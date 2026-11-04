import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {encodeCp1, hashK1} from '@lnurlcash/kit'
import {bearerNoteIdOfPreimage} from './spend.ts'
import {shareOnFile} from './shares.ts'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import {finalizeEvent, getPublicKey, type Event, type UnsignedEvent} from 'nostr-tools/pure'
import {SimplePool} from 'nostr-tools/pool'
import {makeZapReceipt, validateZapRequest} from 'nostr-tools/nip57'
import {wrapEvent} from 'nostr-tools/nip59'
import type {Filter} from 'nostr-tools/filter'
import type {ZapConfig} from './config.ts'
import {NotePendingError, NoteUnavailableError, swapFingerprint, type NoteRow, type NoteStore, type ZapInvoiceRow} from './store.ts'
import type {LightningBackend} from './backends/types.ts'

// Zap-to-note: a lightning address on this host that pays out as an
// LNURLcash note delivered over Nostr.
//
// A NIP-57 zap is an ordinary LNURL-pay. Unlike current LUD-25 minting it
// carries no wallet-chosen output commitment, so a zap name works in the
// recipient direction instead: its invoice gets a throwaway preimage; on
// settlement the mint creates a note with a fresh secret of its own,
// gift-wraps it (NIP-59, kind 2525 rumor) to the name's pubkey, leaves it on
// their NIP-17 inbox relays, and publishes the kind 9735 receipt that makes
// the zap show up in clients.
//
// Until the recipient rotates the note, the mint knows its secret. That is
// why wallets rotate on receipt. The mint also learns who was paid, which a
// lightning address always did.

export const NOTE_KIND = 2525
export const INBOX_RELAYS_KIND = 10050
export const ZAP_REQUEST_KIND = 9734

// Where a recipient's kind 10050 is looked for, beyond the mint's own relays.
export const INDEXER_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol']

export type NostrTransport = {
  publish(relays: string[], event: Event): Promise<{ok: string[]; failed: string[]}>
  query(relays: string[], filter: Filter): Promise<Event[]>
  close(): void
}

// How long a settled zap keeps retrying the recipient's inbox relays
// before it settles for whichever took the wrap. The receiver reads ONE
// of its inbox relays, so a wrap that reached three others is still
// undelivered. Seen live: a long-lived pool's dead socket to the device's
// relay failed silently for hours while the other relays said OK.
export const INBOX_RETRY_MS = 10 * 60_000

export const poolTransport = (): NostrTransport => {
  const pool = new SimplePool()
  const used = new Set<string>()
  return {
    async publish(relays, event) {
      for (const r of relays) used.add(r)
      // A relay whose socket died reports failure forever on a pool that
      // keeps the stale Relay object; drop it so the next publish dials
      // afresh.
      const results = await Promise.allSettled(pool.publish(relays, event))
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          try {
            pool.close([relays[i]!])
          } catch {
            // nothing to close
          }
        }
      })
      const ok: string[] = []
      const failed: string[] = []
      results.forEach((r, i) => (r.status === 'fulfilled' ? ok : failed).push(relays[i]!))
      return {ok, failed}
    },
    async query(relays, filter) {
      for (const r of relays) used.add(r)
      try {
        return await pool.querySync(relays, filter, {maxWait: 6_000})
      } catch {
        return []
      }
    },
    close() {
      pool.close([...used])
    }
  }
}

export const inboxRelays = async (transport: NostrTransport, pubkey: string, lookOn: string[]): Promise<string[]> => {
  const events = await transport.query(lookOn, {kinds: [INBOX_RELAYS_KIND], authors: [pubkey], limit: 3})
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!latest) return []
  return [...new Set(latest.tags.filter(t => t[0] === 'relay' && t[1]).map(t => t[1]!))]
}

export type ZapBridgeDeps = {
  config: ZapConfig
  store: NoteStore
  backend: LightningBackend
  transport: NostrTransport
  // The mint's fee posture, shared with /p/cb so a zap nets what a mint
  // would.
  netAfterMintFee: (grossMsat: number) => number
  minSendableMsat: number
  maxSendableMsat: number
  minMintMsat: number
  // `Mint fees: <base>,<ppm>`, without the address fee: a LUD-26 address
  // carries mint@'s mint fees, and only mint@ advertises what registering
  // costs.
  mintFeeLine: string | null
  feeInWords: string | null
  // The mint's withdraw endpoint, `${origin}/w`: an address with a share
  // advertises it, as LUD-26 has, so a payer holding a note here knows it
  // is the same mint and may transfer internally.
  withdrawLink: string
  // The note a spend verifiably opens, in any state, by Q, or a reason: the
  // check the withdraw callback makes before anything moves.
  openNote: (k1: string) => Promise<{q: string; note: NoteRow} | {reason: string}>
  verify: boolean
  // The mint's public origin. Required when zaps are on: a settled zap is
  // minted by a timer, with no request to read a Host header from.
  origin: string
  // The mint's certificate for a key note, as cs1 over the domain its URL
  // names: what lets the holder check what arrived before touching the mint.
  certify: (noteIdHex: string, amountMsat: number, domain: string) => string
  log?: (message: string) => void
  now?: () => number
}

