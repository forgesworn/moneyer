# Deploying moneyer against lnd

## Before you run this

A mint holds other people's bitcoin and owes it back to whoever holds the
secret. That is a custodial position, and in most jurisdictions it is the
custody of it - not the software - that a regulator has a view on. Read
this section before pointing the thing at mainnet.

**The perimeter follows the operator, not the code.** Publishing or
installing moneyer is not a regulated activity anywhere. Running a mint
that the public can pay, by way of business, may well be. In the UK the
test is "by way of business" (FCA PERG 2.3): degree of continuity, the
existence of a commercial element, scale, and how the activity sits
against everything else you do. None of those factors is decisive alone,
and the one you most directly control is the commercial element.

**Evaluation deployments should look like evaluation deployments.** If
this is a conformance target or a protocol demonstration rather than a
service you are offering, make that true in the configuration and not
only in the prose:

```bash
# MONEYER_NAME_PRICE_MSAT unset    # selling addresses is a priced product
MONEYER_MAX_SENDABLE_MSAT=100000   # a cap nobody could mistake for a bank
MONEYER_MOTD="Evaluation mint. Protocol testing only - assume any note here can be lost."
```

**Do not zero the fee to make the point.** A fee-free mint pays the melt
routing floor out of its own channel balance on every payout, and nothing
stops a griefer cycling mint-and-melt at minimum amounts to bleed it - see
the known limitations in `THREAT-MODEL.md`. Zeroing the fee buys a weaker
posture than the one you already have, at the cost of a real vector.

Keep it at cost recovery instead, and keep it **below** cost. The melt
routing budget is `max(0.5% of the amount, 5000 msat, the mint fee)`
(`meltFeeLimitMsat`, `src/server.ts`), so a fee of `5000 msat + 1000 ppm`
under-recovers on every note above about 1,250 sats, and by better than
threefold at the top of a 10k sat range. That is the useful fact: the fee
is structurally incapable of being a margin, which is a far stronger
statement about what it is for than charging nothing would be. Note that
"it does not cover my costs" is not the same argument and does not work -
a loss-making activity is still a commercial one. What matters is that the
fee is *priced as* a routing-cost pass-through and an anti-grief floor,
and that this is visible in the code and predates the question.

Better still, run against signet or a test network, where the notes are
worth nothing and the question does not arise.

**Do not take fiat. Ever.** moneyer is denominated in millisatoshis
throughout, and that is load-bearing rather than incidental. In the UK,
the Payment Services Regulations 2017 and the Electronic Money
Regulations 2011 both gate on "funds", defined exhaustively as banknotes
and coins, scriptural money and electronic money. Bitcoin is none of the
three, which is the whole reason a mint is not a payment institution or
an e-money issuer. Add a card on-ramp, price anything in GBP, settle a
melt in fiat, or denominate a note in a national currency, and all of
that closes at once - the last of those additionally lands you in the
qualifying-stablecoin regime. Keep the msat boundary intact.

**In the UK the operative registration is under the Money Laundering
Regulations 2017, not the payments regimes.** A person carrying on
business in the UK as a custodian wallet provider - safeguarding
cryptoassets, or the keys to them, on behalf of customers - or as a
cryptoasset exchange provider must be registered with the FCA; carrying
on unregistered is a criminal offence. There is no de minimis: the gate
is "by way of business", the same continuity-and-commercial-element
analysis as PERG 2.3, and the evaluation posture above is the argument,
not an exemption. The note itself is probably not an MLR cryptoasset -
the definition asks for distributed ledger technology, and a note is a
signature over a database row - which weakens the exchange limb. Custody
is the live one: the mint holds bitcoin against bearer liabilities, a
regulator reads substance, and substance says custodial wallet. A UK
operator offering a mint to the public as a business should expect the
question and have a better answer than "the IOU is mine". And know what
registration would ask in return: the travel rule (MLR Part 7A) obliges a
registered firm to pass originator and beneficiary information with a
transfer, which an anonymous bearer instrument cannot carry. A public UK
mint may be close to unregistrable as designed - a fact to weigh before
building a business on one, not a loophole to lean on.

