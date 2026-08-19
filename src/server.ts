import {createServer, type IncomingMessage, type ServerResponse} from 'node:http'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {applyMintFee, grossUpForMintFee, hashK1} from 'lnurlcash-kit'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import type {MoneyerConfig} from './config.ts'
import {NotePendingError, NoteStore, NoteUnavailableError, type NoteRow} from './store.ts'
import {createNoteSigner, type NoteSigner} from './signing.ts'
import {createFakeBackend} from './backends/fake.ts'
import {createClnBackend} from './backends/cln.ts'
import {createLndBackend} from './backends/lnd.ts'
import {PaymentPendingError, type LightningBackend, type NodeInfo} from './backends/types.ts'
import {reconcilePendingMelts, runMelt} from './melt.ts'
import {landingPage} from './landing.ts'
import {CONFIG_TOKEN, loadWebAssets, type WebAssets} from './web-assets.ts'

const HEX32 = /^[0-9a-f]{64}$/

export type Moneyer = {
  url: string
  port: number
  config: MoneyerConfig
  store: NoteStore
  backend: LightningBackend
  signer: NoteSigner | null
  reconcile: () => Promise<void>
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
}

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

  // Melt payment hashes with a live attempt in this process. Reconcile
  // skips these - see melt.ts.
  const inFlight = new Set<string>()

  const mintFeeMsat = (grossMsat: number): number =>
    config.mintFee ? grossMsat - applyMintFee(grossMsat, config.mintFee) : 0

  // What the mint advertises as its minimum must survive its own fee: a
  // payRequest whose minSendable nets below the dust floor invites a
  // payment it would then refuse.
  const effectiveMinSendableMsat = Math.max(
    config.minSendableMsat,
    config.mintFee ? grossUpForMintFee(config.minMintMsat, config.mintFee) : 0
  )

  // The routing-fee budget for a melt. LUD-25 has the mint fee cover the
  // eventual payout's routing cost, so the budget follows what this mint
  // actually charges, floored at 0.5%-or-5000msat so fee-free mints still
  // route.
  const meltFeeLimitMsat = (amountMsat: number): number =>
    Math.max(Math.round(amountMsat * 0.005), 5_000, mintFeeMsat(amountMsat))

  // A note whose id we do not know yet may be a settled mint invoice whose
  // claim simply has not been observed: settle it lazily against the
  // funding source, which is what makes paying an invoice mint the note.
  const resolveNote = async (k1: string): Promise<NoteRow | null> => {
    const id = hashK1(k1)
    const note = store.noteById(id)
    if (note) return note
    const invoice = store.mintInvoiceByHash(id)
    if (invoice && !invoice.settled && (await backend.isInvoiceSettled(id))) {
      store.settleMintInvoice(id)
      return store.noteById(id)
    }
    return null
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
        res.end(landingPage({config, host, mintPubkey: signer?.pubkey ?? null, nodeInfo}))
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

    // Every LNURL endpoint below is a GET. The method matters: /w/cb
    // mutates on whatever arrives, and an OPTIONS preflight or a stray
    // retry carrying the same query string must never burn a note.
    if (req.method !== 'GET') return fail('Not found.', 404)

    // ---- LUD-16 payRequest: paying this mints a note ----
    const lnurlpMatch = requestUrl.pathname.match(/^\/\.well-known\/lnurlp\/(.+)$/)
    if (lnurlpMatch) {
      if (!knownUser(lnurlpMatch[1]!)) return fail('Unknown user.', 404)
      const metadata: Array<[string, string]> = [
        ['text/plain', `Mint an LNURLcash bearer note at ${config.username}@${host}`],
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
        withdrawLink: `lnurlw://${host}/w`,
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
          ? applyMintFee(config.maxSendableMsat, config.mintFee)
          : config.maxSendableMsat,
        defaultDescription: config.description,
        payLink: `${origin}/.well-known/lnurlp/${lnurlwMatch[1]}`,
        ...(signer ? {mintPubkey: signer.pubkey} : {}),
        ...(nodeInfo.alias ? {nodeAlias: nodeInfo.alias} : {}),
        ...(nodeInfo.uri ? {nodeUri: nodeInfo.uri} : {}),
        ...(nodeInfo.color ? {nodeColor: nodeInfo.color} : {}),
        ...(nodeInfo.capacityMsat !== undefined ? {nodeCapacityMsat: nodeInfo.capacityMsat} : {}),
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
      const net = config.mintFee ? applyMintFee(amount, config.mintFee) : amount
      if (net < config.minMintMsat) return fail('Amount too small to mint a note.')

      // The preimage is the future note's spend secret; its hash is the
      // note id AND the invoice's payment hash. Generated here, handed to
      // the funding source, never persisted - the store keeps hashes only.
      let preimage = bytesToHex(randomBytes(32))
      let paymentHash = hashK1(preimage)
      while (store.noteById(paymentHash) || store.mintInvoiceByHash(paymentHash)) {
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
      store.recordMintInvoice(paymentHash, pr, amount, net)
      return send({
        pr,
        disposable: false,
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
      return fail('Unknown payment hash.')
    }

    // ---- LUD-03 informational GET ----
    if (requestUrl.pathname === '/w') {
      const k1 = q.get('k1')?.toLowerCase()
      if (!k1 || !HEX32.test(k1)) return fail('Unknown note.')
      const note = await resolveNote(k1)
      if (!note) return fail('Unknown note.')
      if (note.state === 'burned') return fail('Note already spent.')
      return send({
        tag: 'withdrawRequest',
        callback: `${origin}/w/cb`,
        k1,
        minWithdrawable: 0,
        maxWithdrawable: note.amountMsat,
        defaultDescription: config.description,
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
        if (decoded.amountMsats === null || decoded.amountMsats !== BigInt(totalMsat)) {
          return fail(`Invoice must be for exactly ${totalMsat} msat.`)
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
          store.swap(inputIds, [
            {id: h!, amountMsat: amount},
            {id: h2!, amountMsat: changeMsat}
          ])
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
        store.swap(inputIds, [{id: h!, amountMsat: mergedMsat}])
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

  // Resolve anything an earlier process left pending before serving new
  // melts against the same notes.
  await reconcilePendingMelts(store, backend, inFlight, log)

  // ...and keep resolving: a melt whose outcome stays unconfirmable would
  // otherwise park its note until the next restart. Five minutes is a
  // compromise between a holder's stuck funds and funding-source chatter;
  // unref'd so the timer never keeps the process alive.
  const reconcileTimer = setInterval(() => {
    reconcilePendingMelts(store, backend, inFlight, log).catch(err =>
      log(`reconcile failed: ${(err as Error).message}`)
    )
  }, 300_000)
  reconcileTimer.unref()

  return {
    url: `http://${config.host}:${port}`,
    port,
    config,
    store,
    backend,
    signer,
    reconcile: () => reconcilePendingMelts(store, backend, inFlight, log),
    close: async () => {
      clearInterval(reconcileTimer)
      await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
      await backend.close?.()
      store.close()
    }
  }
}
