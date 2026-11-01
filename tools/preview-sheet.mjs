/**
 * Dev helper: render several icon candidates into one contact sheet.
 *
 * Run: node tools/preview-sheet.mjs icon-a.svg icon-b.svg ...
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node tools/preview-sheet.mjs <svg> [<svg> ...]')
  process.exit(1)
}

const port = Number(process.env.SHEET_PORT ?? 9379)
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const cards = []
for (const file of files) {
  const svg = await readFile(resolve(file), 'utf8')
  const data = Buffer.from(svg).toString('base64')
  cards.push({ label: basename(file, '.svg'), src: `data:image/svg+xml;base64,${data}` })
}

const columns = Math.min(2, cards.length)
const cell = 148
const width = columns * cell + 24
const rows = Math.ceil(cards.length / columns)
const height = rows * (cell + 26) + 24

const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:12px;background:#0f1116;font:12px "Segoe UI",system-ui,sans-serif;color:#c9d1de}
  .grid{display:grid;grid-template-columns:repeat(${columns}, ${cell}px);gap:14px}
  figure{margin:0;text-align:center}
  img{width:128px;height:128px;border-radius:28px;display:block;margin:0 auto 6px;background:#1b1e25}
  figcaption{font-size:11px;opacity:.75;word-break:break-all}
</style>
<div class="grid">
${cards.map((c) => `<figure><img src="${c.src}"><figcaption>${c.label}</figcaption></figure>`).join('\n')}
</div>`

const out = join(root, '.test-out', 'icon-sheet.png')
await mkdir(join(root, '.test-out'), { recursive: true })

const chrome = spawn(chromePath, [
  `--user-data-dir=${join(root, '.test-out', 'sheet-profile')}`,
  `--remote-debugging-port=${port}`,
  '--headless=new',
  '--no-first-run',
  '--disable-gpu',
  '--hide-scrollbars',
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
    } catch { /* not up */ }
  }
  const cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` })
  await sleep(700)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(out, Buffer.from(shot.data, 'base64'))
  console.log(out)
} finally {
  chrome.kill()
  await sleep(300)
}
