// @vitest-environment happy-dom
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {buildNoteUrl} from 'lnurlcash-kit'
import {installNodeFetch} from './browser-fetch-shim.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// happy-dom's fetch double-sends every request - see browser-fetch-shim.ts
installNodeFetch()

// Boots the real mint website in a DOM against a real (fake-funded) mint
// and walks the whole promise of the page: discovery renders the terms,
// an invoice is created fee-grossed, settling it claims the note, the
// claim rotates it, and the rotated note's signature verifies - all with
// the same kit calls a wallet would make. Then the check flow classifies
// an unknown note. Polls, never sleeps a fixed beat.

let mint: TestMint

const until = async (predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what} - body: ${text().slice(0, 400)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const text = (): string => document.body.textContent ?? ''
const click = (selector: string): void => {
  const node = document.querySelector<HTMLButtonElement>(selector)
  if (!node) throw new Error(`nothing matches ${selector}`)
  node.click()
}

const onHome = () => document.querySelectorAll('.tile').length === 2

beforeAll(async () => {
  mint = await startMint({mintFee: {baseFeeMsat: 1000, feePpm: 5000}})
  ;(window as unknown as {__MINT__: unknown}).__MINT__ = {
    username: 'mint',
    origin: mint.moneyer.url,
    walletUrl: 'https://wallet.example'
  }
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>'
  await import('../web/src/main.ts')
  await until(onHome, 'the home screen')
})

afterAll(async () => {
  await mint.moneyer.close()
})

describe('the mint website', () => {
  it('renders discovery: address, terms, fee line, signing key', () => {
    expect(text()).toContain(`mint@${new URL(mint.moneyer.url).host}`)
    expect(text()).toContain('0.5%')
    expect(text()).toContain(mint.moneyer.signer!.pubkey)
  })

  it('mints in the browser: invoice, settle, claim, rotate, verify', async () => {
    click('[data-go-mint]')
    await until(() => document.querySelector('[data-amount]') !== null, 'the mint form')

    const amount = document.querySelector<HTMLInputElement>('[data-amount]')!
    amount.value = '21'
    amount.dispatchEvent(new Event('input'))
    expect(text()).toContain('You pay')

    click('[data-create]')
    await until(() => document.querySelector('a.qr') !== null, 'the invoice screen')

    const pr = document.querySelector<HTMLAnchorElement>('a.qr')!.href.replace(/^lightning:/i, '')
    // grossed up: the invoice asks for more than the note will hold
    expect(text()).toContain('Copy invoice')
    const paymentHash = bolt11PaymentHash(pr)!
    mint.backend.control.settleInvoice(paymentHash)

    await until(() => text().includes('freshly rotated') || document.querySelector('.toast.err') !== null, 'the claimed note or an error', 20_000)
    const errToast = document.querySelector('.toast.err')
    if (errToast) throw new Error(`claim errored: ${errToast.textContent}`)
    expect(text()).toContain('signature verified')
    // the value counts up from 0 - poll for the landing figure
    await until(() => document.querySelector('[data-value]')?.textContent === '21', 'the counted value')
    const walletLink = document.querySelector<HTMLAnchorElement>('a[href^="https://wallet.example/#/claim?u="]')
    expect(walletLink).not.toBeNull()
    // the code arrives under scratch silver, not in the open
    expect(document.querySelector('.scratch-foil')).not.toBeNull()
  }, 30_000)

  it('classifies an unknown note in the check flow', async () => {
    click('[data-back]')
    await until(onHome, 'the home screen')
    click('[data-go-check]')
    await until(() => document.querySelector('[data-input]') !== null, 'the check form')

    const input = document.querySelector<HTMLTextAreaElement>('[data-input]')!
    input.value = buildNoteUrl(`${mint.moneyer.url}/w`, freshK1(), 21_000)
    click('[data-check]')
    await until(() => text().includes('Unknown note'), 'the unknown-note verdict')
  }, 15_000)

  it('rejects something that is not a note at all', async () => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-input]')!
    input.value = 'certainly not money'
    click('[data-check]')
    await until(() => text().includes('Not a bearer note'), 'the refusal')
  })
})
