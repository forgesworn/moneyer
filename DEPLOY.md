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

**None of the above is legal advice.** If a mint you run holds value that
would matter to the person who lost it, get advice from someone qualified
in your jurisdiction before it does.

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
