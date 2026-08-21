import {afterEach, describe, expect, it} from 'vitest'
import {hashK1, mintAddressUrl} from 'lnurlcash-kit'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// A note is often all a holder ever has of a mint: handed one over Nostr or
// on a tag, they never went near a Lightning Address. `payLink` is the route
// back to the document that publishes the mint's terms and its retired
// signing keys, which is what tells an announced rotation from a swapped key.

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

describe('a note points back at the mint', () => {
  it('carries a payLink that resolves to this mint discovery document', async () => {
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)

    const note = (await (await fetch(`${mint.moneyer.url}/w?k1=${k1}`)).json()) as {payLink?: string}
    expect(typeof note.payLink).toBe('string')

    // the kit turns a payLink into the discovery URL, exactly as a wallet does
    const discoveryUrl = mintAddressUrl(note.payLink!)
    expect(discoveryUrl).not.toBeNull()
    const discovery = (await (await fetch(discoveryUrl!)).json()) as {
      tag?: string
      payLink?: string
      previousPubkeys?: string[]
    }
    expect(discovery.tag).toBe('withdrawRequest')
    expect(discovery.payLink).toBe(note.payLink)
    expect(Array.isArray(discovery.previousPubkeys)).toBe(true)
  })

  it('says nothing about the mint on a note it does not know', async () => {
    const mint = (active = await startMint())
    const unknown = (await (await fetch(`${mint.moneyer.url}/w?k1=${freshK1()}`)).json()) as Record<string, unknown>
    expect(unknown.status).toBe('ERROR')
    expect(unknown.payLink).toBeUndefined()
  })

  it('says nothing about the mint on a spent note', async () => {
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    mint.moneyer.store.swap([hashK1(k1)], [{id: hashK1(freshK1()), amountMsat: 21_000}])
    const spent = (await (await fetch(`${mint.moneyer.url}/w?k1=${k1}`)).json()) as Record<string, unknown>
    expect(spent.status).toBe('ERROR')
    expect(spent.payLink).toBeUndefined()
  })
})
