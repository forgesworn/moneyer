# Changelog

## Unreleased

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
