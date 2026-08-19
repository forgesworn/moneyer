import {afterEach, describe, expect, it} from 'vitest'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {sweepExpiredMintInvoices} from '../src/server.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// The expiry sweep deletes unsettled mint invoices whose bolt11 expiry is
// provably past - "provably" being the whole game, since deleting a row
// whose invoice could still settle would take a payer's money without
// minting the note. fakeBolt11 writes no x tag, so the decoder's default
// one-hour expiry applies to every invoice below.

let active: TestMint | null = null
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

const recordInvoice = (mint: TestMint, ageSeconds = 0): string => {
  const paymentHash = freshK1()
  const pr = fakeBolt11({
    amountMsat: 22_000,
    paymentHashHex: paymentHash,
    ...(ageSeconds > 0 ? {timestamp: Math.floor(Date.now() / 1000) - ageSeconds} : {})
  })
  mint.moneyer.store.recordMintInvoice(paymentHash, pr, 22_000, 22_000)
  return paymentHash
}

describe('the mint-invoice expiry sweep', () => {
  it('deletes an unsettled invoice well past its expiry', async () => {
    const mint = await start()
    const paymentHash = recordInvoice(mint, 3 * 3600)
    expect(sweepExpiredMintInvoices(mint.moneyer.store)).toBe(1)
    expect(mint.moneyer.store.mintInvoiceByHash(paymentHash)).toBeNull()
  })

  it('keeps a fresh unsettled invoice', async () => {
    const mint = await start()
    const paymentHash = recordInvoice(mint)
    expect(sweepExpiredMintInvoices(mint.moneyer.store)).toBe(0)
    expect(mint.moneyer.store.mintInvoiceByHash(paymentHash)).not.toBeNull()
  })

  it('keeps an invoice inside the post-expiry margin', async () => {
    const mint = await start()
    // expired by ten minutes; the margin is an hour
    const paymentHash = recordInvoice(mint, 3600 + 600)
    expect(sweepExpiredMintInvoices(mint.moneyer.store)).toBe(0)
    expect(mint.moneyer.store.mintInvoiceByHash(paymentHash)).not.toBeNull()
  })

  it('never deletes a settled invoice, however old', async () => {
    const mint = await start()
    const paymentHash = recordInvoice(mint, 30 * 24 * 3600)
    mint.moneyer.store.settleMintInvoice(paymentHash)
    expect(sweepExpiredMintInvoices(mint.moneyer.store)).toBe(0)
    expect(mint.moneyer.store.mintInvoiceByHash(paymentHash)).not.toBeNull()
  })

  it('keeps an invoice it cannot decode - no proof of expiry, no delete', async () => {
    const mint = await start()
    const paymentHash = freshK1()
    mint.moneyer.store.recordMintInvoice(paymentHash, 'not-an-invoice', 22_000, 22_000)
    expect(sweepExpiredMintInvoices(mint.moneyer.store)).toBe(0)
    expect(mint.moneyer.store.mintInvoiceByHash(paymentHash)).not.toBeNull()
  })
})
