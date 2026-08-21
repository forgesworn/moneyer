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
alias).

## Configuration

Environment only. Every variable is `MONEYER_*`; anything unset takes the
default, and a variable set to an empty string counts as unset.

| variable | default | what it does |
| --- | --- | --- |
| `MONEYER_HOST` | `127.0.0.1` | listen address |
| `MONEYER_PORT` | `3737` | listen port |
| `MONEYER_PUBLIC_ORIGIN` | derived from `Host` | the origin wallets are told to call back on. Required behind a reverse proxy, and required for zap-to-note |
| `MONEYER_USERNAME` | `mint` | the local part of the mint's own lightning address |
| `MONEYER_DESCRIPTION` | `an LNURLcash note` | what a note is called on the wire (`defaultDescription`, and `description` on discovery) |
| `MONEYER_DB` | `moneyer.sqlite` | SQLite path; `:memory:` allowed |
| `MONEYER_BACKEND` | `fake` | `cln`, `lnd`, or `fake` (refused outside `--dev`) |
| `MONEYER_BACKEND_URL` | | the funding source's REST endpoint |
| `MONEYER_BACKEND_RUNE` | | cln authentication |
| `MONEYER_BACKEND_MACAROON` | | lnd authentication, hex |
| `MONEYER_SIGNING_KEY` | | 32 bytes of hex. Unset means notes go out unsigned, which holders will notice |
| `MONEYER_PREVIOUS_SIGNING_PUBKEYS` | | compressed pubkeys this mint signed under before, comma separated (see below) |
| `MONEYER_BASE_FEE_MSAT` | `0` | flat mint fee |
| `MONEYER_FEE_PPM` | `0` | proportional mint fee, parts per million |
| `MONEYER_ROUND_FEE_TO_SAT` | `false` | ceiling the mint fee to a whole sat (see below) |
| `MONEYER_MIN_SENDABLE_MSAT` | `1000` | smallest payment the mint advertises |
| `MONEYER_MAX_SENDABLE_MSAT` | `100000000` | largest payment the mint advertises |
| `MONEYER_MIN_MINT_MSAT` | `1000` | dust floor: the smallest note the mint will strike |
| `MONEYER_MAX_K1S` | `21` | most notes one callback may name |
| `MONEYER_VERIFY` | `true` | the LUD-21 `verify` endpoint. Off means 404 |
| `MONEYER_WALLET_URL` | | a companion web wallet the mint's site links notes into |
| `MONEYER_SUNSET` | `false` | wind down: refuse anything that grows liabilities, keep every way out open |
| `MONEYER_STATS` | `true` | the `/stats` endpoint. Off means 404 |
| `MONEYER_STATS_RATIO_ONLY` | `false` | publish the coverage ratio alone, without the size of the book |
| `MONEYER_STATS_PUBLISH` | `false` | publish a signed hourly snapshot of `/stats` to Nostr |

### Who runs this mint

Optional, all of it, and unset means the field is simply absent from the
discovery endpoint rather than present and empty. This is the human layer
a holder wants before trusting a mint with sats.

| variable | what it does |
| --- | --- |
| `MONEYER_NAME` | the mint's name, shown on its own site and published as `name` |
| `MONEYER_CONTACT_NOSTR` | an npub or hex pubkey to reach the operator on; published as an npub |
| `MONEYER_CONTACT_EMAIL` | an email address to reach the operator on |
| `MONEYER_CONTACT_URL` | a contact page |
| `MONEYER_TOS_URL` | the terms a holder is agreeing to |
| `MONEYER_MOTD` | a message of the day, at most 280 characters: maintenance, a sunset, a fee change. It is how an operator talks to holders without a mailing list they never signed up to |

