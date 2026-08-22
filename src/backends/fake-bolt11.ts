import {bech32} from '@scure/base'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {hexToBytes, utf8ToBytes, randomBytes} from '@noble/hashes/utils.js'

// A syntactically COMPLETE BOLT-11 invoice that nothing can ever pay.
//
// The conformance mock mint gets away with an HRP and filler because the
// reference wallet only reads the human-readable part. This stack holds
// itself to farrier-kit's full decode - checksum, tagged fields, signature
// layout - so the fake funding source has to emit the real grammar: a
// mainnet HRP with the exact amount, a p field carrying the true payment
// hash, s and 9 so modern parsers see a payment secret and its feature
// bits, d for the memo, and a recoverable signature by a fixed throwaway
// key that no Lightning node has ever announced. Unpayable by
// construction; decodable by anything.

const FAKE_NODE_KEY = hexToBytes('4242424242424242424242424242424242424242424242424242424242424242')

const fiveToEight = (words: number[]): Uint8Array => {
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const word of words) {
    acc = (acc << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff)
  return new Uint8Array(out)
}

const tagged = (type: number, data: number[]): number[] => [
  type,
  data.length >> 5,
  data.length & 31,
  ...data
]

const amountHrp = (msat: number): string => (msat % 100 === 0 ? `${msat / 100}n` : `${msat * 10}p`)

// `amountMsat` omitted builds an invoice that states no amount, which is
// the shape a payee uses when the payer decides what to send.
export const fakeBolt11 = (args: {
  amountMsat?: number
  paymentHashHex: string
  memo?: string
  timestamp?: number
}): string => {
  const hrp = `lnbc${args.amountMsat === undefined ? '' : amountHrp(args.amountMsat)}`
  const words: number[] = []

  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000)
  for (let i = 6; i >= 0; i--) words.push((timestamp / 2 ** (5 * i)) & 31)

  // p - payment hash
  words.push(...tagged(1, Array.from(bech32.toWords(hexToBytes(args.paymentHashHex)))))
  // d - description
  words.push(...tagged(13, Array.from(bech32.toWords(utf8ToBytes(args.memo ?? 'moneyer fake invoice')))))
  // s - payment secret (random; nothing will ever present it)
  words.push(...tagged(16, Array.from(bech32.toWords(randomBytes(32)))))
  // 9 - features: var_onion_optin (bit 9) and payment_secret (bit 15), both
  // optional, as 20 bits of 5-bit words
  words.push(...tagged(5, [1, 0, 16, 0]))

  const signed = sha256(new Uint8Array([...utf8ToBytes(hrp), ...fiveToEight(words)]))
  const lead = secp256k1.sign(signed, FAKE_NODE_KEY, {format: 'recovered', prehash: false})
  const signature = new Uint8Array([...lead.subarray(1), lead[0]!])
  words.push(...Array.from(bech32.toWords(signature)))

  return bech32.encode(hrp, words, false)
}
