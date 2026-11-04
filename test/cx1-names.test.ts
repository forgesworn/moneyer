import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate} from 'nostr-tools/pure'
import {unwrapEvent} from 'nostr-tools/nip59'
import {matchFilter, type Filter} from 'nostr-tools/filter'
import {sha256, sha512} from '@noble/hashes/sha2.js'
import {hmac} from '@noble/hashes/hmac.js'
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {encodeCk1, encodeCp1, encodeCx1, encodeLegacyCx1, signNoteOwnership} from '@lnurlcash/kit'
import specVectors from 'lnurlcash-conformance/vectors/spec-vectors.json' with {type: 'json'}
import {NOTE_PURPOSE_LIGHTNING_ADDRESS, deriveNotePubkey} from '../src/spend.ts'
import {NIP98_KIND} from '../src/names.ts'
import {decodeShare, proofVerifies, registrationMessage} from '../src/shares.ts'
import {HOLD_GRACE_MS, NoteStore} from '../src/store.ts'
import {NOTE_KIND, type NostrTransport} from '../src/zap.ts'
import {createFakeBackend, type FakeBackend} from '../src/backends/fake.ts'
import {freshK1, startMint, waitFor, type TestMint, noteIdOf, certifiesNote} from './helpers.ts'

// A name with a share is paid to the holder's own keys: the mint derives the
// next one from the share's cx1 with BIP-32, and the gift wrap says only
// where to look and at which index. The mint never holds anything that
// spends it.

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

const start = async (overrides: Record<string, unknown> = {}, backend?: FakeBackend) => {
  const relay = fakeRelay()
  active = await startMint(
    {
      publicOrigin: `http://${HOST}`,
      mintFee: {baseFeeMsat: 1000, feePpm: 0},
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {}},
      namePriceMsat: 0,
      ...overrides
    },
    {nostr: relay.transport, zapPollMs: 20, ...(backend ? {backend} : {})}
  )
  return {mint: active, relay}
}

// What each invoice commits to, as the funding source is asked for it: lnd
// and cln hash exactly this string into the invoice's description hash.
const recordingBackend = () => {
  const backend = createFakeBackend()
  const committed: Array<string | undefined> = []
  const createInvoice = backend.createInvoice.bind(backend)
  backend.createInvoice = async args => {
    committed.push(args.descriptionForHash)
    return createInvoice(args)
  }
  return {backend, committed}
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

// A share, as a wallet holds one: its private key p and chain code. Its
// notes are BIP-32's non-hardened children, sk_i = p + I_L mod n, written
// out here with noble so the mint is checked against code it shares
// nothing with (and against luds' own vectors, below).
type Holder = {sk: Uint8Array; pubkey: string; shareKey: Uint8Array; chainCode: Uint8Array; cx1: string}

const N = secp256k1.Point.CURVE().n
const toBigInt = (bytes: Uint8Array): bigint => BigInt(`0x${bytesToHex(bytes)}`)
const ser32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n, false)
  return bytes
}
const childSecretKey = (shareKey: Uint8Array, chainCode: Uint8Array, index: number): Uint8Array => {
  const P = secp256k1.getPublicKey(shareKey, true)
  const I = hmac(sha512, chainCode, new Uint8Array([...P, ...ser32(index)]))
  const k = (toBigInt(shareKey) + toBigInt(I.subarray(0, 32))) % N
  return Uint8Array.from(Buffer.from(k.toString(16).padStart(64, '0'), 'hex'))
}

const holder = (): Holder => {
  const sk = generateSecretKey()
  const shareKey = secp256k1.utils.randomSecretKey()
  const chainCode = randomBytes(32)
  return {
    sk,
    pubkey: getPublicKey(sk),
    shareKey,
    chainCode,
    cx1: encodeCx1({chainCode, pubkey: secp256k1.getPublicKey(shareKey, true)})
  }
}

