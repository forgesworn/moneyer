import {verifyPreimage} from 'farrier-kit/preimage'
import {
  PaymentAlreadyKnownError,
  PaymentFailedError,
  PaymentPendingError,
  type LightningBackend
} from './backends/types.ts'
import type {NoteStore} from './store.ts'

// A melt replies OK the moment the note is reserved; everything here
// happens after that reply, and the note's fate hangs on it. The rules,
// carried over from the reference mint because each one closes a way to
// lose somebody's money:
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
  amountMsat: number
}

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

const confirmThenSettle = async (job: MeltJob, deps: MeltDeps): Promise<void> => {
  const log = deps.log ?? (() => {})
  for (const delay of deps.confirmDelaysMs ?? DEFAULT_CONFIRM_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    try {
      const complete = await deps.backend.isPaymentComplete(job.paymentHash)
      if (complete) {
        deps.store.finalizeMelt(job.paymentHash)
      } else {
        log(`melt ${job.noteId}: confirmed not paid - restoring`)
        deps.store.restoreMelt(job.paymentHash)
      }
      return
    } catch (err) {
      if (!(err instanceof PaymentPendingError)) {
        log(`melt ${job.noteId}: could not confirm payment status (${(err as Error).message})`)
      }
    }
  }
  log(`melt ${job.noteId}: payment status unconfirmable - note left pending for reconciliation`)
}

export const runMelt = async (job: MeltJob, deps: MeltDeps): Promise<void> => {
  const log = deps.log ?? (() => {})
  let outcome
  try {
    outcome = await deps.backend.payInvoice({
      pr: job.pr,
      feeLimitMsat: deps.feeLimitMsat(job.amountMsat)
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
      return
    }
    if (!(err instanceof PaymentFailedError)) {
      log(`melt ${job.noteId}: payment attempt failed ambiguously (${(err as Error).message})`)
    }
    await confirmThenSettle(job, deps)
    return
  }
  if (outcome.preimageHex !== null && !verifyPreimage(outcome.preimageHex, job.paymentHash)) {
    // The backend claims success with a preimage that does not settle this
    // invoice. That is a statement about the evidence, not the money - fall
    // back to the tracker rather than trusting either way.
    log(`melt ${job.noteId}: backend preimage does not settle this invoice - reconfirming`)
    await confirmThenSettle(job, deps)
    return
  }
  deps.store.finalizeMelt(job.paymentHash)
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
