/**
 * Dev helper: show how a small PNG actually looks when blown up, without
 * smoothing — the honest way to judge a 16/32px icon.
 *
 * Run: node tools/preview-icon.mjs extension/icons/icon-16.png 8
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const target = resolve(root, process.argv[2] ?? 'extension/icons/icon-16.png')
const scale = Number(process.argv[3] ?? 8)
const port = Number(process.env.ICON_PORT ?? 9371)
const out = join(root, '.test-out', `preview-${scale}x.png`)

const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const data = (await readFile(target)).toString('base64')
const mime = target.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#20242c;overflow:hidden}
img{display:block;width:${128 * scale / 8}px;height:${128 * scale / 8}px;image-rendering:pixelated}</style>
<img src="data:${mime};base64,${data}">`

await mkdir(dirname(out), { recursive: true })
const chrome = spawn(chromePath, [
  `--user-data-dir=${join(root, '.test-out', 'icon-preview-profile')}`,
  `--remote-debugging-port=${port}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 128 * scale / 8,
    height: 128 * scale / 8,
    deviceScaleFactor: 1,
    mobile: false
  })
  await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` })
  await sleep(400)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(out, Buffer.from(shot.data, 'base64'))
  console.log(out)
} finally {
  chrome.kill()
  await sleep(300)
}
