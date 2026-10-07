# An LDK funding source for moneyer: design

Status: design only, nothing built. Written 2026-10-07 for review before any
code exists.

The idea: a small Rust process (the "sidecar") embeds the `ldk-node` crate and
exposes a minimal local HTTP API, and a new moneyer backend (`ldk`) talks to it
the way `lnd.ts` talks to lnd's REST proxy. moneyer itself stays TypeScript
and keeps its melt discipline unchanged.

## Sources

Every claim about ldk-node, LDK or dni's mint below cites one of these:

- **ldk-node 0.7.0**, the crate source from crates.io (released 2025-12-03,
  `CHANGELOG.md`; it is still the newest release on crates.io). It is the
  version dni's mint pins (`Cargo.lock`). Cited as `ldk-node src/...`.
- **lightning 0.2.7** (LDK), as pinned in dni's `Cargo.lock`. Cited as
  `lightning src/...`. `lightning-background-processor 0.2.3` likewise.
- **dni's lnurl-mint-rust at e91b8f2** ("feat: use ldk-node"), read with
  `git show origin/main:<path>`. Cited as `lnurl-mint-rust:<path>`.
- **moneyer at b09553e** (0.19.0). Cited by repository path.
- **LDK Server's README** on GitHub `main`, read 2026-10-07.
- The operator's private deployment notes, for facts about the live box.
  Nothing from them here is checked against the box itself: this design was
  written without logging in to anything.

Nothing in this document was built or run. Statements about runtime
behaviour are read from source, and several are marked as needing a regtest
proof before anything relies on them.

## Status of the pieces, stated as they are

- ldk-node is pre-1.0 (0.7.0). Its README and crate docs make no production
  claim either way. Within it, splicing is "experimental"
  (`ldk-node CHANGELOG.md`, `src/lib.rs:1250`), the LSPS2 *service* is
  "alpha" (`ldk-node src/builder.rs:476-479`) and the VSS storage backend is
  "alpha ... may cause LDK to panic if persistence failures are
  unrecoverable" (`ldk-node src/builder.rs:624-626`). The LSPS2 *client*,
  which is what this design would use, carries no such label.
- LDK Server, the off-the-shelf daemon over ldk-node, says of itself: "LDK
  Server is still under active development and is not ready for production
  use. Until the v0.1 release, the persisted data model may change in
  non-backwards-compatible ways. Do not run it with funds you cannot afford to
  lose." (README). Whether its gRPC API exposes manual claims
  (`receive_for_hash`/`claim_for_hash`) was not checked.
- dni's own PLAN.md, before the switch, recommended raw LDK over ldk-node
  because ldk-node "owns the event loop and payment store" and raw LDK gives
  "exact control over claim decisions and payment ids"
  (`lnurl-mint-rust:PLAN.md`, "Risks and open questions"). The switch happened
  anyway, the same day this was written. Section 1 shows that the payment
  store concern is real.

---

## 1. The sidecar API and moneyer's `ldk` backend

### Shape

