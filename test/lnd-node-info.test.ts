import {afterEach, describe, expect, it} from 'vitest'
import {createLndBackend} from '../src/backends/lnd.ts'

// What the mint may say about its own node.
//
// `nodeCapacity` goes out in the discovery document, which is public and
// also gets announced. So it has to be the figure the rest of the network
// already holds - this node's entry in the public graph - and not the sum
// of `/v1/channels`, which is an authenticated view that counts private
// channels. Publishing that would tell every visitor the size of channels
// the operator deliberately did not announce.

const PUBKEY = '02' + 'ab'.repeat(32)

type Handler = (path: string) => {status: number; body: unknown}

const withLnd = (handler: Handler) => {
  const asked: string[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const path = new URL(String(input)).pathname
    asked.push(path)
    const {status, body} = handler(path)
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'}
    })
  }) as typeof fetch
  restore = () => {
    globalThis.fetch = real
  }
  return {asked, backend: createLndBackend({url: 'https://lnd.test', macaroon: 'ff'})}
}

let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

const getinfo = {
  identity_pubkey: PUBKEY,
  alias: 'moneyer',
  color: '#c9ced8',
  num_active_channels: 2,
  num_peers: 4,
  uris: [`${PUBKEY}@2.29.14.244:9735`]
}

describe('lnd nodeInfo capacity', () => {
  it('reports the announced capacity, in msat, without reading the channel list', async () => {
    const {asked, backend} = withLnd(path => {
      if (path === '/v1/getinfo') return {status: 200, body: getinfo}
      // grpc-gateway renders int64 as a string, and lnd counts this one in
      // sats while every amount in this codebase is msat.
      if (path === `/v1/graph/node/${PUBKEY}`) return {status: 200, body: {total_capacity: '500000'}}
      if (path === '/v1/balance/channels') return {status: 200, body: {local_balance: {msat: '252253369'}}}
      return {status: 404, body: {}}
    })

    const info = await backend.nodeInfo!()

    expect(info.capacityMsat).toBe(500_000_000)
    expect(info.localBalanceMsat).toBe(252_253_369)
    // The private view is never consulted, which is the whole point.
    expect(asked).not.toContain('/v1/channels')
  })

  it('calls a node with nothing announced zero, not unknown', async () => {
    // lnd answers its own graph lookup with NOT_FOUND when none of its
    // channels are public. Zero is the true public capacity there; leaving
    // the field off would say "this mint does not report capacity", which
    // is a different and less honest claim.
    const {backend} = withLnd(path =>
      path === '/v1/getinfo' ? {status: 200, body: getinfo} : {status: 404, body: {error: 'unable to find node'}}
    )

    expect((await backend.nodeInfo!()).capacityMsat).toBe(0)
  })

  it('leaves capacity off when the node cannot answer', async () => {
    // A macaroon without info:read, or a node mid-restart. Unknown is not
    // zero, and the discovery endpoint is fine without the field.
    const {backend} = withLnd(path =>
      path === '/v1/getinfo' ? {status: 200, body: getinfo} : {status: 500, body: {error: 'permission denied'}}
    )

    const info = await backend.nodeInfo!()
    expect(info.capacityMsat).toBeUndefined()
    expect(info.alias).toBe('moneyer')
  })
})

describe('lnd nodeInfo addresses', () => {
  it('publishes every announced address, with uri still the first', async () => {
    // A node behind Tor as well as clearnet announces both. `nodeUri`
    // alone only ever carried the first, so a peer that can reach only the
    // other one was told about a door it cannot open.
    const onion = `${PUBKEY}@abcdefghijklmnop.onion:9735`
    const clearnet = `${PUBKEY}@2.29.14.244:9735`
    const {backend} = withLnd(path =>
      path === '/v1/getinfo'
        ? {status: 200, body: {...getinfo, uris: [clearnet, onion]}}
        : {status: 404, body: {}}
    )

    const info = await backend.nodeInfo!()

    expect(info.uri).toBe(clearnet)
    expect(info.uris).toEqual([clearnet, onion])
  })

  it('has no address list for a node that announces nothing', async () => {
    // The bare pubkey still stands in as `uri`, the way it always has, but
    // an empty list would claim the node announced something.
    const {backend} = withLnd(path =>
      path === '/v1/getinfo' ? {status: 200, body: {...getinfo, uris: []}} : {status: 404, body: {}}
    )

    const info = await backend.nodeInfo!()

    expect(info.uri).toBe(PUBKEY)
    expect(info.uris).toBeUndefined()
  })
})