export type ZapCallbackResult = {pr: string; verify?: string} | {status: 'OK'} | {reason: string}

export type ZapBridge = {
  // The mint's Nostr pubkey (hex): `nostrPubkey` in every zap payRequest.
  pubkey: string
  isZapName(name: string): boolean
  payRequest(name: string): Record<string, unknown> | null
  // With a `k1`, LUD-26's internal transfer instead of an invoice.
  callback(name: string, amountMsat: number, nostrParam: string | null, k1?: string | null): Promise<ZapCallbackResult>
  // Poll the funding source for settled zap invoices: mint, wrap, park.
  settle(): Promise<number>
  // Push parked wraps and receipts to relays. A wrap that reaches no relay
  // stays parked for the next pass.
  publish(): Promise<number>
  sweep(nowMs?: number): Promise<number>
  // LUD-26 address fees: register each held name whose invoice settled,
  // and free each whose invoice expired unpaid.
  settleHolds(nowMs?: number): Promise<number>
  // One hold, checked now: what a lookup of a held name does, so a payment
  // the poll has not reached yet still publishes the address.
  settleHold(paymentHash: string): Promise<boolean>
}

// The same for every payment to a name, so an invoice commits to exactly
// what the payer was shown (LUD-06). No key of the share is ever in it:
// LUD-26 dropped `text/cpub`, since anyone who fetched it could watch the
// share. A payer holding a note here transfers by the callback instead.
const metadataFor = (name: string, host: string, mintFeeLine: string | null, feeInWords: string | null = null): string => {
  const metadata: Array<[string, string]> = [
    ['text/plain', `Zap ${name}@${host}: arrives as a Lightning bearer note${feeInWords ? ` (${feeInWords})` : ''}`],
    ['text/identifier', `${name}@${host}`]
  ]
  if (mintFeeLine) metadata.push(['text/plain', mintFeeLine])
  return JSON.stringify(metadata)
}

// LUD-16's `+tag`: a payment to <name>+<tag> is a payment to <name>.
export const addressName = (name: string): string => name.toLowerCase().split('+', 1)[0]!

const tagValues = (event: {tags: string[][]}, name: string): string[] =>
  event.tags.filter(t => t[0] === name && t[1]).map(t => t[1]!)

