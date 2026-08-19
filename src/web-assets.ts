import {readFileSync, readdirSync} from 'node:fs'
import {extname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

// The mint's website, built by vite into web/dist and loaded whole into
// memory at startup. Serving from a Map keyed by exact URL path means no
// filesystem access per request and no path to traverse. A missing dist is
// fine - the server falls back to the self-contained landing page - so an
// npm install without the web build still has a face.

export type WebAsset = {body: Buffer; type: string; immutable: boolean}

export type WebAssets = {
  // index.html with this token replaced by the mint's runtime config
  indexHtml: string
  get(path: string): WebAsset | undefined
}

export const CONFIG_TOKEN = '<!--#mint-config-->'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

export const defaultWebDist = (): string => fileURLToPath(new URL('../web/dist', import.meta.url))

export const loadWebAssets = (dir: string = defaultWebDist()): WebAssets | null => {
  const files = new Map<string, WebAsset>()
  let indexHtml: string | null = null

  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        walk(join(current, entry.name), path)
        continue
      }
      if (!entry.isFile()) continue
      const body = readFileSync(join(current, entry.name))
      const type = TYPES[extname(entry.name).toLowerCase()] ?? 'application/octet-stream'
      // vite content-hashes everything under /assets/, so those never change
      // in place; everything else revalidates.
      files.set(path, {body, type, immutable: path.startsWith('/assets/')})
      if (path === '/index.html') indexHtml = body.toString('utf8')
    }
  }

  try {
    walk(dir, '')
  } catch {
    return null
  }
  if (indexHtml === null) return null
  return {indexHtml, get: path => files.get(path)}
}
