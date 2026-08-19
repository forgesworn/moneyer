# Security policy

moneyer moves real money. If you find a way to make it move the wrong way,
please report it privately.

## Reporting

Open a GitHub security advisory on this repository (Security tab, "Report
a vulnerability"), or contact the maintainer privately. Please do not open
a public issue for anything that could cost an operator or a holder funds
before a fix exists.

Include what you can: the endpoint or flow, a reproduction against
`moneyer --dev` (never against someone's live mint), and what an attacker
gains.

## Scope

In scope: anything that burns, mints, restores or reveals a note contrary
to the rules in THREAT-MODEL.md; anything that makes the melt discipline
guess; anything that lets a request cross the store's atomicity.

Out of scope: denial of service against an unproxied dev deployment,
vulnerabilities in the funding source itself, and social engineering.

## Supported versions

Pre-1.0: only the latest release is supported. Pin an exact version; the
LUD-25 spec is still a draft and wire behaviour may follow it.