export const createZapBridge = (deps: ZapBridgeDeps): ZapBridge => {
  const {config, store, backend, transport} = deps
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const secret = hexToBytes(config.nostrKey)
  const pubkey = getPublicKey(secret)
  const origin = deps.origin
  const host = new URL(origin).host

  // Names live in the store, not in the configuration: the operator's own
  // are loaded there at startup and self-service registrations land in
  // the same table, so one lookup serves both. A `+tag` names the same
  // name (LUD-16).
  const isZapName = (name: string): boolean => store.zapName(addressName(name)) !== null

  const payRequest = (name: string): Record<string, unknown> | null => {
    const lowered = addressName(name)
    const registered = store.zapName(lowered)
    if (!registered) return null
    const share = shareOnFile(registered.cx1)
    return {
      tag: 'payRequest',
      // The name alone: nothing in the payRequest moves between payments,
      // so the invoice's description hash is always over the metadata the
      // payer saw.
      callback: `${origin}/z/cb/${lowered}`,
      minSendable: deps.minSendableMsat,
      maxSendable: deps.maxSendableMsat,
      metadata: metadataFor(lowered, host, deps.mintFeeLine, deps.feeInWords),
      // A Nostr key owns the name, so a zap to it can be receipted to that
      // key. A name owned by its share alone has no key to receipt to.
      ...(registered.pubkey ? {allowsNostr: true, nostrPubkey: pubkey} : {}),
      // A name with a share is a LUD-26 Lightning Address: it names the
      // mint it credits, and invites no comment, since the note it mints is
      // the share's next key, which no comment could choose. A wallet reads
      // exactly that pair as "same mint, transfer internally". A name with
      // no share carries neither: its invoice's preimage is NOT a note, and
      // there is no share for an internal transfer to credit.
      ...(share ? {withdrawLink: deps.withdrawLink} : {})
    }
  }

  // LUD-26's internal transfer: a payer holding a note on this mint sends
  // the note itself, `k1`, instead of asking for an invoice. A rotate whose
  // output this mint picks: verified like any spend, the whole note's value
  // credited free of fees to the share's next unused key, which the payer
  // never learns. A retry of a completed transfer is answered as the first.
  const transfer = async (name: string, amountMsat: number, k1: string): Promise<ZapCallbackResult> => {
    const registered = store.zapName(name)
    if (!registered || !shareOnFile(registered.cx1)) return {reason: 'This address takes Lightning payments only.'}
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) return {reason: 'Invalid amount.'}
    if (amountMsat < deps.minSendableMsat || amountMsat > deps.maxSendableMsat) {
      return {reason: 'Amount outside what this address accepts.'}
    }
    const opened = await deps.openNote(k1)
    if ('reason' in opened) return {reason: opened.reason}
    // The output is the mint's to pick, so the request is identified by
    // its input, its payee and its amount.
    const fingerprint = swapFingerprint({inputIds: [opened.note.id], h: `transfer:${name}`, amountMsat})
    if (store.swapByFingerprint(fingerprint)) return {status: 'OK'}
    if (opened.note.state === 'burned') return {reason: 'already in use'}
    if (opened.note.state === 'pending') return {reason: 'pending'}
    if (amountMsat !== opened.note.amountMsat) {
      return {reason: `amount must be the note's full value, ${opened.note.amountMsat} msat - split it first.`}
    }
    try {
      const credited = store.transferToShare({inputIds: [opened.note.id], name, amountMsat, fingerprint})
      log(`transfer: ${amountMsat} msat to ${name}, key ${credited.index}`)
    } catch (err) {
      if (err instanceof NotePendingError) return {reason: 'pending'}
      if (err instanceof NoteUnavailableError) return {reason: 'already in use'}
      throw err
    }
    return {status: 'OK'}
  }

  const callback = async (
    name: string,
    amountMsat: number,
    nostrParam: string | null,
    k1: string | null = null
  ): Promise<ZapCallbackResult> => {
    const lowered = addressName(name)
    const registered = store.zapName(lowered)
    if (!registered) return {reason: 'unknown user'}
    if (k1 !== null && k1 !== '') return transfer(lowered, amountMsat, k1)
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) return {reason: 'Invalid amount.'}
    if (amountMsat < deps.minSendableMsat || amountMsat > deps.maxSendableMsat) return {reason: 'Amount out of range.'}
    const net = deps.netAfterMintFee(amountMsat)
    if (net < deps.minMintMsat) return {reason: 'Amount too small to mint a note.'}
    const recipient = registered.pubkey

    let zapRequest: string | null = null
    if (nostrParam !== null && nostrParam !== '') {
      if (!recipient) return {reason: `${lowered}@${host} takes no zaps: no Nostr key owns it.`}
      const problem = validateZapRequest(nostrParam)
      if (problem) return {reason: problem}
      const parsed = JSON.parse(nostrParam) as Event
      if (parsed.kind !== ZAP_REQUEST_KIND) return {reason: 'Zap request is not kind 9734.'}
      const p = tagValues(parsed, 'p')
      if (p.length !== 1 || p[0] !== recipient) return {reason: `Zap request is not for ${lowered}@${host}.`}
      const amountTag = tagValues(parsed, 'amount')[0]
      if (amountTag !== undefined && Number(amountTag) !== amountMsat) {
        return {reason: 'Zap request amount does not match.'}
      }
      zapRequest = nostrParam
    }

    // A throwaway preimage: the payer will learn it, and it must be worth
    // nothing to them. The note's secret, or its key, is settled on later.
    const preimage = bytesToHex(randomBytes(32))
    const paymentHash = hashK1(preimage)
    let pr: string
    try {
      pr = (
        await backend.createInvoice({
          amountMsat,
          preimageHex: preimage,
          memo: `Zap ${lowered}@${host}`,
          // A zap commits to its zap request (NIP-57); any other payment to
          // the metadata the payer was shown (LUD-06).
          descriptionForHash: zapRequest ?? metadataFor(lowered, host, deps.mintFeeLine, deps.feeInWords)
        })
      ).pr
    } catch (err) {
      log(`zap: create invoice failed: ${(err as Error).message}`)
      return {reason: 'Temporarily unable to issue an invoice.'}
    }
    const decoded = tryDecodeBolt11(pr)
    if (!decoded || decoded.paymentHashHex !== paymentHash || decoded.amountMsats !== BigInt(amountMsat)) {
      log('zap: funding source returned an invoice that does not match the requested preimage/amount')
      return {reason: 'Temporarily unable to issue an invoice.'}
    }
    // No Nostr key, no wrap: recorded as '' and never delivered. The note
    // waits at the mint for the holder's scan of the share.
    store.recordZapInvoice({paymentHash, name: lowered, recipient: recipient ?? '', pr, grossMsat: amountMsat, netMsat: net, zapRequest})
    return {pr, ...(deps.verify ? {verify: `${origin}/verify/${paymentHash}`} : {})}
  }

  const wrapTags = (row: ZapInvoiceRow): string[][] => {
    const tags: string[][] = [
      ['p', row.recipient],
      ['amount', String(row.netMsat)],
      ['u', `${host}/w`]
    ]
    if (row.zapRequest) {
      const zr = JSON.parse(row.zapRequest) as Event
      // Who zapped, and what they zapped, so a receiver can say so.
      tags.push(['P', zr.pubkey])
      for (const e of tagValues(zr, 'e')) tags.push(['e', e])
      for (const a of tagValues(zr, 'a')) tags.push(['a', a])
      // The zap request itself, the same content the kind 9735 receipt
      // carries, so a wallet can show who zapped and what they wrote
      // without going to a relay for it. Readers take tags by name, so an
      // older one simply does not see this.
      tags.push(['description', row.zapRequest])
    }
    return tags
  }

  const wrap = (row: ZapInvoiceRow, tags: string[][], content: string): Event => {
    const rumor: UnsignedEvent = {kind: NOTE_KIND, pubkey, created_at: Math.floor(now() / 1000), tags, content}
    return wrapEvent(rumor, secret, row.recipient)
  }

  // The note as the recipient's wallet will paste it, wrapped to them.
  const buildWrap = (row: ZapInvoiceRow, k1: string): Event =>
    wrap(row, wrapTags(row), `${origin}/w?k1=${k1}&amount=${row.netMsat}`)

  // A zap to a name with a cx1: the note already belongs to the holder's
  // key, so the wrap carries no secret at all, only where to look (`p`),
  // the certificate, and the index `i` the holder derives the key at. A
  // reader that knows only note URLs sees no k1 and passes it by, and the
  // note waits at the mint for a scan to find it.
  const buildKeyWrap = (row: ZapInvoiceRow, noteId: string, index: number): Event =>
    wrap(
      row,
      [...wrapTags(row), ['i', String(index)]],
      `${origin}/w?p=${encodeCp1(hexToBytes(noteId))}&c=${deps.certify(noteId, row.netMsat, new URL(origin).hostname.toLowerCase())}&i=${index}`
    )

  // NIP-57 receipt, without the preimage tag: it is optional there, and
  // here it would only invite someone to mistake it for the note.
  const buildReceipt = (row: ZapInvoiceRow): Event | null => {
    if (!row.zapRequest) return null
    const unsigned = makeZapReceipt({zapRequest: row.zapRequest, bolt11: row.pr, paidAt: new Date(now())})
    return finalizeEvent(unsigned, secret)
  }

  const settle = async (): Promise<number> => {
    let minted = 0
    for (const row of store.unsettledZapInvoices()) {
      let paid: boolean
      try {
        paid = await backend.isInvoiceSettled(row.paymentHash)
      } catch (err) {
        log(`zap: settlement check failed for ${row.paymentHash.slice(0, 8)}: ${(err as Error).message}`)
        continue
      }
      if (!paid) continue
      const share = shareOnFile(store.zapName(row.name)?.cx1)
      if (share) {
        const receipt = buildReceipt(row)
        const landed = store.settleZapInvoiceToKey(row.paymentHash, share.noteAt, (noteId, index) => ({
          // Only a Nostr key gets a wrap. Without one the note simply waits
          // for the holder's scan, as LUD-26's auto-mint has it.
          wrapJson: row.recipient ? JSON.stringify(buildKeyWrap(row, noteId, index)) : null,
          receiptJson: receipt ? JSON.stringify(receipt) : null
        }))
        if (landed) {
          minted += 1
          log(`zap: ${row.name} received ${row.netMsat} msat; note minted to key ${landed.index}${row.recipient ? ', wrap parked' : ''}`)
        }
        continue
      }
      const k1 = bytesToHex(randomBytes(32))
      // The bearer note whose preimage is k1, stored under its Q.
      const noteId = bearerNoteIdOfPreimage(k1)
      const wrap = buildWrap(row, k1)
      const receipt = buildReceipt(row)
      if (store.settleZapInvoice(row.paymentHash, noteId, JSON.stringify(wrap), receipt ? JSON.stringify(receipt) : null)) {
        minted += 1
        log(`zap: ${row.name} received ${row.netMsat} msat; note ${noteId.slice(0, 8)} minted, wrap parked`)
      }
    }
    return minted
  }

  const publish = async (): Promise<number> => {
    let published = 0
    for (const row of store.unpublishedZaps()) {
      if (!row.wrapJson) {
        store.markZapPublished(row.paymentHash)
        continue
      }
      const wrap = JSON.parse(row.wrapJson) as Event
      const lookOn = [...new Set([...config.relays, ...INDEXER_RELAYS])]
      const inbox = await inboxRelays(transport, row.recipient, lookOn)
      const wrapRelays = [...new Set([...inbox, ...config.relays])]
      const result = await transport.publish(wrapRelays, wrap)
      if (!result.ok.length) {
        log(`zap: wrap for ${row.name} reached no relay (${result.failed.join(', ')}); will retry`)
        continue
      }
      const missedInbox = result.failed.filter(r => inbox.includes(r))
      if (missedInbox.length) {
        const age = now() - (row.settledAt ?? now())
        if (age < INBOX_RETRY_MS) {
          log(`zap: wrap for ${row.name} missed inbox relay(s) ${missedInbox.join(', ')}; parked for another try`)
          continue
        }
        log(`zap: wrap for ${row.name} never reached ${missedInbox.join(', ')} in ${Math.round(age / 60_000)} min; left on ${result.ok.join(', ')}`)
      }
      if (!inbox.length) log(`zap: ${row.name} publishes no inbox list; wrap left on the mint's relays`)
      if (row.receiptJson) {
        const receipt = JSON.parse(row.receiptJson) as Event
        // NIP-57 puts every relay in ONE tag: ["relays", url, url, ...].
        const zr = JSON.parse(row.zapRequest ?? '{"tags":[]}') as Event
        const fromRequest = zr.tags.find(t => t[0] === 'relays')?.slice(1) ?? []
        const receiptRelays = [...new Set([...fromRequest, ...config.relays])].filter(r => /^wss?:\/\//.test(r))
        const sent = await transport.publish(receiptRelays, receipt)
        if (!sent.ok.length) log(`zap: receipt for ${row.name} reached no relay; the note still went out`)
      }
      store.markZapPublished(row.paymentHash)
      published += 1
    }
    return published
  }

  // As the mint-invoice sweep: an expired row goes only once the funding
  // source confirms it unpaid. One paid while the mint was down stays for
  // the next settle pass to mint, and no answer deletes nothing.
  const sweep = async (nowMs: number = now()): Promise<number> => {
    const stale: string[] = []
    for (const row of store.unsettledZapInvoices()) {
      const decoded = tryDecodeBolt11(row.pr)
      if (!decoded) continue
      if (nowMs > (decoded.timestamp + decoded.expirySeconds) * 1000 + 3_600_000) stale.push(row.paymentHash)
    }
    let swept = 0
    for (const hash of stale) {
      let paid: boolean
      try {
        paid = await backend.isInvoiceSettled(hash)
      } catch {
        continue
      }
      if (paid) continue
      store.deleteUnsettledZapInvoice(hash)
      swept++
    }
    return swept
  }

  const settleHold = async (paymentHash: string): Promise<boolean> => {
    let paid: boolean
    try {
      paid = await backend.isInvoiceSettled(paymentHash)
    } catch (err) {
      log(`address fee: settlement check failed for ${paymentHash.slice(0, 8)}: ${(err as Error).message}`)
      return false
    }
    if (!paid) return false
    const settled = store.settleHold(paymentHash)
    if (settled?.registered) log(`address ${settled.name} registered: its fee settled`)
    else if (settled) log(`address fee for ${settled.name} settled after its hold lapsed and the name was taken: fee kept, nothing registered`)
    return settled?.registered ?? false
  }

  // As the zap sweep: an expired hold goes only once the funding source
  // confirms its invoice unpaid. The name was free again from the moment
  // the invoice expired; this only tidies the row away.
  const settleHolds = async (nowMs: number = now()): Promise<number> => {
    let registered = 0
    for (const hold of store.unsettledHolds()) {
      if (await settleHold(hold.paymentHash)) {
        registered += 1
        continue
      }
      if (nowMs > hold.expiresAt + 3_600_000) {
        let paid = true
        try {
          paid = await backend.isInvoiceSettled(hold.paymentHash)
        } catch {
          continue
        }
        if (!paid) store.deleteUnsettledHold(hold.paymentHash)
      }
    }
    return registered
  }

  return {pubkey, isZapName, payRequest, callback, settle, publish, sweep, settleHolds, settleHold}
}
