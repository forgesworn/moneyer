# Changelog

## [0.2.0] - unreleased

While LUD-25 is a draft, a `0.x` minor bump may be breaking; this one is
additive on the wire apart from the node-capacity rename below.

- The mint can announce itself. With `MONEYER_ANNOUNCE=true` and the Nostr
  identity zap-to-note already uses, it publishes its own discovery
  document hourly as a parameterised replaceable event (kind 30078, `d`
  tag `lnurlcash-mint`), alongside the liabilities snapshot. Until now a
  wallet could only learn of a mint by being told its address; this is the
  half that has to exist before finding one means anything. The content is
  the document exactly as the discovery endpoint serves it, so there is one
  description of a mint and not two, plus a `sig` over the canonicalised
  body made with the note signing key, so a holder can check the
  announcement against the same key their notes verify against.
  `verifyAnnouncement` is exported for that. Off unless the operator turns
  it on: a mint that does not want to be listed says nothing. No new event
  kind, and no recommendations or reviews; both are protocol decisions that
  belong with the NIPs.
- A note melts to an invoice that states no amount. Such an invoice used
  to be refused outright, which is a papercut for anyone paying one: for a
  bearer note the amount was never in question, since the note's value is
  the amount. The mint sends the whole-sat floor of the note's value, the
  same figure it already accepts from a wallet that fills the amount in
  itself, and keeps the sub-sat remainder as the same dust. A note worth
  less than a single satoshi has nothing left once the floor applies and
  is refused with `insufficient value`; it can still be melted by a wallet
  that invoices its exact value. Everything else about the melt path is
  untouched, including the pending and restore discipline.
- A wallet can name the note it is buying. It chooses the note's spend
  secret itself, keeps it, and sends `h`, the sha256 of that secret, on
  the pay callback; the mint credits the note at `h` when the invoice
  settles. The invoice's payment preimage then buys nothing and is only a
  payment proof, which is what it always should have been: a preimage is
  known to the funding source, to every node that forwarded the payment,
  and to anyone who polls LUD-21 `verify` with the payment hash written
  inside the invoice. Naming the note leaves the buyer as the only party
  who ever held the secret, and replaces "claim and rotate faster than
  anybody else" with nothing to race for. A malformed `h` is refused
  before an invoice is issued, so a wallet never pays for a quote the
  mint would reject; an `h` that already names a note or an invoice is
  refused with `Invalid or already spent k1.`, the same oracle-free
  sentence a colliding output gets on the withdraw callback. The reply
  carries `mintToHash: true` when the binding was made, and the payRequest
  and the discovery document advertise `mintToHash: true` so a wallet
  knows before it asks. Claiming needs no `verify` poll: the wallet asks
  `/w?k1=<its own secret>` directly. Entirely optional and additive: a
  wallet that sends no `h` gets exactly today's behaviour, and the LUD-25
  draft needs no change. Wallets are urged to persist the secret before
  requesting the invoice, which is the one thing that could make this
  worse than what it replaces.
- A live note's informational GET now carries `payLink`, pointing at this
  mint's payRequest, which is the counterpart of the `withdrawLink` a
  payRequest already advertises. It is the route home for a holder who has
  nothing but a note: from it a wallet reaches the discovery document, and
  so the mint's terms and its retired signing keys. Without it a wallet
  that only ever received notes cannot tell an announced key rotation from
  a substituted key. Optional and additive; unknown and spent notes still
  say nothing about the mint beyond the refusal.
- Both database connections now wait up to five seconds for a lock instead
  of giving up at once. `node:sqlite` opens with no busy timeout, so a
  second writer met `database is locked` the moment the first one held it.
  The operator CLI is that second writer while the mint is running, and the
  times you reach for `moneyer admin reconcile` are the busy ones. Nothing
  was ever at risk of corruption; the command simply failed when it was
  least convenient.
- The discovery endpoint carries the human layer: `name`, `description`,
  `contact` (`nostr` as an npub, `email`, `url`), `tosUrl`, `motd`,
  `fees`, `version` and `previousPubkeys`. Every one is optional and an
  unset one is absent rather than empty. New environment variables:
  `MONEYER_NAME`, `MONEYER_CONTACT_NOSTR`, `MONEYER_CONTACT_EMAIL`,
  `MONEYER_CONTACT_URL`, `MONEYER_TOS_URL`, `MONEYER_MOTD`.
