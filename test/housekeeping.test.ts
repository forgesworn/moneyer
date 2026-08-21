import {afterEach, describe, expect, it} from 'vitest'
import {getPublicKey, type Event} from 'nostr-tools/pure'
import {hexToBytes} from '@noble/hashes/utils.js'
import {hashK1} from 'lnurlcash-kit'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {sweepExpiredMintInvoices} from '../src/server.ts'
import {STATS_D_TAG, STATS_KIND, verifyStatsSnapshot} from '../src/stats.ts'
import type {NostrTransport} from '../src/zap.ts'
import {TEST_SIGNING_KEY, freshK1, startMint, waitFor, type TestMint} from './helpers.ts'

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

// The hourly signed snapshot: the mint states its liabilities on the
// record, signed with the key its notes verify against, so the history
// can be checked afterwards rather than taken on the operator's word.

const MINT_NOSTR_KEY = '22'.repeat(32)

const recordingRelay = () => {
  const published: Event[] = []
  const transport: NostrTransport = {
    async publish(relays, event) {
      published.push(event)
      return {ok: relays, failed: []}
    },
    async query() {
      return []
    },
    close() {}
  }
  return {transport, published}
}

const startPublishingMint = async (relay: ReturnType<typeof recordingRelay>, overrides = {}) =>
  start(
    {
      publicOrigin: 'http://mint.test',
      signingKey: TEST_SIGNING_KEY,
      statsPublish: true,
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {}},
      ...overrides
    },
    {nostr: relay.transport, statsPublishMs: 20}
  )

describe('the signed liabilities snapshot', () => {
  it('publishes a snapshot anyone can check against the mint pubkey', async () => {
    const relay = recordingRelay()
    const mint = await startPublishingMint(relay)
    mint.moneyer.store.creditNote(hashK1(freshK1()), 40_000)
    await mint.moneyer.publishStats()

    const event = relay.published.at(-1)!
    expect(event.kind).toBe(STATS_KIND)
    expect(event.tags).toContainEqual(['d', STATS_D_TAG])
    // Signed as the mint's Nostr identity, but the liabilities inside are
    // signed with the NOTE key - the one a holder already checks against.
    expect(event.pubkey).toBe(getPublicKey(hexToBytes(MINT_NOSTR_KEY)))
    const checked = verifyStatsSnapshot(event.content, mint.moneyer.signer!.pubkey)
    expect(checked.valid).toBe(true)
    expect(checked.stats!.outstandingMsat).toBe(40_000)
  })

  it('publishes on its own timer once configured', async () => {
    const relay = recordingRelay()
    await startPublishingMint(relay)
    await waitFor(() => relay.published.length > 0)
  })

  it('stays quiet unless the operator turned it on', async () => {
    const relay = recordingRelay()
    const mint = await startPublishingMint(relay, {statsPublish: false})
    await mint.moneyer.publishStats()
    expect(relay.published).toHaveLength(0)
  })
})
