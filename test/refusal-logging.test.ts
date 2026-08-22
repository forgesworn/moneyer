import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1} from 'lnurlcash-kit'
import {createMoneyer, type Moneyer} from '../src/server.ts'
import {createFakeBackend} from '../src/backends/fake.ts'
import {freshK1, testConfig} from './helpers.ts'

// A mint that refuses in silence cannot be debugged from the outside.
//
// A wallet shows its holder "already spent" and the operator has nothing to
// compare it against - no idea which call was refused, or how often, or
// whether it is one confused wallet or every wallet. That is how a melt bug
// went unnoticed: the journal carried startup lines and invoice sweeps, and
// not one word about the requests that were failing.
//
// What must NOT reach the log is the k1. A note URL carries it in the query
// string, and a k1 is the money: an operator's log file, or anything that
// ships it onward, would be a pile of bearer secrets.

let mint: Moneyer | null = null
const lines: string[] = []

const start = async () => {
  lines.length = 0
  const backend = createFakeBackend()
  mint = await createMoneyer(testConfig(), {
    backend,
    confirmDelaysMs: [0, 10],
    webAssets: null,
    log: message => lines.push(message)
  })
  return {mint, backend}
}

afterEach(async () => {
  await mint?.close()
  mint = null
})

const get = (url: string) => fetch(url).then(r => r.json() as Promise<Record<string, unknown>>)

describe('refusals an operator can see', () => {
  it('names the call and the reason on the mutating callback', async () => {
    const {mint: m} = await start()
    const k1 = freshK1()
    const body = await get(`${m.url}/w/cb?k1=${k1}&h=${hashK1(freshK1())}`)

    expect(body.status).toBe('ERROR')
    const refusal = lines.find(line => line.startsWith('refused'))
    expect(refusal).toBeDefined()
    expect(refusal).toContain('/w/cb')
    expect(refusal).toContain(String(body.reason))
  })

  it('never writes a k1 into the log', async () => {
    const {mint: m} = await start()
    const k1 = freshK1()
    // Every shape that carries a secret and gets refused.
    await get(`${m.url}/w/cb?k1=${k1}`)
    await get(`${m.url}/w/cb?k1=${k1}&amount=1&h=${hashK1(freshK1())}`)
    await get(`${m.url}/p/cb?amount=1&h=nothex`)

    expect(lines.length).toBeGreaterThan(0)
    const everything = lines.join('\n')
    expect(everything).not.toContain(k1)
    // and no query string at all, so a secret cannot arrive by a route
    // nobody thought of
    expect(everything).not.toContain('?')
    expect(everything).not.toContain('k1=')
  })

  it('stays quiet about the informational GET, which restore walks by design', async () => {
    const {mint: m} = await start()
    // A restore probes unknown indexes until it has seen a run of them.
    for (let i = 0; i < 5; i += 1) {
      await get(buildNoteUrl(`${m.url}/w`, freshK1()))
    }
    expect(lines.filter(line => line.startsWith('refused'))).toEqual([])
  })

  it('reports a refused mint quote, which is where an amount is turned away', async () => {
    const {mint: m} = await start()
    const body = await get(`${m.url}/p/cb?amount=1`)
    expect(body.status).toBe('ERROR')
    expect(lines.some(line => line.includes('/p/cb') && line.includes(String(body.reason)))).toBe(true)
  })
})
