import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {buildNoteUrl, hashK1, withNewK1} from 'lnurlcash-kit'
import {runAdmin} from '../src/admin.ts'
import {NoteStore} from '../src/store.ts'
import {createFakeBackend, FAKE_LOCAL_BALANCE_MSAT} from '../src/backends/fake.ts'
import {createNoteSigner} from '../src/signing.ts'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {TEST_SIGNING_KEY, freshK1} from './helpers.ts'

// The operator CLI, driven with the argv an operator would type and a
// :memory: store standing in for the mint's database. No server, no
// network: every command here has to be answerable from the database and
// the funding source alone.

const ENV = {MONEYER_SIGNING_KEY: TEST_SIGNING_KEY, MONEYER_DB: ':memory:'}

const run = async (argv: string[], overrides: {env?: NodeJS.ProcessEnv; store?: NoteStore} = {}) => {
  const out: string[] = []
  const err: string[] = []
  const store = overrides.store ?? new NoteStore(':memory:')
  const code = await runAdmin(argv, {
    env: {...ENV, ...overrides.env},
    store,
    backend: createFakeBackend(),
    out: line => out.push(line),
    err: line => err.push(line)
  })
  return {code, out: out.join('\n'), err: err.join('\n'), store}
}

let temp: string | null = null
afterEach(() => {
  if (temp) rmSync(temp, {recursive: true, force: true})
  temp = null
})

