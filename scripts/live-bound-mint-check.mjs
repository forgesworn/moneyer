#!/usr/bin/env node
// A resumable, real-sats bound-mint release check.
//
// The payer command receives the mint invoice as its final argument. Its
// stdout is intentionally ignored: lnd has emitted JSON and tables across
// versions, while Moneyer's /verify response is the settlement proof that
// matters. The refund command receives no added arguments and must print an
// amountless BOLT11 invoice; Moneyer melts the whole test note back to it.
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {runLiveBoundMintCheck} from '../dist/live-check.js'

const usage = `usage:
  npm run live:bound-mint -- \\
    --pay-url https://mint.example/.well-known/lnurlp/mint \\
    --amount-sat 56 \\
    --state /secure/path/moneyer-live-check.json \\
    --payer <command...> \\
    --refund <command...>

The payer command gets the BOLT11 invoice as its final argument. The refund
command must emit a fresh amountless BOLT11 invoice on stdout. State is mode
0600 and resumable; rerun the exact command after any interruption.`

const failUsage = message => {
  if (message) console.error(message)
  console.error(usage)
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

const payerAt = args.indexOf('--payer')
const refundAt = args.indexOf('--refund')
if (payerAt < 0 || refundAt < 0 || refundAt <= payerAt) failUsage('Both --payer and --refund commands are required.')

const optionArgs = args.slice(0, payerAt)
const payerArgv = args.slice(payerAt + 1, refundAt)
const refundArgv = args.slice(refundAt + 1)
if (payerArgv.length === 0 || refundArgv.length === 0) failUsage('Command markers may not be empty.')

const values = new Map()
for (let index = 0; index < optionArgs.length; index += 2) {
  const name = optionArgs[index]
  const value = optionArgs[index + 1]
  if (!name?.startsWith('--') || value === undefined) failUsage(`Invalid option near ${name ?? '(end)'}.`)
  if (!['--pay-url', '--amount-sat', '--state', '--timeout-seconds'].includes(name)) failUsage(`Unknown option ${name}.`)
  values.set(name, value)
}

const payUrl = values.get('--pay-url')
const amountSat = Number(values.get('--amount-sat'))
const stateValue = values.get('--state')
const timeoutSeconds = values.has('--timeout-seconds') ? Number(values.get('--timeout-seconds')) : 60
if (!payUrl || !stateValue) failUsage('--pay-url, --amount-sat and --state are required.')
if (!Number.isSafeInteger(amountSat) || amountSat <= 0) failUsage('--amount-sat must be a positive whole number.')
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) failUsage('--timeout-seconds must be positive.')

const runCommand = (argv, appended = []) => {
  const [program, ...commandArgs] = argv
  const result = spawnSync(program, [...commandArgs, ...appended], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutSeconds * 1000
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim().slice(0, 500)
    throw new Error(`command exited ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout
}

const statePath = resolve(stateValue)
try {
  const result = await runLiveBoundMintCheck({
    payUrl,
    grossMsat: amountSat * 1000,
    statePath,
    timeoutMs: timeoutSeconds * 1000,
    payInvoice: async pr => {
      // Deliberately do not parse or print this output. Settlement is proved
      // independently by the invoice preimage and signed mint receipt.
      runCommand(payerArgv, [pr])
    },
    createRefundInvoice: async () => runCommand(refundArgv),
    log: message => console.error(`[live-check] ${message}`)
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`[live-check] ${error instanceof Error ? error.message : String(error)}`)
  console.error(`[live-check] state retained at ${statePath}; rerun the exact command to resume`)
  process.exitCode = 1
}
