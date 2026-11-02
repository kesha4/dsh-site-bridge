/**
 * Renders the storefront screenshots into assets/screenshots/.
 *
 * Everything is generated from the extension itself: the popup is the real
 * popup.html with a stubbed chrome.* API, and the bundle view is a rendering of
 * the files `site_capture` writes. No private data — the fixtures are neutral.
 *
 * Run: node tools/make-screenshots.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'assets', 'screenshots')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = Number(process.env.SHOT_PORT ?? 9385)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const locale = JSON.parse(await readFile(join(root, 'extension', '_locales', 'en', 'messages.json'), 'utf8'))
const messages = Object.fromEntries(Object.entries(locale).map(([key, value]) => [key, value.message]))

const POPUP_STATES = {
  'popup-main': {
    ok: true, configured: true, connected: true, port: 47321, recording: false, captured: 0,
    activeTabId: 1,
    target: { id: 1, title: 'Example Store — Products', url: 'https://shop.example/products' },
    targets: [
      { id: 1, title: 'Example Store — Products', url: 'https://shop.example/products', recording: true, captured: 4 }
    ]
  },
  'popup-recording': {
    ok: true, configured: true, connected: true, port: 47321, recording: true, captured: 12,
    activeTabId: 1,
    target: { id: 1, title: 'Example Store — Products', url: 'https://shop.example/products' },
    targets: [
      { id: 1, title: 'Example Store — Products', url: 'https://shop.example/products', recording: true, captured: 12 },
      { id: 2, title: 'Example Store — Cart', url: 'https://shop.example/cart', recording: false, captured: 0 }
    ]
  }
}

const BUNDLE_HTML = `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:28px; background:#14161b; color:#e8eaf0;
         font:13px/1.5 "Segoe UI", system-ui, sans-serif; }
  h1 { margin:0 0 4px; font-size:16px; font-weight:600; }
  .path { color:#99a1ae; font-size:12px; margin-bottom:20px; }
  .cols { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
  .card { background:#1b1e25; border:1px solid #2a2f3a; border-radius:12px; padding:14px 16px; }
  h2 { margin:0 0 10px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#99a1ae; }
  pre { margin:0; white-space:pre-wrap; font:12px/1.55 "Cascadia Mono", Consolas, monospace; color:#c9d3e6; }
  .accent { color:#7e98ff; }
  .ok { color:#35c88f; }
  .muted { color:#8b93a1; }
</style>
<h1>Snapshot bundle</h1>
<div class="path">captures/shop.example/20261102-101500</div>
<div class="cols">
  <div class="card">
    <h2>api.md</h2>
<pre><span class="accent">## POST /api/cart/items</span>
- calls: <span class="ok">3</span>
- status: 200
- resource: fetch
- mime: application/json

Request headers: <span class="muted">content-type, x-csrf-token</span>

Request body:
{
  "sku": "A1",
  "qty": 1
}

Response fields: <span class="muted">id, items[].sku, items[].qty, total</span>

Response body:
{
  "id": 42,
  "items": [{ "sku": "A1", "qty": 1 }],
  "total": 1990
}</pre>
  </div>
  <div class="card">
    <h2>selectors.md</h2>
<pre><span class="muted">| # | tag | role | best selector | matches |</span>
<span class="muted">|---|-----|------|---------------|---------|</span>
| 0 | button | button | <span class="accent">[data-testid="buy"]</span>   | unique |
| 1 | input  | textbox | <span class="accent">input[name="q"]</span>       | unique |
| 2 | select | combobox | <span class="accent">#sort-order</span>              | unique |
| 3 | a      | link   | <span class="accent">[aria-label="Cart"]</span>        | unique |
| 4 | div    |        | <span class="muted">div > div:nth-of-type(2)</span> | NOT unique |

<span class="muted">## Notes for the extension author</span>
- Prefer <span class="accent">data-testid</span> / id / name over class chains.
- Every selector was checked against the live DOM
  at capture time.</pre>
  </div>
</div>`

const popupStub = (state) => `
  const MESSAGES = ${JSON.stringify(messages)};
  window.chrome = {
    runtime: { sendMessage: async (m) => (m.type === 'status' ? ${JSON.stringify(state)} : { ok: true }) },
    storage: { local: { get: async () => ({ port: 47321, token: 'example-token-0123456789abcdefgh' }), set: async () => {} } },
    i18n: {
      getUILanguage: () => 'en-US',
      getMessage: (key, subs) => {
        const raw = MESSAGES[key];
        if (!raw) return '';
        const list = Array.isArray(subs) ? subs : (subs === undefined ? [] : [subs]);
        return raw.replace(/\\$(\\w+)\\$/g, (whole, name) => {
          const slot = name.toUpperCase();
          if (slot === 'COUNT' || slot === 'ERROR') return String(list[0] ?? '');
          return whole;
        });
      }
    }
  };
`

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(this.url)
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      message.error ? entry.rej(new Error(message.error.message)) : entry.res(message.result)
    }
  }
  send(method, params = {}, sessionId) {
    const id = this.id++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)) }, 20000)
    })
  }
}

await mkdir(outDir, { recursive: true })
const chrome = spawn(chromePath, [
  `--user-data-dir=${join(root, '.test-out', 'shots-profile')}`,
  `--remote-debugging-port=${port}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--allow-file-access-from-files',
  '--hide-scrollbars',
  'about:blank'
], { stdio: 'ignore' })

try {
  let version = null
  for (let i = 0; i < 60 && !version; i += 1) {
    await sleep(300)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) version = await response.json()
    } catch { /* not up yet */ }
  }
  const cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  await send('Page.enable')
  await send('Runtime.enable')

  for (const [name, state] of Object.entries(POPUP_STATES)) {
    // One fresh target per shot: a reused document keeps the injected stub of
    // the previous state, so both screenshots would come out identical.
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
    const shotSend = (method, params) => cdp.send(method, params, attached.sessionId)
    await shotSend('Page.enable')
    await shotSend('Runtime.enable')
    await shotSend('Emulation.setDeviceMetricsOverride', { width: 340, height: 420, deviceScaleFactor: 2, mobile: false })
    await shotSend('Page.addScriptToEvaluateOnNewDocument', { source: popupStub(state) })
    await shotSend('Page.navigate', { url: `file:///${join(root, 'extension', 'popup.html').replace(/\\/g, '/')}` })
    await sleep(800)
    const probe = await shotSend('Runtime.evaluate', {
      expression: "document.getElementById('captured')?.textContent + ' | ' + document.getElementById('connection-text')?.textContent",
      returnByValue: true
    })
    console.log(`  ${name}: ${probe.result?.value}`)
    const shot = await shotSend('Page.captureScreenshot', { format: 'png' })
    const file = join(outDir, `${name}.png`)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    console.log(`wrote ${file}`)
    await cdp.send('Target.closeTarget', { targetId: created.targetId })
  }

  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 620, deviceScaleFactor: 1.5, mobile: false })
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(BUNDLE_HTML)}` })
  await sleep(500)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(outDir, 'bundle.png')
  await writeFile(file, Buffer.from(shot.data, 'base64'))
  console.log(`wrote ${file}`)
} finally {
  chrome.kill()
  await sleep(300)
}
