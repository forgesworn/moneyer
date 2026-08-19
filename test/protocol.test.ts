import {afterEach, describe, expect, it} from 'vitest'
import {
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  ServiceRejectedError,
  applyMintFee,
  buildNoteUrl,
  fetchInvoiceVerification,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  hashK1,
  mergeNotes,
  meltNote,
  probeBurnedNote,
  requestInvoice,
  rotateNote,
  settleNote,
  splitNote,
  verifyNoteSignature
} from 'lnurlcash-kit'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {freshK1, startMint, waitFor, type TestMint} from './helpers.ts'

// moneyer driven end to end by lnurlcash-kit - the same client every
// wallet built on the kit would bring. The kit's own strictness (k1 echo,
// amount checks, error taxonomy) grades the mint on every call.

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

describe('discovery', () => {
  it('serves a payRequest with a withdrawLink and no fee line when fee-free', async () => {
    const mint = await start()
    const info = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    expect(info.tag).toBe('payRequest')
    expect(info.withdrawLink).toMatch(/^lnurlw:\/\//)
    expect(info.mintFee).toBeUndefined()
    expect(info.callback).toBe(`${mint.moneyer.url}/p/cb`)
  })

  it('ships security headers on the landing page and the API', async () => {
    const mint = await start({}, {webAssets: null})
    const page = await fetch(`${mint.moneyer.url}/`)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    const api = await fetch(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    expect(api.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('advertises mint fees through metadata the kit parses back', async () => {
    const mint = await start({mintFee: {baseFeeMsat: 1000, feePpm: 5000}})
    const info = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    expect(info.mintFee).toEqual({baseFeeMsat: 1000, feePpm: 5000})
  })

  it('answers the bare-domain LUD-16 alias and rejects strangers', async () => {
    const mint = await start()
    const info = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/_`)
    expect(info.tag).toBe('payRequest')
    await expect(fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/nobody`)).rejects.toThrow(
      ServiceRejectedError
    )
  })

  it('serves the experimental mint address with the mint pubkey', async () => {
    const mint = await start()
    const info = await fetchMintAddress(`${mint.moneyer.url}/.well-known/lnurlw/mint`)
    expect(info.callback).toBe(`${mint.moneyer.url}/w`)
    expect(info.nodePubkey).toBe(mint.moneyer.signer!.pubkey)
    expect(info.payLink).toContain('/.well-known/lnurlp/mint')
  })
})

describe('minting', () => {
  it('mints a claimable note whose invoice preimage is the spend secret', async () => {
    const mint = await start()
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    const invoice = await requestInvoice(pay.callback, 21_000)
    expect(invoice.disposable).toBe(false)
    expect(invoice.verify).toBeDefined()
    const paymentHash = decodeBolt11(invoice.pr).paymentHashHex

    const before = await fetchInvoiceVerification(invoice.verify!)
    expect(before.settled).toBe(false)
    expect(before.preimage).toBeNull()

    mint.backend.control.settleInvoice(paymentHash)
    const after = await fetchInvoiceVerification(invoice.verify!)
    expect(after.settled).toBe(true)
    expect(after.preimage).not.toBeNull()

    // The preimage IS the k1. Claim it, learn its authoritative value, and
    // rotate immediately per the spec's security considerations.
    const settled = await settleNote(`${mint.moneyer.url}/w`, after.preimage!, 21_000, undefined)
    expect(settled.amountMsat).toBe(21_000)
    expect(settled.k1).not.toBe(after.preimage)
    expect(verifyNoteSignature(settled.k1, 21_000, settled.signature!, mint.moneyer.signer!.pubkey)).toBe(true)
  })

  it('withholds the advertised fee and reports the net value as authoritative', async () => {
    const fee = {baseFeeMsat: 1000, feePpm: 5000}
    const mint = await start({mintFee: fee})
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    const invoice = await requestInvoice(pay.callback, 50_000)
    const paymentHash = decodeBolt11(invoice.pr).paymentHashHex
    mint.backend.control.settleInvoice(paymentHash)
    const verification = await fetchInvoiceVerification(invoice.verify!)
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, verification.preimage!))
    expect(info.maxWithdrawable).toBe(applyMintFee(50_000, fee))
  })

  it('refuses amounts out of range and dust nets', async () => {
    const mint = await start({mintFee: {baseFeeMsat: 2000, feePpm: 0}})
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    await expect(requestInvoice(pay.callback, 500)).rejects.toThrow(ServiceRejectedError)
    await expect(requestInvoice(pay.callback, 200_000_000)).rejects.toThrow(ServiceRejectedError)
    // nets 500 msat after the 2 sat base fee - below the 1 sat dust floor
    await expect(requestInvoice(pay.callback, 2_500)).rejects.toThrow(ServiceRejectedError)
  })

  it('refuses to mint while sunsetting but still lets holders leave', async () => {
    const mint = await start({sunset: true})
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    await expect(requestInvoice(pay.callback, 21_000)).rejects.toThrow(ServiceRejectedError)

    const note = creditNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)
    // splits grow liabilities - refused
    await expect(splitNote(info.callback, [note.k1], 1_000)).rejects.toThrow(ServiceRejectedError)
    // rotate does not - allowed
    const rotated = await rotateNote(info.callback, note.k1)
    expect(rotated.k1).toBeDefined()
  })
})

