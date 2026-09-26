import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1} from '@lnurlcash/kit'
// The grader deliberately shares no code with any LNURLcash library - which
// is exactly why passing it means something.
import {createReport, gradeMint, gradeNote} from 'lnurlcash-conformance'
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
      'every certificate verifies over hex(Q) and the note value'
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
})
