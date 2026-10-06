import {afterEach, describe, expect, it} from 'vitest'
import {createLndBackend} from '../src/backends/lnd.ts'

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
