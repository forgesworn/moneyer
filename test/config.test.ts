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
