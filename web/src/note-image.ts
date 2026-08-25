import {encode} from 'uqr'
import {cornerText} from './banknote.ts'
import {ROSETTE_STROKE, ROSETTE_VIEWBOX, ringPoints, rosetteRings} from './guilloche.ts'
import {amountInWords} from './note-words.ts'

// The note as a file you can hand to someone. banknote.ts letterpresses
// the portrait plate in HTML for the screen; this composites the same
// plate onto a canvas so it can leave as a PNG. The zones are the
// stylesheet's, unchanged: a cqw is one per cent of the plate's width
// either way, so 7.2cqw here is the 7.2cqw there.
//
// Printed open - no scratch foil, no SPECIMEN - because a note the
// recipient cannot scan is not worth sending. The image IS the money.

const W = 1024
const H = 1536
const INK = '#23262b'
const BLUE = '#33597d'
const PAPER = '#edeff0'
const PLATE = '/art/plate-p.webp'

const DISPLAY = "'Cinzel', 'Times New Roman', serif"
const BODY = "'Spectral', Georgia, 'Times New Roman', serif"
const MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace"

// The stylesheet's units. Percentages of an absolutely positioned box
// resolve against the plate, so across/down are literal translations.
const cqw = (n: number): number => (n * W) / 100
const across = (pct: number): number => (pct * W) / 100
const down = (pct: number): number => (pct * H) / 100

// Canvas grew letterSpacing late; where it is missing the tracking is
// walked out by hand, which costs the kerning and nothing else.
type Ctx = CanvasRenderingContext2D & {letterSpacing?: string}

type Face = {family: string; weight: number; italic?: boolean}

const setFace = (ctx: Ctx, face: Face, size: number): void => {
  ctx.font = `${face.italic ? 'italic ' : ''}${face.weight} ${size}px ${face.family}`
}

const tracks = (ctx: Ctx): boolean => 'letterSpacing' in ctx

// CSS letter-spacing lands after every character, the last one included,
// so a centred line sits half a step left of true. Measure the ink only.
const inkWidth = (ctx: Ctx, text: string, tracking: number): number => {
  if (!text) return 0
  if (tracks(ctx)) {
    ctx.letterSpacing = `${tracking}px`
    const width = ctx.measureText(text).width
    ctx.letterSpacing = '0px'
    return width - tracking
  }
  const chars = [...text]
  const sum = chars.reduce((total, char) => total + ctx.measureText(char).width, 0)
  return sum + tracking * (chars.length - 1)
}

const drawCentred = (ctx: Ctx, text: string, cx: number, baseline: number, tracking: number): void => {
  if (!text) return
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  let x = cx - inkWidth(ctx, text, tracking) / 2
  if (tracks(ctx)) {
    ctx.letterSpacing = `${tracking}px`
    ctx.fillText(text, x, baseline)
    ctx.letterSpacing = '0px'
    return
  }
  for (const char of [...text]) {
    ctx.fillText(char, x, baseline)
    x += ctx.measureText(char).width + tracking
  }
}

// CSS half-leading: the line box is size x line-height, the glyphs sit
// centred in it by the font's own ascent and descent.
const leading = (ctx: Ctx, size: number, lineHeight: number): {box: number; baseline: number} => {
  const metrics = ctx.measureText('H')
  const ascent = metrics.fontBoundingBoxAscent || size * 0.8
  const descent = metrics.fontBoundingBoxDescent || size * 0.2
  const box = size * lineHeight
  return {box, baseline: (box - (ascent + descent)) / 2 + ascent}
}

