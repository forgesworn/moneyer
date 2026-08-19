import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1, meltNote, fetchNoteInfo} from 'lnurlcash-kit'
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

    // Confirmation attempts exhaust against a still-pending payment.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(noteState(mint, noteId)).toBe('pending')

    mint.backend.control.resolvePayment(paymentHash, 'complete')
    await mint.moneyer.reconcile()
    expect(noteState(mint, noteId)).toBe('burned')
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
