import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fetchPayRequest, hashK1, requestInvoice} from '@lnurlcash/kit'
import {tryDecodeBolt11} from 'farrier-kit/bolt11'
import {createFakeBackend, type FakeBackend} from '../src/backends/fake.ts'
import {freshK1, startMint, waitFor, type TestMint} from './helpers.ts'

// A funding source that streams its settles lets the mint credit a paid
// invoice at once, with no wallet coming back to ask. The stream is only a
// hint, and it has to survive being dropped and the mint restarting.

let active: TestMint | null = null
const cleanups: Array<() => void> = []
afterEach(async () => {
  await active?.moneyer.close().catch(() => {})
  active = null
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const streaming = (): FakeBackend => createFakeBackend({streamsSettles: true})

const start = async (backend: FakeBackend, dbPath?: string): Promise<TestMint> => {
  active = await startMint(dbPath ? {dbPath} : {}, {backend, invoiceStreamRetryMs: 20})
  return active
}

// An invoice quoted to a note the test never claims: nothing but the
// stream can credit it.
const quote = async (mint: TestMint): Promise<string> => {
  const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
  const invoice = await requestInvoice(pay.callback, 21_000, hashK1(freshK1()))
  return tryDecodeBolt11(invoice.pr)!.paymentHashHex
}

const credited = (mint: TestMint, paymentHash: string): boolean =>
  mint.moneyer.store.mintInvoiceByHash(paymentHash)?.settled === true

describe('the invoice settle stream', () => {
  it('mints the note the moment its invoice settles', async () => {
    const mint = await start(streaming())
    const paymentHash = await quote(mint)
    const before = mint.moneyer.store.outstandingLiabilityMsat()
    mint.backend.control.settleInvoice(paymentHash)
    await waitFor(() => credited(mint, paymentHash))
    expect(mint.moneyer.store.outstandingLiabilityMsat()).toBe(before + 21_000)
    expect(mint.moneyer.store.metaValue('invoice_stream_index:fake')).toBe('1')
  })

  it('credits nothing the funding source does not confirm', async () => {
    const mint = await start(streaming())
    const paymentHash = await quote(mint)
    mint.backend.isInvoiceSettled = async () => false
    mint.backend.control.settleInvoice(paymentHash)
    await waitFor(() => mint.moneyer.store.metaValue('invoice_stream_index:fake') === '1')
    expect(credited(mint, paymentHash)).toBe(false)
  })

  it('catches up on a settle it missed while the stream was down', async () => {
    const mint = await start(streaming())
    const [first, second] = [await quote(mint), await quote(mint)]
    mint.backend.control.settleInvoice(first)
    await waitFor(() => credited(mint, first))
    mint.backend.control.dropInvoiceStreams()
    mint.backend.control.settleInvoice(second)
    await waitFor(() => credited(mint, second))
    expect(mint.moneyer.store.metaValue('invoice_stream_index:fake')).toBe('2')
  })

  it('resumes after a restart from the last settle it handled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-stream-'))
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}))
    const dbPath = join(dir, 'mint.sqlite')
    const backend = streaming()

    let mint = await start(backend, dbPath)
    const [first, second] = [await quote(mint), await quote(mint)]
    backend.control.settleInvoice(first)
    await waitFor(() => credited(mint, first))
    await mint.moneyer.close()
    active = null

    // paid while the mint was down
    backend.control.settleInvoice(second)
    mint = await start(backend, dbPath)
    await waitFor(() => credited(mint, second))
    expect(mint.moneyer.store.metaValue('invoice_stream_index:fake')).toBe('2')
  })

  it('leaves a funding source without a stream to the lazy paths', async () => {
    const mint = await start(createFakeBackend())
    const paymentHash = await quote(mint)
    mint.backend.control.settleInvoice(paymentHash)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(credited(mint, paymentHash)).toBe(false)
  })
})
