import {describe, expect, it} from 'vitest'
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
