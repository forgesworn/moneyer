import {createHash} from 'node:crypto'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createLndBackend} from '../src/backends/lnd.ts'

// This fixture's hash contains both '/' and '+' in ordinary Base64.
const PREIMAGE = '01'.repeat(32)
const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex')

afterEach(() => vi.unstubAllGlobals())

const trackingLnd = (status: string, preimage = PREIMAGE) => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const path = new URL(String(input)).pathname
    // grpc-gateway unescapes the path before routing. Even an escaped slash
    // then adds a segment and cannot match TrackPaymentV2's hash parameter.
    const match = /^\/v2\/router\/track\/([^/]+)$/.exec(decodeURIComponent(path))
    if (!match) return Response.json({code: 5, message: 'Not Found'}, {status: 404})
    const encoded = match[1]!
    if (!encoded.endsWith('=') || Buffer.from(encoded, 'base64url').toString('hex') !== HASH) {
      return Response.json({code: 3, message: 'Invalid hash'}, {status: 400})
    }
    return new Response(JSON.stringify({result: {status, payment_preimage: preimage}}) + '\n')
  }))
  return createLndBackend({url: 'https://lnd.test', macaroon: 'ff'})
}

describe('lnd payment tracking with path-sensitive hashes', () => {
  it('retrieves and validates the proof of a successful payment', async () => {
    expect(await trackingLnd('SUCCEEDED').paymentPreimage(HASH)).toBe(PREIMAGE)
  })

  it('reports a successful payment as complete', async () => {
    expect(await trackingLnd('SUCCEEDED').isPaymentComplete(HASH)).toBe(true)
  })

  it('keeps failed payments unpaid and without a proof', async () => {
    const lnd = trackingLnd('FAILED', '')
    expect(await lnd.isPaymentComplete(HASH)).toBe(false)
    expect(await lnd.paymentPreimage(HASH)).toBeNull()
  })

  it('rejects a proof that does not settle the requested hash', async () => {
    expect(await trackingLnd('SUCCEEDED', '02'.repeat(32)).paymentPreimage(HASH)).toBeNull()
  })
})