The sidecar listens on `127.0.0.1` only, behind a bearer token read from a
file (the same pattern as lnd's macaroon header). No TLS on loopback. Every
amount is integer msat, every hash is lowercase hex, as in `types.ts`.

moneyer gets `MONEYER_BACKEND=ldk`, `MONEYER_BACKEND_URL`,
`MONEYER_BACKEND_TOKEN`, a `kind: 'ldk'` arm in `src/config.ts` and
`src/admin.ts`'s `backendFor`, and a new `src/backends/ldk.ts`. `melt.ts`,
`server.ts` and `zap.ts` do not change under Design A (section 2).

Operator functions (fund, open, close, bootstrap an LSP channel, send on-chain)
belong on a separate CLI or Unix socket, as dni does with `lnurl-mint-cli`
(`lnurl-mint-rust:README.md`, "Admin CLI"). moneyer never calls them.

### Endpoints, one per `LightningBackend` method

**`POST /v1/invoices`** (`createInvoice`)

```json
{"amountMsat": 100000, "preimageHex": "<64 hex>", "memo": "LNURLcash mint at moneyer.dev"}
{"amountMsat": 21000, "preimageHex": "<64 hex>", "descriptionHashHex": "<64 hex>"}
```

The client hashes `descriptionForHash` itself, as `lnd.ts` does, and sends
only the hash. Answers:

- `200 {"pr": "lnbc...", "paymentHash": "<hex>"}`
- `409 {"error": "hash_in_use"}` if the sidecar already holds an invoice or a
  payment for that hash
- `503 {"error": "not_running"}`

moneyer keeps its own after-the-fact checks: the decoded amount and payment
hash must match what it asked for (`server.ts` 896-907, `zap.ts` 244-247).

**`POST /v1/payments`** (`payInvoice`)

```json
{"pr": "lnbc...", "feeLimitMsat": 5000}
{"pr": "lnbc1...", "feeLimitMsat": 5000, "amountMsat": 12000}
```

`amountMsat` is present only for an amountless invoice, and selects
`send_using_amount` instead of `send` (`ldk-node src/payment/bolt11.rs:189`).
`feeLimitMsat` becomes `RouteParametersConfig.max_total_routing_fee_msat`, as
dni does (`lnurl-mint-rust:src/ln/mod.rs:452-455`).

ldk-node's `send` returns as soon as the payment is handed to LDK; the outcome
arrives later as an event (`ldk-node src/payment/bolt11.rs:116-142`). So the
handler waits for this hash's terminal event, up to a bound (60 s, under the
client's 90 s transport timeout), and answers one of:

| Answer | Meaning | Client throws / returns |
|---|---|---|
| `200 {"status":"succeeded","preimageHex","feeMsat"}` | `PaymentSuccessful` event | returns `PaymentOutcome` |
| `200 {"status":"failed","sent":false,"reason"}` | refused before anything left (below) | `PaymentFailedError(reason)` |
| `200 {"status":"failed","sent":true,"reason"}` | LDK's `PaymentFailed` event | `PaymentFailedError(reason)` |
| `200 {"status":"pending"}` | no terminal event within the bound | plain `Error` (ambiguous) |
| `409 {"error":"already_known"}` | `DuplicatePayment`, or a late request (below) | `PaymentAlreadyKnownError` |
| anything else, transport error | unknown | plain `Error` (ambiguous) |

Every `PaymentFailedError` is still only a report: `melt.ts` confirms through
`isPaymentComplete` before restoring anything, exactly as with lnd and cln.

**`GET /v1/payments/{hash}`** (`isPaymentComplete`, `paymentPreimage`)

`200 {"status": "succeeded" | "failed" | "pending" | "unknown" | "unresolved", "preimageHex"?, "feeMsat"?}`.
`succeeded` gives `true`, `failed` and `unknown` give `false`, `pending` and
`unresolved` throw `PaymentPendingError`. `paymentPreimage` returns the
preimage only for `succeeded`, after checking it hashes to `{hash}` (as
`lnd.ts` does with `verifyPreimage`).

**`GET /v1/invoices/{hash}`** (`isInvoiceSettled`, `invoicePreimage`)

`200 {"status": "unpaid" | "claiming" | "settled" | "failed" | "unknown", "preimageHex"?}`.
`settled` gives `true`; `unpaid`, `failed` and `unknown` give `false`;
`claiming` (an HTLC is held and the claim has not completed) throws, because
the expiry sweep deletes a row on `false` and this is no answer yet (the same
rule `lnd.ts` 176-183 states). The preimage is returned only for `settled`.

**`GET /v1/info`** (`nodeInfo`) returns the `NodeInfo` shape directly:

- `uris` from `announcement_addresses()`
- `alias` from `node_alias()`
- no `color` (ldk-node has none; dni leaves it out too, `lnurl-mint-rust:src/ln/mod.rs:503`)
- `numPeers` from connected peers
- `numChannels` from usable channels
- `capacityMsat` summed over announced channels only, so nothing private
  leaks (`types.ts` 23-29; dni does the same, `src/ln/mod.rs:506-513`)
- `localBalanceMsat` summed from `outbound_capacity_msat` over usable channels

### The sidecar's own ledger

ldk-node's payment store cannot be the sole source of truth for melts, for
three reasons found in its source:

1. **A crash window with no record.** `send` calls `pay_for_bolt11_invoice`
   and only afterwards inserts the payment as `Pending`
   (`ldk-node src/payment/bolt11.rs:116-142`). A crash between the two leaves
   a payment LDK may have sent with no row in the store. ldk-node's
   `PaymentSent` and `PaymentFailed` handlers tolerate a missing row and still
   emit the event (`ldk-node src/event.rs:1020-1110`), but `node.payment()`
   reads "absent", and absent is what lnd's 404 means: "never attempted, safe
   to restore". Answering from the store alone would restore a paid note.
2. **Status is not sticky.** LDK warns that "in exceedingly rare cases" a
   `PaymentFailed` can follow a `PaymentSent` and "MUST be ignored"
   (`lightning src/events/mod.rs:1077-1080`). ldk-node's store update writes
   the new status unconditionally (`ldk-node src/payment/store.rs:281`), so
   `Succeeded` can become `Failed`. The preimage written by `PaymentSent`
   stays set.
3. **An inbound HTLC can mark an outbound payment `Failed`.** When an inbound
   payment arrives whose hash matches an *outbound* entry, ldk-node fails the
   inbound HTLC back and sets that payment's status to `Failed`
   (`ldk-node src/event.rs:647-663`). Reading the source, a hodl-invoice payee
   who holds our HTLC knows the preimage and could send a keysend with it to
   the mint's node, turning our still-in-flight melt to `Failed` in the store.
   That is the hodl-invoice attack `melt.ts` exists to stop. This is inferred
   from source and **must be proved or disproved on regtest** (section 8).

So the sidecar keeps a small SQLite ledger of its own (`synchronous=FULL`),
written before it acts and updated only from ldk-node's events:

- `payments(hash, state, preimage, fee_msat, reason, request_seq, updated_seq)`
  with `state` one of `attempting`, `refused`, `inflight`, `succeeded`,
  `failed`;
- `not_paid_answers(hash, answered_seq)`, explained below;
- `invoices(hash, preimage, amount_msat, expires_at, state)` for Design A.

`seq` is a counter the process keeps, monotonic across restarts.

### When "confirmed not paid" is safe to report

`GET /v1/payments/{hash}` answers `failed` (so moneyer restores) only in
three cases:

1. **Refused before anything left.** `send`/`send_using_amount` returned
   `PaymentSendingFailed`, `InvalidInvoice`, `InvalidAmount` or `NotRunning`.
   LDK finds the route before it registers the payment, and returns
   `RouteNotFound`, `PaymentExpired` or `OnionPacketSizeExceeded` only from
   that stage; any error after registration is handled internally and
   surfaces as events (`lightning src/ln/outbound_payment.rs:1494-1530`).
   `InvalidInvoice`/`InvalidAmount` return before LDK is called at all, and
   ldk-node does not record them (`ldk-node src/payment/bolt11.rs:147-152`),
   which is a second reason the ledger has to.
2. **LDK's `PaymentFailed` event**, which LDK emits "once there are no further
   pending HTLCs for the payment and the payment is no longer retryable"
   (`lightning src/events/mod.rs:1073-1076`), with no `PaymentSuccessful`
   ever recorded for the hash. Success is sticky: once `succeeded`, nothing
   moves the row back.
3. **Never attempted.** No ledger row at all, and no ldk-node store row. The
   answer is recorded in `not_paid_answers` (see the race below).

Every other combination answers `pending` or `unresolved`, never `failed`:
an `attempting` row with no event yet, an ldk-node store row reading `Failed`
with no matching `PaymentFailed` event in the ledger (reason 3 above), or an
`attempting` row that survives a restart with no store row and no event
(reason 1). `unresolved` is logged loudly for the operator; the note stays
pending, as `melt.ts` intends.

**The late-request race.** moneyer's `payInvoice` can time out while the
sidecar is still working on the request, after which `melt.ts` asks
`isPaymentComplete`. If that query finds no row and answers "never attempted",
moneyer restores the note, and the stalled request must not then send. So the
send handler, holding a per-hash lock, refuses with `already_known` any
request whose `request_seq` is older than a `not_paid_answers` entry for that
hash. A genuinely new attempt (moneyer 0.19.0 re-melting a restored invoice)
arrives after the answer and proceeds.

### Status mapping in one table

| ldk-node / LDK state, as the ledger records it | `isPaymentComplete` | Melt outcome |
|---|---|---|
| `PaymentSuccessful` event, or store row with preimage set | `true` | burn |
| refused before send (case 1) | `false` | restore |
| `PaymentFailed` event, never succeeded (case 2) | `false` | restore |
| no ledger row, no store row (case 3) | `false` | restore |
| `attempting`/`inflight`, no terminal event | `PaymentPendingError` | pending |
| store says `Failed`, no `PaymentFailed` event | `PaymentPendingError` + operator log | pending |
| `attempting` row after restart, no store row, no event | `PaymentPendingError` + operator log | pending, operator resolves |

`DuplicatePayment` from `send` means the store holds the hash as `Pending` or
`Succeeded` (`ldk-node src/payment/bolt11.rs:103-109`), or that LDK itself
still tracks the payment id. Nothing went out for *this* call, so it maps to
`PaymentAlreadyKnownError`, which restores, exactly as moneyer reads lnd's
three refusals. A hash whose earlier payment `Failed` is resendable, which
matches moneyer 0.19.0's retry of a restored melt. One caveat: LDK keeps a
finished payment id for idempotency for 7 timer ticks
(`lightning src/ln/outbound_payment.rs:54`), and the background processor
ticks every 60 s (`lightning-background-processor src/lib.rs:124`), so a
retry within roughly seven minutes of a failure may be refused as a duplicate.
The wallet then sees "use a fresh one", the note is restored, and no money is
at risk. Confirm on regtest.

---

## 2. Preimage handling, and invoices paid while something is down

### Can the mint keep choosing preimages? Yes, but the sidecar must claim

`receive_for_hash` registers a caller-chosen hash, and ldk-node then raises
`PaymentClaimable` and requires the caller to `claim_for_hash` with the
preimage, or `fail_for_hash` "immediately" if it cannot
(`ldk-node src/payment/bolt11.rs:410-437`). dni's mint does exactly this, with
the preimage derived as `HMAC(seed key, note id)` so it never stores it
(`lnurl-mint-rust:src/ln/mod.rs:392-425, 726-730`;
`src/ln/events.rs:34-61`).

moneyer cannot be the claimer. It never persists a mint invoice's preimage
("the store keeps hashes only", `server.ts` 851-853), and a zap's preimage is
a throwaway too (`zap.ts` 228-231). After a moneyer restart nobody but the
sidecar could hold it. So under either design the claim happens inside the
sidecar process.

**Design A (recommended): `acceptsInvoicePreimage: true`.**

- moneyer passes `preimageHex`, as it does to lnd today.
- The sidecar inserts `{hash, preimage, amount, expires_at}` into its ledger
  *before* calling `receive_for_hash`, and deletes the row if that call fails.
- On `PaymentClaimable` it looks the hash up and calls `claim_for_hash`.
  ldk-node itself checks the preimage against the hash and refuses an amount
  below the invoice's (`ldk-node src/payment/bolt11.rs:307-357`). With no row,
  or on any claim error, it calls `fail_for_hash`.
- It acknowledges the event (`event_handled`) only after its ledger write
  commits, as dni does (`lnurl-mint-rust:src/ln/events.rs:16-30`). An
  unacknowledged event is replayed, across restarts too
  (`lightning src/events/mod.rs`, `PaymentClaimable`, "Failure Behavior and
  Persistence").
- After the claim, ldk-node's own store carries the preimage as well
  (`ldk-node src/event.rs:922-960`), so `invoicePreimage` can answer from
  either table.

This is lnd's behaviour (lnd stores `r_preimage` and settles on its own), which
moneyer's sweep, `/verify` and `resolveNote` are already built around.
`zap.ts` and the `server.ts` pre-chosen path are untouched.

Design A's extra risk is the sidecar's preimage table. Its failure mode is
bounded: no preimage means `fail_for_hash`, so the payer is refunded and no
note credits. That is a refund, not a loss. The table belongs in the backup
set (section 5).

**Design B (alternative): `acceptsInvoicePreimage: false`.** The sidecar uses
`receive()`; LDK derives the preimage statelessly, ldk-node records it in its
store at creation and claims inside its own event handler
(`ldk-node src/payment/bolt11.rs:497-511`, `src/event.rs:897-899`). moneyer's
mint path already supports a node-chosen preimage
(`test/node-chosen-preimage.test.ts`). **The zap path does not:** `zap.ts`
always passes a preimage and refuses any invoice whose hash differs
(`zap.ts` 229-247), and a backend declaring `false` must ignore the preimage
(`types.ts` 82-83). Since zap-to-note is live, B needs the node-chosen checks
of `server.ts` 908-931 ported into `zap.ts` first. B does not remove the claim
deadline risk; it only moves the claim into ldk-node's handler.

### The deadline

LDK sets `claim_deadline = earliest_expiry - HTLC_FAIL_BACK_BUFFER`
(`lightning src/ln/channelmanager.rs:7903`). `HTLC_FAIL_BACK_BUFFER` is
`CLTV_CLAIM_BUFFER + LATENCY_GRACE_PERIOD_BLOCKS` = 2 × 18 + 3 = 39 blocks
(`lightning src/chain/channelmonitor.rs:277-330`). ldk-node's invoices take
the default `min_final_cltv_expiry_delta`, which is
`MIN_FINAL_CLTV_EXPIRY_DELTA` = 39 + 3 = 42 blocks
(`lightning src/ln/channelmanager.rs:3099`; `ldk-node
src/payment/bolt11.rs:478-484` sets no delta). So the guaranteed claim window
after an HTLC arrives is only about 3 blocks, plus whatever extra the payer
added. Waiting on moneyer, or a human, is not an option. In-process claiming
is.

### Who claims, and what happens when something is down

| Situation | What happens | Money |
|---|---|---|
| moneyer down, sidecar up | The sidecar claims at once. moneyer learns of it later by asking (`resolveNote`, `/verify`, the sweep's `isInvoiceSettled` before any delete, the zap poller). | safe for mint invoices |
| Sidecar process down | No HTLC can reach a node that is offline; the payer's attempt fails at the previous hop and the payer keeps the money. | safe |
| Sidecar up, event loop stalled past the deadline | LDK fails the HTLC back itself (`lightning src/events/mod.rs:817-821`). The payer is refunded and no note credits. | safe |
| Sidecar dies while holding a claimable HTLC | `PaymentClaimable` is persisted and replayed on restart. Back before the deadline: it claims. Back after the deadline: LDK fails the HTLC back on the next block. Down past the HTLC's own expiry: the peer must go on-chain to time it out, a force close at the mint's cost in fees and channel. | payer safe, mint pays fees |
| Hard kill (SIGKILL, OOM, power) | dni reports LDK then force-closes a channel whose manager on disk is older than its monitor, "no funds will be lost" beyond fees (`lnurl-mint-rust:README.md`, "Running a node"; `PLAN.md`). | fees |

**An existing gap, independent of LDK.** The housekeeping pass that runs at
moneyer's startup deletes unsettled *zap* rows past expiry plus one hour
without asking the funding source (`zap.ts` 390-399; `server.ts` 1394-1402,
where `zap?.sweep()` runs before the zap poller has started). A zap paid while
moneyer was down for longer than that is claimed by the node, under lnd today
or the sidecar tomorrow, and its row is then deleted unminted. Mint invoices
are protected (their sweep asks `isInvoiceSettled` first); zaps are not. Worth
fixing on its own.

---

## 3. Chain and gossip

### Chain source

ldk-node supports Esplora, Electrum, bitcoind RPC and bitcoind REST
(`ldk-node src/builder.rs:328-411`). The live box has no bitcoind and lnd runs
on neutrino (operator notes), so production means Esplora or Electrum.

| Option | Who | Privacy | Notes |
|---|---|---|---|
| Public Esplora | ldk-node's default is `https://blockstream.info/api` (`ldk-node src/config.rs:42`); mempool.space also runs one, and the box already polls it for lnd's fee feed (operator notes) | The server sees the box's IP and every script and txid the node watches: wallet addresses, channel funding outputs, closes. That links the node's whole on-chain footprint to the box. | Free, rate-limited, one operator's uptime. |
| Public Electrum | various public servers | Same exposure as Esplora. | Same trade-off. |
| Self-hosted Esplora or Electrum | a pruned bitcoind plus an indexer, on another box | Private | Not on this box (RAM). A new box or volume is a recurring **cost to surface**. |

Neutrino today fetches compact filters and blocks from peers and does not
hand one server a list of the node's scripts, so any public chain source is
a privacy regression from the current setup. It also concentrates a safety
dependency: LDK's HTLC and breach handling assume a timely chain view, and a
stalled Esplora is a stalled node. ldk-node takes one chain source, not a
list. Fee estimates would come from the chain source, which would retire the
local fee-feed workaround lnd needed.

Whether ldk-node can reach Esplora or Electrum through Tor or a SOCKS proxy was
not checked.

Background sync runs every 80 s for the on-chain wallet and every 30 s for the
Lightning wallet, and fee rates refresh every 10 minutes
(`ldk-node src/config.rs:26-28`).

### Gossip

Rapid Gossip Sync (`set_gossip_source_rgs`, `ldk-node src/builder.rs:421`)
downloads the graph from one server at startup and hourly
(`ldk-node src/config.rs:64`). dni defaults to LDK's server on mainnet
(`lnurl-mint-rust:src/ln/mod.rs:94-101`) and describes it as semi-trusted:
it "can leave channels out, which makes some routes fail, but it can't take
funds"; the first snapshot is about 2 MB
(`lnurl-mint-rust:README.md`, "The network graph"). The server learns the
box's IP and that it runs LDK, nothing payment-specific.

P2P gossip alone, from one or two peers, would leave a fresh node unable to
route melts until the graph fills in. Recommendation: RGS, from LDK's server,
with the omission risk accepted. Peer gossip keeps updating the same graph
either way (dni, same section).

---

## 4. Liquidity

A mint consumes inbound to mint and outbound to melt, and wants them roughly
equal (operator notes). A new node starts with neither.

**Opening channels ourselves** gives outbound only. The operator notes record
ACINQ's minimum incoming channel as 400,000 sat, an order of magnitude below
the other large peers probed. Inbound then has to be made by spending: the
notes record that paying one's own other wallet was by far the cheapest way to
do that on this mint. Costs to surface: the open's on-chain fee, the capital,
the anchor reserve (below), and the routing fees of the rebalancing spend.

**LSPS2 just-in-time channels** (`set_liquidity_source_lsps2`,
`receive_via_jit_channel`) make an LSP open a channel *to* the node when a
payment arrives, keeping an opening fee from it. dni uses this only for a
one-off bootstrap invoice paid from outside the mint, never for mint invoices
(`lnurl-mint-rust:README.md`, "Inbound liquidity";
`src/ln/mod.rs:659-690`). That is the right shape here too: per-mint JIT
invoices would skim LSP fees off small payments. The LSP is trusted twice: it
is added to `trusted_peers_0conf` (`ldk-node src/builder.rs:466-467`), and dni
also lets it skip the anchor reserve, trusting it to confirm the commitment
on a close (`lnurl-mint-rust:src/ln/mod.rs:276-285`). Its opening fee comes
from the LSP's quoted parameters and can be capped
(`max_total_lsp_fee_limit_msat`). **No LSP and no fee is named in any source
read for this design**, so which LSPs offer LSPS2 to a node like this, and at
what price, is an open question.

**Things that bite whichever way:**

- ldk-node opens anchor channels and keeps an on-chain reserve of 25,000 sat
  per anchor channel by default (`ldk-node src/config.rs:30`). The operator
  notes record lnd's equivalent reserve already blocking any new channel on
  this mint.
- LDK accepts at most 10% of a channel's value in inbound HTLCs in flight by
  default (`lightning src/util/config.rs:252`). ldk-node raises that to 100%
  only for private channels it opens (`ldk-node src/lib.rs:1092-1098`) and for
  its LSPS2 channels (`ldk-node src/event.rs:1225-1245`). On an announced
  channel, or one a peer opens to us, the largest mint is 10% of the channel.
  dni lists this as open (`lnurl-mint-rust:PLAN.md`). The live note cap
  (10,000 sat per the operator notes) needs a 100,000 sat announced channel
  at 10%.
- dni notes that LDK's anchor bumps spend confirmed wallet coins, and with one
  UTXO a second bump finds nothing to spend: keep several confirmed UTXOs
  (`lnurl-mint-rust:PLAN.md`, "One coin, one fee bump").

---

## 5. Persistence and backup

### What the sidecar holds

| Item | Where | Loss means |
|---|---|---|
| Seed (64 bytes of entropy) | file, 0600 | everything; it derives node, wallet and channel keys |
| Channel state, wallet, payments, peers, graph | `ldk_node_data.sqlite`, ldk-node's default SQLite store (`ldk-node src/builder.rs:587-599`, `src/io/sqlite_store/mod.rs:28`) | channel funds at risk (below) |
| Sidecar ledger (preimages, melt outcomes, `not_paid_answers`) | its own SQLite file | Design A: unclaimed mint invoices fail back (refund). Melt rows: pending melts can no longer be read safely and need an operator. |
| API token | file | regenerate |

moneyer's own three (ledger, signing key, and today lnd's SCB, per the
operator notes) are unchanged except the third.

### The gap: no static channel backup

lnd's SCB plus the seed recovers channel funds by asking peers to force close,
and is safe to restore at any age. **ldk-node 0.7.0 has no equivalent that I
could find.** LDK 0.2 contains peer-storage machinery
(`lightning src/ln/our_peer_storage.rs`), and ldk-node wires its key in
(`ldk-node src/builder.rs:1375`), but no restore-from-peer-storage flow
exists in ldk-node's API. Whether one is usable is unverified.

So `moneyer-scb.path`, which snapshots the SCB on change, has no counterpart,
and the hourly tarball must not simply grow to include the channel database:

- dni: "the seed alone does not recover channel funds, and restoring an old
  copy of `ldk-node/` while channels are open can lose them, as with any
  Lightning node" (`lnurl-mint-rust:README.md`, "Running a node").
- The operator notes already forbid restoring a stale channel database for
  phoenixd. phoenixd gets away with seed-only backups because its LSP keeps
  the channel state. An LDK node with ordinary peers has nothing equivalent.

A workable posture, weaker than today's:

1. Seed: backed up once, offsite, with the existing two-recipient `age`
   scheme. Recovers the on-chain wallet.
2. Sidecar ledger: into the hourly snapshot via `VACUUM INTO`, as moneyer's
   ledger is. A stale copy is harmless for preimages (missing ones refund).
   For melt rows it is only a starting point: reconcile it against ldk-node's
   store before trusting any answer.
3. Channel database: copied **only while the sidecar is stopped** (at each
   upgrade), labelled with the time, and restored only if the live copy is
   gone *and* nothing has happened on any channel since. Otherwise recovery
   means letting peers force close and claiming what the stale monitors
   allow, which needs verifying on regtest before it is relied on.
4. VSS gives synchronous remote persistence, but is alpha and "may cause LDK
   to panic" on unrecoverable persistence failures
   (`ldk-node src/builder.rs:624-626`), and needs a VSS server. Not now.

This is the strongest argument against switching the live mint (section 9).

---

## 6. Resources

**No measured memory or CPU figure for ldk-node exists in any source read.**
None is invented here. What is known:

- The box: about 3.8 GB, 2 vCPU, no swap, running lnd, moneyer and Caddy
  (operator notes). The notes also forbid building anything on it, for fear
  of OOM-killing a money service.
- dni's Docker image is 152 MB on disk (`lnurl-mint-rust:PLAN.md`), which says
  nothing about RSS.
- What drives an LDK node's memory: the network graph and scorer (a full
  mainnet graph via RGS), the BDK wallet, and the tokio runtime. CPU spikes
  when an RGS snapshot is applied (dni moves that off the async workers,
  `PLAN.md`) and on each sync interval (section 3).

How to get the number, before the box is touched:

1. Run the sidecar unfunded on mainnet on a development machine, with RGS and
   the chosen chain source, for a day. Record peak and steady RSS (`VmHWM`,
   `VmRSS`) and CPU around RGS applies. An unfunded node costs nothing.
2. Read lnd's and moneyer's current RSS on the box (read-only, by the
   operator).
3. Gate: sidecar peak + lnd + moneyer + Caddy must leave comfortable
   headroom, because the migration runs both nodes at once (section 7).

Under systemd, give the sidecar `MemoryHigh` (throttle), not `MemoryMax`
(kill): a kill is a hard kill, with the force-close cost in section 2. Build
the binary off the box, in CI, for the box's architecture (open question).

Running *instead of* lnd frees whatever lnd uses today; that figure is also
unknown here.

---

## 7. Migration from lnd

### Constraints that fix the order

- **Liabilities stay covered throughout.** Every outstanding note is a debt.
  At every step, outbound on whichever node moneyer points at must cover
  `/stats`' outstanding total, with margin for routing fees.
- **The mint signing key does not change.** `mintPubkey` is
  `MONEYER_SIGNING_KEY` (`src/config.ts` 239-241), not the node key, so every
  certificate already issued keeps verifying. dni's design differs: there
  the node key is the mint key, and a migration orphans old certificates
  (`lnurl-mint-rust:PLAN.md`, "Migration"). Only `nodeUri`/`nodeUris` in
  discovery change.
- **lnd-issued invoices must be finished before the switch.** After the
  switch, `isInvoiceSettled` for an lnd hash asks the sidecar, which answers
  `unknown`, which is `false`. The mint sweep then deletes the row an hour
  past expiry while lnd can still settle the payment with its stored
  preimage, and the note never credits. Zap rows are worse (section 2). `lnd.ts`
  sets no invoice expiry, so lnd's default applies.
- **Historical unnamed invoices.** For quotes from before the comment-bound
  cutover, the invoice preimage *is* the note's spend secret, and `/verify`
  fetches it live from the funding source (`server.ts` 982-987).
  Once lnd is gone, `/verify` cannot return it. The payer's wallet learned it
  on payment, so the money is not lost, but a wallet that relied on `/verify`
  would be stuck. Count these rows (`mint_invoices` with `output_id IS NULL`,
  whose notes are still outstanding) before deciding (open question).
- **mint.forgesworn.dev's sunset.** Its melt route runs over its channel to
  moneyer's lnd until its redemption deadline of 2026-11-25 (operator notes).
  Closing that channel earlier strands its holders' route.

### Run both, then switch (recommended over a cold switch)

1. **Bench.** Regtest (section 8), then the unfunded mainnet resource run
   (section 6). Stop here if either fails.
2. **Stand up the sidecar beside lnd.** Separate system user, data directory
   and systemd unit, `TimeoutStopSec` of at least 60 s (dni recommends 60 s
   for Docker, `README.md`), different p2p port. moneyer still on lnd.
3. **Fund it.** On-chain to the sidecar's wallet. **Cost:** a transaction fee,
   plus any swap fee if the capital comes out of another Lightning wallet.
4. **Channels.** Open from the sidecar (to ACINQ or another peer) and/or take
   an LSPS2 bootstrap channel. **Costs:** opening fees, the 25,000 sat
   per-channel anchor reserve held on-chain, LSP opening fee.
5. **Make inbound.** Spend from the sidecar to another wallet of the
   operator's, per the notes. **Cost:** routing fees.
6. **Drain lnd's invoices.** Set `MONEYER_SUNSET=true` (refuses mint and zap
   invoices, `server.ts` 732, 786; melts stay open) for longer than lnd's
   invoice expiry plus the sweep's hour, until no unsettled mint or zap row
   remains and `pendingMelts()` is zero. Holders can still melt throughout.
