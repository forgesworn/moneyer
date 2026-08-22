import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {recoversToPubkey, signDigestRecoverable} from './signing.ts'

// The mint announcing itself.
//
// A wallet only ever learns of a mint by being told its address; there is
// no way to find one. Cashu has NIP-87 for this, and its kinds are not
// ours to take. A new kind of our own is a protocol decision that belongs
// with the NIPs, so this uses what already exists: the same NIP-78
// replaceable kind the hourly liabilities snapshot goes out under, with a
// `d` tag of its own.
//
// The content is the mint's own discovery document, unchanged, so there is
// one description of a mint and not two. It carries a signature by the
// NOTE signing key as well, which is the key a holder already checks their
// notes against: an announcement that verifies against `mintPubkey` is the
// mint speaking, whoever the Nostr identity publishing it belongs to.

export const ANNOUNCE_KIND = 30078
export const ANNOUNCE_D_TAG = 'lnurlcash-mint'
export const ANNOUNCE_MESSAGE_PREFIX = 'LNURLcash-mint:'

export type MintAddressDocument = Record<string, unknown>

// RFC 8785 canonical JSON, over the shapes a mint address document holds:
// strings, finite numbers, booleans, arrays, and nested objects. Keys sort
// by UTF-16 code unit, which is what JavaScript's own string comparison
// does, and numbers serialise the ECMAScript way, which is what the RFC
// specifies. `undefined` members are dropped exactly as JSON.stringify
// drops them, so what is signed matches what goes on the wire.
export const canonicalise = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Only a finite number can be signed.')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`)
    return `{${members.join(',')}}`
  }
  throw new Error(`A ${typeof value} cannot be signed.`)
}

// The same "Lightning Signed Message" wrapping the notes use, over a
// prefix of its own, so an announcement signature can never be replayed as
// a note signature or as a liabilities signature.
export const announcementDigest = (document: MintAddressDocument): Uint8Array =>
  sha256(sha256(utf8ToBytes(`Lightning Signed Message:${ANNOUNCE_MESSAGE_PREFIX}${canonicalise(document)}`)))

export const signAnnouncement = (document: MintAddressDocument, privateKeyHex: string): string =>
  signDigestRecoverable(announcementDigest(document), privateKeyHex)

// What goes in the event: the document as the endpoint serves it, plus
// `sig`. A mint with no note signing key has no `mintPubkey` to verify
// against either, so it announces the document alone.
export const announcementContent = (document: MintAddressDocument, privateKeyHex?: string | undefined): string =>
  JSON.stringify(privateKeyHex ? {...document, sig: signAnnouncement(document, privateKeyHex)} : document)

// The reverse: read an announcement and check it against the note-signing
// key it claims. `mintPubkey` inside the document is what a wallet holding
// a note of this mint already knows, so an announcement that recovers to
// it needs nothing else trusted.
export const verifyAnnouncement = (
  content: string,
  mintPubkeyHex: string
): {valid: boolean; document: MintAddressDocument | null} => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return {valid: false, document: null}
  }
  const {sig, ...document} = parsed
  if (typeof sig !== 'string') return {valid: false, document: null}
  let digest: Uint8Array
  try {
    digest = announcementDigest(document)
  } catch {
    return {valid: false, document: null}
  }
  return {valid: recoversToPubkey(digest, sig, mintPubkeyHex), document}
}
