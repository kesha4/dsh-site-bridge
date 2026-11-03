/**
 * Pause check: while paused the worker must stop polling, refuse commands and
 * keep the flag in storage — the agent has no way to turn it back on.
 *
 * Run: node test/pause.mjs
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
const debugPort = Number(process.env.PAUSE_PORT ?? 9401)

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

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body><h1>pause me</h1><button id="b">b</button></body></html>')
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)) }, 20000)
    })
  }
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-pause-'))
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

  const before = await inWorker(`({ paused: __dshSiteBridge.state.paused === true })`)
  check('not paused by default', before?.paused === false, JSON.stringify(before))

  await inWorker(`__dshSiteBridge.setPaused(true).then(() => true)`)
  const after = await inWorker(`({ paused: __dshSiteBridge.state.paused === true, poll: __dshSiteBridge.state.lastPollOk })`)
  check('the worker is paused', after?.paused === true, JSON.stringify(after))
  check('polling stopped (liveness reset)', after?.poll === 0, JSON.stringify(after?.poll))

  const storedPaused = await inWorker(`chrome.storage.local.get({ paused: false }).then((s) => s.paused)`)
  check('the pause survives a worker restart (stored)', storedPaused === true, JSON.stringify(storedPaused))

  const refused = await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'click', selector: '#b' }] }).then(() => 'no error').catch((e) => String(e.message))`)
  check('commands are refused while paused', /паузе/.test(refused), refused)

  const pingOk = await inWorker(`__dshSiteBridge.handle('ping', {}).then((r) => r.ok)`)
  check('ping still answers so the popup can render', pingOk === true, JSON.stringify(pingOk))

  await inWorker(`__dshSiteBridge.setPaused(false).then(() => true)`)
  const resumed = await inWorker(`({ paused: __dshSiteBridge.state.paused === true })`)
  check('unpause clears the flag', resumed?.paused === false, JSON.stringify(resumed))

  const acted = await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'exists', selector: '#b' }] }).then((r) => r.results[0].ok)`)
  check('commands work again after unpause', acted === true, JSON.stringify(acted))
} catch (error) {
  check('pause run completed without exceptions', false, String(error?.stack ?? error))
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
