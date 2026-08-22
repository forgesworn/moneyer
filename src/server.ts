import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {finalizeEvent} from 'nostr-tools/pure'
import {applyMintFee, grossUpForMintFee, hashK1} from 'lnurlcash-kit'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import type {MoneyerConfig} from './config.ts'
import {
  NotePendingError,
  NoteStore,
  NoteUnavailableError,
  OutputCollisionError,
  swapFingerprint,
  type NoteRow
} from './store.ts'
import {createNoteSigner, type NoteSigner} from './signing.ts'
import {createFakeBackend} from './backends/fake.ts'
import {createClnBackend} from './backends/cln.ts'
import {createLndBackend} from './backends/lnd.ts'
import {PaymentPendingError, type LightningBackend, type NodeInfo} from './backends/types.ts'
import {reconcilePendingMelts, runMelt} from './melt.ts'
import {landingPage} from './landing.ts'
import {packageVersion} from './version.ts'
import {createZapBridge, poolTransport, type NostrTransport, type ZapBridge} from './zap.ts'
import {STATS_D_TAG, STATS_KIND, buildStats, statsSnapshotContent, type MintStats} from './stats.ts'
import {isRefusal, registerName, validateNip98} from './names.ts'
import {CONFIG_TOKEN, loadWebAssets, type WebAssets} from './web-assets.ts'

const HEX32 = /^[0-9a-f]{64}$/

export type Moneyer = {
  url: string
  port: number
  config: MoneyerConfig
  store: NoteStore
  backend: LightningBackend
  signer: NoteSigner | null
  // Null unless zap-to-note is configured.
  zap: ZapBridge | null
  reconcile: () => Promise<void>
  // The current liabilities snapshot, cached for 30 seconds - the same
  // object /stats serves.
  stats: () => Promise<MintStats>
  // One signed snapshot to Nostr, if snapshots are configured. Runs
  // hourly on its own; exposed so a caller (and a test) can force a pass.
  publishStats: () => Promise<void>
  close: () => Promise<void>
}

export type MoneyerDeps = {
  backend?: LightningBackend
  store?: NoteStore
  log?: (message: string) => void
  // See melt.ts - tests shrink these.
  confirmDelaysMs?: number[]
  // The built website to serve at GET /. Omitted means load web/dist from
  // disk; null means serve the self-contained landing page instead.
  webAssets?: WebAssets | null
  // Relay access for zap-to-note. Omitted means a real relay pool.
  nostr?: NostrTransport
  // How often settled zap invoices are looked for. Tests shrink it.
  zapPollMs?: number
  // How often a signed liabilities snapshot is published. Tests shrink it.
  statsPublishMs?: number
}

// The one request body this mint reads. Capped hard: nothing here needs
// more than a name and a note, and an unbounded read on a public endpoint
// is a way to run a mint out of memory.
const MAX_BODY_BYTES = 8 * 1024

