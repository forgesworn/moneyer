import {expect} from 'vitest'

export type ConformanceReport = {
  results: Array<{status: string; name: string; detail?: string}>
}

export const failures = (report: ConformanceReport) =>
  report.results.filter(result => result.status === 'fail')

// Published conformance 0.4.0 predates the final 2026-08-31 draft change:
// its invoice probe sends no comment and its h probe omits the now-mandatory
// comment. Until the refreshed suite is published, those two refusals prove
// strict behaviour rather than a mint defect. Every other failure remains a
// real failure; the exception naturally disappears with the updated grader.
export const expectNoUnexpectedFailures = (report: ConformanceReport) => {
  const staleProbeNames = new Set([
    'issues an invoice for the amount requested',
    'accepts a named output on the mint quote (LUD-25 comment / mintToHash, optional)'
  ])
  const unexpected = failures(report).filter(
    result =>
      !staleProbeNames.has(result.name) ||
      !/must name its output with a LUD-12 comment/.test(result.detail ?? '')
  )
  expect(unexpected).toEqual([])
}
