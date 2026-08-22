#!/usr/bin/env node
import {parseArgs} from 'node:util'
import {bytesToHex, randomBytes} from '@noble/hashes/utils.js'
import {buildNoteUrl, hashK1} from 'lnurlcash-kit'
import {configFromEnv} from './config.ts'
import {createMoneyer} from './server.ts'

// moneyer - strike LNURLcash bearer notes.
//
//   moneyer            run against the configured MONEYER_* environment
//   moneyer --dev      in-memory fake funding source, an ephemeral signing
//                      key, and one funded 21-sat note printed for a wallet
//                      to play with. Nothing here is payable.
//   moneyer admin ...  operate a running mint - see admin.ts

const {values, positionals} = parseArgs({
  options: {
    dev: {type: 'boolean', default: false},
    help: {type: 'boolean', default: false}
  },
  allowPositionals: true,
  // The admin subcommand carries flags of its own (--state, --limit,
  // --pending), parsed there rather than declared here.
  strict: false
})

if (positionals[0] === 'admin') {
  const args = process.argv.slice(2)
  const {runAdmin} = await import('./admin.ts')
  process.exit(await runAdmin(args.slice(args.indexOf('admin') + 1)))
}

if (values.help) {
  console.log(
    [
      'moneyer - an LNURLcash (LUD-25) mint',
      '',
      'Usage: moneyer [--dev]',
      '       moneyer admin <command>',
      '',
      '  --dev   fake funding source, in-memory store, ephemeral signing key,',
      '          and a funded 21 sat note printed at startup. Unpayable, for',
      '          wallets to develop against.',
      '  admin   operate a running mint: status, notes, melts, reconcile,',
      '          sweep, snapshot, names, keys, verify-note.',
      '          `moneyer admin help` lists them.',
      '',
      'Configuration is MONEYER_* environment variables - see README.md.'
    ].join('\n')
  )
  process.exit(0)
}

const env = {...process.env}
if (values.dev) {
  env.MONEYER_BACKEND = 'fake'
  env.MONEYER_DB ??= ':memory:'
  env.MONEYER_SIGNING_KEY ??= bytesToHex(randomBytes(32))
}

const config = configFromEnv(env)
if (config.backend.kind === 'fake' && !values.dev) {
  console.error('The fake funding source mints unpayable invoices - refusing to run it outside --dev.')
  process.exit(1)
}
// --dev means a mint a wallet can actually use. Without settling invoices
// the fake source hands out quotes nobody can pay, so a wallet pointed at
// it mints nothing and has no note to split, merge, melt or send - the
// mint looks alive and every flow that needs money dead-ends. Only ever
// reachable here, on the one backend that moves nothing.
if (config.backend.kind === 'fake' && values.dev) {
  config.backend = {...config.backend, autoSettle: true}
}

const log = (message: string) => console.error(`[moneyer] ${message}`)
const moneyer = await createMoneyer(config, {log})

console.log(`moneyer listening on ${moneyer.url}`)
console.log(`  lightning address: ${config.username}@${new URL(config.publicOrigin ?? moneyer.url).host}`)
if (moneyer.signer) console.log(`  mint pubkey:       ${moneyer.signer.pubkey}`)
console.log(`  funding source:    ${moneyer.backend.name}`)

if (values.dev) {
  const k1 = bytesToHex(randomBytes(32))
  moneyer.store.creditNote(hashK1(k1), 21_000)
  console.log(`  a 21 sat note:     ${buildNoteUrl(`${moneyer.url}/w`, k1, 21_000)}`)
  console.log(
    '\nDEV MINT - the fake funding source invents its invoices and treats every one\nof them as paid the moment it is issued, so minting here costs nothing and\nthe notes it hands out are worth nothing. Melts always succeed and send no\nsats anywhere. Never point a wallet holding real money at this.'
  )
}

const shutdown = () => {
  moneyer.close().then(
    () => process.exit(0),
    () => process.exit(1)
  )
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