const readBody = async (req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | null> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// "fee 5 sat + 0.1%" - what a payer sees in their wallet's description.
export const describeFee = (fee: {baseFeeMsat: number; feePpm: number}, roundedToSat: boolean): string => {
  const parts: string[] = []
  if (fee.baseFeeMsat > 0) parts.push(`${fee.baseFeeMsat % 1000 === 0 ? fee.baseFeeMsat / 1000 : (fee.baseFeeMsat / 1000).toFixed(3)} sat`)
  if (fee.feePpm > 0) parts.push(`${(fee.feePpm / 10_000).toString()}%`)
  const base = parts.length ? `fee ${parts.join(' + ')}` : 'no fee'
  return roundedToSat && parts.length ? `${base}, rounded up to the sat` : base
}

// A note's value rounded down to a whole sat; unchanged when already whole.
const wholeSatFloor = (msat: number): number => Math.floor(msat / 1000) * 1000

const backendFor = (config: MoneyerConfig): LightningBackend => {
  switch (config.backend.kind) {
    case 'fake':
      return createFakeBackend()
    case 'cln':
      return createClnBackend(config.backend)
    case 'lnd':
      return createLndBackend(config.backend)
  }
}

export const createMoneyer = async (config: MoneyerConfig, deps: MoneyerDeps = {}): Promise<Moneyer> => {
  const log = deps.log ?? (() => {})
  const store = deps.store ?? new NoteStore(config.dbPath)
  const backend = deps.backend ?? backendFor(config)
  const signer = config.signingKey ? createNoteSigner(config.signingKey) : null
  const webAssets = deps.webAssets === undefined ? loadWebAssets() : deps.webAssets

  // Node identity for the discovery endpoint, fetched once, best-effort: a
  // funding source that cannot answer does not stop the mint serving.
  let nodeInfo: NodeInfo = {}
  try {
    nodeInfo = (await backend.nodeInfo?.()) ?? {}
  } catch {
    log('could not fetch funding-source node info - discovery will omit it')
  }

  // The operator's own lightning addresses, re-applied at every startup so
  // the environment and the table cannot disagree. Self-service names
  // live in the same table and are left alone.
  if (config.zap) {
    for (const [name, pubkey] of Object.entries(config.zap.names)) store.putOperatorZapName(name, pubkey)
  }

  // Melt payment hashes with a live attempt in this process. Reconcile
  // skips these - see melt.ts.
  const inFlight = new Set<string>()

  const mintFeeMsat = (grossMsat: number): number => {
    if (!config.mintFee) return 0
    const exact = grossMsat - applyMintFee(grossMsat, config.mintFee)
    // Both readings sit inside lnurlcash-kit's mintFeeBand, so a wallet
    // is not misled either way - it is told the range up front.
    return config.roundFeeToSat === true ? Math.ceil(exact / 1000) * 1000 : exact
  }

  // Every quote and every credit goes through here, so the fee posture
  // cannot drift between what is advertised and what is withheld.
  const netAfterMintFee = (grossMsat: number): number =>
    Math.max(0, grossMsat - mintFeeMsat(grossMsat))

  // What the mint advertises as its minimum must survive its own fee: a
  // payRequest whose minSendable nets below the dust floor invites a
  // payment it would then refuse. grossUpForMintFee inverts the exact
  // formula; with the fee rounded up to the sat the net can land just
  // under the floor, so walk up until it clears. At most a sat of steps.
  const effectiveMinSendableMsat = (() => {
    let min = Math.max(config.minSendableMsat, config.mintFee ? grossUpForMintFee(config.minMintMsat, config.mintFee) : 0)
    while (config.mintFee && netAfterMintFee(min) < config.minMintMsat) min += 1
    return min
  })()

  // The routing-fee budget for a melt. LUD-25 has the mint fee cover the
  // eventual payout's routing cost, so the budget follows what this mint
  // actually charges, floored at 0.5%-or-5000msat so fee-free mints still
  // route.
  const meltFeeLimitMsat = (amountMsat: number): number =>
    Math.max(Math.round(amountMsat * 0.005), 5_000, mintFeeMsat(amountMsat))

  const mintFeeLine = config.mintFee ? `Mint fees: ${config.mintFee.baseFeeMsat},${config.mintFee.feePpm}` : null
  // The same fee for a person: "Mint fees: 5000,1000" is for wallets that
  // parse LUD-25, and reads as nonsense to anyone who does not.
  const feeInWords = config.mintFee ? describeFee(config.mintFee, config.roundFeeToSat === true) : null
  const nostr = config.zap ? (deps.nostr ?? poolTransport()) : null
  const zap: ZapBridge | null =
    config.zap && nostr
      ? createZapBridge({
          config: config.zap,
          store,
          backend,
          transport: nostr,
          netAfterMintFee,
          minSendableMsat: effectiveMinSendableMsat,
          maxSendableMsat: config.maxSendableMsat,
          minMintMsat: config.minMintMsat,
          mintFeeLine,
          feeInWords,
          verify: config.verify,
          // configFromEnv guarantees this when zap is set; a caller
          // building the config by hand gets the same rule.
          origin: config.publicOrigin ?? (() => {
            throw new Error('Zap-to-note needs publicOrigin.')
          })(),
          log
        })
      : null

  // A note whose id we do not know yet may be a settled mint invoice whose
  // claim simply has not been observed: settle it lazily against the
  // funding source, which is what makes paying an invoice mint the note.
  const resolveNote = async (k1: string): Promise<NoteRow | null> => {
    const id = hashK1(k1)
    const note = store.noteById(id)
    if (note) return note
    // Either the invoice whose payment hash is this id - the older
    // arrangement, where the payment preimage is the spend secret - or the
    // invoice a payer bound to this id by naming it with `h`. In the bound
    // case the wallet needs nothing but its own secret to claim: no
    // /verify poll, no preimage, and so no window in which knowing the
    // invoice is knowing the money.
    const invoice = store.mintInvoiceByHash(id) ?? store.mintInvoiceByOutputId(id)
    if (invoice && !invoice.settled && (await backend.isInvoiceSettled(invoice.paymentHash))) {
      store.settleMintInvoice(invoice.paymentHash)
      // The note lands at the id its payer named. Looking it up by this id
      // finds it when that id IS the name, and finds nothing when this is
      // a bound invoice's payment hash - which is the point of binding.
      return store.noteById(id)
    }
    return null
  }

  // ---- transparency: what the mint owes, and what the node holds ----
  //
  // Cached for 30 seconds so a public endpoint cannot be turned into a
  // load generator against the funding source, and so the landing page
  // and /stats never disagree with each other by a request.
  let localBalanceMsat = nodeInfo.localBalanceMsat
  let reconciledAt: number | undefined
  let statsCache: {builtAt: number; value: MintStats} | null = null
  const currentStats = async (): Promise<MintStats> => {
    const now = Date.now()
    if (statsCache && now - statsCache.builtAt < 30_000) return statsCache.value
    try {
      // An answer that omits the balance is the funding source saying it
      // does not know, and coverage must disappear with it rather than be
      // computed against a stale number. A THROWN error is different: the
      // node is unreachable this minute, and the last known figure stands.
      const fresh = await backend.nodeInfo?.()
      if (fresh) localBalanceMsat = fresh.localBalanceMsat
    } catch {
      // unreachable - keep the last figure
    }
    const value = buildStats({
      liabilities: store.liabilities(now),
      localBalanceMsat,
      reconciledAt,
      at: now,
      ratioOnly: config.statsRatioOnly === true
    })
    statsCache = {builtAt: now, value}
    return value
  }

  // An hourly signed snapshot, so the coverage history can be checked
  // after the fact rather than taken on the operator's word for it today.
  // Signed with the NOTE key: a holder already trusts that key for their
  // own notes, so this adds nothing new to trust.
  const publishStats = async (): Promise<void> => {
    if (config.statsPublish !== true || !signer || !config.signingKey || !config.zap || !nostr) return
    const stats = await currentStats()
    const event = finalizeEvent(
      {
        kind: STATS_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', STATS_D_TAG]],
        content: statsSnapshotContent(stats, config.signingKey)
      },
      hexToBytes(config.zap.nostrKey)
    )
    const {ok, failed} = await nostr.publish(config.zap.relays, event)
    log(`liabilities snapshot published to ${ok.length} relay${ok.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} refused` : ''}`)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const q = requestUrl.searchParams
    const origin = config.publicOrigin ?? `http://${req.headers.host ?? '127.0.0.1'}`
    const host = new URL(origin).host

    const send = (body: unknown, status = 200): void => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'x-content-type-options': 'nosniff'
      })
      res.end(JSON.stringify(body))
    }
    const fail = (reason: string, status = 200): void => send({status: 'ERROR', reason}, status)

    const knownUser = (user: string): boolean => user === config.username || user === '_'

    // ---- the mint's face ----
    if (requestUrl.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (webAssets) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer'
        })
        // Runtime identity the static build cannot know. `<` is escaped so
        // no value can close the script element it is injected into.
        const injected = JSON.stringify({
          username: config.username,
          ...(config.walletUrl ? {walletUrl: config.walletUrl} : {}),
          ...(config.sunset ? {sunset: true} : {})
        }).replace(/</g, '\\u003c')
        res.end(webAssets.indexHtml.replace(CONFIG_TOKEN, `<script>window.__MINT__=${injected}</script>`))
      } else {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          // The fallback page is self-contained: inline style only, no
          // scripts, no external assets. The CSP says exactly that.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer'
        })
        res.end(
          landingPage({
            config,
            host,
            mintPubkey: signer?.pubkey ?? null,
            nodeInfo,
            stats: config.stats === false ? null : await currentStats()
          })
        )
      }
      return
    }
    if (webAssets && (req.method === 'GET' || req.method === 'HEAD')) {
      const asset = webAssets.get(requestUrl.pathname)
      if (asset) {
        res.writeHead(200, {
          'content-type': asset.type,
          'x-content-type-options': 'nosniff',
          'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300'
        })
        res.end(req.method === 'HEAD' ? undefined : asset.body)
        return
      }
    }

    // ---- claiming a lightning address ----
    //
    // This sits ABOVE the GET-only gate on purpose. That gate protects
    // the LNURL callbacks, where a retried GET carrying the same query
    // string must never burn a note twice; this is not one of them. It is
    // a POST because it creates something, and it is authenticated by
    // NIP-98 rather than by anything this mint has to store.
    if (requestUrl.pathname === '/names' && req.method === 'POST') {
      if (config.namePriceMsat === undefined) return fail('This mint is not registering names.', 404)
      const body = await readBody(req)
      if (body === null) return fail('Request body too large.', 413)
      const authorized = validateNip98(req.headers.authorization, {
        url: `${origin}${requestUrl.pathname}`,
        method: 'POST',
        body
      })
      if ('reason' in authorized) return fail(authorized.reason, 401)
      let parsed: {name?: unknown; note?: unknown}
      try {
        parsed = JSON.parse(body || '{}') as {name?: unknown; note?: unknown}
      } catch {
        return fail('Body must be JSON.', 400)
      }
      const result = registerName({
        store,
        // The NIP-98 signer owns the name. No other identity is accepted:
        // a pubkey in the body would let anyone register a name to
        // somebody else's key.
        pubkey: authorized.pubkey,
        body: parsed,
        priceMsat: config.namePriceMsat,
        reserved: [config.username],
        host
      })
      if (isRefusal(result)) return fail(result.reason, result.status)
      log(`name ${result.name} registered to ${result.pubkey.slice(0, 8)} for ${result.paidMsat} msat`)
      return send({
        status: 'OK',
        name: result.name,
        pubkey: result.pubkey,
        address: `${result.name}@${host}`,
        priceMsat: config.namePriceMsat,
        paidMsat: result.paidMsat
      })
    }

    // Every LNURL endpoint below is a GET. The method matters: /w/cb
    // mutates on whatever arrives, and an OPTIONS preflight or a stray
    // retry carrying the same query string must never burn a note.
    if (req.method !== 'GET') return fail('Not found.', 404)

    // ---- NIP-05 ----
    // The same table, so a registered name resolves both as a lightning
    // address and as a Nostr address. Only the name asked for is
    // answered: the list of everyone here is not something to hand out.
    if (requestUrl.pathname === '/.well-known/nostr.json') {
      const wanted = q.get('name')?.toLowerCase()
      const entry = wanted ? store.zapName(wanted) : null
      return send({names: entry ? {[entry.name]: entry.pubkey} : {}})
    }

    // ---- machine-readable operating figures ----
    // The OpenMetrics text format, for a scraper. Off unless asked for,
    // and deliberately unauthenticated: the deployment notes restrict the
    // path at the reverse proxy, which is where that decision belongs.
    if (requestUrl.pathname === '/metrics') {
      if (config.metrics !== true) return fail('Not found.', 404)
      const liabilities = store.liabilities()
      const totals = store.totals()
      // The balance rides along with the /stats cache rather than hitting
      // the funding source on every scrape.
      const snapshot = await currentStats()
      const lines: string[] = []
      const metric = (name: string, help: string, type: 'gauge' | 'counter', samples: Array<[string, number]>): void => {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
        for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`)
      }
      metric('moneyer_outstanding_msat', 'Value of every note this mint still owes.', 'gauge', [['', liabilities.outstandingMsat]])
      metric('moneyer_outstanding_notes', 'Number of notes this mint still owes.', 'gauge', [['', liabilities.outstandingNotes]])
      metric('moneyer_pending_melts', 'Melts reserved against a note and not yet resolved.', 'gauge', [['', liabilities.pendingMelts]])
      metric('moneyer_oldest_pending_melt_seconds', 'Age of the oldest unresolved melt.', 'gauge', [
        ['', liabilities.oldestPendingMeltAgeSecs]
      ])
      if (snapshot.localBalanceMsat !== undefined) {
        metric('moneyer_local_balance_msat', 'Outbound balance reported by the funding source.', 'gauge', [
          ['', snapshot.localBalanceMsat]
        ])
      }
      metric('moneyer_unsettled_mint_invoices', 'Mint invoices issued and not yet paid.', 'gauge', [
        ['', totals.unsettledMintInvoices]
      ])
      metric('moneyer_mints_total', 'Notes minted from a settled invoice.', 'counter', [['', totals.mints]])
      metric('moneyer_melts_total', 'Melts by outcome.', 'counter', [
        ['{outcome="paid"}', totals.melts.paid],
        ['{outcome="restored"}', totals.melts.restored],
        ['{outcome="pending"}', totals.melts.pending]
      ])
      metric('moneyer_zaps_total', 'Zaps that settled into a note.', 'counter', [['', totals.zaps]])
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'x-content-type-options': 'nosniff'
      })
      res.end(`${lines.join('\n')}\n`)
      return
    }

    // ---- what the mint owes ----
    // Public by design, and never per-note: a mint that will not say its
    // liabilities is asking for trust it has not earned, but a mint that
    // listed its notes would be handing out an oracle.
    if (requestUrl.pathname === '/stats') {
      if (config.stats === false) return fail('Not found.', 404)
      return send(await currentStats())
    }

    // ---- Zap-to-note: a name that pays out as a note over Nostr ----
    const lnurlpMatch = requestUrl.pathname.match(/^\/\.well-known\/lnurlp\/(.+)$/)
    if (lnurlpMatch && zap && zap.isZapName(lnurlpMatch[1]!)) {
      return send(zap.payRequest(lnurlpMatch[1]!))
    }
    const zapCbMatch = requestUrl.pathname.match(/^\/z\/cb\/(.+)$/)
    if (zapCbMatch) {
      if (!zap || !zap.isZapName(zapCbMatch[1]!)) return fail('Unknown user.', 404)
      if (config.sunset) return fail('This mint is sunsetting - minting is disabled.')
      const result = await zap.callback(zapCbMatch[1]!, Number(q.get('amount')), q.get('nostr'))
      if ('reason' in result) return fail(result.reason)
      return send({...result, disposable: false})
    }

    // ---- LUD-16 payRequest: paying this mints a note ----
    if (lnurlpMatch) {
      if (!knownUser(lnurlpMatch[1]!)) return fail('Unknown user.', 404)
      const metadata: Array<[string, string]> = [
        ['text/plain', `Mint an LNURLcash bearer note at ${config.username}@${host}${feeInWords ? ` (${feeInWords})` : ''}`],
        ['text/identifier', `${lnurlpMatch[1]}@${host}`]
      ]
      if (config.mintFee) {
        metadata.push(['text/plain', `Mint fees: ${config.mintFee.baseFeeMsat},${config.mintFee.feePpm}`])
      }
      return send({
        tag: 'payRequest',
        callback: `${origin}/p/cb`,
        minSendable: effectiveMinSendableMsat,
        maxSendable: config.maxSendableMsat,
        metadata: JSON.stringify(metadata),
        // The plain URL, as lnurl-mint emits and the LUD-25 diagram shows.
        // LUD-17's lnurlw:// is the scheme a wallet puts on a QR, not a
        // field in a JSON body; every other URL here is directly fetchable.
        withdrawLink: `${origin}/w`,
        // This mint takes `h` on the callback below, so a wallet can name
        // the note it is buying. Advertised here as well as on the
        // discovery document because a wallet handed nothing but a
        // lightning address never reads that document, and this has to be
        // known BEFORE paying, not after.
        mintToHash: true,
        disposable: false
      })
    }

    // ---- LUD-25 mint address discovery (experimental) ----
    const lnurlwMatch = requestUrl.pathname.match(/^\/\.well-known\/lnurlw\/(.+)$/)
    if (lnurlwMatch) {
      if (!knownUser(lnurlwMatch[1]!)) return fail('Unknown user.', 404)
      return send({
        tag: 'withdrawRequest',
        callback: `${origin}/w`,
        minWithdrawable: config.minMintMsat,
        maxWithdrawable: config.mintFee
          ? netAfterMintFee(config.maxSendableMsat)
          : config.maxSendableMsat,
        defaultDescription: config.description,
        payLink: `${origin}/.well-known/lnurlp/${lnurlwMatch[1]}`,
        ...(signer ? {mintPubkey: signer.pubkey} : {}),
        // The human layer: who runs this, how to reach them, the terms,
        // and today's message. Absent unless the operator set it.
        ...(config.name ? {name: config.name} : {}),
        description: config.description,
        ...(config.contact ? {contact: config.contact} : {}),
        ...(config.tosUrl ? {tosUrl: config.tosUrl} : {}),
        ...(config.motd ? {motd: config.motd} : {}),
        // The structured twin of the payRequest metadata's fee prose. Both
        // stay: one is for a wallet that parses LUD-25, the other for a
        // wallet that only reads a payRequest.
        ...(config.mintFee ? {fees: config.mintFee} : {}),
        ...(packageVersion ? {version: packageVersion} : {}),
        // What a lightning address at this mint costs, when anyone can
        // claim one. Absent means registration is closed.
        ...(config.namePriceMsat !== undefined ? {namePriceMsat: config.namePriceMsat} : {}),
        // Keys this mint has signed under before, so a wallet pinned to an
        // old one can tell a legitimate rotation from an impostor. Always
        // present, empty included: "never rotated" and "does not
        // implement the field" are different answers.
        previousPubkeys: config.previousSigningPubkeys ?? [],
        // This mint accepts `h` on the pay callback: the payer's wallet may
        // name the note it is buying, and then the payment preimage is not
        // a spend secret for it. A wallet learns this before it asks for an
        // invoice rather than after it has paid one.
        mintToHash: true,
        ...(nodeInfo.alias ? {nodeAlias: nodeInfo.alias} : {}),
        ...(nodeInfo.uri ? {nodeUri: nodeInfo.uri} : {}),
        ...(nodeInfo.color ? {nodeColor: nodeInfo.color} : {}),
        // nodeCapacity is the name the reference mint, the conformance
        // mock and lnurlcash-kit all use; nodeCapacityMsat was ours alone
        // and only survived a round trip through the kit's rest-spread.
        // Both go out for one release, then the old name goes.
        ...(nodeInfo.capacityMsat !== undefined
          ? {nodeCapacity: nodeInfo.capacityMsat, nodeCapacityMsat: nodeInfo.capacityMsat}
          : {}),
        ...(nodeInfo.numChannels !== undefined ? {nodeNumChannels: nodeInfo.numChannels} : {}),
        ...(nodeInfo.numPeers !== undefined ? {nodeNumPeers: nodeInfo.numPeers} : {})
      })
    }

    // ---- LUD-06 pay callback: issue a mint invoice ----
    if (requestUrl.pathname === '/p/cb') {
      if (config.sunset) return fail('This mint is sunsetting - minting is disabled.')
      const amount = Number(q.get('amount'))
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('Invalid amount.')
      if (amount < effectiveMinSendableMsat || amount > config.maxSendableMsat) {
        return fail('Amount out of range.')
      }
      const net = netAfterMintFee(amount)
      if (net < config.minMintMsat) return fail('Amount too small to mint a note.')

      // ---- naming the note being bought ----
      //
      // Optionally the payer's wallet chooses the note's spend secret
      // itself and sends `h`, the sha256 of it, exactly as `h` means on
      // the withdraw callback. The mint then credits the note at `h` on
      // settlement, and the invoice's payment preimage buys nothing.
      //
      // That matters because a payment preimage is not a secret between
      // two parties. It is known to the funding source, it is known to
      // every node that forwarded the payment, and /verify hands it to
      // anyone who can name the payment hash - which is written inside the
      // invoice itself, on the QR the payer was shown. Where the preimage
      // is the money, holding the invoice is nearly holding the money, and
      // the wallet's only defence is to claim and rotate faster than
      // anybody else. Naming the note removes the race instead of running
      // it: the buyer is the only party who ever knew the secret.
      //
      // Both checks happen before an invoice exists, so a wallet is never
      // left holding a quote the mint was always going to refuse. A
      // collision gets the same reason a colliding output gets on the
      // withdraw callback: which table an id already sits in is an oracle
      // nobody is owed.
      const askedOutputId = q.get('h')
      const outputId = askedOutputId === null ? null : askedOutputId.toLowerCase()
      if (outputId !== null) {
        if (!HEX32.test(outputId)) return fail('missing h')
        if (store.outputIdInUse(outputId)) return fail('Invalid or already spent k1.')
      }

      // The preimage is the future note's spend secret unless `h` named
      // one; its hash is the invoice's payment hash either way. Generated
      // here, handed to the funding source, never persisted - the store
      // keeps hashes only.
      let preimage = bytesToHex(randomBytes(32))
      let paymentHash = hashK1(preimage)
      while (store.outputIdInUse(paymentHash) || paymentHash === outputId) {
        preimage = bytesToHex(randomBytes(32))
        paymentHash = hashK1(preimage)
      }

      let pr: string
      try {
        pr = (
          await backend.createInvoice({
            amountMsat: amount,
            preimageHex: preimage,
            memo: `LNURLcash mint at ${host}`
          })
        ).pr
      } catch (err) {
        log(`create invoice failed: ${(err as Error).message}`)
        return fail('Temporarily unable to issue an invoice.')
      }
      // Trust but verify: an invoice that does not commit to OUR payment
      // hash would take the payer's money and mint a note they can never
      // claim. Refuse to hand it out.
      const decoded = tryDecodeBolt11(pr)
      if (!decoded || decoded.paymentHashHex !== paymentHash || decoded.amountMsats !== BigInt(amount)) {
        log('funding source returned an invoice that does not match the requested preimage/amount')
        return fail('Temporarily unable to issue an invoice.')
      }
      try {
        store.recordMintInvoice(paymentHash, pr, amount, net, outputId)
      } catch (err) {
        // The read above already refused the collisions it could see; this
        // closes the race where another request claimed the id in between.
        // The invoice exists at the funding source but has been shown to
        // nobody, so nothing can be paid against it.
        if (err instanceof OutputCollisionError) return fail('Invalid or already spent k1.')
        throw err
      }
      return send({
        pr,
        disposable: false,
        // Confirmation that this invoice really is bound to the id the
        // wallet named. A mint that ignored an unknown parameter would
        // answer without it, and a wallet can tell the two apart before
        // paying rather than by looking for a note afterwards.
        ...(outputId !== null ? {mintToHash: true} : {}),
        ...(config.verify ? {verify: `${origin}/verify/${paymentHash}`} : {})
      })
    }

    // ---- LUD-21 verify: mint invoices and melt payments ----
    const verifyMatch = requestUrl.pathname.match(/^\/verify\/([0-9a-fA-F]{64})$/)
    if (verifyMatch) {
      if (!config.verify) return fail('Not found.', 404)
      const paymentHash = verifyMatch[1]!.toLowerCase()
      const invoice = store.mintInvoiceByHash(paymentHash)
      if (invoice) {
        if (!invoice.settled && (await backend.isInvoiceSettled(paymentHash))) {
          store.settleMintInvoice(paymentHash)
        }
        const settled = store.mintInvoiceByHash(paymentHash)!.settled
        // The preimage IS the bearer secret. Served only once settled, and
        // fetched live from the funding source - it is never stored here.
        const preimageHex = settled ? await backend.invoicePreimage(paymentHash) : null
        return send({status: 'OK', settled, preimage: preimageHex, pr: invoice.pr})
      }
      const melt = store.meltByHash(paymentHash)
      if (melt) {
        const settled = melt.outcome === 'paid'
        const preimageHex = settled ? await backend.paymentPreimage(paymentHash) : null
        return send({status: 'OK', settled, preimage: preimageHex, pr: melt.pr})
      }
      // A zap invoice's preimage is a throwaway the payer already holds,
      // so serving it is LUD-21 as written and leaks nothing: the note's
      // secret is a different value, sealed to the recipient.
      const zapInvoice = store.zapInvoiceByHash(paymentHash)
      if (zapInvoice) {
        const settled = zapInvoice.settled || (await backend.isInvoiceSettled(paymentHash))
        const preimageHex = settled ? await backend.invoicePreimage(paymentHash) : null
        return send({status: 'OK', settled, preimage: preimageHex, pr: zapInvoice.pr})
      }
      return fail('Unknown payment hash.')
    }

    // ---- LUD-03 informational GET ----
    if (requestUrl.pathname === '/w') {
      const k1 = q.get('k1')?.toLowerCase()
      if (!k1 || !HEX32.test(k1)) return fail('Unknown note.')
      const note = await resolveNote(k1)
      if (!note) return fail('Unknown note.')
      if (note.state === 'burned') return fail('Note already spent.')
      // maxWithdrawable states the note's value, as the reference does.
      // minWithdrawable is that value floored to a whole sat: most Lightning
      // wallets can only invoice whole sats, and a note of 94.9 sat that
      // insists on exactly 94,900 msat cannot be withdrawn by any of them.
      // The sub-sat remainder of such a melt is dust the mint keeps.
      return send({
        tag: 'withdrawRequest',
        callback: `${origin}/w/cb`,
        k1,
        minWithdrawable: wholeSatFloor(note.amountMsat),
        maxWithdrawable: note.amountMsat,
        defaultDescription: config.description,
        // The way home. A payRequest advertises `withdrawLink`; this is the
        // other direction, so a holder who has nothing but a note can still
        // find the document that publishes this mint's terms and its retired
        // signing keys. Without it a wallet that only ever received notes
        // cannot tell an announced key rotation from a substituted key.
        payLink: `${origin}/.well-known/lnurlp/${config.username}`,
        ...(signer ? {mintPubkey: signer.pubkey} : {})
      })
    }

    // ---- the mutating callback: melt / rotate / split / merge ----
    if (requestUrl.pathname === '/w/cb') {
      const k1s = q.getAll('k1').map(value => value.toLowerCase())
      const pr = q.get('pr')
      const amountRaw = q.get('amount')
      const h = q.get('h')?.toLowerCase()
      const h2 = q.get('h2')?.toLowerCase()

      if (k1s.length === 0) return fail('Missing k1.')
      if (k1s.length > config.maxK1s) return fail(`Too many k1s (max ${config.maxK1s}).`)
      if (pr && (k1s.length > 1 || amountRaw !== null)) {
        return fail('pr cannot be combined with multiple k1s or amount - merge or split first.')
      }
      // Hash parameters are checked before any note resolves, so an
      // invalid or missing hash can never burn anything.
      if (!pr) {
        if (!h || !HEX32.test(h)) return fail('missing h')
        if (amountRaw !== null && (!h2 || !HEX32.test(h2))) return fail('missing h2')
        if (h2 !== undefined && h2 === h) return fail('h and h2 must differ.')
      }
      if (config.sunset && amountRaw !== null) {
        return fail('This mint is sunsetting - splitting is disabled.')
      }
      // A repeated k1 would count one note's value twice on the way into a
      // merge or split. Atomic refusal, same as an invalid one.
      if (new Set(k1s).size !== k1s.length) return fail('Invalid or already spent k1.')

      // ---- the retried mutation ----
      //
      // A rotate, split or merge is a GET, and transports retry GETs.
      // Go's net/http retries one that failed on a reused idle
      // connection; the JDK's HttpClient retries idempotent methods with
      // no switch to turn it off. The retry is byte-identical and arrives
      // after the inputs are burned, so the honest-looking answer -
      // "already spent" - tells a wallet to drop the only copy of a
      // secret this mint really did mint a note against.
      //
      // So a request that already minted its outputs is answered with the
      // same reply. This branch burns nothing, mints nothing and moves no
      // balance: it is a read. The signature is deterministic over the
      // output id and its amount, so it is recomputed rather than stored.
      // Anything else naming a burned input is a double-spend attempt and
      // still gets today's reason string, unchanged.
      // Every k1 has to be hex before it can be hashed into a
      // fingerprint; a malformed one falls through to the loop below and
      // gets the same refusal it always did.
      const fingerprint = pr !== null || !k1s.every(k1 => HEX32.test(k1))
        ? null
        : swapFingerprint({
            inputIds: k1s.map(hashK1),
            h: h!,
            h2,
            ...(amountRaw !== null ? {amountMsat: Number(amountRaw)} : {})
          })
      const alreadyMinted = fingerprint === null ? null : store.swapByFingerprint(fingerprint)
      if (alreadyMinted) {
        const first = alreadyMinted.find(output => output.id === h)
        const second = h2 === undefined ? undefined : alreadyMinted.find(output => output.id === h2)
        if (first) {
          return send({
            status: 'OK',
            ...(signer
              ? {
                  sig: signer.sign(first.id, first.amountMsat),
                  ...(second ? {sig2: signer.sign(second.id, second.amountMsat)} : {})
                }
              : {})
          })
        }
      }

      const found: NoteRow[] = []
      for (const k1 of k1s) {
        if (!HEX32.test(k1)) return fail('Invalid or already spent k1.')
        const note = await resolveNote(k1)
        if (!note || note.state === 'burned') return fail('Invalid or already spent k1.')
        if (note.state === 'pending') return fail('pending')
        found.push(note)
      }
      const totalMsat = found.reduce((sum, note) => sum + note.amountMsat, 0)
      const inputIds = found.map(note => note.id)

      // melt
      if (pr) {
        const decoded = tryDecodeBolt11(pr.trim())
        if (!decoded) return fail('Invalid invoice.')
        // Exactly the notes' value, or the whole-sat floor of it when the
        // value is not a whole sat (see the informational GET above). Never
        // less than the floor: that would let a holder leave real value on
        // the table by accident, and never more.
        const floorMsat = wholeSatFloor(totalMsat)
        if (decoded.amountMsats === null || decoded.amountMsats > BigInt(totalMsat) || decoded.amountMsats < BigInt(floorMsat)) {
          return fail(
            floorMsat === totalMsat
              ? `Invoice must be for exactly ${totalMsat} msat.`
              : `Invoice must be for ${totalMsat} msat, or ${floorMsat} msat (the whole-sat floor).`
          )
        }
        const paymentHash = decoded.paymentHashHex
        // Paying an invoice this mint itself issued would route the funding
        // source's money back at itself; refuse synchronously.
        if (store.mintInvoiceByHash(paymentHash)) {
          return fail('Cannot melt into an invoice this mint issued itself.')
        }
        // The funding source dedupes payments by hash, so a second melt
        // into the same invoice would be "confirmed" against the first
        // payment and burn its note without moving funds.
        if (store.meltByHash(paymentHash)) {
          return fail('Invoice already used by an earlier melt - use a fresh one.')
        }
        // A shared funding source is a supported deployment (DEPLOY.md),
        // and the node's payment history is the only dedupe that spans
        // every consumer of it. A hash the node ever paid - or is still
        // paying - is refused here for the same reason as the local check
        // above; runMelt's PaymentAlreadyKnownError branch closes the
        // remaining race between this check and the send.
        try {
          if (await backend.isPaymentComplete(paymentHash)) {
            return fail('Invoice already used by an earlier melt - use a fresh one.')
          }
        } catch (err) {
          if (err instanceof PaymentPendingError) {
            return fail('Invoice already used by an earlier melt - use a fresh one.')
          }
          log(`melt pre-check failed: ${(err as Error).message}`)
          return fail('Temporarily unable to melt - try again shortly.')
        }
        try {
          store.markPending(inputIds[0]!, paymentHash, pr.trim(), totalMsat)
        } catch (err) {
          if (err instanceof NotePendingError) return fail('pending')
          if (err instanceof NoteUnavailableError) return fail('Invalid or already spent k1.')
          return fail('Invoice already used by an earlier melt - use a fresh one.')
        }
        inFlight.add(paymentHash)
        void runMelt(
          {paymentHash, noteId: inputIds[0]!, pr: pr.trim(), amountMsat: totalMsat},
          {store, backend, feeLimitMsat: meltFeeLimitMsat, log, ...(deps.confirmDelaysMs ? {confirmDelaysMs: deps.confirmDelaysMs} : {})}
        )
          .catch(err => log(`melt ${inputIds[0]}: ${(err as Error).message}`))
          .finally(() => inFlight.delete(paymentHash))
        // Replied before the payment resolves, per LUD-03: OK means the
        // melt is requested and the note reserved, never that it settled.
        return send({
          status: 'OK',
          ...(config.verify ? {pr: pr.trim(), verify: `${origin}/verify/${paymentHash}`} : {})
        })
      }

      const baseFeeMsat = config.mintFee?.baseFeeMsat ?? 0

      // split
      if (amountRaw !== null) {
        const amount = Number(amountRaw)
        if (!Number.isSafeInteger(amount) || amount <= 0) return fail('Invalid amount.')
        // Change must stay positive: an exact-total split is a rotate, and
        // a zero note is a liability entry nobody can ever want.
        if (amount >= totalMsat) return fail('Invalid amount.')
        // LUD-25: the flat base fee comes out of CHANGE on every split -
        // never out of the requested amount - so a holder cannot dodge
        // per-melt costs by splitting into dust and melting each piece.
        // The proportional part is never reapplied; it was withheld once,
        // at mint time.
        const changeBeforeFeeMsat = totalMsat - amount
        if (changeBeforeFeeMsat < baseFeeMsat) return fail('insufficient value')
        const changeMsat = changeBeforeFeeMsat - baseFeeMsat
        if (changeMsat < 1) return fail('insufficient value')
        try {
          store.swap(
            inputIds,
            [
              {id: h!, amountMsat: amount},
              {id: h2!, amountMsat: changeMsat}
            ],
            fingerprint ?? undefined
          )
        } catch (err) {
          if (err instanceof NotePendingError) return fail('pending')
          // OutputCollisionError shares the dead-k1 reason on purpose:
          // which table the id collided with is an oracle nobody is owed.
          return fail('Invalid or already spent k1.')
        }
        return send({
          status: 'OK',
          ...(signer ? {sig: signer.sign(h!, amount), sig2: signer.sign(h2!, changeMsat)} : {})
        })
      }

      // rotate (one k1) or merge (several) - the same swap either way.
      // LUD-25: a merge of n notes refunds (n - 1) base fees, since this
      // mint now faces one eventual melt instead of n. A rotate is a merge
      // of one - the refund is exactly 0.
      const mergedMsat = totalMsat + (inputIds.length - 1) * baseFeeMsat
      try {
        store.swap(inputIds, [{id: h!, amountMsat: mergedMsat}], fingerprint ?? undefined)
      } catch (err) {
        if (err instanceof NotePendingError) return fail('pending')
        // same oracle-free reason for a collision as for a dead k1
        return fail('Invalid or already spent k1.')
      }
      return send({status: 'OK', ...(signer ? {sig: signer.sign(h!, mergedMsat)} : {})})
    }

    return fail('Not found.', 404)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(err => {
      log(`internal error: ${(err as Error).stack ?? err}`)
      if (!res.headersSent) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'x-content-type-options': 'nosniff'
        })
      }
      if (!res.writableEnded) res.end(JSON.stringify({status: 'ERROR', reason: 'Internal error.'}))
    })
  })

  await new Promise<void>(resolve => server.listen(config.port, config.host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port

  // Housekeeping, at startup and every five minutes after: resolve melts an
  // earlier process left pending, and sweep mint invoices whose bolt11
  // expiry has passed. A melt whose outcome stays unconfirmable would
  // otherwise park its note until the next restart; an unswept table would
  // otherwise grow by one dead row per /p/cb call forever. The timer is
  // unref'd so it never keeps the process alive.
  const housekeeping = async (): Promise<void> => {
    const swept = sweepExpiredMintInvoices(store) + (zap?.sweep() ?? 0)
    if (swept > 0) log(`swept ${swept} expired mint invoice${swept === 1 ? '' : 's'}`)
    await reconcilePendingMelts(store, backend, inFlight, log)
    reconciledAt = Date.now()
  }
  await housekeeping()
  const housekeepingTimer = setInterval(() => {
    housekeeping().catch(err => log(`housekeeping failed: ${(err as Error).message}`))
  }, 300_000)
  housekeepingTimer.unref()

  // A zap settles on the funding source's clock, not ours, so look often.
  // One pass at a time: a slow relay must not stack passes.
  let zapPass: Promise<void> | null = null
  const zapTick = (): Promise<void> => {
    if (!zap) return Promise.resolve()
    if (zapPass) return zapPass
    zapPass = (async () => {
      try {
        await zap.settle()
        await zap.publish()
      } catch (err) {
        log(`zap pass failed: ${(err as Error).message}`)
      } finally {
        zapPass = null
      }
    })()
    return zapPass
  }
  const zapTimer = zap ? setInterval(() => void zapTick(), deps.zapPollMs ?? 5_000) : null
  zapTimer?.unref()

  const statsTimer =
    config.statsPublish === true && signer && config.zap
      ? setInterval(() => {
          publishStats().catch(err => log(`liabilities snapshot failed: ${(err as Error).message}`))
        }, deps.statsPublishMs ?? 3_600_000)
      : null
  statsTimer?.unref()

  return {
    url: `http://${config.host}:${port}`,
    port,
    config,
    store,
    backend,
    signer,
    zap,
    reconcile: async () => {
      await reconcilePendingMelts(store, backend, inFlight, log)
      reconciledAt = Date.now()
      await zapTick()
    },
    stats: currentStats,
    publishStats,
    close: async () => {
      clearInterval(housekeepingTimer)
      if (zapTimer) clearInterval(zapTimer)
      if (statsTimer) clearInterval(statsTimer)
      nostr?.close()
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
      await backend.close?.()
      store.close()
    }
  }
}

// Deletes unsettled mint invoices whose bolt11 expiry is comfortably past,
// returning the count swept. The invoice's own timestamp + expiry are the
// proof - a funding source refuses to settle an expired invoice, so the
// row can never mint a note again. The hour's margin keeps the delete
// unambiguously behind every implementation's reading of that expiry, and
// an undecodable invoice is kept: no proof, no delete. The delete itself is
// conditional on the row still being unsettled, so a settle racing the
// sweep always wins.
export const sweepExpiredMintInvoices = (store: NoteStore, nowMs: number = Date.now()): number => {
  const stale: string[] = []
  for (const invoice of store.unsettledMintInvoices()) {
    const decoded = tryDecodeBolt11(invoice.pr)
    if (!decoded) continue
    const expiresAtMs = (decoded.timestamp + decoded.expirySeconds) * 1000
    if (nowMs > expiresAtMs + 3_600_000) stale.push(invoice.paymentHash)
  }
  for (const paymentHash of stale) store.deleteUnsettledMintInvoice(paymentHash)
  return stale.length
}
