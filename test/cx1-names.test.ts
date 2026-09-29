import {afterEach, describe, expect, it} from 'vitest'
import {finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate} from 'nostr-tools/pure'
import {unwrapEvent} from 'nostr-tools/nip59'
import {matchFilter, type Filter} from 'nostr-tools/filter'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {
  ServiceError,
  decodeCx1,
  encodeCk1,
  encodeCp1,
  encodeCx1,
  hashK1,
  mergeNotesWithHash,
  signNoteOwnership,
} from '@lnurlcash/kit'
import {NOTE_PURPOSE_LIGHTNING_ADDRESS, NOTE_PURPOSE_WALLET, deriveNotePubkey} from '../src/spend.ts'
import {NIP98_KIND, addressProofVerifies} from '../src/names.ts'
import {NOTE_KIND, type NostrTransport} from '../src/zap.ts'
import {startMint, waitFor, type TestMint, noteIdOf, certifiesNote} from './helpers.ts'

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

const start = async (overrides: Record<string, unknown> = {}) => {
  const relay = fakeRelay()
  active = await startMint(
    {
      publicOrigin: `http://${HOST}`,
      mintFee: {baseFeeMsat: 1000, feePpm: 0},
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {}},
      namePriceMsat: 0,
      ...overrides
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

// LUD-25's address proof, by the branch's index-0 key, bound to this mint.
const proof = (who: Holder, action: 'register' | 'unregister', name: string, domain = HOST): string =>
  bytesToHex(
    schnorr.sign(
      sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${name}`)),
      deriveNoteSecretKey(who, NOTE_PURPOSE_WALLET, 0),
      new Uint8Array(32)
    )
  )

// `prover`, when given, signs the address proof a cx1 change needs.
const claim = async (mint: TestMint, secret: Uint8Array, body: Record<string, unknown>, prover?: Holder) => {
  if (prover && body.cx1 !== undefined && typeof body.name === 'string') {
    body = {...body, sig: proof(prover, body.cx1 === null ? 'unregister' : 'register', body.name)}
  }
  const payload = JSON.stringify(body)
  const res = await fetch(`${mint.moneyer.url}/names`, {
    method: 'POST',
    headers: {authorization: token(secret, payload), 'content-type': 'application/json'},
    body: payload
  })
  return {status: res.status, body: (await res.json()) as Record<string, unknown>}
}

type Holder = {
  sk: Uint8Array
  pubkey: string
  branchPrivateKey: Uint8Array
  branchPubkey: Uint8Array
  chainCode: Uint8Array
  cx1: string
}

const holder = (): Holder => {
  const sk = generateSecretKey()
  const branchPrivateKey = secp256k1.utils.randomSecretKey()
  const branchPubkey = secp256k1.getPublicKey(branchPrivateKey, true).subarray(1)
  const chainCode = randomBytes(32)
  return {
    sk,
    pubkey: getPublicKey(sk),
    branchPrivateKey,
    branchPubkey,
    chainCode,
    cx1: encodeCx1(branchPubkey, chainCode)
  }
}

// The wallet's half of LUD-25's derivation, which the kit pinned here
// predates: the branch key taken at even y, plus the same tweak the mint
// adds to derive the public key.
const N = secp256k1.Point.CURVE().n
const toBigInt = (bytes: Uint8Array): bigint => BigInt(`0x${bytesToHex(bytes)}`)
const ser32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n, false)
  return bytes
}
const deriveNoteSecretKey = (who: Holder, purpose: number, index: number): Uint8Array => {
  let d = toBigInt(who.branchPrivateKey)
  if (secp256k1.getPublicKey(who.branchPrivateKey, true)[0] === 3) d = N - d
  const t = toBigInt(schnorr.utils.taggedHash('LNURLcash/derive', who.branchPubkey, who.chainCode, ser32(purpose), ser32(index))) % N
  return Uint8Array.from(Buffer.from(((d + t) % N).toString(16).padStart(64, '0'), 'hex'))
}

// Lightning Address payments land on their own purpose of the branch.
const keyAt = (who: Holder, index: number): string =>
  bytesToHex(deriveNotePubkey(who.branchPubkey, who.chainCode, NOTE_PURPOSE_LIGHTNING_ADDRESS, index))

const ck1At = (who: Holder, index: number): string => {
  const {pubkeyXOnly, signature} = signNoteOwnership(deriveNoteSecretKey(who, NOTE_PURPOSE_LIGHTNING_ADDRESS, index))
  return encodeCk1(pubkeyXOnly, signature)
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

describe('a name with a cx1', () => {
  it('is registered by its owner, who alone may change or clear the branch', async () => {
    const {mint} = await start()
    const alice = holder()
    const granted = await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect(granted.status).toBe(200)
    expect(granted.body.cx1).toBe(alice.cx1)
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({cx1: alice.cx1, nextIndex: 0})

    expect((await claim(mint, holder().sk, {name: 'alice', cx1: holder().cx1})).status).toBe(409)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: 'cx1nonsense'})).status).toBe(400)

    const cleared = await claim(mint, alice.sk, {name: 'alice', cx1: null}, alice)
    expect(cleared.status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBeNull()
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
    expect(first.url.searchParams.has('amount')).toBe(false)
    expect(first.rumor.tags).toContainEqual(['i', '0'])
    // the holder checks the certificate, then opens the note with its own key
    expect(certifiesNote(ck1At(alice, 0), 20_000, first.url.searchParams.get('c')!, mint.moneyer.signer.pubkey)).toBe(
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
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    await invoice(mint, 'alice', 21_000)
    await invoice(mint, 'alice', 21_000)
    const paid = await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    expect(paid.url.searchParams.get('i')).toBe('0')
  })

  it('publishes the next free branch key as an internal-transfer hint', async () => {
    const {mint} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    mint.moneyer.store.creditNote(keyAt(alice, 0), 5_000)

    const pay = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/alice`)).json()) as {metadata: string}
    const entries = JSON.parse(pay.metadata) as unknown[][]
    expect(entries).toContainEqual(['text/cpub', `${alice.cx1}:1`])
    // Never the older name: a wallet reading it would derive without a purpose.
    expect(entries.some(entry => entry[0] === 'text/xpub')).toBe(false)

    const custodial = holder()
    await claim(mint, custodial.sk, {name: 'bobby'})
    const oldPay = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/bobby`)).json()) as {metadata: string}
    expect(JSON.parse(oldPay.metadata).some((entry: unknown[]) => entry[0] === 'text/cpub')).toBe(false)
  })

  it('accepts an internal transfer on the address purpose and advances after a raced hint', async () => {
    const {mint} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    const pay = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/alice`)).json()) as {metadata: string}
    const hint = (JSON.parse(pay.metadata) as string[][]).find(entry => entry[0] === 'text/cpub')![1]!
    const sep = hint.lastIndexOf(':')
    const branch = decodeCx1(hint.slice(0, sep))!
    expect(Number(hint.slice(sep + 1))).toBe(0)

    // The payRequest was honest when read, but another transfer wins index
    // zero before this one lands. The specific collision answer lets the
    // payer retry at one without risking the input, as LUD-25's internal
    // transfer does (the kit pinned here predates purposes, so this walks
    // the same merge by hand).
    mint.moneyer.store.creditNote(keyAt(alice, 0), 5_000)
    const source = bytesToHex(randomBytes(32))
    mint.moneyer.store.creditNote(noteIdOf(source), 21_000)
    let index = Number(hint.slice(sep + 1))
    let signature: string | undefined
    for (;; index++) {
      const output = encodeCp1(deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, NOTE_PURPOSE_LIGHTNING_ADDRESS, index))
      try {
        signature = (await mergeNotesWithHash(`${mint.moneyer.url}/w/cb`, [source], output)).signature
        break
      } catch (err) {
        if (!(err instanceof ServiceError && err.reason === 'already in use') || index > 3) throw err
      }
    }

    expect(index).toBe(1)
    expect(mint.moneyer.store.noteById(noteIdOf(source))?.state).toBe('burned')
    expect(mint.moneyer.store.noteById(keyAt(alice, 1))).toMatchObject({amountMsat: 21_000, state: 'outstanding'})
    expect(certifiesNote(ck1At(alice, 1), 21_000, signature!, mint.moneyer.signer.pubkey)).toBe(true)
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

  it('starts a new branch at index 0, and keeps its place when the same one is sent again', async () => {
    const {mint, relay} = await start()
    const alice = holder()
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect(mint.moneyer.store.zapName('alice')?.nextIndex).toBe(1)
    await claim(mint, alice.sk, {name: 'alice', cx1: holder().cx1}, alice)
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

  it('lets the owner of an operator name set a branch while registration is closed', async () => {
    const alice = holder()
    const {mint} = await start({
      namePriceMsat: undefined,
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice: alice.pubkey}}
    })
    const set = await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    expect(set.status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBe(alice.cx1)
    // still closed to anyone wanting a new name, and still not a stranger's
    expect((await claim(mint, holder().sk, {name: 'bobby', cx1: holder().cx1})).status).toBe(404)
    expect((await claim(mint, holder().sk, {name: 'alice', cx1: holder().cx1})).status).toBe(409)
  })

  it('needs the address proof to point a name at a branch, or away from one', async () => {
    const {mint} = await start()
    const alice = holder()
    const stranger = holder()
    // No proof, a proof by some other branch, one bound to another mint,
    // and one for the other action are all refused, and nothing is set.
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1})).status).toBe(403)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, stranger)).status).toBe(403)
    const elsewhere = proof(alice, 'register', 'alice', 'other.example')
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1, sig: elsewhere})).status).toBe(403)
    const wrongAction = proof(alice, 'unregister', 'alice')
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1, sig: wrongAction})).status).toBe(403)
    expect(mint.moneyer.store.zapName('alice')).toBeNull()

    expect((await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)).status).toBe(200)
    // Switching is proven by the branch on file, not the one switched to.
    const next = holder()
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: next.cx1}, next)).status).toBe(403)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBe(alice.cx1)
    // Clearing is an unregister by the branch on file.
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: null}, next)).status).toBe(403)
    expect((await claim(mint, alice.sk, {name: 'alice', cx1: null}, alice)).status).toBe(200)
    expect(mint.moneyer.store.zapName('alice')?.cx1).toBeNull()
  })

  it("keeps an operator name's branch across a restart, and drops it when the operator gives the name away", async () => {
    const alice = holder()
    const {mint, relay} = await start({
      namePriceMsat: undefined,
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice: alice.pubkey}}
    })
    await claim(mint, alice.sk, {name: 'alice', cx1: alice.cx1}, alice)
    await settle(mint, relay, alice, await invoice(mint, 'alice', 21_000))
    const store = mint.moneyer.store
    expect(store.zapName('alice')).toMatchObject({cx1: alice.cx1, nextIndex: 1})

    // What every startup does with the environment's names.
    store.putOperatorZapName('alice', alice.pubkey)
    expect(store.zapName('alice')).toMatchObject({pubkey: alice.pubkey, cx1: alice.cx1, nextIndex: 1})

    const bob = holder()
    store.putOperatorZapName('alice', bob.pubkey)
    expect(store.zapName('alice')).toMatchObject({pubkey: bob.pubkey, cx1: null, nextIndex: 0})
  })
})

