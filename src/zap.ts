import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {hashK1} from 'lnurlcash-kit'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import {finalizeEvent, getPublicKey, type Event, type UnsignedEvent} from 'nostr-tools/pure'
import {SimplePool} from 'nostr-tools/pool'
import {makeZapReceipt, validateZapRequest} from 'nostr-tools/nip57'
import {wrapEvent} from 'nostr-tools/nip59'
import type {Filter} from 'nostr-tools/filter'
import type {ZapConfig} from './config.ts'
import type {NoteStore, ZapInvoiceRow} from './store.ts'
import type {LightningBackend} from './backends/types.ts'

// Zap-to-note: a lightning address on this host that pays out as an
// LNURLcash note delivered over Nostr.
//
// A NIP-57 zap is an ordinary LNURL-pay. Paying the mint's own address
// would mint a note, but to the PAYER: LUD-25 makes the invoice preimage
// the secret, and on Lightning the payer always learns the preimage. So a
// zap name works the other way round. The invoice gets a throwaway
// preimage; on settlement the mint creates a note with a fresh secret of
// its own, gift-wraps it (NIP-59, kind 2525 rumor) to the name's pubkey,
// leaves it on their NIP-17 inbox relays, and publishes the kind 9735
// receipt that makes the zap show up in clients.
//
// Until the recipient rotates the note, the mint knows its secret. That is
// exactly the position a freshly minted note is in anyway, and it is why
// wallets rotate on receipt. What is new is that the mint learns who was
// paid, which a lightning address always did.

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

export const poolTransport = (): NostrTransport => {
  const pool = new SimplePool()
  const used = new Set<string>()
  return {
    async publish(relays, event) {
      for (const r of relays) used.add(r)
      const results = await Promise.allSettled(pool.publish(relays, event))
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
  mintFeeLine: string | null
  feeInWords: string | null
  verify: boolean
  // The mint's public origin. Required when zaps are on: a settled zap is
  // minted by a timer, with no request to read a Host header from.
  origin: string
  log?: (message: string) => void
  now?: () => number
}

export type ZapCallbackResult = {pr: string; verify?: string} | {reason: string}

export type ZapBridge = {
  // The mint's Nostr pubkey (hex): `nostrPubkey` in every zap payRequest.
  pubkey: string
  isZapName(name: string): boolean
  payRequest(name: string): Record<string, unknown> | null
  callback(name: string, amountMsat: number, nostrParam: string | null): Promise<ZapCallbackResult>
  // Poll the funding source for settled zap invoices: mint, wrap, park.
  settle(): Promise<number>
  // Push parked wraps and receipts to relays. A wrap that reaches no relay
  // stays parked for the next pass.
  publish(): Promise<number>
  sweep(nowMs?: number): number
}

const metadataFor = (name: string, host: string, mintFeeLine: string | null, feeInWords: string | null = null): string => {
  const metadata: Array<[string, string]> = [
    ['text/plain', `Zap ${name}@${host}: arrives as a Lightning bearer note${feeInWords ? ` (${feeInWords})` : ''}`],
    ['text/identifier', `${name}@${host}`]
  ]
  if (mintFeeLine) metadata.push(['text/plain', mintFeeLine])
  return JSON.stringify(metadata)
}

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

  const isZapName = (name: string): boolean => Object.hasOwn(config.names, name.toLowerCase())

  const payRequest = (name: string): Record<string, unknown> | null => {
    const lowered = name.toLowerCase()
    if (!isZapName(lowered)) return null
    return {
      tag: 'payRequest',
      callback: `${origin}/z/cb/${lowered}`,
      minSendable: deps.minSendableMsat,
      maxSendable: deps.maxSendableMsat,
      metadata: metadataFor(lowered, host, deps.mintFeeLine, deps.feeInWords),
      allowsNostr: true,
      nostrPubkey: pubkey
      // Deliberately no withdrawLink: the preimage of this invoice is NOT
      // a note, and an LNURLcash wallet that paid this must not think it
      // is one.
    }
  }

  const callback = async (name: string, amountMsat: number, nostrParam: string | null): Promise<ZapCallbackResult> => {
    const lowered = name.toLowerCase()
    const recipient = config.names[lowered]
    if (!recipient) return {reason: 'Unknown user.'}
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) return {reason: 'Invalid amount.'}
    if (amountMsat < deps.minSendableMsat || amountMsat > deps.maxSendableMsat) return {reason: 'Amount out of range.'}
    const net = deps.netAfterMintFee(amountMsat)
    if (net < deps.minMintMsat) return {reason: 'Amount too small to mint a note.'}

    let zapRequest: string | null = null
    if (nostrParam !== null && nostrParam !== '') {
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
    // nothing to them. The note's secret is minted at settlement.
    const preimage = bytesToHex(randomBytes(32))
    const paymentHash = hashK1(preimage)
    let pr: string
    try {
      pr = (
        await backend.createInvoice({
          amountMsat,
          preimageHex: preimage,
          memo: `Zap ${lowered}@${host}`,
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
    store.recordZapInvoice({paymentHash, name: lowered, recipient, pr, grossMsat: amountMsat, netMsat: net, zapRequest})
    return {pr, ...(deps.verify ? {verify: `${origin}/verify/${paymentHash}`} : {})}
  }

  // The note as the recipient's wallet will paste it, wrapped to them.
  const buildWrap = (row: ZapInvoiceRow, k1: string): Event => {
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
    }
    const rumor: UnsignedEvent = {
      kind: NOTE_KIND,
      pubkey,
      created_at: Math.floor(now() / 1000),
      tags,
      content: `${origin}/w?k1=${k1}&amount=${row.netMsat}`
    }
    return wrapEvent(rumor, secret, row.recipient)
  }

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
      const k1 = bytesToHex(randomBytes(32))
      const noteId = hashK1(k1)
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

  const sweep = (nowMs: number = now()): number => {
    const stale: string[] = []
    for (const row of store.unsettledZapInvoices()) {
      const decoded = tryDecodeBolt11(row.pr)
      if (!decoded) continue
      if (nowMs > (decoded.timestamp + decoded.expirySeconds) * 1000 + 3_600_000) stale.push(row.paymentHash)
    }
    for (const hash of stale) store.deleteUnsettledZapInvoice(hash)
    return stale.length
  }

  return {pubkey, isZapName, payRequest, callback, settle, publish, sweep}
}
