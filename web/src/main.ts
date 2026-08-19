import './style.css'
import {animate, stagger, utils} from 'animejs'
import {renderSVG} from 'uqr'
import {
  applyMintFee,
  buildNoteUrl,
  fetchInvoiceVerification,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  grossUpForMintFee,
  formatFeePercent,
  noteK1,
  noteSignature,
  requestInvoice,
  resolveNoteInput,
  rotateNote,
  toBech32Lnurl,
  verifyNoteSignature,
  withNewK1,
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  type MintAddressInfo,
  type MintFee,
  type PayRequestInfo
} from 'lnurlcash-kit'
import {icons} from './icons.ts'

// The mint's own website: mint a note right here, check one, read the
// terms. Every protocol step goes through lnurlcash-kit against the same
// endpoints any wallet uses - the page IS a wallet-grade client, minus the
// storage. Nothing here is trusted state: it all comes from discovery.

type MintRuntime = {username: string; walletUrl?: string; sunset?: boolean; origin?: string}

const runtime: MintRuntime = (window as unknown as {__MINT__?: MintRuntime}).__MINT__ ?? {username: 'mint'}
// The dev server runs on vite's port; production serves this page from the
// mint itself, so the API is simply where the page came from.
const API = runtime.origin ?? (location.port === '5173' ? 'http://127.0.0.1:3737' : location.origin)
const HOST = new URL(API).host

const app = document.getElementById('app')!
let viewEpoch = 0

// discovery, loaded once at boot
let pay: PayRequestInfo | null = null
let addr: MintAddressInfo | null = null
let fee: MintFee | null = null

// ---------- tiny DOM + motion helpers ----------

const el = (html: string): HTMLElement => {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild as HTMLElement
}

const sats = (msat: number): string => {
  const whole = msat / 1000
  const text = Number.isInteger(whole) ? whole.toLocaleString('en-GB') : whole.toFixed(3)
  return text.replace(/,/g, ' ')
}

const toast = (message: string, kind: 'ok' | 'err' | '' = ''): void => {
  const node = el(`<div class="toast ${kind}"></div>`)
  node.textContent = message
  document.getElementById('toasts')!.append(node)
  animate(node, {opacity: [0, 1], y: [16, 0], duration: 320, ease: 'outCubic'})
  setTimeout(() => {
    animate(node, {opacity: 0, y: 10, duration: 280, ease: 'inCubic', onComplete: () => node.remove()})
  }, 3600)
}

