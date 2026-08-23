import {afterEach, describe, expect, it} from 'vitest'
import {request} from 'node:http'
import {configFromEnv} from '../src/config.ts'
import {hashK1} from 'lnurlcash-kit'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// The same mint, reached over Tor.
//
// A hidden service is a different origin. A mint that answers a Tor
// visitor with its clearnet URL has told that visitor's wallet to leave
// Tor to finish the job, which is both broken and the exact thing they
// came here to avoid - the callback fetch would go out over clearnet, from
// their address, naming the mint they bank with.

const ONION = 'http://mintmintmintmintmintmintmintmintmintmintmintmintmintmi.onion'

describe('MONEYER_ONION_URL', () => {
  it('accepts an onion address on either scheme', () => {
    expect(configFromEnv({MONEYER_ONION_URL: ONION}).onionUrl).toBe(ONION)
    expect(configFromEnv({}).onionUrl).toBeUndefined()
    expect(configFromEnv({MONEYER_ONION_URL: ''}).onionUrl).toBeUndefined()
  })

  it('refuses anything that is not one', () => {
    // A clearnet host here would silently send Tor visitors back out to it,
    // which is the failure this variable exists to prevent.
    expect(() => configFromEnv({MONEYER_ONION_URL: 'https://mint.example'})).toThrow(/\.onion/)
    expect(() => configFromEnv({MONEYER_ONION_URL: 'not a url'})).toThrow(/MONEYER_ONION_URL/)
    expect(() => configFromEnv({MONEYER_ONION_URL: 'ftp://x.onion'})).toThrow(/http/)
  })
})

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close().catch(() => {})
  active = null
})

// node:http, not fetch: Host is a forbidden header name there, so a fetch
// cannot ask the question this whole feature turns on.
const asHost = (mint: TestMint, path: string, host: string): Promise<Record<string, any>> => {
  const target = new URL(mint.moneyer.url)
  return new Promise((resolve, reject) => {
    const req = request(
      {hostname: target.hostname, port: target.port, path, method: 'GET', headers: {host}},
      res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>)
          } catch (err) {
            reject(err as Error)
          }
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('a mint reached over Tor', () => {
  it('hands a Tor visitor onion URLs and everyone else the clearnet one', async () => {
    const mint = (active = await startMint({
      publicOrigin: 'https://mint.example',
      onionUrl: ONION
    }))
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)

    const overTor = await asHost(mint, `/w?k1=${k1}`, new URL(ONION).host)
    expect(overTor.callback).toBe(`${ONION}/w/cb`)
    expect(overTor.payLink).toBe(`${ONION}/.well-known/lnurlp/mint`)

    const overClearnet = await asHost(mint, `/w?k1=${k1}`, 'mint.example')
    expect(overClearnet.callback).toBe('https://mint.example/w/cb')

    // and the lightning address the pay endpoint states follows the same
    // door the caller came in by
    const payOverTor = await asHost(mint, '/.well-known/lnurlp/mint', new URL(ONION).host)
    expect(payOverTor.callback).toBe(`${ONION}/p/cb`)
    expect(payOverTor.withdrawLink).toBe(`${ONION}/w`)
    expect(payOverTor.metadata).toContain(`mint@${new URL(ONION).host}`)
  })

  it('names its other door, so the same note can be redeemed either way', async () => {
    // A note is keyed by sha256(k1) and not by host, so both doors serve
    // the same notes - but a note travels as a URL, and a URL names one
    // host. Saying which other host answers is what lets a wallet move a
    // note between them instead of a holder discovering it cannot.
    const mint = (active = await startMint({
      publicOrigin: 'https://mint.example',
      onionUrl: ONION
    }))
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)

    const overTor = await asHost(mint, `/w?k1=${k1}`, new URL(ONION).host)
    expect(overTor.mirrors).toEqual(['https://mint.example'])
    const overClearnet = await asHost(mint, `/w?k1=${k1}`, 'mint.example')
    expect(overClearnet.mirrors).toEqual([ONION])

    // and the discovery document says it too, so a wallet that has never
    // held a note from here still learns both doors
    const address = await asHost(mint, '/.well-known/lnurlw/mint', 'mint.example')
    expect(address.mirrors).toEqual([ONION])
  })

  it('names no mirror when there is only one door', async () => {
    const mint = (active = await startMint({publicOrigin: 'https://mint.example'}))
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    const answer = await asHost(mint, `/w?k1=${k1}`, 'mint.example')
    expect(answer.mirrors).toBeUndefined()
    // absent, not an empty array: a wallet reading [] would think it had
    // been told something
    expect(Object.keys(answer)).not.toContain('mirrors')
  })

  it('ignores a Host header that names neither of them', async () => {
    // The Host header is attacker controlled, so it may only CHOOSE between
    // origins the operator configured. A forged one gets the clearnet
    // origin back, never a URL of the caller's invention.
    const mint = (active = await startMint({
      publicOrigin: 'https://mint.example',
      onionUrl: ONION
    }))
    const answer = await asHost(mint, '/.well-known/lnurlp/mint', 'evil.example')
    expect(answer.callback).toBe('https://mint.example/p/cb')
    expect(JSON.stringify(answer)).not.toContain('evil.example')
  })

  it('is simply absent when no onion is configured', async () => {
    const mint = (active = await startMint({publicOrigin: 'https://mint.example'}))
    const answer = await asHost(mint, '/.well-known/lnurlp/mint', new URL(ONION).host)
    expect(answer.callback).toBe('https://mint.example/p/cb')
  })
})
