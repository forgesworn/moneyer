import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1, meltNote, fetchNoteInfo, PendingNoteError} from '@lnurlcash/kit'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {InvoiceUsedError, NoteStore} from '../src/store.ts'
import {createMoneyer} from '../src/server.ts'
import {claimMintedNote} from '../src/claim.ts'
import {freshK1, startMint, testConfig, waitFor, type TestMint, noteIdOf} from './helpers.ts'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

// The money-critical rules of the melt path, one mode each:
// burn only on confirmed payment, restore only on confirmed non-payment,
// park everything else as pending - and resolve pending ones later.

let active: TestMint | null = null
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  await active?.moneyer.close().catch(() => {})
  active = null
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const meltOnce = async (mint: TestMint, amountMsat = 21_000) => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(noteIdOf(k1), amountMsat)
  const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, amountMsat))
  const paymentHash = freshK1()
  const pr = fakeBolt11({amountMsat, paymentHashHex: hashK1(paymentHash)})
  await meltNote(info.callback, k1, pr)
  return {k1, noteId: noteIdOf(k1), paymentHash: hashK1(paymentHash)}
}

// The callback's raw answer, for melts the mint refuses outright.
const meltAnswer = async (mint: TestMint, amountMsat = 21_000) => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(noteIdOf(k1), amountMsat)
  const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, amountMsat))
  const paymentHash = hashK1(freshK1())
  const pr = fakeBolt11({amountMsat, paymentHashHex: paymentHash})
  const body = (await fetch(`${info.callback}?k1=${k1}&pr=${pr}`).then(r => r.json())) as {status: string; reason?: string}
  return {k1, noteId: noteIdOf(k1), paymentHash, body}
}

const noteState = (mint: TestMint, noteId: string) => mint.moneyer.store.noteById(noteId)?.state

describe('a note that is not a whole sat', () => {
  // Most Lightning wallets can only invoice whole sats. A 94.9 sat note
  // that insists on exactly 94,900 msat cannot be withdrawn by any of them.
  it('advertises its whole-sat floor as the minimum and melts for it, keeping the dust', async () => {
    active = await startMint()
    const k1 = freshK1()
    active.moneyer.store.creditNote(noteIdOf(k1), 94_900)
    const info = await fetchNoteInfo(buildNoteUrl(`${active.moneyer.url}/w`, k1, 94_900))
    expect(info.maxWithdrawable).toBe(94_900)
    expect(info.minWithdrawable).toBe(94_000)

    // Below the floor, or above the value: refused, note untouched.
    for (const wrong of [93_000, 95_000, 94_901]) {
      const res = await fetch(`${info.callback}?k1=${k1}&pr=${fakeBolt11({amountMsat: wrong, paymentHashHex: hashK1(freshK1())})}`)
      const body = (await res.json()) as {status: string; reason?: string}
      expect(body.status).toBe('ERROR')
      expect(body.reason).toMatch(/94900 msat, or 94000 msat/)
    }
    expect(noteState(active, noteIdOf(k1))).toBe('outstanding')

    // The whole-sat floor pays out; the 900 msat of dust stays with the mint.
    const paymentHash = hashK1(freshK1())
    await meltNote(info.callback, k1, fakeBolt11({amountMsat: 94_000, paymentHashHex: paymentHash}))
    await waitFor(() => noteState(active!, noteIdOf(k1)) === 'burned')
    expect(active.moneyer.store.meltByHash(paymentHash)).toMatchObject({amountMsat: 94_900, outcome: 'paid'})
  })

  it('still demands the exact amount for a whole-sat note', async () => {
    active = await startMint()
    const k1 = freshK1()
    active.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const info = await fetchNoteInfo(buildNoteUrl(`${active.moneyer.url}/w`, k1, 21_000))
    expect(info.minWithdrawable).toBe(21_000)
    const res = await fetch(`${info.callback}?k1=${k1}&pr=${fakeBolt11({amountMsat: 20_000, paymentHashHex: hashK1(freshK1())})}`)
    expect(((await res.json()) as {reason?: string}).reason).toMatch(/exactly 21000 msat/)
  })
})

