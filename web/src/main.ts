import '@fontsource/cinzel/400.css'
import '@fontsource/cinzel/700.css'
import '@fontsource/spectral/400.css'
import '@fontsource/spectral/400-italic.css'
import '@fontsource/spectral/500-italic.css'
import '@fontsource/spectral/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './style.css'
import {animate, stagger, svg as animeSvg, utils} from 'animejs'
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
  hashK1,
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
import {rosette} from './guilloche.ts'
import {banknote} from './banknote.ts'

// The mint's own website: mint a note right here, check one, read the
// terms. Every protocol step goes through lnurlcash-kit against the same
// endpoints any wallet uses - the page IS a wallet-grade client, minus the
// storage. Set like a banknote, because that is what it strikes.

type MintRuntime = {username: string; walletUrl?: string; sunset?: boolean; origin?: string}

// The mint-info fields moneyer publishes on top of what lnurlcash-kit
// types today. The kit passes unknown fields through untouched, so they
// arrive whether or not its own type has caught up; every one is optional
// and a mint that publishes none of them renders exactly as before.
type MintInfo = MintAddressInfo & {
  name?: string
  description?: string
  contact?: {nostr?: string; email?: string; url?: string}
  tosUrl?: string
  motd?: string
  fees?: {baseFeeMsat: number; feePpm: number}
  version?: string
  previousPubkeys?: string[]
  nodeCapacity?: number
}

const runtime: MintRuntime = (window as unknown as {__MINT__?: MintRuntime}).__MINT__ ?? {username: 'mint'}
// The dev server runs on vite's port; production serves this page from the
// mint itself, so the API is simply where the page came from.
const API = runtime.origin ?? (location.port === '5173' ? 'http://127.0.0.1:3737' : location.origin)
const HOST = new URL(API).host

const app = document.getElementById('app')!
let viewEpoch = 0

// discovery, loaded once at boot
let pay: PayRequestInfo | null = null
let addr: MintInfo | null = null
let fee: MintFee | null = null

// ---------- tiny DOM + motion helpers ----------

const el = (html: string): HTMLElement => {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild as HTMLElement
}

const esc = (value: string): string => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

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
  for (let i = 0; i < 18; i++) {
    const spark = el('<i class="spark"></i>')
    spark.style.left = '50%'
    spark.style.top = '40%'
    host.append(spark)
    sparks.push(spark)
  }
  animate(sparks, {
    x: () => utils.random(-150, 150),
    y: () => utils.random(-120, 90),
    scale: [1, 0],
    opacity: [1, 0],
    duration: 900,
    delay: stagger(12),
    ease: 'outExpo',
    onComplete: () => sparks.forEach(spark => spark.remove())
  })
}

const countTo = (node: Element, msat: number): void => {
  const counter = {value: 0}
  animate(counter, {
    value: msat / 1000,
    duration: 1100,
    ease: 'outExpo',
    onUpdate: () => (node.textContent = sats(Math.round(counter.value) * 1000))
  })
}

// The lathe turns: engine-turned rings draw themselves on.
const drawOn = (host: Element, duration = 1600): void => {
  const paths = host.querySelectorAll('path')
  if (!paths.length) return
  try {
    const drawables = animeSvg.createDrawable(paths)
    animate(drawables, {draw: ['0 0', '0 1'], duration, delay: stagger(90), ease: 'inOutQuad'})
  } catch {
    // an environment without real SVG geometry (tests) just shows it drawn
  }
}

// A verdict arrives the way verdicts do: stamped.
const stampIn = (node: HTMLElement): void => {
  animate(node, {
    scale: [2.2, 1],
    opacity: [0, 1],
    rotate: ['-2deg', node.style.getPropertyValue('--tilt') || '-6deg'],
    duration: 480,
    ease: 'outBack(2.2)'
  })
  if (navigator.vibrate) navigator.vibrate(20)
}

const letterSettle = (node: HTMLElement): void => {
  const text = node.textContent ?? ''
  node.textContent = ''
  const letters = [...text].map(char => {
    const span = el(`<b style="display:inline-block">${char === ' ' ? '&nbsp;' : esc(char)}</b>`)
    node.append(span)
    return span
  })
  animate(letters, {
    opacity: [0, 1],
    y: [14, 0],
    delay: stagger(55, {start: 120}),
    duration: 500,
    ease: 'outCubic'
  })
}

