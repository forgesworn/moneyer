# Threat model

moneyer holds other people's money as bearer liabilities. The store keeps
note ids (hashes), amounts and states; the spend secrets exist only as
invoice preimages at the funding source and in holders' wallets.

## Assets

- The outstanding note set: every `outstanding` row is money owed to
  whoever holds its secret.
- The funding source credentials (rune or macaroon): full spending power
  over the mint's liquidity.
- The mint signing key: whoever holds it can issue "verified" notes.

## Adversaries and defences

**A holder replaying or racing mutations.** Every mutation validates and
transitions state in one synchronous SQLite transaction with no await
inside it; two concurrent callbacks for the same k1 cannot both win. A
burned k1 answers `Invalid or already spent k1.` atomically.

**A holder inflating a merge or split with a repeated k1.** Duplicated k1
parameters in one request are refused outright; they would otherwise count
one note's value twice into the output.

**A holder claiming an output id that already exists.** `h`/`h2` may not
collide with any existing note OR any mint invoice's payment hash, settled
or not. The invoice case is the subtle one: `/verify` hands a settled mint
invoice's preimage to its payer, and that preimage is the k1 of whatever
note carries the hash as its id - minting "over" such an id would point a
future payer's money at a stranger's note.

**A holder melting into the mint's own invoice.** Refused synchronously:
paying it would route the funding source's money at itself, which real
nodes handle inconsistently.

**A holder reusing an invoice across melts.** Refused: the funding source
dedupes payments by hash, so the second melt would be "confirmed" against
the first payment and burn a note without moving funds.

**A holder replaying a melt across mints sharing one funding source.**
Sharing a node between mints is a supported deployment, and it creates a
dedupe gap no mint's own tables can see: an invoice melted at mint A is
unknown to mint B, whose confirm-by-hash would read A's completed payment
as its own success and burn B's note with no funds moving. Closed twice
over: the melt callback synchronously asks the NODE whether it ever paid
(or is still paying) the hash and refuses if so, and if the foreign
payment lands in the race between that check and the send, the node's own
"payment already exists" refusal is surfaced as a distinct
PaymentAlreadyKnownError and the note restores - nothing went out on this
mint's behalf, so nothing is guessed. Do not share a funding source with
a mint implementation that lacks the equivalent guard: its side of the
same replay stays open.

**A malicious payee holding a hodl invoice.** A clean failure report from
the funding source is never trusted on its own: the note restores only
once `isPaymentComplete` returns a terminal false. A payment stuck
in-flight leaves the note pending rather than restorable - the alternative
is letting the holder melt the same value twice.

**A funding source lying about an invoice.** The invoice returned by
`createInvoice` is decoded and must commit to the preimage moneyer chose
and the amount requested, or it is never handed out - otherwise a payer's
money would mint an unclaimable note.

**Process death.** Melts are journalled before payment; reconciliation
runs at startup and on demand, resolving pending melts by asking the
funding source, never by assumption.

**The verify endpoint as an oracle.** `/verify` serves bearer material
(the preimage). It is only served once the funding source reports
settlement, is fetched live rather than cached, and has a real off switch
(`MONEYER_VERIFY=0` makes it a 404). Anyone who saw the unpaid invoice can
poll it, which is why wallets must rotate immediately on claim - stated in
the spec and enforced by the companion wallet.

## Out of scope

- Compromise of the host or the funding source credentials: at that point
  the attacker IS the mint.
- Lightning-level attacks against the funding source (channel jamming,
  probing) - the node's own concern.
- TLS termination: moneyer expects a reverse proxy in production and binds
  to loopback by default.

## Known limitations

- The cln and lnd backends are unexercised against live nodes (direct
  ports of the reference mint's logic). Run `--dev` traffic and the
  conformance grader against a staging deployment before taking real money.
- No rate limiting is built in; put it at the proxy.
- `node:sqlite` is a single-writer store; moneyer is a single-process
  service by design. Do not run two instances against one database.
