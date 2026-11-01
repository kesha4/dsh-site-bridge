/**
 * Loopback bridge between the DSH host and the browser extension.
 *
 * Transport: plain HTTP on 127.0.0.1 with a shared secret header. The
 * extension long-polls for commands and posts results back. No WebSocket
 * dependency, survives service-worker restarts, and never leaves loopback.
 *
 * Every request must carry `x-site-token`. The token is generated once and
 * stored next to the DSH home so the pairing survives restarts.
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactEntry } from './redact.js'

const MAX_BODY_BYTES = 64 * 1024 * 1024
const POLL_MAX_MS = 25000
const NET_CAP = 2000
const PENDING_LIMIT = 64

/** Load the persisted {port, token} pair, creating it on first run. */
export async function loadOrCreateCredentials(homeDir, defaultPort) {
  const dir = join(homeDir, 'site-bridge')
  const file = join(dir, 'bridge.json')
  await mkdir(dir, { recursive: true })
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed?.token === 'string' && parsed.token.length >= 16) {
      return { port: Number(parsed.port) || defaultPort, token: parsed.token, file, created: false }
    }
  } catch {
    // missing or corrupt -> regenerate below
  }
  const credentials = { port: defaultPort, token: randomBytes(24).toString('base64url'), file, created: true }
  await writeFile(file, JSON.stringify({ port: credentials.port, token: credentials.token }, null, 2), 'utf8')
  return credentials
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-site-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function tokenMatches(expected, received) {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export class Bridge {
  /** @param {{port?: number, homeDir: string, token: string, log?: (msg: string) => void}} options */
  constructor(options) {
    this.host = '127.0.0.1'
    this.homeDir = options.homeDir
    this.token = options.token
    this.desiredPort = options.port ?? 47321
    this.log = options.log ?? (() => {})
    this.server = null
    this.port = 0
    this.seq = 0
    this.queue = []
    this.pending = new Map()
    this.waiters = []
    this.client = null
    this.target = null
    this.tabs = []
    this.net = []
    this.netRecording = false
    this.lastSeen = 0
    this.startedAt = 0
    this.lastError = null
  }

  async listen() {
    if (this.server) return { port: this.port }
    const server = createServer((req, res) => {
      this.#route(req, res).catch((error) => {
        this.lastError = String(error?.message ?? error)
        if (!res.headersSent) json(res, 500, { ok: false, error: this.lastError })
      })
    })
    server.keepAliveTimeout = 65000
    server.headersTimeout = 70000
    const attempts = 12
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = this.desiredPort + offset
      try {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.removeListener('error', onError)
            reject(error)
          }
          server.once('error', onError)
          server.listen(port, this.host, () => {
            server.removeListener('error', onError)
            resolve()
          })
        })
        this.server = server
        this.port = server.address()?.port ?? port
        this.startedAt = Date.now()
        this.log(`[site-bridge] listening on http://${this.host}:${port}`)
        return { port }
      } catch (error) {
        if (error?.code !== 'EADDRINUSE') throw error
      }
    }
    throw new Error(`no free port in ${this.desiredPort}..${this.desiredPort + attempts - 1}`)
  }

  async close() {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('bridge closed'))
      this.pending.delete(id)
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      try {
        json(waiter.res, 200, { ok: true, seq: this.seq, commands: [] })
      } catch {
        // client already gone
      }
    }
    this.waiters = []
    this.queue = []
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()))
      this.server = null
    }
  }

  state() {
    return {
      listening: this.server !== null,
      port: this.port,
      clientConnected: this.lastSeen > 0 && Date.now() - this.lastSeen < 20000,
      clientVersion: this.client?.version ?? null,
      clientBrowser: this.client?.browser ?? null,
      lastSeen: this.lastSeen || null,
      target: this.target,
      tabs: this.tabs,
      network: { recording: this.netRecording, captured: this.net.length },
      pendingCommands: this.pending.size,
      lastError: this.lastError
    }
  }

  /**
   * Queue a command for the extension and wait for its result.
   * @returns {Promise<unknown>}
   */
  enqueue(op, args = {}, options = {}) {
    const timeout = options.timeout ?? 45000
    if (this.pending.size >= PENDING_LIMIT) return Promise.reject(new Error('too many pending browser commands'))
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const command = { id, seq: id, op, args, ts: Date.now() }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.queue = this.queue.filter((item) => item.id !== id)
        reject(new Error(`browser did not answer «${op}» within ${timeout}ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.queue.push(command)
      this.#flush()
    })
  }

  #flush() {
    while (this.queue.length > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      clearTimeout(waiter.timer)
      json(waiter.res, 200, { ok: true, seq: this.seq, commands: this.queue.splice(0) })
    }
  }

  async #authorize(req) {
    const received = req.headers['x-site-token']
    if (tokenMatches(this.token, Array.isArray(received) ? received[0] : received)) return true
    return false
  }

  async #route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-site-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600'
      })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port || this.desiredPort}`)
    if (!(await this.#authorize(req))) {
      json(res, 401, { ok: false, error: 'bad or missing x-site-token' })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/ping') {
      json(res, 200, { ok: true, port: this.port, version: '0.1.0', recording: this.netRecording })
      return
    }

    // Only real browser traffic counts as liveness: a diagnostic /v1/state or
    // /v1/ping from the host must not make a dead extension look connected.
    if (url.pathname === '/v1/poll' || url.pathname === '/v1/result' || url.pathname === '/v1/evt') {
      this.lastSeen = Date.now()
    }

    if (req.method === 'GET' && url.pathname === '/v1/poll') {
      if (this.queue.length > 0) {
        json(res, 200, { ok: true, seq: this.seq, commands: this.queue.splice(0) })
        return
      }
      const requested = Number(url.searchParams.get('timeout') ?? 20000)
      const timeout = Math.min(POLL_MAX_MS, Math.max(1000, Number.isFinite(requested) ? requested : 20000))
      const waiter = { res }
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        json(res, 200, { ok: true, seq: this.seq, commands: [] })
      }, timeout)
      this.waiters.push(waiter)
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/result') {
      const body = await readBody(req)
      const id = Number(body.id)
      const entry = this.pending.get(id)
      if (!entry) {
        json(res, 200, { ok: true, ignored: true })
        return
      }
      this.pending.delete(id)
      clearTimeout(entry.timer)
      if (body.ok === false) entry.reject(new Error(String(body.error ?? 'browser command failed')))
      else entry.resolve(body.data ?? null)
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/evt') {
      const body = await readBody(req)
      this.#applyEvent(body)
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/state') {
      json(res, 200, { ok: true, ...this.state() })
      return
    }

    json(res, 404, { ok: false, error: `unknown route ${req.method} ${url.pathname}` })
  }

  #applyEvent(event) {
    const kind = String(event?.kind ?? '')
    if (kind === 'hello') {
      this.client = {
        version: String(event.version ?? 'unknown'),
        browser: String(event.browser ?? 'unknown'),
        at: Date.now()
      }
      return
    }
    if (kind === 'target') {
      const tab = event.tab
      this.target = tab && typeof tab === 'object'
        ? { id: Number(tab.id), url: String(tab.url ?? ''), title: String(tab.title ?? ''), at: Date.now() }
        : null
      return
    }
    if (kind === 'tabs') {
      this.tabs = Array.isArray(event.tabs) ? event.tabs.slice(0, 200) : []
      return
    }
    if (kind === 'netcontrol') {
      this.netRecording = event.recording === true
      return
    }
    if (kind === 'net') {
      const entries = Array.isArray(event.entries) ? event.entries : []
      for (const entry of entries) {
        this.net.push(redactEntry(entry))
      }
      if (this.net.length > NET_CAP) this.net.splice(0, this.net.length - NET_CAP)
      return
    }
    if (kind === 'netclear') {
      this.net = []
      return
    }
    if (kind === 'error') {
      this.lastError = String(event.message ?? 'unknown extension error')
      return
    }
  }

  /** Remove a captured entry from the ring buffer (by id). */
  forgetNetworkEntry(id) {
    this.net = this.net.filter((entry) => String(entry.id) !== String(id))
  }

  /** Reset captured traffic without touching the recording flag. */
  clearNetwork() {
    this.net = []
  }
}
