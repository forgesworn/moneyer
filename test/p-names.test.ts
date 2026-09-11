import {afterEach, describe, expect, it} from 'vitest'
import {hashK1, verifyNoteSignature} from 'lnurlcash-kit'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// LUD-25 renamed the hash lookup `h` to `p` and the callback outputs `h`/`h2`
// to `p1`/`p2`. Wallets in the field send either, so both are accepted. The
// kit still sends the old names, hence raw URLs here.

let active: TestMint | null = null
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

type Body = Record<string, unknown>

const call = async (mint: TestMint, path: string, params: Array<[string, string]>): Promise<Body> => {
  const url = new URL(`${mint.moneyer.url}${path}`)
  for (const [name, value] of params) url.searchParams.append(name, value)
  return (await (await fetch(url)).json()) as Body
}
const info = (mint: TestMint, params: Array<[string, string]>) => call(mint, '/w', params)
const callback = (mint: TestMint, params: Array<[string, string]>) => call(mint, '/w/cb', params)

const creditNote = (mint: TestMint, amountMsat: number): string => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(hashK1(k1), amountMsat)
  return k1
}

const worth = async (mint: TestMint, k1: string): Promise<unknown> =>
  (await info(mint, [['k1', k1]])).maxWithdrawable

// A reason a wallet would read as a statement about the note itself.
const NOTE_STATE = /spent|unknown|not found|^pending$/i

// Shaped like a Part 2 `cp1` key, which this mint does not take yet.
const CP1 = `cp1${'q'.repeat(58)}`

describe('the informational GET by p', () => {
  it('looks a note up by p exactly as by h', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 42_000)
    const byP = await info(mint, [['p', hashK1(k1)]])
    expect(byP.maxWithdrawable).toBe(42_000)
    expect(byP).not.toHaveProperty('k1')
    expect(byP.mintPubkey).toBe(mint.moneyer.signer.pubkey)
    expect(await info(mint, [['h', hashK1(k1)]])).toEqual(byP)
    expect(await info(mint, [['p', hashK1(k1).toUpperCase()]])).toEqual(byP)
  })

  it('answers unknown, spent and pending by p', async () => {
    const mint = await start()
    expect((await info(mint, [['p', hashK1(freshK1())]])).reason).toBe('Unknown note.')

    const spent = creditNote(mint, 21_000)
    expect((await callback(mint, [['k1', spent], ['p1', hashK1(freshK1())]])).status).toBe('OK')
    expect((await info(mint, [['p', hashK1(spent)]])).reason).toBe('Note already spent.')

    const melting = creditNote(mint, 21_000)
    const paymentHash = freshK1()
    mint.moneyer.store.markPending(
      hashK1(melting),
      paymentHash,
      fakeBolt11({amountMsat: 21_000, paymentHashHex: paymentHash}),
      21_000
    )
    expect((await info(mint, [['p', hashK1(melting)]])).reason).toBe('pending')
  })

  it('takes p and h together only when they agree', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 42_000)
    const agreed = await info(mint, [['p', hashK1(k1)], ['h', hashK1(k1)]])
    expect(agreed.maxWithdrawable).toBe(42_000)

    const split = await info(mint, [['p', hashK1(k1)], ['h', hashK1(freshK1())]])
    expect(split.status).toBe('ERROR')
    expect(split.reason).not.toMatch(NOTE_STATE)
  })

  it('refuses p alongside k1, and a p that is not a 64-hex hash', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 42_000)
    expect((await info(mint, [['k1', k1], ['p', hashK1(k1)]])).reason).toBe('Unknown note.')
    expect((await info(mint, [['p', CP1]])).reason).toBe('Unknown note.')
    expect((await info(mint, [['p', '']])).reason).toBe('Unknown note.')
  })
})