7. **Switch.** Stop moneyer, snapshot its ledger as the runbook does, set
   `MONEYER_BACKEND=ldk`, start, unset sunset. Verify with the conformance
   grade and `/stats` before and after, as the upgrade runbook does.
8. **Move the money.** Pay sidecar invoices from lnd to shift lnd's channel
   balance across (**cost:** routing fees), then close lnd's channels
   cooperatively (**cost:** two on-chain fees), not the forgesworn-mint
   channel before 2026-11-25. Sweep lnd's on-chain balance to the sidecar
   (**cost:** a transaction fee; this also frees lnd's anchor reserve).
9. **Retire lnd** only after the historical-unnamed question is settled and
   the forgesworn sunset has passed. Keep its data directory, stopped, as a
   read-only record.

Rollback, until step 8: set `MONEYER_BACKEND=lnd` again. Any invoice the
sidecar issued in between needs the same drain in reverse.

### Every step that costs money

| Step | Cost | Amount |
|---|---|---|
| Funding the sidecar wallet | on-chain fee; swap fee if moved off Lightning | not estimated |
| Each channel open | on-chain fee; capital locked; 25,000 sat anchor reserve per channel by default (`ldk-node src/config.rs:30`) | fee not estimated |
| LSPS2 bootstrap, if used | LSP opening fee, cappable | unknown (no LSP in sources) |
| Creating inbound | routing fees on the spend | not estimated |
| Moving lnd's channel balance | routing fees | not estimated |
| Closing lnd's channels | one on-chain fee per channel | not estimated |
| Sweeping lnd's on-chain balance | one on-chain fee | not estimated |
| Any hard kill during the overlap | possible force close: on-chain fees, channel lost | not estimated |
| Self-hosted chain source, if chosen | a box or volume, recurring | not estimated |
| More RAM or swap, if the bench says so | hosting change | not estimated |

---

## 8. Testing

### moneyer side (TypeScript, no network)

- `test/ldk-backend.test.ts`, in the style of `test/lnd-invoice-settled.test.ts`:
  a stubbed `fetch` answers every row of the tables in section 1, and each
  must produce the right return value or error class.
- `test/melt-discipline.test.ts` run again with the `ldk` client over a stub:
  a clean failure report alone never restores; `pending` never restores;
  `already_known` restores; success burns.

### Sidecar side (Rust)

Unit tests on the ledger: success is sticky against a later `PaymentFailed`; a
store `Failed` without a `PaymentFailed` event is `unresolved`; a send request
older than a `not_paid_answers` entry is refused; replayed events are
idempotent; the invoice row exists before `receive_for_hash` is called.

### Regtest, reusing dni's harness

`lnurl-mint-rust:e2e/regtest.py` already runs a regtest bitcoind and several
LDK nodes as dni's mint binary, driven only through public endpoints and the
admin API: B pays mint invoices, receives melts and acts as an LSPS2 provider
(a `--features test-lsp` build); C has no channels, so melting into its invoice
must fail before sending; F tests the LSP bootstrap; CONFORM=1 runs the
lnurlcash-conformance grader. The repository is MIT-licensed (its
`Cargo.toml`), so the harness can be adapted with attribution. The adaptation:
keep bitcoind, B and C as dni's binaries; replace the mint under test with our
sidecar plus moneyer pointed at it; grade moneyer with CONFORM=1.

Scenarios beyond dni's:

1. Mint, rotate, split, merge, melt round trip; the grader passes.
2. Melt into C's invoice: refused before sending, restored with a reason.
3. **Hodl melt**: a payee that holds our HTLC, then fails it. Needs a second
   sidecar instance with a test-only "hold claims" switch, or an lnd/cln with
   hold invoices. The note stays pending until the HTLC is gone.
4. **Keysend into a held melt** (section 1, reason 3): while the payee holds
   our HTLC, it keysends to our node using the preimage (ldk-node 0.7.0 can
   send a keysend with a chosen preimage, `CHANGELOG.md` #549). Expect
   ldk-node's store to read `Failed` and the sidecar to answer `unresolved`.
   This test decides whether the attack is real.
5. Crash windows, via test-only failpoints: kill the sidecar between `send`
   and the store insert; kill it holding a claimable HTLC and restart before
   and after the claim deadline (mine blocks between); kill moneyer mid-melt.
   No note may burn without payment or restore with an HTLC outstanding.
6. Invoice paid while moneyer is stopped: the note mints on restart via claim,
   `/verify` or the sweep. The same for a zap shows the existing gap in
   section 2.
7. Retry a restored melt into the same invoice inside and outside LDK's
   idempotency window.
8. SIGTERM versus SIGKILL restarts, recording whether a channel force closes.

Gap to state: regtest uses bitcoind RPC as the chain source, while
production would use Esplora or Electrum, so the code that matters most for
chain safety on the live box is not what the regtest run exercises. Adding an
Esplora or electrs container to the harness would close that, at some setup
effort.

---

## 9. Open questions, and a recommendation

### Decisions for the operator

1. **Whether to do this at all** (recommendation below).
2. Design A (sidecar stores preimages, no moneyer changes) or Design B (node
   chooses, needs a `zap.ts` change).
3. Chain source: which public Esplora or Electrum, accepting the privacy
   regression from neutrino, or a self-hosted one at a recurring cost.
4. Liquidity: own channel opens (ACINQ's 400,000 sat floor) or an LSPS2
   bootstrap; which LSP, at what fee. None is named in the sources.
5. Backup: accept no static channel backup, with the stopped-copy posture of
   section 5, or wait for a verified peer-storage restore or a non-alpha VSS.
6. Historical unnamed invoices: export their preimages from lnd before it
   goes (breaking "never persist a preimage" for that legacy set only), keep
   lnd's data readable, or accept that `/verify` stops answering for them.
7. Timing against mint.forgesworn.dev's 2026-11-25 deadline.
8. Where the sidecar lives (its own repository, or a directory here with Rust
   added to moneyer's CI), and the box's CPU architecture for the build.
9. Announced or private channels (the 10% in-flight limit).
10. The sidecar's invoice expiry, and whether it should match lnd's default.

### Unverified, to settle on regtest or in source

- Whether the keysend-into-a-held-melt path flips ldk-node's store to `Failed`
  in practice (section 8, scenario 4).
- Whether LDK's peer storage gives any usable restore in ldk-node.
- How a node restored from a stale channel database behaves on reconnection.
- The DuplicatePayment window after a failure.
- RSS and CPU.
- Whether LDK Server exposes manual claims, if it were ever preferred to a
  bespoke sidecar.

### Recommendation

**Do not switch moneyer.dev off lnd now.** The case for LDK here is
alignment with dni's stack, in-process event-driven settlement, and an LSPS2
bootstrap path. None of those fixes a problem moneyer.dev has today: lnd
works, the liabilities are small, and moneyer is a proof-of-concept mint.
Against it:

1. **Backup gets weaker.** No static channel backup in ldk-node; a stale
   channel database is dangerous to restore; VSS is alpha (section 5).
2. **A safety-critical component to write and own.** The sidecar's ledger
   has to make up for three ways ldk-node's payment store can mislead a melt
   (section 1). One of them looks like a hodl-invoice attack and is
   unproven either way. lnd's tracker has none of these problems.
3. **Privacy and dependency regression** from neutrino to a public chain
   server, plus an unmeasured memory cost on a box that has no swap and
   already holds money services (sections 3 and 6).

On top of that, every step of the migration costs on-chain or routing fees,
and the forgesworn sunset pins lnd's channel in place until 2026-11-25
anyway.

If an LDK backend is wanted (for other operators, for interop with dni's
direction, or to measure it), the bounded path is: build the sidecar to
Design A, prove it with the regtest scenarios in section 8 on dni's harness,
and run the unfunded mainnet resource measurement. Then revisit with the
numbers and the scenario 4 result in hand, no earlier than 2026-11-25. Ship
it as an optional backend for operators who accept its backup posture. Do not
change what backs moneyer.dev.
