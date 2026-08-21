import {DatabaseSync} from 'node:sqlite'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'

// The store holds note IDs - sha256(k1) - and never a secret. A freshly
// minted note's id is exactly the payment hash of the invoice that funded
// it, so the spend secret lives only with the payer (and, until claimed,
// with the funding source, which is why wallets rotate immediately).
//
// Everything here is synchronous on purpose: a mutation's validate-and-
// transition happens in one SQLite transaction with no await inside it, so
// two concurrent callbacks racing for the same note cannot both win.

export type NoteState = 'outstanding' | 'pending' | 'burned'
export type NoteRow = {id: string; amountMsat: number; state: NoteState}
export type MintInvoiceRow = {
  paymentHash: string
  pr: string
  grossMsat: number
  netMsat: number
  settled: boolean
}
export type MeltRow = {
  paymentHash: string
  noteId: string
  pr: string
  amountMsat: number
  outcome: 'paid' | 'restored' | null
}
// A zap-to-note invoice (zap.ts). Unlike a mint invoice its payment hash
// is NOT a note id: the payer learns the preimage on settlement, so the
// note minted for the recipient gets a secret of its own. `noteId` is
// sha256 of that secret once minted. The wrap and receipt are kept only
// until published: the wrap is ciphertext only the recipient can open,
// and the receipt is public by design.
export type ZapInvoiceRow = {
  paymentHash: string
  name: string
  recipient: string
  pr: string
  grossMsat: number
  netMsat: number
  zapRequest: string | null
  settled: boolean
  noteId: string | null
  wrapJson: string | null
  receiptJson: string | null
  settledAt: number | null
}

// What identifies one mutation request, so a retry of it can be answered
// with the same reply instead of "already spent". Everything the WALLET
// chose goes in: the notes it named (by id, never by secret - the store
// holds no secrets), the output ids it asked for, and the split amount.
// Anything else naming a burned input is a different request and is still
// refused, so no oracle appears. Input order is not part of it: a
// reordered retry is the same operation.
export const swapFingerprint = (args: {
  inputIds: string[]
  h: string
  h2?: string | undefined
  amountMsat?: number | undefined
}): string =>
  bytesToHex(
    sha256(
      utf8ToBytes(
        [[...args.inputIds].sort().join(','), args.h, args.h2 ?? '', args.amountMsat === undefined ? '' : String(args.amountMsat)].join(
          '|'
        )
      )
    )
  )

// What the mint owes, as /stats and the operator CLI report it.
export type Liabilities = {
  outstandingMsat: number
  outstandingNotes: number
  pendingMsat: number
  pendingMelts: number
  oldestPendingMeltAgeSecs: number
}

export type NoteListRow = NoteRow & {createdAt: number; updatedAt: number}
export type MeltListRow = MeltRow & {createdAt: number; resolvedAt: number | null}
export type StoreTotals = {
  mints: number
  unsettledMintInvoices: number
  zaps: number
  melts: {paid: number; restored: number; pending: number}
}

// A note named by the request is reserved by an in-flight melt. The wire
// reply for this is the exact reason string "pending".
export class NotePendingError extends Error {}
// A note named by the request is burned or was never minted. The callback
// cannot say which without leaking, so the wire reply is the atomic
// "Invalid or already spent k1."
export class NoteUnavailableError extends Error {}
// A requested output id already names a note or a mint invoice. Refused
// before anything burns: minting "over" an existing id would let whoever
// can learn that id's preimage take the output.
export class OutputCollisionError extends Error {}

export class NoteStore {
  private db: DatabaseSync
  readonly readOnly: boolean

