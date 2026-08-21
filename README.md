# moneyer

> An LNURLcash (LUD-25) mint. A moneyer was the mediaeval craftsman licensed
> to strike coins; this one strikes Lightning bearer notes.

moneyer is an independent implementation of the LUD-25 draft: paying an
invoice it issues mints a bearer note whose spend secret is that invoice's
payment preimage, and a note's holder can rotate, split, merge and melt it
against the withdraw callback. It passes the full
[lnurlcash-conformance](https://github.com/TheCryptoDonkey/lnurlcash-conformance)
grader, including the spending checks, and the grader runs in this repo's
own test suite.

Reference stack, by dni (MIT): the [LUD-25 draft](https://github.com/lnurl/luds/pull/301),
[lnurl-mint](https://github.com/dni/lnurl-mint), [lnurl-wallet](https://github.com/dni/lnurl-wallet).
moneyer shares no code with them; where their behaviour encodes a safety
lesson, that behaviour is kept deliberately and tested.

## What it is

- TypeScript, ESM, Node 24+. `node:http` and `node:sqlite`; no web
  framework, no ORM.
- Funding sources: **cln** (clnrest) and **lnd** (REST), both of which
  accept a caller-supplied invoice preimage - the capability a LUD-25 mint
  cannot exist without. phoenixd and NIP-47 `make_invoice` do not offer it,
  which is why neither can back a mint. A **fake** backend exists for
  development and tests and refuses to run outside `--dev`.
- Notes are stored by id, `sha256(k1)` - the store never holds a spend
  secret. A freshly minted note's preimage lives only with the payer and
  the funding source.
- Signs every note it mints with its own mint key (secp256k1, the standard
  `Lightning Signed Message` construction) for LUD-25 offline verification.
- The melt discipline: reply OK when the note is reserved, pay in the
  background, burn only on confirmed payment, restore only on confirmed
  non-payment, and park everything else as pending for reconciliation -
  which also runs at startup, so a crash mid-melt never guesses.

## Run

Not on npm yet - build from source, with the sibling repos it links
against until those publish:

```bash
git clone https://github.com/TheCryptoDonkey/lnurlcash-kit
git clone https://github.com/TheCryptoDonkey/lnurlcash-conformance
git clone https://github.com/forgesworn/moneyer
(cd lnurlcash-kit && npm install && npm run build)
cd moneyer && npm install && npm run build && npm run web:build
```

```bash
# development: fake funding source, in-memory store, a funded note printed
node dist/cli.js --dev

# production shape
MONEYER_BACKEND=cln \
MONEYER_BACKEND_URL=https://127.0.0.1:3010 \
MONEYER_BACKEND_RUNE=... \
MONEYER_SIGNING_KEY=<32 bytes hex> \
MONEYER_PUBLIC_ORIGIN=https://mint.example \
MONEYER_DB=/var/lib/moneyer/mint.sqlite \
node dist/cli.js
```

The mint is then payable at `mint@mint.example` (and the bare-domain `_`
alias). Configuration is environment-only; see `src/config.ts` for the
full `MONEYER_*` set including fees (`MONEYER_BASE_FEE_MSAT`,
`MONEYER_FEE_PPM`), limits, and `MONEYER_SUNSET` for winding down without
stranding holders.

## The website

`GET /` serves the mint's own site (`web/`, vite + anime.js, built by
`npm run web:build` into memory-served static files). It is a wallet-grade
LNURLcash client in its own right, driven entirely by `lnurlcash-kit`
against the same endpoints every wallet uses:

- **Mint a note in the browser**: amount in, fee grossed up and shown
  before the invoice exists, invoice QR (tap opens a wallet), LUD-21
  polling with a countdown, and on settlement the note is claimed and
  **immediately rotated** - the preimage any invoice-observer could poll
  out of verify is dead before the note is shown. The rotated note's
  signature is verified against the mint's advertised key in front of the
  user, and the QR arrives under scratch-off silver foil, rubbed away like a scratch card.
- **Check a note**: live value, spent/unknown/pending classified in plain
  words, offline signature verification.
- `MONEYER_WALLET_URL` (optional) links minted notes straight into a
  companion web wallet's `#/claim` route.

Without a web build the server falls back to a self-contained, zero-script
landing page, so an npm-installed mint still has a face.

As a library:

```ts
import {createMoneyer, configFromEnv} from '@forgesworn/moneyer'
const mint = await createMoneyer(configFromEnv())
```

## The mint fee, and the rounding question

LUD-25 gives the fee as a flat `base_fee_msat` plus a ppm cut and says
nothing about rounding. dni's lnurl-mint, the reference, ceilings it to a
whole sat on purpose so the mint is never short a sat; moneyer withholds
the msat-exact amount. Neither is out of spec - lnurlcash-kit's
`mintFeeBand` treats anything between the two as the mint keeping its
word, and the conformance grader accepts both.

`MONEYER_ROUND_FEE_TO_SAT=true` switches this mint to the reference's
behaviour. Off by default: turning it on raises what the mint withholds,
and that is not a change to make behind an operator's back on a redeploy.

Why you probably want it on anyway: msat-exact fees make notes like 94.9
sat, and most Lightning wallets can only invoice whole sats, so such a
note cannot be withdrawn by them. moneyer covers the notes already out
there by advertising `minWithdrawable` as the note floored to a whole sat
and accepting a melt for that; the sub-sat remainder is dust the mint
keeps. Rounding at mint time means it never comes up.

## Zap-to-note: a lightning address that pays out as a note

A Nostr zap is an ordinary LNURL-pay. Paid to the mint's own address it
would mint a note, but to the payer: the invoice preimage is the secret
and on Lightning the payer always learns it. So moneyer can also serve
names that work the other way round. A zap to `alice@<host>` gets an
invoice with a throwaway preimage; when it settles, the mint creates a
note with a fresh secret, seals it in a NIP-59 gift wrap (a kind 2525
rumor, the shape heartwood-esp32 and notecase read) to alice's pubkey,
leaves it on her NIP-17 inbox relays, and publishes the kind 9735 receipt
so the zap shows up in her client like any other. A hardware wallet that
catches up on its inbox when it powers on will find the note waiting.

Until alice rotates the note, the mint knows its secret. That is the
position every freshly minted note is in, and it is why wallets rotate on
receipt; notecase does it on `heartwood collect`. What is new is that the
mint learns who was paid, which a lightning address always did.

```bash
MONEYER_PUBLIC_ORIGIN=https://mint.example      # required: settlement is on a timer
MONEYER_NOSTR_KEY=<32 bytes hex>                # the mint's own Nostr identity
MONEYER_NOSTR_RELAYS=wss://relay.example,wss://nos.lol
MONEYER_ZAP_NAMES="alice=npub1...,bob=<hex pubkey>"
```

All three or none. A zap name's payRequest carries `allowsNostr` and the
mint's `nostrPubkey`, and deliberately no `withdrawLink`. The receipt
carries no preimage tag: it is optional in NIP-57, and here it would only
invite someone to mistake it for the note. A zap name must not be the
mint username or `_`.

## Endpoints

| | |
| --- | --- |
| `/.well-known/lnurlp/<user>` | LUD-16 payRequest; paying mints a note |
| `/.well-known/lnurlp/<zap name>` | NIP-57 payRequest; paying mints a note *to the name's pubkey* |
| `/.well-known/lnurlw/<user>` | LUD-25 mint address discovery (experimental) |
| `/p/cb` | LUD-06 pay callback; issues the mint invoice |
| `/z/cb/<zap name>` | the zap callback; validates the kind 9734 and issues the invoice |
| `/verify/<hash>` | LUD-21 verify, for mint invoices and melt payments |
| `/w` | LUD-03 informational GET |
| `/w/cb` | the mutating callback: melt, rotate, split, merge |

## Testing

```bash
npm test          # vitest: protocol, signing, melt discipline, conformance
```

The conformance grader runs inside the suite against an in-process mint,
read-only and spending paths both. The cln and lnd backends are direct
ports of the reference mint's semantics but have not yet been exercised
against live nodes; treat them as beta until they have.

## Dogfood

Part of the ForgeSworn LNURLcash stack: built on
[`lnurlcash-kit`](https://github.com/TheCryptoDonkey/lnurlcash-kit) (fee
maths, hashing, signature agreement) and
[`farrier-kit`](https://github.com/forgesworn/farrier-kit) (BOLT-11
decoding and preimage verification on the melt path). The companion wallet
is [`@forgesworn/notecase`](https://github.com/forgesworn/notecase).

Other mints, wallets and libraries speaking the same protocol are indexed
in [awesome-lnurlcash](https://github.com/TheCryptoDonkey/awesome-lnurlcash).

## Licence

MIT.
