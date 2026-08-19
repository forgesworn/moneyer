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
