import {request} from 'node:http'

// happy-dom's fetch physically sends every request TWICE (probed: two
// server hits per fetch(), the caller handed the SECOND response's body).
// For a bearer-note protocol that is fatal in a way no retry is: the first
// request rotates the note, the second reads "already spent", and a claim
// that landed reports failure. Real browsers do not do this - it is purely
// a test-environment artefact - so DOM tests that drive protocol calls
// install this node:http-backed fetch instead.
export const installNodeFetch = (): void => {
  const nodeFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const req = request(url, {method: init?.method ?? 'GET'}, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk as Buffer))
        res.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[name] = value
          }
          resolve(new Response(Buffer.concat(chunks).toString('utf8'), {status: res.statusCode ?? 500, headers}))
        })
      })
      req.on('error', reject)
      if (typeof init?.body === 'string') req.write(init.body)
      req.end()
    })
  globalThis.fetch = nodeFetch as typeof fetch
}
