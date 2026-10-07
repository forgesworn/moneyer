import {afterEach, describe, expect, it} from 'vitest'
import {createLndBackend} from '../src/backends/lnd.ts'
import {PaymentAlreadyKnownError} from '../src/backends/types.ts'

// The expiry sweep deletes a mint invoice's row on a "not settled", so that
// answer has to mean the node said so. lnd answers 404 for an invoice it
// does not hold; anything else that is not a 200 is no answer.

const HASH = 'ab'.repeat(32)

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

const lndAnswering = (status: number, body: unknown) => {
  const real = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})) as typeof fetch
  restore = () => {
    globalThis.fetch = real
  }
  return createLndBackend({url: 'https://lnd.test', macaroon: 'ff'})
}

describe('lnd isInvoiceSettled', () => {
  it('reads a settled invoice as paid', async () => {
    expect(await lndAnswering(200, {settled: true}).isInvoiceSettled(HASH)).toBe(true)
  })

  it('reads an open invoice as unpaid', async () => {
    expect(await lndAnswering(200, {settled: false}).isInvoiceSettled(HASH)).toBe(false)
  })

  it('reads an invoice lnd does not hold as unpaid', async () => {
    expect(await lndAnswering(404, {code: 5, message: 'unable to locate invoice'}).isInvoiceSettled(HASH)).toBe(false)
  })

  it('throws rather than answer when lnd refuses', async () => {
    await expect(lndAnswering(500, {message: 'internal'}).isInvoiceSettled(HASH)).rejects.toThrow(/HTTP 500/)
    await expect(lndAnswering(403, {message: 'permission denied'}).isInvoiceSettled(HASH)).rejects.toThrow(/HTTP 403/)
  })
})

// grpc-gateway answers a refused stream with the gRPC code's HTTP status and
// one error chunk. lnd refuses a hash it is creating, paying or has paid
// (payments/db/errors.go); each is somebody else's payment on a shared
// node, so nothing went out for this send and the note may restore.
describe('lnd payInvoice refusals', () => {
  it.each(['payment already exists', 'payment is in transition', 'invoice is already paid'])(
    'reads "%s" as a payment the node already holds',
    async message => {
      const lnd = lndAnswering(409, {error: {code: 6, message, details: []}})
      await expect(lnd.payInvoice({pr: 'lnbc1', feeLimitMsat: 5000})).rejects.toBeInstanceOf(PaymentAlreadyKnownError)
    }
  )
})

// lnd's invoice subscription: one {"result": Invoice} per line, adds and
// settles alike, and an {"error": ...} line if lnd ends it.
describe('lnd watchSettledInvoices', () => {
  const streaming = (lines: unknown[]) => {
    const real = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input))
      return new Response(lines.map(line => JSON.stringify(line)).join('\n') + '\n', {status: 200})
    }) as typeof fetch
    restore = () => {
      globalThis.fetch = real
    }
    return {lnd: createLndBackend({url: 'https://lnd.test', macaroon: 'ff'}), urls}
  }
  const base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64')

  it('reports settled invoices only, by hex hash and settle index, resuming after the index given', async () => {
    const {lnd, urls} = streaming([
      {result: {state: 'OPEN', r_hash: base64('cd'.repeat(32)), settle_index: '0'}},
      {result: {state: 'SETTLED', r_hash: base64(HASH), settle_index: '7'}}
    ])
    const seen: Array<[string, number]> = []
    await lnd.watchSettledInvoices!({
      fromIndex: 6,
      signal: new AbortController().signal,
      onSettled: async (hash, index) => {
        seen.push([hash, index])
      }
    })
    expect(urls).toEqual(['https://lnd.test/v1/invoices/subscribe?settle_index=6'])
    expect(seen).toEqual([[HASH, 7]])
  })

  it('throws when lnd ends the stream with an error', async () => {
    const {lnd} = streaming([{error: {code: 2, message: 'shutting down'}}])
    await expect(
      lnd.watchSettledInvoices!({fromIndex: 0, signal: new AbortController().signal, onSettled: async () => {}})
    ).rejects.toThrow(/shutting down/)
  })
})