const wrap = (ctx: Ctx, text: string, maxWidth: number, tracking: number): string[] => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word
    if (line && inkWidth(ctx, candidate, tracking) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

// text-wrap: balance. Squeeze the measure until the line count would
// rise, so the last line is not left carrying one word on its own.
const balanced = (ctx: Ctx, text: string, maxWidth: number, tracking: number): string[] => {
  const target = wrap(ctx, text, maxWidth, tracking).length
  if (target < 2) return [text]
  let low = 0
  let high = maxWidth
  for (let i = 0; i < 14; i++) {
    const mid = (low + high) / 2
    if (wrap(ctx, text, mid, tracking).length <= target) high = mid
    else low = mid
  }
  return wrap(ctx, text, high, tracking)
}

// One flex item of the cartouche: its own type, its own leading, and the
// margin-top that the stylesheet gives it.
type Block = {
  lines: string[]
  face: Face
  size: number
  lineHeight: number
  tracking: number
  colour: string
  marginTop: number
}

const blockHeight = (block: Block): number =>
  block.marginTop + block.lines.length * block.size * block.lineHeight

// flex-direction: column; align-items: center; justify-content: center.
const drawStack = (ctx: Ctx, blocks: Block[], cx: number, top: number, height: number, gap: number): void => {
  const total =
    blocks.reduce((sum, block) => sum + blockHeight(block), 0) + gap * (blocks.length - 1)
  let y = top + (height - total) / 2
  for (const block of blocks) {
    y += block.marginTop
    setFace(ctx, block.face, block.size)
    ctx.fillStyle = block.colour
    const {box, baseline} = leading(ctx, block.size, block.lineHeight)
    for (const line of block.lines) {
      drawCentred(ctx, line, cx, y + baseline, block.tracking)
      y += box
    }
    y += gap
  }
}

// Module edges snapped to whole pixels: no seams between modules, no
// half-lit row at the bottom, which is what a scanner wants.
const drawQr = (ctx: Ctx, text: string, x: number, y: number, side: number): void => {
  const {size, data} = encode(text, {border: 1})
  const edge = (n: number): number => Math.round((n * side) / size)
  ctx.fillStyle = '#000000'
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!data[row]?.[col]) continue
      const left = edge(col)
      const top = edge(row)
      ctx.fillRect(x + left, y + top, edge(col + 1) - left, edge(row + 1) - top)
    }
  }
}

const SEAL_RING = 'MONEYER · STRUCK ON LIGHTNING ·'

// The seal, drawn in the 120-unit space its SVG uses so the radii below
// are the ones in banknote.ts.
const drawSeal = (ctx: Ctx, cx: number, cy: number, side: number): void => {
  const scale = side / 120
  ctx.save()
  ctx.globalAlpha = 0.8
  ctx.translate(cx, cy)
  ctx.rotate((8 * Math.PI) / 180)
  ctx.scale(scale, scale)
  ctx.strokeStyle = BLUE
  ctx.fillStyle = BLUE

  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(0, 0, 57, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.arc(0, 0, 44, 0, Math.PI * 2)
  ctx.stroke()

  // the rosette, inset in a 64-unit box concentric with the rings
  ctx.save()
  const inner = 64 / ROSETTE_VIEWBOX
  ctx.scale(inner, inner)
  // hairlines this fine land on a quarter of a pixel and disappear
  ctx.lineWidth = Math.max(ROSETTE_STROKE, 0.45 / (scale * inner))
  for (const ring of rosetteRings()) {
    ctx.globalAlpha = 0.8 * ring.opacity
    ctx.beginPath()
    for (const [x, y] of ringPoints(ring)) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.stroke()
  }
  ctx.restore()

  // the legend, set round the ring a character at a time
  ctx.globalAlpha = 0.8
  ctx.fillStyle = BLUE
  setFace(ctx, {family: MONO, weight: 400}, 9.5)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const radius = 46
  let angle = 0
  for (const char of SEAL_RING) {
    const step = ctx.measureText(char).width
    angle += step / 2 / radius
    ctx.save()
    ctx.rotate(angle)
    ctx.fillText(char, 0, -radius)
    ctx.restore()
    angle += (step / 2 + 2.2) / radius
  }
  ctx.restore()
}

// Which cuts of which faces the plate actually sets. Loaded before a
// stroke is drawn, or the canvas quietly falls back to Times.
const FACES = [
  '400 40px Cinzel',
  '700 40px Cinzel',
  'italic 500 40px Spectral',
  '400 40px "IBM Plex Mono"',
  '600 40px "IBM Plex Mono"'
]

const loadFaces = async (): Promise<void> => {
  await Promise.all(FACES.map(face => document.fonts.load(face).catch(() => [])))
  await document.fonts.ready
}

const loadPlate = (): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The plate artwork did not load.'))
    image.src = PLATE
  })

export type NoteImageArgs = {
  sats: number
  serialHex: string
  host: string
  qrText: string
}