**Marketing sits under its own regime, with a wider net.** Since October
2023 an invitation or inducement to acquire a qualifying cryptoasset is a
financial promotion: communicating one is a criminal offence for anyone
neither authorised nor MLR-registered, and the net is territorial in the
reader rather than the mint - a promotion capable of having an effect in
the UK is caught wherever the server sits. The definition does not even
require a blockchain: a transferable, fungible, cryptographically secured
representation of value or rights qualifies, and a note is all three. Two
consequences. Keep `MONEYER_ANNOUNCE` off unless the operator is
registered - hourly self-announcements are inducements by design. And
keep the site factual: no yields, no bonuses, no referral rewards,
nothing that reads as encouragement rather than manual. The site this
repo ships is written that way; keep it that way. (A registered firm may
approve its own promotions, and then owes the prescribed risk warning,
the 24-hour cooling-off and the incentives ban.)

**Sanctions bind the operator however the mint is classified.** Making
funds available to a designated person breaches the UK sanctions regime
independent of any FCA perimeter, and an anonymous bearer service
reachable over Tor has no screening capability at all. That cannot be
engineered away while the instrument is bearer; it can only be bounded -
small caps, a prohibited-use clause in the terms (TERMS-TEMPLATE.md
carries one), and no pretence, to yourself or to holders, that the risk
is closed.

**The perimeter is moving towards the mint.** The Financial Services and
Markets Act 2023 brings cryptoassets into the fold, and the draft
secondary legislation published under it in 2025 makes safeguarding
qualifying cryptoassets a regulated activity in its own right - the limb
aimed squarely at a custodial mint. Nothing to build against today except
the habit of reading it; the public `/stats` coverage figure is
incidentally the shape of the disclosure such a regime will expect.

**None of the above is legal advice.** If a mint you run holds value that
would matter to the person who lost it, get advice from someone qualified
in your jurisdiction before it does. In the UK the FCA's Innovation Hub
will give an informal steer on where its perimeter sits, for free.

## The node

No new Lightning node is needed if one already runs: moneyer is a Node
service that sits BESIDE an existing lnd and uses it as the funding
source.

**Sharing the node with another mint is a supported configuration.**
moneyer guards the melt path against the cross-mint replay a shared node
makes possible (an invoice melted at the other mint being "confirmed" here
against that foreign payment): it pre-checks the node's payment history
before reserving a note, and treats the node's "payment already exists"
refusal as a distinct, note-restoring outcome. Two caveats stand: the
mints share the node's liquidity, so keep the SUM of every mint's limits
inside what it can actually pay out; and only share with implementations
carrying the equivalent guard - the replay otherwise stays open on THEIR
side, not moneyer's. For separated books and blast radius, a second lnd
on the same box (bootstrapped with one channel from the first) is the
upgrade path; nothing about correctness requires it.

## 1. Credentials from lnd

moneyer needs invoice create/lookup and payment send/track. Bake a
macaroon scoped to exactly that, rather than handing it admin:

```bash
lncli bakemacaroon invoices:read invoices:write offchain:read offchain:write \
  --save_to /var/lib/moneyer/moneyer.macaroon
xxd -p -c 1000 /var/lib/moneyer/moneyer.macaroon   # the hex goes in the env
```

lnd's REST cert is self-signed; point Node at it rather than disabling
verification:

```
NODE_EXTRA_CA_CERTS=/path/to/lnd/tls.cert
```

## 2. The mint's own signing key

```bash
openssl rand -hex 32
```

Back it up: it is the mint's identity. Notes stay spendable if it is
lost, but every issued signature stops verifying against a replacement
key, and wallets that pinned the old pubkey will refuse the new one.

## 3. Environment

