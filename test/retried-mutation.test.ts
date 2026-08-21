import {afterEach, describe, expect, it} from 'vitest'
import {
  NoteSpentError,
  buildNoteUrl,
  fetchNoteInfo,
  hashK1,
  mergeNotesWithHash,
  rotateNoteWithHash,
  splitNoteWithHash,
  verifyNoteSignature
} from 'lnurlcash-kit'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// A rotate, split or merge is a GET, and transports retry GETs. Go's
// net/http retries one that failed on a reused idle connection; the JDK's
// HttpClient retries idempotent methods with no switch to stop it. The
// retry is byte-identical and arrives after the inputs are burned.
//
// Answering it "already spent" is what destroys money: the wallet
// believes the refusal, deletes the staged secret, and the mint keeps a
// note nobody can ever spend. So a request that already minted its
// outputs gets the same reply, and anything else naming a burned input
// still gets today's refusal, unchanged.

let active: TestMint | null = null
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

const creditNote = (mint: TestMint, amountMsat: number): {k1: string; url: string} => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(hashK1(k1), amountMsat)
  return {k1, url: buildNoteUrl(`${mint.moneyer.url}/w`, k1, amountMsat)}
}

describe('a retried mutation', () => {
  it('answers a repeated rotate with the same signature, and mints nothing new', async () => {
    const mint = await start()
    const note = creditNote(mint, 21_000)
    const callback = `${mint.moneyer.url}/w/cb`
    const fresh = freshK1()

    const first = await rotateNoteWithHash(callback, note.k1, hashK1(fresh))
    const retry = await rotateNoteWithHash(callback, note.k1, hashK1(fresh))
    expect(retry.signature).toBe(first.signature)
    expect(verifyNoteSignature(fresh, 21_000, retry.signature!, mint.moneyer.signer!.pubkey)).toBe(true)

    // The note at the staged secret is untouched: still one note, still
    // worth what it was, still spendable.
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, fresh))
    expect(info.maxWithdrawable).toBe(21_000)
    expect(mint.moneyer.store.liabilities().outstandingMsat).toBe(21_000)
    expect(mint.moneyer.store.liabilities().outstandingNotes).toBe(1)
  })

  it('still refuses the same burned k1 with a different output', async () => {
    const mint = await start()
    const note = creditNote(mint, 21_000)
    const callback = `${mint.moneyer.url}/w/cb`
    await rotateNoteWithHash(callback, note.k1, hashK1(freshK1()))
    // A genuine double-spend attempt: same dead k1, an output it never
    // asked for. The reason string is the one it has always been.
    await expect(rotateNoteWithHash(callback, note.k1, hashK1(freshK1()))).rejects.toThrow(NoteSpentError)
  })

  it('replays a split with both signatures', async () => {
    const mint = await start({mintFee: {baseFeeMsat: 1000, feePpm: 0}})
    const note = creditNote(mint, 21_000)
    const callback = `${mint.moneyer.url}/w/cb`
    const keep = freshK1()
    const change = freshK1()

    const first = await splitNoteWithHash(callback, [note.k1], 5_000, hashK1(keep), hashK1(change))
    const retry = await splitNoteWithHash(callback, [note.k1], 5_000, hashK1(keep), hashK1(change))
    expect(retry.signature).toBe(first.signature)
    expect(retry.changeSignature).toBe(first.changeSignature)
    // The base fee comes out of change once, not twice.
    expect(mint.moneyer.store.liabilities().outstandingMsat).toBe(20_000)
  })

  it('replays a merge, and a merge asking for a different total is refused', async () => {
    const mint = await start()
    const a = creditNote(mint, 5_000)
    const b = creditNote(mint, 7_000)
    const callback = `${mint.moneyer.url}/w/cb`
    const merged = freshK1()

    const first = await mergeNotesWithHash(callback, [a.k1, b.k1], hashK1(merged))
    const retry = await mergeNotesWithHash(callback, [a.k1, b.k1], hashK1(merged))
    expect(retry.signature).toBe(first.signature)
    expect(mint.moneyer.store.liabilities().outstandingMsat).toBe(12_000)
    // The same inputs with a different output is not this request.
    await expect(mergeNotesWithHash(callback, [a.k1, b.k1], hashK1(freshK1()))).rejects.toThrow(NoteSpentError)
  })

  it('answers a retry whose inputs were listed the other way round', async () => {
    const mint = await start()
    const a = creditNote(mint, 5_000)
    const b = creditNote(mint, 7_000)
    const callback = `${mint.moneyer.url}/w/cb`
    const merged = freshK1()
    const first = await mergeNotesWithHash(callback, [a.k1, b.k1], hashK1(merged))
    const retry = await mergeNotesWithHash(callback, [b.k1, a.k1], hashK1(merged))
    expect(retry.signature).toBe(first.signature)
  })

  it('never lets a note burned by a melt be rotated after the fact', async () => {
    const mint = await start()
    const note = creditNote(mint, 21_000)
    const callback = `${mint.moneyer.url}/w/cb`
    const paymentHash = freshK1()
    mint.moneyer.store.markPending(
      hashK1(note.k1),
      paymentHash,
      fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash}),
      21_000
    )
    mint.moneyer.store.finalizeMelt(paymentHash)
    // A melt records no swap provenance, so nothing here can look like a
    // retry: the note is gone and the refusal stands.
    await expect(rotateNoteWithHash(callback, note.k1, hashK1(freshK1()))).rejects.toThrow(NoteSpentError)
  })

  it('does not let a stranger draw a success out of a burned k1 and a live note id', async () => {
    const mint = await start()
    const victim = creditNote(mint, 21_000)
    const callback = `${mint.moneyer.url}/w/cb`
    await rotateNoteWithHash(callback, victim.k1, hashK1(freshK1()))
    // A note that exists, and a k1 that is burned. Provenance is recorded
    // rather than inferred, so "a note exists at h" proves nothing.
    const other = creditNote(mint, 3_000)
    await expect(rotateNoteWithHash(callback, victim.k1, hashK1(other.k1))).rejects.toThrow(NoteSpentError)
    expect(mint.moneyer.store.noteById(hashK1(other.k1))!.amountMsat).toBe(3_000)
  })
})
