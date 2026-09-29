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
  deriveNotePubkey,
  encodeCk1,
  encodeCp1,
  encodeCw1,
  keyPathSighash,
  NOTE_PURPOSE_CHANGE,
  NOTE_PURPOSE_LIGHTNING_ADDRESS,
  NOTE_PURPOSE_WALLET,
  spendPrevout,
  spendSigMsg,
  verifySpend,
  type Spend
} from '../src/spend.ts'

// LUD-25's own test vectors 1 and 2 (the mint's half), 3 and 5, then lnurl-wallet's spends as the
// reference mint's kernel checks them.

const SK0 = '3616b02290a133da73e758a54dbff1bf6439b4067a820cb51ca873fa4a13a96a'
const Q0 = '690ac33892c64aa53874b0066ab1332f0ef45cb7c0e017eae0828916f52aa99f'
const VECTOR3_CK1 =
  'ck1dy9vxwyjce922wr5kqrx4vfn9u80gh9hcrsp06hqs2y3daf24x0lcdy378rtefeae4mt8r7xk75z4mc0r7n8yykwkltlvndug8ytlem7pkmqwa3yhughhtdktmlqg30rs2kf7nx4stm6tnpkd3awk3vq6smm20wz'
const VECTOR5_PREIMAGE = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const VECTOR5_H = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd'
const VECTOR5_Q = 'd18b619687343df2fc7a47e1daf25260b909bb563fb4b4b11e59e2bd64880982'
const VECTOR5_CW1 =
  'cw1qqqqqq8lllll7qpr4qsxxrwd99nvgvmxjyf9gj9mkfd5laqj5jw8xtdjez4urwzcr0t3phv8qqsuq5yjnd6vrgzf2jmckjmqxh5h5hs83fdq728vjm2500lwnt8gqwkqqqsqqqgzqvzq2ps8pqys5zcvp58q7yq3zgf3g9gkzuvpjxsmrsw3u8c6x6a4c'

const NOW = 1_800_000_000

const verified = (spend: Spend, domains: string[], lockedAt = 0, now = NOW) =>
  verifySpend(spend, {outputKey: spend.outputKey, domains, now, lockedAt})

// A cx1 branch's note keys, per purpose. The mint derives these to prove a
// name's branch (purpose 0, index 0) and to credit its payments (purpose 2).
describe('test vectors 1 and 2: note keys', () => {
  const key = (p: string, chain: string, purpose: number, index: number) =>
    bytesToHex(deriveNotePubkey(hexToBytes(p), hexToBytes(chain), purpose, index))
  const P1 = 'b783d2930dc053a971f019054ca43e7c9de50e0769de872dd1ddde5d0bf4c9d1'
  const C1 = 'ab91cc11aea395ea6b62292a6147f51ef4150ebea04e745137b68719e238f904'
  const P2 = '64885a9cab93ec051761b8a0b80e1854a61865878d58f72a365dfd640850f675'
  const C2 = '6b95795f9807ada85c8ca50ec93c921483a183abfed4a3b4abe6b95c89880306'

  it('derives vector 1 on every purpose (odd-y branch key)', () => {
    expect(key(P1, C1, NOTE_PURPOSE_WALLET, 0)).toBe(Q0)
    expect(key(P1, C1, NOTE_PURPOSE_WALLET, 1)).toBe('3e76b56c1a90bc64c4bf594be91a3cb8861a150232da92705cff6ee3714bb384')
    expect(key(P1, C1, NOTE_PURPOSE_WALLET, 2)).toBe('20146298f9b6439027ead2b4a15738a10721b26c425b58c634baac6147ee7fc7')
    expect(key(P1, C1, NOTE_PURPOSE_WALLET, 5)).toBe('c64ed8f1cd0f4d23aba8ddd739d9ae7e1a7ba2719cb54437384498fbc73788b3')
    expect(key(P1, C1, NOTE_PURPOSE_CHANGE, 0)).toBe('e9a2d71a45a4a5a22d3378bdd761f0b3b2622b6a939d24c779668379352d8274')
    expect(key(P1, C1, NOTE_PURPOSE_LIGHTNING_ADDRESS, 0)).toBe(
      'acff3482453b4671e410d2158fd93ab7d4c3e8c1b9554ce1190deb021fd2cd4c'
    )
  })

  it('derives vector 2 (even-y branch key)', () => {
    expect(key(P2, C2, NOTE_PURPOSE_WALLET, 0)).toBe('01fee34e378bf66de6afa1bfa6e30f5c89551fd92bc1b089dca93c52b7ab61bc')
    expect(key(P2, C2, NOTE_PURPOSE_WALLET, 1)).toBe('7c5434c33d25bc24d98c35b2610dd484cb2a3d4a7854de354f7747e9b10597b8')
    expect(key(P2, C2, NOTE_PURPOSE_WALLET, 2)).toBe('2517f8221468e33cb7aafdffde313950446da0cf4d790c9b758b373dc67a5686')
  })
})

describe('test vector 3: key-path spend', () => {
  it('builds the prevout, SigMsg and sighash the spec shows', () => {
    expect(bytesToHex(spendPrevout('mint.example'))).toBe('d5ac2de3423432e37713bcb133cfea7938ff6b2f8ea4174dfcec84bea705d6b2')
    const sigMsg = spendSigMsg({outputKey: hexToBytes(Q0), domain: 'mint.example', locktime: 0, sequence: 0xffffffff})
    expect(sigMsg.length).toBe(174)
    expect(bytesToHex(keyPathSighash(hexToBytes(Q0), 'mint.example'))).toBe(
      'e97bb6831a916ff83919046f50a39c18ab98bf43079cf68cd364d251f7de527f'
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
