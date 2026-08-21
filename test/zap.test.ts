import {afterEach, describe, expect, it} from 'vitest'
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools/pure'
import {unwrapEvent} from 'nostr-tools/nip59'
import {matchFilter, type Filter} from 'nostr-tools/filter'
import {bytesToHex} from '@noble/hashes/utils.js'
import {fetchNoteInfo, hashK1, rotateNote} from 'lnurlcash-kit'
import {configFromEnv} from '../src/config.ts'
import {INBOX_RELAYS_KIND, NOTE_KIND, type NostrTransport} from '../src/zap.ts'
import {startMint, waitFor, type TestMint} from './helpers.ts'

// Zap-to-note end to end against the fake funding source and a fake relay:
// a NIP-57 zap to alice@<mint> settles, alice's wallet opens a gift wrap
// holding a note it can rotate, the zapper sees a receipt, and the zapper's
// preimage is worth nothing.

const MINT_NOSTR_KEY = '22'.repeat(32)
const aliceSk = generateSecretKey()
const alice = getPublicKey(aliceSk)
const zapperSk = generateSecretKey()
const zapper = getPublicKey(zapperSk)

// One in-memory relay for everything: stores regular kinds, answers
// queries, and records every publish so a test can see what went where.
const fakeRelay = () => {
  const stored: Event[] = []
  const published: Array<{relays: string[]; event: Event}> = []
  const transport: NostrTransport = {
    async publish(relays, event) {
      published.push({relays, event})
      stored.push(event)
      return {ok: relays, failed: []}
    },
    async query(_relays, filter: Filter) {
      return stored.filter(e => matchFilter(filter, e))
    },
    close() {}
  }
  return {transport, stored, published}
}

const zapRequest = (amountMsat: number, overrides: Partial<{p: string; amount: string | null; relays: string[]}> = {}): string =>
  JSON.stringify(
    finalizeEvent(
      {
        kind: 9734,
        created_at: Math.floor(Date.now() / 1000),
        content: 'great post',
        tags: [
          ['p', overrides.p ?? alice],
          ['relays', ...(overrides.relays ?? ['wss://zapper.example'])],
          ...(overrides.amount === null ? [] : [['amount', overrides.amount ?? String(amountMsat)]]),
          ['e', 'ab'.repeat(32)]
        ]
      },
      zapperSk
    )
  )

let mint: TestMint | null = null
afterEach(async () => {
  await mint?.moneyer.close()
  mint = null
})

const startZapMint = async (relay = fakeRelay(), overrides = {}) => {
  mint = await startMint(
    {
      publicOrigin: 'http://mint.test',
      mintFee: {baseFeeMsat: 1000, feePpm: 0},
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice}},
      ...overrides
    },
    {nostr: relay.transport, zapPollMs: 20}
  )
  return {mint, relay}
}

