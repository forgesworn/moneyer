import {sha256} from '@noble/hashes/sha2.js'
import {schnorr, secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, concatBytes, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {bech32m} from '@scure/base'

// LUD-25 notes and their spends.
//
// Every note is a BIP-341 taproot output key Q, and this mint stores it
// under hex(Q). A `k1` a redeemer presents is a spend of one:
//
//   ck1<Q || sig>   key path: a BIP-340 signature by Q
//   cw1<...>        script path: a leaf of Q's tree, its control block and
//                   the witness that satisfies it
//   64 hex          a bearer note's preimage, the short form of its cw1
//
// Every signature signs the BIP-341 sighash of input 0 of one fixed,
// never-broadcast transaction whose prevout is bound to this mint's domain,
// so a spend one mint has seen cannot be replayed at another. The rules
// here follow lnurlcash/kernel, the reference mint's verifier, field for
// field; where the two could disagree the kernel is right.
//
// Nothing here is secret. Every key, leaf and control block is public, so
// none of this needs to be constant-time.

export const TAPLEAF_VERSION = 0xc0
export const KEY_PATH_LOCKTIME = 0
export const KEY_PATH_SEQUENCE = 0xffffffff

// BIP-341's nothing-up-my-sleeve point. Nobody knows its discrete log, so
// a note built on it has no key path: only its leaf can spend it.
export const NUMS_H = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0')

const HEX32 = /^[0-9a-f]{64}$/i
const MAX_MERKLE_DEPTH = 128
// BIP-342 keeps the 520-byte cap on every initial stack element.
const MAX_STACK_ELEMENT = 520
// No URL gets near this; it only stops a hostile string costing work.
const MAX_BECH32_CHARS = 8192
const CURVE_ORDER = secp256k1.Point.CURVE().n

const taggedHash = (tag: string, ...parts: Uint8Array[]): Uint8Array => schnorr.utils.taggedHash(tag, ...parts)

const compactSize = (n: number): Uint8Array => {
  if (n < 0xfd) return new Uint8Array([n])
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, n >> 8])
  const out = new Uint8Array(5)
  out[0] = 0xfe
  new DataView(out.buffer).setUint32(1, n, true)
  return out
}

const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, true)
  return out
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const liftX = (x: Uint8Array) => {
  if (x.length !== 32) return null
  try {
    return schnorr.utils.lift_x(BigInt(`0x${bytesToHex(x)}`))
  } catch {
    return null
  }
}

// Is `x` the x coordinate of a curve point? LUD-25 has a mint refuse a cp1
// that is not: no spend could ever open it.
export const isXOnlyPoint = (x: Uint8Array): boolean => liftX(x) !== null

export const tapLeafHash = (script: Uint8Array, version = TAPLEAF_VERSION): Uint8Array =>
  taggedHash('TapLeaf', new Uint8Array([version]), compactSize(script.length), script)

// Q = lift_x(P) + tagged_hash("TapTweak", P || root)·G, with Q's parity.
// Null if P is not a point or the tweak is out of range.
export const taprootTweak = (
  internalKey: Uint8Array,
  merkleRoot: Uint8Array
): {outputKey: Uint8Array; parity: 0 | 1} | null => {
  const p = liftX(internalKey)
  if (!p) return null
  const t = BigInt(`0x${bytesToHex(taggedHash('TapTweak', internalKey, merkleRoot))}`)
  if (t >= CURVE_ORDER) return null
  const q = p.add(secp256k1.Point.BASE.multiply(t))
  if (q.equals(secp256k1.Point.ZERO)) return null
  return {outputKey: schnorr.utils.pointToBytes(q), parity: q.y % 2n === 0n ? 0 : 1}
}

// The Q a leaf and its control block commit to, or null if the control
// block is malformed. The parity bit is checked too, so a Q returned here
// is exactly the one the spend is valid against.
export const outputKeyOf = (script: Uint8Array, controlBlock: Uint8Array): Uint8Array | null => {
  if (controlBlock.length < 33 || (controlBlock.length - 33) % 32 !== 0) return null
  if ((controlBlock.length - 33) / 32 > MAX_MERKLE_DEPTH) return null
  let node = tapLeafHash(script, controlBlock[0]! & 0xfe)
  for (let i = 33; i < controlBlock.length; i += 32) {
    const sibling = controlBlock.subarray(i, i + 32)
    node = bytesToHex(node) < bytesToHex(sibling)
      ? taggedHash('TapBranch', node, sibling)
      : taggedHash('TapBranch', sibling, node)
  }
  const tweaked = taprootTweak(controlBlock.subarray(1, 33), node)
  if (!tweaked || tweaked.parity !== (controlBlock[0]! & 1)) return null
  return tweaked.outputKey
}

