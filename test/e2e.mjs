/**
 * End-to-end check against a real Chrome with the extension loaded.
 *
 * Run: node test/e2e.mjs            (headless)
 *      E2E_HEADED=1 node test/e2e.mjs
 *
 * It serves a page with a working BFF call, a canvas-like pad and a file
 * input, then drives everything through the same bridge the agent uses.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Bridge } from '../lib/bridge.js'

const here = dirname(fileURLToPath(import.meta.url))
const extPath = resolve(here, '..', 'extension')
const profilePath = resolve(here, '..', '.e2e-profile')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DEBUG_PORT = Number(process.env.E2E_PORT ?? 9333)
const TOKEN = 'e2e-token-0123456789abcdefghij'

const results = []
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  ${detail}`}`)
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function waitFor(label, probe, { timeout = 20000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

/* ------------------------------------------------------------------ page */

const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Site Bridge E2E</title></head>
<body style="font:16px system-ui;padding:24px">
  <h1>Тестовая витрина</h1>
  <label>Поиск <input id="q" name="q" /></label>
  <label>Сортировка <select id="s" name="s"><option value="asc">asc</option><option value="desc">desc</option></select></label>
  <button id="buy" data-testid="buy" style="padding:8px 16px">Купить</button>
  <p id="result">нет заказа</p>
  <div id="pad" style="width:220px;height:120px;background:#eee;display:flex;align-items:center;justify-content:center">
    кликни меня: <span id="pad-count">0</span>
  </div>
  <input id="f" type="file" style="display:none" />
  <p id="file-name">файл не выбран</p>
  <script>
    document.cookie = 'sid=abc123; path=/';
    let pad = 0;
    document.getElementById('pad').addEventListener('mousedown', () => {
      pad += 1;
      document.getElementById('pad-count').textContent = String(pad);
    });
    document.getElementById('buy').addEventListener('click', async () => {
      const response = await fetch('/api/order', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok-123' },
        body: JSON.stringify({ sku: 'A1', qty: 1, note: 'заказ с витрины' })
      });
      const data = await response.json();
      document.getElementById('result').textContent = 'заказ ' + data.id;
    });
    document.getElementById('f').addEventListener('change', (event) => {
      document.getElementById('file-name').textContent = event.target.files[0]?.name ?? 'нет';
    });
  </script>
