/**
 * Rasterizes extension/icon.svg into the PNG sizes MV3 requires.
 *
 * MV3 does not accept SVG in the manifest, so the SVG stays the source of
 * truth and this script renders it with the same Chrome the extension runs in
 * (no image libraries, no build chain).
 *
 * Run: node tools/make-icons.mjs
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const svgPath = join(root, 'extension', 'icon.svg')
const smallSvgPath = join(root, 'extension', 'icon-small.svg')
const outDir = join(root, 'extension', 'icons')
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = Number(process.env.ICON_PORT ?? 9370)
// Small sizes get a simplified drawing: the full composition turns to mush at
// 16px, so 16/32 use the optical variant and 48/128 use the full one.
const sizes = [16, 32, 48, 128]
const sources = { 16: smallSvgPath, 32: smallSvgPath, 48: svgPath, 128: svgPath }

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

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

const svgByFile = new Map()
for (const file of new Set(Object.values(sources))) {
  svgByFile.set(file, (await readFile(file, 'utf8')).replace(/^<\?xml[^>]*\?>\s*/, ''))
}
await mkdir(outDir, { recursive: true })

const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${join(root, '.test-out', 'icon-profile')}`,
    `--remote-debugging-port=${port}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

try {
  let version = null
  for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
    await sleep(300)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) version = await response.json()
    } catch {
      // not up yet
    }
  }
  if (!version) throw new Error('chrome devtools did not start')

  const cdp = new Cdp(version.webSocketDebuggerUrl)
  await cdp.open()
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const send = (method, params) => cdp.send(method, params, sessionId)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })

  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false
    })
    const html = `<!doctype html><meta charset="utf-8">
      <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${size}px;height:${size}px}</style>${svgByFile.get(sources[size])}`
    await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` })
    await sleep(350)
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = join(outDir, `icon-${size}.png`)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    console.log(`wrote ${file}`)
  }
} finally {
  chrome.kill()
  await sleep(300)
}