const copyText = async (text: string, label: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${label} copied`, 'ok')
  } catch {
    toast('Copying is blocked here - long-press to copy instead.', 'err')
  }
}

const burst = (host: HTMLElement): void => {
  host.classList.add('burst-host')
  const sparks: HTMLElement[] = []
  for (let i = 0; i < 16; i++) {
    const spark = el('<i class="spark"></i>')
    spark.style.left = '50%'
    spark.style.top = '50%'
    host.append(spark)
    sparks.push(spark)
  }
  animate(sparks, {
    x: () => utils.random(-120, 120),
    y: () => utils.random(-100, 70),
    scale: [1, 0],
    opacity: [1, 0],
    duration: 850,
    delay: stagger(14),
    ease: 'outExpo',
    onComplete: () => sparks.forEach(spark => spark.remove())
  })
}

const countTo = (node: Element, msat: number): void => {
  const counter = {value: 0}
  animate(counter, {
    value: msat / 1000,
    duration: 900,
    ease: 'outExpo',
    onUpdate: () => (node.textContent = sats(Math.round(counter.value) * 1000))
  })
}

const show = (build: () => HTMLElement): void => {
  viewEpoch += 1
  app.replaceChildren(build())
  const view = app.firstElementChild as HTMLElement
  animate(view, {opacity: [0, 1], y: [14, 0], duration: 340, ease: 'outCubic'})
  const items = view.querySelectorAll('.tile, .step, .card, .result')
  if (items.length) {
    animate(items, {opacity: [0, 1], y: [18, 0], delay: stagger(50), duration: 380, ease: 'outCubic'})
  }
}

const busy = async <T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T | undefined> => {
  const label = button.innerHTML
  button.disabled = true
  button.innerHTML = `${icons.refresh} <span>Working…</span>`
  button.classList.add('pulse')
  try {
    return await work()
  } catch (err) {
    toast((err as Error).message || 'Something went wrong.', 'err')
    return undefined
  } finally {
    button.disabled = false
    button.classList.remove('pulse')
    button.innerHTML = label
  }
}

const topBar = (title: string, onBack: () => void): HTMLElement => {
  const bar = el(`<div class="top">
    <button class="btn-icon" data-back aria-label="Back">${icons.back}</button>
    <div class="brand">${title}</div>
    <span class="spacer"></span>
  </div>`)
  bar.querySelector('[data-back]')!.addEventListener('click', onBack)
  return bar
}

const qrCard = (text: string, href?: string): HTMLElement => {
  const card = el(
    href
      ? `<a class="qr" href="${href}" role="img" aria-label="QR code"></a>`
      : '<div class="qr" role="img" aria-label="QR code"></div>'
  )
  card.innerHTML = renderSVG(text, {border: 1})
  return card
}

// A bearer QR never flashes on screen from one careless tap: it sits
// blurred behind a cover until deliberately revealed.
const coveredQr = (text: string): HTMLElement => {
  const wrap = el('<div class="covered"></div>')
  const qr = qrCard(text)
  const cover = el(`<button class="cover">${icons.eye}<span>Tap to reveal</span><small>Anyone who sees this code can take the sats.</small></button>`)
  cover.addEventListener('click', () => {
    animate(cover, {opacity: 0, duration: 220, ease: 'outCubic', onComplete: () => cover.remove()})
    animate(qr, {filter: ['blur(14px)', 'blur(0px)'], scale: [0.98, 1], duration: 420, ease: 'outCubic'})
  })
  wrap.append(qr, cover)
  return wrap
}

// ---------- shared fee arithmetic ----------

const netFor = (grossMsat: number): number => (fee ? applyMintFee(grossMsat, fee) : grossMsat)
const grossFor = (netMsat: number): number => (fee ? grossUpForMintFee(netMsat, fee) : netMsat)

const feeLine = (): string => {
  if (!fee) return 'none - notes hold exactly what you pay'
  const parts: string[] = []
  if (fee.baseFeeMsat > 0) parts.push(`${sats(fee.baseFeeMsat)} sat flat`)
  if (fee.feePpm > 0) parts.push(`${formatFeePercent(fee.feePpm)}%`)
  return parts.join(' + ')
}

// ---------- boot ----------

const boot = async (): Promise<void> => {
  show(() => {
    const view = el(`<div class="view center" style="justify-content:center">
      <div class="hero"><span class="mark pulse">${icons.logo}</span><h1 class="skel" style="margin:14px auto 0;max-width:220px">.</h1></div>
    </div>`)
    return view
  })
  try {
    const [payInfo, addrInfo] = await Promise.all([
      fetchPayRequest(`${API}/.well-known/lnurlp/${runtime.username}`),
      fetchMintAddress(`${API}/.well-known/lnurlw/${runtime.username}`).catch(() => null)
    ])
    pay = payInfo
    addr = addrInfo
    fee = payInfo.mintFee ?? null
    if (addr?.nodeColor && /^#[0-9a-fA-F]{6}$/.test(addr.nodeColor)) {
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', addr.nodeColor)
    }
    viewHome()
  } catch (err) {
    show(() => {
      const view = el(`<div class="view center" style="justify-content:center">
        <div class="result bad">${icons.x}<b>The mint is not answering</b><p></p>
        <button class="btn">${icons.refresh}<span>Try again</span></button></div>
      </div>`)
      view.querySelector('p')!.textContent = (err as Error).message || 'Could not reach the mint.'
      view.querySelector('button')!.addEventListener('click', () => void boot())
      return view
    })
  }
}

// ---------- home ----------

const viewHome = (): void => {
  const address = `${runtime.username}@${HOST}`
  const lnurl = toBech32Lnurl(`${API}/.well-known/lnurlp/${runtime.username}`)
  show(() => {
    const view = el(`<div class="view">
      <div class="hero">
        <span class="mark">${icons.logo}</span>
        <h1>${addr?.nodeAlias ? esc(addr.nodeAlias) : 'moneyer'}</h1>
        <p class="sub">An LNURLcash mint. Pay a Lightning invoice and its payment preimage <em>is</em> your bearer note - <em>money as a secret you hold</em>.</p>
      </div>
      <button class="plate" data-copy-address>${icons.bolt}<span>${esc(address)}</span></button>
      ${runtime.sunset ? `<div class="badges"><span class="badge wait">${icons.hourglass}<span>sunsetting - existing notes redeem, new ones are not minted</span></span></div>` : ''}
      <div class="actions">
        <button class="tile" data-go-mint ${runtime.sunset ? 'disabled' : ''}>${icons.mint}<b>Mint a note</b><small>Pay an invoice, walk away with a bearer note</small></button>
        <button class="tile" data-go-check>${icons.search}<b>Check a note</b><small>Is it real, is it unspent, what is it worth</small></button>
      </div>
      <div class="stack" data-qr-slot></div>
      <button class="btn btn-ghost" data-show-qr>${icons.qr}<span>Show address QR</span></button>
      <div class="steps" data-steps>
        <div class="step"><span class="n">1</span><b>Pay the invoice</b><p>From any Lightning wallet. The mint writes your note's secret into the invoice itself.</p></div>
        <div class="step"><span class="n">2</span><b>The preimage is your note</b><p>Your wallet's payment receipt - the preimage - is the bearer secret. Whoever holds it, holds the money.</p></div>
        <div class="step"><span class="n">3</span><b>Spend it anywhere</b><p>Hand the note to anyone, split it, merge it, or melt it back onto Lightning. No account, ever.</p></div>
      </div>
      <div class="grid2" data-cards></div>
      <footer>
        <div class="luds">
          ${[
            ['01', 'https://github.com/lnurl/luds/blob/luds/01.md'],
            ['03', 'https://github.com/lnurl/luds/blob/luds/03.md'],
            ['06', 'https://github.com/lnurl/luds/blob/luds/06.md'],
            ['11', 'https://github.com/lnurl/luds/blob/luds/11.md'],
            ['16', 'https://github.com/lnurl/luds/blob/luds/16.md'],
            ['17', 'https://github.com/lnurl/luds/blob/luds/17.md'],
            ['21', 'https://github.com/lnurl/luds/blob/luds/21.md'],
            ['25', 'https://github.com/lnurl/luds/pull/301']
          ]
            .map(([n, href]) => `<a href="${href}" target="_blank" rel="noopener" title="LUD-${n}">LUD-${n}</a>`)
            .join('')}
        </div>
        <p>Independent implementation of the <a href="https://github.com/lnurl/luds/pull/301" target="_blank" rel="noopener">LNURLcash draft</a>, graded by <a href="https://github.com/TheCryptoDonkey/lnurlcash-conformance" target="_blank" rel="noopener">lnurlcash-conformance</a>.<br/>
        Source: <a href="https://github.com/forgesworn/moneyer" target="_blank" rel="noopener">forgesworn/moneyer</a> · wallet: <a href="https://github.com/forgesworn/notecase" target="_blank" rel="noopener">forgesworn/notecase</a></p>
      </footer>
    </div>`)

    view.querySelector('[data-copy-address]')!.addEventListener('click', () => void copyText(address, 'Lightning address'))
    view.querySelector('[data-go-mint]')!.addEventListener('click', () => viewMint())
    view.querySelector('[data-go-check]')!.addEventListener('click', () => viewCheck())

    const qrSlot = view.querySelector('[data-qr-slot]') as HTMLElement
    const qrButton = view.querySelector('[data-show-qr]') as HTMLButtonElement
    qrButton.addEventListener('click', () => {
      if (qrSlot.childElementCount) {
        qrSlot.replaceChildren()
        qrButton.innerHTML = `${icons.qr}<span>Show address QR</span>`
        return
      }
      const card = qrCard(lnurl.toUpperCase(), `lightning:${lnurl}`)
      qrSlot.append(card)
      animate(card, {opacity: [0, 1], scale: [0.94, 1], duration: 320, ease: 'outCubic'})
      qrButton.innerHTML = `${icons.qr}<span>Hide address QR</span>`
    })

    const cards = view.querySelector('[data-cards]') as HTMLElement
    cards.append(termsCard(), nodeCard())
    return view
  })
}

const esc = (value: string): string => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

const termsCard = (): HTMLElement => {
  const p = pay!
  const minNet = netFor(p.minSendable)
  const maxNet = netFor(p.maxSendable)
  const card = el(`<div class="card">
    <h3>${icons.scale.replace('aria-hidden="true"', 'aria-hidden="true" style="width:15px;height:15px;vertical-align:-2px"')} The terms</h3>
    <div class="kv"><span>mints</span><b>${sats(p.minSendable)} to ${sats(p.maxSendable)} sat</b></div>
    <div class="kv"><span>mint fee</span><b>${esc(feeLine())}</b></div>
    <div class="kv"><span>note values</span><b>${sats(minNet)} to ${sats(maxNet)} sat</b></div>
    ${addr?.nodePubkey ? `<div class="kv"><span>notes signed by</span><code>${esc(addr.nodePubkey)}</code></div>` : '<div class="kv"><span>note signatures</span><b>not offered</b></div>'}
    <div class="kv"><span>fee charged</span><b>once, at minting - mutations are free, merges refund</b></div>
  </div>`)
  return card
}

const nodeCard = (): HTMLElement => {
  const nodePubkey = addr?.nodeUri?.split('@')[0]
  const card = el(`<div class="card">
    <h3>The funding node</h3>
    ${addr?.nodeAlias ? `<div class="kv"><span>alias</span><b>${addr.nodeColor ? `<span class="dot" style="background:${esc(addr.nodeColor)}"></span>` : ''}${esc(addr.nodeAlias)}</b></div>` : ''}
    ${addr?.nodeCapacityMsat ? `<div class="kv"><span>capacity</span><b>${sats(addr.nodeCapacityMsat)} sat</b></div>` : ''}
    ${addr?.nodeNumChannels !== undefined ? `<div class="kv"><span>channels · peers</span><b>${addr.nodeNumChannels}${addr.nodeNumPeers !== undefined ? ` · ${addr.nodeNumPeers}` : ''}</b></div>` : ''}
    ${addr?.nodeUri ? `<div class="kv"><span>node URI</span><code>${esc(addr.nodeUri)}</code></div>` : ''}
    <div class="row" data-links></div>
  </div>`)
  const links = card.querySelector('[data-links]') as HTMLElement
  if (addr?.nodeUri) {
    const copyUri = el(`<button class="btn btn-ghost" style="min-height:48px">${icons.copy}<span>Copy URI</span></button>`)
    copyUri.addEventListener('click', () => void copyText(addr!.nodeUri!, 'Node URI'))
    links.append(copyUri)
  }
  if (nodePubkey && /^[0-9a-f]{66}$/i.test(nodePubkey)) {
    links.append(
      el(`<a class="btn btn-ghost" style="min-height:48px;text-decoration:none" href="https://mempool.space/lightning/node/${nodePubkey}" target="_blank" rel="noopener">${icons.external}<span>mempool</span></a>`),
      el(`<a class="btn btn-ghost" style="min-height:48px;text-decoration:none" href="https://amboss.space/node/${nodePubkey}" target="_blank" rel="noopener">${icons.external}<span>amboss</span></a>`)
    )
  }
  if (!links.childElementCount) links.remove()
  return card
}

// ---------- mint flow ----------

const viewMint = (): void => {
  const p = pay!
  const minNet = netFor(p.minSendable)
  const maxNet = netFor(p.maxSendable)
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Mint a note', viewHome))
    const body = el(`<div class="stack">
      <div class="field"><label>How much should the note hold?</label></div>
      <div class="amount-input"><input data-amount inputmode="numeric" pattern="[0-9]*" placeholder="0" autofocus /><span class="unit">sat</span></div>
      <div class="presets" data-presets></div>
      <p class="warn" data-feenote>&nbsp;</p>
      <button class="btn btn-silver" data-create>${icons.bolt}<span>Create the invoice</span></button>
      <p class="warn">Notes hold between ${sats(minNet)} and ${sats(maxNet)} sat here.</p>
    </div>`)
    view.append(body)

    const input = body.querySelector('[data-amount]') as HTMLInputElement
    const feeNote = body.querySelector('[data-feenote]') as HTMLElement

    const presetValues = [500_000, 1_000_000, 5_000_000, 21_000_000].filter(v => v >= minNet && v <= maxNet)
    const presets = body.querySelector('[data-presets]') as HTMLElement
    if (presetValues.length >= 2) {
      for (const value of presetValues) {
        const button = el(`<button>${sats(value)}</button>`)
        button.addEventListener('click', () => {
          input.value = String(value / 1000)
          paint()
        })
        presets.append(button)
      }
    } else {
      presets.remove()
    }

    const paint = (): void => {
      const net = Number(input.value) * 1000
      if (!Number.isSafeInteger(net) || net <= 0) {
        feeNote.innerHTML = fee ? `Mint fee: <strong>${esc(feeLine())}</strong>, charged once, now.` : 'No mint fee - you pay exactly what the note holds.'
        return
      }
      const gross = grossFor(net)
      feeNote.innerHTML = fee
        ? `You pay <strong>${sats(gross)} sat</strong> - the note holds ${sats(netFor(gross))} sat after the ${sats(gross - netFor(gross))} sat mint fee.`
        : `You pay exactly <strong>${sats(net)} sat</strong>.`
    }
    input.addEventListener('input', paint)
    paint()

    const create = body.querySelector('[data-create]') as HTMLButtonElement
    create.addEventListener('click', () =>
      busy(create, async () => {
        const net = Number(input.value) * 1000
        if (!Number.isSafeInteger(net) || net <= 0) throw new Error('Give an amount in whole sats.')
        if (net < minNet) throw new Error(`The smallest note here holds ${sats(minNet)} sat.`)
        if (net > maxNet) throw new Error(`The largest note here holds ${sats(maxNet)} sat.`)
        const gross = Math.min(Math.max(grossFor(net), p.minSendable), p.maxSendable)
        const invoice = await requestInvoice(p.callback, gross)
        if (!invoice.verify) {
          throw new Error('This mint offers no payment verification, so the page cannot claim the note for you.')
        }
        viewInvoice({pr: invoice.pr, verifyUrl: invoice.verify, grossMsat: gross})
      })
    )
    return view
  })
}

const viewInvoice = (args: {pr: string; verifyUrl: string; grossMsat: number}): void => {
  const epoch = viewEpoch + 1
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Pay to mint', viewHome))
    const body = el(`<div class="stack center">
      <div class="amount"><span>${sats(args.grossMsat)}</span><span class="unit">sat</span></div>
      <p class="warn">Pay this invoice from any Lightning wallet - tap the QR to open one on this device. Your note appears here the moment it settles.</p>
      <button class="btn" data-copy>${icons.copy}<span>Copy invoice</span></button>
      <button class="btn btn-ghost" data-check-now>${icons.refresh}<span>Checking payment…</span></button>
    </div>`)
    body.insertBefore(qrCard(args.pr.toUpperCase(), `lightning:${args.pr}`), body.querySelector('p'))
    view.append(body)

    body.querySelector('[data-copy]')!.addEventListener('click', () => void copyText(args.pr, 'Invoice'))

    // Countdown-on-the-button polling: the one control is both the status
    // indicator and the manual override. Guarded so a slow poll and the
    // next tick (or an impatient tap) can never claim twice - a second
    // rotate of the same preimage would read as "already spent" and bury
    // the freshly minted note under an error.
    const checkButton = body.querySelector('[data-check-now]') as HTMLButtonElement
    let seconds = 4
    let inFlightPoll = false
    let claimed = false
    let ticker: ReturnType<typeof setInterval> | undefined
    const poll = async (): Promise<void> => {
      if (inFlightPoll || claimed) return
      inFlightPoll = true
      checkButton.innerHTML = `${icons.refresh}<span>Checking…</span>`
      try {
        const result = await fetchInvoiceVerification(args.verifyUrl)
        if (viewEpoch !== epoch) return
        if (result.settled && result.preimage) {
          claimed = true
          if (ticker) clearInterval(ticker)
          await claimNote(result.preimage, args.grossMsat)
          return
        }
      } catch {
        // transient - the countdown keeps going
      } finally {
        inFlightPoll = false
      }
      seconds = 4
    }
    ticker = setInterval(() => {
      if (viewEpoch !== epoch) {
        clearInterval(ticker)
        return
      }
      if (inFlightPoll || claimed) return
      seconds -= 1
      if (seconds <= 0) void poll()
      else checkButton.innerHTML = `${icons.refresh}<span>Checking payment (${seconds}s)</span>`
    }, 1000)
    checkButton.addEventListener('click', () => void poll())
    return view
  })
}

// Claim, then immediately rotate: anyone who saw the unpaid invoice can
// poll verify and learn the preimage, so the note is only private once its
// secret is one this page generated. The rotate also yields a signature to
// verify against the mint's advertised key, live, in front of the user.
const claimNote = async (preimage: string, grossMsat: number): Promise<void> => {
  const netMsat = netFor(grossMsat)
  const rawUrl = buildNoteUrl(pay!.withdrawLink ?? `lnurlw://${HOST}/w`, preimage, netMsat)
  try {
    const info = await fetchNoteInfo(rawUrl)
    const rotated = await rotateNote(info.callback, preimage)
    const finalUrl = withNewK1(rawUrl, rotated.k1, info.maxWithdrawable, rotated.signature)
    const verified = Boolean(
      rotated.signature &&
        info.mintPubkey &&
        verifyNoteSignature(rotated.k1, info.maxWithdrawable, rotated.signature, info.mintPubkey)
    )
    viewNote({url: finalUrl, amountMsat: info.maxWithdrawable, verified, secured: true})
  } catch (err) {
    if (err instanceof AmbiguousMutationError) {
      // The rotate may or may not have landed. Probe; if that fails too,
      // hand over BOTH candidate secrets - one of them is the money.
      const carried = err.newSecrets[0]
      try {
        await fetchNoteInfo(rawUrl)
        viewNote({url: rawUrl, amountMsat: netMsat, verified: false, secured: false})
        return
      } catch (probeErr) {
        if ((probeErr instanceof NoteSpentError || probeErr instanceof NoteUnknownError) && carried) {
          viewNote({url: withNewK1(rawUrl, carried, netMsat), amountMsat: netMsat, verified: false, secured: true})
          return
        }
      }
      viewNote({
        url: rawUrl,
        amountMsat: netMsat,
        verified: false,
        secured: false,
        alsoUrl: carried ? withNewK1(rawUrl, carried, netMsat) : undefined
      })
      return
    }
    // Rotation failed cleanly - the original preimage is still the note.
    toast(`Could not re-secure the note here: ${(err as Error).message}`, 'err')
    viewNote({url: rawUrl, amountMsat: netMsat, verified: false, secured: false})
  }
}

