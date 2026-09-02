import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, fetchNoteInfo, hashK1} from 'lnurlcash-kit'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {createFakeBackend} from '../src/backends/fake.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// A funding source whose node mints its own invoice preimages.
//
// Moneyer used to require a caller-supplied preimage, and said so: it was
// "the capability a LUD-25 mint cannot exist without". That was true of the
// draft that keyed a bearer note by the payment preimage, and stopped being
// true on 31 August 2026 when that keying was removed. A note is bound to the
// wallet's comment commitment, which the funding source never sees and cannot
// influence, so a node that will not take a preimage - phoenixd, NIP-47
// `make_invoice` - can back a mint perfectly well.
//
// What it cannot do is let Moneyer know the payment hash before the invoice
// exists. Everything the pre-chosen path got for free has to be checked after
// the fact instead, and these tests pin that it is.

let active: TestMint | null = null
const start = async (): Promise<TestMint> => {
  active = await startMint({}, {backend: createFakeBackend({nodeChoosesPreimage: true})})
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

type CallbackReply = {status?: string; reason?: string; pr?: string; verify?: string}

const quote = async (mint: TestMint, amountMsat: number, secret: string): Promise<CallbackReply> => {
  const url = new URL(`${mint.moneyer.url}/p/cb`)
  url.searchParams.set('amount', String(amountMsat))
  url.searchParams.set('comment', bytesToHex(sha256(hexToBytes(secret))))
  return (await (await fetch(url)).json()) as CallbackReply
}

describe('a funding source that mints its own invoice preimages', () => {
  it('still mints a note the wallet alone can spend', async () => {
    const mint = await start()
    expect(mint.backend.acceptsInvoicePreimage).toBe(false)

    const secret = freshK1()
    const reply = await quote(mint, 21_000, secret)
    expect(reply.status).not.toBe('ERROR')
    const pr = reply.pr!
    const paymentHash = decodeBolt11(pr).paymentHashHex
    mint.backend.control.settleInvoice(paymentHash)

    // The note is at the wallet's own secret, worth what was paid.
    const info = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(info.maxWithdrawable).toBe(21_000)

    // And the payment preimage - which this node chose, and every routing
    // node on the way would have learned - buys nothing at all.
    const preimage = mint.backend.control.invoiceByHash(paymentHash)!.preimageHex
    expect(hashK1(preimage)).toBe(paymentHash)
    await expect(
      fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, preimage))
    ).rejects.toThrow()
  })

  it('refuses an invoice whose payment hash it has already issued', async () => {
    const mint = await start()

    const first = await quote(mint, 21_000, freshK1())
    const alreadyIssued = decodeBolt11(first.pr!).paymentHashHex

    // The node hands back the earlier invoice rather than a fresh one. With a
    // pre-chosen preimage this could not happen unnoticed; here it has to be
    // caught by looking the hash up afterwards.
    mint.backend.control.reuseNextInvoiceHash(alreadyIssued)
    const second = await quote(mint, 21_000, freshK1())
    expect(second.status).toBe('ERROR')
    expect(second.pr).toBeUndefined()
  })

  it('refuses an invoice the node had already settled', async () => {
    const mint = await start()

    // An invoice that exists and is paid, but belongs to nothing this mint is
    // quoting now. Handing it out would credit a note the instant the payer
    // looked, against money that moved for someone else entirely.
    const strangers = await mint.backend.createInvoice({
      amountMsat: 21_000,
      memo: 'not this mint'
    })
    // This node picks its own preimage, so the hash only exists once the
    // invoice does.
    const strangersHash = decodeBolt11(strangers.pr).paymentHashHex
    mint.backend.control.settleInvoice(strangersHash)

    mint.backend.control.reuseNextInvoiceHash(strangersHash)
    const reply = await quote(mint, 21_000, freshK1())
    expect(reply.status).toBe('ERROR')
    expect(reply.pr).toBeUndefined()
  })

  it('refuses an invoice committing to the note id the wallet named', async () => {
    const mint = await start()

    // The one collision that would be silently catastrophic: an invoice whose
    // payment hash IS the note's id. The note would be keyed by a value the
    // funding source knows.
    const secret = freshK1()
    const outputId = bytesToHex(sha256(hexToBytes(secret)))
    mint.backend.control.reuseNextInvoiceHash(outputId)
    const reply = await quote(mint, 21_000, secret)
    expect(reply.status).toBe('ERROR')
    expect(reply.pr).toBeUndefined()
  })
})
