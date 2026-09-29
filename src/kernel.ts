import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {createInterface} from 'node:readline'
import {bytesToHex} from '@noble/hashes/utils.js'
import {encodeCw1, type ScriptVerifier} from './spend.ts'

// A ScriptVerifier backed by a long-lived child process speaking one JSON
// request and one JSON reply per line: scripts/kernel-verifier.py, which
// runs Bitcoin Core's own interpreter through lnurlcash-kernel.
//
// LUD-25 has a mint accept any consensus-valid tapscript, and moneyer is
// not a tapscript interpreter. Rather than write one, it borrows the one
// the reference mint uses, so the two mints accept and refuse exactly the
// same spends.
//
// Anything short of a verdict - the process missing, crashing, answering
// with an error, or too slowly - refuses the spend. The note is untouched
// and the wallet can try again; accepting on a broken verifier would be
// the one unrecoverable answer.

export const UNAVAILABLE = 'script verification is unavailable - try again later'

export type KernelVerifier = ScriptVerifier & {close: () => void}

export const createKernelVerifier = (options: {
  // The command and its arguments, e.g. ['python3', '/opt/moneyer/kernel-verifier.py'].
  command: string[]
  timeoutMs?: number
  log?: (message: string) => void
}): KernelVerifier => {
  const [program, ...args] = options.command
  if (!program) throw new Error('The script verifier needs a command.')
  const timeoutMs = options.timeoutMs ?? 5_000
  const log = options.log ?? (() => {})
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  const pending = new Map<number, {resolve: (reason: string | null) => void; timer: NodeJS.Timeout}>()

  const settle = (id: number, reason: string | null): void => {
    const waiting = pending.get(id)
    if (!waiting) return
    clearTimeout(waiting.timer)
    pending.delete(id)
    waiting.resolve(reason)
  }

  const refuseAll = (): void => {
    for (const id of [...pending.keys()]) settle(id, UNAVAILABLE)
  }

  const running = (): ChildProcessWithoutNullStreams => {
    if (child) return child
    const started = spawn(program, args, {stdio: ['pipe', 'pipe', 'pipe']})
    started.on('error', err => {
      log(`script verifier failed to start: ${err.message}`)
      if (child === started) child = null
      refuseAll()
    })
    started.on('exit', code => {
      log(`script verifier exited (${code ?? 'signal'})`)
      if (child === started) child = null
      refuseAll()
    })
    // A write to a process that has just died fails asynchronously; the
    // exit handler above has already refused whatever was waiting.
    started.stdin.on('error', err => log(`script verifier stdin: ${err.message}`))
    started.stderr.on('data', chunk => log(`script verifier: ${String(chunk).trim()}`))
    createInterface({input: started.stdout}).on('line', line => {
      let reply: {id?: unknown; ok?: unknown; reason?: unknown; error?: unknown}
      try {
        reply = JSON.parse(line) as typeof reply
      } catch {
        return
      }
      if (typeof reply.id !== 'number') return
      if (reply.ok === true) settle(reply.id, null)
      else if (typeof reply.reason === 'string') settle(reply.id, reply.reason)
      else {
        log(`script verifier error: ${String(reply.error)}`)
        settle(reply.id, UNAVAILABLE)
      }
    })
    child = started
    return started
  }

  const verify: ScriptVerifier = ({outputKey, domain, spend, now, lockedAt}) =>
    new Promise(resolve => {
      const id = nextId++
      const timer = setTimeout(() => {
        log('script verifier timed out')
        settle(id, UNAVAILABLE)
      }, timeoutMs)
      pending.set(id, {resolve, timer})
      const request = {id, q: bytesToHex(outputKey), domain, cw1: encodeCw1(spend), now, locked_at: lockedAt}
      try {
        running().stdin.write(`${JSON.stringify(request)}\n`)
      } catch (err) {
        log(`script verifier unreachable: ${(err as Error).message}`)
        settle(id, UNAVAILABLE)
      }
    })

  return Object.assign(verify, {
    close: () => {
      refuseAll()
      child?.kill()
      child = null
    }
  })
}