</body></html>`

const pageServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/order') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 42, token: 'resp-secret-value', echo: JSON.parse(raw || '{}'), items: [{ sku: 'A1', qty: 1 }] }))
    })
    return
  }
  if (req.url === '/api/cart') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [] }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})

/* -------------------------------------------------------------------- cdp */

class CDP {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }
  async open() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.onopen = () => resolveOpen()
      this.ws.onerror = (event) => rejectOpen(new Error(`ws error ${event?.message ?? ''}`))
    })
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolveSend, rejectSend } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) rejectSend(new Error(message.error.message))
        else resolveSend(message.result)
      }
    }
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolveSend, rejectSend })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rejectSend(new Error(`cdp timeout: ${method}`))
        }
      }, 30000)
    })
  }
  close() {
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
  }
}

/* ------------------------------------------------------------------- main */

let chrome = null
let bridge = null
let cdp = null

async function main() {
  await mkdir(profilePath, { recursive: true })
  await new Promise((resolveListen) => pageServer.listen(0, '127.0.0.1', resolveListen))
  const pagePort = pageServer.address().port
  const pageUrl = `http://127.0.0.1:${pagePort}/`

  bridge = new Bridge({ port: 47390, homeDir: '.', token: TOKEN })
  await bridge.listen()

  const args = [
    `--user-data-dir=${profilePath}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    // Chrome 137+ ignores --load-extension; the supported path is
    // Extensions.loadUnpacked over CDP, which needs this switch.
    '--enable-unsafe-extension-debugging',
    '--window-size=1280,900',
    pageUrl
  ]
  if (process.env.E2E_HEADED !== '1') args.unshift('--headless=new')

  chrome = spawn(chromePath, args, { stdio: 'ignore' })
  chrome.on('error', (error) => console.error('chrome spawn error', error.message))

  const version = await waitFor('chrome devtools', async () => {
    const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    return response.ok ? response.json() : null
  }, { timeout: 30000 })

  cdp = new CDP(version.webSocketDebuggerUrl)
  await cdp.open()

  const loaded = await cdp.send('Extensions.loadUnpacked', { path: extPath })
  check('extension loaded into Chrome', typeof loaded?.id === 'string' && loaded.id.length > 10, JSON.stringify(loaded))

  const worker = await waitFor('extension service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos.find((info) => info.type === 'service_worker' && info.url.endsWith('/sw.js')) ?? null
  }, { timeout: 30000 })
  check('extension service worker is running', Boolean(worker))

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)

  const evalInWorker = async (expression) => {
    const { result, exceptionDetails } = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    )
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }

  await evalInWorker(
    `chrome.storage.local.set({ port: ${bridge.port}, token: ${JSON.stringify(TOKEN)} }).then(() => 'saved')`
  )

  const connected = await waitFor('worker to reach the bridge', () => {
    const state = bridge.state()
    return state.clientConnected ? state : null
  }, { timeout: 30000 })
  check('extension connected to the bridge', connected.clientConnected === true)
  check('pairing token is the only credential the bridge sees', bridge.token === TOKEN)

  // the page the extension should drive
  const pageTab = await waitFor('test page tab', async () => {
    const tabs = await evalInWorker(`chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith('http://127.0.0.1:${pagePort}')).map((t) => ({ id: t.id, url: t.url })))`)
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null
  })
  check('test page is open', Boolean(pageTab?.id))

  const claim = await evalInWorker(`__dshSiteBridge.claimTab(${pageTab.id}).then((t) => t)`)
  check('tab claimed for debugging', claim?.url?.startsWith('http://127.0.0.1'), JSON.stringify(claim))

  const target = await waitFor('bridge target', () => bridge.state().target)
  check('bridge knows the target tab', target.url.startsWith('http://127.0.0.1'))

  // let the page settle after attach
  await sleep(600)

  /* ---- input: fill / type / select / click ---- */
  const typed = await bridge.enqueue('act', {
    steps: [
      { op: 'type', selector: '#q', value: 'кофемолка' },
      { op: 'fill', selector: '#s', value: 'desc' }
    ]
  }, { timeout: 30000 })
  check('typed into a field with trusted input', typed.ok === true, JSON.stringify(typed))

  const fieldState = await bridge.enqueue('act', {
    steps: [{ op: 'eval', expression: `({ q: document.querySelector('#q').value, s: document.querySelector('#s').value })` }]
  }, { timeout: 20000 })
  const values = fieldState.results?.[0]?.value
  check('field kept the typed value', values?.q === 'кофемолка', JSON.stringify(values))
  check('select kept the chosen value', values?.s === 'desc', JSON.stringify(values))

  /* ---- network capture around a real BFF call ---- */
  await bridge.enqueue('net.start', {}, { timeout: 15000 })
  bridge.clearNetwork()
  const clicked = await bridge.enqueue('act', {
    steps: [{ op: 'click', selector: '[data-testid="buy"]' }]
  }, { timeout: 30000 })
  check('clicked the buy button', clicked.ok === true, JSON.stringify(clicked))

  const orderEntry = await waitFor('captured order request', () => {
    return bridge.net.find((entry) => String(entry.url).includes('/api/order')) ?? null
  }, { timeout: 15000 })
  await bridge.enqueue('net.stop', {}, { timeout: 15000 })
  check('BFF call was captured', Boolean(orderEntry))
  check('request method and status', orderEntry.method === 'POST' && orderEntry.status === 200, `${orderEntry.method} ${orderEntry.status}`)
  check('request body captured', String(orderEntry.request?.body ?? '').includes('A1'), String(orderEntry.request?.body))
  check('CSRF header captured by name', 'x-csrf-token' in (orderEntry.request?.headers ?? {}))
  check('CSRF header value redacted', orderEntry.request?.headers?.['x-csrf-token'] === '«redacted»', JSON.stringify(orderEntry.request?.headers))
  const cookieHeader = Object.keys(orderEntry.request?.headers ?? {}).find((name) => name.toLowerCase() === 'cookie')
  check('cookie header never reaches artifacts', cookieHeader === undefined || orderEntry.request.headers[cookieHeader] === '«redacted»')
  check('response body captured', String(orderEntry.response?.body ?? '').includes('42'), String(orderEntry.response?.body).slice(0, 120))
  check('token inside response body redacted', !String(orderEntry.response?.body ?? '').includes('resp-secret-value'), String(orderEntry.response?.body).slice(0, 200))

  const pageResult = await bridge.enqueue('act', {
    steps: [{ op: 'eval', expression: `document.querySelector('#result').textContent` }]
  }, { timeout: 20000 })
  check('the page really ran the call', String(pageResult.results?.[0]?.value ?? '').includes('42'), String(pageResult.results?.[0]?.value))

  /* ---- markup snapshot ---- */
  const snapshot = await bridge.enqueue('dom.snapshot', { selector: 'body' }, { timeout: 45000 })
  check('snapshot returned a node tree', Array.isArray(snapshot.nodes) && snapshot.nodes.length > 8, `${snapshot.nodes?.length} nodes`)
  check('snapshot kept the markup', String(snapshot.html ?? '').includes('data-testid="buy"'))
  const buyNode = (snapshot.nodes ?? []).find((node) => node.attrs?.['data-testid'] === 'buy')
  const buySelectors = (buyNode?.sel?.candidates ?? []).map((item) => item.selector)
  check(
    'interactive node got a stable selector',
    buyNode?.sel?.unique === true && ['#buy', '[data-testid="buy"]'].includes(buyNode.sel.best) && buySelectors.includes('[data-testid="buy"]'),
    JSON.stringify(buyNode?.sel)
  )
  check('computed styles were sampled', Object.keys(snapshot.styles ?? {}).length > 0)

  /* ---- virtual cursor on a control that needs real coordinates ---- */
  const padBox = await bridge.enqueue('act', {
    steps: [{ op: 'eval', expression: `(() => { const r = document.querySelector('#pad').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()` }]
  }, { timeout: 20000 })
  const point = padBox.results?.[0]?.value
  const cursor = await bridge.enqueue('cursor', { x: Math.round(point.x), y: Math.round(point.y), click: true }, { timeout: 20000 })
  check('virtual cursor clicked at coordinates', cursor?.clicked === true)
  const padCount = await bridge.enqueue('act', {
    steps: [{ op: 'eval', expression: `document.querySelector('#pad-count').textContent` }]
  }, { timeout: 20000 })
  check('the page received the mouse event', String(padCount.results?.[0]?.value) === '1', String(padCount.results?.[0]?.value))

  /* ---- file upload ---- */
  const filePath = resolve(here, '..', '.e2e-upload.txt')
  await writeFile(filePath, 'hello from e2e', 'utf8')
  const upload = await bridge.enqueue('act', {
    steps: [{ op: 'upload', selector: '#f', files: [filePath] }]
  }, { timeout: 20000 })
  check('file input accepted the upload', upload.ok === true, JSON.stringify(upload))
  const fileName = await bridge.enqueue('act', {
    steps: [{ op: 'eval', expression: `document.querySelector('#file-name').textContent` }]
  }, { timeout: 20000 })
  check('the page saw the uploaded file', String(fileName.results?.[0]?.value).includes('.e2e-upload.txt'), String(fileName.results?.[0]?.value))

  /* ---- inject a script, the way the agent verifies its own extension ---- */
  const injected = await bridge.enqueue('inject', {
    js: `
      const host = document.createElement('div');
      host.id = 'dsh-verify';
      host.textContent = 'панель вставлена';
      document.body.appendChild(host);
      return { anchor: Boolean(document.querySelector('[data-testid="buy"]')), node: Boolean(document.getElementById('dsh-verify')) };
    `
  }, { timeout: 20000 })
  check('injected script found its anchor', injected?.value?.anchor === true, JSON.stringify(injected))

  /* ---- screenshot ---- */
  const shot = await bridge.enqueue('shot', { fullPage: false }, { timeout: 20000 })
  check('screenshot came back as PNG', typeof shot?.png === 'string' && shot.png.length > 1000, `${shot?.png?.length} chars`)

  /* ---- bundle ---- */
  const root = resolve(here, '..', '.e2e-captures')
  const { writeBundle } = await import('../lib/artifacts.js')
  const bundle = await writeBundle({
    root,
    host: '127.0.0.1',
    snapshot,
    entries: bridge.net.slice(),
    meta: { host: '127.0.0.1', url: target.url, title: target.title, capturedAt: new Date().toISOString() }
  })
  check('bundle written with markup and API', bundle.files.includes('api.md') && bundle.files.includes('dom.json'), bundle.files.join(','))
}

async function cleanup() {
  try {
    if (bridge) await bridge.close()
  } catch {
    // ignore
  }
  try {
    cdp?.close()
  } catch {
    // ignore
  }
  try {
    chrome?.kill()
  } catch {
    // ignore
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 500))
  try {
    pageServer.close()
  } catch {
    // ignore
  }
  try {
    await rm(profilePath, { recursive: true, force: true })
  } catch {
    // profile can stay locked by a closing chrome; harmless
  }
}

try {
  await main()
} catch (error) {
  check('e2e completed without exceptions', false, String(error?.stack ?? error))
} finally {
  await cleanup()
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((item) => item.name).join('; '))
    process.exitCode = 1
  }
}
