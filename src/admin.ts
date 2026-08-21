import {existsSync} from 'node:fs'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {hashK1, noteDeclaredAmount, noteK1, noteSignature, verifyNoteSignature} from 'lnurlcash-kit'
import {configFromEnv, type MoneyerConfig} from './config.ts'
import {NoteStore, type NoteState} from './store.ts'
import {buildStats} from './stats.ts'
import {reconcilePendingMelts} from './melt.ts'
import {sweepExpiredMintInvoices} from './server.ts'
import {createFakeBackend} from './backends/fake.ts'
import {createClnBackend} from './backends/cln.ts'
import {createLndBackend} from './backends/lnd.ts'
import type {LightningBackend} from './backends/types.ts'
import {packageVersion} from './version.ts'

// `moneyer admin <command>` - the operator surface.
//
// Every command reads the same MONEYER_* environment the server does, so
// there is one description of a deployment and not two. Commands that only
// read open the database READ-ONLY: an operator poking at a live mint
// should not be able to write to it by accident, and a mistyped path
// should not silently create an empty database to answer from.
//
// Nothing here talks to a wallet or moves money. `reconcile` asks the
// funding source about melts that are already in flight, and that is the
// furthest any of it goes.

export type AdminDeps = {
  env?: NodeJS.ProcessEnv
  out?: (line: string) => void
  err?: (line: string) => void
  // Tests hand in a :memory: store and a fake funding source; production
  // opens both from the configuration.
  store?: NoteStore
  backend?: LightningBackend
  now?: () => number
}

const COMMANDS = [
  ['status', 'liabilities, melts in flight, node balance, coverage, keys'],
  ['notes [--state s] [--limit n]', 'list notes; state is outstanding, pending or burned'],
  ['note <id|k1>', 'one note, by id or by the secret itself'],
  ['melts [--pending]', 'list melts, newest first'],
  ['reconcile', 'resolve melts left in flight, and say what changed'],
  ['sweep', 'delete mint invoices whose expiry is provably past'],
  ['snapshot <path>', 'a consistent copy of the database, taken live'],
  ['names list', 'the lightning addresses this mint pays out as notes'],
  ['keys rotate', 'generate a signing key and print the two env lines'],
  ['verify-note <url>', 'check a note offline, then say what the mint holds']
] as const

export const adminHelp = (): string =>
  [
    'moneyer admin - operate a running mint',
    '',
    'Usage: moneyer admin <command> [options]',
    '',
    ...COMMANDS.map(([name, what]) => `  ${name.padEnd(30)} ${what}`),
    '',
    'Reads the same MONEYER_* environment as the mint itself, so run it',
    'with that environment loaded. Read-only unless the command says',
    'otherwise (reconcile, sweep and snapshot are the only ones that are not).'
  ].join('\n')

const sats = (msat: number): string => `${(msat / 1000).toLocaleString('en-GB')} sat`

const age = (fromMs: number, nowMs: number): string => {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

const backendFor = (config: MoneyerConfig): LightningBackend => {
  switch (config.backend.kind) {
    case 'fake':
      return createFakeBackend()
    case 'cln':
      return createClnBackend(config.backend)
    case 'lnd':
      return createLndBackend(config.backend)
  }
}

const signingPubkey = (config: MoneyerConfig): string | null =>
  config.signingKey ? bytesToHex(secp256k1.getPublicKey(hexToBytes(config.signingKey), true)) : null

// Options are parsed here rather than in the CLI so a test can drive a
// command with the same argv an operator would type.
const parse = (argv: string[]): {positionals: string[]; flags: Map<string, string | true>} => {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) {
      flags.set(name!, inline)
    } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
      flags.set(name!, argv[++i]!)
    } else {
      flags.set(name!, true)
    }
  }
  return {positionals, flags}
}

