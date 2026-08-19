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

```bash
# development: fake funding source, in-memory store, a funded note printed
npx moneyer --dev

# production shape
MONEYER_BACKEND=cln \
MONEYER_BACKEND_URL=https://127.0.0.1:3010 \
MONEYER_BACKEND_RUNE=... \
MONEYER_SIGNING_KEY=<32 bytes hex> \
MONEYER_PUBLIC_ORIGIN=https://mint.example \
MONEYER_DB=/var/lib/moneyer/mint.sqlite \
moneyer
```

The mint is then payable at `mint@mint.example` (and the bare-domain `_`
alias). Configuration is environment-only; see `src/config.ts` for the
full `MONEYER_*` set including fees (`MONEYER_BASE_FEE_MSAT`,
`MONEYER_FEE_PPM`), limits, and `MONEYER_SUNSET` for winding down without
stranding holders.

As a library:

```ts
import {createMoneyer, configFromEnv} from '@forgesworn/moneyer'
const mint = await createMoneyer(configFromEnv())
```

## Endpoints

| | |
| --- | --- |
| `/.well-known/lnurlp/<user>` | LUD-16 payRequest; paying mints a note |
| `/.well-known/lnurlw/<user>` | LUD-25 mint address discovery (experimental) |
| `/p/cb` | LUD-06 pay callback; issues the mint invoice |
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

## Licence

MIT.
