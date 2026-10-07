import {verifyPreimage} from 'farrier-kit/preimage'
import {
  PaymentAlreadyKnownError,
  PaymentFailedError,
  PaymentPendingError,
  type LightningBackend
} from './backends/types.ts'
import type {NoteStore} from './store.ts'

// The callback waits a short while for runMelt's outcome so it can answer a
// payment that cleanly failed with its reason; past that window it replies
// OK and everything here carries on after the reply, the note's fate hanging
// on it. The rules, carried over from the reference mint because each one
// closes a way to lose somebody's money:
//
// - The note burns only once the payment POSITIVELY completed.
// - The note restores only once the funding source gives a terminal "not
//   paid". A clean failure REPORT is not that: a hodl-invoice payee can
//   make a backend report failure while an HTLC it already sent stays
//   claimable, and restoring on the report alone would let the holder melt
//   the same value twice.
// - Anything else leaves the note pending, visible to reconcile and to an
//   operator, rather than guessed at.

export type MeltJob = {
  paymentHash: string
  noteId: string
  pr: string
  // The note value this melt spends, which is what the routing budget is
  // sized against and what the mint owes until it settles.
  amountMsat: number
  // What to send, for an invoice that states no amount of its own. Absent
  // for an invoice that names its own amount, where the payee decided.
  payAmountMsat?: number
}

// What a melt came to. `restored` means the funding source confirmed the
// payment never went out and the note is outstanding again; `reason` is
// what a wallet can be told. `unresolved` leaves the note pending.
export type MeltOutcome = {kind: 'paid'} | {kind: 'restored'; reason: string} | {kind: 'unresolved'}

export type MeltDeps = {
  store: NoteStore
  backend: LightningBackend
  feeLimitMsat: (amountMsat: number) => number
  // Confirmation backoff after an unclear payment attempt. Injectable so
  // tests need not wait half a minute; ~31s total by default.
  confirmDelaysMs?: number[]
  log?: (message: string) => void
}

const DEFAULT_CONFIRM_DELAYS_MS = [0, 2_000, 4_000, 9_000, 16_000]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const confirmThenSettle = async (job: MeltJob, deps: MeltDeps, reason: string): Promise<MeltOutcome> => {
  const log = deps.log ?? (() => {})
  for (const delay of deps.confirmDelaysMs ?? DEFAULT_CONFIRM_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    try {
      const complete = await deps.backend.isPaymentComplete(job.paymentHash)
      if (complete) {
        deps.store.finalizeMelt(job.paymentHash)
        return {kind: 'paid'}
      }
      log(`melt ${job.noteId}: confirmed not paid - restoring`)
      deps.store.restoreMelt(job.paymentHash)
      return {kind: 'restored', reason}
    } catch (err) {
      if (!(err instanceof PaymentPendingError)) {
        log(`melt ${job.noteId}: could not confirm payment status (${(err as Error).message})`)
      }
    }
  }
  log(`melt ${job.noteId}: payment status unconfirmable - note left pending for reconciliation`)
  return {kind: 'unresolved'}
}

export const runMelt = async (job: MeltJob, deps: MeltDeps): Promise<MeltOutcome> => {
  const log = deps.log ?? (() => {})
  let outcome
  try {
    outcome = await deps.backend.payInvoice({
      pr: job.pr,
      feeLimitMsat: deps.feeLimitMsat(job.amountMsat),
      ...(job.payAmountMsat !== undefined ? {amountMsat: job.payAmountMsat} : {})
    })
  } catch (err) {
    if (err instanceof PaymentAlreadyKnownError) {
      // The node's payment for this hash belongs to someone else - another
      // mint sharing this funding source, or the operator. Nothing went
      // out for THIS melt, and confirming by hash would confirm against
      // that foreign payment: restore, never guess. The synchronous
      // pre-check in the callback catches this before the note is even
      // reserved; this branch closes the race where the foreign payment
      // lands between that check and the send.
      log(`melt ${job.noteId}: the funding source already knew this hash - restored (shared-node replay?)`)
      deps.store.restoreMelt(job.paymentHash)
      return {kind: 'restored', reason: 'Invoice already used by an earlier melt - use a fresh one.'}
    }
    // A clean failure's message is the backend's reason, written for a
    // wallet ("Could not find a route..."); an ambiguous one is transport
    // detail, so a wallet gets a plain sentence instead.
    const clean = err instanceof PaymentFailedError
    if (!clean) {
      log(`melt ${job.noteId}: payment attempt failed ambiguously (${(err as Error).message})`)
    }
    return confirmThenSettle(job, deps, clean ? (err as Error).message : 'Payment failed.')
  }
  if (outcome.preimageHex !== null && !verifyPreimage(outcome.preimageHex, job.paymentHash)) {
    // The backend claims success with a preimage that does not settle this
    // invoice. That is a statement about the evidence, not the money - fall
    // back to the tracker rather than trusting either way.
    log(`melt ${job.noteId}: backend preimage does not settle this invoice - reconfirming`)
    return confirmThenSettle(job, deps, 'Payment failed.')
  }
  deps.store.finalizeMelt(job.paymentHash)
  return {kind: 'paid'}
}

// Resolves melts an earlier process left pending - a crash mid-melt, or an
// outcome that could not be confirmed at the time. Melts whose attempt is
// live in THIS process are skipped: their runMelt owns them, and the
// backend can momentarily report "no such payment" before the RPC lands.
export const reconcilePendingMelts = async (
  store: NoteStore,
  backend: LightningBackend,
  inFlight: ReadonlySet<string>,
  log: (message: string) => void = () => {}
): Promise<void> => {
  for (const melt of store.pendingMelts()) {
    if (inFlight.has(melt.paymentHash)) continue
    try {
      const complete = await backend.isPaymentComplete(melt.paymentHash)
      if (complete) {
        store.finalizeMelt(melt.paymentHash)
        log(`reconcile: melt ${melt.noteId} confirmed paid - burned`)
      } else {
        store.restoreMelt(melt.paymentHash)
        log(`reconcile: melt ${melt.noteId} confirmed not paid - restored`)
      }
    } catch {
      // still unresolved - an operator can look, and the next reconcile
      // will try again
    }
  }
}
