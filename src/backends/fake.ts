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

// Long enough that an unpaid invoice reads as unpaid to anything looking
// at it in the same breath it was issued, short enough that nobody
// developing against a dev mint notices the wait.
export const DEFAULT_AUTO_SETTLE_AFTER_MS = 1_500

// An invoice is paid if something paid it, or if autoSettle's moment has
// arrived. Read rather than scheduled: no timer to leak when a mint is
// closed, and a test that fakes the clock sees the same answer.
const isSettled = (
  invoice: {settled: boolean; settleAt: number | null} | undefined
): boolean => {
  if (!invoice) return false
  if (invoice.settled) return true
  return invoice.settleAt !== null && Date.now() >= invoice.settleAt
}

type PaymentRecord = {
  status: 'complete' | 'failed' | 'pending'
  preimageHex: string | null
  // What the caller asked to send, for an invoice that states no amount.
  amountMsat: number | null
}

export type FakeBackendOptions = {
  // Mint invoices settle on their own a moment after they are issued, as
  // if a payer had paid them promptly.
  //
  // Without this a fake mint can issue invoices and nothing can ever pay
  // one: settlement is only reachable through `control.settleInvoice`,
  // which is an in-process handle a test holds. A wallet talking to a
  // standalone `MONEYER_BACKEND=fake` mint over HTTP therefore mints
  // nothing, holds no notes, and cannot exercise a single thing that
  // needs one - splitting, merging, melting, sending. Off by default so
  // the tests that drive settlement by hand keep their exact timing.
  autoSettle?: boolean
  // How long after issuing an invoice `autoSettle` treats it as paid.
  //
  // Not zero, and the difference matters. Settling at the instant of
  // issuance makes the mint claim an invoice nobody has paid is already
  // settled, which is indistinguishable on the wire from a mint that
  // hands out a note before it has been paid for - the conformance
  // grader fails it on exactly that, and rightly. A short delay keeps
  // "nothing has paid this yet" true for as long as it really is true,
  // and a wallet still mints without waiting on anything a human has to
  // do. A fast payer, rather than one that pays before being asked.
  autoSettleAfterMs?: number
}

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
    // What was sent for a payment, when the invoice named no amount and
    // the mint chose. Null when the invoice named one.
    sentAmountMsat(paymentHashHex: string): number | null | undefined
    // What this pretend node says it can pay out with, for the coverage
    // ratio. Under-coverage is a state the mint has to render honestly,
    // so a test must be able to ask for it.
    setLocalBalanceMsat(msat: number | undefined): void
  }
}

// One bitcoin, so a development mint covers anything it is likely to mint.
export const FAKE_LOCAL_BALANCE_MSAT = 100_000_000_000

export const createFakeBackend = (options: FakeBackendOptions = {}): FakeBackend => {
  const autoSettle = options.autoSettle === true
  const autoSettleAfterMs = options.autoSettleAfterMs ?? DEFAULT_AUTO_SETTLE_AFTER_MS
  // `settleAt` is when autoSettle starts calling this invoice paid; null
  // for an invoice only control.settleInvoice can settle, which is every
  // invoice unless autoSettle is on.
  const invoices = new Map<string, {preimageHex: string; amountMsat: number; settled: boolean; settleAt: number | null}>()
  const payments = new Map<string, PaymentRecord>()
  const knownPreimages = new Map<string, string>()
  let localBalanceMsat: number | undefined = FAKE_LOCAL_BALANCE_MSAT
  let payMode: FakePayMode = 'succeed'

  return {
    name: 'fake',

    async createInvoice({amountMsat, preimageHex, memo}) {
      const paymentHashHex = bytesToHex(sha256(hexToBytes(preimageHex)))
      const pr = fakeBolt11({amountMsat, paymentHashHex, memo})
      invoices.set(paymentHashHex, {
        preimageHex,
        amountMsat,
        settled: false,
        settleAt: autoSettle ? Date.now() + autoSettleAfterMs : null
      })
      return {pr}
    },

    async payInvoice({pr, amountMsat}) {
      const paymentHashHex = bolt11PaymentHash(pr)
      if (!paymentHashHex) throw new PaymentFailedError('That is not a decodable invoice.')
      // Real nodes dedupe sends by payment hash: a hash this node already
      // holds a payment for is refused, exactly as lnd and cln refuse it.
      if (payments.has(paymentHashHex)) {
        throw new PaymentAlreadyKnownError('this node already has a payment for that hash')
      }
      const preimageHex = knownPreimages.get(paymentHashHex) ?? null
      const sentMsat = amountMsat ?? null
      switch (payMode) {
        case 'succeed':
          payments.set(paymentHashHex, {status: 'complete', preimageHex, amountMsat: sentMsat})
          return {preimageHex, feeMsat: 0}
        case 'fail-clean':
          payments.set(paymentHashHex, {status: 'failed', preimageHex: null, amountMsat: sentMsat})
          throw new PaymentFailedError('Could not find a route to pay this invoice.')
        case 'fail-then-paid':
          payments.set(paymentHashHex, {status: 'complete', preimageHex, amountMsat: sentMsat})
          throw new PaymentFailedError('Timed out trying to find a route to pay this invoice.')
        case 'ambiguous-paid':
          payments.set(paymentHashHex, {status: 'complete', preimageHex, amountMsat: sentMsat})
          throw new Error('connection reset mid-payment')
        case 'ambiguous-unpaid':
          payments.set(paymentHashHex, {status: 'failed', preimageHex: null, amountMsat: sentMsat})
          throw new Error('connection reset mid-payment')
        case 'ambiguous-pending':
          payments.set(paymentHashHex, {status: 'pending', preimageHex, amountMsat: sentMsat})
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
      return isSettled(invoices.get(paymentHashHex))
    },

    async invoicePreimage(paymentHashHex) {
      const invoice = invoices.get(paymentHashHex)
      return isSettled(invoice) ? invoice!.preimageHex : null
    },

    async paymentPreimage(paymentHashHex) {
      const payment = payments.get(paymentHashHex)
      return payment?.status === 'complete' ? payment.preimageHex : null
    },

    async nodeInfo(): Promise<NodeInfo> {
      return {
        alias: 'moneyer (fake funding source)',
        color: '#c9ced8',
        ...(localBalanceMsat !== undefined ? {localBalanceMsat} : {})
      }
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
        payments.set(paymentHashHex, {status, preimageHex: null, amountMsat: null})
      },
      sentAmountMsat(paymentHashHex) {
        const payment = payments.get(paymentHashHex)
        return payment ? payment.amountMsat : undefined
      },
      setLocalBalanceMsat(msat) {
        localBalanceMsat = msat
      },
      invoiceByHash(paymentHashHex) {
        const invoice = invoices.get(paymentHashHex)
        // `settled` here answers "is it paid now", so autoSettle's moment
        // counts. A caller reading the stored flag would see false for an
        // invoice the mint itself treats as paid.
        return invoice && {...invoice, settled: isSettled(invoice)}
      }
    }
  }
}
