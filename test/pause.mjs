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

  // The worker target appears before its module finishes evaluating.
  await waitFor('worker hook', async () => {
    const ready = await inWorker('typeof __dshSiteBridge !== "undefined"')
    return ready === true ? true : null
  }, 15000)

  // A fresh profile starts paused: a browser is not handed to an agent by default.
  const fresh = await inWorker(`({ paused: __dshSiteBridge.state.paused === true })`)
  check('a fresh install starts paused', fresh?.paused === true, JSON.stringify(fresh))

  await inWorker(`__dshSiteBridge.setPaused(false).then(() => true)`)

  const tabId = await waitFor('tab id', async () => {
    const tabs = await inWorker(`chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith('${base}')).map((t) => t.id))`)
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null
  })
  await inWorker(`__dshSiteBridge.claimTab(${tabId}, 'user').then(() => true)`)
  check('page claimed after resuming', Boolean(tabId))

  await inWorker(`__dshSiteBridge.setPaused(true).then(() => true)`)
  const after = await inWorker(`({ paused: __dshSiteBridge.state.paused === true })`)
  check('the worker is paused', after?.paused === true, JSON.stringify(after))

  const calm = await inWorker(`({ kind: __dshSiteBridge.state.iconKind, badge: null })`)
  check('the calm pause keeps the II badge', calm?.kind === 'paused', JSON.stringify(calm))
  const calmBadge = await inWorker(`chrome.action.getBadgeText({}).then((text) => text)`)
  check('the calm pause still shows II', calmBadge === 'II', JSON.stringify(calmBadge))

  const storedPaused = await inWorker(`chrome.storage.local.get({ paused: false }).then((s) => s.paused)`)
  check('the pause survives a worker restart (stored)', storedPaused === true, JSON.stringify(storedPaused))

  const refused = await inWorker(`__dshSiteBridge.handle('act', { steps: [{ op: 'click', selector: '#b' }] }).then(() => 'no error').catch((e) => String(e.message))`)
  check('commands are refused while paused', /паузе/.test(refused), refused)
  check('the refusal tells the agent what to do', /попап|play/.test(refused), refused)

  const knock = await inWorker(`({ at: __dshSiteBridge.state.knockAt, op: __dshSiteBridge.state.knockOp })`)
  check('a refused command is recorded as a knock', knock?.op === 'act' && Number(knock?.at) > 0, JSON.stringify(knock))

  // The host refuses early but still tells the extension, so the icon blinks.
  const knocked = await inWorker(`__dshSiteBridge.handle('pause.knock', { op: 'site_act' }).then((r) => r)`)
  check('the host can raise a knock explicitly', Number(knocked?.knockAt) > 0, JSON.stringify(knocked))

  const ping = await inWorker(`__dshSiteBridge.handle('ping', {}).then((r) => r)`)
  check('ping answers with the pause state', ping?.ok === true && ping?.paused === true, JSON.stringify(ping))

  // The mark is painted into the icon; after the blink it settles as "knock".
  await new Promise((done) => setTimeout(done, 11000))
  const painted = await inWorker(`({ kind: __dshSiteBridge.state.iconKind, badge: null })`)
  check('the icon is painted with the knock mark', painted?.kind === 'knock', JSON.stringify(painted))

  await inWorker(`__dshSiteBridge.setPaused(false).then(() => true)`)
  const resumed = await inWorker(`({ paused: __dshSiteBridge.state.paused === true, knock: __dshSiteBridge.state.knockAt })`)
  check('unpause clears the flag and the knock', resumed?.paused === false && resumed?.knock == null, JSON.stringify(resumed))
  const cleared = await inWorker(`__dshSiteBridge.state.iconKind`)
  check('the icon returns to normal after resuming', cleared === 'normal', JSON.stringify(cleared))

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