const show = (build: () => HTMLElement): void => {
  viewEpoch += 1
  app.replaceChildren(build())
  const view = app.firstElementChild as HTMLElement
  animate(view, {opacity: [0, 1], y: [10, 0], duration: 320, ease: 'outCubic'})
  const items = view.querySelectorAll('.tile, .step, .kv, .result')
  if (items.length) {
    animate(items, {opacity: [0, 1], y: [14, 0], delay: stagger(40), duration: 360, ease: 'outCubic'})
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

// The reveal is a scratch card. The silver series hides its secret under
// actual scratch silver: an opaque painted foil the holder rubs away with
// a finger, flakes falling, until enough is gone and the rest dissolves
// into sparks, the foil glint and the seal. A secret that must be
// scratched for can never flash from a careless tap - and it is a small
// ceremony of ownership. Keyboard: Enter reveals at once.

const paintFoil = (canvas: HTMLCanvasElement): void => {
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  const dpr = Math.min(window.devicePixelRatio || 1, 3)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d', {willReadFrequently: true})
  if (!ctx) return
  ctx.scale(dpr, dpr)

  // the metal: a diagonal silver gradient
  const metal = ctx.createLinearGradient(0, 0, w, h)
  for (const [stop, colour] of [
    [0, '#cfd4db'],
    [0.22, '#eef1f5'],
    [0.42, '#a7b0bc'],
    [0.58, '#dfe3e9'],
    [0.78, '#98a1ad'],
    [1, '#d5dae1']
  ] as Array<[number, string]>) {
    metal.addColorStop(stop, colour)
  }
  ctx.fillStyle = metal
  ctx.fillRect(0, 0, w, h)

  // brushed grain
  for (let i = 0; i < 900; i++) {
    const light = Math.random() > 0.5
    ctx.fillStyle = light ? `rgba(255,255,255,${Math.random() * 0.1})` : `rgba(40,46,54,${Math.random() * 0.07})`
    ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 10, 1)
  }
  // a sheen band
  ctx.fillStyle = 'rgba(255,255,255,0.14)'
  ctx.beginPath()
  ctx.moveTo(w * 0.15, 0)
  ctx.lineTo(w * 0.38, 0)
  ctx.lineTo(w * 0.12, h)
  ctx.lineTo(-w * 0.1, h)
  ctx.closePath()
  ctx.fill()

  // embossed instruction
  const size = Math.max(11, w * 0.055)
  ctx.textAlign = 'center'
  ctx.font = `600 ${size}px 'IBM Plex Mono', monospace`
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.fillText('SCRATCH TO REVEAL', w / 2, h / 2 + 1)
  ctx.fillStyle = 'rgba(44,50,58,0.72)'
  ctx.fillText('SCRATCH TO REVEAL', w / 2, h / 2)
  ctx.font = `500 ${Math.max(8.5, w * 0.032)}px 'IBM Plex Mono', monospace`
  ctx.fillStyle = 'rgba(44,50,58,0.6)'
  ctx.fillText('THE CODE BENEATH IS THE MONEY', w / 2, h / 2 + size * 1.5)

  // hairline frame
  ctx.strokeStyle = 'rgba(44,50,58,0.4)'
  ctx.lineWidth = 1
  ctx.strokeRect(3.5, 3.5, w - 7, h - 7)

  // the CSS gradient only covered the pre-paint frame; from here the
  // bitmap is the foil, and scratching must open onto the code beneath
  canvas.style.background = 'none'
}

// A silver flake spins off the scrub point.
const flake = (host: HTMLElement, x: number, y: number): void => {
  const bit = el('<i class="foil-flake" aria-hidden="true"></i>')
  bit.style.left = `${x}px`
  bit.style.top = `${y}px`
  host.append(bit)
  animate(bit, {
    x: utils.random(-22, 22),
    y: utils.random(18, 60),
    rotate: `${utils.random(-200, 200)}deg`,
    opacity: [1, 0],
    duration: utils.random(400, 750),
    ease: 'inQuad',
    onComplete: () => bit.remove()
  })
}

// The last of the foil dissolves: sparks, the glint, the seal, the serial.
const finale = (root: HTMLElement, canvas: HTMLCanvasElement): void => {
  if (navigator.vibrate) navigator.vibrate([12, 30, 20])
  animate(canvas, {
    opacity: [1, 0],
    scale: [1, 1.05],
    duration: 380,
    ease: 'outCubic',
    onComplete: () => canvas.remove()
  })
  const qr = root.querySelector('.covered .qr') as HTMLElement | null
  if (qr) animate(qr, {scale: [0.985, 1.02, 1], duration: 480, ease: 'outBack(1.6)'})
  const panel = root.querySelector('.nb-panel') as HTMLElement | null
  burst(panel ?? root)
  const seal = root.querySelector('.nb-seal') as HTMLElement | null
  if (seal) {
    animate(seal, {scale: [1.9, 1], opacity: [0, 0.8], rotate: ['-6deg', '8deg'], duration: 520, delay: 260, ease: 'outBack(2)'})
  }
  const serial = root.querySelector('.nb-serial') as HTMLElement | null
  if (serial) animate(serial, {opacity: [0, 1], y: [4, 0], duration: 420, delay: 380, ease: 'outCubic'})
  setTimeout(() => {
    root.classList.add('glint')
    setTimeout(() => root.classList.remove('glint'), 1500)
  }, 320)
}

const wireCover = (root: HTMLElement): void => {
  const canvas = root.querySelector('canvas.scratch-foil') as HTMLCanvasElement | null
  if (!canvas) return
  const covered = canvas.parentElement as HTMLElement
  let revealed = false
  let painted = false
  let strokes = 0
  let lastX = 0
  let lastY = 0
  let scrubbing = false

  // paint once the layout has given the canvas its real size
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (!painted && canvas.clientWidth > 0) {
        painted = true
        paintFoil(canvas)
        observer.disconnect()
      }
    })
    observer.observe(canvas)
  } else {
    paintFoil(canvas)
  }

  const reveal = (): void => {
    if (revealed) return
    revealed = true
    finale(root, canvas)
  }

  const clearedEnough = (): boolean => {
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    if (!ctx || !canvas.width) return false
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let clear = 0
    let total = 0
    // sample every 23rd pixel - plenty for a fraction
    for (let i = 3; i < data.length; i += 4 * 23) {
      total++
      if (data[i]! < 40) clear++
    }
    return total > 0 && clear / total > 0.45
  }

  const scrub = (x: number, y: number): void => {
    const ctx = canvas.getContext('2d', {willReadFrequently: true})
    if (!ctx) return
    const dpr = canvas.width / canvas.clientWidth
    const radius = Math.max(16, canvas.clientWidth * 0.09)
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineWidth = radius
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(lastX, lastY)
    ctx.lineTo(x, y)
    ctx.stroke()
    ctx.restore()
    strokes++
    if (strokes % 4 === 0) flake(covered, x, y)
    if (navigator.vibrate && strokes % 7 === 0) navigator.vibrate(4)
    if (strokes % 10 === 0 && clearedEnough()) reveal()
  }

  const local = (event: PointerEvent): {x: number; y: number} => {
    const rect = canvas.getBoundingClientRect()
    return {x: event.clientX - rect.left, y: event.clientY - rect.top}
  }

  canvas.addEventListener('pointerdown', event => {
    if (revealed) return
    event.preventDefault()
    canvas.setPointerCapture(event.pointerId)
    scrubbing = true
    const {x, y} = local(event)
    lastX = x
    lastY = y
    scrub(x, y)
  })
  canvas.addEventListener('pointermove', event => {
    if (!scrubbing || revealed) return
    const {x, y} = local(event)
    scrub(x, y)
    lastX = x
    lastY = y
  })
  for (const eventName of ['pointerup', 'pointercancel'] as const) {
    canvas.addEventListener(eventName, () => {
      scrubbing = false
      if (!revealed && clearedEnough()) reveal()
    })
  }
  // keyboard: reveal at once - nobody scratches with a spacebar
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      reveal()
    }
  })
}

