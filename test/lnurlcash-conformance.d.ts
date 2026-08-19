// The conformance runner ships as plain ESM with no declarations - the
// mock-mint entry has them, the grader does not. Just enough shape here for
// the test suite; the vectors and grader remain the source of truth.
declare module 'lnurlcash-conformance' {
  export type ReportResult = {
    status: 'pass' | 'fail' | 'warn' | 'skip'
    name: string
    detail?: string
  }
  export type Report = {
    results: ReportResult[]
    pass(name: string, detail?: string): void
    fail(name: string, detail?: string): void
    warn(name: string, detail?: string): void
    skip(name: string, detail?: string): void
    check(name: string, fn: () => Promise<unknown> | unknown): Promise<void>
  }
  export type MintFee = {baseFeeMsat: number; feePpm: number}
  export const createReport: () => Report
  export const resolveMint: (input: string) => string
  export const parseAdvertisedMintFee: (metadata: string) => MintFee | null
  export const gradeMint: (payUrl: string, report: Report) => Promise<unknown>
  export const gradeNote: (
    noteUrl: string,
    report: Report,
    options?: {mintFee?: MintFee | null}
  ) => Promise<unknown>
}