  // `readOnly` is for the operator CLI: a command that only reads should
  // not be able to write, and should not create a database file at a
  // mistyped path either. It skips the schema statements for the same
  // reason - there is nothing to migrate when nothing can be written.
  constructor(path: string, options: {readOnly?: boolean} = {}) {
    this.readOnly = options.readOnly === true
    if (this.readOnly) {
      this.db = new DatabaseSync(path, {readOnly: true})
      return
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        amount_msat INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('outstanding','pending','burned')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mint_invoices (
        payment_hash TEXT PRIMARY KEY,
        pr TEXT NOT NULL,
        gross_msat INTEGER NOT NULL,
        net_msat INTEGER NOT NULL,
        settled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS zap_invoices (
        payment_hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        recipient TEXT NOT NULL,
        pr TEXT NOT NULL,
        gross_msat INTEGER NOT NULL,
        net_msat INTEGER NOT NULL,
        zap_request TEXT,
        settled INTEGER NOT NULL DEFAULT 0,
        note_id TEXT,
        wrap_json TEXT,
        receipt_json TEXT,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        published_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS swaps (
        fingerprint TEXT PRIMARY KEY,
        outputs TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS melts (
        payment_hash TEXT PRIMARY KEY,
        note_id TEXT NOT NULL,
        pr TEXT NOT NULL,
        amount_msat INTEGER NOT NULL,
        outcome TEXT CHECK (outcome IN ('paid','restored')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
    `)
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  noteById(id: string): NoteRow | null {
    const row = this.db
      .prepare('SELECT id, amount_msat, state FROM notes WHERE id = ?')
      .get(id) as {id: string; amount_msat: number; state: NoteState} | undefined
    return row ? {id: row.id, amountMsat: row.amount_msat, state: row.state} : null
  }

  private insertNote(id: string, amountMsat: number): void {
    const now = Date.now()
    this.db
      .prepare('INSERT INTO notes (id, amount_msat, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, amountMsat, 'outstanding', now, now)
  }

  private setNoteState(id: string, state: NoteState): void {
    this.db.prepare('UPDATE notes SET state = ?, updated_at = ? WHERE id = ?').run(state, Date.now(), id)
  }

  // An output id may not collide with any existing note OR any mint
  // invoice's payment hash, settled or not. The invoice case is the subtle
  // one: /verify hands out a settled mint invoice's preimage, and that
  // preimage is the k1 of whatever note carries the invoice's payment hash
  // as its id - so letting a mutation claim such an id would point a future
  // payer's money at a stranger's note.
  private assertOutputIdFree(id: string): void {
    const asNote = this.db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)
    const asInvoice = this.db.prepare('SELECT 1 FROM mint_invoices WHERE payment_hash = ?').get(id)
    if (asNote || asInvoice) throw new OutputCollisionError(`output id ${id} is already in use`)
  }

  private assertOutstanding(id: string): NoteRow {
    const note = this.noteById(id)
    if (!note) throw new NoteUnavailableError(`no note ${id}`)
    if (note.state === 'pending') throw new NotePendingError(`note ${id} has a melt in flight`)
    if (note.state !== 'outstanding') throw new NoteUnavailableError(`note ${id} is ${note.state}`)
    return note
  }

  // The atomic mutation behind rotate, split and merge: burn every input,
  // mint every output, or do nothing at all.
  //
  // `fingerprint`, when given, records which request minted these outputs
  // from those inputs. A GET is retried by transports that have no idea a
  // rotate spends anything - Go's net/http retries one on a reused idle
  // connection, the JDK's HttpClient retries idempotent methods with no
  // switch to stop it - and the retry arrives byte-identical after the
  // inputs are already burned. Without provenance the mint can only say
  // "already spent", and a wallet that believes it drops the only copy of
  // a secret the mint really did mint a note against.
  swap(inputIds: string[], outputs: Array<{id: string; amountMsat: number}>, fingerprint?: string): void {
    this.tx(() => {
      for (const id of inputIds) this.assertOutstanding(id)
      for (const output of outputs) this.assertOutputIdFree(output.id)
      for (const id of inputIds) this.setNoteState(id, 'burned')
      for (const output of outputs) this.insertNote(output.id, output.amountMsat)
      if (fingerprint !== undefined) {
        this.db
          .prepare('INSERT OR REPLACE INTO swaps (fingerprint, outputs, created_at) VALUES (?, ?, ?)')
          .run(fingerprint, JSON.stringify(outputs.map(output => [output.id, output.amountMsat])), Date.now())
      }
    })
  }

  // What a previous request with this exact fingerprint minted, if any.
  // Provenance is recorded rather than inferred on purpose: matching on
  // "a note exists at h" alone would let anyone holding a burned k1 and
  // any outstanding note id draw a success out of the mint.
  swapByFingerprint(fingerprint: string): Array<{id: string; amountMsat: number}> | null {
    const row = this.db.prepare('SELECT outputs FROM swaps WHERE fingerprint = ?').get(fingerprint) as
      | {outputs: string}
      | undefined
    if (!row) return null
    const parsed = JSON.parse(row.outputs) as Array<[string, number]>
    return parsed.map(([id, amountMsat]) => ({id, amountMsat}))
  }

  // Reserves a note for a melt and records the melt, atomically. The melts
  // row is keyed by the invoice's payment hash; a duplicate hash means an
  // earlier melt already used this invoice and the INSERT itself refuses.
  markPending(noteId: string, paymentHash: string, pr: string, amountMsat: number): void {
    this.tx(() => {
      this.assertOutstanding(noteId)
      this.db
        .prepare('INSERT INTO melts (payment_hash, note_id, pr, amount_msat, outcome, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(paymentHash, noteId, pr, amountMsat, Date.now())
      this.setNoteState(noteId, 'pending')
    })
  }

  finalizeMelt(paymentHash: string): void {
    this.tx(() => {
      const melt = this.meltByHash(paymentHash)
      if (!melt || melt.outcome !== null) return
      this.db
        .prepare('UPDATE melts SET outcome = ?, resolved_at = ? WHERE payment_hash = ?')
        .run('paid', Date.now(), paymentHash)
      this.setNoteState(melt.noteId, 'burned')
    })
  }

  restoreMelt(paymentHash: string): void {
    this.tx(() => {
      const melt = this.meltByHash(paymentHash)
      if (!melt || melt.outcome !== null) return
      this.db
        .prepare('UPDATE melts SET outcome = ?, resolved_at = ? WHERE payment_hash = ?')
        .run('restored', Date.now(), paymentHash)
      const note = this.noteById(melt.noteId)
      if (note?.state === 'pending') this.setNoteState(melt.noteId, 'outstanding')
    })
  }

  meltByHash(paymentHash: string): MeltRow | null {
    const row = this.db
      .prepare('SELECT payment_hash, note_id, pr, amount_msat, outcome FROM melts WHERE payment_hash = ?')
      .get(paymentHash) as
      | {payment_hash: string; note_id: string; pr: string; amount_msat: number; outcome: 'paid' | 'restored' | null}
      | undefined
    if (!row) return null
    return {
      paymentHash: row.payment_hash,
      noteId: row.note_id,
      pr: row.pr,
      amountMsat: row.amount_msat,
      outcome: row.outcome
    }
  }

  pendingMelts(): MeltRow[] {
    const rows = this.db
      .prepare('SELECT payment_hash, note_id, pr, amount_msat, outcome FROM melts WHERE outcome IS NULL')
      .all() as Array<{payment_hash: string; note_id: string; pr: string; amount_msat: number; outcome: null}>
    return rows.map(row => ({
      paymentHash: row.payment_hash,
      noteId: row.note_id,
      pr: row.pr,
      amountMsat: row.amount_msat,
      outcome: row.outcome
    }))
  }

  recordMintInvoice(paymentHash: string, pr: string, grossMsat: number, netMsat: number): void {
    this.tx(() => {
      this.assertOutputIdFree(paymentHash)
      this.db
        .prepare('INSERT INTO mint_invoices (payment_hash, pr, gross_msat, net_msat, settled, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(paymentHash, pr, grossMsat, netMsat, Date.now())
    })
  }

  mintInvoiceByHash(paymentHash: string): MintInvoiceRow | null {
    const row = this.db
      .prepare('SELECT payment_hash, pr, gross_msat, net_msat, settled FROM mint_invoices WHERE payment_hash = ?')
      .get(paymentHash) as
      | {payment_hash: string; pr: string; gross_msat: number; net_msat: number; settled: number}
      | undefined
    if (!row) return null
    return {
      paymentHash: row.payment_hash,
      pr: row.pr,
      grossMsat: row.gross_msat,
      netMsat: row.net_msat,
      settled: row.settled === 1
    }
  }

  // Every unsettled mint invoice, for the expiry sweep. An unsettled row
  // past its bolt11 expiry can never settle - the funding source refuses
  // expired invoices - so it is dead weight, and every /p/cb call adds one.
  unsettledMintInvoices(): MintInvoiceRow[] {
    const rows = this.db
      .prepare('SELECT payment_hash, pr, gross_msat, net_msat, settled FROM mint_invoices WHERE settled = 0')
      .all() as Array<{payment_hash: string; pr: string; gross_msat: number; net_msat: number; settled: number}>
    return rows.map(row => ({
      paymentHash: row.payment_hash,
      pr: row.pr,
      grossMsat: row.gross_msat,
      netMsat: row.net_msat,
      settled: false
    }))
  }

  // Conditional on STILL unsettled: a settle landing between the sweep's
  // check and this delete must win, always.
  deleteUnsettledMintInvoice(paymentHash: string): void {
    this.db.prepare('DELETE FROM mint_invoices WHERE payment_hash = ? AND settled = 0').run(paymentHash)
  }

  // Paying a mint invoice is what brings its note into existence. Safe to
  // call twice: the second settle finds the note already minted.
  settleMintInvoice(paymentHash: string): void {
    this.tx(() => {
      const invoice = this.mintInvoiceByHash(paymentHash)
      if (!invoice) return
      this.db.prepare('UPDATE mint_invoices SET settled = 1 WHERE payment_hash = ?').run(paymentHash)
      if (!this.noteById(paymentHash)) this.insertNote(paymentHash, invoice.netMsat)
    })
  }

  // ---- zap-to-note ----

  recordZapInvoice(row: {
    paymentHash: string
    name: string
    recipient: string
    pr: string
    grossMsat: number
    netMsat: number
    zapRequest: string | null
  }): void {
    this.db
      .prepare(
        'INSERT INTO zap_invoices (payment_hash, name, recipient, pr, gross_msat, net_msat, zap_request, settled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
      )
      .run(row.paymentHash, row.name, row.recipient, row.pr, row.grossMsat, row.netMsat, row.zapRequest, Date.now())
  }

  private zapRow(row: Record<string, unknown>): ZapInvoiceRow {
    return {
      paymentHash: row.payment_hash as string,
      name: row.name as string,
      recipient: row.recipient as string,
      pr: row.pr as string,
      grossMsat: row.gross_msat as number,
      netMsat: row.net_msat as number,
      zapRequest: (row.zap_request as string | null) ?? null,
      settled: row.settled === 1,
      noteId: (row.note_id as string | null) ?? null,
      wrapJson: (row.wrap_json as string | null) ?? null,
      receiptJson: (row.receipt_json as string | null) ?? null,
      settledAt: (row.settled_at as number | null) ?? null
    }
  }

  private static readonly ZAP_COLUMNS =
    'payment_hash, name, recipient, pr, gross_msat, net_msat, zap_request, settled, note_id, wrap_json, receipt_json, settled_at'

  zapInvoiceByHash(paymentHash: string): ZapInvoiceRow | null {
    const row = this.db
      .prepare(`SELECT ${NoteStore.ZAP_COLUMNS} FROM zap_invoices WHERE payment_hash = ?`)
      .get(paymentHash) as Record<string, unknown> | undefined
    return row ? this.zapRow(row) : null
  }

  unsettledZapInvoices(): ZapInvoiceRow[] {
    const rows = this.db
      .prepare(`SELECT ${NoteStore.ZAP_COLUMNS} FROM zap_invoices WHERE settled = 0`)
      .all() as Record<string, unknown>[]
    return rows.map(row => this.zapRow(row))
  }

  deleteUnsettledZapInvoice(paymentHash: string): void {
    this.db.prepare('DELETE FROM zap_invoices WHERE payment_hash = ? AND settled = 0').run(paymentHash)
  }

  // The note comes into being and the events that announce it are parked
  // for publishing, in one transaction: a crash between the two would
  // otherwise leave a liability nobody was ever told about. Returns false
  // if the row was already settled (a racing poll), in which case nothing
  // was minted.
  settleZapInvoice(paymentHash: string, noteId: string, wrapJson: string, receiptJson: string | null): boolean {
    return this.tx(() => {
      const row = this.zapInvoiceByHash(paymentHash)
      if (!row || row.settled) return false
      this.assertOutputIdFree(noteId)
      this.insertNote(noteId, row.netMsat)
      this.db
        .prepare(
          'UPDATE zap_invoices SET settled = 1, note_id = ?, wrap_json = ?, receipt_json = ?, settled_at = ? WHERE payment_hash = ?'
        )
        .run(noteId, wrapJson, receiptJson, Date.now(), paymentHash)
      return true
    })
  }

  // Settled zaps whose wrap has not yet reached a relay.
  unpublishedZaps(): ZapInvoiceRow[] {
    const rows = this.db
      .prepare(`SELECT ${NoteStore.ZAP_COLUMNS} FROM zap_invoices WHERE settled = 1 AND published_at IS NULL`)
      .all() as Record<string, unknown>[]
    return rows.map(row => this.zapRow(row))
  }

  // The wrap is on a relay: drop our copy. The receipt is dropped with it
  // whether or not every relay took it - it is public and best-effort.
  markZapPublished(paymentHash: string): void {
    this.db
      .prepare('UPDATE zap_invoices SET wrap_json = NULL, receipt_json = NULL, published_at = ? WHERE payment_hash = ?')
      .run(Date.now(), paymentHash)
  }

  // Operator/dev funding path: mint a note directly, bypassing Lightning.
  // The fake backend's world only - the CLI never exposes it on a real one.
  creditNote(id: string, amountMsat: number): void {
    this.tx(() => {
      this.assertOutputIdFree(id)
      this.insertNote(id, amountMsat)
    })
  }

  // Everything the mint owes and everything it is in the middle of
  // paying, in one read. Public numbers only: this is what /stats
  // publishes, and no per-note detail belongs anywhere near it.
  liabilities(nowMs: number = Date.now()): Liabilities {
    const notes = this.db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(amount_msat), 0) AS total FROM notes WHERE state IN ('outstanding','pending')"
      )
      .get() as {count: number; total: number}
    const melts = this.db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(amount_msat), 0) AS total, MIN(created_at) AS oldest FROM melts WHERE outcome IS NULL'
      )
      .get() as {count: number; total: number; oldest: number | null}
    return {
      outstandingMsat: notes.total,
      outstandingNotes: notes.count,
      pendingMsat: melts.total,
      pendingMelts: melts.count,
      // Whole seconds, and never negative however the clock has moved.
      oldestPendingMeltAgeSecs: melts.oldest === null ? 0 : Math.max(0, Math.floor((nowMs - melts.oldest) / 1000))
    }
  }

  // Note rows for the operator CLI. Newest first, capped by the caller:
  // this is the operator's own database, not anything a request reaches.
  notes(filter: {state?: NoteState; limit?: number} = {}): NoteListRow[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 20, 1000))
    const rows = (
      filter.state === undefined
        ? this.db
            .prepare('SELECT id, amount_msat, state, created_at, updated_at FROM notes ORDER BY created_at DESC LIMIT ?')
            .all(limit)
        : this.db
            .prepare(
              'SELECT id, amount_msat, state, created_at, updated_at FROM notes WHERE state = ? ORDER BY created_at DESC LIMIT ?'
            )
            .all(filter.state, limit)
    ) as Array<{id: string; amount_msat: number; state: NoteState; created_at: number; updated_at: number}>
    return rows.map(row => ({
      id: row.id,
      amountMsat: row.amount_msat,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  melts(filter: {pendingOnly?: boolean; limit?: number} = {}): MeltListRow[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 20, 1000))
    const where = filter.pendingOnly === true ? 'WHERE outcome IS NULL' : ''
    const rows = this.db
      .prepare(
        `SELECT payment_hash, note_id, pr, amount_msat, outcome, created_at, resolved_at FROM melts ${where} ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      payment_hash: string
      note_id: string
      pr: string
      amount_msat: number
      outcome: 'paid' | 'restored' | null
      created_at: number
      resolved_at: number | null
    }>
    return rows.map(row => ({
      paymentHash: row.payment_hash,
      noteId: row.note_id,
      pr: row.pr,
      amountMsat: row.amount_msat,
      outcome: row.outcome,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at
    }))
  }

  // Lifetime totals, read from the tables rather than counted in memory,
  // so a restart does not reset them.
  totals(): StoreTotals {
    const mints = this.db.prepare('SELECT COUNT(*) AS n FROM mint_invoices WHERE settled = 1').get() as {n: number}
    const unsettled = this.db.prepare('SELECT COUNT(*) AS n FROM mint_invoices WHERE settled = 0').get() as {n: number}
    const zaps = this.db.prepare('SELECT COUNT(*) AS n FROM zap_invoices WHERE settled = 1').get() as {n: number}
    const melts = this.db
      .prepare("SELECT COALESCE(outcome, 'pending') AS outcome, COUNT(*) AS n FROM melts GROUP BY 1")
      .all() as Array<{outcome: 'paid' | 'restored' | 'pending'; n: number}>
    const byOutcome = {paid: 0, restored: 0, pending: 0}
    for (const row of melts) byOutcome[row.outcome] = row.n
    return {mints: mints.n, unsettledMintInvoices: unsettled.n, zaps: zaps.n, melts: byOutcome}
  }

  // VACUUM INTO: a consistent copy of the whole database, taken while the
  // mint is running, without needing a sqlite3 binary on the box. SQLite
  // refuses an existing target itself; the caller checks first so the
  // operator gets a sentence rather than a driver error.
  snapshot(path: string): void {
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`)
  }

  outstandingLiabilityMsat(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount_msat), 0) AS total FROM notes WHERE state IN ('outstanding','pending')")
      .get() as {total: number}
    return row.total
  }

  close(): void {
    this.db.close()
  }
}
