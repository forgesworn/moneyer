import {afterEach, describe, expect, it} from 'vitest'
import {
  NoteSpentError,
  NoteUnknownError,
  buildNoteUrl,
  fetchInvoiceVerification,
  fetchNoteInfo,
  fetchPayRequest,
  hashK1,
  mintFeeBand,
  rotateNote,
  rotateNoteWithHash,
  verifyNoteSignature
} from 'lnurlcash-kit'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
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

type CallbackReply = {
  status?: string
  reason?: string
  pr?: string
  verify?: string
  mintToHash?: boolean
  mint?: {h: string; amount: number; sig?: string}
}

// The pay callback called directly. lnurlcash-kit can send `h` now, and
// test/bound-mint-e2e.test.ts drives the whole purchase through it, but
// these cases stay on the raw wire on purpose: most of them send shapes a
// wallet library refuses client-side, and refusing to send is not the same
// property as refusing to honour.
const payCallback = async (mint: TestMint, params: Record<string, string>): Promise<CallbackReply> => {
  const url = new URL(`${mint.moneyer.url}/p/cb`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return (await (await fetch(url)).json()) as CallbackReply
}

const namedQuote = (amount: string, h: string): Record<string, string> => ({
  amount,
  comment: h,
  h
})

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

describe('requiring comment protection', () => {
  it('refuses an unnamed quote before issuing an invoice', async () => {
    const mint = await start()
    const invoices = countInvoices(mint)
    const reply = await payCallback(mint, {amount: '21000'})
    expect(reply.status).toBe('ERROR')
    expect(reply.pr).toBeUndefined()
    expect(invoices()).toBe(0)
  })

  it('refuses a valid h when the mandatory comment is absent', async () => {
    const mint = await start()
    const invoices = countInvoices(mint)
    const reply = await payCallback(mint, {amount: '21000', h: hashK1(freshK1())})
    expect(reply.status).toBe('ERROR')
    expect(reply.pr).toBeUndefined()
    expect(invoices()).toBe(0)
  })

  it('mints a quote named by a valid comment', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, {
      amount: '21000',
      comment: bytesToHex(sha256(hexToBytes(secret)))
    })
    expect(reply.status).not.toBe('ERROR')
    expect(reply.pr).toBeTypeOf('string')
  })
})

