/**
 * Dev helper: render extension/popup.html with a stubbed chrome.* API so the
 * popup design and every locale can be reviewed without loading the extension.
 *
 * Run: node tools/preview-popup.mjs [connected|notarget|offline] [locale] [scale]
 *      node tools/preview-popup.mjs connected zh_CN 2
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const state = process.argv[2] ?? 'connected'
const locale = process.argv[3] ?? 'ru'
const scale = Number(process.argv[4] ?? 2)
const out = join(root, '.test-out', `popup-${state}-${locale}.png`)
const port = Number(process.env.POPUP_PORT ?? 9378)
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const statuses = {
  'connected-one': {
    ok: true, configured: true, connected: true, port: 47321, recording: false, captured: 0, selfTabId: 1,
    activeTabId: 1,
    target: { id: 1, title: 'Example Store — Products', url: 'https://shop.example/products' },
    targets: [
      { id: 1, title: 'Example Store — Products', url: 'https://shop.example/products', recording: false, captured: 0 }
    ]
  },
  connected: {
    ok: true, configured: true, connected: true, port: 47321, recording: true, captured: 12, selfTabId: 3,
    activeTabId: 1,
    target: { id: 1, title: 'Ozon: Торговая площадка', url: 'https://seller.ozon.ru/app/products' },
    targets: [
      { id: 1, title: 'Ozon: Торговая площадка', url: 'https://seller.ozon.ru/app/products', recording: true, captured: 12 },
      { id: 2, title: 'DeepSeek Platform', url: 'https://platform.deepseek.com/usage', recording: false, captured: 0 }
    ]
  },
  notarget: { ok: true, configured: true, connected: true, port: 47321, recording: false, captured: 0, target: null },
  connecting: {
    ok: true, configured: true, connected: false, port: 47321, recording: false, captured: 0,
    attempts: 1, target: null, lastError: 'Failed to fetch'
  },
  offline: {
    ok: true, configured: true, connected: false, port: 47321, recording: false, captured: 0,
    attempts: 3, target: null, lastError: 'bridge HTTP 401'
  }
}

const messages = JSON.parse(
  await readFile(join(root, 'extension', '_locales', locale, 'messages.json'), 'utf8')
)
const flat = Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, value.message]))

const stub = `
  const MESSAGES = ${JSON.stringify(flat)};
  window.chrome = {
    runtime: { sendMessage: async (m) => (m.type === 'status' ? ${JSON.stringify(statuses[state] ?? statuses.connected)} : { ok: true }) },
    storage: { local: { get: async () => ({ port: 47321, token: 'GWCIveb--rxL_wKChN9Wl-OJmXFGTK4' }), set: async () => {} } },
    tabs: { query: async () => [{ id: ${JSON.stringify(statuses[state]?.selfTabId ?? 1)} }] },
    i18n: {
      getUILanguage: () => ${JSON.stringify(locale.replace('_', '-'))},
      getMessage: (key, subs) => {
        const raw = MESSAGES[key];
        if (!raw) return '';
        const list = Array.isArray(subs) ? subs : (subs === undefined ? [] : [subs]);
        return raw.replace(/\\$(\\w+)\\$/g, (whole, name) => {
          const match = name.toUpperCase();
          if (match === 'COUNT') return String(list[0] ?? '');
          if (match === 'ERROR') return String(list[0] ?? '');
          return whole;
        });
      }
    }
  };
`

await mkdir(join(root, '.test-out'), { recursive: true })
const chrome = spawn(chromePath, [
  `--user-data-dir=${join(root, '.test-out', 'popup-profile')}`,
  `--remote-debugging-port=${port}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--allow-file-access-from-files',
  'about:blank'
], { stdio: 'ignore' })

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
  await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 640, deviceScaleFactor: scale, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: stub })
  await send('Page.navigate', { url: `file:///${join(root, 'extension', 'popup.html').replace(/\\/g, '/')}` })
  await sleep(900)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(out, Buffer.from(shot.data, 'base64'))
  console.log(out)
} finally {
  chrome.kill()
  await sleep(300)
}
