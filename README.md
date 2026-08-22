# moneyer

> An LNURLcash (LUD-25) mint. A moneyer was the mediaeval craftsman licensed
> to strike coins; this one strikes Lightning bearer notes.

moneyer is an independent implementation of the LUD-25 draft: paying an
invoice it issues mints a bearer note, and a note's holder can rotate,
split, merge and melt it against the withdraw callback. The note's spend
secret is the invoice's payment preimage, or, better, a secret the buyer
chose and named on the way in. It passes the full
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
  secret. A buyer may name the note they are buying, in which case the
  secret is theirs alone from the start.
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
| `MONEYER_ROUND_FEE_TO_SAT` | `true` | ceiling the mint fee to a whole sat (see below) |
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
| `MONEYER_ANNOUNCE` | `false` | announce this mint on Nostr, hourly, so a wallet can find it (see below) |
| `MONEYER_METRICS` | `false` | the `/metrics` endpoint, in the OpenMetrics text format |
| `MONEYER_NAME_PRICE_MSAT` | | what a self-service lightning address costs. Unset means registration is closed; `0` means free |

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

## Announcing the mint

A wallet only ever learns of a mint by being told its address. There is no
way to find one, and nothing that might follow from finding one, a list or
a recommendation, can exist until that first step does.

With `MONEYER_ANNOUNCE=true`, and the same Nostr identity zap-to-note
uses, the mint announces itself on the same hourly pass as the snapshot:
kind 30078 again, `d` tag `lnurlcash-mint`. The content is this mint's own
discovery document, exactly as `/.well-known/lnurlw/<user>` serves it, so
there is one description of a mint rather than two that drift apart. It
carries a `sig` over the canonicalised (RFC 8785) document made with the
**note signing key**, so a holder can check that the mint announcing
itself is the mint their notes verify against, whoever the Nostr identity
publishing it belongs to. `verifyAnnouncement` in this package does that
check.

Off by default, deliberately. A mint that does not want to be listed says
nothing, and turning it on is the operator saying otherwise. Announcing
needs `MONEYER_PUBLIC_ORIGIN`, since an announcement made with a `Host`
header nobody sent is an address nobody can call back on.

There is no recommendation or review here, and no new event kind. Both are
protocol decisions that belong with the LNURLcash NIPs rather than with a
single mint's implementation.

## The mint fee, and the rounding question

LUD-25 gives the fee as a flat `base_fee_msat` plus a ppm cut and says
nothing about rounding. dni's lnurl-mint, the reference, ceilings it to a
whole sat on purpose so the mint is never short a sat; moneyer withholds
the msat-exact amount. Neither is out of spec - lnurlcash-kit's
`mintFeeBand` treats anything between the two as the mint keeping its
word, and the conformance grader accepts both.

**moneyer rounds, by default.** A mint that deals in fractions of a sat
issues notes nothing downstream can spend: msat-exact fees make notes like
94.9 sat, and most Lightning wallets can only invoice whole sats, so such
a note cannot be withdrawn by them at all. moneyer covers the notes
already out there by advertising `minWithdrawable` as the note floored to
a whole sat and accepting a melt for that, keeping the sub-sat remainder
as dust - a wart it should not need. Rounding at mint time means it never
comes up, and every note this mint issues for a whole-sat payment is worth
a whole number of sats.

`MONEYER_ROUND_FEE_TO_SAT=false` restores the msat-exact fee. An operator
upgrading into this default withholds slightly more per mint than before,
which is why the changelog says so plainly rather than letting a redeploy
change it quietly.

## Melting to an invoice with no amount

An invoice that states no amount leaves the sending side to decide, and
for a bearer note there is nothing to decide: the note's value is the
amount. moneyer melts a note to one for the whole-sat floor of its value,
the same figure it accepts from a wallet that fills the amount in itself,
and keeps the sub-sat remainder as the same dust described above.

A note worth less than a single satoshi has nothing left once the floor
applies, so an amountless invoice from one is refused with `insufficient
value`. It can still be melted the ordinary way by a wallet that invoices
its exact millisatoshi value.

Nothing else about the melt changes. `OK` still means in flight, the note
still burns only on confirmed payment and restores only on confirmed
non-payment, and the routing budget is still sized against the note.

## Name the note you are buying

Paying a mint invoice mints a note, and by default that note's spend
secret is the invoice's payment preimage. A payment preimage is not a
private thing. The funding source has it, every node that forwarded the
payment has it, and LUD-21 `verify` hands it to whoever asks with the
payment hash, which is written inside the invoice on the payer's screen.
The draft's answer is for the wallet to claim and rotate the instant the
invoice settles, which is a foot race the wallet has to keep winning.

So a wallet may name the note instead. It chooses the secret first, writes
it down, and sends `h`, the sha256 of that secret, on the pay callback:

```
GET /p/cb?amount=21000&h=<64 hex>
```

The mint credits the note at `h` when the invoice settles. The payment
preimage then buys nothing: it is an ordinary payment proof, which is why
`verify` goes on serving it. Nobody but the buyer ever knew the secret, so
there is no race left to run, and no window in which holding the invoice
is nearly holding the money.

`h` is optional and additive. A wallet that sends none gets exactly the
behaviour it always got, so upgrading this mint breaks nothing that works
today, and the LUD-25 draft needs no change to allow it.

The rules:

- `h` is 64 hex characters, the sha256 of a 32-byte secret: the same
  meaning `h` carries on the withdraw callback. Upper case is accepted and
  read as lower case, there too.
- A malformed `h` is refused before the mint asks its funding source for
  anything, so a wallet is never left holding a quote the mint was always
  going to reject.
- An `h` that already names a note, an invoice, or a note another buyer
  has already bought is refused with `Invalid or already spent k1.`, the
  same sentence a colliding output gets on the withdraw callback. Which
  table an id sits in is an oracle nobody is owed.
- The callback's reply carries `mintToHash: true` when the invoice really
  was bound to `h`. A mint that did not implement the parameter would
  ignore it and answer without that field, so a wallet can tell the two
  apart before paying rather than by hunting for a note afterwards.
- The payRequest and the discovery document both advertise `mintToHash:
  true`, so a wallet knows this mint takes the parameter before it asks
  rather than after it pays.
- Claiming needs nothing else. `GET /w?k1=<the secret>` brings the note
  into existence as soon as the invoice has settled, with no `verify` poll
  and no preimage involved. The poll is still the way to claim from a mint
  that does not advertise `mintToHash`.
- **Persist the secret before asking for the invoice.** Paying and then
  losing the secret is the one way this is worse than the old arrangement,
  and writing it down first removes it entirely.

A named note is also derived-secret friendly: a wallet whose secrets come
from its seed can restore a note it bought but never claimed, which a note
whose secret was a preimage could never offer.

## A retried mutation is answered, not refused

Rotate, split and merge are GETs, and transports retry GETs. Go's
`net/http` retries one that failed on a reused idle connection; the JDK's
`HttpClient` retries idempotent methods with no switch to stop it. The
retry is byte-identical, and it arrives after the mint has already burned
the inputs.

Answering it "already spent" is what destroys money. A wallet that
believes the refusal - which is exactly what the error taxonomy tells it
to do - deletes the staged secret, and the mint keeps a note nobody can
ever spend.

So moneyer records which request minted which outputs, and a request that
has already minted its outputs gets the same reply again: same `OK`, same
signatures, nothing burned, nothing minted, no balance moved. A retry is
a read.

A request is the same request when it names the same input notes and asks
for the same outputs: the same `h`, the same `h2`, the same `amount`.
Input order does not matter, because a reordered retry is the same
operation. Anything else naming a burned note is a double-spend attempt
and still gets `Invalid or already spent k1.`, unchanged. Provenance is
recorded rather than inferred for that reason: matching on "a note exists
at `h`" alone would let anyone holding a burned `k1` and any outstanding
note id draw a success out of the mint.

The melt path is untouched: melts are deduplicated by payment hash, which
is a different question with a different answer.

This is moneyer's own behaviour. The LUD-25 draft says nothing about
retries yet; the suggested wording is on lnurl/luds#301 as a SHOULD.

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
MONEYER_ZAP_NAMES="alice=npub1...,bob=<hex pubkey>"   # optional, see below
```

The key and the relays go together; the names are optional, because a
mint can open registration and start with none of its own. A zap name's
payRequest carries `allowsNostr` and the mint's `nostrPubkey`, and
deliberately no `withdrawLink`. The receipt carries no preimage tag: it is
optional in NIP-57, and here it would only invite someone to mistake it
for the note. A zap name must not be the mint username or `_`. The kind
2525 rumor carries the zap request in a `description` tag, so a wallet can
show who zapped and what they wrote without fetching the receipt.

### Self-service: anyone with an npub can claim a name

Set `MONEYER_NAME_PRICE_MSAT` and the mint takes registrations. Unset
means registration is closed and `POST /names` 404s; `0` means free,
capped at three names per pubkey (rate limiting per address is the
reverse proxy's job).

```bash
curl -X POST https://mint.example/names \
  -H "Authorization: Nostr <base64 kind 27235 event>" \
  -d '{"name":"donkey","note":"https://mint.example/w?k1=...&amount=21000"}'