const keyAt = (who: Holder, index: number): string =>
  bytesToHex(secp256k1.getPublicKey(childSecretKey(who.shareKey, who.chainCode, index), true).subarray(1))

const ck1At = (who: Holder, index: number): string => {
  const {pubkeyXOnly, signature} = signNoteOwnership(childSecretKey(who.shareKey, who.chainCode, index), HOST)
  return encodeCk1(pubkeyXOnly, signature)
}

// LUD-26's proofs, by the share's own key, bound to this mint.
const message = (action: 'register' | 'update' | 'unregister', name: string, cx1?: string, domain = HOST): string =>
  `LNURLcash:${action}:${domain}:${name}${action === 'unregister' ? '' : `:${cx1}`}`
const proof = (who: Holder, action: 'register' | 'update' | 'unregister', name: string, cx1 = who.cx1, domain = HOST): string =>
  bytesToHex(schnorr.sign(sha256(utf8ToBytes(message(action, name, cx1, domain))), who.shareKey, new Uint8Array(32)))

// `prover`, when given, signs the proof a cx1 change needs: register by the
// new share, or unregister by the one on file.
const claim = async (mint: TestMint, secret: Uint8Array, body: Record<string, unknown>, prover?: Holder) => {
  if (prover && body.cx1 !== undefined && typeof body.name === 'string') {
    body = {...body, sig: body.cx1 === null ? proof(prover, 'unregister', body.name) : proof(prover, 'register', body.name, body.cx1 as string)}
  }
  const payload = JSON.stringify(body)
  const res = await fetch(`${mint.moneyer.url}/names`, {
    method: 'POST',
    headers: {authorization: token(secret, payload), 'content-type': 'application/json'},
    body: payload
  })
  return {status: res.status, body: (await res.json()) as Record<string, unknown>}
}

// LUD-26's own routes, form-encoded.
const address = async (mint: TestMint, method: 'POST' | 'PUT' | 'DELETE', name: string, form: Record<string, string>) => {
  const res = await fetch(`${mint.moneyer.url}/.well-known/lnurlp/${name}`, {
    method,
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(form).toString()
  })
  return {status: res.status, cors: res.headers.get('access-control-allow-origin'), body: (await res.json()) as Record<string, unknown>}
}

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