const viewNote = (args: {url: string; amountMsat: number; verified: boolean; secured: boolean; alsoUrl?: string}): void => {
  const lnurl = toBech32Lnurl(args.url)
  const claimHref = runtime.walletUrl ? `${runtime.walletUrl}/#/claim?u=${encodeURIComponent(args.url)}` : null
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Your note', viewHome))
    const body = el(`<div class="stack center">
      <div class="burst-host" style="padding:6px 0 0">
        <div class="amount"><span data-value>0</span><span class="unit">sat</span></div>
      </div>
      <div class="badges">
        ${args.verified ? `<span class="badge good">${icons.shield}<span>signature verified</span></span>` : ''}
        ${args.secured ? `<span class="badge good">${icons.check}<span>freshly rotated - only you hold it</span></span>` : `<span class="badge wait">${icons.hourglass}<span>not re-secured - receive it into a wallet soon</span></span>`}
      </div>
      <p class="warn"><strong>This note is the money.</strong> Whoever sees it owns it - save it somewhere private, or open it in a wallet now.</p>
    </div>`)
    body.append(coveredQr(claimHref ?? lnurl.toUpperCase()))
    if (claimHref) {
      body.append(
        el(`<a class="btn btn-silver" style="text-decoration:none" href="${claimHref}">${icons.wallet}<span>Open in the wallet</span></a>`)
      )
    }
    const copyUrl = el(`<button class="btn">${icons.copy}<span>Copy note URL</span></button>`)
    copyUrl.addEventListener('click', () => void copyText(args.url, 'Note URL'))
    const copyLnurl = el(`<button class="btn btn-ghost">${icons.copy}<span>Copy LNURL</span></button>`)
    copyLnurl.addEventListener('click', () => void copyText(lnurl, 'LNURL'))
    body.append(copyUrl, copyLnurl)
    if (args.alsoUrl) {
      body.append(
        el(`<p class="warn"><strong>Keep both of these.</strong> A network hiccup hid which secret ended up holding the money - one of the two below is your note. A wallet's reconcile sorts it out.</p>`),
        el(`<div class="mono">${esc(args.url)}</div>`),
        el(`<div class="mono">${esc(args.alsoUrl)}</div>`)
      )
    }
    view.append(body)
    const valueEl = body.querySelector('[data-value]')!
    setTimeout(() => {
      countTo(valueEl, args.amountMsat)
      burst(body.querySelector('.burst-host')!)
    }, 300)
    return view
  })
}

