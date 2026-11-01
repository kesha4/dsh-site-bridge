/**
 * Live check: drives the *installed* plugin in the *running* DSH.
 *
 * It launches a throwaway Chrome, loads the staged extension through CDP,
 * points it at the real bridge (port + token from bridge.json), opens a page
 * with a working BFF call and claims the tab. It then waits: the actual
 * tool calls (site_status / site_network / site_act / site_capture) are made
 * from the DSH session, so what gets verified is the shipped path, not a
 * reimplementation of it.
 *
 * The token is read from disk and never printed.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const staged = process.env.SITE_BRIDGE_EXT ?? resolve(process.env.USERPROFILE ?? '', '.dsh', 'site-bridge', 'extension')
const credentialsFile = process.env.SITE_BRIDGE_CRED ?? join(process.env.USERPROFILE ?? '', '.dsh', 'site-bridge', 'bridge.json')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const debugPort = Number(process.env.LIVE_DEBUG_PORT ?? 9361)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Live Витрина</title></head>
<body style="font:16px system-ui;padding:24px">
  <h1>Живая витрина</h1>
  <label>Поиск <input id="q" name="q" /></label>
  <button id="buy" data-testid="buy" style="padding:8px 16px">Оформить</button>
  <p id="result">заказа нет</p>
  <div id="pad" style="width:200px;height:100px;background:#eef;display:flex;align-items:center;justify-content:center">
    кликни: <span id="pad-count">0</span>
  </div>
  <script>
    document.cookie = 'sid=live-secret; path=/';
    let pad = 0;
    document.getElementById('pad').addEventListener('mousedown', () => {
      pad += 1; document.getElementById('pad-count').textContent = String(pad);
    });
    document.getElementById('buy').addEventListener('click', async () => {
      const response = await fetch('/api/order', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-live-777' },
        body: JSON.stringify({ sku: 'LIVE-1', qty: 2 })
      });
      const data = await response.json();
      document.getElementById('result').textContent = 'заказ ' + data.id;
    });
  </script>
</body></html>`

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/order') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 777, token: 'live-response-secret', echo: JSON.parse(raw || '{}') }))
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 1
    this.pending = new Map()
  }
  async open() {
    this.ws = new WebSocket(this.url)
    await new Promise((res, rej) => {
      this.ws.onopen = res
      this.ws.onerror = rej
    })
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
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`timeout ${method}`))
      }, 20000)
    })
  }
}

async function waitFor(label, probe, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null)
    if (value) return value
    await sleep(200)
  }
  throw new Error(`timeout: ${label}`)
}

const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'))
const profile = await mkdtemp(join(tmpdir(), 'dsh-live-'))

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const pageUrl = `http://127.0.0.1:${server.address().port}/`

const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--enable-unsafe-extension-debugging',
    '--window-size=1280,900',
    pageUrl
  ],
  { stdio: 'ignore' }
)

let cdp = null
const shutdown = async () => {
  try { chrome.kill() } catch { /* ignore */ }
  try { server.close() } catch { /* ignore */ }
  await sleep(400)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

try {
  const version = await waitFor('chrome devtools', async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    return response.ok ? response.json() : null
  })
  cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()

  const loaded = await cdp.send('Extensions.loadUnpacked', { path: staged })
  const worker = await waitFor('service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos.find((info) => info.type === 'service_worker' && info.url.endsWith('/sw.js') && info.url.includes(loaded.id)) ?? null
  })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  const evalInWorker = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }

  await evalInWorker(
    `chrome.storage.local.set({ port: ${credentials.port}, token: ${JSON.stringify(credentials.token)} }).then(() => 'ok')`
  )

  const tab = await waitFor('page tab', async () => {
    const tabs = await evalInWorker(
      `chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith('http://127.0.0.1:')).map((t) => ({ id: t.id, url: t.url })))`
    )
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null
  })
  const claimed = await evalInWorker(`__dshSiteBridge.claimTab(${tab.id}).then((t) => t)`)
  if (!claimed?.url) throw new Error('claim failed')

  // make sure the bridge has seen the pairing before we announce readiness
  const state = await waitFor('bridge to see the extension', async () => {
    const response = await fetch(`http://127.0.0.1:${credentials.port}/v1/state`, {
      headers: { 'x-site-token': credentials.token }
    })
    if (!response.ok) return null
    const body = await response.json()
    return body.clientConnected && body.target ? body : null
  })

  console.log(`READY page=${pageUrl} bridge=${state.port} target=${state.target.url}`)
} catch (error) {
  console.error('LIVE-CHECK FAILED:', error.message)
  await shutdown()
}

// stay alive until the parent stops the job
setInterval(() => {}, 1 << 30)
