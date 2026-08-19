# Changelog

## [0.1.0] - unreleased

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
- Shared funding sources are a supported deployment: the melt path
  pre-checks the node's payment history and surfaces the node's
  "payment already exists" refusal as a distinct, note-restoring
  outcome, closing the cross-mint melt replay a shared node otherwise
  allows.
