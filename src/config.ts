import type {MintFee} from 'lnurlcash-kit'
import {getPublicKey} from 'nostr-tools/pure'
import {decode as decodeNip19} from 'nostr-tools/nip19'
import {hexToBytes} from '@noble/hashes/utils.js'

export type BackendConfig =
  | {kind: 'fake'}
  | {kind: 'cln'; url: string; rune: string}
  | {kind: 'lnd'; url: string; macaroon: string}

export type MoneyerConfig = {
  host: string
  port: number
  // The origin wallets are told to call back on, e.g. https://mint.example.
  // Unset means "derive from the request's Host header", which is fine on a
  // dev box and wrong behind a reverse proxy - production sets it.
  publicOrigin?: string
  username: string
  description: string
  minSendableMsat: number
  maxSendableMsat: number
  // Below this net amount a fresh mint is refused as dust. Mutation outputs
  // are exempt, matching the reference mint.
  minMintMsat: number
  // Advertised in the payRequest metadata and withheld on minting. Null
  // means fee-free.
  mintFee: MintFee | null
  // Ceiling the mint fee to a whole sat, as dni's lnurl-mint does on
  // purpose so it is "never short a sat". LUD-25 says nothing either way,
  // and lnurlcash-kit's mintFeeBand accepts both, so this is a posture
  // choice rather than a compliance one. Off by default: turning it on
  // raises what this mint withholds, and that is not a change to make
  // behind an operator's back on a redeploy.
  roundFeeToSat?: boolean
  // 32-byte hex. Unset means notes are issued unsigned, which the spec
  // allows but holders will notice.
  signingKey?: string
  // SQLite path, ':memory:' allowed.
  dbPath: string
  backend: BackendConfig
  // LUD-21 verify endpoint. Off means 404: the preimage it serves IS a
  // bearer secret, so the off switch has to be real.
  verify: boolean
  // A companion web wallet the mint's site links notes into, e.g.
  // https://wallet.example. Unset means the site offers copy/QR only.
  walletUrl?: string
  maxK1s: number
  // Winding down: refuse anything that grows liabilities (mints and
  // splits). Rotate, merge and melt stay available so holders can leave.
  sunset: boolean
  // Zap-to-note: lightning addresses on this host that, when paid, mint a
  // note to a Nostr pubkey and gift-wrap it there (see zap.ts). Unset means
  // the feature is off and those names 404 like any other.
  zap?: ZapConfig
}

export type ZapConfig = {
  // The mint's own Nostr identity: seals the wraps, signs the zap receipts,
  // and is the `nostrPubkey` a zapping client checks receipts against.
  nostrKey: string
  // Where receipts go, and where a recipient's inbox list is looked for.
  relays: string[]
  // name -> recipient pubkey (hex). `name@<host>` is the lightning address.
  names: Record<string, string>
}

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 3737,
  username: 'mint',
  description: 'an LNURLcash note',
  minSendableMsat: 1000,
  maxSendableMsat: 100_000_000,
  minMintMsat: 1000,
  dbPath: 'moneyer.sqlite',
  verify: true,
  maxK1s: 21,
  sunset: false,
  roundFeeToSat: false
} as const

