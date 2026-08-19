import {bytesToHex} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes} from '@noble/hashes/utils.js'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {fakeBolt11} from './fake-bolt11.ts'
import {
  PaymentAlreadyKnownError,
  PaymentFailedError,
  PaymentPendingError,
  type LightningBackend,
  type NodeInfo
} from './types.ts'

// A funding source that invents its invoices and pays nothing, for
// development and tests. Every failure a real backend can inflict on the
// melt path is a mode here, because the melt discipline - restore only on
// confirmed non-payment, leave pending on ambiguity - is exactly the code
// that must be exercised without real sats.
//
//   succeed            payment completes immediately
//   fail-clean         clean terminal failure, genuinely not paid
//   fail-then-paid     the backend REPORTS failure but the payment landed -
//                      the hodl-invoice shape confirm-before-restore exists for
//   ambiguous-paid     the attempt errors ambiguously; it actually landed
//   ambiguous-unpaid   the attempt errors ambiguously; it genuinely failed
//   ambiguous-pending  the attempt errors ambiguously and stays unresolved
//                      until control.resolvePayment is called

export type FakePayMode =
  | 'succeed'
  | 'fail-clean'
  | 'fail-then-paid'
  | 'ambiguous-paid'
  | 'ambiguous-unpaid'
  | 'ambiguous-pending'

type PaymentRecord = {status: 'complete' | 'failed' | 'pending'; preimageHex: string | null}

export type FakeBackend = LightningBackend & {
  control: {
    // Marks a mint invoice paid, as the payer's wallet would.
    settleInvoice(paymentHashHex: string): void
    setPayMode(mode: FakePayMode): void
    // Resolves an ambiguous-pending payment after the fact.
    resolvePayment(paymentHashHex: string, status: 'complete' | 'failed'): void
    // Lets a test register the true preimage of an invoice this backend is
    // about to "pay", so settlement proofs round-trip.
    registerPaymentPreimage(paymentHashHex: string, preimageHex: string): void
    // Plants a payment somebody ELSE made through this node - the
    // shared-funding-source shape the melt pre-check exists for.
    seedForeignPayment(paymentHashHex: string, status?: 'complete' | 'pending'): void
    invoiceByHash(paymentHashHex: string): {preimageHex: string; amountMsat: number; settled: boolean} | undefined
  }
}

export const createFakeBackend = (): FakeBackend => {
  const invoices = new Map<string, {preimageHex: string; amountMsat: number; settled: boolean}>()
  const payments = new Map<string, PaymentRecord>()
  const knownPreimages = new Map<string, string>()
  let payMode: FakePayMode = 'succeed'

  return {
    name: 'fake',

    async createInvoice({amountMsat, preimageHex, memo}) {
      const paymentHashHex = bytesToHex(sha256(hexToBytes(preimageHex)))
      const pr = fakeBolt11({amountMsat, paymentHashHex, memo})
      invoices.set(paymentHashHex, {preimageHex, amountMsat, settled: false})
      return {pr}
    },

    async payInvoice({pr}) {
      const paymentHashHex = bolt11PaymentHash(pr)
      if (!paymentHashHex) throw new PaymentFailedError('That is not a decodable invoice.')
      // Real nodes dedupe sends by payment hash: a hash this node already
      // holds a payment for is refused, exactly as lnd and cln refuse it.
      if (payments.has(paymentHashHex)) {
        throw new PaymentAlreadyKnownError('this node already has a payment for that hash')
      }
      const preimageHex = knownPreimages.get(paymentHashHex) ?? null
      switch (payMode) {
        case 'succeed':
          payments.set(paymentHashHex, {status: 'complete', preimageHex})
          return {preimageHex, feeMsat: 0}
        case 'fail-clean':
          payments.set(paymentHashHex, {status: 'failed', preimageHex: null})
          throw new PaymentFailedError('Could not find a route to pay this invoice.')
        case 'fail-then-paid':
          payments.set(paymentHashHex, {status: 'complete', preimageHex})
          throw new PaymentFailedError('Timed out trying to find a route to pay this invoice.')
        case 'ambiguous-paid':
          payments.set(paymentHashHex, {status: 'complete', preimageHex})
          throw new Error('connection reset mid-payment')
        case 'ambiguous-unpaid':
          payments.set(paymentHashHex, {status: 'failed', preimageHex: null})
          throw new Error('connection reset mid-payment')
        case 'ambiguous-pending':
          payments.set(paymentHashHex, {status: 'pending', preimageHex})
          throw new Error('connection reset mid-payment')
      }
    },

    async isPaymentComplete(paymentHashHex) {
      const payment = payments.get(paymentHashHex)
      if (!payment) return false
      if (payment.status === 'pending') {
        throw new PaymentPendingError('the payment has no terminal outcome yet')
      }
      return payment.status === 'complete'
    },

    async isInvoiceSettled(paymentHashHex) {
      return invoices.get(paymentHashHex)?.settled ?? false
    },

    async invoicePreimage(paymentHashHex) {
      const invoice = invoices.get(paymentHashHex)
      return invoice?.settled ? invoice.preimageHex : null
    },

    async paymentPreimage(paymentHashHex) {
      const payment = payments.get(paymentHashHex)
      return payment?.status === 'complete' ? payment.preimageHex : null
    },

    async nodeInfo(): Promise<NodeInfo> {
      return {alias: 'moneyer (fake funding source)', color: '#c9ced8'}
    },

    control: {
      settleInvoice(paymentHashHex) {
        const invoice = invoices.get(paymentHashHex)
        if (!invoice) throw new Error(`no fake invoice for ${paymentHashHex}`)
        invoice.settled = true
      },
      setPayMode(mode) {
        payMode = mode
      },
      resolvePayment(paymentHashHex, status) {
        const payment = payments.get(paymentHashHex)
        if (!payment) throw new Error(`no fake payment for ${paymentHashHex}`)
        payment.status = status
      },
      registerPaymentPreimage(paymentHashHex, preimageHex) {
        knownPreimages.set(paymentHashHex, preimageHex)
        const payment = payments.get(paymentHashHex)
        if (payment?.status === 'complete') payment.preimageHex = preimageHex
      },
      seedForeignPayment(paymentHashHex, status = 'complete') {
        payments.set(paymentHashHex, {status, preimageHex: null})
      },
      invoiceByHash(paymentHashHex) {
        return invoices.get(paymentHashHex)
      }
    }
  }
}
