import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1} from 'lnurlcash-kit'
// The grader deliberately shares no code with any LNURLcash library - which
// is exactly why passing it means something.
import {createReport, gradeMint, gradeNote} from 'lnurlcash-conformance'
import {freshK1, startMint, type TestMint} from './helpers.ts'
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
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    const report = createReport()
    await gradeNote(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000), report)
    expect(failures(report)).toEqual([])
    // The Part 2 check is a warning on a mint without Part 2; here it has
    // to have run for real: the cp1 note certified, and the plain note it
    // rotated home to unsigned.
    const part2 = report.results.find(result => result.name === 'certifies a cp1 note it issues (Part 2)')
    expect(part2?.status).toBe('pass')
    expect(part2?.detail).toContain('verified offline')
    expect(part2?.detail).toContain('is unsigned')
  })

  it('passes the spending checks with a mint fee advertised - exact fee algebra', async () => {
    const fee = {baseFeeMsat: 1000, feePpm: 5000}
    const mint = (active = await startMint({mintFee: fee}))
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    const report = createReport()
    await gradeNote(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000), report, {mintFee: fee})
    expect(failures(report)).toEqual([])
  })
})