// ---------- shared fee arithmetic ----------

const netFor = (grossMsat: number): number => (fee ? applyMintFee(grossMsat, fee) : grossMsat)
// Rounded up to a whole sat: nobody should be asked to pay 211.211 sat.
// The extra fraction lands in the note, never in the fee.
const grossFor = (netMsat: number): number =>
  fee ? Math.ceil(grossUpForMintFee(netMsat, fee) / 1000) * 1000 : netMsat

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
      <div class="hero"><span class="mark pulse">${rosette(120)}</span></div>
    </div>`)
    return view
  })
  try {
    const [payInfo, addrInfo] = await Promise.all([
      fetchPayRequest(`${API}/.well-known/lnurlp/${runtime.username}`),
      fetchMintAddress(`${API}/.well-known/lnurlw/${runtime.username}`).catch(() => null)
    ])
    pay = payInfo
    addr = addrInfo as MintInfo | null
    fee = payInfo.mintFee ?? null
    if (addr?.nodeColor && /^#[0-9a-fA-F]{6}$/.test(addr.nodeColor)) {
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', addr.nodeColor)
    }
    // A proofing press for the live note's print, no invoice needed: the
    // secret is a constant, so this is never a spendable note.
    if (location.hash === '#/proof') {
      // Six hundred billion sats: a denomination absurd enough that nobody
      // mistakes the proofing press for money.
      viewNote({
        url: buildNoteUrl(payInfo.withdrawLink ?? `${API}/w`, '11'.repeat(32), 600_000_000_000_000),
        amountMsat: 600_000_000_000_000,
        verified: true,
        secured: true
      })
      return
    }
    viewHome()
  } catch (err) {
    show(() => {
      const view = el(`<div class="view center" style="justify-content:center">
        <div class="result bad"><span class="stamp" style="--tilt:-6deg">Held</span><b>The mint is not answering</b><p></p>
        <p class="pulse" style="color:var(--dim);font-size:13px;font-style:italic">retrying on its own…</p>
        <button class="btn">${icons.refresh}<span>Try again now</span></button></div>
      </div>`)
      view.querySelector('p')!.textContent = (err as Error).message || 'Could not reach the mint.'
      view.querySelector('button')!.addEventListener('click', () => void boot())
      stampIn(view.querySelector('.stamp') as HTMLElement)
      return view
    })
    // A front page heals itself: one flaky moment on the visitor's path
    // must not leave a dead screen waiting for a human.
    const epoch = viewEpoch
    setTimeout(() => {
      if (viewEpoch === epoch) void boot()
    }, 6000)
  }
}

// ---------- home ----------

const LUDS: Array<[string, string]> = [
  ['01', 'https://github.com/lnurl/luds/blob/luds/01.md'],
  ['03', 'https://github.com/lnurl/luds/blob/luds/03.md'],
  ['06', 'https://github.com/lnurl/luds/blob/luds/06.md'],
  ['11', 'https://github.com/lnurl/luds/blob/luds/11.md'],
  ['16', 'https://github.com/lnurl/luds/blob/luds/16.md'],
  ['17', 'https://github.com/lnurl/luds/blob/luds/17.md'],
  ['21', 'https://github.com/lnurl/luds/blob/luds/21.md'],
  ['25', 'https://github.com/lnurl/luds/pull/301']
]

const viewHome = (): void => {
  const address = `${runtime.username}@${HOST}`
  const lnurl = toBech32Lnurl(`${API}/.well-known/lnurlp/${runtime.username}`)
  show(() => {
    const view = el(`<div class="view">
      <header class="masthead">
        <h1 class="wordmark" data-wordmark>${esc((addr?.name ?? 'MONEYER').toUpperCase())}</h1>
        <div class="tagline">An LNURLcash mint · strikes Lightning bearer notes</div>
      </header>
      <div class="hero">
        <span class="medallion"><span class="mark" data-rosette>${rosette(176)}</span></span>
        <p class="promise">Pay a Lightning invoice, and its payment preimage <em>is</em> your note - <em>money as a secret you hold</em>.</p>
        <div class="fineline">No account · no custodian's ledger · whoever holds the string holds the money</div>
      </div>
      ${addr?.motd ? `<div class="notice"><b>notice</b>${esc(addr.motd)}</div>` : ''}
      <button class="plate" data-copy-address>${icons.bolt}<span>${esc(address)}</span></button>
      ${runtime.sunset ? `<div class="badges"><span class="badge wait">${icons.hourglass}<span>sunsetting - existing notes redeem, new ones are not struck</span></span></div>` : ''}
      <div class="actions">
        <button class="tile" data-go-mint ${runtime.sunset ? 'disabled' : ''}>${icons.mint}<b>Mint a note</b><small>Pay an invoice, walk away with a bearer note</small></button>
        <button class="tile" data-go-check>${icons.search}<b>Check a note</b><small>Is it real, is it unspent, what is it worth</small></button>
      </div>
      <div class="stack" data-qr-slot></div>
      <button class="btn btn-ghost" data-show-qr>${icons.qr}<span>Show address QR</span></button>
      <div class="rubric">The note</div>
      <div data-specimen></div>
      <p class="warn">Every note this mint strikes is a 32-byte secret. This is what one looks like when a wallet prints it - yours arrives with a live QR where the specimen mark sits.</p>
      <div class="rubric">How it works</div>
      <div class="steps" data-steps>
        <div class="step"><span class="n">I</span><b>Pay the invoice</b><p>From any Lightning wallet. The mint writes your note's secret into the invoice itself.</p></div>
        <div class="step"><span class="n">II</span><b>The preimage is the note</b><p>Your wallet's payment receipt - the preimage - is the bearer secret. Whoever holds it, holds the money.</p></div>
        <div class="step"><span class="n">III</span><b>Spend it anywhere</b><p>Hand it to anyone, split it, merge it, or melt it back onto Lightning. No account, ever.</p></div>
      </div>
      <div class="grid2" data-cards></div>
      <footer>
        <div class="microprint">${Array(8).fill('MONEYER · PAYS THE BEARER ON DEMAND · LNURLCASH · NOT LEGAL TENDER · ').join('')}</div>
        <div class="luds">${LUDS.map(([n, href]) => `<a href="${href}" target="_blank" rel="noopener" title="LUD-${n}">LUD-${n}</a>`).join('')}</div>
        <p>An independent implementation of the <a href="https://github.com/lnurl/luds/pull/301" target="_blank" rel="noopener">LNURLcash draft</a>, graded by <a href="https://github.com/TheCryptoDonkey/lnurlcash-conformance" target="_blank" rel="noopener">lnurlcash-conformance</a>.<br/>
        Source: <a href="https://github.com/forgesworn/moneyer" target="_blank" rel="noopener">forgesworn/moneyer</a> · a companion wallet: <a href="https://github.com/forgesworn/notecase" target="_blank" rel="noopener">forgesworn/notecase</a></p>
      </footer>
    </div>`)

    view.querySelector('[data-copy-address]')!.addEventListener('click', () => void copyText(address, 'Lightning address'))
    view.querySelector('[data-go-mint]')!.addEventListener('click', () => viewMint())
    view.querySelector('[data-go-check]')!.addEventListener('click', () => viewCheck())

    // the specimen note, stamped as such
    const specimen = banknote({
      sats: 21,
      serialHex: 'b0171f0000000000000000000000000000000000000000000000000000000011fd',
      host: HOST.toUpperCase(),
      variant: {kind: 'specimen'}
    })
    view.querySelector('[data-specimen]')!.append(specimen)

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

    // motion: the wordmark settles, the lathe turns the rosette on, and
    // the SPECIMEN overstamp lands once the note scrolls into view
    letterSettle(view.querySelector('[data-wordmark]') as HTMLElement)
    drawOn(view.querySelector('[data-rosette]')!)
    const overstamps = [...specimen.querySelectorAll('.nb-overstamp')] as HTMLElement[]
    if (overstamps.length && 'IntersectionObserver' in window) {
      overstamps.forEach(stamp => (stamp.style.opacity = '0'))
      const seen = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          seen.disconnect()
          for (const stamp of overstamps) {
            stamp.style.removeProperty('opacity')
            animate(stamp, {scale: [2.4, 1], opacity: [0, 0.3], rotate: ['-4deg', '-14deg'], duration: 520, ease: 'outBack(2)'})
          }
        }
      }, {threshold: 0.4})
      seen.observe(specimen)
    }
    return view
  })
}

const termsCard = (): HTMLElement => {
  const p = pay!
  const minNet = netFor(p.minSendable)
  const maxNet = netFor(p.maxSendable)
  return el(`<div class="card">
    <h3>Schedule of terms</h3>
    <div class="kv"><span>mints</span><b>${sats(p.minSendable)} to ${sats(p.maxSendable)} sat</b></div>
    <div class="kv"><span>mint fee</span><b>${esc(feeLine())}</b></div>
    <div class="kv"><span>note values</span><b>${sats(minNet)} to ${sats(maxNet)} sat</b></div>
    <div class="kv"><span>the fee falls</span><b>once, at the striking - mutations free, merges refund</b></div>
    ${addr?.nodePubkey ? `<div class="kv"><span>notes signed by</span><code>${esc(addr.nodePubkey)}</code></div>` : '<div class="kv"><span>note signatures</span><b>not offered</b></div>'}
    ${addr?.contact?.email ? `<div class="kv"><span>email</span><code>${esc(addr.contact.email)}</code></div>` : ''}
    ${addr?.contact?.nostr ? `<div class="kv"><span>nostr</span><code>${esc(addr.contact.nostr)}</code></div>` : ''}
    ${addr?.contact?.url ? `<div class="kv"><span>contact</span><a href="${esc(addr.contact.url)}" target="_blank" rel="noopener">${esc(addr.contact.url)}</a></div>` : ''}
    ${addr?.tosUrl ? `<div class="kv"><span>terms</span><a href="${esc(addr.tosUrl)}" target="_blank" rel="noopener">${esc(addr.tosUrl)}</a></div>` : ''}
    ${addr?.version ? `<div class="kv"><span>software</span><b>moneyer ${esc(addr.version)}</b></div>` : ''}
  </div>`)
}

const nodeCard = (): HTMLElement => {
  const nodePubkey = addr?.nodeUri?.split('@')[0]
  // nodeCapacity is the field name the reference mint and the mock use;
  // nodeCapacityMsat is what moneyer emitted before 0.2.0 and still emits
  // alongside it for one release. Both are milli-satoshis.
  const capacityMsat = addr?.nodeCapacity ?? addr?.nodeCapacityMsat
  const card = el(`<div class="card">
    <h3>The funding node</h3>
    ${addr?.nodeAlias ? `<div class="kv"><span>alias</span><b>${addr.nodeColor ? `<span class="dot" style="background:${esc(addr.nodeColor)}"></span>` : ''}${esc(addr.nodeAlias)}</b></div>` : ''}
    ${capacityMsat ? `<div class="kv"><span>capacity</span><b>${sats(capacityMsat)} sat</b></div>` : ''}
    ${addr?.nodeNumChannels !== undefined ? `<div class="kv"><span>channels · peers</span><b>${addr.nodeNumChannels}${addr.nodeNumPeers !== undefined ? ` · ${addr.nodeNumPeers}` : ''}</b></div>` : ''}
    ${addr?.nodeUri ? `<div class="kv"><span>node URI</span><code>${esc(addr.nodeUri)}</code></div>` : ''}
    <div class="row" data-links></div>
  </div>`)
  const links = card.querySelector('[data-links]') as HTMLElement
  if (addr?.nodeUri) {
    const copyUri = el(`<button class="btn btn-ghost" style="min-height:46px">${icons.copy}<span>Copy URI</span></button>`)
    copyUri.addEventListener('click', () => void copyText(addr!.nodeUri!, 'Node URI'))
    links.append(copyUri)
  }
  if (nodePubkey && /^[0-9a-f]{66}$/i.test(nodePubkey)) {
    links.append(
      el(`<a class="btn btn-ghost" style="min-height:46px;text-decoration:none" href="https://mempool.space/lightning/node/${nodePubkey}" target="_blank" rel="noopener">${icons.external}<span>mempool</span></a>`),
      el(`<a class="btn btn-ghost" style="min-height:46px;text-decoration:none" href="https://amboss.space/node/${nodePubkey}" target="_blank" rel="noopener">${icons.external}<span>amboss</span></a>`)
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
      <div class="rubric">To be struck</div>
      <div class="amount-input"><input data-amount inputmode="numeric" pattern="[0-9]*" placeholder="0" autofocus /><span class="unit">sat</span></div>
      <div class="presets" data-presets></div>
      <p class="warn" data-feenote>&nbsp;</p>
      <button class="btn btn-silver" data-create>${icons.bolt}<span>Create the invoice</span></button>
      <p class="warn">Notes hold between ${sats(minNet)} and ${sats(maxNet)} sat here.</p>
    </div>`)
    view.append(body)

    const input = body.querySelector('[data-amount]') as HTMLInputElement
    const feeNote = body.querySelector('[data-feenote]') as HTMLElement

    const presetValues = [21_000, 100_000, 500_000, 1_000_000].filter(v => v >= minNet && v <= maxNet)
    const presets = body.querySelector('[data-presets]') as HTMLElement
    if (presetValues.length >= 2) {
      for (const value of presetValues) {
        const button = el(`<button>${sats(value)}</button>`)
        button.addEventListener('click', () => {
          input.value = String(value / 1000)
          animate(input, {scale: [1.06, 1], duration: 260, ease: 'outCubic'})
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
      <div class="rubric">The invoice</div>
      <div class="amount"><span>${sats(args.grossMsat)}</span><span class="unit">sat</span></div>
      <p class="warn">Pay from any Lightning wallet - tap the QR to open one on this device. Your note is struck here the moment it settles.</p>
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
  const rawUrl = buildNoteUrl(pay!.withdrawLink ?? `${API}/w`, preimage, netMsat)
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
  const k1 = noteK1(args.url)
  const claimHref = runtime.walletUrl ? `${runtime.walletUrl}/#/claim?u=${encodeURIComponent(args.url)}` : null
  show(() => {
    const view = el('<div class="view"></div>')
    view.append(topBar('Your note', viewHome))
    const body = el('<div class="stack center"></div>')

    const note = banknote({
      sats: Math.round(args.amountMsat / 1000),
      serialHex: k1 ? hashK1(k1) : '0000000000000000',
      host: HOST.toUpperCase(),
      variant: {kind: 'live', qrText: claimHref ?? lnurl.toUpperCase()}
    })
    wireCover(note)
    body.append(note)

    body.append(
      el(`<div class="badges">
        ${args.verified ? `<span class="badge good">${icons.shield}<span>signature verified</span></span>` : ''}
        ${args.secured ? `<span class="badge good">${icons.check}<span>freshly rotated - only you hold it</span></span>` : `<span class="badge wait">${icons.hourglass}<span>not re-secured - receive it into a wallet soon</span></span>`}
      </div>`),
      el(`<p class="warn"><strong>This note is the money.</strong> Whoever sees it owns it - save it somewhere private, or open it in a wallet now.</p>`)
    )
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

    // the strike: the note lands and the corners count up
    animate(note, {scale: [0.96, 1], y: [10, 0], duration: 600, ease: 'outBack(1.4)'})
    // corners past a million print compact (600B) - counting up would
    // overwrite them with long digits
    const counterEl = note.querySelector('[data-value]')
    if (counterEl && args.amountMsat < 1_000_000_000_000) {
      setTimeout(() => {
        countTo(counterEl, args.amountMsat)
        burst(body)
      }, 250)
    } else {
      setTimeout(() => burst(body), 300)
    }
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
        <label>Present the note</label>
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
    const renderResult = (kind: 'good' | 'bad' | 'wait', stamp: string, title: string, detail: string): HTMLElement => {
      const node = el(`<div class="result ${kind}"><span class="stamp" style="--tilt:${kind === 'good' ? '-5deg' : '-7deg'}">${esc(stamp)}</span><b>${esc(title)}</b><p>${esc(detail)}</p></div>`)
      resultSlot.replaceChildren(node)
      stampIn(node.querySelector('.stamp') as HTMLElement)
      return node
    }

    const check = body.querySelector('[data-check]') as HTMLButtonElement
    check.addEventListener('click', () =>
      busy(check, async () => {
        const url = resolveNoteInput(input.value.trim())
        if (!url) {
          renderResult('bad', 'Refused', 'Not a bearer note', 'That does not decode to a note URL. A note looks like lnurlw://… with a k1 secret, or its LNURL1… encoding.')
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
            'Live',
            `Good for ${sats(info.maxWithdrawable)} sat`,
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
            renderResult('bad', 'Spent', 'Already spent', 'The mint knows this note and reports it burned. Whatever it was worth has already been redeemed.')
          } else if (err instanceof NoteUnknownError) {
            renderResult('bad', 'Unknown', 'Unknown note', `${noteHost === HOST ? 'This mint' : noteHost} has never issued a note with this id. Either it was minted elsewhere, or it never existed.`)
          } else if (err instanceof PendingNoteError) {
            renderResult('wait', 'In flight', 'Locked mid-payment', 'A melt is in flight on this note. It resolves shortly - either spent, or restored untouched.')
          } else {
            renderResult('wait', 'Held', 'Could not reach the mint', noteHost === HOST ? 'The mint did not answer. Try again shortly.' : `${noteHost} did not answer from this page - check it in a wallet instead.`)
          }
        }
      })
    )
    return view
  })
}

// ---------- go ----------

void boot()
