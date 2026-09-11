import {afterEach, describe, expect, it} from 'vitest'
import {finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate} from 'nostr-tools/pure'
import {unwrapEvent} from 'nostr-tools/nip59'
import {matchFilter, type Filter} from 'nostr-tools/filter'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {
  cashNodeToCx1,
  deriveCashAddressNode,
  deriveCashRoot,
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCk1,
  encodeCp1,
  encodeCx1,
  signNoteOwnership,
  verifyNoteSignature,
  type CashNode
} from 'lnurlcash-kit'
import {NIP98_KIND} from '../src/names.ts'
import {NOTE_KIND, type NostrTransport} from '../src/zap.ts'
import {startMint, waitFor, type TestMint} from './helpers.ts'

// A name with a cx1 is paid to the holder's own keys: the mint derives the
// next one from the watch-only branch, and the gift wrap says only where to
// look and at which index. The mint never holds anything that spends it.

const MINT_NOSTR_KEY = '22'.repeat(32)
const HOST = 'mint.test'

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
  return {transport, published}
}

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

const start = async () => {
  const relay = fakeRelay()
  active = await startMint(
    {
      publicOrigin: `http://${HOST}`,
      mintFee: {baseFeeMsat: 1000, feePpm: 0},
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {}},
      namePriceMsat: 0
    },
    {nostr: relay.transport, zapPollMs: 20}
  )
  return {mint: active, relay}
}

const token = (secret: Uint8Array, body: string): string => {
  const template: EventTemplate = {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', `http://${HOST}/names`],
      ['method', 'POST'],
      ['payload', bytesToHex(sha256(utf8ToBytes(body)))]
    ]
  }
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent(template, secret))).toString('base64')}`
}

const claim = async (mint: TestMint, secret: Uint8Array, body: Record<string, unknown>) => {
  const payload = JSON.stringify(body)
  const res = await fetch(`${mint.moneyer.url}/names`, {
    method: 'POST',
    headers: {authorization: token(secret, payload), 'content-type': 'application/json'},
    body: payload
  })
  return {status: res.status, body: (await res.json()) as Record<string, unknown>}
}

type Holder = {sk: Uint8Array; pubkey: string; node: CashNode; cx1: string}

const holder = (): Holder => {
  const sk = generateSecretKey()
  const node = deriveCashAddressNode(deriveCashRoot(randomBytes(32)), HOST)
  const {pubkeyXOnly, chainCode} = cashNodeToCx1(node)
  return {sk, pubkey: getPublicKey(sk), node, cx1: encodeCx1(pubkeyXOnly, chainCode)}
}

const keyAt = (who: Holder, index: number): string =>
  bytesToHex(deriveNotePubkey(cashNodeToCx1(who.node).pubkeyXOnly, who.node.chainCode, index))

const ck1At = (who: Holder, index: number): string =>
  encodeCk1(signNoteOwnership(deriveNoteSecretKey(who.node.privateKey, who.node.chainCode, index)))

// Asks for an invoice to `name`, and returns its payment hash.
const invoice = async (mint: TestMint, name: string, amountMsat: number): Promise<string> => {
  const cb = (await (await fetch(`${mint.moneyer.url}/z/cb/${name}?amount=${amountMsat}`)).json()) as {pr: string}
  return decodeBolt11(cb.pr).paymentHashHex
}

const wraps = (relay: ReturnType<typeof fakeRelay>) => relay.published.filter(p => p.event.kind === 1059)

// Settles an invoice and returns what the holder finds in the wrap it causes.
const settle = async (mint: TestMint, relay: ReturnType<typeof fakeRelay>, who: Holder, paymentHash: string) => {
  const before = wraps(relay).length
  mint.backend.control.settleInvoice(paymentHash)
  await waitFor(() => wraps(relay).length > before)
  const rumor = unwrapEvent(wraps(relay).at(-1)!.event, who.sk)
  return {rumor, url: new URL(rumor.content)}
}

describe('a name with a cx1', () => {
  it('is registered by its owner, who alone may change or clear the branch', async () => {
    const {mint} = await start()
    const alice = holder()
    const granted = await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})
    expect(granted.status).toBe(200)
    expect(granted.body.cx1).toBe(alice.cx1)
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({cx1: alice.cx1, nextIndex: 0})

    expect((await claim(mint, holder().sk, {name: 'alice', cx1: holder().cx1})).status).toBe(409)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: 'cx1nonsense'})).status).toBe(400)

    const cleared = await claim(mint, alice.sk, {name: 'alice', cx1: null})
    expect(cleared.status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBeNull()
  })

  it('pays each zap to the next key, wrapping only where to look', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})

    const first = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(first.rumor.kind).toBe(NOTE_KIND)
    expect(first.url.searchParams.has('k1')).toBe(false)
    expect(first.url.searchParams.get('p')).toBe(encodeCp1(Buffer.from(keyAt(alice, 0), 'hex')))
    expect(first.url.searchParams.get('i')).toBe('0')
    expect(first.url.searchParams.get('amount')).toBe('20000')
    expect(first.rumor.tags).toContainEqual(['i', '0'])
    // the holder checks the certificate, then opens the note with its own key
    expect(verifyNoteSignature(ck1At(alice, 0), 20_000, first.url.searchParams.get('sig')!, mint.moneyer.signer.pubkey)).toBe(
      true
    )
    const opened = (await (await fetch(`${mint.moneyer.url}/w?k1=${ck1At(alice, 0)}`)).json()) as {maxWithdrawable: number}
    expect(opened.maxWithdrawable).toBe(20_000)

    const second = await settle(mint, relay, alice, await invoice(mint, 'alice', 11_000))
    expect(second.url.searchParams.get('i')).toBe('1')
    expect(mint.moneyer.store.noteById(keyAt(alice, 1))?.amountMsat).toBe(10_000)
  })

  it('takes no index for an invoice nobody pays', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})
    await invoice(mint, 'alice', 21_000)
    await invoice(mint, 'alice', 21_000)
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('i')).toBe('0')
  })

  it('skips a key that already names a note', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})
    mint.moneyer.store.creditNote(keyAt(alice, 0), 5_000)
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('i')).toBe('1')
    expect(mint.moneyer.store.noteById(keyAt(alice, 0))?.amountMsat).toBe(5_000)
    expect(mint.moneyer.store.zapName('alice')?.nextIndex).toBe(2)
  })

  it('starts a new branch at index 0, and keeps its place when the same one is sent again', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})
    await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})
    expect(mint.moneyer.store.zapName('alice')?.nextIndex).toBe(1)
    await claim(mint, alice.sk, {name: 'alice', cx1: holder().cx1})
    expect(mint.moneyer.store.zapName('alice')?.nextIndex).toBe(0)
  })

  it('leaves a name without one on the custodial path', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice'})
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('k1')).toMatch(/^[0-9a-f]{64}$/)
    expect(paid.url.searchParams.has('p')).toBe(false)
  })
})
