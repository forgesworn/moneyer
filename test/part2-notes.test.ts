import {afterEach, describe, expect, it} from 'vitest'
import {
  encodeCk1,
  encodeCp1,
  hashK1,
  signNoteOwnership,
  verifyNoteSignature,
  verifyNoteSignatureHash
} from '@lnurlcash/kit'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// LUD-25 Part 2: a note keyed by a public key (cp1), spent with a recoverable
// ownership signature (ck1), certified by the mint as cs1.

let active: TestMint | null = null
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

type Body = Record<string, unknown>

const call = async (mint: TestMint, path: string, params: Array<[string, string]>): Promise<Body> => {
  const url = new URL(`${mint.moneyer.url}${path}`)
  for (const [name, value] of params) url.searchParams.append(name, value)
  return (await (await fetch(url)).json()) as Body
}
const info = (mint: TestMint, params: Array<[string, string]>) => call(mint, '/w', params)
const worth = async (mint: TestMint, k1: string): Promise<unknown> =>
  (await info(mint, [['k1', k1]])).maxWithdrawable
const callback = (mint: TestMint, params: Array<[string, string]>) => call(mint, '/w/cb', params)

type NoteKey = {sk: Uint8Array; id: string; cp1: string; ck1: string}

const freshKey = (): NoteKey => {
  const sk = secp256k1.utils.randomSecretKey()
  const pk = secp256k1.getPublicKey(sk, true).slice(1)
  const {pubkeyXOnly, signature} = signNoteOwnership(sk)
  return {sk, id: bytesToHex(pk), cp1: encodeCp1(pk), ck1: encodeCk1(pubkeyXOnly, signature)}
}

const creditKey = (mint: TestMint, amountMsat: number): NoteKey => {
  const key = freshKey()
  mint.moneyer.store.creditNote(key.id, amountMsat)
  return key
}

const creditSecret = (mint: TestMint, amountMsat: number): string => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(hashK1(k1), amountMsat)
  return k1
}

const OWNERSHIP_DIGEST = sha256(utf8ToBytes('LNURLcash'))

// A second, equally valid ck1 the key's owner can make with a fresh nonce.
// BIP-340 Schnorr, unlike the old recoverable-ECDSA scheme, has no cheap
// bit-flip malleation of a FIXED signature into another one that still
// verifies (there is no separate "flip s and the recovery id" trick): the
// only way to get a second valid ck1 for one key is a fresh nonce, same as
// this.
const resigned = (key: NoteKey): string => {
  const pubkeyXOnly = secp256k1.getPublicKey(key.sk, true).slice(1)
  const signature = schnorr.sign(OWNERSHIP_DIGEST, key.sk, randomBytes(32))
  return encodeCk1(pubkeyXOnly, signature)
}

const certifies = (mint: TestMint, key: NoteKey, amountMsat: number, sig: unknown): boolean =>
  typeof sig === 'string' &&
  verifyNoteSignature(key.ck1, amountMsat, sig, mint.moneyer.signer.pubkey)

describe('minting to a cp1 key', () => {
  it('credits the note at the key named in the comment', async () => {
    const mint = await start()
    const key = freshKey()
    const quote = await call(mint, '/p/cb', [['amount', '21000'], ['comment', key.cp1]])
    expect(typeof quote.pr).toBe('string')
    mint.backend.control.settleInvoice(decodeBolt11(quote.pr as string).paymentHashHex)

    const note = await info(mint, [['k1', key.ck1]])
    expect(note.maxWithdrawable).toBe(21_000)
    expect(note.k1).toBe(key.ck1)
    expect(certifies(mint, key, 21_000, note.sig)).toBe(true)
  })

  it('refuses a comment that is neither a hash nor a cp1 key', async () => {
    const mint = await start()
    const reply = await call(mint, '/p/cb', [['amount', '21000'], ['comment', `cp1${'q'.repeat(58)}`]])
    expect(reply.status).toBe('ERROR')
  })
})

describe('looking a cp1 note up', () => {
  it('by p, without the ck1, with its certificate', async () => {
    const mint = await start()
    const key = creditKey(mint, 42_000)
    const byKey = await info(mint, [['p', key.cp1]])
    expect(byKey.maxWithdrawable).toBe(42_000)
    expect(byKey).not.toHaveProperty('k1')
    expect(certifies(mint, key, 42_000, byKey.sig)).toBe(true)
    expect(verifyNoteSignatureHash(key.id, 42_000, byKey.sig as string, mint.moneyer.signer.pubkey)).toBe(true)
  })

  it('by its id as hex, which names it as a hash and gets no certificate', async () => {
    const mint = await start()
    const key = creditKey(mint, 42_000)
    const byHex = await info(mint, [['p', key.id]])
    expect(byHex.maxWithdrawable).toBe(42_000)
    expect(byHex).not.toHaveProperty('sig')
  })

  it('by both spellings of the same key at once', async () => {
    const mint = await start()
    const key = creditKey(mint, 42_000)
    const both = await info(mint, [['p', key.cp1], ['h', key.id]])
    expect(both.maxWithdrawable).toBe(42_000)
  })

  it('answers unknown for a key that holds no note, and for a ck1 that does not decode', async () => {
    const mint = await start()
    expect((await info(mint, [['k1', freshKey().ck1]])).reason).toBe('Unknown note.')
    expect((await info(mint, [['p', freshKey().cp1]])).reason).toBe('Unknown note.')
    const bad = freshKey().ck1
    expect((await info(mint, [['k1', bad.slice(0, -1) + (bad.endsWith('q') ? 'p' : 'q')]])).reason).toBe(
      'Unknown note.'
    )
  })
})