const payRequestOf = async (mint: TestMint, name: string) =>
  (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/${name}`)).json()) as Record<string, unknown>

describe('a name with a share', () => {
  it('is registered by its owner, who alone may set or clear the share', async () => {
    const {mint} = await start()
    const alice = holder()
    const granted = await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect(granted.status).toBe(200)
    expect(granted.body.cx1).toBe(alice.cx1)
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({cx1: alice.cx1, nextIndex: 0})

    const bob = holder()
    expect((await claim(mint, bob.sk, {name: 'alice', cx1: bob.cx1}, bob)).status).toBe(409)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: 'cx1nonsense'})).status).toBe(400)

    const cleared = await claim(mint, alice.sk, {name: 'alice', cx1: null}, alice)
    expect(cleared.status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBeNull()
  })

  it('refuses the whole-branch cx1 and the proof that bound no cx1', async () => {
    const {mint} = await start()
    const alice = holder()
    const branch = encodeLegacyCx1({pubkeyXOnly: secp256k1.getPublicKey(alice.shareKey, true).subarray(1), chainCode: alice.chainCode})
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: branch})).status).toBe(400)
    // 0.21.0's message: no cx1 in it, so it could be replayed with any.
    const unbound = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`LNURLcash:register:${HOST}:alice`)), alice.shareKey, new Uint8Array(32)))
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1, sig: unbound})).status).toBe(403)
    expect(mint.moneyer.store.zapName('alice')).toBeNull()
  })

  it('needs the share proof to point a name at a share, or away from one', async () => {
    const {mint} = await start()
    const alice = holder()
    const stranger = holder()
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})).status).toBe(403)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1, sig: proof(stranger, 'register', 'alice', alice.cx1)})).status).toBe(403)
    const elsewhere = proof(alice, 'register', 'alice', alice.cx1, 'other.example')
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1, sig: elsewhere})).status).toBe(403)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1, sig: proof(alice, 'unregister', 'alice')})).status).toBe(403)
    expect(mint.moneyer.store.zapName('alice')).toBeNull()

    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)).status).toBe(200)
    // A cx1 on file is never overwritten here: a move is LUD-26's PUT.
    const next = holder()
    const overwrite = await claim(mint, alice.sk, {name: 'alice', cx1: next.cx1}, next)
    expect(overwrite.status).toBe(409)
    expect(overwrite.body.reason).toMatch(/^already registered/)
    // The same share again is no change.
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)).status).toBe(200)
    // Clearing is an unregister by the share on file.
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: null}, next)).status).toBe(403)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: null}, alice)).status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBeNull()
    // ...and the share it held is never accepted again, here or elsewhere.
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)).body.reason).toBe('cx1 already used')
    const bob = holder()
    expect((await claim(mint, bob.sk, {name: 'bobby', cx1: alice.cx1}, alice)).body.reason).toBe('cx1 already used')
  })

  it('publishes a LUD-26 Lightning Address that names its mint and no key', async () => {
    const {mint} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    const pay = await payRequestOf(mint, 'alice')
    expect(pay.callback).toBe(`http://${HOST}/z/cb/alice`)
    expect(pay.withdrawLink).toBe(`http://${HOST}/w`)
    expect(pay).not.toHaveProperty('commentAllowed')
    expect(pay.allowsNostr).toBe(true)
    const entries = JSON.parse(pay.metadata as string) as unknown[][]
    expect(entries.some(entry => entry[0] === 'text/cpub' || entry[0] === 'text/xpub')).toBe(false)
    expect(JSON.stringify(pay)).not.toMatch(/cx1[02-9ac-hj-np-z]{20,}/)
    // mint@'s mint fees, without the address fee only mint@ advertises.
    expect(entries).toContainEqual(['text/plain', 'Mint fees: 1000,0'])
    // A +tag is the same address.
    expect((await payRequestOf(mint, 'alice+coffee')).callback).toBe(`http://${HOST}/z/cb/alice`)

    const custodial = holder()
    await claim(mint, custodial.sk, {name: 'bobby'})
    expect(await payRequestOf(mint, 'bobby')).not.toHaveProperty('withdrawLink')
  })

  it('pays each zap to the next key, wrapping only where to look', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)

    const first = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(first.rumor.kind).toBe(NOTE_KIND)
    expect(first.url.searchParams.has('k1')).toBe(false)
    expect(first.url.searchParams.get('p')).toBe(encodeCp1(Buffer.from(keyAt(alice, 0), 'hex')))
    expect(first.url.searchParams.get('i')).toBe('0')
    expect(first.rumor.tags).toContainEqual(['i', '0'])
    // The wrap names the mint's public origin, so that is the domain certified.
    expect(certifiesNote(ck1At(alice, 0), 20_000, first.url.searchParams.get('c')!, mint.moneyer.signer.pubkey, HOST)).toBe(true)
    const opened = (await (await fetch(`${mint.moneyer.url}/w?k1=${ck1At(alice, 0)}`)).json()) as {maxWithdrawable: number}
    expect(opened.maxWithdrawable).toBe(20_000)

    const second = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(second.url.searchParams.get('i')).toBe('1')
    expect(mint.moneyer.store.noteById(keyAt(alice, 1))?.amountMsat).toBe(20_000)
  })

  it('takes no index for an invoice nobody pays', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    await invoice(mint, 'alice', 21_000)
    await invoice(mint, 'alice', 21_000)
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('i')).toBe('0')
  })

  it('commits every invoice to the metadata its payer was shown', async () => {
    const {backend, committed} = recordingBackend()
    const {mint} = await start({}, backend)
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    const pay = await payRequestOf(mint, 'alice')
    await invoice(mint, 'alice', 21_000)
    mint.moneyer.store.creditNote(keyAt(alice, 0), 5_000)
    await invoice(mint, 'alice', 21_000)
    // Nothing in the payRequest moves when the next key does.
    expect(committed).toEqual([pay.metadata, pay.metadata])
    expect((await payRequestOf(mint, 'alice')).metadata).toBe(pay.metadata)
  })

  it('skips a key that already names a note', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    mint.moneyer.store.creditNote(keyAt(alice, 0), 5_000)
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('i')).toBe('1')
    expect(mint.moneyer.store.noteById(keyAt(alice, 0))?.amountMsat).toBe(5_000)
    expect(mint.moneyer.store.zapName('alice')?.nextIndex).toBe(2)
  })

  it('leaves a name without one on the custodial path', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice'})
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('k1')).toMatch(/^[0-9a-f]{64}$/)
    expect(paid.url.searchParams.has('p')).toBe(false)
  })

  it('lets the owner of an operator name set a share while registration is closed', async () => {
    const alice = holder()
    const {mint} = await start({
      namePriceMsat: undefined,
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice: alice.pubkey}}
    })
    const set = await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect(set.status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBe(alice.cx1)
    const stranger = holder()
    expect((await claim(mint, stranger.sk, {name: 'bobby', cx1: stranger.cx1}, stranger)).status).toBe(404)
    expect((await claim(mint, stranger.sk, {name: 'alice', cx1: stranger.cx1}, stranger)).status).toBe(409)
  })

  it("keeps an operator name's share across a restart, and drops it when the operator gives the name away", async () => {
    const alice = holder()
    const {mint, relay} = await start({
      namePriceMsat: undefined,
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice: alice.pubkey}}
    })
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    const store = mint.moneyer.store
    expect(store.zapName('alice')).toMatchObject({cx1: alice.cx1, nextIndex: 1})
    store.putOperatorZapName('alice', alice.pubkey)
    expect(store.zapName('alice')).toMatchObject({pubkey: alice.pubkey, cx1: alice.cx1, nextIndex: 1})
    const bob = holder()
    store.putOperatorZapName('alice', bob.pubkey)
    expect(store.zapName('alice')).toMatchObject({pubkey: bob.pubkey, cx1: null, nextIndex: 0})
  })
})

