/**
 * OOPIF check: a cross-origin iframe runs in its own process, and its network
 * traffic must reach the capture. The page is served from 127.0.0.1 while the
 * frame comes from localhost — different sites, so Chrome isolates it.
 *
 * Run: node test/oopif.mjs
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
const debugPort = Number(process.env.OOPIF_PORT ?? 9399)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(label, probe, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null)
    if (value) return value
    await sleep(200)
  }
  throw new Error(`timeout: ${label}`)
}

// Inner frame: a different site (localhost), fetches its own JSON on load.
const inner = createServer((req, res) => {
  if (req.url?.startsWith('/api/inner')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: 'inner', ok: true }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body>
    <h2 id="inner">inner frame</h2>
    <script>fetch('/api/inner').catch(() => {})</script>
  </body></html>`)
})
await new Promise((done) => inner.listen(0, '127.0.0.1', done))
const innerPort = inner.address().port

const outer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body><h1>outer</h1>
    <iframe id="w" src="http://localhost:${innerPort}/frame" width="360" height="240"></iframe>
  </body></html>`)
})
await new Promise((done) => outer.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${outer.address().port}`

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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)) }, 30000)
    })
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-oopif-test-'))
const chrome = spawn(chromePath, [
  `--user-data-dir=${dir}`,
  `--remote-debugging-port=${debugPort}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--enable-unsafe-extension-debugging',
  `${base}/`
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
  const workerSession = (await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId
  const inWorker = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, workerSession)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }

  const tabId = await waitFor('tab id', async () => {
    const tabs = await inWorker(`chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith('${base}')).map((t) => t.id))`)
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null
  })
  await inWorker(`__dshSiteBridge.claimTab(${tabId}, 'user').then(() => true)`)
  check('page claimed', Boolean(tabId))

  const children = await waitFor('child frame attached', async () => {
    const count = await inWorker(`__dshSiteBridge.state.sessions.get(${tabId})?.children?.size ?? 0`)
    return count > 0 ? count : null
  }, 15000)
  check('cross-origin frame is attached as a child target', children >= 1, `children=${children}`)

  await inWorker(`__dshSiteBridge.handle('net.start', {}).then((r) => r)`)
  await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'reload' }] }).then((r) => r)`)
  await sleep(4000)

  const list = await inWorker(`__dshSiteBridge.handle('net.list', {}).then((r) => r)`)
  const entries = Array.isArray(list?.items) ? list.items : []
  const fromFrame = entries.find((entry) => String(entry.url).includes('/api/inner'))
  check('traffic from the frame is captured', Boolean(fromFrame), JSON.stringify(entries.map((e) => e.url)).slice(0, 300))
  check('the entry names its frame', Boolean(fromFrame?.frame && fromFrame.frame.includes('localhost')), JSON.stringify(fromFrame?.frame))
} catch (error) {
  check('oopif run completed without exceptions', false, String(error?.stack ?? error))
} finally {
  try { chrome.kill() } catch { /* ignore */ }
  try { inner.close() } catch { /* ignore */ }
  try { outer.close() } catch { /* ignore */ }
  await sleep(400)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((item) => item.name).join('; '))
    process.exitCode = 1
  }
}
