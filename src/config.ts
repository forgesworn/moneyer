import type {MintFee} from 'lnurlcash-kit'
import {getPublicKey} from 'nostr-tools/pure'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {decode as decodeNip19, npubEncode} from 'nostr-tools/nip19'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'

export type BackendConfig =
  | {kind: 'fake'; autoSettle?: boolean}
  | {kind: 'cln'; url: string; rune: string}
  | {kind: 'lnd'; url: string; macaroon: string}

// Who runs this mint and how to reach them. Every field is optional and
// an unset one is absent from the wire, never an empty string: a holder
// reading "contact: " learns less than nothing.
export type MintContact = {
  nostr?: string
  email?: string
  url?: string
}

export type MoneyerConfig = {
  host: string
  port: number
  // The origin wallets are told to call back on, e.g. https://mint.example.
  // Unset means "derive from the request's Host header", which is fine on a
  // dev box and wrong behind a reverse proxy - production sets it.
  publicOrigin?: string
  username: string
  description: string
  // The human layer on the discovery endpoint: who this is, how to reach
  // them, the terms, and a message of the day. MOTD is how an operator
  // talks to holders - maintenance, a sunset, a fee change - without a
  // mailing list they never signed up to.
  name?: string
  contact?: MintContact
  tosUrl?: string
  motd?: string
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
  // Compressed pubkeys this mint has signed notes under before, published
  // as `previousPubkeys` so a wallet can tell a legitimate rotation from
  // an impostor. Pubkeys only: verifying an old note needs no private
  // key, and an old private key left on the box is a liability with no
  // upside.
  previousSigningPubkeys?: string[]
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
  // GET /stats: what the mint owes and what its node holds. Public by
  // design and on by default - a custodial mint that will not say its
  // liabilities is asking for trust it has not earned. Optional on the
  // type because MoneyerConfig is public API and an embedder should not
  // have to name a field to get the sensible answer.
  stats?: boolean
  // Publish the coverage ratio and nothing else, for an operator who
  // would rather not put the size of the book on the internet.
  statsRatioOnly?: boolean
  // Publish a signed hourly snapshot of the stats to Nostr, so the
  // history can be checked after the fact. Needs a signing key and the
  // zap Nostr identity.
  statsPublish?: boolean
  // Announce this mint on Nostr, hourly, alongside the snapshot: the
  // discovery document as a replaceable event, so a wallet can find the
  // mint rather than having to be told its address. Off unless the
  // operator turns it on - a mint that does not want to be listed says
  // nothing. Needs the zap Nostr identity and a public origin.
  announce?: boolean
  // GET /metrics in the OpenMetrics text format, for a scraper. Off by
  // default and never authenticated by the app: the deployment notes
  // restrict the path at the reverse proxy, which is where that belongs.
  metrics?: boolean
  // Winding down: refuse anything that grows liabilities (mints and
  // splits). Rotate, merge and melt stay available so holders can leave.
  sunset: boolean
  // Zap-to-note: lightning addresses on this host that, when paid, mint a
  // note to a Nostr pubkey and gift-wrap it there (see zap.ts). Unset means
  // the feature is off and those names 404 like any other.
  zap?: ZapConfig
  // What a self-service lightning address costs, in millisatoshis, paid
  // with a note of this mint. Unset means registration is closed and
  // POST /names 404s; 0 means free, capped at three names per pubkey.
  namePriceMsat?: number
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
  roundFeeToSat: false,
  stats: true,
  statsRatioOnly: false,
  statsPublish: false,
  announce: false,
  metrics: false
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

// Trimmed, or absent. An empty variable is the operator not setting it,
// which is not the same as setting it to nothing.
const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const webUrl = (name: string, value: string | undefined): string | undefined => {
  const trimmed = text(value)
  if (trimmed === undefined) return undefined
  let protocol: string
  try {
    protocol = new URL(trimmed).protocol
  } catch {
    throw new Error(`${name} is not a URL: ${JSON.stringify(value)}.`)
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`${name} must be http or https, got ${JSON.stringify(value)}.`)
  }
  return trimmed
}

