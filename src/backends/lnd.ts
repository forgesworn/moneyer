import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {verifyPreimage} from 'farrier-kit/preimage'
import {PaymentAlreadyKnownError, PaymentFailedError, PaymentPendingError, type LightningBackend} from './types.ts'

// lnd over its REST proxy. AddInvoice never returns a preimage but accepts
// one (r_preimage), which is what lets it back a mint. Payment send/track
// are chunked NDJSON streams read line by line to a terminal status.
//
// Not yet exercised against a live node - the semantics are a direct port
// of the reference mint's lnd backend, which is.
//
// TLS: for lnd's self-signed cert, point NODE_EXTRA_CA_CERTS at it.

const FAILURE_REASONS: Record<string, string> = {
  FAILURE_REASON_NO_ROUTE: 'Could not find a route to pay this invoice.',
  FAILURE_REASON_INCORRECT_PAYMENT_DETAILS: "The invoice's payment details were rejected.",
  FAILURE_REASON_INSUFFICIENT_BALANCE: 'Insufficient balance to pay this invoice.',
  FAILURE_REASON_TIMEOUT: 'Timed out trying to find a route to pay this invoice.'
}

const hexToBase64 = (hex: string): string => Buffer.from(hexToBytes(hex)).toString('base64')

const decodeHexOrBase64 = (value: string): string => {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase()
  return Buffer.from(value, 'base64').toString('hex')
}

