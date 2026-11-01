/**
 * Host-half integration: register the real tools, pair a fake extension that
 * speaks the real wire protocol, and drive every tool the agent will use.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The real `defineTool` comes from the DSH host as a peer dependency. Outside
// DSH the tools can still be exercised with a one-file shim that returns the
// spec unchanged, so this test is self-contained on a fresh clone.
const SHIM_DIR = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-tools')
await mkdir(SHIM_DIR, { recursive: true })
await writeFile(
  join(SHIM_DIR, 'package.json'),
  JSON.stringify(
    { name: '@deepseek-ai/dsh-tools', version: '0.0.0-local-shim', private: true, type: 'module', main: './index.js', exports: { '.': './index.js' } },
    null,
    2
  )
)
await writeFile(join(SHIM_DIR, 'index.js'), 'export function defineTool(spec) { return spec }\nexport default { defineTool }\n')

const OUT = resolve(process.cwd(), '.test-out')
const DSH_HOME = join(OUT, 'dsh-home')
const CAPTURES = join(OUT, 'plugin-captures')
const WORKSPACE = join(OUT, 'workspace')
process.env.DSH_HOME = DSH_HOME

const { apply } = await import('../lib/index.js')

const tools = new Map()
const effects = []
const ctx = {
  tools: { register: (spec) => tools.set(spec.name, spec) },
  logger: { info() {}, warn() {} },
  // cordis semantics: the callback runs immediately and yields the disposer
  effect: (fn) => effects.push(fn()),
  get: (name) => (name === 'workingDirectory' ? { ensure: async () => WORKSPACE } : undefined)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(label, probe, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null)
    if (value) return value
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${label}`)
}

const snapshotFixture = {
  url: 'https://shop.test/cart',
  title: 'Корзина',
  viewport: { w: 1280, h: 800, dpr: 1 },
  scroll: { x: 0, y: 0, w: 1280, h: 1600 },
  frameworks: ['react-ish'],
  counts: { shadowRoots: 0, frames: 0 },
  cssVars: { '--brand': '#1a73e8' },
  nodes: [
    {
      i: 0,
      p: -1,
      tag: 'button',
      id: 'buy',
      cls: ['btn'],
      role: 'button',
      name: '',
      text: 'Купить',
      attrs: { 'data-testid': 'buy' },
      rect: { x: 10, y: 20, w: 120, h: 40 },
      vis: true,
      d: 3,
      sel: { best: '#buy', unique: true, candidates: [{ selector: '#buy', matches: 1 }] }
    }
  ],
  styles: { 0: { color: 'rgb(255,255,255)' } },
  html: '<button id="buy" data-testid="buy">Купить</button>'
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')

/** Minimal but protocol-accurate fake extension. */
function startFakeExtension(port, token, state) {
  let running = true
  const postEntry = () =>
    fetch(`http://127.0.0.1:${port}/v1/evt`, {
      method: 'POST',
      headers: { 'x-site-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'net',
        entries: [
          {
            id: 'live-1',
            method: 'POST',
            url: 'https://shop.test/api/order',
            status: 201,
            type: 'fetch',
            request: { headers: { 'content-type': 'application/json', 'x-csrf-token': '«redacted»' }, body: '{"sku":"A1"}' },
            response: { headers: {}, body: '{"id":42}' }
          }
        ]
      })
    })

  const handle = async (op, args) => {
    if (op === 'tab.claim') return { target: state.target }
    if (op === 'tabs.list') return { tabs: [{ id: 1, title: 'Корзина', url: state.target.url, target: true }] }
    if (op === 'dom.snapshot') return snapshotFixture
    if (op === 'net.start') {
      // a real page keeps talking while capture is on: replay one BFF call,
      // and report the recording flag the way the real worker does
      await fetch(`http://127.0.0.1:${port}/v1/evt`, {
        method: 'POST',
        headers: { 'x-site-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'netcontrol', recording: true })
      })
      await postEntry()
      return { recording: true }
    }
    if (op === 'net.stop') {
      await fetch(`http://127.0.0.1:${port}/v1/evt`, {
        method: 'POST',
        headers: { 'x-site-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'netcontrol', recording: false })
      })
      return { recording: false, captured: 1 }
    }
    if (op === 'net.clear') return { captured: 0 }
    if (op === 'act') return { ok: true, results: (args.steps ?? []).map((step) => ({ op: step.op, ok: true })) }
    if (op === 'shot') return { png: PNG }
    if (op === 'inject') return { injected: true, value: { anchor: true, node: true } }
    if (op === 'cursor') return { x: args.x, y: args.y, clicked: args.click === true }
    throw new Error(`fake extension got unknown op ${op}`)
  }
  const loop = async () => {
    while (running) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/poll?timeout=1500`, {
          headers: { 'x-site-token': token, 'content-type': 'application/json' }
        })
        if (!response.ok) throw new Error(`poll ${response.status}`)
        const body = await response.json()
        for (const command of body.commands ?? []) {
          const data = await handle(command.op, command.args)
          await fetch(`http://127.0.0.1:${port}/v1/result`, {
            method: 'POST',
            headers: { 'x-site-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({ id: command.id, ok: true, data })
          })
        }
      } catch {
        await sleep(120)
      }
    }
  }
  void loop()
  return { stop: () => { running = false } }
}

async function credentials() {
  return JSON.parse(await readFile(join(DSH_HOME, 'site-bridge', 'bridge.json'), 'utf8'))
}

