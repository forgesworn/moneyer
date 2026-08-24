import {readFileSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtempSync} from 'node:fs'
import {afterEach, describe, expect, it} from 'vitest'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {hashK1} from 'lnurlcash-kit'
import {extractBolt11, runLiveBoundMintCheck, type LiveCheckState} from '../src/live-check.ts'
import {fakeBolt11} from '../src/backends/fake-bolt11.ts'
import {freshK1, startMint, type TestMint} from './helpers.ts'

let active: TestMint | null = null
let temporary: string | null = null

afterEach(async () => {
  await active?.moneyer.close()
  active = null
  if (temporary) rmSync(temporary, {recursive: true, force: true})
  temporary = null
})

describe('the resumable live bound-mint check', () => {
  it('finds refund invoices in JSON or human-readable command output', () => {
    const pr = fakeBolt11({paymentHashHex: freshK1()})
    expect(extractBolt11(JSON.stringify({payment_request: pr}))).toBe(pr)
    expect(extractBolt11(`+-----------------+\n| payment_request | ${pr} |\n+-----------------+`)).toBe(pr)
    expect(extractBolt11('payment succeeded')).toBeNull()
  })

  it('persists before payment, accepts an ambiguous payer exit, validates the receipt and retires the note', async () => {
    active = await startMint({
      minMintMsat: 50_000,
      mintFee: {baseFeeMsat: 5_000, feePpm: 1_000},
      roundFeeToSat: true
    })
    temporary = mkdtempSync(join(tmpdir(), 'moneyer-live-check-'))
    const statePath = join(temporary, 'state.json')
    let payerCalls = 0
    let refundCalls = 0

    const result = await runLiveBoundMintCheck({
      payUrl: `${active.moneyer.url}/.well-known/lnurlp/mint`,
      grossMsat: 56_000,
      statePath,
      timeoutMs: 2_000,
      pollMs: 5,
      payInvoice: async pr => {
        payerCalls += 1
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as LiveCheckState
        expect(state.stage).toBe('quoted')
        expect(state.secret).toMatch(/^[0-9a-f]{64}$/)
        expect(hashK1(state.secret!)).toBe(state.h)
        if (typeof process.getuid === 'function') expect(statSync(statePath).mode & 0o077).toBe(0)

        active!.backend.control.settleInvoice(decodeBolt11(pr).paymentHashHex)
        // A payment command can lose its connection after lnd accepted the
        // payment. The independently settled /verify response must win.
        throw new Error('payer connection closed after accepting the invoice')
      },
      createRefundInvoice: async () => {
        refundCalls += 1
        const preimage = freshK1()
        const paymentHashHex = hashK1(preimage)
        active!.backend.control.registerPaymentPreimage(paymentHashHex, preimage)
        const pr = fakeBolt11({paymentHashHex})
        // Exercise the same table shape that broke the one-off live check.
        return `+-----------------+\n| payment_request | ${pr} |\n+-----------------+`
      }
    })

    expect(payerCalls).toBe(1)
    expect(refundCalls).toBe(1)
    expect(result).toMatchObject({
      stage: 'retired',
      grossMsat: 56_000,
      netMsat: 50_000,
      paymentPreimageValidated: true,
      receiptSignatureValidated: true,
      refundSettled: true
    })
    expect(active.moneyer.store.liabilities()).toMatchObject({outstandingMsat: 0, outstandingNotes: 0})

    const finalState = JSON.parse(readFileSync(statePath, 'utf8')) as LiveCheckState
    expect(finalState.stage).toBe('retired')
    expect(finalState.secret).toBeUndefined()
    expect(finalState.quote).toBeUndefined()
    expect(finalState.refundPr).toBeUndefined()
    expect(finalState).toMatchObject({
      paymentPreimageValidated: true,
      receiptSignatureValidated: true,
      refundSettled: true
    })

    // A completed state is idempotent: rerunning neither pays nor creates
    // another refund invoice.
    const repeated = await runLiveBoundMintCheck({
      payUrl: `${active.moneyer.url}/.well-known/lnurlp/mint`,
      grossMsat: 56_000,
      statePath,
      payInvoice: async () => {
        payerCalls += 1
      },
      createRefundInvoice: async () => {
        refundCalls += 1
        return ''
      }
    })
    expect(repeated).toEqual(result)
    expect(payerCalls).toBe(1)
    expect(refundCalls).toBe(1)
  })
})
