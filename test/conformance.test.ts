import {afterEach, describe, expect, it} from 'vitest'
import {createServer} from 'node:net'
import {buildNoteUrl, hashK1} from '@lnurlcash/kit'
// The grader deliberately shares no code with any LNURLcash library - which
// is exactly why passing it means something.
import {createReport, gradeMint, gradeNote, gradeRegistration} from 'lnurlcash-conformance'
import {freshK1, startMint, type TestMint, noteIdOf} from './helpers.ts'
import {expectNoUnexpectedFailures, failures} from './conformance-compat.ts'

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

describe('lnurlcash-conformance', () => {
  it('passes the read-only mint checks', async () => {
    const mint = (active = await startMint())
    const report = createReport()
    await gradeMint(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expectNoUnexpectedFailures(report)
  })

  it('passes the read-only checks with a mint fee advertised', async () => {
    const mint = (active = await startMint({mintFee: {baseFeeMsat: 1000, feePpm: 5000}}))
    const report = createReport()
    await gradeMint(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expectNoUnexpectedFailures(report)
  })

  it('passes the spending checks against a funded note', async () => {
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const report = createReport()
    await gradeNote(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000), report)
    expect(failures(report)).toEqual([])
    // These have to have run for real, not been skipped as not applicable:
    // key notes bound to this mint's domain, and every certificate - bearer
    // notes' included - over the note's Q.
    for (const name of [
      'credits a key-path note named by its cp1',
      'refuses a ck1 bound to another domain',
      'spends a key-path note by a ck1 bound to its own domain',
      'certifies a bearer output over hex(Q)',
      'a certificate on the informational GET verifies over hex(Q)',
      'every certificate verifies over the domain, hex(Q) and the note value'
    ]) {
      expect(report.results.find(result => result.name === name)?.status, name).toBe('pass')
    }
  })

  it('passes the spending checks with a mint fee advertised - exact fee algebra', async () => {
    const fee = {baseFeeMsat: 1000, feePpm: 5000}
    const mint = (active = await startMint({mintFee: fee}))
    const k1 = freshK1()
    mint.moneyer.store.creditNote(noteIdOf(k1), 21_000)
    const report = createReport()
    await gradeNote(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000), report, {mintFee: fee})
    expect(failures(report)).toEqual([])
  })

  // LUD-26 at this mint's own Lightning Addresses. The grader signs its
  // proofs for the hostname it was pointed at, and follows every callback,
  // so the mint's public origin has to be the address it really listens on.
  const freePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const port = typeof address === 'object' && address ? address.port : 0
        probe.close(() => resolve(port))
      })
    })
  const startAddressMint = async (overrides: Record<string, unknown> = {}) => {
    const port = await freePort()
    return (active = await startMint(
      {
        port,
        publicOrigin: `http://127.0.0.1:${port}`,
        zap: {nostrKey: '22'.repeat(32), relays: [], names: {}},
        namePriceMsat: 0,
        ...overrides
      },
      {nostr: {publish: async relays => ({ok: relays, failed: []}), query: async () => [], close: () => {}}}
    ))
  }

  it('passes the LUD-26 registration checks, free', async () => {
    const mint = await startAddressMint({mintFee: {baseFeeMsat: 1000, feePpm: 5000}})
    const report = createReport()
    await gradeRegistration(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expect(failures(report)).toEqual([])
    expect(report.results.find(result => result.name === 'publishes the registered address')?.status).toBe('pass')
  })

  it('passes the LUD-26 registration checks with an address fee', async () => {
    const mint = await startAddressMint({namePriceMsat: 21_000})
    const report = createReport()
    await gradeRegistration(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expect(failures(report)).toEqual([])
    expect(report.results.find(result => result.name === 'publishes no address before its fee settles (LUD-26)')?.status).toBe('pass')
  })

  it('passes the read-only checks at mint@ with registration open', async () => {
    const mint = await startAddressMint({namePriceMsat: 21_000, mintFee: {baseFeeMsat: 1000, feePpm: 5000}})
    const report = createReport()
    await gradeMint(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expectNoUnexpectedFailures(report)
  })
})