describe('an internal transfer (LUD-26)', () => {
  const send = async (mint: TestMint, name: string, k1: string, amountMsat: number) =>
    (await (await fetch(`${mint.moneyer.url}/z/cb/${name}?amount=${amountMsat}&k1=${encodeURIComponent(k1)}`)).json()) as Record<
      string,
      unknown
    >

  it("credits the whole note, free, to the share's next key, and answers a retry as the first", async () => {
    const {mint} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    mint.moneyer.store.creditNote(keyAt(alice, 0), 5_000)
    const source = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(source), 21_000)

    expect(await send(mint, 'alice', source, 20_000)).toMatchObject({status: 'ERROR', reason: expect.stringMatching(/full value, 21000 msat/)})
    expect(mint.moneyer.store.noteById(noteIdOf(source))?.state).toBe('outstanding')

    expect(await send(mint, 'alice', source, 21_000)).toEqual({status: 'OK'})
    expect(mint.moneyer.store.noteById(noteIdOf(source))?.state).toBe('burned')
    // key 0 already named a note, so key 1, worth all of it: no mint fee
    expect(mint.moneyer.store.noteById(keyAt(alice, 1))).toMatchObject({amountMsat: 21_000, state: 'outstanding'})
    expect(await send(mint, 'alice', source, 21_000)).toEqual({status: 'OK'})
    expect(mint.moneyer.store.zapName('alice')?.nextIndex).toBe(2)
    // The same note to anyone else, or for another amount, is a double spend.
    const bob = holder()
    await claim(mint, bob.sk, {name: 'bobby', cx1: bob.cx1}, bob)
    expect(await send(mint, 'bobby', source, 21_000)).toEqual({status: 'ERROR', reason: 'already in use'})
  })

  it('refuses a name with no share, and a note that does not open', async () => {
    const {mint} = await start()
    const custodial = holder()
    await claim(mint, custodial.sk, {name: 'bobby'})
    const source = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(source), 21_000)
    expect((await send(mint, 'bobby', source, 21_000)).status).toBe('ERROR')
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect((await send(mint, 'alice', freshK1(), 21_000)).status).toBe('ERROR')
    expect(mint.moneyer.store.noteById(noteIdOf(source))?.state).toBe('outstanding')
  })
})