test('host half registers every tool and drives the bridge', async (t) => {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(CAPTURES, { recursive: true })

  apply(ctx, { port: 47401, settleMs: 30 })
  const creds = await waitFor('bridge credentials', credentials)
  t.after(() => effects[effects.length - 1]?.())

  for (const name of ['site_status', 'site_tabs', 'site_capture', 'site_network', 'site_act', 'site_cursor', 'site_inject']) {
    assert.ok(tools.has(name), `tool ${name} registered`)
  }

  const offline = await tools.get('site_status').execute({}, {})
  assert.equal(offline.ok, true)
  assert.equal(offline.connected, false)

  const fake = startFakeExtension(creds.port, creds.token, {
    target: { id: 1, url: 'https://shop.test/cart', title: 'Корзина' }
  })
  t.after(() => fake.stop())

  const post = (payload) =>
    fetch(`http://127.0.0.1:${creds.port}/v1/evt`, {
      method: 'POST',
      headers: { 'x-site-token': creds.token, 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })

  await post({ kind: 'hello', version: '0.1.0', browser: 'Chrome/156' })
  await post({ kind: 'target', tab: { id: 1, url: 'https://shop.test/cart', title: 'Корзина' } })

  const online = await waitFor('bridge to see the client', async () => {
    const status = await tools.get('site_status').execute({}, {})
    return status.connected ? status : null
  })
  assert.equal(online.ok, true)
  assert.match(online.summary, /shop\.test/)

  const tabs = await tools.get('site_tabs').execute({ action: 'list' }, {})
  assert.match(tabs.summary, /\[1\]/)

  await tools.get('site_network').execute({ action: 'start' }, {})
  await post({
    kind: 'net',
    entries: [
      {
        id: 'e1',
        method: 'POST',
        url: 'https://shop.test/api/order',
        status: 201,
        type: 'fetch',
        request: { headers: { 'content-type': 'application/json', 'x-csrf-token': '«redacted»' }, body: '{"sku":"A1"}' },
        response: { headers: {}, body: '{"id":42}' }
      }
    ]
  })
  const list = await tools.get('site_network').execute({ action: 'list' }, {})
  assert.match(list.summary, /api\/order/)
  const one = await tools.get('site_network').execute({ action: 'get', id: 'e1' }, {})
  assert.match(one.summary, /"sku":"A1"/)
  await tools.get('site_network').execute({ action: 'stop' }, {})

  const act = await tools.get('site_act').execute(
    { steps: JSON.stringify([{ op: 'click', selector: '#buy' }, { op: 'type', selector: '#q', value: 'x' }]) },
    {}
  )
  assert.equal(act.ok, true)
  assert.match(act.summary, /click/)

  const cursor = await tools.get('site_cursor').execute({ x: 100, y: 200, click: true }, {})
  assert.match(cursor.summary, /кликнул/)

  const injected = await tools.get('site_inject').execute({ js: 'return 1' }, {})
  assert.match(injected.summary, /anchor/)

  const capture = await tools.get('site_capture').execute({ screenshot: true }, { agent: { id: 'test-agent' } })
  assert.equal(capture.ok, true, capture.summary)
  const files = await readdir(capture.dir)
  assert.ok(files.includes('api.md') && files.includes('dom.json') && files.includes('screenshot.png'), files.join(','))
  const api = await readFile(join(capture.dir, 'api.md'), 'utf8')
  assert.match(api, /## POST \/api\/order/)
  // traffic recorded before site_capture must survive it (that is the whole
  // point of "start recording, click, then capture")
  assert.ok(capture.requests >= 1, `expected recorded requests in the bundle, got ${capture.requests}`)
  // and the bundle belongs to the session workspace, not to the DSH profile
  assert.ok(
    capture.dir.startsWith(join(WORKSPACE, 'captures')),
    `capture must land in the workspace, got ${capture.dir}`
  )

  // a dedicated screenshot tool: writes a file, never base64 into the model
  const shot = await tools.get('site_shot').execute({ fullPage: true }, { agent: { id: 'test-agent' } })
  assert.equal(shot.ok, true, shot.summary)
  assert.ok(shot.file.endsWith('.png'), shot.file)
  assert.ok(shot.bytes > 0, `empty screenshot: ${shot.bytes}`)
  const shotBytes = await readFile(shot.file)
  assert.ok(shotBytes.length > 0)
  assert.match(shot.summary, /вся страница/)

  const viewportShot = await tools.get('site_shot').execute({ name: 'viewport-test' }, { agent: { id: 'test-agent' } })
  assert.ok(viewportShot.file.endsWith('viewport-test.png'), viewportShot.file)
  assert.match(viewportShot.summary, /видимая область/)
})

test('a tool without a connected browser explains what to do', async () => {
  await rm(join(OUT, 'dsh-home-2'), { recursive: true, force: true })
  process.env.DSH_HOME = join(OUT, 'dsh-home-2')
  const local = new Map()
  const localEffects = []
  const localCtx = {
    tools: { register: (spec) => local.set(spec.name, spec) },
    logger: { info() {}, warn() {} },
    effect: (fn) => localEffects.push(fn()),
    get: () => undefined
  }
  const { apply: applyAgain } = await import('../lib/index.js?isolated=1')
  applyAgain(localCtx, { port: 47402, captureDir: CAPTURES })
  const status = await waitFor('second bridge', async () => {
    const value = await local.get('site_status').execute({}, {})
    return value.port ? value : null
  })
  assert.equal(status.ok, true)
  await assert.rejects(
    local.get('site_act').execute({ steps: '[{"op":"click","selector":"#x"}]' }, {}),
    /браузер не подключён/
  )
  await localEffects[localEffects.length - 1]()
})
