// Stands in for scripts/kernel-verifier.py in tests: same line protocol,
// no Bitcoin Core. It accepts a spend unless told otherwise.
//   domain "refuse.example"  -> a verdict refusing the spend
//   FAKE_KERNEL=crash        -> exits on the first request
//   FAKE_KERNEL=error        -> answers every request with an error
//   FAKE_KERNEL=silent       -> never answers
import {createInterface} from 'node:readline'

const mode = process.env.FAKE_KERNEL ?? ''
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line)
  if (mode === 'crash') process.exit(3)
  if (mode === 'silent') return
  const reply =
    mode === 'error'
      ? {id: request.id, error: 'KernelError'}
      : request.domain === 'refuse.example'
        ? {id: request.id, reason: 'bitcoin core rejected the spend'}
        : {id: request.id, ok: true}
  process.stdout.write(`${JSON.stringify(reply)}\n`)
})
