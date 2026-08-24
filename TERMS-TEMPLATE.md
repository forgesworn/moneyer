# Terms template

A starting point for `MONEYER_TOS_URL`. Adapt it, host it, point the
variable at it. Angle brackets mark what an operator must fill in; the
rest is written to be true of any moneyer mint and should only change if
your deployment makes it untrue.

This is a template, not legal advice. If your mint holds value that would
matter to the person who lost it, have someone qualified in your
jurisdiction read this before you publish it.

---

## Terms for <mint.example>

Last updated: <date>

### What this is

<mint.example> is an evaluation mint for the
[LUD-25 draft](https://github.com/lnurl/luds/pull/301), running
[moneyer](https://github.com/forgesworn/moneyer). It exists to
demonstrate the protocol and to give wallet and mint implementers
something to grade against.

It is not a place to keep money. Notes on this mint are for testing the
protocol, and you should not hold value here that you would mind losing.

### What a note is

A note is a bearer instrument. Whoever holds its secret can spend it, and
the mint cannot tell one holder from another - there are no accounts, no
passwords and no recovery. In particular:

- **Lose the secret and the value is gone.** Nobody can restore it, this
  mint included.
- **Disclose the secret and whoever sees it can spend the note.** Treat it
  the way you would treat cash.
- A note is a claim on this mint and nothing else. It is not backed by any
  third party, and it is not a claim on the Bitcoin network.

### No guarantee of redemption

This mint will try to honour every note it has struck. It does not
promise to, and you should not rely on it doing so. Redemption can fail
for reasons inside the operator's control and outside it: insufficient
channel liquidity, a funding source that is down, a host that is gone, or
the operator winding the mint down.

The mint publishes what it owes and what it holds at `/stats`, updated
continuously and signed hourly. Read it before you trust the mint with
anything. A `coverage` figure below 1 means the mint could not pay every
note out today.

The service is provided as is, without warranty of any kind. To the
fullest extent the law allows, the operator accepts no liability for any
loss arising from its use. That sentence has a floor: nothing in these
terms limits a liability the law does not allow to be limited, and if you
use this mint as a consumer, the statutory rights your law does not let
you sign away - in the UK, those the Consumer Rights Act 2015 implies -
are unaffected.

### Wind-down

If this mint is retired, it will be put into sunset mode: it will refuse
anything that grows what it owes, and keep every way out open, so
outstanding notes can be melted. <Notice will be given through the mint's
MOTD and at <contact> at least <n> days beforehand.> Notes not melted by
then may not be redeemable.

### Limits and fees

- Smallest note: <n> sats. Largest note: <n> sats.
- The mint fee is `<base> msat + <ppm> ppm`, published in the payRequest
  metadata and on the discovery endpoint before you pay.

The fee is set to recover the routing cost the mint commits to when it
pays a note out, and is not priced to make a margin. The melt routing
budget is `max(0.5% of the amount, 5000 msat, the mint fee)`, so above
roughly 1,250 sats the fee does not cover it.

### What the mint knows

This mint is not blind, and that is a property of LUD-25 rather than a
choice this deployment made. See
[What the mint knows](<mint.example>) - published on the mint's own site
and in its discovery document - for the full statement. In short: it
knows every note it issued, what each is worth, the links between them,
and the address each request came from. It does not know who holds a note
between operations.

Do not use this mint for anything where that matters to you.

That statement is also the privacy notice in outline. The personal data
are the network addresses requests arrive from and any zap names bound to
pubkeys; the operator holds them to run the mint and for nothing else,
keeps them for <retention period>, and does not sell or share them except
under compulsion of law. Where your law gives you rights over your data -
in the UK, the UK GDPR rights of access, correction and deletion -
contact <contact> to exercise them.

### What this mint is not

- **Not a bank, and not a deposit-taker.** A note is not a deposit. There
  is no depositor protection scheme behind it, in any jurisdiction.
- **Not a payment or e-money service.** This mint accepts and pays out
  bitcoin only. It does not accept, hold, or pay out any national
  currency, and no note is denominated in one.
- **Not a regulated financial service**, and not offered as one.
  <The operator is not authorised or registered by <regulator>.>

### Use

Use this mint lawfully. Do not use it if you are designated under UK, UN,
EU or US sanctions lists (or those of <jurisdiction>), and do not use it
to move value to or for anyone who is: a bearer mint cannot screen its
holders, so that duty sits with you. The operator may refuse or reverse
service, and may cooperate with lawful requests from authorities in
<jurisdiction>.

### Operator and contact

<Operated by <name>, <jurisdiction>. Reach the operator at <contact>.>

### Changes

These terms may change. The current version is always the one at this
URL, and material changes will be flagged through the mint's MOTD.

### Governing law

<These terms are governed by the law of <jurisdiction>.>