// ---- the bearer note ----
//
// NUMS internal key, one `OP_SHA256 <h> OP_EQUAL` leaf: spent by revealing
// the preimage, with no signature and so bound to no mint. Everything but
// the preimage follows from h, which is why its short forms work.

export const bearerLeaf = (h: Uint8Array): Uint8Array => {
  if (h.length !== 32) throw new Error('h must be 32 bytes.')
  return concatBytes(new Uint8Array([0xa8, 0x20]), h, new Uint8Array([0x87]))
}

export const bearerNote = (h: Uint8Array): {outputKey: Uint8Array; controlBlock: Uint8Array; leaf: Uint8Array} => {
  const leaf = bearerLeaf(h)
  const tweaked = taprootTweak(NUMS_H, tapLeafHash(leaf))
  // NUMS_H is a point and a hash is never out of range in practice.
  if (!tweaked) throw new Error('Bearer note tweak failed.')
  return {
    outputKey: tweaked.outputKey,
    controlBlock: concatBytes(new Uint8Array([TAPLEAF_VERSION | tweaked.parity]), NUMS_H),
    leaf
  }
}

// hex(Q) of the bearer note whose hash is `hHex`.
export const bearerNoteId = (hHex: string): string => bytesToHex(bearerNote(hexToBytes(hHex.toLowerCase())).outputKey)

// hex(Q) of the bearer note a hex preimage opens.
export const bearerNoteIdOfPreimage = (k1Hex: string): string =>
  bytesToHex(bearerNote(sha256(hexToBytes(k1Hex.toLowerCase()))).outputKey)

// ---- a cx1 branch's note keys ----
//
//   t    = tagged_hash("LNURLcash/derive", P || chaincode || ser32(purpose) || ser32(i)) mod n
//   pk_i = x(lift_x(P) + t·G)
//
// `purpose` splits one branch into independent counters so a wallet's own
// indices and this mint's auto-minted ones never meet. The mint derives on
// two: the wallet's index 0 proves a name's cx1, and Lightning Address
// payments land on their own counter.
export const NOTE_PURPOSE_WALLET = 0
export const NOTE_PURPOSE_CHANGE = 1
export const NOTE_PURPOSE_LIGHTNING_ADDRESS = 2

const ser32 = (n: number): Uint8Array => {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, n, false)
  return bytes
}

// Throws for the vanishingly rare tweak that lands on the point at infinity.
export const deriveNotePubkey = (
  branchPubkeyXOnly: Uint8Array,
  chainCode: Uint8Array,
  purpose: number,
  index: number
): Uint8Array => {
  const p = liftX(branchPubkeyXOnly)
  if (!p) throw new Error('branch key is not on the curve')
  const t =
    BigInt(`0x${bytesToHex(taggedHash('LNURLcash/derive', branchPubkeyXOnly, chainCode, ser32(purpose), ser32(index)))}`) %
    CURVE_ORDER
  return schnorr.utils.pointToBytes(p.add(secp256k1.Point.BASE.multiply(t)))
}

// The `h` inside a leaf, if the leaf is exactly a bearer note's.
const bearerHashOfLeaf = (script: Uint8Array): Uint8Array | null =>
  script.length === 35 && script[0] === 0xa8 && script[1] === 0x20 && script[34] === 0x87 ? script.subarray(2, 34) : null

// ---- what a signature signs ----

// The bare lowercase hostname a spend at `origin` is bound to: never the
// scheme or the port.
export const spendDomainOf = (origin: string): string => new URL(origin).hostname.toLowerCase()

export const spendPrevout = (domain: string): Uint8Array => {
  if (!domain) throw new Error('A spend domain is required.')
  return taggedHash('LNURLcash/mint', utf8ToBytes(domain.toLowerCase()))
}

const I64_ZERO = new Uint8Array(8)

