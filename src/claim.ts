import {
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  buildNoteUrl,
  fetchNoteInfo,
  isPreimage
} from '@lnurlcash/kit'

/** Result of checking the wallet-chosen secret behind a bound mint quote. */
export type MintClaim = {
  state: 'minted' | 'unminted' | 'pending' | 'spent'
  k1: string
  amountMsat: number | null
  callback: string | null
}

/**
 * Inspect the note a wallet named before requesting its invoice.
 *
 * This is Moneyer's operational orchestration, not a wire primitive: it
 * classifies the read-only lookup so the live check can poll an unpaid quote
 * without mistaking an unreachable mint for an unminted note.
 */
export const claimMintedNote = async (withdrawLink: string, k1: string): Promise<MintClaim> => {
  const secret = k1.trim().toLowerCase()
  if (!isPreimage(secret)) throw new Error('A note secret must be 32 bytes of hex - nothing was sent.')
  const blank = {k1: secret, amountMsat: null, callback: null}
  try {
    const info = await fetchNoteInfo(buildNoteUrl(withdrawLink, secret))
    return {
      state: 'minted',
      k1: secret,
      amountMsat: info.maxWithdrawable,
      callback: info.callback
    }
  } catch (error) {
    if (error instanceof PendingNoteError) return {...blank, state: 'pending'}
    if (error instanceof NoteSpentError) return {...blank, state: 'spent'}
    if (error instanceof NoteUnknownError) return {...blank, state: 'unminted'}
    throw error
  }
}