export const createLndBackend = (config: {url: string; macaroon: string}): LightningBackend => {
  const headers = {'Grpc-Metadata-macaroon': config.macaroon, 'content-type': 'application/json'}

  const json = async (path: string, init: {method?: string; body?: unknown; timeoutMs?: number} = {}): Promise<{ok: boolean; status: number; json: any}> => {
    const res = await fetch(`${config.url}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? {body: JSON.stringify(init.body)} : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000)
    })
    return {ok: res.ok, status: res.status, json: await res.json().catch(() => null)}
  }

  // Reads a chunked NDJSON stream until `until` returns a value. A non-2xx
  // response's body rides back in `error` - grpc-gateway puts the actual
  // refusal reason there, and payInvoice needs to read it.
  const streamUntil = async <T>(
    path: string,
    init: {method?: string; body?: unknown; timeoutMs?: number},
    until: (event: any) => T | undefined
  ): Promise<{status: number; result: T | undefined; error?: string}> => {
    const res = await fetch(`${config.url}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? {body: JSON.stringify(init.body)} : {}),
      signal: AbortSignal.timeout(init.timeoutMs ?? 90_000)
    })
    if (!res.ok || !res.body) {
      const error = await res.text().catch(() => '')
      return {status: res.status, result: undefined, error}
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const {done, value} = await reader.read()
        if (value) buffer += decoder.decode(value, {stream: true})
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let event: any
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          const payment = event?.result ?? event
          const result = until(payment)
          if (result !== undefined) return {status: res.status, result}
        }
        if (done) return {status: res.status, result: undefined}
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  return {
    name: 'lnd',

    async createInvoice({amountMsat, preimageHex, memo, descriptionForHash}) {
      const res = await json('/v1/invoices', {
        method: 'POST',
        body: {
          value_msat: String(amountMsat),
          r_preimage: hexToBase64(preimageHex),
          ...(descriptionForHash === undefined
            ? {memo}
            : {description_hash: hexToBase64(bytesToHex(sha256(utf8ToBytes(descriptionForHash))))})
        }
      })
      if (!res.ok || typeof res.json?.payment_request !== 'string') {
        throw new Error(`lnd did not return a payment_request (${res.status}).`)
      }
      return {pr: res.json.payment_request}
    },

    async payInvoice({pr, feeLimitMsat}) {
      const {result, error} = await streamUntil(
        '/v2/router/send',
        {
          method: 'POST',
          body: {payment_request: pr, timeout_seconds: 60, fee_limit_msat: String(feeLimitMsat)},
          timeoutMs: 90_000
        },
        payment => (payment?.status === 'SUCCEEDED' || payment?.status === 'FAILED' ? payment : undefined)
      )
      if (!result) {
        // lnd refuses a send whose payment hash it already holds - on a
        // shared node that is somebody else's payment, and nothing went
        // out for THIS call. Distinct from ambiguity: safely restorable.
        if (error && /already exists|AlreadyExists|payment is in transition/i.test(error)) {
          throw new PaymentAlreadyKnownError('lnd already has a payment for this hash')
        }
        // The stream ended without a terminal status - genuinely ambiguous.
        throw new Error('lnd did not report a terminal payment status.')
      }
      if (result.status !== 'SUCCEEDED') {
        const reason = FAILURE_REASONS[result.failure_reason] ?? `Payment failed: ${result.failure_reason ?? 'unknown'}.`
        throw new PaymentFailedError(reason)
      }
      const preimageHex = result.payment_preimage ? decodeHexOrBase64(result.payment_preimage) : null
      if (!preimageHex) throw new Error('lnd did not return a payment_preimage.')
      const feeMsat = result.fee_msat !== undefined ? Number(result.fee_msat) : null
      return {preimageHex, feeMsat}
    },

    async isPaymentComplete(paymentHashHex) {
      const {status, result} = await streamUntil(
        `/v2/router/track/${encodeURIComponent(hexToBase64(paymentHashHex))}?no_inflight_updates=true`,
        {timeoutMs: 15_000},
        payment => {
          if (payment?.status === 'SUCCEEDED') return true
          if (payment?.status === 'FAILED') return false
          if (payment?.status) {
            // Anything non-terminal must not read as "confirmed not paid".
            throw new PaymentPendingError(`lnd reports payment status ${payment.status}`)
          }
          return undefined
        }
      )
      // A payment lnd never attempted is a 404 - safe to report incomplete,
      // since no HTLC was ever sent for it.
      if (status === 404) return false
      if (result === undefined) throw new Error('lnd did not report a payment status.')
      return result
    },

    async isInvoiceSettled(paymentHashHex) {
      const res = await json(`/v1/invoice/${paymentHashHex}`)
      return res.ok && Boolean(res.json?.settled)
    },

    async invoicePreimage(paymentHashHex) {
      const res = await json(`/v1/invoice/${paymentHashHex}`)
      if (!res.ok || !res.json?.settled || typeof res.json?.r_preimage !== 'string') return null
      const preimageHex = decodeHexOrBase64(res.json.r_preimage)
      return verifyPreimage(preimageHex, paymentHashHex) ? preimageHex : null
    },

    async paymentPreimage(paymentHashHex) {
      const {result} = await streamUntil(
        `/v2/router/track/${encodeURIComponent(hexToBase64(paymentHashHex))}?no_inflight_updates=true`,
        {timeoutMs: 15_000},
        payment => {
          if (payment?.status === 'SUCCEEDED') return payment.payment_preimage ?? null
          if (payment?.status === 'FAILED') return null
          return undefined
        }
      )
      if (typeof result !== 'string') return null
      const preimageHex = decodeHexOrBase64(result)
      return verifyPreimage(preimageHex, paymentHashHex) ? preimageHex : null
    },

    async nodeInfo() {
      const res = await json('/v1/getinfo')
      if (!res.ok) return {}
      const uris: string[] = res.json?.uris ?? []
      const color = typeof res.json?.color === 'string' ? `#${res.json.color.replace(/^#/, '')}` : undefined
      const numChannels = Number(res.json?.num_active_channels)
      const numPeers = Number(res.json?.num_peers)
      // Total public capacity, best-effort: the macaroon may not carry
      // offchain:read, and the discovery endpoint works fine without it.
      let capacityMsat: number | undefined
      const channels = await json('/v1/channels')
      if (channels.ok && Array.isArray(channels.json?.channels)) {
        capacityMsat = channels.json.channels.reduce(
          (sum: number, channel: {capacity?: string}) => sum + Number(channel.capacity ?? 0) * 1000,
          0
        )
      }
      return {
        ...(res.json?.alias ? {alias: res.json.alias} : {}),
        ...(uris[0] || res.json?.identity_pubkey ? {uri: uris[0] ?? res.json.identity_pubkey} : {}),
        ...(color && /^#[0-9a-fA-F]{6}$/.test(color) ? {color} : {}),
        // !== undefined narrows for exactOptionalPropertyTypes; the isFinite
        // half keeps a NaN from an unparseable channel capacity out.
        ...(capacityMsat !== undefined && Number.isFinite(capacityMsat) ? {capacityMsat} : {}),
        ...(Number.isSafeInteger(numChannels) ? {numChannels} : {}),
        ...(Number.isSafeInteger(numPeers) ? {numPeers} : {})
      }
    }
  }
}
