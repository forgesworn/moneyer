import {renderSVG} from 'uqr'
import {rosette, band} from './guilloche.ts'
import {amountInWords} from './note-words.ts'

// The struck note, rendered as what it is: a banknote. Always ivory -
// paper does not have a dark mode - with graphite ink, silver engine
// turning and a copper seal. The same plate prints the homepage SPECIMEN
// and the live note around a real QR.

const esc = (value: string): string => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

const MICROPRINT = Array(6)
  .fill('WHOEVER HOLDS THE STRING HOLDS THE MONEY · PAYS THE BEARER ON DEMAND · ')
  .join('')

// A circular seal: text on a ring around a small rosette, pure SVG.
const seal = (): string => {
  const inner = rosette(64).replace('<svg ', '<svg x="28" y="28" ')
  return `<svg class="nb-seal" viewBox="0 0 120 120" aria-hidden="true">
    <defs><path id="sealring" d="M60 14a46 46 0 1 1-.01 0z"/></defs>
    <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="60" cy="60" r="44" fill="none" stroke="currentColor" stroke-width="0.8"/>
    <text font-size="9.5" letter-spacing="2.2" fill="currentColor" font-family="IBM Plex Mono, monospace">
      <textPath href="#sealring" startOffset="0">MONEYER · STRUCK ON LIGHTNING ·</textPath>
    </text>
    ${inner}
  </svg>`
}

const cornerNumeral = (sats: number, corner: string): string =>
  `<span class="nb-corner ${corner}"><i></i><b${corner === 'tl' ? ' data-value' : ''}>${sats.toLocaleString('en-GB').replace(/,/g, ' ')}</b></span>`

export type BanknoteArgs = {
  sats: number
  serialHex: string
  host: string
  // specimen: no QR, a SPECIMEN overstamp. live: a QR the holder reveals.
  variant: {kind: 'specimen'} | {kind: 'live'; qrText: string}
}

export const banknote = (args: BanknoteArgs): HTMLElement => {
  const serial = `${args.serialHex.slice(0, 4)}…${args.serialHex.slice(-4)}`.toUpperCase()
  const words = amountInWords(args.sats)
  const template = document.createElement('template')
  template.innerHTML = `
  <div class="nb" role="img" aria-label="A bearer note for ${args.sats} sats">
    <div class="nb-frame"></div>
    <div class="nb-micro top">${MICROPRINT}</div>
    <div class="nb-band top">${band()}</div>
    ${cornerNumeral(args.sats, 'tl')}${cornerNumeral(args.sats, 'tr')}
    ${cornerNumeral(args.sats, 'bl')}${cornerNumeral(args.sats, 'br')}
    <div class="nb-rosette">${rosette(300)}</div>
    <div class="nb-body">
      <div class="nb-title">LNURLCASH BEARER NOTE</div>
      <div class="nb-titlerule"><i></i><span>·</span><i></i></div>
      <div class="nb-words">${esc(words)}</div>
      <div class="nb-sats">S A T S</div>
      <div class="nb-promise">Pays the bearer on demand, no questions asked</div>
      <div class="nb-serial">Nº&nbsp;&nbsp;${esc(serial)} · SERIES 2026</div>
      ${
        args.variant.kind === 'live'
          ? `<div class="nb-qrwrap">
               <div class="covered">
                 <div class="qr nb-qr" role="img" aria-label="The note itself">${renderSVG(args.variant.qrText, {border: 1})}</div>
                 <button class="cover"><span>Tap to reveal</span><small>Anyone who sees this code can take the sats.</small></button>
               </div>
             </div>`
          : `<div class="nb-specimen" aria-hidden="true">SPECIMEN</div>`
      }
    </div>
    ${seal()}
    <div class="nb-foot">32 BYTES · A CLAIM ON A VERY SMALL NODE · NOT LEGAL TENDER</div>
    <div class="nb-issuer">${esc(args.host)}</div>
    <div class="nb-band bottom">${band()}</div>
    <div class="nb-micro bottom">${MICROPRINT}</div>
  </div>`
  return template.content.firstElementChild as HTMLElement
}