- **Wire-name change**: node capacity now goes out as `nodeCapacity`, the
  name the reference mint, the conformance mock and `lnurlcash-kit` all
  use. `nodeCapacityMsat`, which was moneyer's alone, is emitted alongside
  it for this one release and then removed. Both are milli-satoshis.
- The mint's own site and the fallback landing page show the message of
  the day, the operator's contact and the terms link, and read capacity
  under either name.
- `GET /stats` states what the mint owes and what its funding node holds:
  outstanding liabilities and note count, melts in flight and the age of
  the oldest, the node's local balance, and the coverage ratio between
  the two to four decimal places. Cached 30 seconds, never per-note,
  public by design. `MONEYER_STATS=false` switches it off and
  `MONEYER_STATS_RATIO_ONLY=true` publishes the ratio alone. Both the
  mint's site and the fallback landing page carry a coverage row.
- `MONEYER_STATS_PUBLISH=true` publishes an hourly signed snapshot of
  those figures to Nostr (kind 30078, `d` tag `lnurlcash-liabilities`),
  signed with the note signing key so anyone can check the history
  against the mint's advertised pubkey. `scripts/verify-stats.mjs` does
  exactly that, and `verifyStatsSnapshot` is exported for wallets.
- The lnd and cln backends report the node's local channel balance;
  the fake one reports a configurable balance, one bitcoin by default.
- **Self-service lightning addresses.** With `MONEYER_NAME_PRICE_MSAT`
  set, anyone with an npub can claim `name@<host>` by posting to
  `/names` with a NIP-98 Authorization and a note of this mint. The key
  that signs the request owns the name; no other identity is accepted.
  The note is burned and the name recorded in one transaction, so
  nothing is ever paid for a name somebody else got first. Unset means
  registration is closed; `0` means free, three names per pubkey.
  Registered and operator-configured names live in one table and are
  served by one lookup, and `GET /.well-known/nostr.json?name=` resolves
  them over NIP-05 as well, one name at a time. Discovery advertises
  `namePriceMsat` while registration is open.
- The kind 2525 rumor for a zap-funded note carries the zap request in a
  `description` tag - the same content the kind 9735 receipt carries - so
  a wallet can show who zapped and what they wrote without fetching the
  receipt. Readers take tags by name, so an older one does not notice.
- `MONEYER_ZAP_NAMES` is now optional: a mint that opens registration can
  start with no names of its own. `MONEYER_NOSTR_KEY` and
  `MONEYER_NOSTR_RELAYS` still go together.
- `moneyer admin names` gains `add <name> <npub>` and `rm <name>`, and
  `list` shows configured names the running mint has not loaded yet.
- **A retried rotate, split or merge is answered instead of refused.**
  These are GETs, and transports retry GETs on their own: the retry
  arrives byte-identical after the inputs are burned, and the old answer
  - `Invalid or already spent k1.` - told the wallet to drop the only
  copy of a secret the mint really had minted a note against. The mint
  now records which request minted which outputs, and replays the same
  reply: same signatures, nothing burned, nothing minted, no balance
  moved. A request counts as the same request when it names the same
  input notes and asks for the same `h`, `h2` and `amount`; input order
  does not matter. Anything else naming a burned note is still refused
  with the same reason string, so no oracle appears, and the melt path is
  untouched. moneyer's own behaviour: the draft says nothing about
  retries yet.
- `moneyer admin <command>`: the operator surface. `status`, `notes`,
  `note`, `melts`, `reconcile`, `sweep`, `snapshot`, `names list`,
  `keys rotate` and `verify-note`, all reading the same `MONEYER_*`
  environment the mint does, and all opening the database read-only
  unless the command mutates. `snapshot` uses `VACUUM INTO`, so it needs
  no sqlite3 binary and is safe against a live mint; `keys rotate`
  generates a key and prints the two environment lines without touching
  anything.
