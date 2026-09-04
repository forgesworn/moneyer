import {expect} from 'vitest'

export type ConformanceReport = {
  results: Array<{status: string; name: string; detail?: string}>
}

export const failures = (report: ConformanceReport) =>
  report.results.filter(result => result.status === 'fail')

// Conformance 0.4.0 needed an exception here: its invoice probe sent no
// comment and its `h` probe omitted the then-new mandatory one, so two
// refusals proved strict behaviour rather than a mint defect. 0.6.0 sends the
// comment on both, and grades the offline-verification and mutation-replay
// MUSTs besides - so the exception is gone and any failure is a real one.
export const expectNoUnexpectedFailures = (report: ConformanceReport) => {
  expect(failures(report)).toEqual([])
}
