import {afterEach, describe, expect, it} from 'vitest'
import {
  NoteSpentError,
  NoteUnknownError,
  applyMintFee,
  buildNoteUrl,
  fetchInvoiceVerification,
  fetchNoteInfo,
  fetchPayRequest,
  hashK1,
  rotateNote,
  rotateNoteWithHash,
  verifyNoteSignature
} from 'lnurlcash-kit'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NoteStore} from '../src/store.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// Naming the note you are buying.
//
// A minted note's secret used to be the invoice's payment preimage, and a
// preimage is not private: the funding source has it, every node that
// forwarded the payment has it, and LUD-21 verify hands it to anyone who
// can name the payment hash, which is written inside the invoice. So the
// wallet may instead choose the secret itself and send its hash as `h` on
// the pay callback. The mint then credits the note at `h`, and the
// preimage buys nothing.
//
// The property these tests pin is one sentence: after a bound mint
// settles, the payment preimage is not a usable secret and the wallet's
// own secret is.

let active: TestMint | null = null
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

type CallbackReply = {status?: string; reason?: string; pr?: string; verify?: string; mintToHash?: boolean}

// The pay callback called directly: lnurlcash-kit 0.1.x has no way to send
// `h` yet, and the wire is the contract being tested.
const payCallback = async (mint: TestMint, params: Record<string, string>): Promise<CallbackReply> => {
  const url = new URL(`${mint.moneyer.url}/p/cb`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return (await (await fetch(url)).json()) as CallbackReply
}

// Counts what the mint asks of its funding source, so "refused before any
// invoice is issued" can be checked rather than assumed.
const countInvoices = (mint: TestMint): (() => number) => {
  let created = 0
  const create = mint.backend.createInvoice.bind(mint.backend)
  mint.backend.createInvoice = async args => {
    created += 1
    return create(args)
  }
  return () => created
}

describe('minting to a named note', () => {
  it('mints the note at the id the wallet named, so the payment preimage buys nothing', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, {amount: '21000', h: hashK1(secret)})
    expect(reply.pr).toBeDefined()
    // The mint says it honoured the binding, before a sat is paid.
    expect(reply.mintToHash).toBe(true)

    const paymentHash = decodeBolt11(reply.pr!).paymentHashHex
    mint.backend.control.settleInvoice(paymentHash)

    // Claimed with nothing but the secret the wallet chose: no verify
    // poll, no preimage, no race with anyone watching the invoice.
    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(note.maxWithdrawable).toBe(21_000)

    // The preimage is still served, and is now an ordinary payment proof.
    const verification = await fetchInvoiceVerification(reply.verify!)
    expect(verification.settled).toBe(true)
    expect(verification.preimage).not.toBeNull()
    expect(hashK1(verification.preimage!)).toBe(paymentHash)

    // It is not a note. Neither reading it nor spending it works.
    await expect(fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, verification.preimage!))).rejects.toThrow(
      NoteUnknownError
    )
    await expect(rotateNote(`${mint.moneyer.url}/w/cb`, verification.preimage!)).rejects.toThrow(NoteSpentError)

    // And the buyer's note is untouched by any of that.
    const after = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(after.maxWithdrawable).toBe(21_000)
    const rotated = await rotateNote(after.callback, secret)
    // The mint signs the rotated note for the full 21,000 msat, which is
    // the value the buyer paid for and nobody else ever held.
    expect(verifyNoteSignature(rotated.k1, 21_000, rotated.signature!, mint.moneyer.signer!.pubkey)).toBe(true)
  })

  it('withholds the mint fee from a named note exactly as from any other', async () => {
    const fee = {baseFeeMsat: 1000, feePpm: 5000}
    const mint = await start({mintFee: fee})
    const secret = freshK1()
    const reply = await payCallback(mint, {amount: '50000', h: hashK1(secret)})
    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(note.maxWithdrawable).toBe(applyMintFee(50_000, fee))
  })

  it('leaves a wallet that sends no h exactly where it was', async () => {
    const mint = await start()
    const reply = await payCallback(mint, {amount: '21000'})
    expect(reply.pr).toBeDefined()
    // Absent, not false: a wallet reads this as "no binding was made".
    expect(reply.mintToHash).toBeUndefined()

    const paymentHash = decodeBolt11(reply.pr!).paymentHashHex
    mint.backend.control.settleInvoice(paymentHash)
    const verification = await fetchInvoiceVerification(reply.verify!)
    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, verification.preimage!))
    expect(note.maxWithdrawable).toBe(21_000)
  })

  it('takes an uppercase h as the same name, as the withdraw callback does', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, {amount: '21000', h: hashK1(secret).toUpperCase()})
    expect(reply.mintToHash).toBe(true)
    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    expect((await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))).maxWithdrawable).toBe(21_000)
  })

  it('refuses a malformed h before it asks the funding source for anything', async () => {
    const mint = await start()
    const invoicesCreated = countInvoices(mint)
    for (const h of ['', 'not hex at all', 'ab'.repeat(31), `${'ab'.repeat(32)}cd`, 'z'.repeat(64)]) {
      const reply = await payCallback(mint, {amount: '21000', h})
      expect(reply.status).toBe('ERROR')
      expect(reply.pr).toBeUndefined()
    }
    // Nothing was quoted, so nothing could have been paid for.
    expect(invoicesCreated()).toBe(0)
    expect(mint.moneyer.store.unsettledMintInvoices()).toHaveLength(0)
  })

  it('refuses an h that already names something, without saying what', async () => {
    const mint = await start()

    // An outstanding note.
    const existing = freshK1()
    mint.moneyer.store.creditNote(hashK1(existing), 5_000)
    const overNote = await payCallback(mint, {amount: '21000', h: hashK1(existing)})
    expect(overNote.status).toBe('ERROR')
    expect(overNote.reason).toBe('Invalid or already spent k1.')
    expect(overNote.pr).toBeUndefined()

    // An unsettled invoice's own payment hash, which is a note id in
    // waiting whenever the payer named nothing.
    const unbound = await payCallback(mint, {amount: '21000'})
    const unboundHash = decodeBolt11(unbound.pr!).paymentHashHex
    const overInvoice = await payCallback(mint, {amount: '21000', h: unboundHash})
    expect(overInvoice.reason).toBe('Invalid or already spent k1.')

    // A note somebody else has already bought but not yet claimed.
    const theirs = freshK1()
    const first = await payCallback(mint, {amount: '21000', h: hashK1(theirs)})
    expect(first.mintToHash).toBe(true)
    const second = await payCallback(mint, {amount: '21000', h: hashK1(theirs)})
    expect(second.reason).toBe('Invalid or already spent k1.')
    expect(second.pr).toBeUndefined()

    // The refusal is the same sentence every time: which table an id sits
    // in is an oracle nobody is owed.
    expect(new Set([overNote.reason, overInvoice.reason, second.reason]).size).toBe(1)
  })

  it('will not let a rotation mint over a note somebody has already bought', async () => {
    const mint = await start()
    const bought = freshK1()
    const reply = await payCallback(mint, {amount: '21000', h: hashK1(bought)})
    expect(reply.mintToHash).toBe(true)

    const mine = freshK1()
    mint.moneyer.store.creditNote(hashK1(mine), 5_000)
    await expect(rotateNoteWithHash(`${mint.moneyer.url}/w/cb`, mine, hashK1(bought))).rejects.toThrow(NoteSpentError)

    // The rotation was refused whole: the input note is still spendable.
    expect((await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, mine))).maxWithdrawable).toBe(5_000)

    // And the bought note still arrives at its buyer.
    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    expect((await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, bought))).maxWithdrawable).toBe(21_000)
  })

  it('says it accepts the parameter before a wallet has to ask', async () => {
    const mint = await start()
    const pay = await fetchPayRequest(`${mint.moneyer.url}/.well-known/lnurlp/mint`)
    expect((pay as unknown as {mintToHash?: boolean}).mintToHash).toBe(true)
    const info = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlw/mint`)).json()) as {mintToHash?: boolean}
    expect(info.mintToHash).toBe(true)
  })
})

describe('an existing database', () => {
  // The mint_invoices table gained a column, and `CREATE TABLE IF NOT
  // EXISTS` leaves an old database exactly as it found it. An operator
  // upgrading has a database full of live notes, so the migration is the
  // one part of this that cannot be allowed to fail quietly.
  it('gains the column an upgrade needs, keeping the rows it already had', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-mint-to-hash-'))
    const path = join(dir, 'mint.db')
    try {
      const old = new DatabaseSync(path)
      old.exec(`
        CREATE TABLE mint_invoices (
          payment_hash TEXT PRIMARY KEY,
          pr TEXT NOT NULL,
          gross_msat INTEGER NOT NULL,
          net_msat INTEGER NOT NULL,
          settled INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `)
      old
        .prepare('INSERT INTO mint_invoices (payment_hash, pr, gross_msat, net_msat, settled, created_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run('aa'.repeat(32), 'lnbc-old', 22_000, 22_000, Date.now())
      old.close()

      const store = new NoteStore(path)
      // The invoice from before the upgrade still reads, and is unbound.
      const carried = store.mintInvoiceByHash('aa'.repeat(32))
      expect(carried?.netMsat).toBe(22_000)
      expect(carried?.outputId).toBeNull()
      // It still mints its note at its own payment hash, as it was sold.
      store.settleMintInvoice('aa'.repeat(32))
      expect(store.noteById('aa'.repeat(32))?.amountMsat).toBe(22_000)

      // And a note can be named from here on.
      store.recordMintInvoice('bb'.repeat(32), 'lnbc-new', 30_000, 30_000, 'cc'.repeat(32))
      store.settleMintInvoice('bb'.repeat(32))
      expect(store.noteById('bb'.repeat(32))).toBeNull()
      expect(store.noteById('cc'.repeat(32))?.amountMsat).toBe(30_000)
      store.close()
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})
