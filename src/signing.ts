import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

// LUD-25 offline verification, from the SERVICE side. The construction is
// the standard "Lightning Signed Message" wrapping over
//
//   "LNURLcash:" || amount_msat || ":" || note_id
//
// where note_id is hex(sha256(k1)). lnurlcash-kit's noteSignatureDigest
// takes the SECRET and hashes it itself, which a wallet holds and a mint
// never does - so the digest is rebuilt here from the id. The two must
// agree byte for byte; the test suite proves they do by verifying every
// signature this module makes with the kit's verifyNoteSignature.

export const noteIdSignatureDigest = (noteId: string, amountMsat: number): Uint8Array =>
  sha256(sha256(utf8ToBytes(`Lightning Signed Message:LNURLcash:${amountMsat}:${noteId}`)))

// A recoverable signature in the LUD-25 wire layout, r || s || recovery_id.
// noble v2 emits recovery_id || r || s, so the leading byte moves to the
// back. Anything this mint signs for a third party to check goes through
// here.
export const signDigestRecoverable = (digest: Uint8Array, privateKeyHex: string): string => {
  const lead = secp256k1.sign(digest, hexToBytes(privateKeyHex), {format: 'recovered', prehash: false})
  return bytesToHex(new Uint8Array([...lead.subarray(1), lead[0]!]))
}

// Does this signature recover to that public key? Both byte orders are
// tried for the same reason lnurlcash-kit tries both: recovery-id-first is
// what noble emits, recovery-id-last is what the wire carries.
export const recoversToPubkey = (digest: Uint8Array, signatureHex: string, pubkeyHex: string): boolean => {
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  const target = pubkeyHex.trim().toLowerCase()
  const recoveryIdFirst = new Uint8Array([wireSig[64]!, ...wireSig.subarray(0, 64)])
  for (const candidate of [recoveryIdFirst, wireSig]) {
    try {
      if (bytesToHex(secp256k1.recoverPublicKey(candidate, digest, {prehash: false})) === target) return true
    } catch {
      // wrong recovery id for this order - try the other
    }
  }
  return false
}

export type NoteSigner = {
  pubkey: string
  sign: (noteId: string, amountMsat: number) => string
}

// Signs with the mint's own dedicated key, in process. The reference mint
// signs via its node's signmessage RPC instead; either is valid, since the
// only key a wallet ever checks against is the mintPubkey the SERVICE
// advertises. An own key keeps the funding source swappable without
// invalidating every outstanding note's signature.
export const createNoteSigner = (privateKeyHex: string): NoteSigner => {
  const priv = hexToBytes(privateKeyHex)
  if (priv.length !== 32) throw new Error('The signing key must be 32 bytes of hex.')
  const pubkey = bytesToHex(secp256k1.getPublicKey(priv, true))
  return {
    pubkey,
    sign: (noteId, amountMsat) => {
      // noble v2 emits recovery_id || r || s; the LUD-25 wire layout is
      // r || s || recovery_id, so the leading byte moves to the back.
      const lead = secp256k1.sign(noteIdSignatureDigest(noteId, amountMsat), priv, {
        format: 'recovered',
        prehash: false
      })
      return bytesToHex(new Uint8Array([...lead.subarray(1), lead[0]!]))
    }
  }
}
