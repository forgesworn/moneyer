import {KeyUsedError, NameTakenError, type NoteStore} from './store.ts'
import {ALWAYS_RESERVED, NAME_RULE} from './names.ts'
import {decodeShare, proofVerifies, shareOnFile} from './shares.ts'

// LUD-26 registration at the Lightning Address itself:
//
//   POST   /.well-known/lnurlp/<username>   cx1, sig              register
//   PUT    /.well-known/lnurlp/<username>   cx1, sig, newsig      move to a new share
//   DELETE /.well-known/lnurlp/<username>   sig                   unregister
//
// A share's own key proves every change, so a name registered here is
// owned by its share and by no Nostr key. That is the other door onto the
// same table as POST /names, where a NIP-98 signature owns the name and a
// cx1 is optional; the rules on cx1s (never overwritten by a POST, no key
// accepted twice) are the store's, so neither door can get round them.
//
// Transport-free: the server parses the form and sends the answer, always
// HTTP 200 with the reason in the body, as LNURL answers.

export type AddressAnswer = {status: 'OK'; pr?: string} | {reason: string}

const INVALID_SIG = 'Invalid ownership signature.'
const UNKNOWN_USER = 'unknown user'

export type FeeInvoice = {pr: string; paymentHash: string; expiresAt: number}

export type AddressContext = {
  store: NoteStore
  // Every domain a proof may be bound to: this mint's own.
  domains: string[]
  // The mint's own username, and anything else it will not give away.
  reserved: string[]
  // Registration's price, the LUD-26 address fee: undefined while this mint
  // registers no names, 0 for free.
  feeMsat: number | undefined
  issueFeeInvoice: (feeMsat: number, name: string) => Promise<FeeInvoice>
  log: (message: string) => void
  nowMs?: number
}

const registrable = (name: string, reserved: string[]): boolean =>
  NAME_RULE.test(name) && ![...ALWAYS_RESERVED, ...reserved.map(entry => entry.toLowerCase())].includes(name)

const field = (form: URLSearchParams, name: string): string | null => {
  const value = form.get(name)
  return value === null ? null : value.trim()
}

export const registerAddress = async (ctx: AddressContext, username: string, form: URLSearchParams): Promise<AddressAnswer> => {
  if (ctx.feeMsat === undefined) return {reason: 'This mint is not registering names.'}
  const name = username.toLowerCase()
  if (!registrable(name, ctx.reserved)) return {reason: 'Invalid or reserved username.'}
  // LUD-26 lets a SERVICE take an unsigned npub for NIP-05. This one does
  // not: an npub nobody signed for would let anyone tie a name here to
  // somebody else's Nostr identity. NIP-98 is how a key claims a name.
  if (form.has('npub')) {
    return {reason: 'npub is not taken unsigned here: attach one with POST /names, signed by that key (NIP-98).'}
  }
  const share = decodeShare(field(form, 'cx1'))
  if (!share) return {reason: 'Invalid cx1.'}
  if (!proofVerifies({action: 'register', domains: ctx.domains, username: name, cx1: share.cx1, keys: share.proofKeys(), sig: field(form, 'sig')})) {
    return {reason: INVALID_SIG}
  }
  const nowMs = ctx.nowMs ?? Date.now()
  // Checked before an invoice exists, so a refused registration costs the
  // funding source nothing. The store checks both again, atomically.
  if (ctx.store.nameTaken(name, nowMs)) return {reason: 'already registered'}
  if (ctx.store.keyAccepted(share.cx1)) return {reason: 'cx1 already used'}
  try {
    if (ctx.feeMsat === 0) {
      ctx.store.registerShareName({name, cx1: share.cx1, nowMs})
      ctx.log(`address ${name} registered to a share, free`)
      return {status: 'OK'}
    }
    let invoice: FeeInvoice
    try {
      invoice = await ctx.issueFeeInvoice(ctx.feeMsat, name)
    } catch (err) {
      ctx.log(`address fee invoice for ${name} failed: ${(err as Error).message}`)
      return {reason: 'Temporarily unable to issue an invoice.'}
    }
    ctx.store.holdAddress({
      paymentHash: invoice.paymentHash,
      pr: invoice.pr,
      name,
      cx1: share.cx1,
      feeMsat: ctx.feeMsat,
      expiresAt: invoice.expiresAt,
      nowMs
    })
    ctx.log(`address ${name} held for its fee of ${ctx.feeMsat} msat`)
    return {status: 'OK', pr: invoice.pr}
  } catch (err) {
    if (err instanceof NameTakenError || err instanceof KeyUsedError) return {reason: err.message}
    throw err
  }
}

export const updateAddress = (ctx: AddressContext, username: string, form: URLSearchParams): AddressAnswer => {
  const name = username.toLowerCase()
  const row = ctx.store.zapName(name)
  if (!row) return {reason: UNKNOWN_USER}
  const onFile = shareOnFile(row.cx1)
  if (!onFile) return {reason: 'This name has no cx1 on file to move: set one with POST /names.'}
  const share = decodeShare(field(form, 'cx1'))
  if (!share) return {reason: 'Invalid cx1.'}
  const proven =
    proofVerifies({action: 'update', domains: ctx.domains, username: name, cx1: share.cx1, keys: onFile.proofKeys(), sig: field(form, 'sig')}) &&
    proofVerifies({action: 'register', domains: ctx.domains, username: name, cx1: share.cx1, keys: share.proofKeys(), sig: field(form, 'newsig')})
  if (!proven) return {reason: INVALID_SIG}
  try {
    // The same cx1 sent again is a key accepted before, so it is refused
    // as LUD-26 says rather than answered as a no-op.
    if (ctx.store.keyAccepted(share.cx1)) return {reason: 'cx1 already used'}
    ctx.store.setZapNameCx1(name, share.cx1)
  } catch (err) {
    if (err instanceof KeyUsedError) return {reason: err.message}
    throw err
  }
  ctx.log(`address ${name} moved to a new share`)
  return {status: 'OK'}
}

export const unregisterAddress = (ctx: AddressContext, username: string, form: URLSearchParams): AddressAnswer => {
  const name = username.toLowerCase()
  const row = ctx.store.zapName(name)
  const onFile = shareOnFile(row?.cx1)
  if (!row || !onFile) return {reason: UNKNOWN_USER}
  if (!proofVerifies({action: 'unregister', domains: ctx.domains, username: name, keys: onFile.proofKeys(), sig: field(form, 'sig')})) {
    return {reason: INVALID_SIG}
  }
  // A name a Nostr key owns stays that key's: the share withdraws, and the
  // name pays out as a gift-wrapped note again. One owned by its share
  // alone is freed. Either way the share's key stays accepted.
  if (row.pubkey) {
    ctx.store.setZapNameCx1(name, null)
    ctx.log(`address ${name} unregistered its share; the name stays with its Nostr key`)
  } else {
    ctx.store.removeZapName(name)
    ctx.log(`address ${name} unregistered and freed`)
  }
  return {status: 'OK'}
}