```bash
MONEYER_BACKEND=lnd
MONEYER_BACKEND_URL=https://127.0.0.1:8080        # lnd REST
MONEYER_BACKEND_MACAROON=<hex from step 1>
MONEYER_SIGNING_KEY=<hex from step 2>
MONEYER_PUBLIC_ORIGIN=https://mint.example        # the public identity
MONEYER_DB=/var/lib/moneyer/mint.sqlite
MONEYER_HOST=127.0.0.1
MONEYER_PORT=3737
MONEYER_USERNAME=mint
MONEYER_WALLET_URL=https://wallet.example         # optional: links minted notes into a web wallet
# start small until the deployment has earned trust:
MONEYER_MAX_SENDABLE_MSAT=1000000                 # 1000 sats
MONEYER_BASE_FEE_MSAT=1000
MONEYER_FEE_PPM=1000
```

The base fee is not just revenue: it is what funds the melt's routing-fee
budget, which is floored at 0.5% of the amount or 5000 msat so that even a
fee-free mint still routes. A fee-free mint pays that floor out of its own
channel balance on every melt, and nothing stops a griefer cycling
mint-and-melt at minimum amounts to bleed it - each round trip returns
their sats and costs the mint up to the floor in routing. Set
MONEYER_BASE_FEE_MSAT to at least cover it.

## 4. systemd

```ini
[Unit]
Description=moneyer - LNURLcash mint
After=network-online.target lnd.service

[Service]
User=moneyer
EnvironmentFile=/etc/moneyer/env
Environment=NODE_EXTRA_CA_CERTS=/path/to/lnd/tls.cert
WorkingDirectory=/opt/moneyer
ExecStart=/usr/bin/node dist/cli.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Pending melts reconcile automatically at startup and every five minutes
afterwards, so a restart mid-melt resolves itself against lnd rather than
guessing.

## 5. TLS front

moneyer binds loopback and expects a reverse proxy to terminate TLS.
Caddy makes it one stanza:

```
mint.example {
    reverse_proxy 127.0.0.1:3737
}
```

Wallets require https for clearnet mints - there is no plain-http mode to
misconfigure.

**Rate limit at this layer.** Every unauthenticated GET to `/p/cb` creates
a real invoice on the funding node. moneyer sweeps its own unsettled rows
once their bolt11 expiry has passed, but the node keeps its side of every
invoice until you clean it (cln's autoclean plugin, or a cron), and an
unthrottled loop can still pile up concurrent RPCs against the node. A few
requests per second per IP on `/p/cb` (and a generous ceiling on the rest)
is enough - wallets call it once per mint.

## 6. Shakedown before real limits

The lnd backend is a faithful port of the reference mint's semantics but
list your deployment as beta until it has moved sats on YOUR node:

```bash
npx lnurlcash-conform mint@mint.example                      # read-only
# then mint the smallest note the fees allow, and spend it:
npx lnurlcash-conform mint@mint.example --note='...' --spend
```

The grader exits non-zero on any failure, and its spending run includes
the adversarial shapes (duplicated k1, output-id collision, h equal to
h2) a mint must refuse atomically. Raise MONEYER_MAX_SENDABLE_MSAT only
after that passes and a few real mint/melt round trips settle cleanly.

For the receipt path itself, run the repository's resumable real-node check
from a built checkout. It needs a second Lightning node: the payer command
receives the mint invoice as its final argument, and the refund command must
print a fresh **amountless** invoice so moneyer can melt the whole test note
back to the payer.

```bash
npm run live:bound-mint -- \
  --pay-url https://mint.example/.well-known/lnurlp/mint \
  --amount-sat 56 \
  --state /var/lib/moneyer-checks/bound-mint.json \
  --payer ssh payer.example lncli payinvoice --force \
  --refund ssh payer.example lncli addinvoice
```

This spends real sats. The state file is created with mode `0600` and contains
the staged bearer secret before any quote or payment exists. Payer stdout may
be JSON, a table, or empty: the check ignores it and proves settlement from
LUD-21 instead. If either command or the network is interrupted, keep the
state file and rerun the exact command. On success the refund has settled,
the test note is burned, and the state file retains only public audit fields.
