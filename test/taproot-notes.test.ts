import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {hashK1} from '@lnurlcash/kit'
import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, concatBytes, hexToBytes} from '@noble/hashes/utils.js'
import {
  NUMS_H,
  bearerLeaf,
  decodeSpend,
  encodeCk1,
  encodeCp1,
  encodeCw1,
  keyPathSighash,
  tapLeafHash,
  taprootTweak,
  type ScriptSpend
} from '../src/spend.ts'
import {NoteStore, swapFingerprint} from '../src/store.ts'
import {createFakeBackend} from '../src/backends/fake.ts'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {certifiesNote, freshK1, noteIdOf, startMint, type TestMint} from './helpers.ts'

// LUD-25's unified model at the mint: every note is a taproot output key Q,
// a ck1 is bound to this mint's domain, a cw1 opens a note by one of its
// leaves, and notes written before any of that stay spendable.

let active: TestMint | null = null
const cleanups: Array<() => void> = []
const start: typeof startMint = async (...args) => {
  active = await startMint(...args)
  return active
}
afterEach(async () => {
  await active?.moneyer.close()
  active = null
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Body = Record<string, unknown>
const call = async (mint: TestMint, path: string, params: Array<[string, string]>): Promise<Body> => {
  const url = new URL(`${mint.moneyer.url}${path}`)
  for (const [name, value] of params) url.searchParams.append(name, value)
  return (await (await fetch(url)).json()) as Body
}
const info = (mint: TestMint, params: Array<[string, string]>) => call(mint, '/w', params)
const callback = (mint: TestMint, params: Array<[string, string]>) => call(mint, '/w/cb', params)
const stateOf = (mint: TestMint, q: string) => mint.moneyer.store.noteByQ(q)?.state

const ZERO_AUX = new Uint8Array(32)

// A key note and its ck1, bound to `domain`.
const keyNote = (domain: string) => {
  const sk = schnorr.utils.randomSecretKey()
  const q = schnorr.getPublicKey(sk)
  return {sk, q: bytesToHex(q), cp1: encodeCp1(q), ck1: encodeCk1(q, schnorr.sign(keyPathSighash(q, domain), sk, ZERO_AUX))}
}

// A bearer note's preimage spelled out in full, as a cw1.
const fullCw1 = (k1: string): string => encodeCw1(decodeSpend(k1) as ScriptSpend)

const creditBearer = (mint: TestMint, amountMsat: number): string => {
  const k1 = freshK1()
  mint.moneyer.store.creditNote(noteIdOf(k1), amountMsat)
  return k1
}

// A two-leaf tree under the NUMS key: a bearer hashlock the test holds the
// preimage for, and `other`. Returns the note and a cw1 builder per leaf.
const twoLeafNote = (other: Uint8Array, otherVersion = 0xc0) => {
  const preimage = hexToBytes(freshK1())
  const hashlock = bearerLeaf(sha256(preimage))
  const hashlockHash = tapLeafHash(hashlock)
  const otherHash = tapLeafHash(other, otherVersion)
  const [lo, hi] = bytesToHex(hashlockHash) < bytesToHex(otherHash) ? [hashlockHash, otherHash] : [otherHash, hashlockHash]
  const root = schnorr.utils.taggedHash('TapBranch', lo, hi)
  const {outputKey, parity} = taprootTweak(NUMS_H, root)!
  const control = (version: number, sibling: Uint8Array) => concatBytes(new Uint8Array([version | parity]), NUMS_H, sibling)
  return {
    q: bytesToHex(outputKey),
    viaHashlock: (claim: {locktime?: number; sequence?: number} = {}) =>
      encodeCw1({
        locktime: claim.locktime ?? 0,
        sequence: claim.sequence ?? 0xffffffff,
        script: hashlock,
        controlBlock: control(0xc0, otherHash),
        witness: [preimage]
      }),
    viaOther: () =>
      encodeCw1({locktime: 0, sequence: 0xffffffff, script: other, controlBlock: control(otherVersion, hashlockHash), witness: []})
  }
}

describe('a key-path spend', () => {
  it('opens its note at the mint it was signed for', async () => {
    const mint = await start()
    const key = keyNote(new URL(mint.moneyer.url).hostname)
    mint.moneyer.store.creditNote(key.q, 21_000)
    expect((await info(mint, [['k1', key.ck1]])).maxWithdrawable).toBe(21_000)
    expect((await callback(mint, [['k1', key.ck1], ['p1', hashK1(freshK1())]])).status).toBe('OK')
    expect(stateOf(mint, key.q)).toBe('burned')
  })

  it('opens nothing anywhere else, and does not say whether the note exists', async () => {
    const mint = await start()
    const key = keyNote('elsewhere.example')
    mint.moneyer.store.creditNote(key.q, 21_000)
    expect((await info(mint, [['k1', key.ck1]])).reason).toBe('Unknown note.')
    expect((await callback(mint, [['k1', key.ck1], ['p1', hashK1(freshK1())]])).reason).toBe('Invalid or already spent k1.')
    expect(stateOf(mint, key.q)).toBe('outstanding')
  })

  it("is bound to any of this mint's own hosts, clearnet or onion, and only those", async () => {
    const onion = 'http://mintmintmintmintmintmintmintmintmintmintmintmintmintmi.onion'
    const mint = await start({publicOrigin: 'https://mint.example', onionUrl: onion})
    for (const domain of ['mint.example', new URL(onion).hostname]) {
      const key = keyNote(domain)
      mint.moneyer.store.creditNote(key.q, 5_000)
      expect((await callback(mint, [['k1', key.ck1], ['p1', hashK1(freshK1())]])).status).toBe('OK')
    }
    // The host a request happened to arrive on is not one of them.
    const stray = keyNote(new URL(mint.moneyer.url).hostname)
    mint.moneyer.store.creditNote(stray.q, 5_000)
    expect((await callback(mint, [['k1', stray.ck1], ['p1', hashK1(freshK1())]])).status).toBe('ERROR')
  })

  it('is refused by the informational GET when its signature does not verify', async () => {
    const mint = await start()
    const key = keyNote(new URL(mint.moneyer.url).hostname)
    mint.moneyer.store.creditNote(key.q, 21_000)
    const forged = encodeCk1(hexToBytes(key.q), new Uint8Array(64).fill(7))
    expect((await info(mint, [['k1', forged]])).reason).toBe('Unknown note.')
  })
})

describe('a bearer note', () => {
  it('is the same note by its preimage and by its full cw1', async () => {
    const mint = await start()
    const k1 = creditBearer(mint, 21_000)
    const cw1 = fullCw1(k1)
    const byCw1 = await info(mint, [['k1', cw1]])
    expect(byCw1.maxWithdrawable).toBe(21_000)
    // The k1 comes back exactly as it was sent.
    expect(byCw1.k1).toBe(cw1)

    const next = freshK1()
    const first = await callback(mint, [['k1', cw1], ['p1', hashK1(next)]])
    expect(first.status).toBe('OK')
    // A retry spelled with the preimage is the same request: matched on Q.
    const retry = await callback(mint, [['k1', k1], ['p1', hashK1(next)]])
    expect(retry).toEqual(first)
  })

  it('is certified over its Q, wherever a certificate is given', async () => {
    const mint = await start()
    const k1 = creditBearer(mint, 21_000)
    const pubkey = mint.moneyer.signer.pubkey
    const byH = await info(mint, [['p', hashK1(k1)]])
    expect(certifiesNote(k1, 21_000, byH.sig as string, pubkey)).toBe(true)
    expect((byH.sig as string).startsWith('cs')).toBe(true)
    const next = freshK1()
    const rotated = await callback(mint, [['k1', k1], ['p1', hashK1(next)]])
    expect(certifiesNote(next, 21_000, rotated.sig as string, pubkey)).toBe(true)
    // Over Q, and so NOT over h the way certificates used to be made.
    expect(mint.moneyer.signer.sign(hashK1(next), 21_000)).not.toBe(mint.moneyer.signer.sign(noteIdOf(next), 21_000))
  })

  it('cannot be credited again once burned: "already in use"', async () => {
    const mint = await start()
    const spent = creditBearer(mint, 10_000)
    expect((await callback(mint, [['k1', spent], ['p1', hashK1(freshK1())]])).status).toBe('OK')
    const other = creditBearer(mint, 10_000)
    for (const named of [hashK1(spent), encodeCp1(hexToBytes(noteIdOf(spent)))]) {
      expect(await callback(mint, [['k1', other], ['p1', named]])).toEqual({status: 'ERROR', reason: 'already in use'})
    }
    expect(stateOf(mint, noteIdOf(other))).toBe('outstanding')
  })
})

describe('a script-path spend', () => {
  it('is refused for a leaf version this mint does not know, and the note stays spendable', async () => {
    const mint = await start()
    const note = twoLeafNote(new Uint8Array([0x51]), 0xc2)
    mint.moneyer.store.creditNote(note.q, 10_000)
    expect((await callback(mint, [['k1', note.viaOther()], ['p1', hashK1(freshK1())]])).reason).toBe('unknown tapleaf version')
    expect((await callback(mint, [['k1', note.viaHashlock()], ['p1', hashK1(freshK1())]])).status).toBe('OK')
  })

  it('is refused for a leaf using an OP_SUCCESS opcode', async () => {
    const mint = await start()
    const note = twoLeafNote(new Uint8Array([0x50]))
    mint.moneyer.store.creditNote(note.q, 10_000)
    expect((await info(mint, [['k1', note.viaOther()]])).reason).toMatch(/OP_SUCCESS/)
    expect((await callback(mint, [['k1', note.viaOther()], ['p1', hashK1(freshK1())]])).reason).toMatch(/OP_SUCCESS/)
    expect(stateOf(mint, note.q)).toBe('outstanding')
  })

  it('takes Unix-time claims only, judged on the mint clock', async () => {
    const mint = await start()
    const note = twoLeafNote(new Uint8Array([0x51]))
    mint.moneyer.store.creditNote(note.q, 10_000)
    const refuse = async (claim: {locktime?: number; sequence?: number}, reason: RegExp) =>
      expect((await callback(mint, [['k1', note.viaHashlock(claim)], ['p1', hashK1(freshK1())]])).reason).toMatch(reason)
    await refuse({locktime: 800_000}, /block-height/)
    await refuse({locktime: Math.floor(Date.now() / 1000) + 3600}, /in the future/)
    await refuse({sequence: 10}, /block-count/)
    // One 512-second unit, counted from when this mint credited the note.
    await refuse({sequence: (1 << 22) | 1}, /not yet satisfied/)
    const pastLock = {locktime: Math.floor(Date.now() / 1000) - 60}
    expect((await callback(mint, [['k1', note.viaHashlock(pastLock)], ['p1', hashK1(freshK1())]])).status).toBe('OK')
  })

  describe('with a leaf this mint cannot judge itself', () => {
    const {vectors} = JSON.parse(readFileSync(new URL('./fixtures/wallet-spend-vectors.json', import.meta.url), 'utf8')) as {
      vectors: Array<{name: string; output_key: string; spend: string; domain: string}>
    }
    const multisig = vectors.find(vector => vector.name === 'multisig2')!

    it('is refused, with the reason, and the note stays outstanding', async () => {
      const mint = await start({publicOrigin: `https://${multisig.domain}`})
      mint.moneyer.store.creditNote(multisig.output_key, 10_000)
      expect((await callback(mint, [['k1', multisig.spend], ['p1', hashK1(freshK1())]])).reason).toBe(
        'this mint cannot verify that script yet'
      )
      expect(stateOf(mint, multisig.output_key)).toBe('outstanding')
    })

    it('is handed to the configured verifier, for this mint domain', async () => {
      const asked: string[] = []
      const mint = await start(
        {publicOrigin: `https://${multisig.domain}`},
        {
          scriptVerifier: async ({domain}) => {
            asked.push(domain)
            return null
          }
        }
      )
      mint.moneyer.store.creditNote(multisig.output_key, 10_000)
      expect((await callback(mint, [['k1', multisig.spend], ['p1', hashK1(freshK1())]])).status).toBe('OK')
      expect(asked).toEqual([multisig.domain])
    })
  })
})

describe('a database from before notes were keyed by Q', () => {
  // Writes rows the way an older moneyer did - bearer notes under h - then
  // lets the store open it again as if freshly upgraded.
  const legacyDatabase = (rows: (db: DatabaseSync) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-legacy-'))
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}))
    const path = join(dir, 'mint.sqlite')
    new NoteStore(path).close()
    const db = new DatabaseSync(path)
    db.exec("DELETE FROM meta WHERE key = 'legacy_ids_indexed'; DROP TABLE legacy_ids;")
    rows(db)
    db.close()
    return path
  }
  const insertNote = (db: DatabaseSync, id: string, amountMsat: number, state = 'outstanding') =>
    db
      .prepare('INSERT INTO notes (id, amount_msat, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, amountMsat, state, Date.now(), Date.now())

  it('finds an old bearer note by its preimage, its full cw1, its h and its cp1', async () => {
    const k1 = freshK1()
    const mint = await start({dbPath: legacyDatabase(db => insertNote(db, hashK1(k1), 21_000))})
    for (const params of [[['k1', k1]], [['k1', fullCw1(k1)]], [['p', hashK1(k1)]], [['p', encodeCp1(hexToBytes(noteIdOf(k1)))]]] as Array<
      Array<[string, string]>
    >) {
      expect((await info(mint, params)).maxWithdrawable).toBe(21_000)
    }
    // Certified over its Q like any other note.
    const byP = await info(mint, [['p', hashK1(k1)]])
    expect(certifiesNote(k1, 21_000, byP.sig as string, mint.moneyer.signer.pubkey)).toBe(true)
  })

  it('spends it once, and never credits its Q or its h anew', async () => {
    const k1 = freshK1()
    const other = freshK1()
    const mint = await start({
      dbPath: legacyDatabase(db => {
        insertNote(db, hashK1(k1), 21_000)
        insertNote(db, hashK1(other), 5_000)
      })
    })
    // Naming the old note as an output, in either spelling, is a collision.
    for (const named of [hashK1(k1), encodeCp1(hexToBytes(noteIdOf(k1)))]) {
      expect((await callback(mint, [['k1', other], ['p1', named]])).reason).toBe('already in use')
    }
    expect((await callback(mint, [['k1', k1], ['p1', hashK1(freshK1())]])).status).toBe('OK')
    expect((await info(mint, [['k1', k1]])).reason).toBe('Note already spent.')
    expect((await callback(mint, [['k1', fullCw1(k1)], ['p1', hashK1(freshK1())]])).reason).toBe('Invalid or already spent k1.')
  })

  it('still answers a rotate completed before the upgrade as a replay', async () => {
    const input = freshK1()
    const output = freshK1()
    const mint = await start({
      dbPath: legacyDatabase(db => {
        insertNote(db, hashK1(input), 21_000, 'burned')
        insertNote(db, hashK1(output), 21_000)
        db.prepare('INSERT INTO swaps (fingerprint, outputs, created_at) VALUES (?, ?, ?)').run(
          swapFingerprint({inputIds: [hashK1(input)], h: hashK1(output)}),
          JSON.stringify([[hashK1(output), 21_000]]),
          Date.now()
        )
      })
    })
    const retry = await callback(mint, [['k1', input], ['p1', hashK1(output)]])
    expect(retry.status).toBe('OK')
    expect(certifiesNote(output, 21_000, retry.sig as string, mint.moneyer.signer.pubkey)).toBe(true)
  })

  it('keeps an old quote payable: its note lands at the h it was bound to, found by Q', async () => {
    const k1 = freshK1()
    const backend = createFakeBackend()
    const {pr} = await backend.createInvoice({amountMsat: 21_000, preimageHex: freshK1(), memo: 'an old quote'})
    const paymentHash = decodeBolt11(pr).paymentHashHex
    const mint = await start(
      {
        dbPath: legacyDatabase(db =>
          db
            .prepare(
              'INSERT INTO mint_invoices (payment_hash, pr, gross_msat, net_msat, settled, created_at, output_id) VALUES (?, ?, ?, ?, 0, ?, ?)'
            )
            .run(paymentHash, pr, 21_000, 21_000, Date.now(), hashK1(k1))
        )
      },
      {backend}
    )
    backend.control.settleInvoice(paymentHash)
    expect((await info(mint, [['k1', k1]])).maxWithdrawable).toBe(21_000)
    expect(mint.moneyer.store.noteById(hashK1(k1))?.state).toBe('outstanding')
  })
})

