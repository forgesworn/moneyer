import {randomBytes} from 'node:crypto'
import {lstat, open, readFile, rename, unlink} from 'node:fs/promises'
import {decodeBolt11} from 'farrier-kit/bolt11'
import {
  NoteSpentError,
  PendingNoteError,
  buildNoteUrl,
  claimMintedNote,
  decodeBolt11AmountMsat,
  fetchInvoiceVerification,
  fetchPayRequest,
  hashK1,
  isBolt11Invoice,
  isPreimage,
  meltNote,
  probeBurnedNote,
  requestInvoice,
  requireBoundMintQuote,
  validateBoundMintReceipt,
  withinMintFeeBand,
  type InvoiceResult,
  type VerifyResult
} from 'lnurlcash-kit'

export type LiveCheckStage = 'prepared' | 'quoted' | 'settled' | 'claimed' | 'retiring' | 'retired'

export type LiveCheckState = {
  version: 1
  stage: LiveCheckStage
  payUrl: string
  grossMsat: number
  h: string
  secret?: string
  netMsat?: number
  mintPubkey?: string
  payCallback?: string
  withdrawLink?: string
  quote?: InvoiceResult
  noteCallback?: string
  refundPr?: string
  refundPaymentHash?: string
  meltVerify?: string
  paymentPreimageValidated?: true
  receiptSignatureValidated?: true
  refundSettled?: true
  completedAt?: string
}

export type LiveBoundMintCheckOptions = {
  payUrl: string
  grossMsat: number
  statePath: string
  payInvoice: (pr: string) => Promise<void>
  createRefundInvoice: () => Promise<string>
  timeoutMs?: number
  pollMs?: number
  log?: (message: string) => void
}

export type LiveBoundMintCheckResult = {
  stage: 'retired'
  payUrl: string
  grossMsat: number
  netMsat: number
  h: string
  mintPubkey: string
  paymentPreimageValidated: true
  receiptSignatureValidated: true
  refundSettled: true
  completedAt: string
}

const stages = new Set<LiveCheckStage>(['prepared', 'quoted', 'settled', 'claimed', 'retiring', 'retired'])

const errno = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined

const serialise = (state: LiveCheckState): string => `${JSON.stringify(state, null, 2)}\n`