describe('registration at the address (LUD-26)', () => {
  it('registers, moves and unregisters a name its share alone owns', async () => {
    const {mint} = await start()
    const alice = holder()
    const registered = await address(mint, 'POST', 'Alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})
    expect(registered).toMatchObject({status: 200, cors: '*', body: {status: 'OK'}})
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({pubkey: null, cx1: alice.cx1})
    // No Nostr key owns it: no NIP-05, no zaps, but a Lightning Address all the same.
    expect(await (await fetch(`${mint.moneyer.url}/.well-known/nostr.json?name=alice`)).json()).toEqual({names: {}})
    const pay = await payRequestOf(mint, 'alice')
    expect(pay.withdrawLink).toBe(`http://${HOST}/w`)
    expect(pay).not.toHaveProperty('allowsNostr')

    const next = holder()
    const moved = await address(mint, 'PUT', 'alice', {
      cx1: next.cx1,
      sig: proof(alice, 'update', 'alice', next.cx1),
      newsig: proof(next, 'register', 'alice', next.cx1)
    })
    expect(moved.body).toEqual({status: 'OK'})
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({cx1: next.cx1, nextIndex: 0})

    expect((await address(mint, 'DELETE', 'alice', {sig: proof(alice, 'unregister', 'alice')})).body.reason).toBe('Invalid ownership signature.')
    expect((await address(mint, 'DELETE', 'alice', {sig: proof(next, 'unregister', 'alice')})).body).toEqual({status: 'OK'})
    expect(mint.moneyer.store.zapName('alice')).toBeNull()
    expect(await payRequestOf(mint, 'alice')).toEqual({status: 'ERROR', reason: 'unknown user'})
  })

  it('leaves a name a Nostr key owns with that key when its share unregisters', async () => {
    const {mint} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect((await address(mint, 'POST', 'alice', {cx1: holder().cx1, sig: '00'.repeat(64)})).body.reason).toBe('Invalid ownership signature.')
    const fresh = holder()
    expect((await address(mint, 'POST', 'alice', {cx1: fresh.cx1, sig: proof(fresh, 'register', 'alice')})).body.reason).toBe('already registered')
    expect((await address(mint, 'DELETE', 'alice', {sig: proof(alice, 'unregister', 'alice')})).body).toEqual({status: 'OK'})
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({pubkey: alice.pubkey, cx1: null})
  })

  it('credits a payment to the share it was paid to, even once the name is gone', async () => {
    const {mint} = await start()
    const alice = holder()
    await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})
    const paymentHash = await invoice(mint, 'alice', 21_000)
    expect((await address(mint, 'DELETE', 'alice', {sig: proof(alice, 'unregister', 'alice')})).body).toEqual({status: 'OK'})
    mint.backend.control.settleInvoice(paymentHash)
    await waitFor(() => mint.moneyer.store.noteById(keyAt(alice, 0)) !== null)
    expect(mint.moneyer.store.noteById(keyAt(alice, 0))).toMatchObject({amountMsat: 20_000, state: 'outstanding'})
    expect(mint.moneyer.store.zapInvoiceByHash(paymentHash)?.settled).toBe(true)
  })

  it('never credits a payment to whoever took the name since', async () => {
    const {mint} = await start()
    const alice = holder()
    await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})
    const paymentHash = await invoice(mint, 'alice', 21_000)
    await address(mint, 'DELETE', 'alice', {sig: proof(alice, 'unregister', 'alice')})
    const mallory = holder()
    expect((await address(mint, 'POST', 'alice', {cx1: mallory.cx1, sig: proof(mallory, 'register', 'alice')})).body).toEqual({status: 'OK'})
    mint.backend.control.settleInvoice(paymentHash)
    await waitFor(() => mint.moneyer.store.zapInvoiceByHash(paymentHash)?.settled === true)
    expect(mint.moneyer.store.noteById(keyAt(alice, 0))?.amountMsat).toBe(20_000)
    expect(mint.moneyer.store.noteById(keyAt(mallory, 0))).toBeNull()
  })

  it('takes a melt of a note of this mint as payment of the address fee', async () => {
    const {mint} = await start({namePriceMsat: 21_000})
    const alice = holder()
    const pr = (await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})).body.pr as string
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const melted = (await (await fetch(`${mint.moneyer.url}/w/cb?k1=${k1}&pr=${pr}`)).json()) as Record<string, unknown>
    expect(melted).toEqual({status: 'OK'})
    expect(mint.moneyer.store.noteById(noteIdOf(k1))?.state).toBe('burned')
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({cx1: alice.cx1, paidMsat: 21_000})
    // never routed: the node paid nothing
    expect(mint.backend.control.sentAmountMsat(decodeBolt11(pr).paymentHashHex)).toBeUndefined()
    // and the same invoice cannot be paid twice
    const again = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(again), 21_000)
    expect(((await (await fetch(`${mint.moneyer.url}/w/cb?k1=${again}&pr=${pr}`)).json()) as {status: string}).status).toBe('ERROR')
    expect(mint.moneyer.store.noteById(noteIdOf(again))?.state).toBe('outstanding')
  })

  it('takes no new registration while sunsetting', async () => {
    const {mint} = await start({sunset: true})
    const alice = holder()
    expect((await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})).body.reason).toMatch(/sunsetting/)
  })

  it('takes no unsigned npub, and no reserved or tagged username', async () => {
    const {mint} = await start()
    const alice = holder()
    const npubbed = await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice'), npub: 'npub1xyz'})
    expect(npubbed.body.reason).toMatch(/NIP-98/)
    for (const name of ['mint', 'admin', 'alice+tag']) {
      expect((await address(mint, 'POST', name, {cx1: alice.cx1, sig: proof(alice, 'register', name)})).body.status).toBe('ERROR')
    }
    expect(mint.moneyer.store.keyAccepted(alice.cx1)).toBe(false)
  })

  it('holds a name for its address fee, and publishes it once paid', async () => {
    const {mint} = await start({namePriceMsat: 21_000})
    const mintPay = await payRequestOf(mint, 'mint')
    expect(JSON.parse(mintPay.metadata as string)).toContainEqual(['text/plain', 'Mint fees: 1000,0,21000'])
    const alice = holder()
    const held = await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})
    expect(held.body.status).toBe('OK')
    const pr = held.body.pr as string
    expect(decodeBolt11(pr).amountMsats).toBe(21_000n)
    expect(await payRequestOf(mint, 'alice')).toEqual({status: 'ERROR', reason: 'unknown user'})
    const rival = holder()
    expect((await address(mint, 'POST', 'alice', {cx1: rival.cx1, sig: proof(rival, 'register', 'alice')})).body.reason).toBe('already registered')
    expect((await claim(mint, rival.sk, {name: 'alice', note: 'x'})).status).toBe(409)

    mint.backend.control.settleInvoice(decodeBolt11(pr).paymentHashHex)
    expect((await payRequestOf(mint, 'alice')).withdrawLink).toBe(`http://${HOST}/w`)
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({cx1: alice.cx1, paidMsat: 21_000})
  })

  it('keeps a lapsed hold for its grace, and a late payment never beats a rival hold', () => {
    const store = new NoteStore(':memory:')
    const t0 = Date.now()
    const a = holder()
    const b = holder()
    store.holdAddress({paymentHash: 'aa'.repeat(32), pr: 'lnbcA', name: 'carol', cx1: a.cx1, feeMsat: 21_000, expiresAt: t0 + 1_000, nowMs: t0})
    // just expired: a payment in its last seconds may not be seen yet
    expect(store.nameTaken('carol', t0 + 2_000)).toBe(true)
    const later = t0 + 1_000 + HOLD_GRACE_MS + 1
    expect(store.nameTaken('carol', later)).toBe(false)
    store.holdAddress({paymentHash: 'bb'.repeat(32), pr: 'lnbcB', name: 'carol', cx1: b.cx1, feeMsat: 21_000, expiresAt: later + 3_600_000, nowMs: later})
    // A's payment is seen only now: B's live hold keeps the name
    expect(store.settleHold('aa'.repeat(32), later)).toEqual({name: 'carol', registered: false})
    expect(store.zapName('carol')).toBeNull()
    expect(store.settleHold('bb'.repeat(32), later)).toEqual({name: 'carol', registered: true})
    expect(store.zapName('carol')?.cx1).toBe(b.cx1)
  })

  it('frees a held name once its fee invoice expires unpaid', async () => {
    const {mint} = await start({namePriceMsat: 21_000})
    const alice = holder()
    await address(mint, 'POST', 'alice', {cx1: alice.cx1, sig: proof(alice, 'register', 'alice')})
    const later = Date.now() + 2 * 3_600_000
    expect(mint.moneyer.store.nameTaken('alice', later)).toBe(false)
    const bob = holder()
    expect(mint.moneyer.store.nameTaken('alice')).toBe(true)
    mint.moneyer.store.registerShareName({name: 'alice', cx1: bob.cx1, nowMs: later})
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBe(bob.cx1)
  })
})