describe('minting to a named note', () => {
  it('mints the note at the id the wallet named, so the payment preimage buys nothing', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, namedQuote('21000', hashK1(secret)))
    expect(reply.pr).toBeDefined()
    // The mint says it honoured the binding, before a sat is paid.
    expect(reply.mintToHash).toBe(true)
    expect(reply.mint).toEqual({h: hashK1(secret), amount: 21_000})

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

    const receipt = (await (await fetch(reply.verify!)).json()) as {
      settled: boolean
      mint: {h: string; amount: number; sig: string}
    }
    expect(receipt.mint.h).toBe(hashK1(secret))
    expect(receipt.mint.amount).toBe(21_000)
    expect(
      verifyNoteSignature(secret, receipt.mint.amount, receipt.mint.sig, mint.moneyer.signer!.pubkey)
    ).toBe(true)

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
    const reply = await payCallback(mint, namedQuote('50000', hashK1(secret)))
    expect(reply.mint).toEqual({
      h: hashK1(secret),
      amount: mintFeeBand(50_000, fee).minNetMsat
    })
    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(note.maxWithdrawable).toBe(mintFeeBand(50_000, fee).minNetMsat)
  })

  it('never signs a bound receipt before its invoice settles', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, namedQuote('21000', hashK1(secret)))
    const pending = (await (await fetch(reply.verify!)).json()) as {
      settled: boolean
      mint: {h: string; amount: number; sig?: string}
    }
    expect(pending.settled).toBe(false)
    expect(pending.mint).toEqual({h: hashK1(secret), amount: 21_000})
    expect(pending.mint.sig).toBeUndefined()
  })

  it('mints from the mandatory comment without the extension h', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, {
      amount: '21000',
      comment: hashK1(secret)
    })
    expect(reply.pr).toBeDefined()
    expect(reply.mintToHash).toBe(true)
    expect(reply.verify).toBeDefined()

    const paymentHash = decodeBolt11(reply.pr!).paymentHashHex
    mint.backend.control.settleInvoice(paymentHash)
    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(note.maxWithdrawable).toBe(21_000)
    const preimage = (await mint.backend.invoicePreimage(paymentHash))!
    await expect(
      fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, preimage))
    ).rejects.toThrow(NoteUnknownError)
  })

  it('takes an uppercase h as the same name, as the withdraw callback does', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(
      mint,
      namedQuote('21000', hashK1(secret).toUpperCase())
    )
    expect(reply.mintToHash).toBe(true)
    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    expect((await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))).maxWithdrawable).toBe(21_000)
  })

  it('refuses a malformed h before it asks the funding source for anything', async () => {
    const mint = await start()
    const invoicesCreated = countInvoices(mint)
    for (const h of ['', 'not hex at all', 'ab'.repeat(31), `${'ab'.repeat(32)}cd`, 'z'.repeat(64)]) {
      const reply = await payCallback(mint, {
        amount: '21000',
        comment: hashK1(freshK1()),
        h
      })
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
    const overNote = await payCallback(mint, namedQuote('21000', hashK1(existing)))
    expect(overNote.status).toBe('ERROR')
    expect(overNote.reason).toBe('Invalid or already spent k1.')
    expect(overNote.pr).toBeUndefined()

    // An unsettled invoice's own payment hash must not be sold as an output.
    const waiting = freshK1()
    const firstInvoice = await payCallback(
      mint,
      namedQuote('21000', hashK1(waiting))
    )
    const invoiceHash = decodeBolt11(firstInvoice.pr!).paymentHashHex
    const overInvoice = await payCallback(mint, namedQuote('21000', invoiceHash))
    expect(overInvoice.reason).toBe('Invalid or already spent k1.')

    // A note somebody else has already bought but not yet claimed.
    const theirs = freshK1()
    const first = await payCallback(mint, namedQuote('21000', hashK1(theirs)))
    expect(first.mintToHash).toBe(true)
    const second = await payCallback(mint, namedQuote('21000', hashK1(theirs)))
    expect(second.reason).toBe('Invalid or already spent k1.')
    expect(second.pr).toBeUndefined()

    // The refusal is the same sentence every time: which table an id sits
    // in is an oracle nobody is owed.
    expect(new Set([overNote.reason, overInvoice.reason, second.reason]).size).toBe(1)
  })

  it('will not let a rotation mint over a note somebody has already bought', async () => {
    const mint = await start()
    const bought = freshK1()
    const reply = await payCallback(mint, namedQuote('21000', hashK1(bought)))
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
    expect(pay.mintPubkey).toBe(mint.moneyer.signer!.pubkey)
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

// LUD-25 names every minted output with a LUD-12 `comment`. `h` predates
// that text here and remains an additive alias, but never substitutes for
// the mandatory comment.
describe('naming the note with a LUD-12 comment', () => {
  it('advertises the capability in both spellings', async () => {
    const mint = await start()
    const pay = (await (await fetch(`${mint.moneyer.url}/.well-known/lnurlp/mint`)).json()) as {
      mintToHash?: boolean
      commentAllowed?: number
    }
    expect(pay.mintToHash).toBe(true)
    // 64 characters: exactly a hex-encoded 32-byte hash, nothing spare
    expect(pay.commentAllowed).toBe(64)
  })

  it('mints to the id a comment named, with no h at all', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, {amount: '21000', comment: hashK1(secret)})
    expect(reply.mintToHash).toBe(true)

    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)

    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(note.maxWithdrawable).toBe(21_000)
  })

  // What our own kit now sends: both spellings, one hash.
  it('accepts both together when they agree', async () => {
    const mint = await start()
    const secret = freshK1()
    const h = hashK1(secret)
    const reply = await payCallback(mint, {amount: '21000', comment: h, h})
    expect(reply.mintToHash).toBe(true)

    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    const note = await fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, secret))
    expect(note.maxWithdrawable).toBe(21_000)
  })

  it('refuses to guess when they disagree', async () => {
    const mint = await start()
    const created = countInvoices(mint)
    const reply = await payCallback(mint, {
      amount: '21000',
      comment: hashK1(freshK1()),
      h: hashK1(freshK1())
    })
    expect(reply.status).toBe('ERROR')
    // minting under one of them would leave the wallet watching the other
    expect(created()).toBe(0)
  })

  it('refuses a malformed comment before invoice creation', async () => {
    const mint = await start()
    const created = countInvoices(mint)
    const reply = await payCallback(mint, {amount: '21000', comment: 'thanks for the sats'})
    expect(reply.status).toBe('ERROR')
    expect(reply.pr).toBeUndefined()
    expect(created()).toBe(0)
  })

  // A malformed `h`, by contrast, is a wallet that meant to name an output
  // and got it wrong. Failing loudly beats minting a note it is not
  // watching for.
  it('still fails loudly on a malformed h', async () => {
    const mint = await start()
    const created = countInvoices(mint)
    const reply = await payCallback(mint, {
      amount: '21000',
      comment: hashK1(freshK1()),
      h: 'not-a-hash'
    })
    expect(reply.status).toBe('ERROR')
    expect(created()).toBe(0)
  })
})