describe('spending with a ck1', () => {
  it('rotates a cp1 note into a fresh key and certifies the new one', async () => {
    const mint = await start()
    const from = creditKey(mint, 30_000)
    const to = freshKey()
    const reply = await callback(mint, [['k1', from.ck1], ['p1', to.cp1]])
    expect(reply.status).toBe('OK')
    expect(certifies(mint, to, 30_000, reply.sig)).toBe(true)
    expect((await info(mint, [['k1', from.ck1]])).reason).toBe('Note already spent.')
    expect((await info(mint, [['k1', to.ck1]])).maxWithdrawable).toBe(30_000)
  })

  it('rotates between the two kinds of note', async () => {
    const mint = await start()
    const secret = creditSecret(mint, 20_000)
    const key = freshKey()
    const toKey = await callback(mint, [['k1', secret], ['p1', key.cp1]])
    expect(certifies(mint, key, 20_000, toKey.sig)).toBe(true)

    const next = freshK1()
    const toHash = await callback(mint, [['k1', key.ck1], ['p1', hashK1(next)]])
    expect(toHash.status).toBe('OK')
    expect(verifyNoteSignature(next, 20_000, toHash.sig as string, mint.moneyer.signer.pubkey)).toBe(true)
    expect(await worth(mint, next)).toBe(20_000)
  })

  it('names a public-key output collision so an internal transfer can advance its index', async () => {
    const mint = await start()
    const from = creditSecret(mint, 20_000)
    const occupied = creditKey(mint, 5_000)
    const reply = await callback(mint, [['k1', from], ['p1', occupied.cp1]])
    expect(reply).toEqual({status: 'ERROR', reason: 'Output already in use.'})
    expect(await worth(mint, from)).toBe(20_000)
  })

  it('splits into a cp1 key and a hash, certifying each in its wire format', async () => {
    const mint = await start()
    const from = creditKey(mint, 50_000)
    const key = freshKey()
    const change = freshK1()
    const reply = await callback(mint, [
      ['k1', from.ck1],
      ['amount', '20000'],
      ['p1', key.cp1],
      ['p2', hashK1(change)]
    ])
    expect(reply.status).toBe('OK')
    expect(certifies(mint, key, 20_000, reply.sig)).toBe(true)
    expect(verifyNoteSignature(change, 30_000, reply.sig2 as string, mint.moneyer.signer.pubkey)).toBe(true)
    expect(await worth(mint, change)).toBe(30_000)
  })

  it('merges a Part 1 note and a Part 2 note in one request', async () => {
    const mint = await start()
    const secret = creditSecret(mint, 11_000)
    const from = creditKey(mint, 22_000)
    const to = freshKey()
    const reply = await callback(mint, [['k1', secret], ['k1', from.ck1], ['p1', to.cp1]])
    expect(reply.status).toBe('OK')
    expect(certifies(mint, to, 33_000, reply.sig)).toBe(true)
  })

  it('answers a retried rotate as a replay, with the same certificate', async () => {
    const mint = await start()
    const from = creditKey(mint, 30_000)
    const to = freshKey()
    const first = await callback(mint, [['k1', from.ck1], ['p1', to.cp1]])
    const again = await callback(mint, [['k1', from.ck1], ['p1', to.cp1]])
    expect(again).toEqual(first)
  })

  it('melts a cp1 note with its ck1', async () => {
    const mint = await start()
    const key = creditKey(mint, 21_000)
    const pr = fakeBolt11({amountMsat: 21_000, paymentHashHex: freshK1()})
    expect((await callback(mint, [['k1', key.ck1], ['pr', pr]])).status).toBe('OK')
    // reserved while the payment is in flight, burned once it lands
    expect((await info(mint, [['k1', key.ck1]])).reason).toMatch(/^pending$|^Note already spent\.$/)
  })

  it('refuses a ck1 whose key holds no note, burning nothing', async () => {
    const mint = await start()
    const live = creditKey(mint, 10_000)
    const reply = await callback(mint, [['k1', live.ck1], ['k1', freshKey().ck1], ['p1', freshKey().cp1]])
    expect(reply.reason).toBe('Invalid or already spent k1.')
    expect((await info(mint, [['k1', live.ck1]])).maxWithdrawable).toBe(10_000)
  })

  it('refuses p1 and p2 that name one note in two spellings', async () => {
    const mint = await start()
    const from = creditKey(mint, 50_000)
    const key = freshKey()
    const reply = await callback(mint, [['k1', from.ck1], ['amount', '1000'], ['p1', key.cp1], ['p2', key.id]])
    expect(reply.reason).toBe('p1 and p2 must differ.')
  })
})

describe('a note named twice', () => {
  // Two ck1 strings for one note would count its value twice in a merge.
  for (const [how, spell] of [
    ['the same ck1 twice', (key: NoteKey) => key.ck1],
    ['a second signature by the same key', resigned]
  ] as const) {
    it(`is refused when spelled as ${how}, with nothing burned`, async () => {
      const mint = await start()
      const key = creditKey(mint, 25_000)
      const other = spell(key)
      // every spelling really does identify the note on its own
      expect((await info(mint, [['k1', other]])).maxWithdrawable).toBe(25_000)
      const reply = await callback(mint, [['k1', key.ck1], ['k1', other], ['p1', freshKey().cp1]])
      expect(reply.reason).toBe('Invalid or already spent k1.')
      expect((await info(mint, [['k1', key.ck1]])).maxWithdrawable).toBe(25_000)
    })
  }

  it('is refused by the store itself, before anything is burned', async () => {
    const mint = await start()
    const key = creditKey(mint, 25_000)
    expect(() => mint.moneyer.store.swap([key.id, key.id], [{id: freshKey().id, amountMsat: 50_000}])).toThrow()
    expect(mint.moneyer.store.noteById(key.id)?.state).toBe('outstanding')
  })
})