// A name registered before LUD-26 holds a whole branch's 64-byte cx1. It
// keeps working as it did, deriving the old purpose-2 keys, publishes no
// key any more, and moves to a share with a PUT proven by its old key.
describe('a name from before LUD-26', () => {
  const legacy = () => {
    const sk = generateSecretKey()
    const branchKey = secp256k1.utils.randomSecretKey()
    const branchPubkey = secp256k1.getPublicKey(branchKey, true).subarray(1)
    const chainCode = randomBytes(32)
    return {sk, pubkey: getPublicKey(sk), branchKey, branchPubkey, chainCode, cx1: encodeLegacyCx1({pubkeyXOnly: branchPubkey, chainCode})}
  }

  it('keeps crediting the old purpose-2 keys and publishes none of them', async () => {
    const {mint} = await start()
    const old = legacy()
    mint.moneyer.store.buyZapName({name: 'carol', pubkey: old.pubkey, paidMsat: 0, cx1: old.cx1})
    const pay = await payRequestOf(mint, 'carol')
    expect(JSON.stringify(pay)).not.toContain(old.cx1)
    expect(pay.withdrawLink).toBe(`http://${HOST}/w`)
    const paymentHash = await invoice(mint, 'carol', 21_000)
    mint.backend.control.settleInvoice(paymentHash)
    const expected = bytesToHex(deriveNotePubkey(old.branchPubkey, old.chainCode, NOTE_PURPOSE_LIGHTNING_ADDRESS, 0))
    await waitFor(() => mint.moneyer.store.noteById(expected) !== null)
    expect(mint.moneyer.store.noteById(expected)?.amountMsat).toBe(20_000)
  })

  it('moves to a share on the old branch key, and its x(P) is never accepted again', async () => {
    const {mint} = await start()
    const old = legacy()
    mint.moneyer.store.buyZapName({name: 'carol', pubkey: old.pubkey, paidMsat: 0, cx1: old.cx1})
    const share = holder()
    const sig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(message('update', 'carol', share.cx1))), old.branchKey, new Uint8Array(32)))
    const moved = await address(mint, 'PUT', 'carol', {cx1: share.cx1, sig, newsig: proof(share, 'register', 'carol', share.cx1)})
    expect(moved.body).toEqual({status: 'OK'})
    expect(mint.moneyer.store.zapName('carol')).toMatchObject({cx1: share.cx1, pubkey: old.pubkey, nextIndex: 0})
    // A share around the old branch's x(P) is the same key.
    const twin = encodeCx1({chainCode: randomBytes(32), pubkey: secp256k1.getPublicKey(old.branchKey, true)})
    expect(mint.moneyer.store.keyAccepted(twin)).toBe(true)
  })

  it('is backfilled into the accepted keys when an older database is opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-legacy-'))
    const path = join(dir, 'mint.db')
    const old = legacy()
    // What 0.21.0 left behind: the name and its cx1, and no accepted_keys.
    new NoteStore(path).close()
    const raw = new DatabaseSync(path)
    raw.exec('DROP TABLE accepted_keys')
    raw
      .prepare("INSERT INTO zap_names (name, pubkey, created_at, paid_msat, source, cx1, next_index) VALUES ('carol', ?, 0, 0, 'self', ?, 3)")
      .run(old.pubkey, old.cx1)
    raw.close()
    const store = new NoteStore(path)
    expect(store.keyAccepted(old.cx1)).toBe(true)
    expect(store.zapName('carol')).toMatchObject({cx1: old.cx1, nextIndex: 3, pubkey: old.pubkey})
    store.close()
    rmSync(dir, {recursive: true, force: true})
  })
})

