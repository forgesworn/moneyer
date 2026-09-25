import {describe, expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, concatBytes, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'
import {
  bearerNote,
  bearerNoteId,
  checkLeaf,
  checkTimeClaim,
  decodeNote,
  decodeSpend,
  encodeCk1,
  encodeCp1,
  encodeCw1,
  keyPathSighash,
  spendPrevout,
  spendSigMsg,
  verifySpend,
  type Spend
} from '../src/spend.ts'

// LUD-25's own test vectors 3 and 5, then lnurl-wallet's spends as the
// reference mint's kernel checks them.

const SK0 = '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f'
const Q0 = 'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
const VECTOR3_CK1 =
  'ck14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc6g8wlplczy60g4e5wp3dyyz6xr07fpse9flp0fy50cg4a4w64av6eprdctjlan6cu9dt38re9nu08etk5w3dmknlhuxzwcm3ycjysw3c9dpmpy'
const VECTOR5_PREIMAGE = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const VECTOR5_H = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd'
const VECTOR5_Q = 'd18b619687343df2fc7a47e1daf25260b909bb563fb4b4b11e59e2bd64880982'
const VECTOR5_CW1 =
  'cw1qqqqqq8lllll7qpr4qsxxrwd99nvgvmxjyf9gj9mkfd5laqj5jw8xtdjez4urwzcr0t3phv8qqsuq5yjnd6vrgzf2jmckjmqxh5h5hs83fdq728vjm2500lwnt8gqwkqqqsqqqgzqvzq2ps8pqys5zcvp58q7yq3zgf3g9gkzuvpjxsmrsw3u8c6x6a4c'

const NOW = 1_800_000_000

const verified = (spend: Spend, domains: string[], lockedAt = 0, now = NOW) =>
  verifySpend(spend, {outputKey: spend.outputKey, domains, now, lockedAt})

describe('test vector 3: key-path spend', () => {
  it('builds the prevout, SigMsg and sighash the spec shows', () => {
    expect(bytesToHex(spendPrevout('mint.example'))).toBe('d5ac2de3423432e37713bcb133cfea7938ff6b2f8ea4174dfcec84bea705d6b2')
    const sigMsg = spendSigMsg({outputKey: hexToBytes(Q0), domain: 'mint.example', locktime: 0, sequence: 0xffffffff})
    expect(sigMsg.length).toBe(174)
    expect(bytesToHex(keyPathSighash(hexToBytes(Q0), 'mint.example'))).toBe(
      'b8933a42090297a1f80d7f1fc0023ec1aa2ab36a7df332520f0dacf07f617943'
    )
  })

  it('reproduces the ck1 with an all-zero aux_rand', () => {
    const sig = schnorr.sign(keyPathSighash(hexToBytes(Q0), 'mint.example'), hexToBytes(SK0), new Uint8Array(32))
    expect(encodeCk1(hexToBytes(Q0), sig)).toBe(VECTOR3_CK1)
  })

  it('verifies at its own domain and nowhere else', async () => {
    const spend = decodeSpend(VECTOR3_CK1)!
    expect(spend.kind).toBe('key')
    expect(bytesToHex(spend.outputKey)).toBe(Q0)
    expect(await verified(spend, ['mint.example'])).toEqual({ok: true})
    expect(await verified(spend, ['other.example'])).toEqual({ok: false, reason: 'invalid', specific: false})
    // Any of a mint's own domains will do: a clearnet and an onion host.
    expect(await verified(spend, ['other.example', 'mint.example'])).toEqual({ok: true})
  })

  it('still reads the deprecated fixed-message ck1s', async () => {
    const sk = hexToBytes(SK0)
    for (const message of [sha256(utf8ToBytes('LNURLcash')), utf8ToBytes('LNURLcash')]) {
      const spend = decodeSpend(encodeCk1(hexToBytes(Q0), schnorr.sign(message, sk, new Uint8Array(32))))!
      expect(await verified(spend, ['mint.example'])).toEqual({ok: true})
    }
    // The pre-Schnorr shape: 65 bytes of recoverable ECDSA, r || s || recid.
    const digest = sha256(sha256(utf8ToBytes('Lightning Signed Message:LNURLcash')))
    const lead = secp256k1.sign(digest, sk, {format: 'recovered', prehash: false})
    const wire = concatBytes(lead.subarray(1), lead.subarray(0, 1))
    const legacy = decodeSpend(bech32m.encode('ck', bech32m.toWords(wire), 1000))!
    expect(legacy.kind).toBe('recovered')
    expect(bytesToHex(legacy.outputKey)).toBe(Q0)
  })

  it('refuses a ck1 of any other length, and a signature by another key', async () => {
    expect(decodeSpend(bech32m.encode('ck', bech32m.toWords(new Uint8Array(95)), 1000))).toBeNull()
    const wrong = schnorr.sign(keyPathSighash(hexToBytes(Q0), 'mint.example'), hexToBytes('11'.repeat(32)), new Uint8Array(32))
    const spend = decodeSpend(encodeCk1(hexToBytes(Q0), wrong))!
    expect((await verified(spend, ['mint.example'])).ok).toBe(false)
  })
})

describe('test vector 5: bearer note', () => {
  it('derives Q and the control block from h', () => {
    const note = bearerNote(hexToBytes(VECTOR5_H))
    expect(bytesToHex(note.outputKey)).toBe(VECTOR5_Q)
    expect(bytesToHex(note.controlBlock)).toBe('c050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')
    expect(encodeCp1(note.outputKey)).toBe('cp16x9kr958xs7l9lr6glsa4ujjvzusnw6k876tfvg7t83t6eygpxpq6we0xc')
  })

  it('reads both short forms as the same note', () => {
    expect(decodeNote(VECTOR5_H)).toBe(VECTOR5_Q)
    expect(decodeNote(VECTOR5_H.toUpperCase())).toBe(VECTOR5_Q)
    expect(decodeNote('cp16x9kr958xs7l9lr6glsa4ujjvzusnw6k876tfvg7t83t6eygpxpq6we0xc')).toBe(VECTOR5_Q)
    expect(bytesToHex(decodeSpend(VECTOR5_PREIMAGE)!.outputKey)).toBe(VECTOR5_Q)
  })

  it('encodes and decodes the full cw1', async () => {
    const spend = decodeSpend(VECTOR5_CW1)!
    expect(spend.kind).toBe('script')
    expect(bytesToHex(spend.outputKey)).toBe(VECTOR5_Q)
    if (spend.kind !== 'script') return
    expect(encodeCw1(spend)).toBe(VECTOR5_CW1)
    expect(encodeCw1(decodeSpend(VECTOR5_PREIMAGE) as typeof spend)).toBe(VECTOR5_CW1)
    // A preimage is bound to no domain.
    expect(await verified(spend, ['anywhere.example'])).toEqual({ok: true})
  })

  it('refuses a wrong preimage, an extra witness item and a cp1 off the curve', async () => {
    const good = decodeSpend(VECTOR5_CW1)
    if (good?.kind !== 'script') throw new Error('expected a script spend')
    const wrong = {...good, witness: [new Uint8Array(32)]}
    expect((await verified(wrong, ['m'])).ok).toBe(false)
    const extra = {...good, witness: [new Uint8Array(1), hexToBytes(VECTOR5_PREIMAGE)]}
    expect((await verified(extra, ['m'])).ok).toBe(false)
    // x = 5 is not on secp256k1.
    const offCurve = new Uint8Array(32)
    offCurve[31] = 5
    expect(decodeNote(encodeCp1(offCurve))).toBeNull()
  })

  it('refuses a cw1 whose length prefixes do not consume it exactly', () => {
    const words = bech32m.decode(VECTOR5_CW1 as `${string}1${string}`, 1000).words
    const bytes = bech32m.fromWords(words)
    expect(decodeSpend(bech32m.encode('cw', bech32m.toWords(bytes.subarray(0, bytes.length - 1)), 1000))).toBeNull()
    expect(decodeSpend(bech32m.encode('cw', bech32m.toWords(bytes.subarray(0, 8 + 2 + 35)), 1000))).toBeNull()
  })

  it('names the bearer note by h', () => {
    expect(bearerNoteId(VECTOR5_H)).toBe(VECTOR5_Q)
  })
})

describe('upgrade hooks and time claims', () => {
  const leafSpend = (script: Uint8Array, version = 0xc0) => {
    const {outputKey} = bearerNote(new Uint8Array(32))
    return {script, controlBlock: concatBytes(new Uint8Array([version]), new Uint8Array(32)), outputKey}
  }

  it('refuses an unknown leaf version or an OP_SUCCESS opcode outside pushed data', () => {
    expect(checkLeaf(new Uint8Array([0x51]), leafSpend(new Uint8Array(0), 0xc2).controlBlock)).toBe('unknown tapleaf version')
    expect(checkLeaf(new Uint8Array([0x50]), leafSpend(new Uint8Array(0)).controlBlock)).toMatch(/OP_SUCCESS/)
    expect(checkLeaf(new Uint8Array([0xbb]), leafSpend(new Uint8Array(0)).controlBlock)).toMatch(/OP_SUCCESS/)
    // The same byte inside a push is data, not an opcode.
    expect(checkLeaf(new Uint8Array([0x01, 0x50, 0x51]), leafSpend(new Uint8Array(0)).controlBlock)).toBeNull()
  })

  it('takes Unix-time claims only, against the mint clock', () => {
    const base = {sequence: 0xffffffff, now: NOW, lockedAt: NOW - 100}
    expect(checkTimeClaim({...base, locktime: 0})).toBeNull()
    expect(checkTimeClaim({...base, locktime: 800_000})).toMatch(/block-height/)
    expect(checkTimeClaim({...base, locktime: NOW + 1})).toMatch(/future/)
    expect(checkTimeClaim({...base, locktime: NOW})).toBeNull()
    // BIP-68: bit 22 set means 512-second units, and it is counted from
    // when this mint credited the note.
    expect(checkTimeClaim({locktime: 0, sequence: 10, now: NOW, lockedAt: 0})).toMatch(/block-count/)
    const oneUnit = (1 << 22) | 1
    expect(checkTimeClaim({locktime: 0, sequence: oneUnit, now: NOW, lockedAt: NOW - 511})).toMatch(/not yet satisfied/)
    expect(checkTimeClaim({locktime: 0, sequence: oneUnit, now: NOW, lockedAt: NOW - 512})).toBeNull()
  })
})

describe("lnurl-wallet's spends, as the reference kernel judges them", () => {
  const {vectors} = JSON.parse(readFileSync(new URL('./fixtures/wallet-spend-vectors.json', import.meta.url), 'utf8')) as {
    vectors: Array<{name: string; output_key: string; spend: string; domain: string; locked_at: number; now: number; cp1: string}>
  }

  it.each(vectors)('$name decodes to its note', vector => {
    const spend = decodeSpend(vector.spend)!
    expect(bytesToHex(spend.outputKey)).toBe(vector.output_key)
    expect(decodeNote(vector.cp1)).toBe(vector.output_key)
  })

  it.each(vectors)('$name verifies, natively or by handing the leaf on', async vector => {
    const spend = decodeSpend(vector.spend)!
    const handedOn: string[] = []
    const verdict = await verifySpend(spend, {
      outputKey: hexToBytes(vector.output_key),
      domains: [vector.domain],
      now: vector.now,
      lockedAt: vector.locked_at,
      scriptVerifier: async ({domain}) => {
        handedOn.push(domain)
        return null
      }
    })
    expect(verdict).toEqual({ok: true})
    // Only leaves this mint cannot judge itself leave the process.
    expect(handedOn.length).toBe(spend.kind === 'script' && !isBearerLeaf(spend.script) ? 1 : 0)
  })

  it('refuses a leaf it cannot judge when no verifier is configured', async () => {
    const vector = vectors.find(candidate => candidate.name === 'multisig2')!
    const spend = decodeSpend(vector.spend)!
    expect(await verified(spend, [vector.domain], vector.locked_at, vector.now)).toEqual({
      ok: false,
      reason: 'this mint cannot verify that script yet',
      specific: true
    })
  })
})

const isBearerLeaf = (script: Uint8Array): boolean =>
  script.length === 35 && script[0] === 0xa8 && script[1] === 0x20 && script[34] === 0x87
