// The mint fee as a person reads it, in one place so the payRequest
// metadata, the landing page and the mint's own site cannot drift apart
// on it - the same reason `privacy.ts` exists.
//
// The raw pair is spelled out deliberately. The machine-readable line
// beside it in the payRequest metadata is "Mint fees: 5000,1000" - the
// shape lnurlcash-kit parses, anchored and digits-only, so it cannot
// carry its own units - and a reader who has not parsed LUD-25 reads
// both numbers as satoshis. A tester who thinks the fee is 5000 sats on
// a 10k sat mint has been told something alarming and false, so the
// prose says msat and ppm where the wire cannot.

export type MintFeeLike = {baseFeeMsat: number; feePpm: number}

// "5 sat + 0.1% (5000 msat + 1000 ppm), rounded up to the sat", or
// "none". Bare, for a page that supplies its own "mint fee" label.
export const feeInUnits = (fee: MintFeeLike | null, roundedToSat: boolean): string => {
  if (!fee) return 'none'
  const shown: string[] = []
  const raw: string[] = []
  if (fee.baseFeeMsat > 0) {
    shown.push(`${fee.baseFeeMsat % 1000 === 0 ? fee.baseFeeMsat / 1000 : (fee.baseFeeMsat / 1000).toFixed(3)} sat`)
    raw.push(`${fee.baseFeeMsat} msat`)
  }
  if (fee.feePpm > 0) {
    shown.push(`${fee.feePpm / 10_000}%`)
    raw.push(`${fee.feePpm} ppm`)
  }
  if (!shown.length) return 'none'
  const body = `${shown.join(' + ')} (${raw.join(' + ')})`
  return roundedToSat ? `${body}, rounded up to the sat` : body
}

// The same fee prefixed for prose: "fee 5 sat + 0.1% (5000 msat + 1000
// ppm)" - what a payer sees inside their wallet's description.
export const describeFee = (fee: MintFeeLike, roundedToSat: boolean): string => {
  const words = feeInUnits(fee, roundedToSat)
  return words === 'none' ? 'no fee' : `fee ${words}`
}
