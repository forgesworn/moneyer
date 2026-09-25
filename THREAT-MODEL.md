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
burned k1 answers `Invalid or already spent k1.` atomically. And every
LNURL endpoint answers GET only, so a preflight or any other non-GET
request carrying a callback's query string cannot mutate anything.

**A holder inflating a merge or split with a repeated k1.** Duplicated k1
parameters in one request are refused outright; they would otherwise count
one note's value twice into the output. The check is on the note each k1
spends, its Q, not on the k1 string: one note has many valid spends (a
bearer note's preimage and its full `cw1`, the key owner's fresh `ck1`s,
the deprecated `ck1` shapes a wallet may still hold). The store refuses a note named twice
among a swap's inputs as well, so the rule does not rest on the handler
alone.

**A holder claiming an output id that already exists.** An output (`p1`,
`p2`, or a mint comment) may not name a Q that is already a note, spent or
not, or that a payer has bought by naming it, and gets LUD-25's
`already in use`. Nor may it name the bearer note a mint invoice's payment
preimage would open: `/verify` hands that preimage out, so minting there
would point money at a note anyone who saw the invoice can spend. A note
written before notes were keyed by Q is protected the same way through
`legacy_ids`, so its preimage never opens two notes.

**A payment preimage that opens a note.** Every preimage is also the spend
of the bearer note whose h is its payment hash, and a preimage reaches the
funding source, every hop and `/verify`. So a quote is refused, before any
invoice is shown, if its payment hash is the h of this quote's own note or
of any note on file, whoever chose the preimage.

**A spend replayed at another mint.** A `ck1` signs the sighash of LUD-25's
canonical spend transaction, whose prevout commits to the mint's domain,
so a key-path spend one mint has seen cannot be used at another. Moneyer
accepts a signature bound to any of its own hosts, clearnet or onion, and
nothing else. The deprecated `ck1` shapes are not bound to any mint; they
are still accepted, as the reference mint accepts them, so that notes
already handed out stay redeemable, and they should be retired once none
are expected to remain.

**A leaf that succeeds for anyone.** Tapscript keeps upgrade hooks that
consensus accepts unconditionally: unknown leaf versions and `OP_SUCCESSx`
opcodes. A `cw1` using either is refused before anything runs, as LUD-25
requires; otherwise a note locked to such a leaf would be spendable by
whoever saw it.

**Timelocks.** A `cw1` carries a signed `nLockTime`/`nSequence`, and the
mint checks them against its own clock: Unix times only, relative locks
counted from when it credited the note. That is the mint asserting its
clock, a custodial policy and not a consensus guarantee, and must never be
described as trustless.

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
(the preimage) whenever the note was minted the old way, at the invoice's
payment hash. It is only served once the funding source reports
settlement, is fetched live rather than cached, and has a real off switch
(`MONEYER_VERIFY=0` makes it a 404). Anyone who saw the unpaid invoice can
poll it, which is why wallets must rotate immediately on claim - stated in
the spec and enforced by the companion wallet.

The durable answer is for the wallet to name the note it is buying (`h` on
the pay callback, see the README). The note is then credited at a secret
only the buyer ever held, the preimage is bearer material for nothing, and
what `/verify` serves is an ordinary payment proof. Wallets should prefer
that path wherever a mint advertises `mintToHash`.

**What a `cx1` on a name gives away.** A name with a watch-only branch is
paid to the holder's keys, so the mint never holds a secret for those notes.
But the mint can work out every key on the branch, so it can link every
payment to that name, and see when each note is spent. That is no more than
a custodial name already reveals. A wallet should keep the branch for
receiving and rotate what arrives onto keys the mint cannot enumerate, which
is what notecase and lnurl-wallet do.

## Out of scope

- Compromise of the host or the funding source credentials: at that point
  the attacker IS the mint.
- Lightning-level attacks against the funding source (channel jamming,
  probing) - the node's own concern.
- TLS termination: moneyer expects a reverse proxy in production and binds
  to loopback by default.

## Known limitations

- A script-path spend whose leaf is not a bearer hashlock can only be
  judged by a tapscript interpreter, which moneyer does not contain. Without
  a `scriptVerifier` such spends are refused and the note waits; a mint
  cannot tell a script note from a key note when it is credited, since Q
  is opaque, so it cannot refuse one up front either.
- The cln and lnd backends are unexercised against live nodes (direct
  ports of the reference mint's logic). Run `--dev` traffic and the
  conformance grader against a staging deployment before taking real money.
- No rate limiting is built in; put it at the proxy. This matters most for
  `/p/cb`: each unauthenticated call creates a real invoice at the funding
  source. moneyer sweeps its own unsettled invoices once their bolt11
  expiry has passed, but the node's side of that growth is the operator's
  to bound (cln's autoclean, or an equivalent cron) - and a proxy limit is
  what keeps the RPC pile-up and the node database from growing at all.
- A fee-free configuration pays the melt routing-fee floor (0.5% of the
  amount or 5000 msat) out of its own channel balance, and mint-and-melt
  cycling costs a griefer nothing. Set `MONEYER_BASE_FEE_MSAT` to cover the
  floor before taking real traffic.
- `node:sqlite` is a single-writer store; moneyer is a single-process
  service by design. Do not run two instances against one database.
