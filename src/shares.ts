import {sha256} from '@noble/hashes/sha2.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {cx1PubkeyXOnly, decodeCx1, decodeLegacyCx1, deriveNotePubkey as deriveShareNotePubkey} from '@lnurlcash/kit'
import {NOTE_PURPOSE_LIGHTNING_ADDRESS, NOTE_PURPOSE_WALLET, deriveNotePubkey as deriveLegacyNotePubkey} from './spend.ts'

// LUD-26 shares, from the SERVICE side.
//
// A share is the extended public key a wallet hands out for one Lightning
// Address: cx1 = bech32m("cx", chaincode || P), 65 bytes, BIP-32's own
// order. This mint derives the share's notes S/a'/2/n'/i from it with plain
// BIP-32 CKDpub, and never holds a private key.
//
// A name registered before LUD-26 holds the superseded 64-byte
// cx1<x(P) || chaincode> of a whole branch. It keeps auto-minting under the
// old purpose-2 tweak, so the address does not stop working the day this
// mint upgrades, until its owner moves it to a share. No new registration
// may use one: the whole-branch cx1 is what let anyone who fetched the
// payRequest watch every key-path note of that wallet.
//
// The form is read off the stored cx1 itself, by its decoded length, as
// the reference mint does: no flag can disagree with the data.

export type Share = {
  // The cx1 as stored and as it was signed: trimmed, lowercase.
  cx1: string
  legacy: boolean
  // x(P), what every proof by the share's own key verifies against, and
  // what "cx1 already used" compares.
  xOnly: Uint8Array
  // hex(Q) of note `index`, or null for the vanishingly rare index that
  // derives no key (a wallet skips it too).
  noteAt: (index: number) => string | null
  // The keys a proof by the holder of this cx1 may be signed with. A share
  // signs with p itself. A legacy branch is accepted from either key a
  // wallet of its day used: the branch node key (as the reference mint
  // reads it) or the purpose-0 index-0 key (as this mint's own proofs were).
  proofKeys: () => Uint8Array[]
}

// Below 2^31: a share's note indices are never hardened.
const MAX_INDEX = 0x7fffffff

const canonical = (cx1: string): string => cx1.trim().toLowerCase()

// A new share, and nothing else: what a registration may name.
export const decodeShare = (value: unknown): Share | null => {
  if (typeof value !== 'string') return null
  const cx1 = canonical(value)
  const decoded = decodeCx1(cx1)
  if (!decoded) return null
  const xOnly = cx1PubkeyXOnly(decoded)
  return {
    cx1,
    legacy: false,
    xOnly,
    noteAt: index => {
      if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) return null
      try {
        return bytesToHex(deriveShareNotePubkey(decoded, index))
      } catch {
        return null
      }
    },
    proofKeys: () => [xOnly]
  }
}

// The cx1 a name holds, in either form.
export const shareOnFile = (value: string | null | undefined): Share | null => {
  if (!value) return null
  const current = decodeShare(value)
  if (current) return current
  const cx1 = canonical(value)
  const branch = decodeLegacyCx1(cx1)
  if (!branch) return null
  return {
    cx1,
    legacy: true,
    xOnly: branch.pubkeyXOnly,
    noteAt: index => {
      if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) return null
      try {
        return bytesToHex(deriveLegacyNotePubkey(branch.pubkeyXOnly, branch.chainCode, NOTE_PURPOSE_LIGHTNING_ADDRESS, index))
      } catch {
        return null
      }
    },
    proofKeys: () => {
      const keys = [branch.pubkeyXOnly]
      try {
        keys.push(deriveLegacyNotePubkey(branch.pubkeyXOnly, branch.chainCode, NOTE_PURPOSE_WALLET, 0))
      } catch {
        // an unusable tweak leaves the branch key alone
      }
      return keys
    }
  }
}

export type ProofAction = 'register' | 'update' | 'unregister'

// LUD-26's registration message. Register and update bind the cx1 being
// put on file, lowercase, so a proof cannot be replayed with another chain
// code or parity around the same x(P); unregister binds none.
export const registrationMessage = (action: ProofAction, domain: string, username: string, cx1?: string | undefined): string =>
  `LNURLcash:${action}:${domain}:${username}${action === 'unregister' ? '' : `:${canonical(cx1 ?? '')}`}`

// A BIP-340 signature by one of `keys` over sha256(message), for any of
// this mint's domains (a proof for another mint never verifies here).
export const proofVerifies = (args: {
  action: ProofAction
  domains: string[]
  username: string
  cx1?: string | undefined
  keys: Uint8Array[]
  sig: unknown
}): boolean => {
  if (typeof args.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(args.sig.trim())) return false
  const signature = hexToBytes(args.sig.trim().toLowerCase())
  return args.domains.some(domain => {
    const digest = sha256(utf8ToBytes(registrationMessage(args.action, domain, args.username, args.cx1)))
    return args.keys.some(key => {
      try {
        return schnorr.verify(signature, digest, key)
      } catch {
        return false
      }
    })
  })
}
