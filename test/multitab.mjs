/**
 * Multi-tab check against a real Chrome: two tabs attached at once, switching
 * the active one, and per-tab network isolation.
 *
 * Run: node test/multitab.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const debugPort = Number(process.env.MULTITAB_PORT ?? 9382)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(label, probe, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null)
    if (value) return value
    await sleep(200)
  }
  throw new Error(`timeout: ${label}`)
}

const PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:16px system-ui;padding:24px"><h1>${title}</h1>
<button id="go" style="padding:8px 16px">Send</button>
<script>document.getElementById('go').addEventListener('click', () => fetch('/api/ping?from=${title}').then(r => r.json()))</script>
</body></html>`

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/ping')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE('tab'))
})

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

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const profile = await mkdtemp(join(tmpdir(), 'dsh-multitab-'))
const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--enable-unsafe-extension-debugging',
  `${base}/a`
], { stdio: 'ignore' })

let cdp = null
try {
  const version = await waitFor('chrome devtools', async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    return response.ok ? response.json() : null
  })
  cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: join(root, 'extension') })
  const worker = await waitFor('service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos.find((info) => info.type === 'service_worker' && info.url.endsWith('/sw.js') && info.url.includes(loaded.id)) ?? null
  })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }

  await cdp.send('Target.createTarget', { url: `${base}/b` })

  const tabs = await waitFor('two tabs', async () => {
    const list = await evaluate(`chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith(${JSON.stringify(base)})).map((t) => t.id))`)
    return Array.isArray(list) && list.length >= 2 ? list : null
  })

  await evaluate(`__dshSiteBridge.claimTab(${tabs[0]}).then((t) => t)`)
  await evaluate(`__dshSiteBridge.claimTab(${tabs[1]}).then((t) => t)`)

  const state = await evaluate(`({ size: __dshSiteBridge.state.sessions.size, active: __dshSiteBridge.state.activeTabId })`)
  check('both tabs are attached at once', state.size === 2, JSON.stringify(state))
  check('the last claimed tab is active', state.active === tabs[1], JSON.stringify(state))

  await evaluate(`__dshSiteBridge.handle('tab.use', { tabId: ${tabs[0]} }).then(() => true)`)
  const switched = await evaluate(`__dshSiteBridge.state.activeTabId`)
  check('tab.use switches the active tab', switched === tabs[0], `active=${switched}`)

  // network isolation: record on tab A, click on tab B, nothing should leak into A
  await evaluate(`__dshSiteBridge.handle('net.start', { tabId: ${tabs[0]} }).then(() => true)`)
  await evaluate(`__dshSiteBridge.handle('act', { tabId: ${tabs[1]}, steps: [{ op: 'click', selector: '#go' }] }).then(() => true)`)
  await sleep(700)
  const capturedA = await evaluate(`__dshSiteBridge.handle('net.list', { tabId: ${tabs[0]} }).then((r) => r.captured)`)
  await evaluate(`__dshSiteBridge.handle('net.start', { tabId: ${tabs[1]} }).then(() => true)`)
  await evaluate(`__dshSiteBridge.handle('act', { tabId: ${tabs[1]}, steps: [{ op: 'click', selector: '#go' }] }).then(() => true)`)
  await sleep(700)
  const capturedB = await evaluate(`__dshSiteBridge.handle('net.list', { tabId: ${tabs[1]} }).then((r) => r.captured)`)
  check('recording on one tab does not capture another', capturedA === 0, `tab A captured ${capturedA}`)
  check('the active recording tab captures its own call', capturedB >= 1, `tab B captured ${capturedB}`)
} catch (error) {
  check('multi-tab run completed without exceptions', false, String(error?.stack ?? error))
} finally {
  try { chrome.kill() } catch { /* ignore */ }
  try { server.close() } catch { /* ignore */ }
  await sleep(400)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((item) => item.name).join('; '))
    process.exitCode = 1
  }
}
