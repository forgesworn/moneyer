import {sha256} from '@noble/hashes/sha2.js'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {verifyEvent, type Event} from 'nostr-tools/pure'
import {decodeCx1, deriveNotePubkey, noteK1} from '@lnurlcash/kit'
import {NotePendingError, NoteStore, NoteUnavailableError, type NoteRow} from './store.ts'
import {decodeSpend} from './spend.ts'

// Self-service lightning addresses.
//
// A name here is a lightning address whose payouts are bearer notes
// gift-wrapped to the holder's own Nostr key: custodial for the seconds
// between the zap settling and the wrap going out, theirs afterwards.
// Anyone with an npub can have one, which is a reason to run a mint and a
// reason to install a wallet.
//
// The identity is the NIP-98 signature and nothing else. There is no
// account, no password and no recovery: the key that signed the
// registration owns the name.

export const NIP98_KIND = 27235
// Sixty seconds, as NIP-98 suggests. Long enough for a slow phone, short
// enough that a captured Authorization header is worth little.
export const NIP98_WINDOW_SECS = 60

// Three to thirty-two characters, starting with a letter or digit. The
// same shape a lightning address local part and a NIP-05 name can both
// carry without quoting.
export const NAME_RULE = /^[a-z0-9][a-z0-9_.-]{2,31}$/

// Never registrable, whatever the mint is called: `_` is LUD-16's
// bare-domain alias, and the other two are what a person types when they
// mean the operator.
export const ALWAYS_RESERVED = ['_', 'admin', 'mint'] as const

// How many free names one pubkey may hold. Paid registration needs no cap
// - the price is the cap.
export const FREE_NAMES_PER_PUBKEY = 3

export type Nip98Failure = {reason: string}
export type Nip98Success = {pubkey: string}

// NIP-98 over one request. Deliberately checked here rather than through
// a helper: the payload tag must commit to the RAW body this handler
// read, not to a re-serialisation of it, or a client whose JSON differs
// from ours by a space is refused for no reason.
export const validateNip98 = (
  authorization: string | undefined,
  request: {url: string; method: string; body: string; nowSecs?: number}
): Nip98Success | Nip98Failure => {
  const header = authorization?.trim()
  if (!header) return {reason: 'Missing NIP-98 Authorization header.'}
  const match = /^Nostr\s+(.+)$/i.exec(header)
  if (!match) return {reason: 'Authorization must be "Nostr <base64 event>".'}
  let event: Event
  try {
    event = JSON.parse(Buffer.from(match[1]!.trim(), 'base64').toString('utf8')) as Event
  } catch {
    return {reason: 'Authorization is not a base64 Nostr event.'}
  }
  if (event?.kind !== NIP98_KIND) return {reason: `Authorization event must be kind ${NIP98_KIND}.`}
  if (!verifyEvent(event)) return {reason: 'Authorization event signature does not verify.'}

  const nowSecs = request.nowSecs ?? Math.floor(Date.now() / 1000)
  if (Math.abs(nowSecs - event.created_at) > NIP98_WINDOW_SECS) {
    return {reason: `Authorization event is not within ${NIP98_WINDOW_SECS} seconds of now.`}
  }
  const tag = (name: string): string | undefined => event.tags.find(t => t[0] === name)?.[1]
  // The URL is compared without its query string, and with a trailing
  // slash ignored: those are the two differences a proxy or an HTTP
  // client introduces on its own.
  const canonical = (value: string): string | null => {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
    } catch {
      return null
    }
  }
  const signedUrl = tag('u')
  if (!signedUrl || canonical(signedUrl) === null || canonical(signedUrl) !== canonical(request.url)) {
    return {reason: 'Authorization event was signed for a different URL.'}
  }
  if ((tag('method') ?? '').toUpperCase() !== request.method.toUpperCase()) {
    return {reason: 'Authorization event was signed for a different method.'}
  }
  const payload = tag('payload')
  if (request.body.length > 0) {
    if (!payload) return {reason: 'Authorization event has no payload tag for this body.'}
    if (payload.toLowerCase() !== bytesToHex(sha256(utf8ToBytes(request.body)))) {
      return {reason: 'Authorization event payload tag does not match the body.'}
    }
  }
  return {pubkey: event.pubkey}
}

