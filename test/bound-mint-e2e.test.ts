import {afterEach, describe, expect, it} from 'vitest'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {buildNoteUrl, claimMintedNote, fetchPayRequest, hashK1, requestInvoice} from 'lnurlcash-kit'
// The grader shares no code with the kit or with this mint, which is what
// makes agreement between the three mean something.
import {createReport, gradeBoundMint, gradeMint} from 'lnurlcash-conformance'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {startMint, type TestMint} from './helpers.ts'

// Buying a note end to end, with three separate implementations in the
// loop and none of them hand-rolled for the occasion.
//
// test/mint-to-hash.test.ts pins the wire by calling the pay callback
// directly, because a wire contract has to be tested at the wire. These
// tests are the other half: the wallet is lnurlcash-kit as published, the
// mint is this one, and the verdict on what happened comes from
// lnurlcash-conformance's grader rather than from an assertion written
// next to the code it grades. Until the kit could send `h` there was no
// way to run this, and the property nobody had checked was the one that
// spans implementations: that a mint's idea of binding and a wallet's
// idea of binding are the same idea.

let active: TestMint | null = null
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

const failures = (report: {results: Array<{status: string; name: string; detail?: string}>}) =>
  report.results.filter(result => result.status === 'fail')

// The whole purchase, as a wallet performs it: read the mint, name the
// output, get a quote, pay it, claim with the secret you already had.
const buyNote = async (mint: TestMint, amountMsat: number) => {
  const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
  expect(pay.mintToHash).toBe(true)
  expect(pay.withdrawLink).toBeTruthy()

  // Generated before the invoice is asked for, which is the order that
  // matters: a wallet that asks first and generates afterwards can lose
  // the secret to a crash and have paid for nothing.
  const secret = bytesToHex(randomBytes(32))
  const quote = await requestInvoice(pay.callback, amountMsat, {h: hashK1(secret)})
  // Said of this quote, not of the mint in general - the payRequest can be
  // cached, this cannot.
  expect(quote.mintToHash).toBe(true)

  const paymentHash = decodeBolt11(quote.pr).paymentHashHex
  mint.backend.control.settleInvoice(paymentHash)
  const preimage = mint.backend.control.invoiceByHash(paymentHash)!.preimageHex

  return {pay, secret, preimage, paymentHash, withdrawLink: pay.withdrawLink!}
}

describe('buying a bound note, kit to mint to grader', () => {
  it('lands the note at the wallet\'s own secret, and the grader agrees', async () => {
    const mint = await start()
    const {secret, preimage, withdrawLink, pay} = await buyNote(mint, 21_000)

    // No verify poll anywhere in this claim. The wallet asks about a
    // secret it has held since before the invoice existed.
    const claim = await claimMintedNote(withdrawLink, secret)
    expect(claim.state).toBe('minted')
    expect(claim.amountMsat).toBe(21_000)
    expect(claim.k1).toBe(secret)

    const report = createReport()
    await gradeBoundMint(buildNoteUrl(withdrawLink, secret, 21_000), report, {
      preimage,
      payCallback: pay.callback
    })
    expect(failures(report)).toEqual([])
    // A pass here and no check run at all look the same on the failure
    // count, so insist the check actually ran.
    expect(report.results.some(result => result.name.includes('bound mint'))).toBe(true)
  })

  it('leaves the payment preimage worth nothing', async () => {
    const mint = await start()
    const {preimage, withdrawLink} = await buyNote(mint, 21_000)

    // The thief's whole position: they saw the invoice, polled verify,
    // and hold the preimage. Under the old scheme that was the note.
    const stolen = await claimMintedNote(withdrawLink, preimage)
    expect(stolen.state).toBe('unminted')
    expect(stolen.amountMsat).toBeNull()
  })

  it('keeps the fee algebra the grader checks, on a bound mint too', async () => {
    const fee = {baseFeeMsat: 1000, feePpm: 5000}
    const mint = await start({mintFee: fee})
    const {secret, preimage, withdrawLink, pay} = await buyNote(mint, 50_000)

    const claim = await claimMintedNote(withdrawLink, secret)
    expect(claim.state).toBe('minted')
    // Binding changes where the note lives, never what it is worth.
    expect(claim.amountMsat).toBe(50_000 - 1000 - Math.floor((50_000 * 5000) / 1_000_000))

    const report = createReport()
    await gradeBoundMint(buildNoteUrl(withdrawLink, secret, claim.amountMsat!), report, {
      preimage,
      payCallback: pay.callback
    })
    expect(failures(report)).toEqual([])
  })

  it('advertises the capability everywhere the grader looks', async () => {
    const mint = await start()
    const report = createReport()
    await gradeMint(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expect(failures(report)).toEqual([])
    // The grader warns rather than fails where the three claims disagree,
    // so a clean failure count is not enough: this mint should be making
    // the claim, not staying silent about it.
    const claimCheck = report.results.find(result => result.name.toLowerCase().includes('minttohash'))
    expect(claimCheck?.status).toBe('pass')
  })
})
