import {afterEach, describe, expect, it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {hashK1} from '@lnurlcash/kit'
import {hexToBytes} from '@noble/hashes/utils.js'
import {createKernelVerifier, UNAVAILABLE, type KernelVerifier} from '../src/kernel.ts'
import {decodeSpend, type ScriptSpend} from '../src/spend.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

// The script verifier moneyer hands every leaf it cannot evaluate itself:
// Bitcoin Core's interpreter in a child process. Anything short of a
// verdict must refuse, never accept.

const FAKE = fileURLToPath(new URL('./fixtures/fake-kernel.mjs', import.meta.url))
const SIDECAR = fileURLToPath(new URL('../scripts/kernel-verifier.py', import.meta.url))
const {vectors} = JSON.parse(readFileSync(new URL('./fixtures/wallet-spend-vectors.json', import.meta.url), 'utf8')) as {
  vectors: Array<{name: string; output_key: string; spend: string; domain: string; locked_at: number; now: number}>
}
const scriptVectors = vectors.filter(vector => decodeSpend(vector.spend)?.kind === 'script')

const verifiers: KernelVerifier[] = []
let active: TestMint | null = null
afterEach(async () => {
  for (const verifier of verifiers.splice(0)) verifier.close()
  await active?.moneyer.close()
  active = null
})

const fake = (mode = '', timeoutMs?: number): KernelVerifier => {
  process.env.FAKE_KERNEL = mode
  const verifier = createKernelVerifier({command: [process.execPath, FAKE], ...(timeoutMs ? {timeoutMs} : {})})
  verifiers.push(verifier)
  return verifier
}

const ask = (verifier: KernelVerifier, domain = 'mint.example.com') => {
  const vector = scriptVectors[0]!
  return verifier({
    outputKey: hexToBytes(vector.output_key),
    domain,
    spend: decodeSpend(vector.spend) as ScriptSpend,
    now: vector.now,
    lockedAt: vector.locked_at
  })
}

describe('the script verifier process', () => {
  it('passes a verdict through, either way', async () => {
    const verifier = fake()
    expect(await ask(verifier)).toBeNull()
    expect(await ask(verifier, 'refuse.example')).toBe('bitcoin core rejected the spend')
  })

  it('refuses when the process dies, and starts it again for the next spend', async () => {
    const verifier = fake('crash')
    expect(await ask(verifier)).toBe(UNAVAILABLE)
    process.env.FAKE_KERNEL = ''
    expect(await ask(verifier)).toBeNull()
  })

  it('refuses on an error, on silence, and on a command that does not exist', async () => {
    expect(await ask(fake('error'))).toBe(UNAVAILABLE)
    expect(await ask(fake('silent', 200))).toBe(UNAVAILABLE)
    const missing = createKernelVerifier({command: ['/nonexistent/kernel-verifier']})
    verifiers.push(missing)
    expect(await ask(missing)).toBe(UNAVAILABLE)
  })

  it('is started from MONEYER_SCRIPT_VERIFIER and judges what the mint cannot', async () => {
    const multisig = vectors.find(vector => vector.name === 'multisig2')!
    process.env.FAKE_KERNEL = ''
    active = await startMint({publicOrigin: `https://${multisig.domain}`, scriptVerifier: [process.execPath, FAKE]})
    active.moneyer.store.creditNote(multisig.output_key, 10_000)
    const url = new URL(`${active.moneyer.url}/w/cb`)
    url.searchParams.set('k1', multisig.spend)
    url.searchParams.set('p1', hashK1(freshK1()))
    expect(((await (await fetch(url)).json()) as {status: string}).status).toBe('OK')
  })
})

// Only where lnurlcash-kernel is installed: the real sidecar, over the
// spends lnurl-wallet generated and the reference kernel accepts.
const kernelInstalled = (() => {
  try {
    execFileSync('python3', ['-c', 'import lnurlcashkernel'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!kernelInstalled)('scripts/kernel-verifier.py with lnurlcash-kernel', () => {
  it.each(scriptVectors)('accepts $name, and refuses it at another mint', async vector => {
    const verifier = createKernelVerifier({command: ['python3', SIDECAR], timeoutMs: 20_000})
    verifiers.push(verifier)
    const args = {
      outputKey: hexToBytes(vector.output_key),
      spend: decodeSpend(vector.spend) as ScriptSpend,
      now: vector.now,
      lockedAt: vector.locked_at
    }
    expect(await verifier({...args, domain: vector.domain})).toBeNull()
    const signed = (decodeSpend(vector.spend) as ScriptSpend).witness.some(item => item.length === 64 || item.length === 65)
    if (signed) expect(await verifier({...args, domain: 'elsewhere.example'})).not.toBeNull()
  })
})
