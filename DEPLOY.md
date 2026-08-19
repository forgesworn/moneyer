# Deploying moneyer against lnd

No new Lightning node is needed if one already runs: moneyer is a Node
service that sits BESIDE an existing lnd and uses it as the funding
source. Several mints can share one lnd - every invoice and payment is
keyed by its own hash - but they share its liquidity, so keep the sum of
all mints' limits inside what the node can actually pay out.

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
# start small until the deployment has earned trust:
MONEYER_MAX_SENDABLE_MSAT=1000000                 # 1000 sats
MONEYER_BASE_FEE_MSAT=1000
MONEYER_FEE_PPM=1000
```

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

Pending melts reconcile automatically at startup, so a restart mid-melt
resolves itself against lnd rather than guessing.

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
