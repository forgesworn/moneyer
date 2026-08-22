import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1, meltNote, fetchNoteInfo, PendingNoteError} from 'lnurlcash-kit'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {NoteStore} from '../src/store.ts'
import {createMoneyer} from '../src/server.ts'
import {freshK1, startMint, testConfig, waitFor, type TestMint} from './helpers.ts'
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
  mint.moneyer.store.creditNote(hashK1(k1), amountMsat)
  const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, amountMsat))
  const paymentHash = freshK1()
  const pr = fakeBolt11({amountMsat, paymentHashHex: hashK1(paymentHash)})
  await meltNote(info.callback, k1, pr)
  return {noteId: hashK1(k1), paymentHash: hashK1(paymentHash)}
}

const noteState = (mint: TestMint, noteId: string) => mint.moneyer.store.noteById(noteId)?.state

describe('a note that is not a whole sat', () => {
  // Most Lightning wallets can only invoice whole sats. A 94.9 sat note
  // that insists on exactly 94,900 msat cannot be withdrawn by any of them.
  it('advertises its whole-sat floor as the minimum and melts for it, keeping the dust', async () => {
    active = await startMint()
    const k1 = freshK1()
    active.moneyer.store.creditNote(hashK1(k1), 94_900)
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
    expect(noteState(active, hashK1(k1))).toBe('outstanding')

    // The whole-sat floor pays out; the 900 msat of dust stays with the mint.
    const paymentHash = hashK1(freshK1())
    await meltNote(info.callback, k1, fakeBolt11({amountMsat: 94_000, paymentHashHex: paymentHash}))
    await waitFor(() => noteState(active!, hashK1(k1)) === 'burned')
    expect(active.moneyer.store.meltByHash(paymentHash)).toMatchObject({amountMsat: 94_900, outcome: 'paid'})
  })

  it('still demands the exact amount for a whole-sat note', async () => {
    active = await startMint()
    const k1 = freshK1()
    active.moneyer.store.creditNote(hashK1(k1), 21_000)
    const info = await fetchNoteInfo(buildNoteUrl(`${active.moneyer.url}/w`, k1, 21_000))
    expect(info.minWithdrawable).toBe(21_000)
    const res = await fetch(`${info.callback}?k1=${k1}&pr=${fakeBolt11({amountMsat: 20_000, paymentHashHex: hashK1(freshK1())})}`)
    expect(((await res.json()) as {reason?: string}).reason).toMatch(/exactly 21000 msat/)
  })
})

describe('melt discipline', () => {
  it('burns the note when the payment succeeds', async () => {
    const mint = (active = await startMint())
    const {noteId} = await meltOnce(mint)
    await waitFor(() => noteState(mint, noteId) === 'burned')
  })

  it('restores the note on a clean, confirmed failure', async () => {
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('fail-clean')
    const {noteId} = await meltOnce(mint)
    await waitFor(() => noteState(mint, noteId) === 'outstanding')
  })

  it('burns the note when the backend REPORTS failure but the payment landed', async () => {
    // The hodl-invoice shape: a clean failure report is not proof no HTLC
    // settled. Restoring here would let the holder melt the value twice.
    const mint = (active = await startMint())
    mint.backend.control.setPayMode('fail-then-paid')
    const {noteId} = await meltOnce(mint)
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
    const {noteId} = await meltOnce(mint)
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
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    const url = buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000)

    // Healthy before the melt.
    expect((await fetchNoteInfo(url)).maxWithdrawable).toBe(21_000)

    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(freshK1())})
    await meltNote((await fetchNoteInfo(url)).callback, k1, pr)
    await waitFor(() => noteState(mint, hashK1(k1)) === 'pending')

    // The same refusal the mutating callback already gives, and the same
    // one the reference mint gives here - and the kit classifies it as the
    // typed error a wallet acts on, rather than an unknown-note answer that
    // would have it write the note off.
    await expect(fetchNoteInfo(url)).rejects.toThrow(PendingNoteError)
  })

  it('refuses to melt into a hash the funding source already paid for someone else', async () => {
    // The shared-node replay: another mint on the same funding source paid
    // this invoice; confirming by hash would burn our note for nothing.
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000))

    const foreignHash = hashK1(freshK1())
    mint.backend.control.seedForeignPayment(foreignHash)
    await expect(
      meltNote(info.callback, k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: foreignHash}))
    ).rejects.toThrow(/already used/)
    // refused before the note was ever reserved
    expect(noteState(mint, hashK1(k1))).toBe('outstanding')

    // a foreign payment still IN FLIGHT is just as refusable
    const pendingHash = hashK1(freshK1())
    mint.backend.control.seedForeignPayment(pendingHash, 'pending')
    await expect(
      meltNote(info.callback, k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: pendingHash}))
    ).rejects.toThrow(/already used/)
    expect(noteState(mint, hashK1(k1))).toBe('outstanding')
  })

  it('restores the note when the foreign payment lands between pre-check and send', async () => {
    // The race the pre-check cannot see: the node acquires a payment for
    // this hash after the melt is reserved. The send is refused with
    // "already exists" - nothing went out for us, so the note restores.
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
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
    await meltNote(info.callback, k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: hash}))
    await waitFor(() => noteState(mint, hashK1(k1)) === 'outstanding')
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