describe('a zap name', () => {
  it('advertises a NIP-57 payRequest with no withdrawLink, and the mint name still mints', async () => {
    const {mint} = await startZapMint()
    const res = await fetch(`${mint.moneyer.url}/.well-known/lnurlp/alice`)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.tag).toBe('payRequest')
    expect(body.allowsNostr).toBe(true)
    expect(body.nostrPubkey).toBe(getPublicKey(Buffer.from(MINT_NOSTR_KEY, 'hex')))
    expect(body.callback).toBe('http://mint.test/z/cb/alice')
    expect(body).not.toHaveProperty('withdrawLink')
    expect(JSON.parse(body.metadata as string)).toContainEqual(['text/identifier', 'alice@mint.test'])

    const mintBody = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/mint`)).json()) as Record<string, unknown>
    expect(mintBody.withdrawLink).toBe('http://mint.test/w')
    expect(mintBody).not.toHaveProperty('allowsNostr')

    expect((await fetch(`${mint.moneyer.url}/.well-known/lnurlp/bob`)).status).toBe(404)
    expect((await fetch(`${mint.moneyer.url}/z/cb/bob?amount=5000`)).status).toBe(404)
  })

  it('turns a settled zap into a note alice can open and rotate, and a receipt the zapper can see', async () => {
    const {mint, relay} = await startZapMint()
    // alice publishes where she reads.
    relay.stored.push(
      finalizeEvent({kind: INBOX_RELAYS_KIND, created_at: 1, content: '', tags: [['relay', 'wss://alice-inbox.example']]}, aliceSk)
    )

    const zr = zapRequest(21_000)
    const cb = (await (
      await fetch(`${mint.moneyer.url}/z/cb/alice?amount=21000&nostr=${encodeURIComponent(zr)}`)
    ).json()) as {pr?: string; verify?: string; reason?: string}
    expect(cb.reason).toBeUndefined()
    expect(cb.pr).toBeTypeOf('string')

    // Nothing exists before settlement, and verify says so.
    const paymentHash = cb.verify!.split('/').pop()!
    expect(mint.moneyer.store.noteById(paymentHash)).toBeNull()
    await mint.moneyer.reconcile()
    expect(relay.published).toHaveLength(0)
    const verifyUrl = cb.verify!.replace('http://mint.test', mint.moneyer.url)
    expect(await (await fetch(verifyUrl)).json()).toMatchObject({status: 'OK', settled: false, preimage: null, pr: cb.pr})

    mint.backend.control.settleInvoice(paymentHash)
    await waitFor(() => relay.published.some(p => p.event.kind === 9735))
    // LUD-21 for the payer: settled, with the throwaway preimage they hold anyway.
    expect(await (await fetch(verifyUrl)).json()).toMatchObject({
      status: 'OK',
      settled: true,
      preimage: mint.backend.control.invoiceByHash(paymentHash)!.preimageHex
    })

    // The wrap went to alice's inbox (and the mint's relay), not the zapper's.
    const wrapPub = relay.published.find(p => p.event.kind === 1059)!
    expect(wrapPub.relays).toEqual(expect.arrayContaining(['wss://alice-inbox.example', 'wss://mint-relay.example']))
    expect(wrapPub.relays).not.toContain('wss://zapper.example')

    // Only alice can open it, and what is inside is a 2525 note rumor.
    const rumor = unwrapEvent(wrapPub.event, aliceSk)
    expect(rumor.kind).toBe(NOTE_KIND)
    expect(rumor.pubkey).toBe(getPublicKey(Buffer.from(MINT_NOSTR_KEY, 'hex')))
    expect(rumor.tags).toContainEqual(['p', alice])
    expect(rumor.tags).toContainEqual(['amount', '20000'])
    expect(rumor.tags).toContainEqual(['u', 'mint.test/w'])
    expect(rumor.tags).toContainEqual(['P', zapper])
    expect(rumor.tags).toContainEqual(['e', 'ab'.repeat(32)])
    // The zap request rides along, so a wallet can say who zapped and
    // what they wrote without asking a relay for the receipt.
    expect(rumor.tags).toContainEqual(['description', zr])
    expect((JSON.parse(zr) as {content: string}).content).toBe('great post')
    const url = new URL(rumor.content)
    expect(url.origin + url.pathname).toBe('http://mint.test/w')
    const k1 = url.searchParams.get('k1')!
    expect(k1).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('amount')).toBe('20000')

    // The note's secret is NOT the invoice preimage the zapper learned.
    const zapperPreimage = mint.backend.control.invoiceByHash(paymentHash)!.preimageHex
    expect(k1).not.toBe(zapperPreimage)
    expect(hashK1(zapperPreimage)).toBe(paymentHash)
    expect(mint.moneyer.store.noteById(paymentHash)).toBeNull()
    const note = mint.moneyer.store.noteById(hashK1(k1))!
    expect(note).toMatchObject({amountMsat: 20_000, state: 'outstanding'})

    // alice's wallet rotates it onto her own secret, as any note.
    const liveUrl = rumor.content.replace('http://mint.test', mint.moneyer.url)
    const info = await fetchNoteInfo(liveUrl)
    expect(info.maxWithdrawable).toBe(20_000)
    const rotated = await rotateNote(info.callback.replace('http://mint.test', mint.moneyer.url), k1)
    expect(mint.moneyer.store.noteById(hashK1(k1))!.state).toBe('burned')
    expect(mint.moneyer.store.noteById(hashK1(rotated.k1))).toMatchObject({amountMsat: 20_000, state: 'outstanding'})

    // The receipt: signed by the mint's nostrPubkey, on the zapper's relays
    // and the mint's, carrying the zap request and no preimage.
    const receiptPub = relay.published.find(p => p.event.kind === 9735)!
    expect(receiptPub.relays).toEqual(expect.arrayContaining(['wss://zapper.example', 'wss://mint-relay.example']))
    const receipt = receiptPub.event
    expect(verifyEvent(receipt)).toBe(true)
    expect(receipt.pubkey).toBe(getPublicKey(Buffer.from(MINT_NOSTR_KEY, 'hex')))
    expect(receipt.tags).toContainEqual(['p', alice])
    expect(receipt.tags).toContainEqual(['P', zapper])
    expect(receipt.tags).toContainEqual(['bolt11', cb.pr])
    expect(receipt.tags).toContainEqual(['description', zr])
    expect(receipt.tags.find(t => t[0] === 'preimage')).toBeUndefined()

    // Parked copies are gone once published; the row stays as the record.
    const row = mint.moneyer.store.zapInvoiceByHash(paymentHash)!
    expect(row.settled).toBe(true)
    expect(row.wrapJson).toBeNull()
    expect(row.receiptJson).toBeNull()
    expect(row.noteId).toBe(hashK1(k1))

    // A second settle pass mints nothing more.
    await mint.moneyer.reconcile()
    expect(relay.published.filter(p => p.event.kind === 1059)).toHaveLength(1)
  })

  it('keeps the wrap parked until a relay takes it, and never loses the note', async () => {
    const relay = fakeRelay()
    let relayUp = false
    const flaky: NostrTransport = {
      ...relay.transport,
      async publish(relays, event) {
        if (!relayUp) return {ok: [], failed: relays}
        return relay.transport.publish(relays, event)
      }
    }
    const {mint} = await startZapMint({transport: flaky, stored: relay.stored, published: relay.published})
    const cb = (await (await fetch(`${mint.moneyer.url}/z/cb/alice?amount=5000`)).json()) as {verify: string}
    const paymentHash = cb.verify.split('/').pop()!
    mint.backend.control.settleInvoice(paymentHash)
    await waitFor(() => mint.moneyer.store.zapInvoiceByHash(paymentHash)!.settled)
    await mint.moneyer.reconcile()
    const parked = mint.moneyer.store.zapInvoiceByHash(paymentHash)!
    expect(parked.wrapJson).not.toBeNull()
    expect(mint.moneyer.store.noteById(parked.noteId!)).toMatchObject({amountMsat: 4_000})
    expect(relay.published).toHaveLength(0)

    relayUp = true
    await mint.moneyer.reconcile()
    expect(relay.published.filter(p => p.event.kind === 1059)).toHaveLength(1)
    expect(mint.moneyer.store.zapInvoiceByHash(paymentHash)!.wrapJson).toBeNull()
    // A plain pay (no zap request) has no receipt to publish.
    expect(relay.published.filter(p => p.event.kind === 9735)).toHaveLength(0)
    const rumor = unwrapEvent(relay.published[0]!.event, aliceSk)
    expect(rumor.tags.find(t => t[0] === 'P')).toBeUndefined()
  })

  it('keeps the wrap parked while an inbox relay refuses it, and settles for the rest after ten minutes', async () => {
    const relay = fakeRelay()
    const inboxDown: NostrTransport = {
      ...relay.transport,
      async publish(relays, event) {
        // The mint's own relay takes it; the recipient's inbox relay does not.
        const ok = relays.filter(r => r !== 'wss://alice-inbox.example')
        const failed = relays.filter(r => r === 'wss://alice-inbox.example')
        relay.published.push({relays: ok, event})
        relay.stored.push(event)
        return {ok, failed}
      }
    }
    mint = await startMint(
      {
        publicOrigin: 'http://mint.test',
        zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice}}
      },
      {nostr: inboxDown, zapPollMs: 100_000}
    )
    relay.stored.push(
      finalizeEvent({kind: INBOX_RELAYS_KIND, created_at: 1, content: '', tags: [['relay', 'wss://alice-inbox.example']]}, aliceSk)
    )
    const cb = (await (await fetch(`${mint.moneyer.url}/z/cb/alice?amount=5000`)).json()) as {verify: string}
    const paymentHash = cb.verify.split('/').pop()!
    mint.backend.control.settleInvoice(paymentHash)
    await mint.moneyer.reconcile()
    // Minted and announced to the mint's relay, but not given up on: the
    // device reads its inbox relay, and that one has not got it.
    expect(mint.moneyer.store.zapInvoiceByHash(paymentHash)!.wrapJson).not.toBeNull()
    expect(relay.published.filter(p => p.event.kind === 1059)).toHaveLength(1)
    await mint.moneyer.reconcile()
    expect(relay.published.filter(p => p.event.kind === 1059)).toHaveLength(2)
    expect(mint.moneyer.store.zapInvoiceByHash(paymentHash)!.wrapJson).not.toBeNull()
    // Same event each time: a relay that already has it just says so.
    expect(new Set(relay.published.filter(p => p.event.kind === 1059).map(p => p.event.id)).size).toBe(1)
  })

  it('refuses a zap request that is forged, for someone else, or for a different amount', async () => {
    const {mint} = await startZapMint()
    const call = async (nostr: string, amount = 21_000) =>
      (await (await fetch(`${mint.moneyer.url}/z/cb/alice?amount=${amount}&nostr=${encodeURIComponent(nostr)}`)).json()) as {
        reason?: string
        pr?: string
      }

    const forged = JSON.parse(zapRequest(21_000)) as Event
    forged.content = 'tampered'
    expect((await call(JSON.stringify(forged))).reason).toMatch(/signature/i)
    expect((await call('not json')).reason).toMatch(/JSON/)
    expect((await call(zapRequest(21_000, {p: bytesToHex(generateSecretKey())}))).reason).toMatch(/not for alice@mint.test/)
    expect((await call(zapRequest(21_000, {amount: '5000'}))).reason).toMatch(/amount does not match/)
    // An amount tag is optional in NIP-57; without it the URL amount rules.
    expect((await call(zapRequest(21_000, {amount: null}))).pr).toBeTypeOf('string')
    // The advertised minimum already covers the fee, so "too small to mint"
    // is unreachable from a compliant payer: below it is out of range.
    const plain = async (amount: string) =>
      (await (await fetch(`${mint.moneyer.url}/z/cb/alice?amount=${amount}`)).json()) as {reason?: string}
    expect((await plain('1500')).reason).toMatch(/out of range/)
    expect((await plain('abc')).reason).toMatch(/Invalid amount/)
    expect(mint.moneyer.store.unsettledZapInvoices()).toHaveLength(1)
  })

  it('is off unless configured, and refuses half a configuration', () => {
    expect(configFromEnv({}).zap).toBeUndefined()
    const full = {
      MONEYER_PUBLIC_ORIGIN: 'https://mint.example',
      MONEYER_NOSTR_KEY: MINT_NOSTR_KEY,
      MONEYER_NOSTR_RELAYS: 'wss://a.example, wss://b.example',
      MONEYER_ZAP_NAMES: `Alice=${alice}`
    }
    expect(() => configFromEnv({...full, MONEYER_ZAP_NAMES: `Alice=${alice},bob=npub1${'q'.repeat(58)}`})).toThrow(/Not a Nostr pubkey/)
    const {zap} = configFromEnv(full)
    expect(zap).toEqual({nostrKey: MINT_NOSTR_KEY, relays: ['wss://a.example', 'wss://b.example'], names: {alice}})
    expect(() => configFromEnv({...full, MONEYER_NOSTR_RELAYS: undefined})).toThrow(/MONEYER_NOSTR_RELAYS/)
    // A mint that opens registration starts with no names of its own, so
    // the key and the relays are what is required, not the names.
    expect(configFromEnv({...full, MONEYER_ZAP_NAMES: undefined}).zap).toEqual({
      nostrKey: MINT_NOSTR_KEY,
      relays: ['wss://a.example', 'wss://b.example'],
      names: {}
    })
    expect(() => configFromEnv({...full, MONEYER_PUBLIC_ORIGIN: undefined})).toThrow(/MONEYER_PUBLIC_ORIGIN/)
    expect(() => configFromEnv({...full, MONEYER_ZAP_NAMES: `mint=${alice}`})).toThrow(/mint username/)
    expect(() => configFromEnv({...full, MONEYER_ZAP_NAMES: `_=${alice}`})).toThrow(/"_"/)
    expect(() => configFromEnv({...full, MONEYER_NOSTR_KEY: 'abc'})).toThrow(/32 bytes/)
  })
})
