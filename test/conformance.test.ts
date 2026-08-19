import {afterEach, describe, expect, it} from 'vitest'
import {buildNoteUrl, hashK1} from 'lnurlcash-kit'
// The grader deliberately shares no code with any LNURLcash library - which
// is exactly why passing it means something.
import {createReport, gradeMint, gradeNote} from 'lnurlcash-conformance'
import {freshK1, startMint, type TestMint} from './helpers.ts'

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

const failures = (report: {results: Array<{status: string; name: string; detail?: string}>}) =>
  report.results.filter(result => result.status === 'fail')

describe('lnurlcash-conformance', () => {
  it('passes the read-only mint checks', async () => {
    const mint = (active = await startMint())
    const report = createReport()
    await gradeMint(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expect(failures(report)).toEqual([])
  })

  it('passes the read-only checks with a mint fee advertised', async () => {
    const mint = (active = await startMint({mintFee: {baseFeeMsat: 1000, feePpm: 5000}}))
    const report = createReport()
    await gradeMint(`${mint.moneyer.url}/.well-known/lnurlp/mint`, report)
    expect(failures(report)).toEqual([])
  })

  it('passes the spending checks against a funded note', async () => {
    const mint = (active = await startMint())
    const k1 = freshK1()
    mint.moneyer.store.creditNote(hashK1(k1), 21_000)
    const report = createReport()
    await gradeNote(buildNoteUrl(`${mint.moneyer.url}/w`, k1, 21_000), report)
    expect(failures(report)).toEqual([])
  })
})
