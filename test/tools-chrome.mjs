/**
 * Tool layer + real Chrome: the whole shipped path without DSH.
 *
 * Registers the plugin's tools against a throwaway bridge, launches Chrome,
 * loads the workspace extension, claims a tab, and then calls the tools the
 * way the agent does. Unlike e2e.mjs (which drives the raw bridge protocol),
 * this exercises lib/index.js: tool arguments, workspace capture dir,
 * capture retention, redaction inside the written bundle.
 *
 * Run: node test/tools-chrome.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const debugPort = Number(process.env.LIVE_DEBUG_PORT ?? 9362)
const WORK = join(root, '.test-out', 'tools-chrome')
const WORKSPACE = join(WORK, 'workspace')
const DSH_HOME = join(WORK, 'dsh-home')
process.env.DSH_HOME = DSH_HOME

await mkdir(WORK, { recursive: true })

const { apply } = await import('../lib/index.js')

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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tools and Chrome</title></head>
<body style="font:16px system-ui;padding:24px">
  <h1>Storefront</h1>
  <label>Search <input id="q" name="q" /></label>
  <button id="buy" data-testid="buy" style="padding:8px 16px">Order</button>
  <p id="result">no order</p>
  <div id="pad" style="width:200px;height:100px;background:#eef;display:flex;align-items:center;justify-content:center">
    click: <span id="pad-count">0</span>
  </div>
  <input id="f" type="file" style="display:none" /><p id="file-name">no file</p>
  <script>
    document.cookie = 'sid=cookie-secret-value; path=/';
    let pad = 0;
    document.getElementById('pad').addEventListener('mousedown', () => {
      pad += 1; document.getElementById('pad-count').textContent = String(pad);
    });
    document.getElementById('buy').addEventListener('click', async () => {
      const response = await fetch('/api/order', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-secret-value' },
        body: JSON.stringify({ sku: 'TOOL-1', qty: 3 })
      });
      const data = await response.json();
      document.getElementById('result').textContent = 'order ' + data.id;
    });
    document.getElementById('f').addEventListener('change', (event) => {
      document.getElementById('file-name').textContent = event.target.files[0]?.name ?? 'none';
    });
  </script>
</body></html>`

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/order') {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 4242, token: 'response-secret-value', echo: JSON.parse(raw || '{}') }))
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

const tools = new Map()
const effects = []
apply(
  {
    tools: { register: (spec) => tools.set(spec.name, spec) },
    logger: { info() {}, warn() {} },
    effect: (fn) => effects.push(fn()),
    get: (name) => (name === 'workingDirectory' ? { ensure: async () => WORKSPACE } : undefined)
  },
  { port: 47410, settleMs: 150 }
)

const credentials = await waitFor('bridge credentials', async () =>
  JSON.parse(await readFile(join(DSH_HOME, 'site-bridge', 'bridge.json'), 'utf8'))
)

await new Promise((done) => server.listen(0, '127.0.0.1', done))
const pageUrl = `http://127.0.0.1:${server.address().port}/`
const profile = await mkdtemp(join(tmpdir(), 'dsh-tools-chrome-'))
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
    pageUrl
  ],
  { stdio: 'ignore' }
)

const cleanup = async () => {
  try { chrome.kill() } catch { /* ignore */ }
  try { server.close() } catch { /* ignore */ }
  await sleep(400)
  await rm(profile, { recursive: true, force: true }).catch(() => {})
  for (const dispose of effects) {
    try { await dispose() } catch { /* ignore */ }
  }
}