// ---------- check flow ----------

const viewCheck = (): void => {
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Check a note', viewHome))
    const body = el(`<div class="stack">
      <div class="field">
        <label>Paste the note</label>
        <textarea data-input placeholder="lnurlw://… or LNURL1…" autocomplete="off" spellcheck="false"></textarea>
      </div>
      <button class="btn btn-ghost" data-paste>${icons.paste}<span>Paste from clipboard</span></button>
      <button class="btn btn-silver" data-check>${icons.search}<span>Check it</span></button>
      <div data-result></div>
      <p class="warn">Checking asks the mint what the note is worth and whether it is still live. It never spends, burns or alters the note - but it does show the mint (and this page) the secret, so rotate the note in a wallet afterwards if you go on holding it.</p>
    </div>`)
    view.append(body)

    const input = body.querySelector('[data-input]') as HTMLTextAreaElement
    body.querySelector('[data-paste]')!.addEventListener('click', async () => {
      input.value = await navigator.clipboard.readText().catch(() => input.value)
    })

    const resultSlot = body.querySelector('[data-result]') as HTMLElement
    const renderResult = (kind: 'good' | 'bad' | 'wait', icon: string, title: string, detail: string): HTMLElement => {
      const node = el(`<div class="result ${kind}">${icon}<b>${esc(title)}</b><p>${esc(detail)}</p></div>`)
      resultSlot.replaceChildren(node)
      animate(node, {opacity: [0, 1], scale: [0.96, 1], duration: 320, ease: 'outCubic'})
      return node
    }

    const check = body.querySelector('[data-check]') as HTMLButtonElement
    check.addEventListener('click', () =>
      busy(check, async () => {
        const url = resolveNoteInput(input.value.trim())
        if (!url) {
          renderResult('bad', icons.x, 'Not a bearer note', 'That does not decode to a note URL. A note looks like lnurlw://… with a k1 secret, or its LNURL1… encoding.')
          return
        }
        const noteHost = new URL(url).host
        try {
          const info = await fetchNoteInfo(url)
          const k1 = noteK1(url)!
          const signature = noteSignature(url)
          const verified = Boolean(
            signature && info.mintPubkey && verifyNoteSignature(k1, info.maxWithdrawable, signature, info.mintPubkey)
          )
          const node = renderResult(
            'good',
            icons.check,
            `Live: ${sats(info.maxWithdrawable)} sat`,
            noteHost === HOST
              ? 'This mint recognises the note and will honour it.'
              : `Recognised and honoured by ${noteHost}.`
          )
          const badges = el(`<div class="badges">
            ${verified ? `<span class="badge good">${icons.shield}<span>signature verified offline</span></span>` : ''}
            ${!verified && signature ? `<span class="badge wait">${icons.shield}<span>signature present but did not verify</span></span>` : ''}
            ${!signature ? `<span class="badge">${icons.shield}<span>carries no signature</span></span>` : ''}
          </div>`)
          node.append(badges)
          if (runtime.walletUrl) {
            node.append(
              el(`<a class="btn" style="text-decoration:none" href="${runtime.walletUrl}/#/claim?u=${encodeURIComponent(url)}">${icons.wallet}<span>Receive it into the wallet</span></a>`)
            )
          }
          burst(node)
        } catch (err) {
          if (err instanceof NoteSpentError) {
            renderResult('bad', icons.x, 'Already spent', 'The mint knows this note and reports it burned. Whatever it was worth has already been redeemed.')
          } else if (err instanceof NoteUnknownError) {
            renderResult('bad', icons.x, 'Unknown note', `${noteHost === HOST ? 'This mint' : noteHost} has never issued a note with this id. Either it was minted elsewhere, or it never existed.`)
          } else if (err instanceof PendingNoteError) {
            renderResult('wait', icons.hourglass, 'Locked mid-payment', 'A melt is in flight on this note. It resolves shortly - either spent, or restored untouched.')
          } else {
            renderResult('wait', icons.hourglass, 'Could not reach the mint', noteHost === HOST ? 'The mint did not answer. Try again shortly.' : `${noteHost} did not answer from this page - check it in a wallet instead.`)
          }
        }
      })
    )
    return view
  })
}

// ---------- go ----------

void boot()
