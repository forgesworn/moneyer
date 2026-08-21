// What the mint knows, in one place so the README, the landing page and
// the mint's own site cannot drift apart on it.
//
// The one property a LUD-25 mint cannot offer is blindness. A reader
// arriving from an ecash wallet will assume otherwise unless told, so
// this is written to be read before anyone trusts the mint with sats,
// not buried in a threat model.

export const MINT_KNOWS_HEADING = 'What the mint knows'

export const MINT_KNOWS: readonly string[] = [
  'This mint knows every note it has issued and what each is worth. It knows every rotate, split and merge, the links between them - which note became which, and when - and the network address the request came from. It knows the invoice a melt paid.',
  'It does not know who holds a note between those operations. A note handed to someone else offline leaves no trace here until they rotate it, which is one reason a wallet rotates on receipt.',
  'The wallet-side mitigations are weak, and worth naming as weak. A Tor or SOCKS proxy hides the address, not the links. Rotating at unpredictable times blurs the timing, not the graph. Nothing a holder does stops this mint seeing the chain of notes it struck.',
  'The design was chosen anyway because it needs no new cryptography, any LUD-03 wallet can cash a note out, and verifying a note offline needs a signature and nothing else. The privacy story is trust the operator, and that is worth saying plainly.'
]