describe('the callback under p1 and p2', () => {
  it('rotates to p1', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    const fresh = freshK1()
    const body = await callback(mint, [['k1', k1], ['p1', hashK1(fresh)]])
    expect(body.status).toBe('OK')
    expect(verifyNoteSignature(fresh, 21_000, body.sig as string, mint.moneyer.signer.pubkey)).toBe(true)
    expect(await worth(mint, fresh)).toBe(21_000)
    expect((await info(mint, [['k1', k1]])).reason).toBe('Note already spent.')
  })

  it('splits to p1 and p2', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    const keep = freshK1()
    const change = freshK1()
    const body = await callback(mint, [
      ['k1', k1],
      ['amount', '5000'],
      ['p1', hashK1(keep)],
      ['p2', hashK1(change)]
    ])
    expect(body.status).toBe('OK')
    const pubkey = mint.moneyer.signer.pubkey
    expect(verifyNoteSignature(keep, 5_000, body.sig as string, pubkey)).toBe(true)
    expect(verifyNoteSignature(change, 16_000, body.sig2 as string, pubkey)).toBe(true)
    expect(await worth(mint, keep)).toBe(5_000)
    expect(await worth(mint, change)).toBe(16_000)
  })

  it('takes one output under each spelling', async () => {
    const mint = await start()
    const first = creditNote(mint, 21_000)
    const keep = freshK1()
    const change = freshK1()
    const mixed = await callback(mint, [
      ['k1', first],
      ['amount', '5000'],
      ['h', hashK1(keep)],
      ['p2', hashK1(change)]
    ])
    expect(mixed.status).toBe('OK')
    expect(await worth(mint, keep)).toBe(5_000)
    expect(await worth(mint, change)).toBe(16_000)

    const second = creditNote(mint, 9_000)
    const a = freshK1()
    const b = freshK1()
    const flipped = await callback(mint, [
      ['k1', second],
      ['amount', '4000'],
      ['p1', hashK1(a)],
      ['h2', hashK1(b)]
    ])
    expect(flipped.status).toBe('OK')
    expect(await worth(mint, a)).toBe(4_000)
    expect(await worth(mint, b)).toBe(5_000)
  })

  it('takes both spellings of one output when they agree', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    const fresh = freshK1()
    const body = await callback(mint, [['k1', k1], ['p1', hashK1(fresh)], ['h', hashK1(fresh).toUpperCase()]])
    expect(body.status).toBe('OK')
    expect(await worth(mint, fresh)).toBe(21_000)
  })

  it('refuses two spellings of one output that disagree, and burns nothing', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)

    const rotate = await callback(mint, [['k1', k1], ['p1', hashK1(freshK1())], ['h', hashK1(freshK1())]])
    expect(rotate.status).toBe('ERROR')
    expect(rotate.reason).toBe('p1 and h name different outputs')

    const split = await callback(mint, [
      ['k1', k1],
      ['amount', '5000'],
      ['p1', hashK1(freshK1())],
      ['p2', hashK1(freshK1())],
      ['h2', hashK1(freshK1())]
    ])
    expect(split.status).toBe('ERROR')
    expect(split.reason).toBe('p2 and h2 name different outputs')

    expect(await worth(mint, k1)).toBe(21_000)
    expect(mint.moneyer.store.liabilities().outstandingNotes).toBe(1)
  })

  it('refuses a missing or malformed output, and burns nothing', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    const twin = hashK1(freshK1())

    expect((await callback(mint, [['k1', k1]])).reason).toBe('missing p1')
    expect((await callback(mint, [['k1', k1], ['p1', CP1]])).reason).toBe('missing p1')
    expect((await callback(mint, [['k1', k1], ['h', CP1]])).reason).toBe('missing p1')
    expect(
      (await callback(mint, [['k1', k1], ['amount', '5000'], ['p1', hashK1(freshK1())]])).reason
    ).toBe('missing p2')
    expect(
      (await callback(mint, [['k1', k1], ['amount', '5000'], ['p1', hashK1(freshK1())], ['p2', CP1]])).reason
    ).toBe('missing p2')
    expect(
      (await callback(mint, [['k1', k1], ['amount', '5000'], ['p1', twin], ['h2', twin]])).reason
    ).toBe('p1 and p2 must differ.')

    expect(await worth(mint, k1)).toBe(21_000)
  })

  it('answers a split retried under the other spelling as a replay', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    const keep = hashK1(freshK1())
    const change = hashK1(freshK1())

    const first = await callback(mint, [['k1', k1], ['amount', '5000'], ['h', keep], ['h2', change]])
    expect(first.status).toBe('OK')
    for (const retry of [
      [['p1', keep], ['p2', change]],
      [['p1', keep], ['h2', change]],
      [['h', keep], ['p2', change]]
    ] as Array<Array<[string, string]>>) {
      const again = await callback(mint, [['k1', k1], ['amount', '5000'], ...retry])
      expect(again).toEqual(first)
    }
    // A read each time: still two notes, still the original total.
    expect(mint.moneyer.store.liabilities().outstandingNotes).toBe(2)
    expect(mint.moneyer.store.liabilities().outstandingMsat).toBe(21_000)
  })

  it('answers a rotate retried under the old spelling as a replay', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    const fresh = hashK1(freshK1())
    const first = await callback(mint, [['k1', k1], ['p1', fresh]])
    expect(first.status).toBe('OK')
    expect(await callback(mint, [['k1', k1], ['h', fresh]])).toEqual(first)
  })

  it('still refuses a burned k1 that names a different output under the new spelling', async () => {
    const mint = await start()
    const k1 = creditNote(mint, 21_000)
    expect((await callback(mint, [['k1', k1], ['h', hashK1(freshK1())]])).status).toBe('OK')
    expect((await callback(mint, [['k1', k1], ['p1', hashK1(freshK1())]])).reason).toBe(
      'Invalid or already spent k1.'
    )
  })
})