// LUD-25's address proof. A cx1 is public, so pointing a name at one, or
// away from one, has to be proven by the branch itself: a BIP-340
// signature by its index-0 key over sha256("LNURLcash:<action>:<domain>:
// <name>"). The domain is this mint's own, so a proof one mint has seen
// cannot be replayed at another; the action and name are in it so a
// register cannot be replayed as an unregister, or for another name.
export const addressProofVerifies = (args: {
  cx1: string
  action: 'register' | 'unregister'
  name: string
  domains: string[]
  sig: unknown
}): boolean => {
  if (typeof args.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(args.sig)) return false
  const branch = decodeCx1(args.cx1)
  if (!branch) return false
  let firstKey: Uint8Array
  try {
    firstKey = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
  } catch {
    return false
  }
  const signature = hexToBytes(args.sig.toLowerCase())
  return args.domains.some(domain => {
    try {
      return schnorr.verify(signature, sha256(utf8ToBytes(`LNURLcash:${args.action}:${domain}:${args.name}`)), firstKey)
    } catch {
      return false
    }
  })
}

export type NameRefusal = {reason: string; status: number}
export type NameGranted = {name: string; pubkey: string; paidMsat: number; cx1: string | null; updated: boolean}

const refuse = (reason: string, status: number): NameRefusal => ({reason, status})

export const isRefusal = (result: NameGranted | NameRefusal): result is NameRefusal => 'reason' in result

