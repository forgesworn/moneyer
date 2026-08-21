#!/usr/bin/env node
// Check a published liabilities snapshot against a mint's signing key.
//
//   node scripts/verify-stats.mjs <mint pubkey> [file]
//
// The snapshot is the CONTENT of the mint's kind 30078 event (d tag
// lnurlcash-liabilities), which is the stats JSON plus a `sig` field. The
// key is the `mintPubkey` from the mint's discovery endpoint - the same
// key its notes verify against, so nothing new has to be trusted.
//
// Reads the file named, or stdin.
import {readFileSync} from 'node:fs'
import {verifyStatsSnapshot} from '../dist/index.js'

const [pubkey, file] = process.argv.slice(2)
if (!pubkey) {
  console.error('usage: node scripts/verify-stats.mjs <mint pubkey> [snapshot.json]')
  process.exit(2)
}

const content = readFileSync(file ?? 0, 'utf8').trim()
const {valid, stats} = verifyStatsSnapshot(content, pubkey)
if (!valid) {
  console.error('INVALID - this snapshot was not signed by that key.')
  process.exit(1)
}

const sats = msat => `${(msat / 1000).toLocaleString('en-GB')} sat`
console.log(`valid - signed by ${pubkey}`)
if (stats.at) console.log(`  taken            ${new Date(stats.at).toISOString()}`)
if (stats.outstandingMsat !== undefined) {
  console.log(`  outstanding      ${sats(stats.outstandingMsat)} over ${stats.outstandingNotes} notes`)
}
if (stats.localBalanceMsat !== undefined) console.log(`  node balance     ${sats(stats.localBalanceMsat)}`)
if (stats.coverage !== undefined) console.log(`  coverage         ${stats.coverage}`)