// The MOTD is a line on a mint card, not a blog. A runaway one would push
// every other field off a wallet's screen, so it is refused at startup
// rather than truncated behind the operator's back.
const MOTD_MAX = 280

const contactFromEnv = (env: NodeJS.ProcessEnv): MintContact | undefined => {
  const rawNostr = text(env.MONEYER_CONTACT_NOSTR)
  // Normalised to npub on the wire whichever form the operator set: a
  // wallet showing a contact wants the form a person can paste back.
  const nostr = rawNostr === undefined ? undefined : npubEncode(pubkeyHex(rawNostr))
  const email = text(env.MONEYER_CONTACT_EMAIL)
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`MONEYER_CONTACT_EMAIL is not an email address: ${JSON.stringify(email)}.`)
  }
  const url = webUrl('MONEYER_CONTACT_URL', env.MONEYER_CONTACT_URL)
  if (nostr === undefined && email === undefined && url === undefined) return undefined
  return {
    ...(nostr ? {nostr} : {}),
    ...(email ? {email} : {}),
    ...(url ? {url} : {})
  }
}

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
  const previousSigningPubkeys = previousPubkeysFromEnv(env, signingKey)

  const kind = env.MONEYER_BACKEND ?? 'fake'
  let backend: BackendConfig
  if (kind === 'fake') {
    // A development-only shortcut, and only reachable on the backend that
    // moves no money: every invoice this mint issues is treated as paid
    // the instant it is issued. It is what makes a local mint usable to a
    // wallet, and it would be a licence to print sats on any other
    // backend, which is why it is read here and nowhere else.
    backend = {kind: 'fake', autoSettle: env.MONEYER_FAKE_AUTOSETTLE === 'true'}
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

  const motd = text(env.MONEYER_MOTD)
  if (motd !== undefined && motd.length > MOTD_MAX) {
    throw new Error(`MONEYER_MOTD must be at most ${MOTD_MAX} characters - it is a banner, not a page.`)
  }
  const contact = contactFromEnv(env)
  const tosUrl = webUrl('MONEYER_TOS_URL', env.MONEYER_TOS_URL)
  const name = text(env.MONEYER_NAME)

  const zap = zapFromEnv(env)
  // Unset is not the same as zero here: unset means registration is
  // closed, zero means free.
  const rawPrice = env.MONEYER_NAME_PRICE_MSAT?.trim()
  const namePriceMsat = rawPrice === undefined || rawPrice === '' ? undefined : int(rawPrice, 0)
  if (namePriceMsat !== undefined && !zap) {
    // A registered name that cannot be wrapped to its owner is a name
    // that takes payments nobody can collect.
    throw new Error('MONEYER_NAME_PRICE_MSAT needs zap-to-note configured - a name pays out as a gift-wrapped note.')
  }
  if (zap && zap.names[env.MONEYER_USERNAME ?? DEFAULTS.username]) {
    throw new Error('MONEYER_ZAP_NAMES must not reuse the mint username.')
  }
  if (flag(env.MONEYER_ANNOUNCE, DEFAULTS.announce) && !zap) {
    // An announcement is a Nostr event, and the mint's Nostr identity is
    // the zap one. Turning this on without it would be a mint that thinks
    // it is listed and is not.
    throw new Error('MONEYER_ANNOUNCE needs the mint Nostr identity - set MONEYER_NOSTR_KEY and MONEYER_NOSTR_RELAYS.')
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
    ...(name ? {name} : {}),
    ...(contact ? {contact} : {}),
    ...(tosUrl ? {tosUrl} : {}),
    ...(motd ? {motd} : {}),
    minSendableMsat,
    maxSendableMsat,
    minMintMsat: int(env.MONEYER_MIN_MINT_MSAT, DEFAULTS.minMintMsat),
    mintFee: baseFeeMsat === 0 && feePpm === 0 ? null : {baseFeeMsat, feePpm},
    roundFeeToSat: flag(env.MONEYER_ROUND_FEE_TO_SAT, DEFAULTS.roundFeeToSat),
    ...(signingKey ? {signingKey: signingKey.toLowerCase()} : {}),
    ...(previousSigningPubkeys.length ? {previousSigningPubkeys} : {}),
    dbPath: env.MONEYER_DB ?? DEFAULTS.dbPath,
    backend,
    verify: flag(env.MONEYER_VERIFY, DEFAULTS.verify),
    stats: flag(env.MONEYER_STATS, DEFAULTS.stats),
    statsRatioOnly: flag(env.MONEYER_STATS_RATIO_ONLY, DEFAULTS.statsRatioOnly),
    statsPublish: flag(env.MONEYER_STATS_PUBLISH, DEFAULTS.statsPublish),
    announce: flag(env.MONEYER_ANNOUNCE, DEFAULTS.announce),
    metrics: flag(env.MONEYER_METRICS, DEFAULTS.metrics),
    ...(env.MONEYER_WALLET_URL ? {walletUrl: env.MONEYER_WALLET_URL.replace(/\/+$/, '')} : {}),
    maxK1s: int(env.MONEYER_MAX_K1S, DEFAULTS.maxK1s),
    sunset: flag(env.MONEYER_SUNSET, DEFAULTS.sunset),
    ...(zap ? {zap} : {}),
    ...(namePriceMsat !== undefined ? {namePriceMsat} : {})
  }
}

