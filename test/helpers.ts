import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {applyMintFee, verifyNoteSignatureHash, type MintFee} from '@lnurlcash/kit'
import type {MoneyerConfig} from '../src/config.ts'
import {createFakeBackend, type FakeBackend} from '../src/backends/fake.ts'
import {createMoneyer, type Moneyer, type MoneyerDeps} from '../src/server.ts'
import {decodeSpend} from '../src/spend.ts'

// A deterministic signing key for tests: the same one the conformance mock
// mint uses, so signature bytes can be compared across implementations.
export const TEST_SIGNING_KEY = '11'.repeat(32)

export const testConfig = (overrides: Partial<MoneyerConfig> = {}): MoneyerConfig => ({
  host: '127.0.0.1',
  port: 0,
  username: 'mint',
  description: 'an LNURLcash note',
  minSendableMsat: 1000,
  maxSendableMsat: 100_000_000,
  minMintMsat: 1000,
  mintFee: null,
  signingKey: TEST_SIGNING_KEY,
  dbPath: ':memory:',
  backend: {kind: 'fake'},
  verify: true,
  maxK1s: 21,
  sunset: false,
  ...overrides
})

export type TestMint = {moneyer: Moneyer; backend: FakeBackend}

export const startMint = async (
  overrides: Partial<MoneyerConfig> = {},
  // `backend` is accepted here so a test can hand in a fake configured
  // differently - a node that mints its own invoice preimages, say - without
  // rebuilding the whole start path.
  deps: Omit<MoneyerDeps, 'backend'> & {backend?: FakeBackend} = {}
): Promise<TestMint> => {
  const backend = deps.backend ?? createFakeBackend()
  const moneyer = await createMoneyer(testConfig(overrides), {
    backend,
    confirmDelaysMs: [0, 10, 20],
    // Hermetic by default: a web build lying around must not change what
    // tests see. web-serving.test.ts opts back in with a stub dist.
    webAssets: null,
    ...deps
  })
  return {moneyer, backend}
}

export const freshK1 = (): string => bytesToHex(randomBytes(32))

// Test-side prediction only. Production accepts the same range through
// withinMintFeeBand; the shared kit deliberately does not expose UI ranges.
export const mintFeeBand = (
  grossMsat: number,
  fee: MintFee
): {minNetMsat: number; maxNetMsat: number} => {
  const maxNetMsat = applyMintFee(grossMsat, fee)
  const exactFee = grossMsat - maxNetMsat
  return {
    minNetMsat: Math.max(0, grossMsat - Math.ceil(exactFee / 1000) * 1000),
    maxNetMsat
  }
}

export const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// The id a bearer note whose preimage is `k1` is stored under: its taproot
// output key Q, as LUD-25 keys every note. Not sha256(k1), which is the
// note's h - still how a wallet may NAME it, as p1, p2, a comment or ?p=.
export {bearerNoteIdOfPreimage as noteIdOf} from '../src/spend.ts'

// Does `signature` certify the note `k1` spends at `amountMsat`? LUD-25
// certifies every note over hex(Q), so this reads Q off the spend - a
// preimage, a ck1 or a cw1 - rather than hashing the k1 as the kit's
// verifyNoteSignature still does.
export const certifiesNote = (k1: string, amountMsat: number, signature: string, mintPubkey: string): boolean => {
  const spend = decodeSpend(k1)
  return spend !== null && verifyNoteSignatureHash(bytesToHex(spend.outputKey), amountMsat, signature, mintPubkey)
}
