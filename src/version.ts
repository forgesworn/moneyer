import {readFileSync} from 'node:fs'

// The running version, for the discovery endpoint and the operator CLI.
// Read from package.json rather than baked in by a build step: a mint that
// says it is on a version it is not is worse than one that says nothing.
// dist/ sits one level under the package root, and so does src/ when
// running the sources directly, so the relative path is the same either
// way. Unreadable means the field is simply absent.
export const packageVersion = ((): string | undefined => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const version = (JSON.parse(raw) as {version?: unknown}).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
})()