```

The NIP-98 event must be kind 27235, signed within 60 seconds, with `u`
set to the full URL, `method` set to `POST`, and `payload` set to the
SHA-256 of the exact body sent. **The key that signs it owns the name.**
No pubkey in the body is accepted, and there is no account, no password
and no recovery.

A paid registration hands over a note of this mint, as a URL or as a bare
secret. The mint burns the whole note - liabilities drop and the sats are
revenue - so send one worth exactly the price; split first if you need to.
A note worth less than the price is refused, and so is one from another
host. Nothing is burned unless the name is granted: the burn and the
registration are one transaction.

Names are `^[a-z0-9][a-z0-9_.-]{2,31}$`. The mint's own username, `_`,
`admin` and `mint` are reserved, as is any name already taken. Names are
permanent in this version; removing one is the operator's, through
`moneyer admin names rm`.

A registered name resolves on both rails at once:

- `name@mint.example` as a lightning address, paying out as a bearer note
  gift-wrapped to the owner's key.
- `GET /.well-known/nostr.json?name=<name>` as a NIP-05 address. Only the
  name asked for is answered: the list of everyone here is not something
  to hand out.

The discovery endpoint advertises `namePriceMsat` while registration is
open, so a wallet can offer the flow without asking.

## Endpoints

| | |
| --- | --- |
| `/.well-known/lnurlp/<user>` | LUD-16 payRequest; paying mints a note |
| `/.well-known/lnurlp/<zap name>` | NIP-57 payRequest; paying mints a note *to the name's pubkey* |
| `/.well-known/lnurlw/<user>` | LUD-25 mint address discovery (experimental) |
| `/p/cb` | LUD-06 pay callback; issues the mint invoice, and takes an optional `h` naming the note |
| `/z/cb/<zap name>` | the zap callback; validates the kind 9734 and issues the invoice |
| `/verify/<hash>` | LUD-21 verify, for mint invoices and melt payments |
| `/w` | LUD-03 informational GET; a live note also carries `payLink`, the route back to this mint's discovery document |
| `/w/cb` | the mutating callback: melt, rotate, split, merge |
| `POST /names` | claim a lightning address, authenticated by NIP-98 |
| `/.well-known/nostr.json` | NIP-05 for the names this mint serves |
| `/stats` | what the mint owes, what the node holds, and the coverage between them |
| `/metrics` | the same figures for a scraper, off by default |

## Operating

```bash
set -a; source /etc/moneyer/env; set +a
moneyer admin status
```

`moneyer admin` reads the same `MONEYER_*` environment the mint does, so
there is one description of a deployment and not two. It opens the
database **read-only** unless the command mutates: an operator poking at
a live mint should not be able to write to it by accident, and a mistyped
path should not silently create an empty database to answer from.

| command | does |
| --- | --- |
| `status` | liabilities, melts in flight, unsettled invoices, node balance and coverage, lifetime totals, keys |
| `notes [--state outstanding\|pending\|burned] [--limit n]` | list notes, newest first |
| `note <id\|k1>` | one note; 64 hex that names no note is hashed and looked up as the secret |
| `melts [--pending]` | list melts |
| `reconcile` | one pending-melt reconcile pass, printing what changed |
| `sweep` | delete mint invoices whose expiry is provably past |
| `snapshot <path>` | a consistent copy of the database, taken live, refusing to overwrite |
| `names list\|add <name> <npub>\|rm <name>` | the lightning addresses this mint pays out as notes |
| `keys rotate` | generate a signing key and print the two environment lines; writes nothing |
| `verify-note <url>` | check a note's signature offline, then say what the mint holds at that id |

`snapshot` uses SQLite's `VACUUM INTO`, so it needs no `sqlite3` binary on
the box and is safe to run against a live mint.

### Metrics

`MONEYER_METRICS=true` serves `GET /metrics` in the OpenMetrics text
format: `moneyer_outstanding_msat`, `moneyer_outstanding_notes`,
`moneyer_pending_melts`, `moneyer_oldest_pending_melt_seconds`,
`moneyer_local_balance_msat`, `moneyer_unsettled_mint_invoices`,
`moneyer_mints_total`, `moneyer_melts_total{outcome}` and
`moneyer_zaps_total`.

The app does not authenticate it. Restrict the path to your scraper at
the reverse proxy, the way `/stats` is left public deliberately and this
is not.

### The three alerts worth having

- **oldest pending melt over 30 minutes.** A melt that cannot be resolved
  is a note nobody can spend and a payment nobody can account for. The
  reconciler retries every five minutes; half an hour without a terminal
  answer means the funding source needs looking at.
- **coverage under 1.** The node cannot pay out every note it owes.
  Whether that is a channel imbalance or something worse, it is the one
  number a custodial mint must never be relaxed about.
- **unsettled invoices growing.** Invoices are issued and never paid all
  day, and the sweep clears the expired ones. A count that climbs through
  a sweep means invoices are being issued that nobody can pay.

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