describe('the informational GET', () => {
  it('echoes the queried k1 and reports authoritative value', async () => {
    const mint = await start()
    const note = creditNote(mint, 42_000)
    const info = await fetchNoteInfo(note.url)
    expect(info.k1).toBe(note.k1)
    expect(info.maxWithdrawable).toBe(42_000)
    expect(info.mintPubkey).toBe(mint.moneyer.signer!.pubkey)
  })

  it('distinguishes an unknown note from a spent one', async () => {
    const mint = await start()
    const unknown = buildNoteUrl(`${mint.moneyer.url}/w`, freshK1())
    await expect(fetchNoteInfo(unknown)).rejects.toThrow(NoteUnknownError)

    const note = creditNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)
    await rotateNote(info.callback, note.k1)
    await expect(fetchNoteInfo(note.url)).rejects.toThrow(NoteSpentError)
    expect(await probeBurnedNote(note.url)).toBe('gone')
  })
})

describe('mutations', () => {
  it('rotates, splits and merges with value conserved and signatures verifying', async () => {
    const mint = await start()
    const pubkey = mint.moneyer.signer!.pubkey
    const note = creditNote(mint, 100_000)
    const info = await fetchNoteInfo(note.url)

    const rotated = await rotateNote(info.callback, note.k1)
    expect(verifyNoteSignature(rotated.k1, 100_000, rotated.signature!, pubkey)).toBe(true)

    const split = await splitNote(info.callback, [rotated.k1], 30_000)
    expect(verifyNoteSignature(split.k1, 30_000, split.signature!, pubkey)).toBe(true)
    expect(verifyNoteSignature(split.change, 70_000, split.changeSignature!, pubkey)).toBe(true)

    const merged = await mergeNotes(info.callback, [split.k1, split.change])
    expect(verifyNoteSignature(merged.k1, 100_000, merged.signature!, pubkey)).toBe(true)

    const finalInfo = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, merged.k1))
    expect(finalInfo.maxWithdrawable).toBe(100_000)
    expect(mint.moneyer.store.outstandingLiabilityMsat()).toBe(100_000)
  })

  it('refuses a burned k1 atomically in a merge', async () => {
    const mint = await start()
    const a = creditNote(mint, 10_000)
    const b = creditNote(mint, 5_000)
    const info = await fetchNoteInfo(a.url)
    await rotateNote(info.callback, b.k1)
    await expect(mergeNotes(info.callback, [a.k1, b.k1])).rejects.toThrow(ServiceRejectedError)
    // the refusal burned nothing
    expect((await fetchNoteInfo(a.url)).maxWithdrawable).toBe(10_000)
  })

  it('refuses a duplicated k1 rather than counting its value twice', async () => {
    const mint = await start()
    const note = creditNote(mint, 10_000)
    const info = await fetchNoteInfo(note.url)
    await expect(mergeNotes(info.callback, [note.k1, note.k1])).rejects.toThrow(ServiceRejectedError)
    expect((await fetchNoteInfo(note.url)).maxWithdrawable).toBe(10_000)
  })

  it('refuses a split of the full amount - that is a rotate', async () => {
    const mint = await start()
    const note = creditNote(mint, 10_000)
    const info = await fetchNoteInfo(note.url)
    await expect(splitNote(info.callback, [note.k1], 10_000)).rejects.toThrow(ServiceRejectedError)
  })

  it('refuses an output hash that collides with a live note', async () => {
    const mint = await start()
    const a = creditNote(mint, 10_000)
    const b = creditNote(mint, 5_000)
    const info = await fetchNoteInfo(a.url)
    const {rotateNoteWithHash} = await import('lnurlcash-kit')
    await expect(rotateNoteWithHash(info.callback, a.k1, hashK1(b.k1))).rejects.toThrow(ServiceRejectedError)
    expect((await fetchNoteInfo(a.url)).maxWithdrawable).toBe(10_000)
  })
})

