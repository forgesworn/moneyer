import {afterEach, describe, expect, it} from 'vitest'
import {finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate} from 'nostr-tools/pure'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {buildNoteUrl, hashK1} from 'lnurlcash-kit'
import {NIP98_KIND} from '../src/names.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// Self-service lightning addresses: anyone with an npub can claim one,
// paying with a note of this mint. The key that signs the NIP-98
// Authorization owns the name, and nothing else is accepted as identity.

const MINT_NOSTR_KEY = '22'.repeat(32)
const PRICE = 21_000

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

const start = async (overrides: Record<string, unknown> = {}): Promise<TestMint> => {
  active = await startMint(
    {
      publicOrigin: 'http://mint.test',
      zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {}},
      namePriceMsat: PRICE,
      ...overrides
    },
    {nostr: {publish: async relays => ({ok: relays, failed: []}), query: async () => [], close: () => {}}}
  )
  return active
}

// A NIP-98 token over exactly the body being sent.
const token = (
  secret: Uint8Array,
  url: string,
  body: string,
  overrides: Partial<{kind: number; method: string; url: string; createdAt: number; payload: string | null}> = {}
): string => {
  const template: EventTemplate = {
    kind: overrides.kind ?? NIP98_KIND,
    created_at: overrides.createdAt ?? Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', overrides.url ?? url],
      ['method', overrides.method ?? 'POST'],
      ...(overrides.payload === null ? [] : [['payload', overrides.payload ?? bytesToHex(sha256(utf8ToBytes(body)))]])
    ]
  }
  return `Nostr ${Buffer.from(JSON.stringify(finalizeEvent(template, secret))).toString('base64')}`
}

const claim = async (
  mint: TestMint,
  secret: Uint8Array,
  body: Record<string, unknown>,
  overrides: Parameters<typeof token>[3] = {}
): Promise<{status: number; body: Record<string, unknown>}> => {
  const payload = JSON.stringify(body)
  const res = await fetch(`${mint.moneyer.url}/names`, {
    method: 'POST',
    headers: {authorization: token(secret, 'http://mint.test/names', payload, overrides), 'content-type': 'application/json'},
    body: payload
  })
  return {status: res.status, body: (await res.json()) as Record<string, unknown>}
}

const fund = (mint: TestMint, amountMsat: number): string => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(hashK1(k1), amountMsat)
  return k1
}

