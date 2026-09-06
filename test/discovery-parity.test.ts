import {afterEach, describe, expect, it} from 'vitest'
import {hashK1} from 'lnurlcash-kit'
import {createFakeBackend} from '../src/backends/fake.ts'
import {createMoneyer} from '../src/server.ts'
import {configFromEnv} from '../src/config.ts'
import {freshK1, startMint, testConfig, type TestMint} from './helpers.ts'

// Three fields the reference mint publishes on its discovery document that
// moneyer did not. Each answers a question a wallet cannot otherwise ask:
// which doors this mint's node will actually open, whether the mint is
// going away, and how much it owes.

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close().catch(() => {})
  active = null
})

const discovery = async (mint: TestMint, user = 'mint'): Promise<Record<string, unknown>> =>
  (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlw/${user}`)).json()) as Record<string, unknown>

const startWithNodeInfo = async (
  nodeInfo: Record<string, unknown>,
  overrides = {}
): Promise<TestMint> => {
  const backend = createFakeBackend()
  const moneyer = await createMoneyer(testConfig(overrides), {
    backend: {...backend, nodeInfo: async () => nodeInfo},
    webAssets: null
  })
  active = {moneyer, backend}
  return active
}

const PUBKEY = '02' + 'ab'.repeat(32)

describe('nodeUris', () => {
  it('publishes every address the node announces', async () => {
    const clearnet = `${PUBKEY}@2.29.14.244:9735`
    const onion = `${PUBKEY}@abcdefghijklmnop.onion:9735`
    const mint = await startWithNodeInfo({uri: clearnet, uris: [clearnet, onion]})

    const info = await discovery(mint)

    expect(info.nodeUris).toEqual([clearnet, onion])
    // The singular field is unchanged and still the first address: a
    // wallet that never learns about nodeUris must keep working.
    expect(info.nodeUri).toBe(clearnet)
  })

  it('says nothing at all for a node that announces nothing', async () => {
    const mint = await startWithNodeInfo({uri: PUBKEY})

    const info = await discovery(mint)

    expect(info).not.toHaveProperty('nodeUris')
    expect(info.nodeUri).toBe(PUBKEY)
  })
})

describe('sunsetDate', () => {
  it('warns while there is still time to spend', async () => {
    // The point of the field: `sunset` stops minting, and by then telling
    // a holder is too late to be useful. This is the earlier signal, and
    // the two are independent - a mint still minting normally can be
    // announcing a closing date months out.
    const mint = await startMint({sunsetDate: '2026-12-31'})
    active = mint

    const info = await discovery(mint)

    expect(info.sunsetDate).toBe('2026-12-31')
    expect(info).not.toHaveProperty('sunset')

    const page = await (await fetch(mint.moneyer.url)).text()
    expect(page).toContain('2026-12-31')
  })

  it('is absent unless the operator set one', async () => {
    const mint = await startMint()
    active = mint

    expect(await discovery(mint)).not.toHaveProperty('sunsetDate')
  })

  it('refuses a date that is not one', () => {
    // A wallet telling a holder "this mint closes on ..." off an unchecked
    // string is worse than telling them nothing.
    expect(configFromEnv({MONEYER_SUNSET_DATE: '2026-12-31'}).sunsetDate).toBe('2026-12-31')
    expect(configFromEnv({}).sunsetDate).toBeUndefined()
    expect(configFromEnv({MONEYER_SUNSET_DATE: '   '}).sunsetDate).toBeUndefined()
    expect(() => configFromEnv({MONEYER_SUNSET_DATE: '31/12/2026'})).toThrow(/ISO-8601/)
    expect(() => configFromEnv({MONEYER_SUNSET_DATE: '2026-12-31T09:00:00Z'})).toThrow(/ISO-8601/)
    // Date would take this one and roll it forward to 3 March, which is
    // not the day anybody typed.
    expect(() => configFromEnv({MONEYER_SUNSET_DATE: '2026-02-31'})).toThrow(/not a real date/)
  })
})

describe('outstandingNotesMsat', () => {
  const credit = (mint: TestMint, amountMsat: number): void => {
    mint.moneyer.store.creditNote(hashK1(freshK1()), amountMsat)
  }

  it('states what the mint owes, even with the funding source unreachable', async () => {
    // A fact about the mint's own database, not about its node, so an
    // unreachable backend must not take it away.
    const backend = createFakeBackend()
    const moneyer = await createMoneyer(testConfig(), {
      backend: {
        ...backend,
        nodeInfo: async () => {
          throw new Error('node unreachable')
        }
      },
      webAssets: null
    })
    active = {moneyer, backend}
    credit(active, 40_000)
    credit(active, 8_000)

    expect((await discovery(active)).outstandingNotesMsat).toBe(48_000)
  })

  it('reports zero rather than going missing when nothing is outstanding', async () => {
    // "Owes nothing" and "will not say" are different claims, and a holder
    // deciding whether to trust a mint needs to be able to tell them apart.
    const mint = await startMint()
    active = mint

    expect((await discovery(mint)).outstandingNotesMsat).toBe(0)
  })

  it('honours the switches that already govern this disclosure', async () => {
    // An operator who turned /stats off, or down to the coverage ratio,
    // has already said not to publish the size of the book. A second
    // endpoint publishing it anyway would make those switches a lie.
    const off = await startMint({stats: false})
    active = off
    expect(await discovery(off)).not.toHaveProperty('outstandingNotesMsat')
    await off.moneyer.close()

    const ratioOnly = await startMint({statsRatioOnly: true})
    active = ratioOnly
    credit(ratioOnly, 40_000)
    expect(await discovery(ratioOnly)).not.toHaveProperty('outstandingNotesMsat')
  })
})