const writeNewState = async (path: string, state: LiveCheckState): Promise<void> => {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(serialise(state), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const assertSecureStateFile = async (path: string): Promise<void> => {
  const stat = await lstat(path)
  if (!stat.isFile()) throw new Error(`Live-check state is not a regular file: ${path}`)
  if (typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) throw new Error(`Live-check state is not owned by this user: ${path}`)
    if ((stat.mode & 0o077) !== 0) throw new Error(`Live-check state must have mode 0600: ${path}`)
  }
}

const replaceState = async (path: string, state: LiveCheckState): Promise<void> => {
  await assertSecureStateFile(path)
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeNewState(temporary, state)
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

const validateState = (value: unknown): LiveCheckState => {
  if (!value || typeof value !== 'object') throw new Error('Live-check state is not an object.')
  const state = value as Partial<LiveCheckState>
  if (state.version !== 1 || !state.stage || !stages.has(state.stage)) throw new Error('Unsupported live-check state.')
  if (
    typeof state.payUrl !== 'string' ||
    typeof state.grossMsat !== 'number' ||
    !Number.isSafeInteger(state.grossMsat) ||
    state.grossMsat <= 0 ||
    typeof state.h !== 'string' ||
    !/^[0-9a-f]{64}$/.test(state.h)
  ) {
    throw new Error('Live-check state is incomplete.')
  }
  if (state.stage !== 'retired') {
    if (typeof state.secret !== 'string' || !isPreimage(state.secret) || hashK1(state.secret) !== state.h) {
      throw new Error('Live-check state does not contain the secret committed by h.')
    }
  }
  return state as LiveCheckState
}

export const readLiveCheckState = async (path: string): Promise<LiveCheckState> => {
  await assertSecureStateFile(path)
  return validateState(JSON.parse(await readFile(path, 'utf8')))
}

const loadOrCreateState = async (options: LiveBoundMintCheckOptions): Promise<LiveCheckState> => {
  let state: LiveCheckState
  try {
    state = await readLiveCheckState(options.statePath)
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error
    const secret = randomBytes(32).toString('hex')
    state = {
      version: 1,
      stage: 'prepared',
      payUrl: options.payUrl,
      grossMsat: options.grossMsat,
      secret,
      h: hashK1(secret)
    }
    try {
      // This fsync completes before a quote exists. A crash from here on
      // can lose an index or an unpaid invoice, never the bearer secret.
      await writeNewState(options.statePath, state)
    } catch (writeError) {
      if (errno(writeError) !== 'EEXIST') throw writeError
      state = await readLiveCheckState(options.statePath)
    }
  }
  if (state.payUrl !== options.payUrl || state.grossMsat !== options.grossMsat) {
    throw new Error('Existing live-check state belongs to a different mint or amount.')
  }
  return state
}

const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

// `lncli` has emitted JSON in some versions and a display table in others.
// The release check only needs an invoice from the refund command; it does
// not treat either presentation as an API contract.
export const extractBolt11 = (output: string): string | null => {
  const trimmed = output.trim()
  if (isBolt11Invoice(trimmed)) return trimmed
  try {
    for (const candidate of stringsIn(JSON.parse(trimmed))) {
      if (isBolt11Invoice(candidate)) return candidate.trim()
    }
  } catch {
    // Human-readable output is handled below.
  }
  for (const match of output.matchAll(/ln(?:bc|tb|bcrt|tbs|sb)[0-9]*[munp]?1[a-z0-9]+/gi)) {
    if (isBolt11Invoice(match[0])) return match[0].trim()
  }
  return null
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const waitForSettled = async (verifyUrl: string, timeoutMs: number, pollMs: number): Promise<VerifyResult> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      const verification = await fetchInvoiceVerification(verifyUrl)
      if (verification.settled) return verification
    } catch (error) {
      lastError = error
    }
    await sleep(pollMs)
  }
  const detail = lastError instanceof Error ? ` Last response: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for settlement.${detail}`)
}

const existingVerification = async (verifyUrl: string): Promise<VerifyResult | null> => {
  try {
    return await fetchInvoiceVerification(verifyUrl)
  } catch {
    return null
  }
}

const requireQuotedState = (
  state: LiveCheckState
): Required<Pick<LiveCheckState, 'secret' | 'netMsat' | 'mintPubkey' | 'payCallback' | 'withdrawLink' | 'quote'>> => {
  if (
    !state.secret ||
    state.netMsat === undefined ||
    !state.mintPubkey ||
    !state.payCallback ||
    !state.withdrawLink ||
    !state.quote?.verify
  ) {
    throw new Error('Quoted live-check state is incomplete.')
  }
  const commitment = requireBoundMintQuote(state.quote, state.h, state.netMsat)
  if (commitment.signature !== undefined) throw new Error('The pre-payment commitment unexpectedly carries a signature.')
  return {
    secret: state.secret,
    netMsat: state.netMsat,
    mintPubkey: state.mintPubkey,
    payCallback: state.payCallback,
    withdrawLink: state.withdrawLink,
    quote: state.quote
  }
}

const retiredResult = (state: LiveCheckState): LiveBoundMintCheckResult => {
  if (
    state.stage !== 'retired' ||
    state.netMsat === undefined ||
    !state.mintPubkey ||
    !state.completedAt ||
    state.paymentPreimageValidated !== true ||
    state.receiptSignatureValidated !== true ||
    state.refundSettled !== true
  ) {
    throw new Error('Retired live-check state is incomplete.')
  }
  return {
    stage: 'retired',
    payUrl: state.payUrl,
    grossMsat: state.grossMsat,
    netMsat: state.netMsat,
    h: state.h,
    mintPubkey: state.mintPubkey,
    paymentPreimageValidated: true,
    receiptSignatureValidated: true,
    refundSettled: true,
    completedAt: state.completedAt
  }
}