// MONEYER_PREVIOUS_SIGNING_PUBKEYS="02ab...,03cd..." - the keys this mint
// signed under before the current one. Every entry must be a point the
// curve accepts, because a typo here would quietly tell wallets to accept
// a key that verifies nothing, and it must not be the current key, which
// would say the mint had rotated to itself.
const previousPubkeysFromEnv = (env: NodeJS.ProcessEnv, signingKey: string | undefined): string[] => {
  const raw = env.MONEYER_PREVIOUS_SIGNING_PUBKEYS?.trim()
  if (!raw) return []
  const current = signingKey ? bytesToHex(secp256k1.getPublicKey(hexToBytes(signingKey.toLowerCase()), true)) : null
  const pubkeys: string[] = []
  for (const entry of raw.split(',')) {
    const pubkey = entry.trim().toLowerCase()
    if (!pubkey) continue
    if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) {
      throw new Error(`MONEYER_PREVIOUS_SIGNING_PUBKEYS entry is not a compressed secp256k1 pubkey: ${JSON.stringify(entry)}.`)
    }
    try {
      secp256k1.Point.fromHex(pubkey)
    } catch {
      throw new Error(`MONEYER_PREVIOUS_SIGNING_PUBKEYS entry is not a point on the curve: ${JSON.stringify(entry)}.`)
    }
    if (pubkey === current) {
      throw new Error('MONEYER_PREVIOUS_SIGNING_PUBKEYS must not repeat the current signing key - a mint has not rotated to itself.')
    }
    if (!pubkeys.includes(pubkey)) pubkeys.push(pubkey)
  }
  return pubkeys
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
// MONEYER_NOSTR_RELAYS. The key and the relays go together: a name
// without a key cannot wrap. The names themselves are now optional, since
// a mint can open registration and start with none of its own.
const zapFromEnv = (env: NodeJS.ProcessEnv): ZapConfig | undefined => {
  const rawNames = env.MONEYER_ZAP_NAMES?.trim()
  const nostrKey = env.MONEYER_NOSTR_KEY?.trim()
  const rawRelays = env.MONEYER_NOSTR_RELAYS?.trim()
  if (!rawNames && !nostrKey && !rawRelays) return undefined
  if (!nostrKey || !rawRelays) {
    throw new Error('Zap-to-note needs MONEYER_NOSTR_KEY and MONEYER_NOSTR_RELAYS.')
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
  for (const entry of (rawNames ?? '').split(',').filter(Boolean)) {
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