export const runAdmin = async (argv: string[], deps: AdminDeps = {}): Promise<number> => {
  const env = deps.env ?? process.env
  const out = deps.out ?? ((line: string) => console.log(line))
  const err = deps.err ?? ((line: string) => console.error(line))
  const now = deps.now ?? (() => Date.now())
  const {positionals, flags} = parse(argv)
  const command = positionals[0]

  if (command === undefined || command === 'help' || flags.has('help')) {
    out(adminHelp())
    return command === undefined ? 2 : 0
  }

  const known = new Set(['status', 'notes', 'note', 'melts', 'reconcile', 'sweep', 'snapshot', 'names', 'keys', 'verify-note'])
  if (!known.has(command)) {
    err(`Unknown command ${JSON.stringify(command)}. Try: moneyer admin help`)
    return 2
  }

  let config: MoneyerConfig
  try {
    config = configFromEnv(env)
  } catch (error) {
    err(`Configuration: ${(error as Error).message}`)
    return 1
  }

  // `keys rotate` writes nothing and reads nothing: it generates a key
  // and prints two lines for the operator to paste. No database needed,
  // which also means it works before a mint has ever run.
  if (command === 'keys') {
    if (positionals[1] !== 'rotate') {
      err('Usage: moneyer admin keys rotate')
      return 2
    }
    const fresh = bytesToHex(randomBytes(32))
    const previous = signingPubkey(config)
    const history = [...(previous ? [previous] : []), ...(config.previousSigningPubkeys ?? [])]
    out('# A new signing key. Nothing has been written - paste these into the')
    out('# mint environment and restart. Keep the OLD PUBLIC key in the list')
    out('# below or every note already issued stops verifying.')
    out(`MONEYER_SIGNING_KEY=${fresh}`)
    if (history.length) out(`MONEYER_PREVIOUS_SIGNING_PUBKEYS=${history.join(',')}`)
    out('')
    out(`# the new mint pubkey will be ${bytesToHex(secp256k1.getPublicKey(hexToBytes(fresh), true))}`)
    if (!previous) out('# this mint has no signing key configured yet, so there is no history to keep')
    return 0
  }

  const mutates = command === 'reconcile' || command === 'sweep' || command === 'snapshot'
  let store: NoteStore
  const ownsStore = deps.store === undefined
  if (deps.store) {
    store = deps.store
  } else {
    try {
      store = new NoteStore(config.dbPath, {readOnly: !mutates})
    } catch (error) {
      err(`Cannot open ${config.dbPath}: ${(error as Error).message}`)
      return 1
    }
  }

  // Opened lazily: most commands never touch the funding source, and a
  // node that is down should not stop `notes` from listing.
  const held: {backend?: LightningBackend} = {}
  const fundingSource = (): LightningBackend => {
    held.backend ??= deps.backend ?? backendFor(config)
    return held.backend
  }

  try {
    switch (command) {
      case 'status': {
        const liabilities = store.liabilities(now())
        const totals = store.totals()
        let localBalanceMsat: number | undefined
        try {
          localBalanceMsat = (await fundingSource().nodeInfo?.())?.localBalanceMsat
        } catch (error) {
          err(`funding source unreachable: ${(error as Error).message}`)
        }
        const stats = buildStats({liabilities, localBalanceMsat, at: now()})
        const previous = config.previousSigningPubkeys ?? []
        out(`moneyer ${packageVersion ?? 'unknown version'} at ${config.dbPath}`)
        out(`  outstanding        ${sats(liabilities.outstandingMsat)} over ${liabilities.outstandingNotes} note${liabilities.outstandingNotes === 1 ? '' : 's'}`)
        out(
          `  melts in flight    ${liabilities.pendingMelts}${liabilities.pendingMelts ? ` (${sats(liabilities.pendingMsat)}, oldest ${liabilities.oldestPendingMeltAgeSecs}s)` : ''}`
        )
        out(`  unsettled invoices ${totals.unsettledMintInvoices}`)
        out(`  node balance       ${localBalanceMsat === undefined ? 'not reported' : sats(localBalanceMsat)}`)
        out(`  coverage           ${stats.coverage === undefined ? (liabilities.outstandingMsat === 0 ? 'nothing outstanding' : 'unknown') : stats.coverage}`)
        out(`  lifetime           ${totals.mints} mints, ${totals.melts.paid} melts paid, ${totals.melts.restored} restored, ${totals.zaps} zaps`)
        out(`  signing key        ${signingPubkey(config) ?? 'none - notes go out unsigned'}`)
        out(`  previous keys      ${previous.length ? previous.join(', ') : 'none'}`)
        out(`  funding source     ${config.backend.kind}`)
        return 0
      }

      case 'notes': {
        const state = flags.get('state')
        if (state !== undefined && (state === true || !['outstanding', 'pending', 'burned'].includes(state))) {
          err('--state must be outstanding, pending or burned.')
          return 2
        }
        const limitRaw = flags.get('limit')
        const limit = limitRaw === undefined || limitRaw === true ? 20 : Number(limitRaw)
        if (!Number.isSafeInteger(limit) || limit < 1) {
          err('--limit must be a positive whole number.')
          return 2
        }
        const rows = store.notes({...(state ? {state: state as NoteState} : {}), limit})
        if (!rows.length) {
          out('no notes')
          return 0
        }
        for (const row of rows) {
          out(`${row.id}  ${sats(row.amountMsat).padStart(14)}  ${row.state.padEnd(11)}  ${age(row.createdAt, now())} old`)
        }
        return 0
      }

      case 'note': {
        const wanted = positionals[1]
        if (!wanted) {
          err('Usage: moneyer admin note <id|k1>')
          return 2
        }
        const asked = wanted.toLowerCase()
        let note = store.noteById(asked)
        let id = asked
        // 64 hex that names no note is very likely the secret itself,
        // which an operator has in front of them far more often than an
        // id. Hash it and look again rather than say "unknown".
        if (!note && /^[0-9a-f]{64}$/.test(asked)) {
          id = hashK1(asked)
          note = store.noteById(id)
          if (note) out(`(that is a secret; its note id is ${id})`)
        }
        if (!note) {
          const invoice = store.mintInvoiceByHash(asked)
          if (invoice) {
            out(`${asked} is a mint invoice for ${sats(invoice.grossMsat)}, netting ${sats(invoice.netMsat)}`)
            out(`  ${invoice.settled ? 'settled - the note exists at this id' : 'unsettled - no note yet'}`)
            return 0
          }
          out(`no note, and no mint invoice, at ${asked}`)
          return 1
        }
        out(`${id}`)
        out(`  value    ${sats(note.amountMsat)}`)
        out(`  state    ${note.state}`)
        const melt = store.melts({limit: 1000}).find(row => row.noteId === id)
        if (melt) {
          out(`  melt     ${melt.outcome ?? 'in flight'} for ${sats(melt.amountMsat)}, ${age(melt.createdAt, now())} ago`)
          out(`  hash     ${melt.paymentHash}`)
        }
        return 0
      }

      case 'melts': {
        const rows = store.melts({pendingOnly: flags.has('pending'), limit: 50})
        if (!rows.length) {
          out(flags.has('pending') ? 'no melts in flight' : 'no melts')
          return 0
        }
        for (const row of rows) {
          out(
            `${row.paymentHash}  ${sats(row.amountMsat).padStart(14)}  ${(row.outcome ?? 'in flight').padEnd(9)}  ${age(row.createdAt, now())} ago  note ${row.noteId.slice(0, 12)}`
          )
        }
        return 0
      }

      case 'reconcile': {
        const before = new Map(store.melts({pendingOnly: true, limit: 1000}).map(row => [row.paymentHash, row]))
        if (!before.size) {
          out('nothing in flight')
          return 0
        }
        await reconcilePendingMelts(store, fundingSource(), new Set())
        let changed = 0
        for (const paymentHash of before.keys()) {
          const after = store.meltByHash(paymentHash)
          if (after?.outcome) {
            changed++
            out(`${paymentHash} ${after.outcome === 'paid' ? 'confirmed paid - note burned' : 'confirmed unpaid - note restored'}`)
          }
        }
        out(`${changed} of ${before.size} resolved${changed === before.size ? '' : ', the rest still have no terminal answer'}`)
        return 0
      }

      case 'sweep': {
        const swept = sweepExpiredMintInvoices(store, now())
        out(`swept ${swept} expired mint invoice${swept === 1 ? '' : 's'}`)
        return 0
      }

      case 'snapshot': {
        const path = positionals[1]
        if (!path) {
          err('Usage: moneyer admin snapshot <path>')
          return 2
        }
        if (existsSync(path)) {
          err(`${path} already exists - refusing to overwrite a snapshot.`)
          return 1
        }
        store.snapshot(path)
        out(`snapshot written to ${path}`)
        return 0
      }

      case 'names': {
        if (positionals[1] !== undefined && positionals[1] !== 'list') {
          // The self-service names table is not here yet; until it is,
          // names are the MONEYER_ZAP_NAMES line and editing that is the
          // operator's own doing.
          err('Only "names list" is available: zap names come from MONEYER_ZAP_NAMES.')
          return 2
        }
        const names = Object.entries(config.zap?.names ?? {})
        if (!names.length) {
          out('no zap names configured')
          return 0
        }
        for (const [name, pubkey] of names) out(`${name.padEnd(20)} ${pubkey}`)
        return 0
      }

      case 'verify-note': {
        const url = positionals[1]
        if (!url) {
          err('Usage: moneyer admin verify-note <url>')
          return 2
        }
        let k1: string
        try {
          k1 = noteK1(url) ?? ''
        } catch {
          k1 = ''
        }
        if (!k1) {
          err('That is not a note URL - no k1 in it.')
          return 2
        }
        const id = hashK1(k1)
        const declared = noteDeclaredAmount(url)
        const signature = noteSignature(url)
        const current = signingPubkey(config)
        const keys = [...(current ? [current] : []), ...(config.previousSigningPubkeys ?? [])]
        out(`note id  ${id}`)
        if (declared !== null) out(`declared ${sats(declared)}`)
        if (!signature) {
          out('signature none on the URL')
        } else if (declared === null) {
          out('signature present, but the URL declares no amount to check it against')
        } else {
          const signedBy = keys.find(pubkey => verifyNoteSignature(k1, declared, signature, pubkey))
          out(
            signedBy === undefined
              ? 'signature DOES NOT verify against this mint'
              : `signature verifies against ${signedBy === current ? 'the current key' : `a previous key (${signedBy})`}`
          )
        }
        const note = store.noteById(id)
        out(`mint     ${note ? `holds ${sats(note.amountMsat)}, state ${note.state}` : 'has no note at this id'}`)
        // A note the mint does not know, or one already burned, is the
        // answer the operator came for; say it in the exit code too.
        return note && note.state !== 'burned' ? 0 : 1
      }

      default:
        return 2
    }
  } catch (error) {
    const message = (error as Error).message
    // A database with no tables is a path that has never held a mint -
    // far more likely a typo than a corrupt file, and worth saying so.
    err(
      /no such table/.test(message)
        ? `${config.dbPath} does not look like a moneyer database - has the mint ever run against it?`
        : message
    )
    return 1
  } finally {
    if (ownsStore) store.close()
    if (deps.backend === undefined && held.backend) await held.backend.close?.()
  }
}