describe('retrying a failed melt\'s invoice', () => {
  // The payee is still waiting on the invoice a failed melt left behind, so
  // a wallet may melt into it again once the funding source confirmed the
  // first attempt never paid. Nothing else unlocks it.
  const noteFor = async (mint: TestMint, amountMsat = 21_000) => {
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), amountMsat)
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, amountMsat))
    return {k1, noteId: noteIdOf(k1), callback: info.callback}
  }
  const answer = async (callback: string, k1: string, pr: string) =>
    (await fetch(`${callback}?k1=${k1}&pr=${pr}`).then(r => r.json())) as {status: string; reason?: string}

  it('pays the same invoice from the same note once the first attempt failed cleanly', async () => {
    const mint = (active = await startMint())
    const note = await noteFor(mint)
    const paymentHash = hashK1(freshK1())
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash})

    mint.backend.control.setPayMode('fail-clean')
    expect(await answer(note.callback, note.k1, pr)).toEqual({
      status: 'ERROR',
      reason: 'Could not find a route to pay this invoice.'
    })
    expect(noteState(mint, note.noteId)).toBe('outstanding')

    mint.backend.control.setPayMode('succeed')
    expect((await answer(note.callback, note.k1, pr)).status).toBe('OK')
    await waitFor(() => noteState(mint, note.noteId) === 'burned')
    expect(mint.moneyer.store.meltByHash(paymentHash)).toMatchObject({noteId: note.noteId, outcome: 'paid'})
    // and once paid, it is spent for good
    const other = await noteFor(mint)
    expect(await answer(other.callback, other.k1, pr)).toEqual({
      status: 'ERROR',
      reason: 'Invoice already used by an earlier melt - use a fresh one.'
    })
    expect(noteState(mint, other.noteId)).toBe('outstanding')
  })

  it('lets a different note take over the invoice, leaving the first one untouched', async () => {
    const mint = (active = await startMint())
    const first = await noteFor(mint)
    const second = await noteFor(mint)
    const paymentHash = hashK1(freshK1())
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash})

    mint.backend.control.setPayMode('fail-clean')
    expect((await answer(first.callback, first.k1, pr)).status).toBe('ERROR')
    mint.backend.control.setPayMode('succeed')
    expect((await answer(second.callback, second.k1, pr)).status).toBe('OK')
    await waitFor(() => noteState(mint, second.noteId) === 'burned')
    expect(noteState(mint, first.noteId)).toBe('outstanding')
    expect(mint.moneyer.store.meltByHash(paymentHash)).toMatchObject({noteId: second.noteId, outcome: 'paid'})
  })

  it('refuses the invoice while an earlier melt into it is unresolved', async () => {
    const mint = (active = await startMint())
    const first = await noteFor(mint)
    const paymentHash = hashK1(freshK1())
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash})

    mint.backend.control.setPayMode('ambiguous-pending')
    expect((await answer(first.callback, first.k1, pr)).status).toBe('OK')
    await waitFor(() => noteState(mint, first.noteId) === 'pending')

    mint.backend.control.setPayMode('succeed')
    const second = await noteFor(mint)
    expect(await answer(second.callback, second.k1, pr)).toEqual({
      status: 'ERROR',
      reason: 'Invoice already used by an earlier melt - use a fresh one.'
    })
    expect(noteState(mint, first.noteId)).toBe('pending')
    expect(noteState(mint, second.noteId)).toBe('outstanding')
  })

  it('refuses a restored invoice somebody else has since paid on a shared node', async () => {
    const mint = (active = await startMint())
    const note = await noteFor(mint)
    const paymentHash = hashK1(freshK1())
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash})

    mint.backend.control.setPayMode('fail-clean')
    expect((await answer(note.callback, note.k1, pr)).status).toBe('ERROR')
    for (const status of ['pending', 'complete'] as const) {
      mint.backend.control.seedForeignPayment(paymentHash, status)
      mint.backend.control.setPayMode('succeed')
      expect(await answer(note.callback, note.k1, pr)).toEqual({
        status: 'ERROR',
        reason: 'Invoice already used by an earlier melt - use a fresh one.'
      })
      expect(noteState(mint, note.noteId)).toBe('outstanding')
      expect(mint.moneyer.store.meltByHash(paymentHash)?.outcome).toBe('restored')
    }
  })

  it('takes over only a restored row in the store itself', () => {
    const store = new NoteStore(':memory:')
    const pr = (hash: string) => fakeBolt11({amountMsat: 1000, paymentHashHex: hash})
    const [a, b, c] = [noteIdOf(freshK1()), noteIdOf(freshK1()), noteIdOf(freshK1())]
    for (const id of [a, b, c]) store.creditNote(id, 1000)
    const hash = hashK1(freshK1())

    store.markPending(a, hash, pr(hash), 1000)
    expect(() => store.markPending(b, hash, pr(hash), 1000)).toThrow(InvoiceUsedError)
    expect(store.noteById(b)?.state).toBe('outstanding')

    store.restoreMelt(hash)
    store.markPending(b, hash, pr(hash), 1000)
    expect(store.meltByHash(hash)).toMatchObject({noteId: b, outcome: null})
    expect(store.noteById(a)?.state).toBe('outstanding')

    store.finalizeMelt(hash)
    expect(() => store.markPending(c, hash, pr(hash), 1000)).toThrow(InvoiceUsedError)
    expect(store.noteById(c)?.state).toBe('outstanding')
    expect(store.noteById(b)?.state).toBe('burned')
  })
})