describe('moneyer admin', () => {
  it('reports the same figures /stats would', async () => {
    const store = new NoteStore(':memory:')
    store.creditNote(hashK1(freshK1()), 40_000)
    store.creditNote(hashK1(freshK1()), 8_000)
    const {code, out} = await run(['status'], {store})
    expect(code).toBe(0)
    expect(out).toContain('48 sat over 2 notes')
    expect(out).toContain(`${FAKE_LOCAL_BALANCE_MSAT / 1000}`.slice(0, 3))
    expect(out).toContain('coverage')
    expect(out).toContain(createNoteSigner(TEST_SIGNING_KEY).pubkey)
  })

  it('lists notes, filtered by state', async () => {
    const store = new NoteStore(':memory:')
    const live = hashK1(freshK1())
    const dead = hashK1(freshK1())
    store.creditNote(live, 40_000)
    store.creditNote(dead, 1_000)
    store.swap([dead], [{id: hashK1(freshK1()), amountMsat: 1_000}])
    const all = await run(['notes'], {store})
    expect(all.out.split('\n')).toHaveLength(3)
    const burned = await run(['notes', '--state', 'burned'], {store})
    expect(burned.out).toContain(dead)
    expect(burned.out).not.toContain(live)
    const bad = await run(['notes', '--state', 'nonsense'], {store})
    expect(bad.code).toBe(2)
  })

  it('finds a note by its secret as well as by its id', async () => {
    const store = new NoteStore(':memory:')
    const k1 = freshK1()
    store.creditNote(hashK1(k1), 21_000)
    const byId = await run(['note', hashK1(k1)], {store})
    expect(byId.out).toContain('21 sat')
    const bySecret = await run(['note', k1], {store})
    expect(bySecret.out).toContain('that is a secret')
    expect(bySecret.out).toContain('21 sat')
    const missing = await run(['note', 'ab'.repeat(32)], {store})
    expect(missing.code).toBe(1)
  })

  it('resolves melts left in flight and says what changed', async () => {
    const store = new NoteStore(':memory:')
    const noteId = hashK1(freshK1())
    store.creditNote(noteId, 21_000)
    const paymentHash = freshK1()
    store.markPending(noteId, paymentHash, fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash}), 21_000)
    const idle = await run(['melts', '--pending'], {store})
    expect(idle.out).toContain('in flight')
    // The fake funding source knows nothing about this payment, so the
    // reconciler confirms it never went out and restores the note.
    const {out} = await run(['reconcile'], {store})
    expect(out).toContain('confirmed unpaid - note restored')
    expect(store.noteById(noteId)!.state).toBe('outstanding')
    expect((await run(['reconcile'], {store})).out).toContain('nothing in flight')
  })

  it('sweeps expired mint invoices', async () => {
    const store = new NoteStore(':memory:')
    const paymentHash = freshK1()
    store.recordMintInvoice(
      paymentHash,
      fakeBolt11({amountMsat: 22_000, paymentHashHex: paymentHash, timestamp: Math.floor(Date.now() / 1000) - 3 * 3600}),
      22_000,
      22_000
    )
    const {out} = await run(['sweep'], {store})
    expect(out).toBe('swept 1 expired mint invoice')
    expect(store.mintInvoiceByHash(paymentHash)).toBeNull()
  })

  it('takes a snapshot that opens and counts, and refuses to overwrite one', async () => {
    temp = mkdtempSync(join(tmpdir(), 'moneyer-admin-'))
    const path = join(temp, 'snapshot.sqlite')
    const store = new NoteStore(join(temp, 'live.sqlite'))
    store.creditNote(hashK1(freshK1()), 21_000)
    const first = await run(['snapshot', path], {store})
    expect(first.code).toBe(0)
    const copy = new NoteStore(path, {readOnly: true})
    expect(copy.liabilities().outstandingMsat).toBe(21_000)
    expect(copy.readOnly).toBe(true)
    copy.close()
    const second = await run(['snapshot', path], {store})
    expect(second.code).toBe(1)
    expect(second.err).toContain('refusing to overwrite')
    store.close()
  })

  it('prints a rotation an operator can paste, and writes nothing', async () => {
    const {code, out} = await run(['keys', 'rotate'], {
      env: {MONEYER_SIGNING_KEY: TEST_SIGNING_KEY, MONEYER_PREVIOUS_SIGNING_PUBKEYS: `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`}
    })
    expect(code).toBe(0)
    const fresh = /MONEYER_SIGNING_KEY=([0-9a-f]{64})/.exec(out)![1]!
    expect(fresh).not.toBe(TEST_SIGNING_KEY)
    // The key that is being retired leads the history, and the one that
    // was already there stays.
    const history = /MONEYER_PREVIOUS_SIGNING_PUBKEYS=(\S+)/.exec(out)![1]!.split(',')
    expect(history[0]).toBe(createNoteSigner(TEST_SIGNING_KEY).pubkey)
    expect(history).toHaveLength(2)
    // And the new pubkey it announces really is that key's.
    expect(out).toContain(bytesToHex(secp256k1.getPublicKey(hexToBytes(fresh), true)))
  })

  it('verifies a note offline and then says what the mint holds', async () => {
    const store = new NoteStore(':memory:')
    const signer = createNoteSigner(TEST_SIGNING_KEY)
    const k1 = freshK1()
    store.creditNote(hashK1(k1), 21_000)
    const url = withNewK1('https://mint.example/w', k1, 21_000, signer.sign(hashK1(k1), 21_000))
    const good = await run(['verify-note', url], {store})
    expect(good.code).toBe(0)
    expect(good.out).toContain('verifies against the current key')
    expect(good.out).toContain('holds 21 sat, state outstanding')

    // A note this mint never signed: the signature is the tell, not the
    // database, and both are reported.
    const stranger = withNewK1('https://mint.example/w', k1, 21_000, createNoteSigner('22'.repeat(32)).sign(hashK1(k1), 21_000))
    expect((await run(['verify-note', stranger], {store})).out).toContain('DOES NOT verify')

    const unknown = buildNoteUrl('https://mint.example/w', freshK1(), 21_000)
    const missing = await run(['verify-note', unknown], {store})
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('has no note at this id')
  })

  it('lists the zap names the mint is configured with', async () => {
    const {out} = await run(['names'], {
      env: {
        MONEYER_PUBLIC_ORIGIN: 'https://mint.example',
        MONEYER_NOSTR_KEY: '22'.repeat(32),
        MONEYER_NOSTR_RELAYS: 'wss://relay.example',
        MONEYER_ZAP_NAMES: `alice=${'33'.repeat(32)}`
      }
    })
    expect(out).toContain('alice')
    expect(out).toContain('33'.repeat(32))
  })

  it('refuses an unknown command and explains itself with no argument', async () => {
    expect((await run(['frobnicate'])).code).toBe(2)
    const bare = await run([])
    expect(bare.code).toBe(2)
    expect(bare.out).toContain('moneyer admin - operate a running mint')
  })

  it('opens the database read-only unless the command mutates', async () => {
    temp = mkdtempSync(join(tmpdir(), 'moneyer-admin-'))
    const path = join(temp, 'live.sqlite')
    const live = new NoteStore(path)
    live.creditNote(hashK1(freshK1()), 21_000)
    live.close()
    const out: string[] = []
    const code = await runAdmin(['notes'], {
      env: {...ENV, MONEYER_DB: path},
      backend: createFakeBackend(),
      out: line => out.push(line),
      err: line => out.push(line)
    })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('21 sat')
  })
})
