import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import type {Liabilities} from './store.ts'

// What the mint owes, what its node holds, and the ratio between the two.
//
// Because LNURLcash notes are not blinded, a mint can state its
// liabilities exactly: no epochs, no blinded sums, no proof ceremony. The
// numbers below are the whole of it, and none of them is per-note - a
// stats endpoint that leaked which notes exist would be worse than no
// stats endpoint at all.

export const STATS_KIND = 30078
export const STATS_D_TAG = 'lnurlcash-liabilities'
export const STATS_MESSAGE_PREFIX = 'LNURLcash-stats:'

export type MintStats = {
  // Milliseconds, so a reader can tell a live snapshot from a stale one.
  at: number
  outstandingMsat?: number
  outstandingNotes?: number
  pendingMsat?: number
  pendingMelts?: number
  oldestPendingMeltAgeSecs?: number
  localBalanceMsat?: number
  // node balance over outstanding liabilities, four decimal places.
  coverage?: number
  // When the melt reconciler last completed a pass. A coverage figure
  // taken while melts are unreconciled is a coverage figure over stale
  // liabilities, and the reader is owed that.
  reconciledAt?: number
}

export const buildStats = (args: {
  liabilities: Liabilities
  localBalanceMsat?: number | undefined
  reconciledAt?: number | undefined
  at?: number
  // Publish the ratio and nothing else. Some operators will happily say
  // "we are covered" without publishing the size of the book, and a mint
  // that would otherwise switch /stats off entirely says more this way.
  ratioOnly?: boolean
}): MintStats => {
  const {liabilities, localBalanceMsat} = args
  const at = args.at ?? Date.now()
  // Nothing outstanding means nothing to cover: any ratio would be
  // infinite, and "infinitely covered" is not a claim worth making.
  const coverage =
    localBalanceMsat !== undefined && liabilities.outstandingMsat > 0
      ? Math.round((localBalanceMsat / liabilities.outstandingMsat) * 10_000) / 10_000
      : undefined
  if (args.ratioOnly === true) {
    return {at, ...(coverage !== undefined ? {coverage} : {})}
  }
  return {
    at,
    ...liabilities,
    ...(localBalanceMsat !== undefined ? {localBalanceMsat} : {}),
    ...(coverage !== undefined ? {coverage} : {}),
    ...(args.reconciledAt !== undefined ? {reconciledAt: args.reconciledAt} : {})
  }
}

// RFC 8785 canonical JSON, for the flat object of numbers this module
// signs: keys sorted by code unit, no whitespace, and ECMAScript's own
// number-to-string, which is what the RFC specifies. Anything nested or
// non-finite is refused rather than serialised a way a verifier might not
// reproduce.
export const canonicalJson = (value: Record<string, number | string>): string => {
  const parts = Object.keys(value)
    .sort()
    .map(key => {
      const item = value[key]
      if (typeof item === 'string') return `${JSON.stringify(key)}:${JSON.stringify(item)}`
      if (typeof item === 'number' && Number.isFinite(item)) return `${JSON.stringify(key)}:${item}`
      throw new Error(`Cannot canonicalise ${key}: only finite numbers and strings are signed.`)
    })
  return `{${parts.join(',')}}`
}

// The same "Lightning Signed Message" wrapping the notes themselves use,
// over a different message, so a stats signature can never be replayed as
// a note signature or the other way round.
export const statsDigest = (stats: MintStats): Uint8Array =>
  sha256(sha256(utf8ToBytes(`Lightning Signed Message:${STATS_MESSAGE_PREFIX}${canonicalJson(stats as Record<string, number>)}`)))

// Signed with the NOTE signing key, deliberately: a holder already checks
// their notes against that key, so the liabilities history checks against
// the same one with nothing new to trust.
export const signStats = (stats: MintStats, privateKeyHex: string): string => {
  const priv = hexToBytes(privateKeyHex)
  const lead = secp256k1.sign(statsDigest(stats), priv, {format: 'recovered', prehash: false})
  // r || s || recovery_id, the LUD-25 wire layout.
  return bytesToHex(new Uint8Array([...lead.subarray(1), lead[0]!]))
}

export const verifyStatsSignature = (stats: MintStats, signatureHex: string, mintPubkeyHex: string): boolean => {
  let wireSig: Uint8Array
  try {
    wireSig = hexToBytes(signatureHex)
  } catch {
    return false
  }
  if (wireSig.length !== 65) return false
  let digest: Uint8Array
  try {
    digest = statsDigest(stats)
  } catch {
    return false
  }
  const target = mintPubkeyHex.trim().toLowerCase()
  // Both byte orders are tried for the same reason lnurlcash-kit tries
  // both: recovery-id-first is what noble emits, recovery-id-last is what
  // the wire carries.
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

// The published snapshot's content: the stats exactly as signed, plus the
// signature. A verifier strips `sig` and canonicalises what is left.
export const statsSnapshotContent = (stats: MintStats, privateKeyHex: string): string =>
  JSON.stringify({...stats, sig: signStats(stats, privateKeyHex)})

// The reverse: parse a published snapshot and check it against the mint's
// advertised note-signing pubkey.
export const verifyStatsSnapshot = (content: string, mintPubkeyHex: string): {valid: boolean; stats: MintStats | null} => {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content) as Record<string, unknown>
  } catch {
    return {valid: false, stats: null}
  }
  const {sig, ...stats} = parsed
  if (typeof sig !== 'string') return {valid: false, stats: null}
  const asStats = stats as MintStats
  return {valid: verifyStatsSignature(asStats, sig, mintPubkeyHex), stats: asStats}
}