// The whole registration, minus the transport. Burning the note and
// inserting the name are the two mutations, in that order: a name that
// exists without payment is worse than a note burned without a name,
// and the INSERT is what settles a race between two people asking for
// the same name at once.
export const registerName = async (args: {
  store: NoteStore
  pubkey: string
  body: {name?: unknown; note?: unknown; cx1?: unknown; sig?: unknown}
  priceMsat: number | undefined
  // The mint's own username, plus anything else it will not give away.
  reserved: string[]
  // Notes offered in payment must belong to this host.
  host: string
  // This mint's own domains, any of which an address proof may be bound to.
  domains: string[]
  // The note a k1 verifiably opens, in any state, or null: the same check
  // the withdraw callback makes, so a name is paid for exactly as a melt is.
  openNote: (k1: string) => Promise<NoteRow | null>
}): Promise<NameGranted | NameRefusal> => {
  const {store, pubkey, priceMsat} = args
  const raw = typeof args.body.name === 'string' ? args.body.name.trim().toLowerCase() : ''
  if (!NAME_RULE.test(raw)) {
    return refuse('A name is 3 to 32 characters of a-z, 0-9, dot, dash or underscore, starting with a letter or digit.', 400)
  }
  if ([...ALWAYS_RESERVED, ...args.reserved.map(name => name.toLowerCase())].includes(raw)) {
    return refuse('That name is reserved.', 403)
  }
  // LUD-25 Part 2: a watch-only branch, so payments to the name are minted
  // to the holder's own keys. Absent leaves it as it is; null clears it.
  let cx1: string | null | undefined
  if (args.body.cx1 === null) {
    cx1 = null
  } else if (args.body.cx1 !== undefined) {
    const given = typeof args.body.cx1 === 'string' ? args.body.cx1.trim().toLowerCase() : ''
    if (!decodeCx1(given)) return refuse('That is not a cx1.', 400)
    cx1 = given
  }

  const proven = (branch: string, action: 'register' | 'unregister'): boolean =>
    addressProofVerifies({cx1: branch, action, name: raw, domains: args.domains, sig: args.body.sig})
  const unproven = refuse(
    'Setting or clearing a cx1 needs "sig": the branch\'s index-0 key signing sha256("LNURLcash:register:<domain>:<name>"), or :unregister: to clear.',
    403
  )

  const existing = store.zapName(raw)
  if (existing) {
    // Its owner may set or clear the branch; nobody else may touch it. The
    // NIP-98 key owns the name, and the branch on file must agree to any
    // change of where it pays: LUD-25 has an overwrite proven by the
    // branch currently registered, not the one being switched to.
    if (existing.pubkey === pubkey && cx1 !== undefined) {
      if (cx1 === null && existing.cx1 && !proven(existing.cx1, 'unregister')) return unproven
      if (cx1 !== null && !proven(existing.cx1 ?? cx1, 'register')) return unproven
      store.setZapNameCx1(raw, cx1)
      return {name: raw, pubkey, paidMsat: 0, cx1, updated: true}
    }
    return refuse('That name is taken.', 409)
  }
  // Checked after the owner's update above: closing registration stops new
  // names, not a holder choosing where their own name pays.
  if (priceMsat === undefined) return refuse('This mint is not registering names.', 404)
  // A fresh name pointed at a branch proves control of that branch.
  if (typeof cx1 === 'string' && !proven(cx1, 'register')) return unproven

  let paidMsat = 0
  let noteId: string | undefined
  if (priceMsat === 0) {
    // Free names are rationed per key. The per-address limit is the
    // reverse proxy's job; this is the one the mint can enforce itself.
    if (store.zapNameCountFor(pubkey) >= FREE_NAMES_PER_PUBKEY) {
      return refuse(`One key may hold ${FREE_NAMES_PER_PUBKEY} free names.`, 403)
    }
  } else {
    const offered = typeof args.body.note === 'string' ? args.body.note.trim() : ''
    if (!offered) return refuse(`This name costs ${priceMsat} msat - send a note of this mint in "note".`, 402)
    // A bare secret is accepted as readily as a full note URL; a URL for
    // somebody else's mint is not, however good the note is. The URL is
    // read here rather than through the kit's resolver, which refuses a
    // plain-http service - correct for a wallet reaching a stranger, and
    // wrong for a mint reading a note it minted itself.
    let k1: string | null = null
    if (decodeSpend(offered)) {
      k1 = offered
    } else {
      let url: URL
      try {
        url = new URL(offered.replace(/^lnurlw:\/\//i, 'https://'))
      } catch {
        return refuse('That is not a note.', 400)
      }
      if (url.host !== args.host) return refuse('That note is not from this mint.', 400)
      k1 = noteK1(url.toString())
    }
    if (!k1) return refuse('That is not a note.', 400)
    const note = await args.openNote(k1)
    if (!note || note.state === 'burned') return refuse('That note is spent or was never minted here.', 400)
    if (note.state === 'pending') return refuse('That note has a melt in flight.', 409)
    if (note.amountMsat < priceMsat) {
      return refuse(`That note is worth ${note.amountMsat} msat and a name costs ${priceMsat} msat.`, 402)
    }
    // The note is burned outright, with no change: the whole of it pays
    // for the name, which is why the price is published and a wallet
    // splits before it asks. Liabilities drop by exactly this much and
    // the sats become revenue.
    noteId = note.id
    paidMsat = note.amountMsat
  }

  try {
    store.buyZapName({name: raw, pubkey, ...(noteId ? {noteId} : {}), paidMsat, cx1: cx1 ?? null})
  } catch (err) {
    if (err instanceof NotePendingError) return refuse('That note has a melt in flight.', 409)
    if (err instanceof NoteUnavailableError) return refuse('That note is spent or was never minted here.', 400)
    // The INSERT lost a race. Nothing was burned: the transaction took
    // the name and the note together or not at all.
    return refuse('That name is taken.', 409)
  }
  return {name: raw, pubkey, paidMsat, cx1: cx1 ?? null, updated: false}
}
