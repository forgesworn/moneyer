import {describe, expect, it} from 'vitest'
import {npubEncode} from 'nostr-tools/nip19'
import {configFromEnv} from '../src/config.ts'

// configFromEnv reads MONEYER_* and throws rather than starting with a
// half-understood configuration.

describe('configFromEnv', () => {
  it('accepts an http or https public origin', () => {
    expect(
      configFromEnv({MONEYER_PUBLIC_ORIGIN: 'https://mint.example'}).publicOrigin
    ).toBe('https://mint.example')
    expect(
      configFromEnv({MONEYER_PUBLIC_ORIGIN: 'http://127.0.0.1:3737'}).publicOrigin
    ).toBe('http://127.0.0.1:3737')
  })

  it('rejects a public origin that is not a URL', () => {
    expect(() => configFromEnv({MONEYER_PUBLIC_ORIGIN: 'mint.example'})).toThrow(
      /MONEYER_PUBLIC_ORIGIN/
    )
  })

  it('rejects a public origin on another scheme', () => {
    expect(() => configFromEnv({MONEYER_PUBLIC_ORIGIN: 'ftp://mint.example'})).toThrow(
      /MONEYER_PUBLIC_ORIGIN/
    )
  })

  it('leaves the origin unset when the variable is absent or empty', () => {
    expect(configFromEnv({}).publicOrigin).toBeUndefined()
    expect(configFromEnv({MONEYER_PUBLIC_ORIGIN: ''}).publicOrigin).toBeUndefined()
  })
})

describe('the sat-ceilinged mint fee', () => {
  // dni's lnurl-mint ceilings its fee to a whole sat on purpose. LUD-25
  // says nothing either way, so this is a posture choice, and turning it
  // on raises what the mint withholds - never a redeploy's doing.
  it('is off unless the operator asks for it', () => {
    expect(configFromEnv({}).roundFeeToSat).toBe(false)
    expect(configFromEnv({MONEYER_ROUND_FEE_TO_SAT: 'true'}).roundFeeToSat).toBe(true)
    expect(configFromEnv({MONEYER_ROUND_FEE_TO_SAT: 'false'}).roundFeeToSat).toBe(false)
  })
})

describe('the operator mint info', () => {
  it('normalises a contact pubkey to an npub whichever form was set', () => {
    const hex = '33'.repeat(32)
    expect(configFromEnv({MONEYER_CONTACT_NOSTR: hex}).contact).toEqual({nostr: npubEncode(hex)})
    expect(configFromEnv({MONEYER_CONTACT_NOSTR: npubEncode(hex)}).contact).toEqual({nostr: npubEncode(hex)})
  })

  it('treats an empty variable as unset, so the field never goes out empty', () => {
    const config = configFromEnv({MONEYER_NAME: '', MONEYER_MOTD: '   ', MONEYER_CONTACT_EMAIL: ''})
    expect(config.name).toBeUndefined()
    expect(config.motd).toBeUndefined()
    expect(config.contact).toBeUndefined()
  })

  it('refuses a contact or terms URL a wallet could not follow', () => {
    expect(() => configFromEnv({MONEYER_CONTACT_URL: 'example.com'})).toThrow(/MONEYER_CONTACT_URL/)
    expect(() => configFromEnv({MONEYER_TOS_URL: 'ftp://example.com/terms'})).toThrow(/MONEYER_TOS_URL/)
    expect(() => configFromEnv({MONEYER_CONTACT_EMAIL: 'not-an-address'})).toThrow(/MONEYER_CONTACT_EMAIL/)
    expect(() => configFromEnv({MONEYER_CONTACT_NOSTR: 'nobody'})).toThrow(/Nostr pubkey/)
  })

  it('refuses a message of the day that would push everything else off the card', () => {
    expect(() => configFromEnv({MONEYER_MOTD: 'x'.repeat(281)})).toThrow(/MONEYER_MOTD/)
    expect(configFromEnv({MONEYER_MOTD: 'x'.repeat(280)}).motd).toHaveLength(280)
  })

  it('keeps the name and terms it was given', () => {
    const config = configFromEnv({
      MONEYER_NAME: 'The Example Mint',
      MONEYER_TOS_URL: 'https://example.com/terms',
      MONEYER_CONTACT_URL: 'https://example.com/contact'
    })
    expect(config.name).toBe('The Example Mint')
    expect(config.tosUrl).toBe('https://example.com/terms')
    expect(config.contact).toEqual({url: 'https://example.com/contact'})
  })
})
