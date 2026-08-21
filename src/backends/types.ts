// The funding source. Every amount is integer milli-satoshis.
//
// The one non-negotiable capability is createInvoice with a CALLER-SUPPLIED
// preimage: a LUD-25 mint invoice's preimage IS the bearer note's spend
// secret, so the mint must know it for certain before the invoice exists.
// lnd (r_preimage) and cln (invoice preimage=) support this; phoenixd and
// NIP-47 make_invoice do not, which is why neither can back a mint.

export type NodeInfo = {
  alias?: string
  uri?: string
  color?: string
  // Best-effort node statistics for the discovery endpoint; a backend that
  // cannot answer cheaply just leaves these out.
  capacityMsat?: number
  numChannels?: number
  numPeers?: number
  // What the node can actually pay out with: the sum of local balances
  // over usable channels. This is the number a coverage ratio is built
  // from, so a backend that cannot answer must leave it out rather than
  // guess low.
  localBalanceMsat?: number
}

export type PaymentOutcome = {
  // The paid invoice's settlement preimage. Real backends always report
  // one; the fake backend has no payee to learn one from and reports null.
  preimageHex: string | null
  feeMsat: number | null
}

// The funding source's immediate answer to the payment attempt was a clean,
// terminal failure - no route, rejected, expired. Distinct from a dropped
// connection or timeout, where the payment may still have gone out. Even
// this "clean" failure is only trusted after isPaymentComplete confirms it:
// a malicious payee holding a hodl invoice can make a backend report
// failure while an HTLC it already sent stays locked.
export class PaymentFailedError extends Error {}

// The payment (or the query about it) has no terminal answer yet. Never to
// be read as "not paid".
export class PaymentPendingError extends Error {}

// The funding source already holds a payment for this hash that THIS call
// did not create - on a shared node, another mint (or the operator) paid
// it. Nothing went out on our behalf, so the caller's melt is safely
// restorable; confirming by hash would confirm against foreign money.
export class PaymentAlreadyKnownError extends Error {}

export interface LightningBackend {
  readonly name: string
  // `descriptionForHash`, when given, is what the invoice commits to via
  // its description hash (LUD-06 metadata, or a NIP-57 zap request) in
  // place of the plain memo.
  createInvoice(args: {amountMsat: number; preimageHex: string; memo: string; descriptionForHash?: string}): Promise<{pr: string}>
  // Throws PaymentFailedError on a clean terminal failure, anything else on
  // an ambiguous one.
  payInvoice(args: {pr: string; feeLimitMsat: number}): Promise<PaymentOutcome>
  // True/false only on a genuinely terminal answer; throws
  // PaymentPendingError while the outcome is still open.
  isPaymentComplete(paymentHashHex: string): Promise<boolean>
  isInvoiceSettled(paymentHashHex: string): Promise<boolean>
  // Fetched live from the funding source, never cached here: for a mint
  // invoice this preimage is the bearer secret itself.
  invoicePreimage(paymentHashHex: string): Promise<string | null>
  paymentPreimage(paymentHashHex: string): Promise<string | null>
  nodeInfo?(): Promise<NodeInfo>
  close?(): void | Promise<void>
}
