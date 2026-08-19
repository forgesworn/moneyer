import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {CONFIG_TOKEN, loadWebAssets} from '../src/web-assets.ts'
import {startMint, type TestMint} from './helpers.ts'

// The website-serving seam: dist loading, config injection, cache headers,
// and the fallback when no build exists. The site's behaviour itself is
// web.test.ts's job.

const fakeDist = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'moneyer-dist-'))
  writeFileSync(join(dir, 'index.html'), `<html><head>${CONFIG_TOKEN}</head><body>site</body></html>`)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("app")')
  writeFileSync(join(dir, 'assets', 'app-abc123.css'), 'body{}')
  return dir
}

let active: TestMint | null = null
afterEach(async () => {
  await active?.moneyer.close()
  active = null
})

describe('loadWebAssets', () => {
  it('returns null when the dist directory does not exist', () => {
    expect(loadWebAssets('/nowhere/at/all')).toBeNull()
  })

  it('returns null when index.html is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moneyer-empty-'))
    writeFileSync(join(dir, 'stray.txt'), 'not a site')
    expect(loadWebAssets(dir)).toBeNull()
  })

  it('loads nested files with content types and immutability by path', () => {
    const assets = loadWebAssets(fakeDist())!
    expect(assets.indexHtml).toContain(CONFIG_TOKEN)
    const js = assets.get('/assets/app-abc123.js')!
    expect(js.type).toContain('text/javascript')
    expect(js.immutable).toBe(true)
    expect(assets.get('/index.html')!.immutable).toBe(false)
    expect(assets.get('/../etc/passwd')).toBeUndefined()
  })
})

describe('serving the website', () => {
  it('injects the runtime config into index.html, token gone', async () => {
    active = await startMint(
      {walletUrl: 'https://wallet.example'},
      {webAssets: loadWebAssets(fakeDist())}
    )
    const page = await (await fetch(`${active.moneyer.url}/`)).text()
    expect(page).not.toContain(CONFIG_TOKEN)
    expect(page).toContain('window.__MINT__=')
    expect(page).toContain('"username":"mint"')
    expect(page).toContain('"walletUrl":"https://wallet.example"')
    expect(page).not.toContain('"sunset"')
  })

  it('flags sunset in the injected config', async () => {
    active = await startMint({sunset: true}, {webAssets: loadWebAssets(fakeDist())})
    const page = await (await fetch(`${active.moneyer.url}/`)).text()
    expect(page).toContain('"sunset":true')
  })

  it('escapes < so a hostile value cannot close the script element', async () => {
    active = await startMint(
      {username: 'x</script><script>alert(1)</script>'},
      {webAssets: loadWebAssets(fakeDist())}
    )
    const page = await (await fetch(`${active.moneyer.url}/`)).text()
    expect(page).not.toContain('</script><script>alert(1)')
    expect(page).toContain('\\u003c/script')
  })

  it('serves hashed assets immutable and everything else revalidating', async () => {
    active = await startMint({}, {webAssets: loadWebAssets(fakeDist())})
    const js = await fetch(`${active.moneyer.url}/assets/app-abc123.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect(js.headers.get('cache-control')).toContain('immutable')
    const missing = await fetch(`${active.moneyer.url}/assets/nothing.js`)
    expect(((await missing.json()) as {status: string}).status).toBe('ERROR')
  })

  it('falls back to the self-contained landing page without a build', async () => {
    active = await startMint({}, {webAssets: null})
    const page = await (await fetch(`${active.moneyer.url}/`)).text()
    expect(page).toContain('LNURLcash mint')
    expect(page).not.toContain('window.__MINT__')
  })
})