describe('verify on mint quotes', () => {
  it('never creates a verify URL for an unnamed request because it creates no invoice', async () => {
    const mint = await start()
    const reply = await payCallback(mint, {amount: '21000'})
    expect(reply.status).toBe('ERROR')
    expect(reply.verify).toBeUndefined()
    expect(reply.pr).toBeUndefined()
  })

  it('is still both for a note that was named', async () => {
    const mint = await start()
    const secret = freshK1()
    const reply = await payCallback(mint, {amount: '21000', comment: hashK1(secret)})
    expect(reply.verify).toBeDefined()

    mint.backend.control.settleInvoice(decodeBolt11(reply.pr!).paymentHashHex)
    const verification = await fetchInvoiceVerification(reply.verify!)
    expect(verification.settled).toBe(true)
    // The preimage is published here, and that is now harmless: it is not
    // the note, and buys nothing.
    expect(verification.preimage).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      fetchNoteInfo(buildNoteUrl(`${mint.moneyer.url}/w`, verification.preimage!))
    ).rejects.toBeTruthy()
  })
})

// The cutover is the whole reason this mint can adopt the rule without
// taking anyone's money with it. An invoice quoted before it keeps its
// verify, because the wallet polling one of those did not pay the invoice
// itself - that is why it is polling - so this mint's copy of the preimage
// is its only route to a note it already owns.
describe('the verify cutover across an upgrade', () => {
  it('reads an invoice quoted before the upgrade as older than the cutover', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-cutover-'))
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
        .prepare('INSERT INTO mint_invoices (payment_hash, pr, gross_msat, net_msat, settled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run('a1'.repeat(32), 'lnbc-before', 22_000, 22_000, Date.now() - 60_000)
      old.close()

      const store = new NoteStore(path)
      const cutover = store.unnamedVerifyCutover()
      expect(cutover).toBeGreaterThan(0)

      // Sold under the old rule, so it is honoured.
      const before = store.mintInvoiceByHash('a1'.repeat(32))!
      expect(before.outputId).toBeNull()
      expect(before.createdAt).toBeLessThan(cutover)

      // Quoted under the new one, so it is not.
      store.recordMintInvoice('a2'.repeat(32), 'lnbc-after', 30_000, 30_000, null)
      const after = store.mintInvoiceByHash('a2'.repeat(32))!
      expect(after.outputId).toBeNull()
      expect(after.createdAt).toBeGreaterThanOrEqual(cutover)

      // And it does not move on the next open, or a restart would strand a
      // quote made minutes earlier under the same build.
      store.close()
      const reopened = new NoteStore(path)
      expect(reopened.unnamedVerifyCutover()).toBe(cutover)
      reopened.close()
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })

  it('still answers verify for an unnamed invoice sold before the rule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-cutover-http-'))
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
        .prepare('INSERT INTO mint_invoices (payment_hash, pr, gross_msat, net_msat, settled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run('b1'.repeat(32), 'lnbc-before', 22_000, 22_000, Date.now() - 60_000)
      old.close()

      const mint = await start({dbPath: path})
      const res = await fetch(`${mint.moneyer.url}/verify/${'b1'.repeat(32)}`)
      // Answered, not refused. This mint has no preimage for an invoice its
      // fake funding source never issued, but the request is honoured, and
      // that is the branch under test.
      expect(res.status).toBe(200)

      // A fresh unnamed quote on the same database is refused before it can
      // create either an invoice or verify URL.
      const reply = await payCallback(mint, {amount: '21000'})
      expect(reply.status).toBe('ERROR')
      expect(reply.pr).toBeUndefined()
      expect(reply.verify).toBeUndefined()
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  })
})