- `MONEYER_METRICS=true` serves `GET /metrics` in the OpenMetrics text
  format. Off by default and never authenticated by the app: restrict the
  path at the reverse proxy. The README's Operating section names the
  three alerts worth having.
- A "What the mint knows" section in the README, on the mint's own site
  and on the fallback landing page, in the same words: what a LUD-25 mint
  can see, what it cannot, why the wallet-side mitigations are weak, and
  why the design was chosen anyway. Blindness is the one ecash property
  this cannot offer, and a reader should not have to infer that.
- `MONEYER_PREVIOUS_SIGNING_PUBKEYS` lists the compressed pubkeys this
  mint signed notes under before, published as `previousPubkeys` on
  discovery. Rotating the signing key no longer invalidates every
  outstanding note's signature or trips a pinned wallet's mismatch
  check. Pubkeys only, validated as points on the curve at startup: the
  old private keys are not needed to verify and should not stay on the
  server. The runbook is in the README.

## [0.1.2] - 2026-08-21

- `MONEYER_ROUND_FEE_TO_SAT` ceilings the mint fee to a whole sat, as
  dni's lnurl-mint does on purpose so the mint is "never short a sat".
  LUD-25 says nothing about rounding and `lnurlcash-kit`'s `mintFeeBand`
  accepts both readings, so this is a posture choice rather than a
  compliance one. **Off by default**: turning it on raises what the mint
  withholds, which is not a change to make on a redeploy.
- The mint path called `applyMintFee` directly rather than the fee helper,
  so it would have ignored that setting entirely - advertising one fee and
  withholding another. Every fee site now goes through one
  `netAfterMintFee`.
- `roundFeeToSat` is optional on `MoneyerConfig`: that type is public API,
  and an embedder constructing a config should not have to name a field it
  does not care about.

## [0.1.1] - 2026-08-21

- `withdrawLink` is now the plain URL (`https://host/w`), the form
  lnurl-mint emits and the LUD-25 diagram shows, instead of
  `lnurlw://host/w`. Both are legal readings of the draft; the reference
  stack's is the intended one, and a wallet that only fetches the field
  without LUD-17 translation now works. Raised on the spec as
  lnurl/luds#301.

## [0.1.0] - 2026-08-20

Initial implementation.

- The six LUD-25 endpoints: payRequest, mint address discovery, pay
  callback, LUD-21 verify (mint and melt sides), informational GET, and
  the mutating callback (melt, rotate, split, merge).
- Funding sources: cln (clnrest) and lnd (REST), both with
  caller-supplied invoice preimages; a fake backend for development and
  tests, refused outside `--dev`.
- SQLite store keyed by note id (sha256 of the secret) - secrets are never
  persisted. Synchronous atomic mutations.
- In-process note signing with a dedicated mint key, agreeing byte for
  byte with lnurlcash-kit's verifier.
- The melt discipline: respond-then-pay, confirm-before-restore,
  pending-not-guessed, reconciliation at startup and on demand.
- Passes the lnurlcash-conformance grader, read-only and spending runs;
  the grader executes inside the test suite.
- The LUD-25 fee algebra on mutations: base_fee_msat deducted from every
  split's change (never the requested amount), (n-1) base fees refunded
  into a merge of n notes, 'insufficient value' when change cannot cover
  the fee or would land at zero.
- The mint's own website at GET /: mint a note in the browser (invoice
  QR, LUD-21 countdown polling, claim-and-immediately-rotate so the
  verify-exposed preimage dies before the note is shown, offline
  signature verification in front of the user, scratch-off silver over the QR), check
  a note (live/spent/unknown/pending in plain words), the terms and the
  funding node. vite + anime.js + lnurlcash-kit, served from memory by
  the mint process; falls back to a self-contained zero-script landing
  page when no web build exists. `MONEYER_WALLET_URL` links minted notes
  into a companion wallet's claim route.
- Node statistics (capacity, channels, peers) on the discovery endpoint,
  best-effort from the funding source.
- Shared funding sources are a supported deployment: the melt path
  pre-checks the node's payment history and surfaces the node's
  "payment already exists" refusal as a distinct, note-restoring
  outcome, closing the cross-mint melt replay a shared node otherwise
  allows.
