/**
 * Picker check in a real Chrome: arm the overlay, click an element with a real
 * mouse event, type a note, and verify the returned selector and XPath resolve
 * to the same node.
 *
 * Run: node test/picker.mjs
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
const debugPort = Number(process.env.PICKER_PORT ?? 9386)

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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Picker</title></head>
<body style="font:16px system-ui;padding:24px">
  <h1>Picker target</h1>
  <button id="pick-me" data-testid="pick-me" style="padding:10px 18px">Pick me</button>
  <p id="note">no pick yet</p>
</body></html>`

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

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const pageUrl = `http://127.0.0.1:${server.address().port}/`

const dir = await mkdtemp(join(tmpdir(), 'dsh-picker-'))
const chrome = spawn(chromePath, [
  `--user-data-dir=${dir}`,
  `--remote-debugging-port=${debugPort}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--enable-unsafe-extension-debugging',
  pageUrl
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
  check('tab claimed', Boolean(tabId))

  const rect = await inPage(`(() => { const r = document.getElementById('pick-me').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  await inWorker(`__dshSiteBridge.handle('pick.arm', {}).then(() => true)`)
  check('picker overlay is armed', (await inPage(`Boolean(window.__dshPicker)`)) === true)

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y }, pageSession)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, pageSession)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, pageSession)
  await sleep(400)
  check('note panel opened on click', (await inPage(`Boolean(document.querySelector('textarea'))`)) === true)

  await cdp.send('Input.insertText', { text: 'кнопка выбора' }, pageSession)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, pageSession)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, pageSession)

  const pick = await waitFor('pick result', async () => {
    const state = await inWorker(`__dshSiteBridge.handle('pick.last', {}).then((r) => r.pick)`)
    return state ?? null
  }, 10000)

  check('picker returned a selector', typeof pick.selector === 'string' && pick.selector.length > 0, JSON.stringify(pick))
  check('note was saved', pick.note === 'кнопка выбора', JSON.stringify(pick.note))
  check('xpath looks absolute', String(pick.xpath).startsWith('/'), pick.xpath)

  const resolves = await inPage(`(() => {
    const bySelector = document.querySelector(${JSON.stringify(pick.selector)});
    const byXPath = document.evaluate(${JSON.stringify(pick.xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    return { same: bySelector === byXPath && Boolean(bySelector), text: bySelector ? bySelector.textContent.trim() : null };
  })()`)
  check('selector and xpath point at the same element', resolves?.same === true, JSON.stringify(resolves))
  check('the element is the one that was clicked', resolves?.text === 'Pick me', JSON.stringify(resolves))
} catch (error) {
  check('picker run completed without exceptions', false, String(error?.stack ?? error))
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
