import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NoteStore} from '../src/store.ts'

// Two processes, one database: the mint and `moneyer admin`. WAL lets them
// read alongside each other, but a second WRITER needs a busy timeout or it
// is refused the instant the first one holds the lock.

let dir: string | null = null
const freshPath = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'moneyer-lock-'))
  return join(dir, 'mint.db')
}
afterEach(() => {
  if (dir) rmSync(dir, {recursive: true, force: true})
  dir = null
})

describe('two connections to one database', () => {
  it('gives a writer time to wait rather than refusing it outright', () => {
    const path = freshPath()
    const mint = new NoteStore(path)
    const admin = new NoteStore(path)
    expect(mint.busyTimeoutMs()).toBe(5_000)
    expect(admin.busyTimeoutMs()).toBe(5_000)
    mint.close()
    admin.close()
  })

  it('sets the timeout on a read-only connection too', () => {
    const path = freshPath()
    const mint = new NoteStore(path)
    const reader = new NoteStore(path, {readOnly: true})
    expect(reader.busyTimeoutMs()).toBe(5_000)
    reader.close()
    mint.close()
  })

  it('lets the second writer through once the first commits', () => {
    const path = freshPath()
    const mint = new NoteStore(path)
    const admin = new NoteStore(path)
    mint.creditNote('a'.repeat(64), 21_000)
    // the admin connection writes while the mint connection is idle but open
    expect(() => admin.creditNote('b'.repeat(64), 9_000)).not.toThrow()
    expect(admin.noteById('b'.repeat(64))?.amountMsat).toBe(9_000)
    expect(mint.noteById('b'.repeat(64))?.amountMsat).toBe(9_000)
    admin.close()
    mint.close()
  })
})
