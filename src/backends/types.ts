// The funding source. Every amount is integer milli-satoshis.
//
// A backend MAY accept a caller-supplied invoice preimage, and Moneyer uses
// one where it can: knowing the payment hash before the invoice exists lets it
// prove the BOLT-11 it got back is the one it asked for. That is a nicety, not
// a requirement. The bearer note is keyed by the wallet's mandatory comment
// commitment, never by the payment preimage, so a funding source whose node
// chooses its own preimages can back a mint perfectly well - see
// `acceptsInvoicePreimage`.

export type NodeInfo = {
  alias?: string
  uri?: string
  // Every address this node announces, each already "node_key@host:port".
  // `uri` is the first of these and stays the one-address answer; a node
  // behind Tor as well as clearnet has more than one, and publishing only
  // the first tells a peer to dial the door it may not be able to reach.
  // Omitted rather than empty when the node announces nothing at all.
  uris?: string[]
  color?: string
  // Best-effort node statistics for the discovery endpoint; a backend that
  // cannot answer cheaply just leaves these out.
  //
  // capacityMsat is *publicly announced* capacity only. It goes out in the
  // discovery document, so it must never carry what an authenticated view
  // of the node can see and the rest of the network cannot - a private
  // channel's size is the operator's business.
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
  // Whether createInvoice honours `preimageHex`.
  //
  // True for backends that let the caller pick (cln, lnd), and Moneyer then
  // knows the payment hash before the invoice exists and refuses any invoice
  // that does not commit to it. False for a node that mints its own preimages
  // (phoenixd, NIP-47 `make_invoice`); Moneyer reads the hash back off the
  // returned invoice and checks what it can after the fact instead.
  //
  // This used to be the capability a mint could not exist without, because an
  // earlier LUD-25 draft keyed the bearer note by the payment preimage. That
  // draft is gone: a preimage reaches every node that forwarded the payment,
  // so keying money by one was always the wrong shape, and the current draft
  // binds the note to a secret only the wallet ever sees.
  readonly acceptsInvoicePreimage: boolean
  // `descriptionForHash`, when given, is what the invoice commits to via
  // its description hash (LUD-06 metadata, or a NIP-57 zap request) in
  // place of the plain memo.
  // `preimageHex` is supplied only when `acceptsInvoicePreimage` is true, and
  // a backend that declares false MUST ignore it rather than fail.
  createInvoice(args: {
    amountMsat: number
    preimageHex?: string
    memo: string
    descriptionForHash?: string
  }): Promise<{pr: string}>
  // Throws PaymentFailedError on a clean terminal failure, anything else on
  // an ambiguous one.
  //
  // `amountMsat` is given only for an invoice that states no amount of its
  // own, where the payer chooses. A backend must send exactly it, and must
  // never apply it to an invoice that does carry an amount.
  payInvoice(args: {pr: string; feeLimitMsat: number; amountMsat?: number}): Promise<PaymentOutcome>
  // True/false only on a genuinely terminal answer; throws
  // PaymentPendingError while the outcome is still open.
  isPaymentComplete(paymentHashHex: string): Promise<boolean>
  isInvoiceSettled(paymentHashHex: string): Promise<boolean>
  // Fetched live from the funding source, never cached here. Current mint
  // invoices use it as settlement proof; only historical unnamed invoices
  // also used it as the bearer secret.
  invoicePreimage(paymentHashHex: string): Promise<string | null>
  paymentPreimage(paymentHashHex: string): Promise<string | null>
  nodeInfo?(): Promise<NodeInfo>
  close?(): void | Promise<void>
}