// BIP-341's SigMsg for input 0 of the canonical spend transaction under
// SIGHASH_DEFAULT, with BIP-342's extension when a leaf is given.
export const spendSigMsg = (args: {
  outputKey: Uint8Array
  domain: string
  locktime: number
  sequence: number
  leafScript?: Uint8Array
}): Uint8Array => {
  if (args.outputKey.length !== 32) throw new Error('Q must be 32 bytes.')
  const scriptPubKey = concatBytes(new Uint8Array([0x51, 0x20]), args.outputKey)
  const parts = [
    new Uint8Array([0x00]), // hash_type
    u32le(2), // nVersion
    u32le(args.locktime),
    sha256(concatBytes(spendPrevout(args.domain), u32le(0))), // sha_prevouts
    sha256(I64_ZERO), // sha_amounts
    sha256(concatBytes(new Uint8Array([scriptPubKey.length]), scriptPubKey)), // sha_scriptpubkeys
    sha256(u32le(args.sequence)), // sha_sequences
    sha256(concatBytes(I64_ZERO, new Uint8Array([0x00]))), // sha_outputs
    new Uint8Array([args.leafScript ? 0x02 : 0x00]), // spend_type, no annex
    u32le(0) // input_index
  ]
  if (args.leafScript) {
    parts.push(tapLeafHash(args.leafScript), new Uint8Array([0x00]), new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  }
  return concatBytes(...parts)
}

const tapSighash = (sigMsg: Uint8Array): Uint8Array => taggedHash('TapSighash', new Uint8Array([0x00]), sigMsg)

// What a ck1's signature signs.
export const keyPathSighash = (outputKey: Uint8Array, domain: string): Uint8Array =>
  tapSighash(spendSigMsg({outputKey, domain, locktime: KEY_PATH_LOCKTIME, sequence: KEY_PATH_SEQUENCE}))

// What a SIGHASH_DEFAULT signature inside a cw1's leaf signs.
export const scriptPathSighash = (
  outputKey: Uint8Array,
  domain: string,
  leafScript: Uint8Array,
  locktime: number,
  sequence: number
): Uint8Array => tapSighash(spendSigMsg({outputKey, domain, locktime, sequence, leafScript}))

// ---- the wire values ----

const decodeBech32m = (value: string, hrp: string): Uint8Array | null => {
  try {
    const decoded = bech32m.decode(value as `${string}1${string}`, MAX_BECH32_CHARS)
    return decoded.prefix === hrp ? bech32m.fromWords(decoded.words) : null
  } catch {
    return null
  }
}

export const encodeCp1 = (outputKey: Uint8Array): string => bech32m.encode('cp', bech32m.toWords(outputKey), MAX_BECH32_CHARS)

export const encodeCk1 = (outputKey: Uint8Array, signature: Uint8Array): string =>
  bech32m.encode('ck', bech32m.toWords(concatBytes(outputKey, signature)), MAX_BECH32_CHARS)

// A `cp1`, only if its Q is a point.
export const decodeCp1 = (value: string): Uint8Array | null => {
  const q = decodeBech32m(value.trim(), 'cp')
  return q && q.length === 32 && isXOnlyPoint(q) ? q : null
}

// hex(Q) of whatever was put where a `cp1` goes - a mint comment, p1/p2,
// ?p= - a `cp1`, or a bearer note's 64-hex `h`. Null if it is neither.
export const decodeNote = (value: string): string | null => {
  const trimmed = value.trim()
  if (HEX32.test(trimmed)) return bearerNoteId(trimmed)
  const q = decodeCp1(trimmed)
  return q ? bytesToHex(q) : null
}

export type ScriptSpend = {
  kind: 'script'
  outputKey: Uint8Array
  locktime: number
  sequence: number
  script: Uint8Array
  controlBlock: Uint8Array
  // Bottom of the stack first, script and control block excluded.
  witness: Uint8Array[]
}

export type Spend =
  | {kind: 'key'; outputKey: Uint8Array; signature: Uint8Array}
  | ScriptSpend
  // A ck1 from before LUD-25 carried Q: a bare 65-byte recoverable ECDSA
  // signature over a fixed message. Recovering the key IS its check.
  | {kind: 'recovered'; outputKey: Uint8Array}

export const encodeCw1 = (spend: Omit<ScriptSpend, 'kind' | 'outputKey'>): string => {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(0, spend.locktime, false)
  new DataView(head.buffer).setUint32(4, spend.sequence, false)
  const items = [spend.script, spend.controlBlock, ...spend.witness].map(item => {
    const len = new Uint8Array(2)
    new DataView(len.buffer).setUint16(0, item.length, false)
    return concatBytes(len, item)
  })
  return bech32m.encode('cw', bech32m.toWords(concatBytes(head, ...items)), MAX_BECH32_CHARS)
}

const decodeCw1 = (value: string): ScriptSpend | null => {
  const data = decodeBech32m(value, 'cw')
  if (!data || data.length < 8) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const parts: Uint8Array[] = []
  let i = 8
  while (i < data.length) {
    if (i + 2 > data.length) return null
    const n = view.getUint16(i, false)
    i += 2
    if (i + n > data.length) return null
    parts.push(data.slice(i, i + n))
    i += n
  }
  if (parts.length < 2) return null
  const outputKey = outputKeyOf(parts[0]!, parts[1]!)
  if (!outputKey) return null
  return {
    kind: 'script',
    outputKey,
    locktime: view.getUint32(0, false),
    sequence: view.getUint32(4, false),
    script: parts[0]!,
    controlBlock: parts[1]!,
    witness: parts.slice(2)
  }
}

// The Lightning-signed-message digest the pre-LUD-25 recoverable ck1 signed.
const LEGACY_ECDSA_DIGEST = sha256(sha256(utf8ToBytes('Lightning Signed Message:LNURLcash')))

const recoverLegacyCk1 = (signature: Uint8Array): Uint8Array | null => {
  try {
    const recidLeading = concatBytes(new Uint8Array([signature[64]!]), signature.subarray(0, 64))
    return secp256k1.recoverPublicKey(recidLeading, LEGACY_ECDSA_DIGEST, {prehash: false}).subarray(1)
  } catch {
    return null
  }
}

// What a redeemer put in `k1`, decoded, or null if it is no spend at all.
// Nothing here checks a signature against a note: that needs the note's
// record and this mint's domain (see verifySpend).
export const decodeSpend = (k1: string): Spend | null => {
  const value = k1.trim()
  if (HEX32.test(value)) {
    const preimage = hexToBytes(value.toLowerCase())
    const note = bearerNote(sha256(preimage))
    return {
      kind: 'script',
      outputKey: note.outputKey,
      locktime: KEY_PATH_LOCKTIME,
      sequence: KEY_PATH_SEQUENCE,
      script: note.leaf,
      controlBlock: note.controlBlock,
      witness: [preimage]
    }
  }
  const ck1 = decodeBech32m(value, 'ck')
  if (ck1) {
    if (ck1.length === 96) return {kind: 'key', outputKey: ck1.slice(0, 32), signature: ck1.slice(32)}
    if (ck1.length === 65) {
      const outputKey = recoverLegacyCk1(ck1)
      return outputKey ? {kind: 'recovered', outputKey} : null
    }
    return null
  }
  return decodeCw1(value)
}

// ---- verifying a spend ----

// BIP-342's OP_SUCCESSx: 80, 98, 126-129, 131-134, 137-138, 141-142,
// 149-153, 187-254.
const OP_SUCCESS = new Set<number>([80, 98, 137, 138, 141, 142])
for (const [from, to] of [
  [126, 129],
  [131, 134],
  [149, 153],
  [187, 254]
] as const) {
  for (let op = from; op <= to; op++) OP_SUCCESS.add(op)
}

const opcodes = function* (script: Uint8Array): Generator<number> {
  let i = 0
  while (i < script.length) {
    const op = script[i]!
    i += 1
    if (op >= 1 && op <= 75) i += op
    else if (op === 0x4c) {
      if (i + 1 > script.length) return
      i += 1 + script[i]!
    } else if (op === 0x4d) {
      if (i + 2 > script.length) return
      i += 2 + (script[i]! | (script[i + 1]! << 8))
    } else if (op === 0x4e) {
      if (i + 4 > script.length) return
      i += 4 + new DataView(script.buffer, script.byteOffset + i, 4).getUint32(0, true)
    } else yield op
  }
}

// Tapscript's upgrade hooks succeed unconditionally, so a leaf using one
// would be spendable by anyone who saw it. Refused before anything runs.
export const checkLeaf = (script: Uint8Array, controlBlock: Uint8Array): string | null => {
  if (controlBlock.length === 0 || (controlBlock[0]! & 0xfe) !== TAPLEAF_VERSION) return 'unknown tapleaf version'
  for (const op of opcodes(script)) {
    if (OP_SUCCESS.has(op)) return 'leaf uses a reserved OP_SUCCESS opcode'
  }
  return null
}

const LOCKTIME_THRESHOLD = 500_000_000
const SEQUENCE_DISABLE_FLAG = 0x80000000
const CSV_TYPE_FLAG = 1 << 22

// The redeemer's signed time claim against this mint's own clock, in Unix
// seconds. A timelock "verified" here means this mint asserted its clock:
// a custodial policy, not a consensus proof, and never to be described as
// trustless.
export const checkTimeClaim = (claim: {locktime: number; sequence: number; now: number; lockedAt: number}): string | null => {
  if (claim.locktime !== 0) {
    if (claim.locktime < LOCKTIME_THRESHOLD) return 'block-height locktimes have no meaning without a chain'
    if (claim.locktime > claim.now) return `locktime ${claim.locktime} is in the future (now ${claim.now})`
  }
  if ((claim.sequence & SEQUENCE_DISABLE_FLAG) !== 0) return null
  if ((claim.sequence & CSV_TYPE_FLAG) === 0) return 'block-count relative locks have no meaning without a chain'
  const elapsed = claim.now - claim.lockedAt
  const required = (claim.sequence & 0xffff) * 512
  if (elapsed < required) return `relative lock of ${required}s not yet satisfied (${Math.max(elapsed, 0)}s elapsed)`
  return null
}

// Judges a leaf this mint cannot evaluate itself. Resolves null when the
// spend is valid, or the reason it is not.
export type ScriptVerifier = (args: {
  outputKey: Uint8Array
  domain: string
  spend: ScriptSpend
  now: number
  lockedAt: number
}) => Promise<string | null>

export type SpendVerdict = {ok: true} | {ok: false; reason: string; specific: boolean}

const LEGACY_OWNERSHIP_MESSAGE = utf8ToBytes('LNURLcash')
const LEGACY_OWNERSHIP_DIGEST = sha256(LEGACY_OWNERSHIP_MESSAGE)

const schnorrVerifies = (signature: Uint8Array, message: Uint8Array, key: Uint8Array): boolean => {
  try {
    return schnorr.verify(signature, message, key)
  } catch {
    return false
  }
}

// Does `spend` open the note `outputKey`? `domains` are every host this
// mint answers on: a signature bound to any of them is this mint's.
// `lockedAt` is when this mint credited the note, where a relative lock
// starts counting.
//
// A key-path failure is never explained: it would only help someone guess.
// A script path's reason is safe to hand back (`specific`), since the cw1
// already discloses everything it has.
export const verifySpend = async (
  spend: Spend,
  context: {outputKey: Uint8Array; domains: string[]; now: number; lockedAt: number; scriptVerifier?: ScriptVerifier}
): Promise<SpendVerdict> => {
  const invalid: SpendVerdict = {ok: false, reason: 'invalid', specific: false}
  if (!equalBytes(spend.outputKey, context.outputKey)) return invalid
  if (spend.kind === 'recovered') return {ok: true}
  if (spend.kind === 'key') {
    for (const domain of context.domains) {
      if (schnorrVerifies(spend.signature, keyPathSighash(spend.outputKey, domain), spend.outputKey)) return {ok: true}
    }
    // Deprecated: the fixed messages a ck1 signed before every spend moved
    // onto the canonical transaction. Kept, as the reference mint keeps
    // them, so notes already handed out stay redeemable.
    if (
      schnorrVerifies(spend.signature, LEGACY_OWNERSHIP_DIGEST, spend.outputKey) ||
      schnorrVerifies(spend.signature, LEGACY_OWNERSHIP_MESSAGE, spend.outputKey)
    ) {
      return {ok: true}
    }
    return invalid
  }
  const specific = (reason: string): SpendVerdict => ({ok: false, reason, specific: true})
  const leafProblem = checkLeaf(spend.script, spend.controlBlock)
  if (leafProblem) return specific(leafProblem)
  const timeProblem = checkTimeClaim({
    locktime: spend.locktime,
    sequence: spend.sequence,
    now: context.now,
    lockedAt: context.lockedAt
  })
  if (timeProblem) return specific(timeProblem)
  // A bearer leaf, under any internal key and at any depth, is evaluated
  // here: OP_SHA256 <h> OP_EQUAL leaves exactly one element, true only for
  // a lone witness item under the stack-element cap that hashes to h. That
  // is the whole of what Bitcoin Core would decide about it.
  const h = bearerHashOfLeaf(spend.script)
  if (h) {
    const [preimage, ...rest] = spend.witness
    if (!preimage || rest.length > 0 || preimage.length > MAX_STACK_ELEMENT) return specific('the witness does not satisfy the leaf')
    return equalBytes(sha256(preimage), h) ? {ok: true} : specific('the witness does not satisfy the leaf')
  }
  if (!context.scriptVerifier) return specific('this mint cannot verify that script yet')
  let last = 'bitcoin core rejected the spend'
  for (const domain of context.domains) {
    const reason = await context.scriptVerifier({
      outputKey: context.outputKey,
      domain,
      spend,
      now: context.now,
      lockedAt: context.lockedAt
    })
    if (reason === null) return {ok: true}
    last = reason
  }
  return specific(last)
}
