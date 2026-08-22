import {defineConfig} from 'vitest/config'

// These are integration tests: nearly every one starts an HTTP server, opens
// a SQLite database and drives real secp256k1 and PBKDF2 work over the wire.
// vitest's 5s default is the budget for a unit test, and on a loaded machine
// - several suites at once, or a laptop doing anything else - the slower
// cases here cross it while passing perfectly well. That turns the pre-push
// gate into a coin flip, and a gate that fails at random teaches people to
// reach for --no-verify, which is worse than no gate.
//
// 30s is a real ceiling rather than a shrug: it is long enough that load
// never explains a failure, and short enough that a genuinely wedged test
// still fails the run rather than hanging it.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