describe('split and merge fees', () => {
  // LUD-25: a fee-advertising mint deducts base_fee_msat from every
  // split's change (never the requested amount) and refunds (n - 1) base
  // fees into a merge of n notes. The proportional part is mint-time only.
  it('deducts the base fee from change and refunds it on merge', async () => {
    const fee = {baseFeeMsat: 1000, feePpm: 5000}
    const mint = await start({mintFee: fee})
    const pubkey = mint.moneyer.signer!.pubkey
    const note = creditNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)

    const split = await splitNote(info.callback, [note.k1], 8_000)
    expect(verifyNoteSignature(split.k1, 8_000, split.signature!, pubkey)).toBe(true)
    expect(verifyNoteSignature(split.change, 12_000, split.changeSignature!, pubkey)).toBe(true)
    const changeInfo = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, split.change))
    expect(changeInfo.maxWithdrawable).toBe(12_000)

    const merged = await mergeNotes(info.callback, [split.k1, split.change])
    const mergedInfo = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, merged.k1))
    expect(mergedInfo.maxWithdrawable).toBe(21_000)
    expect(verifyNoteSignature(merged.k1, 21_000, merged.signature!, pubkey)).toBe(true)
  })

  it('refuses a split whose change cannot cover the fee', async () => {
    const mint = await start({mintFee: {baseFeeMsat: 1000, feePpm: 0}})
    const note = creditNote(mint, 10_000)
    const info = await fetchNoteInfo(note.url)
    // change before the fee is 500 - cannot cover it
    await expect(splitNote(info.callback, [note.k1], 9_500)).rejects.toThrow(ServiceRejectedError)
    // change would land at exactly nothing
    await expect(splitNote(info.callback, [note.k1], 9_000)).rejects.toThrow(ServiceRejectedError)
    // the refusals burned nothing
    expect((await fetchNoteInfo(note.url)).maxWithdrawable).toBe(10_000)
  })

  it('rotates without charging or refunding - a merge of one', async () => {
    const mint = await start({mintFee: {baseFeeMsat: 1000, feePpm: 0}})
    const note = creditNote(mint, 10_000)
    const info = await fetchNoteInfo(note.url)
    const rotated = await rotateNote(info.callback, note.k1)
    const after = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, rotated.k1))
    expect(after.maxWithdrawable).toBe(10_000)
  })
})

describe('melting', () => {
  it('melts a note: OK means in flight, the burn lands on settlement', async () => {
    const mint = await start()
    const note = creditNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)

    const preimage = freshK1()
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: hashK1(preimage)})
    mint.backend.control.registerPaymentPreimage(hashK1(preimage), preimage)

    const melt = await meltNote(info.callback, note.k1, pr)
    expect(melt.pr).toBe(pr)
    expect(melt.verify).toBeDefined()

    await waitFor(() => mint.moneyer.store.noteById(hashK1(note.k1))?.state === 'burned')
    const verification = await fetchInvoiceVerification(melt.verify!)
    expect(verification.settled).toBe(true)
    expect(verification.preimage).toBe(preimage)
    expect(mint.moneyer.store.outstandingLiabilityMsat()).toBe(0)
  })

  it('locks a pending note against every other operation', async () => {
    const mint = await start()
    const note = creditNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)
    mint.backend.control.setPayMode('ambiguous-pending')

    await meltNote(info.callback, note.k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: freshK1()}))
    await waitFor(() => mint.moneyer.store.noteById(hashK1(note.k1))?.state === 'pending')
    await expect(rotateNote(info.callback, note.k1)).rejects.toThrow(PendingNoteError)
    await expect(
      meltNote(info.callback, note.k1, fakeBolt11({amountMsat: 21_000, paymentHashHex: freshK1()}))
    ).rejects.toThrow(PendingNoteError)
  })

  it('refuses the wrong amount, its own invoices, and a reused invoice', async () => {
    const mint = await start()
    const note = creditNote(mint, 21_000)
    const info = await fetchNoteInfo(note.url)

    await expect(
      meltNote(info.callback, note.k1, fakeBolt11({amountMsat: 20_000, paymentHashHex: freshK1()}))
    ).rejects.toThrow(ServiceRejectedError)

    // an invoice this mint itself issued
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    const own = await requestInvoice(pay.callback, 21_000)
    await expect(meltNote(info.callback, note.k1, own.pr)).rejects.toThrow(ServiceRejectedError)

    // an invoice an earlier melt already used
    const other = creditNote(mint, 21_000)
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: freshK1()})
    await meltNote(info.callback, other.k1, pr)
    await waitFor(() => mint.moneyer.store.noteById(hashK1(other.k1))?.state === 'burned')
    await expect(meltNote(info.callback, note.k1, pr)).rejects.toThrow(ServiceRejectedError)
  })
})

describe('verify switch', () => {
  it('serves 404 for verify when disabled, and omits verify URLs', async () => {
    const mint = await start({verify: false})
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    const invoice = await requestInvoice(pay.callback, 21_000)
    expect(invoice.verify).toBeUndefined()
    const paymentHash = decodeBolt11(invoice.pr).paymentHashHex
    const res = await fetch(`${mint.moneyer.url}/verify/${paymentHash}`)
    expect(res.status).toBe(404)
  })
})