// LUD-25's test vector 2: the address proof, by the branch's purpose-0
// index-0 key.
describe('the address proof', () => {
  const cx1 =
    'cx1vjy9489tj0kq29mphzstsrsc2jnpsev834v0w23kth7kgzzs7e6kh9tet7vq0tdgtjx22rkf8jfpfqapsw4la49rkj47dw2u3xyqxpspgvxpa'
  const register =
    '9169a81db3372d8bb8a080f271f8036192131d4ed02596c0baa181613fdc5d6e17b3230b01f510a759fdb6c46b53671e57678f57ac0a6a3deb6300761225adc7'
  const unregister =
    'fcc6a96f560d6505bfc475d8c2d4383047f2ece6593412af9b2834913af60f108b6e194cef31c377a23a051f8c80c1660efc2313b7876a2f80bc1f0f423c7835'
  const check = (action: 'register' | 'unregister', sig: string, domains = ['cash.example.com'], name = 'alice') =>
    addressProofVerifies({cx1, action, name, domains, sig})

  it("verifies the spec's register and unregister signatures", () => {
    expect(check('register', register)).toBe(true)
    expect(check('unregister', unregister)).toBe(true)
  })

  it('binds each to its action, name and domain', () => {
    expect(check('unregister', register)).toBe(false)
    expect(check('register', register, ['cash.example.com'], 'bob')).toBe(false)
    expect(check('register', register, ['mint.example'])).toBe(false)
    expect(check('register', register, ['mint.example', 'cash.example.com'])).toBe(true)
  })
})