export const noteImage = async (args: NoteImageArgs): Promise<Blob> => {
  const [plate] = await Promise.all([loadPlate(), loadFaces()])

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d') as Ctx | null
  if (!ctx) throw new Error('This browser will not draw the note.')

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, W, H)
  ctx.drawImage(plate, 0, 0, W, H)

  // corner numerals, centred on their point the way translate(-50%,-50%) does
  const corner = cornerText(args.sats)
  const cornerSize = cqw(Math.min(4.6, 26 / Math.max(corner.length, 2)))
  setFace(ctx, {family: DISPLAY, weight: 700}, cornerSize)
  ctx.fillStyle = INK
  const cornerLine = leading(ctx, cornerSize, 1.6)
  const cornerBaseline = down(9.9) - cornerLine.box / 2 + cornerLine.baseline
  for (const pct of [16, 84]) drawCentred(ctx, corner, across(pct), cornerBaseline, 0)

  // the cartouche
  const cartoucheWidth = W - across(17) * 2
  const words = amountInWords(args.sats)
  const wordsSize = cqw(words.length > 14 ? 5.6 : 7.2)
  setFace(ctx, {family: DISPLAY, weight: 700}, wordsSize)
  const wordLines = balanced(ctx, words, cartoucheWidth, wordsSize * 0.03)

  const serial = `${args.serialHex.slice(0, 4)}…${args.serialHex.slice(-4)}`.toUpperCase()
  const titleSize = cqw(2.15)
  const satsSize = cqw(3)
  const promiseSize = cqw(2.9)
  const serialSize = cqw(2.2)

  drawStack(
    ctx,
    [
      {
        lines: ['LNURLCASH BEARER NOTE'],
        face: {family: DISPLAY, weight: 700},
        size: titleSize,
        lineHeight: 1.45,
        tracking: titleSize * 0.26,
        colour: INK,
        marginTop: 0
      },
      {
        lines: wordLines,
        face: {family: DISPLAY, weight: 700},
        size: wordsSize,
        lineHeight: 1.08,
        tracking: wordsSize * 0.03,
        colour: INK,
        marginTop: cqw(0.6)
      },
      {
        lines: ['SATS'],
        face: {family: DISPLAY, weight: 400},
        size: satsSize,
        lineHeight: 1.6,
        tracking: satsSize * 0.55,
        colour: INK,
        marginTop: 0
      },
      {
        lines: ['Pays the bearer on demand,', 'no questions asked'],
        face: {family: BODY, weight: 500, italic: true},
        size: promiseSize,
        lineHeight: 1.5,
        tracking: 0,
        colour: INK,
        marginTop: cqw(0.6)
      },
      {
        lines: [`Nº ${serial} · SERIES 2026`],
        face: {family: MONO, weight: 600},
        size: serialSize,
        lineHeight: 1.6,
        tracking: serialSize * 0.14,
        colour: BLUE,
        marginTop: cqw(0.6)
      }
    ],
    W / 2,
    down(18),
    down(21),
    cqw(1)
  )

  // the panel: white ground, the note itself, the caption under it
  const panelX = across(30)
  const panelY = down(53.4)
  const panelSide = across(40.5)
  const coveredX = panelX + panelSide * 0.025
  const coveredY = panelY + panelSide * 0.025
  const coveredWidth = panelSide * 0.95
  const qrSide = panelSide * (1 - 0.025 - 0.15)
  const qrX = coveredX + (coveredWidth - qrSide) / 2

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(qrX, coveredY, qrSide, qrSide)
  const padding = qrSide * 0.04
  drawQr(ctx, args.qrText, qrX + padding, coveredY + padding, qrSide - padding * 2)

  const footSize = cqw(1.45)
  setFace(ctx, {family: MONO, weight: 600}, footSize)
  ctx.fillStyle = INK
  const foot = leading(ctx, footSize, 1.6)
  const footLines = ['32 BYTES · A CLAIM ON A VERY SMALL NODE', '· NOT LEGAL TENDER ·']
  let footY = panelY + panelSide - panelSide * 0.026 - foot.box * footLines.length
  for (const line of footLines) {
    drawCentred(ctx, line, panelX + panelSide / 2, footY + foot.baseline, footSize * 0.1)
    footY += foot.box
  }

  const sealSide = cqw(15)
  drawSeal(ctx, W - across(5) - sealSide / 2, down(84) + sealSide / 2, sealSide)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('The note would not print to a file here.'))
    }, 'image/png')
  })
}
