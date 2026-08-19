import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import type {MoneyerConfig} from '../src/config.ts'
import {createFakeBackend, type FakeBackend} from '../src/backends/fake.ts'
import {createMoneyer, type Moneyer, type MoneyerDeps} from '../src/server.ts'

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
  deps: Omit<MoneyerDeps, 'backend'> = {}
): Promise<TestMint> => {
  const backend = createFakeBackend()
  const moneyer = await createMoneyer(testConfig(overrides), {
    backend,
    confirmDelaysMs: [0, 10, 20],
    ...deps
  })
  return {moneyer, backend}
}

export const freshK1 = (): string => bytesToHex(randomBytes(32))

export const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
