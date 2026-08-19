import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {verifyPreimage} from 'farrier-kit/preimage'
import {PaymentAlreadyKnownError, PaymentFailedError, PaymentPendingError, type LightningBackend} from './types.ts'

// Core Lightning over the clnrest plugin. cln's `invoice` accepts a
// caller-supplied preimage, which is the whole reason it can back a mint.
//
// Not yet exercised against a live node - the semantics are a direct port
// of the reference mint's cln backend, which is.
//
// TLS: the node's certificate must be one this process trusts. For a
// self-signed clnrest cert, point NODE_EXTRA_CA_CERTS at it.

// xpay's documented failure codes.
const PAY_FAILURE_REASONS: Record<number, string> = {
  203: "The invoice's destination permanently rejected this payment.",
  205: 'Could not find a route to pay this invoice.',
  207: 'This invoice has expired.',
  219: 'This invoice has already been paid.'
}

export const createClnBackend = (config: {url: string; rune: string}): LightningBackend => {
  const call = async (path: string, body: unknown, timeoutMs = 15_000): Promise<{ok: boolean; status: number; json: any}> => {
    const res = await fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: {'content-type': 'application/json', Rune: config.rune},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const json = await res.json().catch(() => null)
    return {ok: res.ok, status: res.status, json}
  }

  const mustCall = async (path: string, body: unknown, timeoutMs?: number): Promise<any> => {
    const res = await call(path, body, timeoutMs)
    if (!res.ok) {
      throw new Error(`cln ${path} failed (${res.status}): ${JSON.stringify(res.json)?.slice(0, 200)}`)
    }
    return res.json
  }

  return {
    name: 'cln',

    async createInvoice({amountMsat, preimageHex, memo}) {
      const result = await mustCall('/v1/invoice', {
        amount_msat: amountMsat,
        label: bytesToHex(randomBytes(16)),
        description: memo,
        preimage: preimageHex
      })
      if (typeof result?.bolt11 !== 'string') throw new Error('cln did not return a bolt11 invoice.')
      return {pr: result.bolt11}
    },

    async payInvoice({pr, feeLimitMsat}) {
      // xpay resolves once it stops retrying, which is NOT proof that no
      // HTLC it already sent remains outstanding - the caller confirms via
      // isPaymentComplete before restoring anything either way. The
      // timeout sits above xpay's own default 60s retry_for so a clean
      // failure response is not turned into an ambiguous one at the wire.
      const res = await call('/v1/xpay', {invstring: pr, maxfee: feeLimitMsat}, 90_000)
      if (!res.ok) {
        const code = res.json?.code
        // 219: this node already paid that hash. On a shared node that is
        // somebody else's payment - nothing went out for THIS call, so it
        // is a distinct, safely-restorable refusal rather than a failure.
        if (code === 219) {
          throw new PaymentAlreadyKnownError('cln already has a payment for this hash')
        }
        const reason =
          (typeof code === 'number' && PAY_FAILURE_REASONS[code]) ||
          res.json?.message ||
          `Payment failed (${res.status}).`
        throw new PaymentFailedError(reason)
      }
      const preimageHex = res.json?.payment_preimage
      if (typeof preimageHex !== 'string') throw new Error('cln did not return a payment_preimage.')
      const amountMsat = res.json?.amount_msat
      const amountSentMsat = res.json?.amount_sent_msat
      const feeMsat =
        typeof amountMsat === 'number' && typeof amountSentMsat === 'number'
          ? amountSentMsat - amountMsat
          : null
      return {preimageHex, feeMsat}
    },

    async isPaymentComplete(paymentHashHex) {
      const result = await mustCall('/v1/listpays', {payment_hash: paymentHashHex})
      const pays: any[] = result?.pays ?? []
      // "pending" is not "confirmed not paid" - an HTLC may still be locked
      // at the final hop.
      if (pays.some(pay => pay?.status === 'pending')) {
        throw new PaymentPendingError('cln reports the payment still pending')
      }
      return pays.some(pay => pay?.status === 'complete')
    },

    async isInvoiceSettled(paymentHashHex) {
      const result = await mustCall('/v1/listinvoices', {payment_hash: paymentHashHex})
      const invoices: any[] = result?.invoices ?? []
      return invoices.length > 0 && invoices[0]?.status === 'paid'
    },

    async invoicePreimage(paymentHashHex) {
      const result = await mustCall('/v1/listinvoices', {payment_hash: paymentHashHex})
      const invoice = (result?.invoices ?? [])[0]
      if (!invoice || invoice.status !== 'paid') return null
      const preimageHex = invoice.payment_preimage
      if (typeof preimageHex !== 'string' || !verifyPreimage(preimageHex, paymentHashHex)) return null
      return preimageHex
    },

    async paymentPreimage(paymentHashHex) {
      const result = await mustCall('/v1/listpays', {payment_hash: paymentHashHex})
      for (const pay of result?.pays ?? []) {
        if (pay?.status === 'complete' && typeof pay.preimage === 'string') return pay.preimage
      }
      return null
    },

    async nodeInfo() {
      const info = await mustCall('/v1/getinfo', {})
      const id = info?.id
      const address = (info?.address ?? [])[0]
      const uri =
        id && address?.address && address?.port ? `${id}@${address.address}:${address.port}` : id
      const color = typeof info?.color === 'string' ? `#${info.color.replace(/^#/, '')}` : undefined
      return {
        ...(info?.alias ? {alias: info.alias} : {}),
        ...(uri ? {uri} : {}),
        ...(color && /^#[0-9a-fA-F]{6}$/.test(color) ? {color} : {})
      }
    }
  }
}