export const runLiveBoundMintCheck = async (options: LiveBoundMintCheckOptions): Promise<LiveBoundMintCheckResult> => {
  if (!Number.isSafeInteger(options.grossMsat) || options.grossMsat <= 0) throw new Error('grossMsat must be a positive integer.')
  new URL(options.payUrl)
  const timeoutMs = options.timeoutMs ?? 60_000
  const pollMs = options.pollMs ?? 500
  const log = options.log ?? (() => {})
  let state = await loadOrCreateState(options)
  if (state.stage === 'retired') return retiredResult(state)

  if (state.stage === 'prepared') {
    const pay = await fetchPayRequest(state.payUrl)
    if (!pay.mintToHash || !pay.mintPubkey || !pay.withdrawLink) {
      throw new Error('Mint does not advertise the bound-mint receipt capabilities required by this check.')
    }
    if (state.grossMsat < pay.minSendable || state.grossMsat > pay.maxSendable) {
      throw new Error(`Test amount is outside the mint range ${pay.minSendable}-${pay.maxSendable} msat.`)
    }
    const quote = await requestInvoice(pay.callback, state.grossMsat, {h: state.h})
    if (!quote.verify || !quote.mint) throw new Error('Mint did not bind this quote to h and a verification URL.')
    const netMsat = quote.mint.amountMsat
    if (!Number.isSafeInteger(netMsat) || netMsat <= 0) throw new Error('Mint committed an invalid net note amount.')
    const feeAccepted = pay.mintFee
      ? withinMintFeeBand(state.grossMsat, netMsat, pay.mintFee)
      : netMsat === state.grossMsat
    if (!feeAccepted) throw new Error('Mint committed a net amount outside its advertised fee band.')
    const commitment = requireBoundMintQuote(quote, state.h, netMsat)
    if (commitment.signature !== undefined) throw new Error('The pre-payment commitment unexpectedly carries a signature.')
    state = {
      ...state,
      stage: 'quoted',
      netMsat,
      mintPubkey: pay.mintPubkey,
      payCallback: pay.callback,
      withdrawLink: pay.withdrawLink,
      quote
    }
    await replaceState(options.statePath, state)
    log(`quote committed ${netMsat} msat at the staged note hash`)
  }

  const quoted = requireQuotedState(state)
  if (state.stage === 'quoted') {
    let verification = await fetchInvoiceVerification(quoted.quote.verify!)
    if (!verification.settled) {
      let payerError: unknown
      try {
        // Stdout is deliberately outside this interface. Exit status says
        // whether the command believes it paid; /verify supplies the proof.
        await options.payInvoice(quoted.quote.pr)
      } catch (error) {
        payerError = error
      }
      try {
        verification = await waitForSettled(quoted.quote.verify!, timeoutMs, pollMs)
      } catch (error) {
        if (payerError instanceof Error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)} Payer command: ${payerError.message}`)
        }
        throw error
      }
    }
    const receipt = validateBoundMintReceipt(
      quoted.quote,
      verification,
      state.h,
      quoted.netMsat,
      quoted.mintPubkey
    )
    const paymentHash = decodeBolt11(quoted.quote.pr).paymentHashHex
    if (!verification.preimage || hashK1(verification.preimage) !== paymentHash) {
      throw new Error('The settlement preimage does not prove the quoted invoice.')
    }
    if (!receipt.signature) throw new Error('The settled receipt has no signature.')
    state = {...state, stage: 'settled'}
    await replaceState(options.statePath, state)
    log('settlement preimage and bound receipt signature validated')
  }

  if (state.stage === 'settled') {
    const claim = await claimMintedNote(quoted.withdrawLink, quoted.secret)
    if (claim.state !== 'minted' || claim.amountMsat !== quoted.netMsat || !claim.callback) {
      throw new Error('The staged secret did not claim the committed note.')
    }
    state = {...state, stage: 'claimed', noteCallback: claim.callback}
    await replaceState(options.statePath, state)
    log('the staged secret claimed the committed note')
  }

  if (state.stage === 'claimed') {
    if (!state.noteCallback) throw new Error('Claimed live-check state has no note callback.')
    const refundOutput = await options.createRefundInvoice()
    const refundPr = extractBolt11(refundOutput)
    if (!refundPr) throw new Error('Refund command did not emit a BOLT11 invoice.')
    if (decodeBolt11AmountMsat(refundPr) !== null) {
      throw new Error('Refund invoice must be amountless so the mint retires the entire test note.')
    }
    const refundPaymentHash = decodeBolt11(refundPr).paymentHashHex
    const meltVerify = new URL(`/verify/${refundPaymentHash}`, quoted.withdrawLink).toString()
    // Persist the exact refund invoice before asking the mint to pay it.
    // A crash after the callback can therefore resume without inventing a
    // second payment target or losing the note secret.
    state = {...state, stage: 'retiring', refundPr, refundPaymentHash, meltVerify}
    await replaceState(options.statePath, state)
  }

  if (state.stage === 'retiring') {
    if (!state.noteCallback || !state.refundPr || !state.meltVerify) {
      throw new Error('Retiring live-check state is incomplete.')
    }
    let verification = await existingVerification(state.meltVerify)
    if (verification === null) {
      try {
        const result = await meltNote(state.noteCallback, quoted.secret, state.refundPr)
        if (result.verify && result.verify !== state.meltVerify) {
          throw new Error('Mint returned a different verification URL for the refund melt.')
        }
      } catch (error) {
        if (!(error instanceof PendingNoteError) && !(error instanceof NoteSpentError)) throw error
      }
      verification = await existingVerification(state.meltVerify)
    }
    if (!verification?.settled) {
      try {
        verification = await waitForSettled(state.meltVerify, timeoutMs, pollMs)
      } catch (error) {
        // A cleanly failed melt restores the note. Clear the used refund
        // invoice but retain the secret, so the same command can retry with
        // a fresh amountless invoice rather than stranding value.
        const claim = await claimMintedNote(quoted.withdrawLink, quoted.secret).catch(() => null)
        if (claim?.state === 'minted' && claim.callback) {
          state = {
            version: 1,
            stage: 'claimed',
            payUrl: state.payUrl,
            grossMsat: state.grossMsat,
            h: state.h,
            secret: quoted.secret,
            netMsat: quoted.netMsat,
            mintPubkey: quoted.mintPubkey,
            payCallback: quoted.payCallback,
            withdrawLink: quoted.withdrawLink,
            quote: quoted.quote,
            noteCallback: claim.callback
          }
          await replaceState(options.statePath, state)
          throw new Error(`Refund melt failed cleanly and the note was restored; rerun to use a fresh invoice. ${error instanceof Error ? error.message : ''}`)
        }
        throw error
      }
    }
    const noteUrl = buildNoteUrl(quoted.withdrawLink, quoted.secret, quoted.netMsat)
    const deadline = Date.now() + timeoutMs
    while ((await probeBurnedNote(noteUrl)) !== 'gone') {
      if (Date.now() > deadline) throw new Error('Refund settled but the test note is not yet recorded as burned.')
      await sleep(pollMs)
    }
    const completedAt = new Date().toISOString()
    state = {
      version: 1,
      stage: 'retired',
      payUrl: state.payUrl,
      grossMsat: state.grossMsat,
      netMsat: quoted.netMsat,
      h: state.h,
      mintPubkey: quoted.mintPubkey,
      paymentPreimageValidated: true,
      receiptSignatureValidated: true,
      refundSettled: true,
      completedAt
    }
    await replaceState(options.statePath, state)
    log('refund settled and the test note was burned; bearer secret scrubbed from state')
  }

  return retiredResult(state)
}