The discovery endpoint also publishes `fees` (the structured twin of the
payRequest metadata's fee prose), `version`, and `previousPubkeys`.

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

## Rotating the signing key

moneyer signs notes with its own key rather than the funding node's, so
the node can be swapped without touching a single outstanding note. The
signing key itself is the harder one: rotate it naively and every note
already out there stops verifying at once, and every wallet that pinned
the old key refuses the mint on its next contact.

So the old pubkeys stay published. `previousPubkeys` on the discovery
endpoint lists the keys this mint has signed under before, and a wallet
that finds its pin in that list treats the change as a rotation rather
than an impostor. The trust argument is TOFU's own: whoever controls the
host controls the pin either way, and the history only stops a legitimate
rotation from looking like an attack.

To rotate:

1. Generate a new key: `openssl rand -hex 32`.
2. Set `MONEYER_SIGNING_KEY` to the new key, and add the **old public**
   key to `MONEYER_PREVIOUS_SIGNING_PUBKEYS` (compressed, 33 bytes of
   hex, comma separated, oldest last). The old private key is not wanted
   here and should not stay on the server: verifying an old note needs
   only the pubkey.
3. Restart. Notes signed under the old key keep verifying against it;
   every note minted or mutated from now on is signed under the new one,
   so a holder who rotates their note re-signs it under the new key for
   free.
4. Tell holders through `MONEYER_MOTD`.

Both variables are validated at startup: an entry that is not a
compressed point on the curve, or that repeats the current key, stops the
mint rather than quietly publishing a key that verifies nothing.

## Transparency: what the mint owes

LNURLcash notes are not blinded, so a mint can state its liabilities
exactly. No epochs, no blinded sums, no ceremony: the mint knows every
note it has issued and what each is worth, and it can add them up.

```bash
curl -s https://mint.example/stats | jq
```

```json
{
  "at": 1755800000000,
  "outstandingMsat": 48120000,
  "outstandingNotes": 12,
  "pendingMsat": 0,
  "pendingMelts": 0,
  "oldestPendingMeltAgeSecs": 0,
  "localBalanceMsat": 92400000,
  "coverage": 1.9202,
  "reconciledAt": 1755799800000
}
```

`coverage` is the funding node's outbound balance over the mint's
outstanding liabilities, to four decimal places. Under 1 means the node
could not pay every note out today; that is the operator's business to
show, not the endpoint's to hide. A mint with nothing outstanding has no
coverage figure at all, because "infinitely covered" is not a claim worth
making, and a funding source that will not report its balance leaves both
`localBalanceMsat` and `coverage` out rather than have them guessed.

The figures are cached for 30 seconds, are never per-note, and appear as
one row on the mint's own site and its fallback landing page. The
endpoint is public by design. `MONEYER_STATS=false` switches it off;
`MONEYER_STATS_RATIO_ONLY=true` publishes the ratio without the size of
the book.

### Signed snapshots

With `MONEYER_STATS_PUBLISH=true`, and the Nostr identity that
zap-to-note uses, the mint publishes an hourly snapshot as a
parameterised replaceable event (kind 30078, `d` tag
`lnurlcash-liabilities`). Its content is the `/stats` JSON plus a `sig`
over the canonicalised (RFC 8785) body, made with the **note signing
key** - the key a holder already checks their own notes against, so the
history adds nothing new to trust.

```bash
node scripts/verify-stats.mjs <mintPubkey> snapshot.json
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

## What the mint knows

This mint knows every note it has issued and what each is worth. It
knows every rotate, split and merge, the links between them - which note
became which, and when - and the network address the request came from.
It knows the invoice a melt paid.

It does not know who holds a note between those operations. A note
handed to someone else offline leaves no trace here until they rotate
it, which is one reason a wallet rotates on receipt.

The wallet-side mitigations are weak, and worth naming as weak. A Tor or
SOCKS proxy hides the address, not the links. Rotating at unpredictable
times blurs the timing, not the graph. Nothing a holder does stops this
mint seeing the chain of notes it struck.

The design was chosen anyway because it needs no new cryptography, any
LUD-03 wallet can cash a note out, and verifying a note offline needs a
signature and nothing else. The privacy story is trust the operator, and
that is worth saying plainly.

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
| `/stats` | what the mint owes, what the node holds, and the coverage between them |

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
