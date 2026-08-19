import {describe, expect, it} from 'vitest'
import {hashK1, noteSignatureDigest, verifyNoteSignature} from 'lnurlcash-kit'
import {createNoteSigner, noteIdSignatureDigest} from '../src/signing.ts'
import {TEST_SIGNING_KEY, freshK1} from './helpers.ts'

// The mint signs over the note ID; the wallet-side kit builds its digest
// from the secret. These tests are the byte-level handshake between the
// two: if either drifts, every note this mint issues stops verifying.

describe('note signing', () => {
  const signer = createNoteSigner(TEST_SIGNING_KEY)

  it('agrees with the kit digest built from the secret', () => {
    const k1 = freshK1()
    expect(noteIdSignatureDigest(hashK1(k1), 21_000)).toEqual(noteSignatureDigest(k1, 21_000))
  })

  it('produces signatures the kit verifies against the mint pubkey', () => {
    const k1 = freshK1()
    const signature = signer.sign(hashK1(k1), 21_000)
    expect(signature).toHaveLength(130)
    expect(verifyNoteSignature(k1, 21_000, signature, signer.pubkey)).toBe(true)
  })

  it('binds the signature to the amount', () => {
    const k1 = freshK1()
    const signature = signer.sign(hashK1(k1), 21_000)
    expect(verifyNoteSignature(k1, 21_001, signature, signer.pubkey)).toBe(false)
  })

  it('binds the signature to the note', () => {
    const k1 = freshK1()
    const signature = signer.sign(hashK1(k1), 21_000)
    expect(verifyNoteSignature(freshK1(), 21_000, signature, signer.pubkey)).toBe(false)
  })

  it('never verifies against a different pubkey', () => {
    const other = createNoteSigner('22'.repeat(32))
    const k1 = freshK1()
    const signature = signer.sign(hashK1(k1), 21_000)
    expect(verifyNoteSignature(k1, 21_000, signature, other.pubkey)).toBe(false)
  })
})