describe('certificates', () => {
  it('are named c and c2, with the older sig and sig2 alongside', async () => {
    const mint = await start()
    const k1 = creditBearer(mint, 50_000)
    const looked = await info(mint, [['k1', k1]])
    expect(looked.c).toBeTypeOf('string')
    expect(looked.sig).toBe(looked.c)
    expect(certifiesNote(k1, 50_000, looked.c as string, mint.moneyer.signer.pubkey)).toBe(true)

    const [to, change] = [freshK1(), freshK1()]
    const split = await callback(mint, [
      ['k1', k1],
      ['amount', '20000'],
      ['p1', hashK1(to)],
      ['p2', hashK1(change)]
    ])
    expect(split.status).toBe('OK')
    expect([split.sig, split.sig2]).toEqual([split.c, split.c2])
    expect(certifiesNote(to, 20_000, split.c as string, mint.moneyer.signer.pubkey)).toBe(true)
    expect(certifiesNote(change, 30_000, split.c2 as string, mint.moneyer.signer.pubkey)).toBe(true)
  })
})

describe('a database from before address purposes', () => {
  it("restarts each name's address counter once, and never again", () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-purpose-'))
    cleanups.push(() => rmSync(dir, {recursive: true, force: true}))
    const path = join(dir, 'mint.sqlite')
    const store = new NoteStore(path)
    store.putOperatorZapName('alice', 'aa'.repeat(32))
    store.close()
    const setIndex = (index: number, forget: boolean) => {
      const db = new DatabaseSync(path)
      db.prepare("UPDATE zap_names SET next_index = ? WHERE name = 'alice'").run(index)
      if (forget) db.exec("DELETE FROM meta WHERE key = 'address_purpose_counter'")
      db.close()
    }
    const indexOnOpen = (): number | undefined => {
      const reopened = new NoteStore(path)
      const index = reopened.zapName('alice')?.nextIndex
      reopened.close()
      return index
    }

    setIndex(3, true)
    expect(indexOnOpen()).toBe(0)
    setIndex(4, false)
    expect(indexOnOpen()).toBe(4)
  })
})