describe('claiming a lightning address', () => {
  it('takes a note of this mint, burns it, and answers with the address', async () => {
    const mint = await start()
    const secret = generateSecretKey()
    const note = fund(mint, PRICE)
    const {status, body} = await claim(mint, secret, {name: 'donkey', note: buildNoteUrl('http://mint.test/w', note, PRICE)})
    expect(status).toBe(200)
    expect(body).toMatchObject({status: 'OK', name: 'donkey', address: 'donkey@mint.test', pubkey: getPublicKey(secret)})
    // The sats are revenue, so the liability goes with the note.
    expect(mint.moneyer.store.noteById(hashK1(note))!.state).toBe('burned')
    expect(mint.moneyer.store.liabilities().outstandingMsat).toBe(0)
    // And the name is live on both rails at once.
    const nip05 = (await (await fetch(`${mint.moneyer.url}/.well-known/nostr.json?name=donkey`)).json()) as {
      names: Record<string, string>
    }
    expect(nip05.names.donkey).toBe(getPublicKey(secret))
    const payRequest = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/donkey`)).json()) as Record<string, unknown>
    expect(payRequest.tag).toBe('payRequest')
    expect(payRequest.allowsNostr).toBe(true)
  })

  it('takes a bare secret as readily as a note URL', async () => {
    const mint = await start()
    const note = fund(mint, PRICE)
    const {status} = await claim(mint, generateSecretKey(), {name: 'bearer', note})
    expect(status).toBe(200)
  })

  it('advertises the price on discovery, and closes registration when unset', async () => {
    const open = await start()
    const info = (await (await fetch(`${open.moneyer.url}/.well-known/lnurlw/mint`)).json()) as Record<string, unknown>
    expect(info.namePriceMsat).toBe(PRICE)
    await open.moneyer.close()
    active = null

    const shut = await start({namePriceMsat: undefined})
    const closed = (await (await fetch(`${shut.moneyer.url}/.well-known/lnurlw/mint`)).json()) as Record<string, unknown>
    expect(closed).not.toHaveProperty('namePriceMsat')
    const refused = await claim(shut, generateSecretKey(), {name: 'donkey'})
    expect(refused.status).toBe(404)
  })

  it('refuses every way a NIP-98 token can be wrong', async () => {
    const mint = await start()
    const secret = generateSecretKey()
    const note = fund(mint, PRICE)
    const body = {name: 'donkey', note}

    const stale = await claim(mint, secret, body, {createdAt: Math.floor(Date.now() / 1000) - 300})
    expect(stale.status).toBe(401)
    expect(stale.body.reason).toMatch(/60 seconds/)
    expect((await claim(mint, secret, body, {url: 'http://mint.test/elsewhere'})).body.reason).toMatch(/different URL/)
    expect((await claim(mint, secret, body, {method: 'GET'})).body.reason).toMatch(/different method/)
    expect((await claim(mint, secret, body, {payload: '00'.repeat(32)})).body.reason).toMatch(/payload tag/)
    expect((await claim(mint, secret, body, {payload: null})).body.reason).toMatch(/no payload tag/)
    expect((await claim(mint, secret, body, {kind: 1})).body.reason).toMatch(/kind 27235/)

    const naked = await fetch(`${mint.moneyer.url}/names`, {method: 'POST', body: JSON.stringify(body)})
    expect(naked.status).toBe(401)
    // Nothing was burned by any of that.
    expect(mint.moneyer.store.noteById(hashK1(note))!.state).toBe('outstanding')
  })

  it('refuses a forged signature outright', async () => {
    const mint = await start()
    const body = JSON.stringify({name: 'donkey'})
    const honest = token(generateSecretKey(), 'http://mint.test/names', body)
    const event = JSON.parse(Buffer.from(honest.slice('Nostr '.length), 'base64').toString('utf8')) as {
      pubkey: string
      tags: string[][]
    }
    // Same signature, someone else's key.
    event.pubkey = getPublicKey(generateSecretKey())
    const forged = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`
    const res = await fetch(`${mint.moneyer.url}/names`, {
      method: 'POST',
      headers: {authorization: forged},
      body
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as {reason: string}).reason).toMatch(/does not verify/)
  })

  it('refuses an underpaid note, a foreign note, and a note in a melt', async () => {
    const mint = await start()
    const secret = generateSecretKey()
    const short = fund(mint, PRICE - 1000)
    const underpaid = await claim(mint, secret, {name: 'donkey', note: short})
    expect(underpaid.status).toBe(402)
    expect(underpaid.body.reason).toMatch(/costs 21000 msat/)

    const foreign = await claim(mint, secret, {
      name: 'donkey',
      note: buildNoteUrl('https://other.example/w', freshK1(), PRICE)
    })
    expect(foreign.status).toBe(400)
    expect(foreign.body.reason).toMatch(/not from this mint/)

    const missing = await claim(mint, secret, {name: 'donkey', note: freshK1()})
    expect(missing.status).toBe(400)

    // No note at all, when one is required.
    const free = await claim(mint, secret, {name: 'donkey'})
    expect(free.status).toBe(402)
    expect(mint.moneyer.store.zapName('donkey')).toBeNull()
  })

  it('refuses reserved and malformed names, and one already taken', async () => {
    const mint = await start()
    const secret = generateSecretKey()
    for (const name of ['mint', '_', 'admin', 'ab', 'Not A Name', '.leading', 'x'.repeat(33)]) {
      const note = fund(mint, PRICE)
      const {status} = await claim(mint, secret, {name, note})
      expect([400, 403]).toContain(status)
      // A refused name never costs anything.
      expect(mint.moneyer.store.noteById(hashK1(note))!.state).toBe('outstanding')
    }
    const first = await claim(mint, secret, {name: 'donkey', note: fund(mint, PRICE)})
    expect(first.status).toBe(200)
    const again = await claim(mint, generateSecretKey(), {name: 'DONKEY', note: fund(mint, PRICE)})
    expect(again.status).toBe(409)
    expect(again.body.reason).toMatch(/taken/)
  })

  it('gives free names away three at a time, and no more', async () => {
    const mint = await start({namePriceMsat: 0})
    const secret = generateSecretKey()
    for (const name of ['one', 'two', 'three']) {
      expect((await claim(mint, secret, {name})).status).toBe(200)
    }
    const fourth = await claim(mint, secret, {name: 'four'})
    expect(fourth.status).toBe(403)
    expect(fourth.body.reason).toMatch(/3 free names/)
    // Somebody else's key is not out of names.
    expect((await claim(mint, generateSecretKey(), {name: 'four'})).status).toBe(200)
  })

  it(`keeps the operator's own names working, and answers NIP-05 for them`, async () => {
    const alice = getPublicKey(generateSecretKey())
    const mint = await start({zap: {nostrKey: MINT_NOSTR_KEY, relays: ['wss://mint-relay.example'], names: {alice}}})
    expect(mint.moneyer.store.zapName('alice')).toMatchObject({pubkey: alice, source: 'env'})
    const nip05 = (await (await fetch(`${mint.moneyer.url}/.well-known/nostr.json?name=alice`)).json()) as {
      names: Record<string, string>
    }
    expect(nip05.names.alice).toBe(alice)
    // An unknown name is an empty answer, not an error, and never a list
    // of everyone here.
    const unknown = (await (await fetch(`${mint.moneyer.url}/.well-known/nostr.json?name=nobody`)).json()) as {
      names: Record<string, string>
    }
    expect(unknown.names).toEqual({})
    expect((await (await fetch(`${mint.moneyer.url}/.well-known/nostr.json`)).json()) as unknown).toEqual({names: {}})
  })

  it('refuses a body too large to be a name', async () => {
    const mint = await start()
    const res = await fetch(`${mint.moneyer.url}/names`, {
      method: 'POST',
      headers: {authorization: 'Nostr nonsense'},
      body: 'x'.repeat(9000)
    })
    expect(res.status).toBe(413)
  })
})
