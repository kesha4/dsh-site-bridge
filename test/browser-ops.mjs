/**
 * Ops added in 0.5.0, exercised in a real Chrome through the worker hook:
 * compact snapshot, page text, wait (hidden / settle), tab.open, tab.focus and
 * history navigation.
 *
 * Run: node test/browser-ops.mjs
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
const debugPort = Number(process.env.OPS_PORT ?? 9387)

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

const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:16px system-ui;padding:24px">${body}</body></html>`

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (req.url?.startsWith('/b')) {
    res.end(html('Second', '<h1>Second page</h1><a id="back" href="/a">back</a>'))
    return
  }
  res.end(html('First', `
    <h1 id="heading">First page</h1>
    <button id="btn" data-testid="btn">Buy now</button>
    <input id="field" name="q" placeholder="Search">
    <p id="msg">Ready</p>
  `))
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`

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

const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-'))
const chrome = spawn(chromePath, [
  `--user-data-dir=${dir}`,
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
  const workerSession = (await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId
  const inWorker = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, workerSession)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }

  const pageTarget = await waitFor('page target', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos.find((info) => info.type === 'page' && info.url.startsWith('http://127.0.0.1:')) ?? null
  })
  const pageSession = (await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })).sessionId
  const inPage = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }

  const tabId = await waitFor('tab id', async () => {
    const tabs = await inWorker(`chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith('http://127.0.0.1:')).map((t) => t.id))`)
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null
  })
  await inWorker(`__dshSiteBridge.claimTab(${tabId}).then((t) => t)`)

  // compact snapshot
  const snapshot = await inWorker(`__dshSiteBridge.handle('snapshot.compact', {}).then((r) => r)`)
  const button = (snapshot?.items ?? []).find((item) => item.tag === 'button')
  check('compact snapshot lists the button', Boolean(button), JSON.stringify(snapshot)?.slice(0, 300))
  check('snapshot names the element', button?.name === 'Buy now', JSON.stringify(button))
  const resolves = await inPage(`(() => { const el = document.querySelector(${JSON.stringify(button?.selector ?? '#none')}); return el ? el.id : null })()`)
  check('snapshot selector resolves in the page', resolves === 'btn', String(resolves))

  // page text
  const text = await inWorker(`__dshSiteBridge.handle('text.get', {}).then((r) => r)`)
  check('text.get returns visible text', String(text?.text ?? '').includes('First page'), JSON.stringify(text)?.slice(0, 200))
  const short = await inWorker(`__dshSiteBridge.handle('text.get', { maxChars: 20 }).then((r) => r)`)
  check('text.get honours maxChars and flags truncation', short?.truncated === true && short.text.length <= 20, JSON.stringify(short))

  // wait: settle and hidden
  const settled = await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'wait', state: 'settle', quietMs: 200, timeoutMs: 5000 }] }).then((r) => r.results[0])`)
  check('wait settle resolves on a quiet page', settled?.settled === true, JSON.stringify(settled))
  await inPage(`(() => { document.getElementById('msg').style.display = 'none'; return true })()`)
  const hidden = await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'wait', selector: '#msg', state: 'hidden', timeoutMs: 3000 }] }).then((r) => r.results[0])`)
  check('wait hidden resolves for a hidden element', hidden?.hidden === '#msg', JSON.stringify(hidden))

  // tab.open attaches a second tab
  const opened = await inWorker(`__dshSiteBridge.handle('tab.open', { url: '${base}/b' }).then((r) => r)`)
  check('tab.open attaches the new tab', String(opened?.target?.url ?? '').includes('/b'), JSON.stringify(opened))
  const size = await inWorker(`__dshSiteBridge.state.sessions.size`)
  check('two tabs are attached after open', size === 2, String(size))

  const focused = await inWorker(`__dshSiteBridge.handle('tab.focus', {}).then((r) => r)`)
  check('tab.focus succeeds', Number.isFinite(focused?.focused), JSON.stringify(focused))

  // history back on the active tab
  await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'goto', back: true }], tabId: ${tabId} }).then((r) => r)`)
  await sleep(800)
  const path = await inPage(`location.pathname`)
  check('goto back returns to the previous page', path === '/a', String(path))
} catch (error) {
  check('ops run completed without exceptions', false, String(error?.stack ?? error))
} finally {
  try { chrome.kill() } catch { /* ignore */ }
  try { server.close() } catch { /* ignore */ }
  await sleep(400)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((item) => item.name).join('; '))
    process.exitCode = 1
  }
}