describe('melt discipline', () => {
  it('burns the note when the payment succeeds', async () => {
    const mint = (active = await startMint())
    const {noteId} = await meltOnce(mint)
    await waitFor(() => noteState(mint, noteId) === 'burned')
  })

  it('restores the note on a clean, confirmed failure and answers with the reason', async () => {
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('fail-clean')
    const {k1, noteId, paymentHash, body} = await meltAnswer(mint)
    expect(body).toEqual({status: 'ERROR', reason: 'Could not find a route to pay this invoice.'})
    // Restored before the answer went out, not some time after it.
    expect(noteState(mint, noteId)).toBe('outstanding')
    expect(mint.moneyer.store.meltByHash(paymentHash)?.outcome).toBe('restored')
    const restored = await fetch(`${mint.moneyer.url}/w?h=${hashK1(k1)}`).then(r => r.json())
    expect(restored).toMatchObject({tag: 'withdrawRequest', maxWithdrawable: 21_000})
    expect(restored).not.toHaveProperty('k1')
  })

  it('reports pending then spent by hash, retaining that distinction after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-spent-hash-'))
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}))
    const dbPath = join(dir, 'mint.sqlite')
    const mint = (active = await startMint({dbPath}))
    mint.backend.control.setPayMode('ambiguous-pending')
    const {k1, noteId, paymentHash} = await meltOnce(mint, 3000)
    await waitFor(() => noteState(mint, noteId) === 'pending')
    for (const lookup of [`h=${hashK1(k1)}`, `k1=${k1}`]) {
      expect(await fetch(`${mint.moneyer.url}/w?${lookup}`).then(r => r.json()))
        .toEqual({status: 'ERROR', reason: 'pending'})
    }

    mint.backend.control.resolvePayment(paymentHash, 'complete')
    for (let attempt = 0; attempt < 60 && noteState(mint, noteId) !== 'burned'; attempt += 1) {
      await mint.moneyer.reconcile()
      if (noteState(mint, noteId) !== 'burned') await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(noteState(mint, noteId)).toBe('burned')
    for (const lookup of [`h=${hashK1(k1)}`, `k1=${k1}`]) {
      expect(await fetch(`${mint.moneyer.url}/w?${lookup}`).then(r => r.json()))
        .toEqual({status: 'ERROR', reason: 'Note already spent.'})
    }

    await mint.moneyer.close()
    active = null
    const reborn = (active = await startMint({dbPath}, {backend: mint.backend}))
    expect(await fetch(`${reborn.moneyer.url}/w?h=${hashK1(k1)}`).then(r => r.json()))
      .toEqual({status: 'ERROR', reason: 'Note already spent.'})
    expect(await fetch(`${reborn.moneyer.url}/w?h=${hashK1(freshK1())}`).then(r => r.json()))
      .toEqual({status: 'ERROR', reason: 'Unknown note.'})
    expect(noteState(reborn, noteId)).toBe('burned')
  })

  it('burns the note when the backend REPORTS failure but the payment landed', async () => {
    // The hodl-invoice shape: a clean failure report is not proof no HTLC
    // settled. Restoring here would let the holder melt the value twice.
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('fail-then-paid')
    const {noteId, body} = await meltAnswer(mint)
    expect(body.status).toBe('OK')
    await waitFor(() => noteState(mint, noteId) === 'burned')
  })

  it('burns the note when an ambiguous attempt turns out to have paid', async () => {
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('ambiguous-paid')
    const {noteId} = await meltOnce(mint)
    await waitFor(() => noteState(mint, noteId) === 'burned')
  })

  it('restores the note when an ambiguous attempt is confirmed unpaid', async () => {
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('ambiguous-unpaid')
    const {noteId, body} = await meltAnswer(mint)
    // The transport error is the operator's business; the wallet gets a
    // plain sentence.
    expect(body).toEqual({status: 'ERROR', reason: 'Payment failed.'})
    expect(noteState(mint, noteId)).toBe('outstanding')
  })

  it('answers OK when the outcome is not known within the window, and still restores later', async () => {
    const mint = (active = await startMint({}, {meltAnswerWindowMs: 20}))
    mint.backend.control.setPayMode('fail-clean')
    const realPay = mint.backend.payInvoice.bind(mint.backend)
    mint.backend.payInvoice = async args => {
      await new Promise(resolve => setTimeout(resolve, 150))
      return realPay(args)
    }
    const {noteId, body} = await meltAnswer(mint)
    expect(body.status).toBe('OK')
    expect(noteState(mint, noteId)).toBe('pending')
    await waitFor(() => noteState(mint, noteId) === 'outstanding')
  })

  it('leaves an unconfirmable outcome pending, then reconciles it', async () => {
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('ambiguous-pending')
    const {noteId, paymentHash} = await meltOnce(mint)

    await waitFor(() => noteState(mint, noteId) === 'pending')

    // reconcile deliberately skips a melt this process still has in flight,
    // so it can only act once the attempt has finished exhausting its
    // confirmations. The original fixed 100 ms sleep was waiting for that
    // rather than for the state, and was long enough on an idle machine and
    // not on a loaded one. Retrying reconcile waits for the real condition:
    // a money-path gate that fails at random is one people learn to re-run
    // rather than read.
    mint.backend.control.resolvePayment(paymentHash, 'complete')
    for (let attempt = 0; attempt < 60 && noteState(mint, noteId) !== 'burned'; attempt += 1) {
      await mint.moneyer.reconcile()
      if (noteState(mint, noteId) !== 'burned') await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(noteState(mint, noteId)).toBe('burned')
  })

  // Found by re-reading LUD-25 against dni's lnurl-mint, which refuses this
  // and says why: a note reserved by an in-flight melt must not still be
  // advertised as withdrawable. The spec makes the informational GET the way
  // anyone checks what a note is worth, so answering "live, worth all of it"
  // about a note that is halfway out of the door is the exact lie a
  // sell-during-melt needs - the seller starts a melt, shows the buyer a
  // healthy GET, takes payment out of band, and the melt settles.
  it('stops advertising a note as withdrawable once a melt reserves it', async () => {
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('ambiguous-pending')
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const url = buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000)

    // Healthy before the melt.
    expect((await fetchNoteInfo(url)).maxWithdrawable).toBe(21_000)

    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())})
    await meltNote((await fetchNoteInfo(url)).callback, k1, pr)
    await waitFor(() => noteState(mint, noteIdOf(k1)) === 'pending')

    // Informational pending is the reference mint's literal service reason;
    // the kit itself now classifies it as PendingNoteError (2026-09,
    // matching lnurlcash-core's Error::NotePending), not a generic
    // ServiceError the product layer has to interpret.
    await expect(fetchNoteInfo(url)).rejects.toBeInstanceOf(PendingNoteError)
  })

  it('claimMintedNote reports pending rather than throwing once a melt reserves the note', async () => {
    // A bound-mint quote polls claimMintedNote while waiting for the
    // wallet-chosen secret to appear. It must classify a melt-in-flight note
    // as pending, the same as the raw informational GET above - not throw,
    // which would surface as an unreachable-mint error to the poller.
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('ambiguous-pending')
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const url = buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000)

    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())})
    await meltNote((await fetchNoteInfo(url)).callback, k1, pr)
    await waitFor(() => noteState(mint, noteIdOf(k1)) === 'pending')

    const claim = await claimMintedNote(`${mint.moneyer.url}/w`, k1)
    expect(claim.state).toBe('pending')
  })

  it('refuses to melt into a hash the funding source already paid for someone else', async () => {
    // The shared-node replay: another mint on the same funding source paid
    // this invoice; confirming by hash would burn our note for nothing.
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000))

    const foreignHash = hashK1(freshK1())
    mint.backend.control.seedForeignPayment(foreignHash)
    await expect(
      meltNote(info.callback, k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: foreignHash}))
    ).rejects.toThrow(/already used/)
    // refused before the note was ever reserved
    expect(noteState(mint, noteIdOf(k1))).toBe('outstanding')

    // a foreign payment still IN FLIGHT is just as refusable
    const pendingHash = hashK1(freshK1())
    mint.backend.control.seedForeignPayment(pendingHash, 'pending')
    await expect(
      meltNote(info.callback, k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: pendingHash}))
    ).rejects.toThrow(/already used/)
    expect(noteState(mint, noteIdOf(k1))).toBe('outstanding')
  })

  it('restores the note when the foreign payment lands between pre-check and send', async () => {
    // The race the pre-check cannot see: the node acquires a payment for
    // this hash after the melt is reserved. The send is refused with
    // "already exists" - nothing went out for us, so the note restores.
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000))

    const hash = hashK1(freshK1())
    const realIsComplete = mint.backend.isPaymentComplete.bind(mint.backend)
    // the pre-check sees a clean node; the foreign payment lands right after
    let precheck = true
    mint.backend.isPaymentComplete = async paymentHash => {
      if (precheck && paymentHash === hash) {
        precheck = false
        mint.backend.control.seedForeignPayment(hash)
        return false
      }
      return realIsComplete(paymentHash)
    }
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: hash})
    expect(await fetch(`${info.callback}?k1=${k1}&pr=${pr}`).then(r => r.json())).toEqual({
      status: 'ERROR',
      reason: 'Invoice already used by an earlier melt - use a fresh one.'
    })
    expect(noteState(mint, noteIdOf(k1))).toBe('outstanding')
    expect(mint.moneyer.store.meltByHash(hash)?.outcome).toBe('restored')
  })

  it('reconciles a melt a dead process left pending, at startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-'))
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}))
    const dbPath = join(dir, 'mint.sqlite')

    const mint = (active = await startMint({dbPath}))
    mint.backend.control.setPayMode('ambiguous-pending')
    const {noteId, paymentHash} = await meltOnce(mint)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(noteState(mint, noteId)).toBe('pending')

    // The process dies; the payment later fails terminally at the funding
    // source; a fresh process starts against the same database.
    await mint.moneyer.close()
    active = null
    mint.backend.control.resolvePayment(paymentHash, 'failed')
    const reborn = await createMoneyer(testConfig({dbPath}), {
      backend: mint.backend,
      store: new NoteStore(dbPath),
      confirmDelaysMs: [0]
    })
    cleanups.push(() => reborn.close())
    expect(reborn.store.noteById(noteId)?.state).toBe('outstanding')
  })
})