const int = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${JSON.stringify(value)}.`)
  }
  return parsed
}

const flag = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback
  return value !== '0' && value.toLowerCase() !== 'false'
}

const HEX32 = /^[0-9a-f]{64}$/i

// Reads MONEYER_* from the environment. Throws rather than guessing: a mint
// that starts with a half-understood configuration is holding other
// people's money on a misunderstanding.
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): MoneyerConfig => {
  const baseFeeMsat = int(env.MONEYER_BASE_FEE_MSAT, 0)
  const feePpm = int(env.MONEYER_FEE_PPM, 0)
  if (feePpm >= 1_000_000) {
    throw new Error('MONEYER_FEE_PPM must be below 1000000 - a 100% fee can never net a note.')
  }
  const signingKey = env.MONEYER_SIGNING_KEY
  if (signingKey !== undefined && !HEX32.test(signingKey)) {
    throw new Error('MONEYER_SIGNING_KEY must be 32 bytes of hex.')
  }

  const kind = env.MONEYER_BACKEND ?? 'fake'
  let backend: BackendConfig
  if (kind === 'fake') {
    backend = {kind: 'fake'}
  } else if (kind === 'cln') {
    if (!env.MONEYER_BACKEND_URL || !env.MONEYER_BACKEND_RUNE) {
      throw new Error('The cln backend needs MONEYER_BACKEND_URL and MONEYER_BACKEND_RUNE.')
    }
    backend = {kind: 'cln', url: env.MONEYER_BACKEND_URL, rune: env.MONEYER_BACKEND_RUNE}
  } else if (kind === 'lnd') {
    if (!env.MONEYER_BACKEND_URL || !env.MONEYER_BACKEND_MACAROON) {
      throw new Error('The lnd backend needs MONEYER_BACKEND_URL and MONEYER_BACKEND_MACAROON.')
    }
    backend = {kind: 'lnd', url: env.MONEYER_BACKEND_URL, macaroon: env.MONEYER_BACKEND_MACAROON}
  } else {
    throw new Error(`Unknown MONEYER_BACKEND ${JSON.stringify(kind)} - fake, cln or lnd.`)
  }

  const minSendableMsat = int(env.MONEYER_MIN_SENDABLE_MSAT, DEFAULTS.minSendableMsat)
  const maxSendableMsat = int(env.MONEYER_MAX_SENDABLE_MSAT, DEFAULTS.maxSendableMsat)
  if (minSendableMsat > maxSendableMsat) {
    throw new Error('MONEYER_MIN_SENDABLE_MSAT exceeds MONEYER_MAX_SENDABLE_MSAT.')
  }

  // Wallets are sent to this origin for every callback, so a malformed one
  // must fail at startup, not as a 500 on the first request.
  const publicOrigin = env.MONEYER_PUBLIC_ORIGIN
  if (publicOrigin) {
    let protocol: string
    try {
      protocol = new URL(publicOrigin).protocol
    } catch {
      throw new Error(`MONEYER_PUBLIC_ORIGIN is not a URL: ${JSON.stringify(publicOrigin)}.`)
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new Error(`MONEYER_PUBLIC_ORIGIN must be http or https, got ${JSON.stringify(publicOrigin)}.`)
    }
  }

  const zap = zapFromEnv(env)
  if (zap && zap.names[env.MONEYER_USERNAME ?? DEFAULTS.username]) {
    throw new Error('MONEYER_ZAP_NAMES must not reuse the mint username.')
  }
  if (zap && !publicOrigin) {
    // A settled zap is minted by a timer, with no request to read a Host
    // header from, and the note URL it wraps must be right first time.
    throw new Error('Zap-to-note needs MONEYER_PUBLIC_ORIGIN.')
  }

  return {
    host: env.MONEYER_HOST ?? DEFAULTS.host,
    port: int(env.MONEYER_PORT, DEFAULTS.port),
    ...(publicOrigin ? {publicOrigin} : {}),
    username: env.MONEYER_USERNAME ?? DEFAULTS.username,
    description: env.MONEYER_DESCRIPTION ?? DEFAULTS.description,
    minSendableMsat,
    maxSendableMsat,
    minMintMsat: int(env.MONEYER_MIN_MINT_MSAT, DEFAULTS.minMintMsat),
    mintFee: baseFeeMsat === 0 && feePpm === 0 ? null : {baseFeeMsat, feePpm},
    roundFeeToSat: flag(env.MONEYER_ROUND_FEE_TO_SAT, DEFAULTS.roundFeeToSat),
    ...(signingKey ? {signingKey: signingKey.toLowerCase()} : {}),
    dbPath: env.MONEYER_DB ?? DEFAULTS.dbPath,
    backend,
    verify: flag(env.MONEYER_VERIFY, DEFAULTS.verify),
    ...(env.MONEYER_WALLET_URL ? {walletUrl: env.MONEYER_WALLET_URL.replace(/\/+$/, '')} : {}),
    maxK1s: int(env.MONEYER_MAX_K1S, DEFAULTS.maxK1s),
    sunset: flag(env.MONEYER_SUNSET, DEFAULTS.sunset),
    ...(zap ? {zap} : {})
  }
}

const NAME = /^[a-z0-9._-]{1,64}$/

// An npub or 32-byte hex, to hex. Throws on anything else.
export const pubkeyHex = (value: string): string => {
  const trimmed = value.trim()
  if (HEX32.test(trimmed)) return trimmed.toLowerCase()
  if (/^npub1/i.test(trimmed)) {
    try {
      const decoded = decodeNip19(trimmed.toLowerCase())
      if (decoded.type === 'npub') return decoded.data
    } catch {
      // fall through to the one error below
    }
  }
  throw new Error(`Not a Nostr pubkey: ${JSON.stringify(value)}.`)
}

// MONEYER_ZAP_NAMES="alice=npub1...,bob=<hex>" with MONEYER_NOSTR_KEY and
// MONEYER_NOSTR_RELAYS. All three or none: a name without a key cannot
// wrap, a key without names has nothing to do.
const zapFromEnv = (env: NodeJS.ProcessEnv): ZapConfig | undefined => {
  const rawNames = env.MONEYER_ZAP_NAMES?.trim()
  const nostrKey = env.MONEYER_NOSTR_KEY?.trim()
  const rawRelays = env.MONEYER_NOSTR_RELAYS?.trim()
  if (!rawNames && !nostrKey && !rawRelays) return undefined
  if (!rawNames || !nostrKey || !rawRelays) {
    throw new Error('Zap-to-note needs all of MONEYER_ZAP_NAMES, MONEYER_NOSTR_KEY and MONEYER_NOSTR_RELAYS.')
  }
  if (!HEX32.test(nostrKey)) throw new Error('MONEYER_NOSTR_KEY must be 32 bytes of hex.')
  // Refuse a key the curve refuses, at startup rather than on the first zap.
  getPublicKey(hexToBytes(nostrKey))
  const relays = rawRelays
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)
  if (!relays.length || relays.some(r => !/^wss?:\/\//.test(r))) {
    throw new Error('MONEYER_NOSTR_RELAYS must be a comma-separated list of ws:// or wss:// URLs.')
  }
  const names: Record<string, string> = {}
  for (const entry of rawNames.split(',')) {
    const [name, pubkey, ...rest] = entry.split('=').map(s => s.trim())
    if (!name || !pubkey || rest.length) {
      throw new Error(`MONEYER_ZAP_NAMES entry is not name=pubkey: ${JSON.stringify(entry)}.`)
    }
    const lowered = name.toLowerCase()
    if (!NAME.test(lowered)) throw new Error(`MONEYER_ZAP_NAMES name is not a lightning-address local part: ${JSON.stringify(name)}.`)
    if (lowered === '_') throw new Error('MONEYER_ZAP_NAMES must not claim the bare-domain name "_".')
    names[lowered] = pubkeyHex(pubkey)
  }
  return {nostrKey: nostrKey.toLowerCase(), relays, names}
}
