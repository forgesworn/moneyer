import {describe, expect, it} from 'vitest'
import {encodeCs1WithAmount, hashK1, verifyNoteSignature, verifyNoteSignatureForKey} from '@lnurlcash/kit'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {createNoteSigner, noteIdSignatureDigest} from '../src/signing.ts'
import {
  buildStats,
  canonicalJson,
  signStats,
  statsSnapshotContent,
  verifyStatsSignature,
  verifyStatsSnapshot
} from '../src/stats.ts'
import {TEST_SIGNING_KEY, freshK1, noteIdOf} from './helpers.ts'

// The mint signs over the note ID; the wallet-side kit builds its digest
// from the secret. These tests are the byte-level handshake between the
// two: if either drifts, every note this mint issues stops verifying.

describe('note signing', () => {
  const signer = createNoteSigner(TEST_SIGNING_KEY)
  // The kit reads a certificate only as a cs1, and checks a bearer note's
  // over its taproot output key Q, which it derives from the secret itself.
  const certificate = (k1: string, amountMsat: number, from = signer): string =>
    encodeCs1WithAmount(amountMsat, hexToBytes(from.sign(noteIdOf(k1), amountMsat)))

  it('agrees with the kit digest built from the secret', () => {
    const k1 = freshK1()
    const expected = sha256(
      sha256(utf8ToBytes(`Lightning Signed Message:LNURLcash:21000:${hashK1(k1)}`))
    )
    expect(noteIdSignatureDigest(hashK1(k1), 21_000)).toEqual(expected)
  })

  it('produces signatures the kit verifies against the mint pubkey', () => {
    const k1 = freshK1()
    expect(signer.sign(noteIdOf(k1), 21_000)).toHaveLength(130)
    expect(verifyNoteSignature(k1, 21_000, certificate(k1, 21_000), signer.pubkey)).toBe(true)
  })

  it('still signs over the note id it is given, a note\'s old id included', () => {
    const k1 = freshK1()
    const signature = encodeCs1WithAmount(21_000, hexToBytes(signer.sign(hashK1(k1), 21_000)))
    expect(verifyNoteSignatureForKey(hashK1(k1), 21_000, signature, signer.pubkey)).toBe(true)
    // ...and that is not the certificate of the note the secret opens now.
    expect(verifyNoteSignature(k1, 21_000, signature, signer.pubkey)).toBe(false)
  })

  it('binds the signature to the amount', () => {
    const k1 = freshK1()
    const signature = certificate(k1, 21_000)
    expect(verifyNoteSignature(k1, 21_001, signature, signer.pubkey)).toBe(false)
  })

  it('binds the signature to the note', () => {
    const k1 = freshK1()
    const signature = certificate(k1, 21_000)
    expect(verifyNoteSignature(freshK1(), 21_000, signature, signer.pubkey)).toBe(false)
  })

  it('never verifies against a different pubkey', () => {
    const other = createNoteSigner('22'.repeat(32))
    const k1 = freshK1()
    const signature = certificate(k1, 21_000)
    expect(verifyNoteSignature(k1, 21_000, signature, other.pubkey)).toBe(false)
  })
})

// A liabilities snapshot is signed with the same key the notes are, so a
// holder checking the mint's published history has nothing new to trust.

describe('liabilities snapshots', () => {
  const signer = createNoteSigner(TEST_SIGNING_KEY)
  const stats = buildStats({
    liabilities: {
      outstandingMsat: 48_120_000,
      outstandingNotes: 12,
      pendingMsat: 0,
      pendingMelts: 0,
      oldestPendingMeltAgeSecs: 0
    },
    localBalanceMsat: 92_400_000,
    reconciledAt: 1_700_000_000_000,
    at: 1_700_000_003_000
  })

  it('canonicalises to sorted keys with no whitespace, so a verifier rebuilds the same bytes', () => {
    expect(canonicalJson({b: 2, a: 'x', A: 1})).toBe('{"A":1,"a":"x","b":2}')
    expect(() => canonicalJson({bad: Number.NaN})).toThrow(/finite/)
  })

  it('states coverage to four decimal places', () => {
    expect(stats.coverage).toBe(1.9202)
  })

  it('round-trips through the published snapshot content', () => {
    const content = statsSnapshotContent(stats, TEST_SIGNING_KEY)
    const parsed = verifyStatsSnapshot(content, signer.pubkey)
    expect(parsed.valid).toBe(true)
    expect(parsed.stats).toEqual(stats)
  })

  it('fails a snapshot whose numbers were edited after signing', () => {
    const content = statsSnapshotContent(stats, TEST_SIGNING_KEY)
    const tampered = JSON.parse(content) as Record<string, unknown>
    tampered.outstandingMsat = 1
    expect(verifyStatsSnapshot(JSON.stringify(tampered), signer.pubkey).valid).toBe(false)
  })

  it(`never verifies against another mint's key`, () => {
    const other = createNoteSigner('22'.repeat(32))
    expect(verifyStatsSignature(stats, signStats(stats, TEST_SIGNING_KEY), other.pubkey)).toBe(false)
  })

  it('refuses a snapshot with no signature at all', () => {
    expect(verifyStatsSnapshot(JSON.stringify(stats), signer.pubkey).valid).toBe(false)
    expect(verifyStatsSnapshot('not json', signer.pubkey).valid).toBe(false)
  })
})