// luds 26-vectors.json, as lnurlcash-conformance ships it: the mint's
// derivation and proofs byte for byte against the spec's own.
describe('the LUD-26 vectors', () => {
  const lud26 = specVectors.lud26

  it("derives every share note from the share's cx1 alone", () => {
    let checked = 0
    for (const seed of lud26.derivation) {
      for (const account of seed.accounts) {
        for (const shared of account.shareable) {
          const share = decodeShare(shared.cx1)!
          expect(share.legacy).toBe(false)
          for (const note of shared.notes) {
            expect(share.noteAt(note.i)).toBe(note.Q)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('verifies the register, update and unregister proofs, and binds each', () => {
    const r = lud26.registration
    const first = decodeShare(r.cx1)!
    const second = decodeShare(r.new_cx1)!
    const ok = (action: 'register' | 'update' | 'unregister', keys: Uint8Array[], sig: string, cx1?: string, domains = [r.domain], username = r.username) =>
      proofVerifies({action, domains, username, cx1, keys, sig})
    expect(ok('register', first.proofKeys(), r.register.sig, r.cx1)).toBe(true)
    expect(ok('update', first.proofKeys(), r.update.sig.sig, r.new_cx1)).toBe(true)
    expect(ok('register', second.proofKeys(), r.update.newsig.sig, r.new_cx1)).toBe(true)
    expect(ok('unregister', second.proofKeys(), r.unregister.sig)).toBe(true)
    expect(registrationMessage('register', r.domain, r.username, r.cx1)).toBe(r.register.message)
    // bound to its cx1, action, username and domain
    expect(ok('register', first.proofKeys(), r.register.sig, r.new_cx1)).toBe(false)
    expect(ok('unregister', first.proofKeys(), r.register.sig)).toBe(false)
    expect(ok('register', first.proofKeys(), r.register.sig, r.cx1, [r.domain], 'bob')).toBe(false)
    expect(ok('register', first.proofKeys(), r.register.sig, r.cx1, ['mint.example'])).toBe(false)
    expect(ok('register', first.proofKeys(), r.register.sig, r.cx1, ['mint.example', r.domain])).toBe(true)
  })
})
