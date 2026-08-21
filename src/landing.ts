import type {MoneyerConfig} from './config.ts'
import type {NodeInfo} from './backends/types.ts'
import type {MintStats} from './stats.ts'
import {applyMintFee} from 'lnurlcash-kit'

// The mint's face: one self-contained page at GET /, no build step, no
// external assets. It states what a visitor needs before trusting a mint
// with sats: who it is, what it charges, the key its notes verify
// against, and how to pay it. Anything fancier belongs to the product
// site, not the money service.

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

export const landingPage = (args: {
  config: MoneyerConfig
  host: string
  mintPubkey: string | null
  nodeInfo: NodeInfo
  // Null when the operator has switched /stats off.
  stats?: MintStats | null
}): string => {
  const {config, host, mintPubkey, nodeInfo} = args
  const stats = args.stats ?? null
  const address = `${config.username}@${host}`
  const fee = config.mintFee
  const feeLine = fee
    ? `${fee.baseFeeMsat > 0 ? `${fee.baseFeeMsat} msat flat` : ''}${fee.baseFeeMsat > 0 && fee.feePpm > 0 ? ' + ' : ''}${fee.feePpm > 0 ? `${fee.feePpm / 10_000}%` : ''}`
    : 'none'
  const maxNet = fee ? applyMintFee(config.maxSendableMsat, fee) : config.maxSendableMsat
  const sats = (msat: number) => `${(msat / 1000).toLocaleString('en-GB')} sat`
  const title = config.name ?? nodeInfo.alias ?? 'moneyer'
  // Contacts are shown as text, not links: a mailto or an npub someone
  // else chose is not something this page should hand a click to. The
  // terms are a link because a URL the operator set is the point of it.
  // "coverage 1.92x (outstanding 48,120 sat, node 92,400 sat)", or the
  // ratio alone in ratio-only mode. A mint with nothing outstanding has
  // no ratio to state, so it says so in words instead.
  const coverageLine = ((): string | null => {
    if (!stats) return null
    if (stats.coverage !== undefined) {
      const ratio = `${stats.coverage.toFixed(2)}\u00d7`
      return stats.outstandingMsat === undefined || stats.localBalanceMsat === undefined
        ? ratio
        : `${ratio} (outstanding ${sats(stats.outstandingMsat)}, node ${sats(stats.localBalanceMsat)})`
    }
    if (stats.outstandingMsat === 0) return 'nothing outstanding'
    return stats.outstandingMsat === undefined ? null : `outstanding ${sats(stats.outstandingMsat)}`
  })()

  const contacts = [
    config.contact?.email ? {label: 'email', value: config.contact.email} : null,
    config.contact?.nostr ? {label: 'nostr', value: config.contact.nostr} : null,
    config.contact?.url ? {label: 'contact', value: config.contact.url} : null
  ].filter(entry => entry !== null)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} - an LNURLcash mint</title>
<meta name="description" content="A moneyer strikes Lightning bearer notes. Pay ${escapeHtml(address)} and the invoice's preimage becomes your note."/>
<style>
:root{--bg:#0e0f12;--raise:#16181d;--line:rgba(226,233,242,.09);--ink:#eef1f6;--dim:#98a0ac;--accent:#c9ced8;--accent-deep:#8f97a4}
@media(prefers-color-scheme:light){:root{--bg:#f3f4f6;--raise:#fff;--line:rgba(30,38,50,.12);--ink:#1c2027;--dim:#6b7380;--accent:#6f7784;--accent-deep:#4d545f}}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh;display:grid;place-items:center;padding:28px;
background-image:radial-gradient(900px 420px at 50% -160px,rgba(201,206,216,.13),transparent 70%)}
main{max-width:560px;width:100%;display:flex;flex-direction:column;gap:18px;animation:rise .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}}
.mark{width:64px;height:64px;color:var(--accent);animation:glow 3.2s ease-in-out infinite}
@keyframes glow{50%{filter:drop-shadow(0 0 14px rgba(201,206,216,.5))}}
h1{font-size:clamp(30px,7vw,40px);letter-spacing:-.5px}
h1 small{display:block;font-size:16px;color:var(--dim);font-weight:500;margin-top:8px;line-height:1.5}
.addr{display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--accent),var(--accent-deep));color:#14161b;border-radius:20px;padding:20px 22px;font-weight:750;font-size:clamp(17px,4.6vw,22px);word-break:break-all;box-shadow:0 14px 38px -14px rgba(160,170,185,.5)}
.addr svg{width:26px;height:26px;flex:none}
.card{background:var(--raise);border:1px solid var(--line);border-radius:20px;padding:20px 22px;display:flex;flex-direction:column;gap:12px}
.kv{display:flex;justify-content:space-between;gap:16px;font-size:15px}
.kv span{color:var(--dim)}
.kv code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all;text-align:right}
p.small{color:var(--dim);font-size:13.5px;line-height:1.65;text-align:center}
.motd{background:var(--raise);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:14px;padding:14px 18px;font-size:14.5px;line-height:1.6}
.motd b{display:block;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim);margin-bottom:4px}
a{color:var(--accent)}
</style>
</head>
<body>
<main>
<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.6v8.8"/><path d="M15.4 9.4c-.7-1.1-1.9-1.8-3.4-1.8-2 0-3.6 1.1-3.6 2.7 0 3.4 7.2 1.8 7.2 5 0 1.6-1.6 2.7-3.6 2.7-1.5 0-2.7-.7-3.4-1.8"/></svg>
<h1>${escapeHtml(title)}<small>An LNURLcash mint. Pay the address below and the invoice's payment preimage <em>is</em> your bearer note - money as a secret you hold.</small></h1>
${config.motd ? `<div class="motd"><b>notice</b>${escapeHtml(config.motd)}</div>` : ''}
<div class="addr"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 18 10.5h-6.5L13 2z"/></svg>${escapeHtml(address)}</div>
<div class="card">
<div class="kv"><span>mints</span><b>${sats(config.minSendableMsat)} to ${sats(config.maxSendableMsat)}</b></div>
<div class="kv"><span>mint fee</span><b>${escapeHtml(feeLine)}</b></div>
<div class="kv"><span>largest note</span><b>${sats(maxNet)}</b></div>
${mintPubkey ? `<div class="kv"><span>notes signed by</span><code>${escapeHtml(mintPubkey)}</code></div>` : '<div class="kv"><span>note signatures</span><b>not offered</b></div>'}
${nodeInfo.uri ? `<div class="kv"><span>node</span><code>${escapeHtml(nodeInfo.uri)}</code></div>` : ''}
${coverageLine ? `<div class="kv"><span>coverage</span><b>${escapeHtml(coverageLine)}</b></div>` : ''}
${config.sunset ? '<div class="kv"><span>status</span><b>sunsetting - redeem only</b></div>' : ''}
${contacts.map(entry => `<div class="kv"><span>${entry.label}</span><code>${escapeHtml(entry.value)}</code></div>`).join('\n')}
${config.tosUrl ? `<div class="kv"><span>terms</span><a href="${escapeHtml(config.tosUrl)}" rel="noopener noreferrer">${escapeHtml(config.tosUrl)}</a></div>` : ''}
</div>
<p class="small">Works with any LUD-25 wallet - <a href="https://github.com/forgesworn/notecase">notecase</a> among them. Verify a note offline against the signing key above.<br/>Independent implementation of the <a href="https://github.com/lnurl/luds/pull/301">LNURLcash draft</a> - graded by <a href="https://github.com/TheCryptoDonkey/lnurlcash-conformance">lnurlcash-conformance</a>.</p>
</main>
</body>
</html>`
}
