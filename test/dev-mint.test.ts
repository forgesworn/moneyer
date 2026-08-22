import {afterEach, describe, expect, it} from 'vitest'
import {claimMintedNote, fetchPayRequest, hashK1, requestInvoice} from 'lnurlcash-kit'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {createFakeBackend} from '../src/backends/fake.ts'
import {createMoneyer, type Moneyer} from '../src/server.ts'
import {testConfig} from './helpers.ts'

// A fake mint a wallet can actually use.
//
// The fake funding source settles nothing on its own: settlement is only
// reachable through `control.settleInvoice`, an in-process handle a test
// holds. That is right for tests, which need to say exactly when an
// invoice is paid, and it makes a standalone `MONEYER_BACKEND=fake` mint
// useless to anyone developing a wallet against it. The wallet asks for an
// invoice, nothing ever pays it, no note is ever minted, and every flow
// that needs a note - split, merge, melt, send - dead-ends behind an
// empty wallet. The mint looks healthy the whole time.
//
// `autoSettle` closes that, and `moneyer --dev` turns it on. It can only
// ever be set on the fake backend, which moves no money.

let active: Moneyer | null = null
afterEach(async () => {
  await active?.close()
  active = null
})

const startDevMint = async (autoSettle: boolean, autoSettleAfterMs = 0): Promise<Moneyer> => {
  active = await createMoneyer(testConfig(), {
    backend: createFakeBackend({autoSettle, autoSettleAfterMs}),
    confirmDelaysMs: [0, 10, 20],
    webAssets: null
  })
  return active
}

const buyNote = async (mint: Moneyer, amountMsat: number) => {
  const pay = await fetchPayRequest(`${mint.url}/.well-known/lnurlp/mint`)
  const secret = 'ab'.repeat(32)
  const quote = await requestInvoice(pay.callback, amountMsat, {h: hashK1(secret)})
  return {claim: await claimMintedNote(pay.withdrawLink!, secret), quote}
}

describe('a fake mint a wallet can use', () => {
  it('mints nothing without autoSettle, which is what a wallet ran into', async () => {
    const mint = await startDevMint(false)
    const {claim, quote} = await buyNote(mint, 21_000)
    // The invoice exists and is perfectly well formed. Nothing will ever
    // pay it, so the wallet waits forever holding a secret worth nothing.
    expect(decodeBolt11(quote.pr).amountMsats).toBe(21_000n)
    expect(claim.state).toBe('unminted')
  })

  it('mints on request with autoSettle, so the wallet has money to work with', async () => {
    const mint = await startDevMint(true)
    const {claim} = await buyNote(mint, 21_000)
    expect(claim.state).toBe('minted')
    expect(claim.amountMsat).toBe(21_000)
  })

  it('leaves the rest of the mint honest - the note is a real note', async () => {
    const mint = await startDevMint(true)
    const {claim} = await buyNote(mint, 21_000)
    expect(claim.state).toBe('minted')
    // Not a special-cased freebie: it is outstanding, the mint owes it,
    // and it says so in the same figures everything else reads.
    expect(mint.store.liabilities().outstandingMsat).toBe(21_000)
    expect(mint.store.liabilities().outstandingNotes).toBe(1)
  })

  // The difference between a fast payer and one that pays before being
  // asked. Settling at the instant of issuance makes the mint report an
  // invoice nobody has paid as already settled, which on the wire is
  // indistinguishable from a mint handing out a note before it is paid
  // for - the conformance grader fails exactly that, and is right to.
  it('does not call an invoice paid in the same breath it issued it', async () => {
    const mint = await startDevMint(true, 60_000)
    const pay = await fetchPayRequest(`${mint.url}/.well-known/lnurlp/mint`)
    const quote = await requestInvoice(pay.callback, 21_000, {})
    const verify = (await (await fetch(quote.verify!)).json()) as {settled?: boolean; preimage?: string | null}
    expect(verify.settled).toBe(false)
    expect(verify.preimage).toBeNull()
  })

  it('and a quote is not yet a note', async () => {
    const mint = await startDevMint(true, 60_000)
    const pay = await fetchPayRequest(`${mint.url}/.well-known/lnurlp/mint`)
    const secret = 'cd'.repeat(32)
    await requestInvoice(pay.callback, 21_000, {h: hashK1(secret)})
    // Nothing has paid, so naming an output buys nothing yet.
    const claim = await claimMintedNote(pay.withdrawLink!, secret)
    expect(claim.state).toBe('unminted')
  })

  it('settles the invoice itself rather than pretending the note exists', async () => {
    const mint = await startDevMint(true)
    const pay = await fetchPayRequest(`${mint.url}/.well-known/lnurlp/mint`)
    const quote = await requestInvoice(pay.callback, 21_000, {})
    const paymentHash = decodeBolt11(quote.pr).paymentHashHex
    // The LUD-21 path has to agree with the note path, or a wallet that
    // polls verify and a wallet that claims directly see different mints.
    const verify = (await (await fetch(quote.verify!)).json()) as {settled?: boolean; preimage?: string | null}
    expect(verify.settled).toBe(true)
    expect(verify.preimage).toMatch(/^[0-9a-f]{64}$/)
    expect(hashK1(verify.preimage!)).toBe(paymentHash)
  })
})