try {
  const version = await waitFor('chrome devtools', async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
    return response.ok ? response.json() : null
  })
  const cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: join(root, 'extension') })
  const worker = await waitFor('service worker', async () => {
    const { targetInfos } = await cdp.send('Target.getTargets')
    return targetInfos.find((info) => info.type === 'service_worker' && info.url.endsWith('/sw.js') && info.url.includes(loaded.id)) ?? null
  })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  const inWorker = async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result?.value
  }
  await inWorker(`chrome.storage.local.set({ port: ${credentials.port}, token: ${JSON.stringify(credentials.token)} }).then(() => 'ok')`)

  const status = await waitFor('site_status to report a connection', async () => {
    const value = await tools.get('site_status').execute({}, {})
    return value.connected ? value : null
  })
  check('site_status reports the paired browser', status.connected === true, status.summary)

  const tab = await waitFor('page tab', async () => {
    const tabs = await inWorker(
      `chrome.tabs.query({}).then((ts) => ts.filter((t) => (t.url || '').startsWith('http://127.0.0.1:')).map((t) => ({ id: t.id, url: t.url })))`
    )
    return Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null
  })
  await inWorker(`__dshSiteBridge.claimTab(${tab.id}).then((t) => t)`)
  await waitFor('tool to see the target', async () => {
    const value = await tools.get('site_status').execute({}, {})
    return value.target ? value : null
  })
  await sleep(400)

  const tabs = await tools.get('site_tabs').execute({ action: 'list' }, {})
  check('site_tabs lists the page', /\[\d+\]/.test(tabs.summary), tabs.summary)

  await tools.get('site_network').execute({ action: 'start' }, {})
  const act = await tools.get('site_act').execute(
    {
      steps: JSON.stringify([
        { op: 'type', selector: '#q', value: 'check' },
        { op: 'click', selector: '[data-testid="buy"]' },
        { op: 'wait', ms: 700 }
      ])
    },
    {}
  )
  check('site_act typed and clicked', act.ok === true, act.summary)

  const list = await tools.get('site_network').execute({ action: 'list' }, {})
  check('site_network captured the BFF call', list.summary.includes('/api/order'), list.summary.slice(0, 300))

  const capture = await tools.get('site_capture').execute({ screenshot: true }, { agent: { id: 'live' } })
  check('site_capture wrote a bundle', capture.ok === true, capture.summary)
  check('bundle is inside the session workspace', String(capture.dir).startsWith(join(WORKSPACE, 'captures')), String(capture.dir))
  check('bundle kept the recorded request', capture.requests >= 1, `requests=${capture.requests}`)

  const files = await readdir(capture.dir)
  check('bundle has every artifact', ['api.md', 'dom.json', 'styles.json', 'selectors.md', 'network.jsonl', 'screenshot.png'].every((name) => files.includes(name)), files.join(','))
  const api = await readFile(join(capture.dir, 'api.md'), 'utf8')
  const network = await readFile(join(capture.dir, 'network.jsonl'), 'utf8')
  const dom = await readFile(join(capture.dir, 'dom.json'), 'utf8')
  check('api.md documents POST /api/order', api.includes('POST /api/order'), api.slice(0, 200))
  check('request body is in the bundle', network.includes('TOOL-1'))
  check('cookie value never reaches the bundle', !network.includes('cookie-secret-value'))
  check('csrf value never reaches the bundle', !network.includes('csrf-secret-value'))
  check('response token never reaches the bundle', !network.includes('response-secret-value'))
  check('markup captured with a stable selector', dom.includes('data-testid'))

  const padPoint = await tools.get('site_act').execute(
    {
      steps: [
        {
          op: 'eval',
          expression: `(() => { const r = document.querySelector('#pad').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
        }
      ]
    },
    {}
  )
  const point = padPoint.results?.[0]?.value
  const cursor = await tools.get('site_cursor').execute({ x: Math.round(point.x), y: Math.round(point.y), click: true }, {})
  check('site_cursor clicked at coordinates', cursor.clicked === true, cursor.summary)
  const padCount = await tools.get('site_act').execute(
    { steps: [{ op: 'eval', expression: `document.querySelector('#pad-count').textContent` }] },
    {}
  )
  check('page received the virtual click', String(padCount.results?.[0]?.value) === '1', String(padCount.results?.[0]?.value))

  const uploadFile = join(WORK, 'upload.txt')
  await writeFile(uploadFile, 'hello', 'utf8')
  const upload = await tools.get('site_act').execute({ steps: [{ op: 'upload', selector: '#f', files: [uploadFile] }] }, {})
  check('site_act uploaded a file', upload.ok === true, upload.summary)
  const fileName = await tools.get('site_act').execute(
    { steps: [{ op: 'eval', expression: `document.querySelector('#file-name').textContent` }] },
    {}
  )
  check('page saw the uploaded file', String(fileName.results?.[0]?.value).includes('upload.txt'), String(fileName.results?.[0]?.value))

  const injected = await tools.get('site_inject').execute(
    {
      js: `const el = document.createElement('div'); el.id = 'probe'; document.body.appendChild(el); return Boolean(document.querySelector('[data-testid="buy"]'));`
    },
    {}
  )
  check('site_inject ran the agent script', /true/.test(injected.summary), injected.summary)
} catch (error) {
  check('live tool run completed without exceptions', false, String(error?.stack ?? error))
} finally {
  await cleanup()
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('failed:', failed.map((item) => item.name).join('; '))
    process.exitCode = 1
  }
}
