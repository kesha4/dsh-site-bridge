/**
 * DSH Site Bridge — MV3 service worker.
 *
 * Talks to the DSH host over a loopback long-poll bridge, and does all page
 * work over the Chrome DevTools Protocol through chrome.debugger:
 *
 *   - Network capture with real headers and bodies (CDP Network domain).
 *   - Trusted input: Input.dispatchMouseEvent / insertText / setFileInputFiles,
 *     i.e. events the page cannot tell apart from a human's.
 *   - Virtual cursor: a DOM overlay plus real pointer events at its position,
 *     for controls that ignore synthetic clicks.
 *   - Snapshot: markup tree, computed styles, selector candidates.
 *
 * No credentials are persisted here. Captured traffic is forwarded to the
 * host, which redacts and never writes it to disk.
 */

const EXT_VERSION = chrome.runtime.getManifest().version
const NET_CAP = 600
// Bodies are kept up to this size in the worker, then marked as truncated.
// Raise it per machine with chrome.storage.local.set({ maxBodyChars }): the
// host writes oversized bodies to files instead of printing them.
const DEFAULT_MAX_BODY_CHARS = 5_000_000

const state = {
  // One entry per attached tab. Every command resolves a tab (explicitly or
  // the active one), so several tabs can be driven without extra UI.
  sessions: new Map(),
  activeTabId: null,
  // Tab pinned for the duration of one command, so `args.tabId` reaches every
  // helper (cdp, snapshot, steps) without threading it through each call.
  commandTabId: null,
  dirty: [],
  flushing: false,
  lastPollOk: 0,
  // Consecutive failed polls: the popup turns this into "waiting, attempt N".
  attempts: 0,
  maxBodyChars: DEFAULT_MAX_BODY_CHARS
}

function activeSession() {
  return state.activeTabId == null ? null : state.sessions.get(state.activeTabId) ?? null
}

function sessionOf(tabId) {
  const wanted = tabId == null || tabId === '' ? state.commandTabId ?? state.activeTabId : Number(tabId)
  return wanted == null ? null : state.sessions.get(wanted) ?? null
}

function requireSession(tabId) {
  const session = sessionOf(tabId)
  if (session) return session
  throw new Error(tabId == null || tabId === '' ? 'no page attached: claim a tab first' : `tab ${tabId} is not attached`)
}

/* ------------------------------------------------------------------ config */

async function loadCfg() {
  const stored = await chrome.storage.local.get({ port: 47321, token: '', maxBodyChars: DEFAULT_MAX_BODY_CHARS })
  state.maxBodyChars = Number(stored.maxBodyChars) || DEFAULT_MAX_BODY_CHARS
  return { port: Number(stored.port) || 47321, token: String(stored.token || '') }
}

function baseUrl(cfg) {
  return `http://127.0.0.1:${cfg.port}`
}

async function api(cfg, path, init = {}) {
  const response = await fetch(baseUrl(cfg) + path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-site-token': cfg.token, ...(init.headers || {}) }
  })
  if (!response.ok) throw new Error(`bridge HTTP ${response.status}`)
  return response.json()
}

async function evt(kind, payload = {}) {
  const cfg = await loadCfg()
  if (!cfg.token) return
  try {
    await api(cfg, '/v1/evt', { method: 'POST', body: JSON.stringify({ kind, ...payload }) })
  } catch {
    // bridge offline: capture keeps working, nothing to report to
  }
}

/* --------------------------------------------------------------- lifecycle */

let looping = false

/** Runs a promise with a deadline, so one stuck Chrome call cannot park the loop. */
function withDeadline(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} не ответил за ${ms} мс`)), ms))
  ])
}

async function ensureLoop() {
  if (looping) return
  looping = true
  let greeted = false
  try {
    for (;;) {
      state.lastTick = Date.now()
      try {
        const cfg = await loadCfg()
        if (!cfg.token) {
          await sleep(1500)
          continue
        }
        const reply = await api(cfg, '/v1/poll?timeout=20000')
        if (!greeted) {
          greeted = true
          await evt('hello', { version: EXT_VERSION, browser: navigator.userAgent })
          for (const session of state.sessions.values()) {
            await evt('target', { tab: session.target })
            await evt('netcontrol', { recording: session.recording, tabId: session.tabId })
          }
          if (state.activeTabId != null) await evt('active', { tabId: state.activeTabId })
        }
        state.lastPollOk = Date.now()
        state.lastError = null
        state.attempts = 0
        for (const command of reply.commands || []) {
          // Sequential: a command may pin a tab for its whole duration.
          await withDeadline(runCommand(cfg, command), 120000, `команда ${command?.op ?? '?'}`)
        }
      } catch (error) {
        greeted = false
        state.lastError = String(error?.message ?? error)
        state.attempts = (state.attempts || 0) + 1
        await sleep(1200)
      }
    }
  } finally {
    looping = false
  }
}

// If the loop parks on a Chrome call that never settles, restart it.
setInterval(() => {
  if (!looping) return
  if (Date.now() - (state.lastTick ?? 0) > 90000) {
    state.lastError = 'цикл опроса завис, перезапускаю'
    looping = false
    void ensureLoop()
  }
}, 30000)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runCommand(cfg, command) {
  let payload
  const previousTab = state.commandTabId
  state.commandTabId = command.args?.tabId == null ? null : Number(command.args.tabId)
  try {
    const data = await handle(command.op, command.args || {})
    payload = { id: command.id, ok: true, data }
  } catch (error) {
    payload = { id: command.id, ok: false, error: String(error?.message ?? error) }
  } finally {
    state.commandTabId = previousTab
  }
  try {
    await api(cfg, '/v1/result', { method: 'POST', body: JSON.stringify(payload) })
  } catch {
    // result lost: the host will time the command out; nothing else to do
  }
}

chrome.runtime.onStartup.addListener(() => void ensureLoop())
chrome.runtime.onInstalled.addListener(() => void ensureLoop())
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }))
  return true
})

function handleMessage(message) {
  return handleMessageInner(message)
}

async function handleMessageInner(message) {
  if (message?.type === 'claim') {
    const target = await claimTab(message.tabId, 'user')
    return { ok: true, target }
  }
  if (message?.type === 'use') {
    const tabId = Number(message.tabId)
    const session = state.sessions.get(tabId)
    if (!session) throw new Error(`tab ${tabId} is not attached`)
    state.activeTabId = tabId
    await evt('active', { tabId })
    return { ok: true, target: session.target }
  }
  if (message?.type === 'status') {
    const cfg = await loadCfg()
    const active = activeSession()
    return {
      ok: true,
      configured: cfg.token !== '',
      port: cfg.port,
      connected: state.lastPollOk > 0 && Date.now() - state.lastPollOk < 45000,
      lastError: state.lastError ?? null,
      attempts: state.attempts || 0,
      loopAlive: looping,
      lastTickAgoMs: state.lastTick ? Date.now() - state.lastTick : null,
      target: active?.target ?? null,
      activeTabId: state.activeTabId,
      targets: [...state.sessions.values()].map((session) => ({
        ...session.target,
        recording: session.recording,
        captured: session.entries.length
      })),
      // Aggregates: the popup shows every attached tab, so "capture on" means
      // "at least one is recording" and the counter is the sum.
      recording: [...state.sessions.values()].some((session) => session.recording),
      captured: [...state.sessions.values()].reduce((sum, session) => sum + session.entries.length, 0),
      picking: active?.picking === true,
      picks: active?.picks?.length ?? 0
    }
  }
  if (message?.type === 'pick-arm') {
    const session = requireSession(message.tabId)
    await armPicker(session.tabId)
    session.picking = true
    return { ok: true, picking: true }
  }
  if (message?.type === 'save') {
    await chrome.storage.local.set({ port: Number(message.port) || 47321, token: String(message.token || '') })
    state.lastPollOk = 0
    void ensureLoop()
    return { ok: true }
  }
  if (message?.type === 'release') {
    await detach(message.tabId == null || message.tabId === '' ? state.activeTabId : Number(message.tabId))
    return { ok: true }
  }
  if (message?.type === 'toggle-capture') {
    const on = message.on === true
    if (message.tabId == null || message.tabId === '') {
      for (const session of state.sessions.values()) await setRecording(session, on)
      return { ok: true, recording: on, tabs: state.sessions.size }
    }
    const session = requireSession(message.tabId)
    return { ok: true, recording: await setRecording(session, on) }
  }
  return { ok: false, error: `unknown message ${message?.type}` }
}

/* --------------------------------------------------------------- debugging */

async function cdp(method, params = {}, tabId) {
  const session = requireSession(tabId)
  return chrome.debugger.sendCommand({ tabId: session.tabId }, method, params)
}

async function detach(tabId) {
  const session = state.sessions.get(Number(tabId))
  if (!session) return
  state.sessions.delete(session.tabId)
  if (state.activeTabId === session.tabId) {
    state.activeTabId = state.sessions.size > 0 ? [...state.sessions.keys()][0] : null
  }
  await evt('target', { tab: null, tabId: session.tabId })
  await chrome.debugger.detach({ tabId: session.tabId }).catch(() => {})
}

async function attach(tabId, attachedBy = 'agent') {
  const existing = state.sessions.get(tabId)
  if (existing) {
    state.activeTabId = tabId
    await evt('active', { tabId })
    return existing.target
  }
  const tab = await chrome.tabs.get(tabId)
  // Register the session before talking to the debugger: a child-frame event can
  // arrive the moment auto-attach is armed, and the listener drops events for
  // tabs it does not know yet.
  const session = {
    tabId,
    attachedBy,
    target: { id: tab.id, url: tab.url, title: tab.title, attachedBy },
    recording: false,
    entries: [],
    picking: false,
    picks: [],
    children: new Map()
  }
  state.sessions.set(tabId, session)
  state.activeTabId = tabId
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (error) {
    state.sessions.delete(tabId)
    throw new Error(`chrome.debugger.attach отказал: ${String(error?.message ?? error)}`)
  }
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxTotalBufferSize: 64_000_000,
    maxResourceBufferSize: 16_000_000,
    maxPostDataSize: 1_000_000
  })
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {})
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable').catch(() => {})
  // Cross-origin frames are separate targets; attach to them so their network
  // and DOM are reachable.
  await chrome.debugger
    .sendCommand({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false })
    .catch(() => {})
  await evt('target', { tab: session.target })
  await evt('active', { tabId })
  return session.target
}

async function claimTab(tabId, attachedBy = 'agent') {
  // Without an explicit id, claim whatever tab the user is looking at, so a
  // caller that only knows "this tab" cannot silently pass NaN.
  let id = Number(tabId)
  if (!Number.isFinite(id)) {
    const candidates = await chrome.tabs
      .query({ active: true, lastFocusedWindow: true, windowType: 'normal' })
      .catch(() => [])
    const active = candidates.find((tab) => /^(https?|file):/.test(tab.url ?? '')) ?? candidates[0]
    id = active?.id
  }
  if (!Number.isFinite(id)) throw new Error('no tab to claim: pass tabId or open a page first')
  let tab = null
  try {
    tab = await chrome.tabs.get(id)
  } catch (error) {
    // Chrome refuses to read pages of other extensions and its own service
    // pages; say that in words a person can act on.
    const detail = String(error?.message ?? error)
    const hint = /chrome-extension:\/\//.test(detail)
      ? ' Похоже, вкладка открыта в окне-приложении другого расширения — откройте её как обычную вкладку.'
      : ''
    throw new Error(`эту вкладку нельзя подключить: ${detail}${hint}`)
  }
  if (!/^https?:|^file:/.test(tab.url ?? '')) {
    const scheme = String(tab.url ?? '').split(':')[0] || 'неизвестная схема'
    throw new Error(
      `эту страницу нельзя подключить (${scheme}:): Chrome не даёт доступ к служебным страницам и страницам других расширений. Откройте обычный сайт http(s) или file://`
    )
  }
  return attach(id, attachedBy)
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const session = state.sessions.get(tabId)
  if (!session) return
  const next = { id: tab.id, url: tab.url, title: tab.title, attachedBy: session.attachedBy }
  if (next.title === session.target.title && next.url === session.target.url) return
  session.target = next
  void evt('target', { tab: next, tabId })
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!state.sessions.has(tabId)) return
  state.sessions.delete(tabId)
  if (state.activeTabId === tabId) {
    state.activeTabId = state.sessions.size > 0 ? [...state.sessions.keys()][0] : null
  }
  void evt('target', { tab: null, tabId })
  void evt('active', { tabId: state.activeTabId })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  const session = state.sessions.get(source.tabId)
  if (!session) return
  state.sessions.delete(source.tabId)
  if (state.activeTabId === source.tabId) {
    state.activeTabId = state.sessions.size > 0 ? [...state.sessions.keys()][0] : null
  }
  void evt('target', { tab: null, tabId: source.tabId })
  if (reason !== 'target_closed') void evt('error', { message: `debugger detached: ${reason}` })
})

/* ----------------------------------------------------------------- network */

const requests = new Map()

function keepEntry(session, entry) {
  entry.tabId = session.tabId
  session.entries.push(entry)
  state.dirty.push({ tabId: session.tabId, entry })
  if (session.entries.length > NET_CAP) session.entries.splice(0, session.entries.length - NET_CAP)
  scheduleFlush()
}

function scheduleFlush() {
  if (state.flushing) return
  state.flushing = true
  setTimeout(() => {
    state.flushing = false
    const batch = state.dirty.splice(0)
    if (batch.length === 0) return
    const byTab = new Map()
    for (const item of batch) {
      if (!byTab.has(item.tabId)) byTab.set(item.tabId, [])
      byTab.get(item.tabId).push(item.entry)
    }
    for (const [tabId, entries] of byTab) void evt('net', { tabId, entries })
  }, 400)
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function registrable(host) {
  const parts = String(host).split('.').filter(Boolean)
  return parts.length <= 2 ? String(host) : parts.slice(-2).join('.')
}

function shouldCapture(params, pageUrl) {
  // Only real API calls of the site being inspected.
  const kind = String(params.type ?? '').toLowerCase()
  if (kind !== 'xhr' && kind !== 'fetch') return false
  const targetHost = hostOf(params.request?.url)
  const pageHost = hostOf(pageUrl)
  if (targetHost === '' || pageHost === '') return true
  if (targetHost === pageHost) return true
  if (registrable(targetHost) === registrable(pageHost)) return true
  // Third-party endpoint: only when it actually speaks JSON. This keeps the
  // page's own HTML out of the bundle — some extensions and analytics post a
  // full page dump to their servers, inline tokens included.
  const mime = String(params.response?.mimeType ?? '').toLowerCase()
  return mime.includes('json')
}

/* ------------------------------------------------------- OOPIF (child frames) */

// chrome.debugger cannot address a child target by id ("No target with given
// id"), so a cross-origin frame is driven through Target.sendMessageToTarget and
// its events arrive as Target.receivedMessageFromTarget. Without this, traffic
// and DOM inside such a frame stay invisible.
const tunnelWaiters = new Map()
let tunnelSeq = 100000

function tunnelSend(tabId, sessionId, method, params = {}, timeoutMs = 15000) {
  const id = ++tunnelSeq
  const message = JSON.stringify({ id, method, params })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnelWaiters.delete(id)
      reject(new Error(`${method} не ответил за ${timeoutMs} мс`))
    }, timeoutMs)
    tunnelWaiters.set(id, { resolve, reject, timer })
    chrome.debugger
      .sendCommand({ tabId }, 'Target.sendMessageToTarget', { sessionId, message })
      .catch((error) => {
        clearTimeout(timer)
        tunnelWaiters.delete(id)
        reject(error)
      })
  })
}

async function watchChildFrame(session, sessionId) {
  if (!session.children) session.children = new Map()
  if (session.children.has(sessionId)) return
  session.children.set(sessionId, { sessionId, url: null })
  await Promise.all([
    tunnelSend(session.tabId, sessionId, 'Network.enable', {
      maxTotalBufferSize: 64_000_000,
      maxResourceBufferSize: 16_000_000,
      maxPostDataSize: 1_000_000
    }).catch(() => {}),
    tunnelSend(session.tabId, sessionId, 'Runtime.enable', {}).catch(() => {})
  ])
}

function handleNetworkEvent(session, child, method, params) {
  const key = `${child ? child.sessionId : 'root'}:${params.requestId}`
  if (method === 'Network.requestWillBeSent') {
    // A child frame reports its own document URL; that is the page context its
    // requests belong to.
    if (child && !child.url) child.url = String(params.documentURL ?? '') || null
    if (!shouldCapture(params, child?.url || session.target?.url)) return
    requests.set(key, {
      id: params.requestId,
      ts: Date.now(),
      type: String(params.type ?? '').toLowerCase(),
      method: params.request.method,
      url: params.request.url,
      frame: child?.url ?? null,
      request: {
        headers: params.request.headers || {},
        body: params.request.postData ?? null
      },
      status: null,
      mimeType: params.response?.mimeType ?? null,
      response: { headers: {}, body: null },
      failed: null
    })
    return
  }
  if (method === 'Network.responseReceived') {
    const entry = requests.get(key)
    if (!entry) return
    entry.status = params.response.status
    entry.mimeType = params.response.mimeType
    entry.response.headers = params.response.headers || {}
    return
  }
  if (method === 'Network.loadingFinished') {
    const entry = requests.get(key)
    if (!entry) return
    requests.delete(key)
    const bodyRequest = child
      ? tunnelSend(session.tabId, child.sessionId, 'Network.getResponseBody', { requestId: params.requestId }).catch(() => null)
      : chrome.debugger
          .sendCommand({ tabId: session.tabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .catch(() => null)
    bodyRequest
      .then((payload) => {
        const { body, base64Encoded } = payload ?? {}
        const text = String(body ?? '')
        if (base64Encoded) {
          entry.response.base64Chars = text.length
          entry.response.note = 'base64 body not stored'
        } else {
          const limit = Number(state.maxBodyChars) || DEFAULT_MAX_BODY_CHARS
          entry.response.body = text.slice(0, limit)
          entry.response.bodyChars = text.length
          if (text.length > limit) {
            entry.response.truncated = true
            entry.response.truncatedAt = limit
          }
        }
        if (session.recording) keepEntry(session, entry)
      })
      .catch(() => {
        entry.response.body = null
        if (session.recording) keepEntry(session, entry)
      })
    return
  }
  if (method === 'Network.loadingFailed') {
    const entry = requests.get(key)
    if (!entry) return
    entry.failed = params.errorText || 'failed'
    requests.delete(key)
    if (session.recording) keepEntry(session, entry)
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = state.sessions.get(source.tabId)
  if (!session) return
  try {
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo ?? {}
      if (info.type === 'iframe') void watchChildFrame(session, params.sessionId)
      return
    }
    if (method === 'Target.detachedFromTarget') {
      session.children?.delete(params.sessionId)
      return
    }
    if (method === 'Target.receivedMessageFromTarget') {
      let message = null
      try {
        message = JSON.parse(params.message)
      } catch {
        return
      }
      if (!message) return
      if (message.id && tunnelWaiters.has(message.id)) {
        const waiter = tunnelWaiters.get(message.id)
        tunnelWaiters.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error(String(message.error.message ?? 'tunnel error')))
        else waiter.resolve(message.result ?? {})
        return
      }
      if (typeof message.method === 'string' && message.method.startsWith('Network.')) {
        const child = session.children?.get(params.sessionId) ?? { sessionId: params.sessionId, url: null }
        handleNetworkEvent(session, child, message.method, message.params ?? {})
      }
      return
    }
    if (method.startsWith('Network.')) handleNetworkEvent(session, null, method, params)
  } catch {
    // never let a capture bug break the debugger session
  }
})

async function setRecording(session, on) {
  if (on) {
    session.entries = []
    state.dirty = state.dirty.filter((item) => item.tabId !== session.tabId)
    requests.clear()
    session.recording = true
  } else {
    session.recording = false
  }
  await evt('netcontrol', { recording: session.recording, tabId: session.tabId })
  return session.recording
}

/* ------------------------------------------------------------------ picker */

/**
 * Injected into the page: highlights the element under the cursor, and on click
 * asks for a note, then publishes the result on `window.__dshPickResult`.
 * Enter saves, Shift+Enter adds a line, Escape cancels the whole pick.
 */
function pickerInPage() {
  const HOST_ID = '__dsh_pick_overlay__'
  document.getElementById(HOST_ID)?.remove()
  window.__dshPickResult = null

  const box = document.createElement('div')
  box.id = HOST_ID
  box.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0', 'z-index:2147483646',
    'pointer-events:none', 'border:2px solid #5b7cff', 'border-radius:4px',
    'background:rgba(91,124,255,.12)'
  ].join(';')

  const tip = document.createElement('div')
  tip.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'background:#14161b',
    'color:#e8eaf0', 'border:1px solid #2a2f3a', 'border-radius:4px', 'padding:2px 6px',
    'font:11px/1.5 monospace', 'max-width:70vw', 'white-space:nowrap', 'overflow:hidden',
    'text-overflow:ellipsis'
  ].join(';')
  tip.hidden = true
  document.documentElement.append(box, tip)

  const cssEsc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'))
  const count = (selector) => {
    try { return document.querySelectorAll(selector).length } catch { return -1 }
  }

  function selectorFor(el) {
    const candidates = []
    if (el.id) candidates.push('#' + cssEsc(el.id))
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const value = el.getAttribute(attr)
      if (value) candidates.push('[' + attr + '="' + value.replace(/"/g, '\\"') + '"]')
    }
    if (el.getAttribute('name')) {
      candidates.push(el.tagName.toLowerCase() + '[name="' + el.getAttribute('name').replace(/"/g, '\\"') + '"]')
    }
    if (el.getAttribute('aria-label')) {
      candidates.push('[aria-label="' + el.getAttribute('aria-label').replace(/"/g, '\\"') + '"]')
    }
    const classes = [...el.classList].filter((name) => /^[a-zA-Z][\w-]{2,}$/.test(name)).slice(0, 2)
    if (classes.length > 0) {
      candidates.push(el.tagName.toLowerCase() + classes.map((name) => '.' + cssEsc(name)).join(''))
    }
    const parts = []
    let current = el
    while (current && current.nodeType === 1 && parts.length < 8) {
      let part = current.tagName.toLowerCase()
      if (current.id) { parts.unshift('#' + cssEsc(current.id)); break }
      const parent = current.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((node) => node.tagName === current.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(part)
      current = parent
    }
    candidates.push(parts.join(' > '))
    const unique = candidates.find((selector) => count(selector) === 1)
    return unique ?? candidates[candidates.length - 1]
  }

  function xpathFor(el) {
    if (el.id && count('#' + cssEsc(el.id)) === 1) return '//*[@id="' + el.id + '"]'
    const parts = []
    let current = el
    while (current && current.nodeType === 1) {
      let index = 1
      let sibling = current.previousElementSibling
      while (sibling) {
        if (sibling.tagName === current.tagName) index += 1
        sibling = sibling.previousElementSibling
      }
      const total = current.parentElement
        ? [...current.parentElement.children].filter((node) => node.tagName === current.tagName).length
        : 1
      parts.unshift(current.tagName.toLowerCase() + (total > 1 ? '[' + index + ']' : ''))
      current = current.parentElement
    }
    return '/' + parts.join('/')
  }

  let panel = null
  let hovered = null

  function highlight(el) {
    const rect = el.getBoundingClientRect()
    box.style.left = rect.left + 'px'
    box.style.top = rect.top + 'px'
    box.style.width = rect.width + 'px'
    box.style.height = rect.height + 'px'
    tip.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
    tip.hidden = false
    tip.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 40)) + 'px'
    tip.style.top = Math.max(2, rect.top - 20) + 'px'
  }

  function hideBox() {
    box.style.width = '0'
    box.style.height = '0'
    tip.hidden = true
  }

  function onMove(event) {
    if (panel) return
    const el = document.elementFromPoint(event.clientX, event.clientY)
    if (!el || el === box || el === tip || (panel && panel.contains(el))) return
    hovered = el
    highlight(el)
  }

  function onClick(event) {
    if (panel) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (hovered) askNote(hovered)
  }

  function onKey(event) {
    if (event.key === 'Escape' && !panel) finish(null, true)
  }

  function askNote(el) {
    const rect = el.getBoundingClientRect()
    panel = document.createElement('div')
    panel.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'background:#14161b', 'color:#e8eaf0',
      'border:1px solid #5b7cff', 'border-radius:8px', 'padding:8px', 'width:260px',
      'font:12px/1.45 "Segoe UI",system-ui,sans-serif', 'box-shadow:0 8px 24px rgba(0,0,0,.45)'
    ].join(';')
    panel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 272)) + 'px'
    panel.style.top = Math.min(window.innerHeight - 120, Math.max(8, rect.bottom + 8)) + 'px'

    const hint = document.createElement('div')
    hint.textContent = 'Note — Enter to save, Esc to cancel'
    hint.style.cssText = 'color:#99a1ae;font-size:11px;margin-bottom:4px'

    const input = document.createElement('textarea')
    input.placeholder = 'what is this element for?'
    input.style.cssText = 'width:100%;height:46px;resize:none;background:#15181e;color:#e8eaf0;border:1px solid #2a2f3a;border-radius:6px;padding:5px;font:inherit'

    panel.append(hint, input)
    document.documentElement.appendChild(panel)
    input.focus()

    input.addEventListener('mousedown', (event) => event.stopPropagation())
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        closePanel()
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        finish(el, false, input.value.trim())
      }
    })
  }

  function closePanel() {
    panel?.remove()
    panel = null
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    box.remove()
    tip.remove()
    closePanel()
    window.__dshPicker = null
  }

  function finish(el, cancelled, note) {
    const rect = el ? el.getBoundingClientRect() : null
    closePanel()
    cleanup()
    window.__dshPickResult = cancelled || !el
      ? { cancelled: true }
      : {
          selector: selectorFor(el),
          xpath: xpathFor(el),
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
          tag: el.tagName.toLowerCase(),
          note: note || '',
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
          url: location.href,
          at: Date.now()
        }
  }

  hideBox()
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
  window.__dshPicker = { stop: () => finish(null, true) }
  return true
}

async function armPicker(tabId) {
  await cdp('Runtime.evaluate', { expression: `(${pickerInPage.toString()})()`, returnByValue: true }, tabId)
}

async function stopPicker(tabId) {
  await cdp('Runtime.evaluate', {
    expression: 'window.__dshPicker && window.__dshPicker.stop ? window.__dshPicker.stop() : null',
    returnByValue: true
  }, tabId).catch(() => {})
}

async function readPick(tabId) {
  const { result } = await cdp('Runtime.evaluate', {
    expression: 'window.__dshPickResult || null',
    returnByValue: true
  }, tabId)
  return result?.value ?? null
}

/**
 * Injected into the page: a compact list of what a person can act on, with a
 * stable selector for each, so the agent can pick one without reading the
 * whole snapshot bundle.
 */
function compactSnapshotInPage(options) {
  const limit = Math.max(1, Math.min(Number(options?.limit ?? 120), 400))
  const cssEsc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'))
  const count = (selector) => {
    try { return document.querySelectorAll(selector).length } catch { return -1 }
  }

  function selectorFor(el) {
    const candidates = []
    if (el.id) candidates.push('#' + cssEsc(el.id))
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const value = el.getAttribute(attr)
      if (value) candidates.push('[' + attr + '="' + value.replace(/"/g, '\\"') + '"]')
    }
    if (el.getAttribute('name')) {
      candidates.push(el.tagName.toLowerCase() + '[name="' + el.getAttribute('name').replace(/"/g, '\\"') + '"]')
    }
    if (el.getAttribute('aria-label')) {
      candidates.push('[aria-label="' + el.getAttribute('aria-label').replace(/"/g, '\\"') + '"]')
    }
    const classes = [...el.classList].filter((name) => /^[a-zA-Z][\w-]{2,}$/.test(name)).slice(0, 2)
    if (classes.length > 0) {
      candidates.push(el.tagName.toLowerCase() + classes.map((name) => '.' + cssEsc(name)).join(''))
    }
    const parts = []
    let current = el
    while (current && current.nodeType === 1 && parts.length < 8) {
      let part = current.tagName.toLowerCase()
      if (current.id) { parts.unshift('#' + cssEsc(current.id)); break }
      const parent = current.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((node) => node.tagName === current.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      parts.unshift(part)
      current = parent
    }
    candidates.push(parts.join(' > '))
    const unique = candidates.find((selector) => count(selector) === 1)
    return unique ?? candidates[candidates.length - 1]
  }

  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[contenteditable=""]', '[contenteditable="true"]', '[onclick]'
  ].join(',')

  const nodes = [...document.querySelectorAll(SELECTOR)]
  const items = []
  for (const el of nodes) {
    if (el.closest('#__dsh_pick_overlay__')) continue
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    const label = (el.getAttribute('aria-label') ?? '') ||
      (el.getAttribute('placeholder') ?? '') ||
      (el.innerText ?? '').trim().replace(/\s+/g, ' ') ||
      (el.getAttribute('title') ?? '') ||
      (el.getAttribute('value') ?? '')
    const item = {
      tag: el.tagName.toLowerCase(),
      name: String(label).slice(0, 80),
      selector: selectorFor(el),
      box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
    }
    if (el.getAttribute('type')) item.type = el.getAttribute('type')
    if (el.getAttribute('role')) item.role = el.getAttribute('role')
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') item.disabled = true
    if (el.checked === true) item.checked = true
    if (typeof el.value === 'string' && el.value !== '') item.value = el.value.slice(0, 60)
    if (el.href && el.tagName === 'A') item.href = String(el.href).slice(0, 200)
    items.push(item)
    if (items.length >= limit) break
  }

  return {
    url: location.href,
    title: document.title,
    total: nodes.length,
    returned: items.length,
    truncated: nodes.length > items.length,
    items
  }
}

/* ------------------------------------------------------------------ cursor */

const CURSOR_ID = '__dsh_site_bridge_cursor__'

function cursorBootstrap() {
  if (document.getElementById('__dsh_site_bridge_cursor__')) return
  const host = document.createElement('div')
  host.id = '__dsh_site_bridge_cursor__'
  host.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
    'z-index:2147483647', 'pointer-events:none', 'transition:transform 160ms cubic-bezier(.2,.7,.3,1)'
  ].join(';')
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  arrow.setAttribute('width', '20')
  arrow.setAttribute('height', '20')
  arrow.setAttribute('viewBox', '0 0 20 20')
  arrow.style.cssText = 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))'
  arrow.innerHTML =
    '<path d="M2 1.5 L2 15.5 L6 11.8 L8.6 17.8 L11.2 16.6 L8.6 10.8 L13.6 10.8 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>'
  host.appendChild(arrow)
  const ripple = document.createElement('div')
  ripple.id = '__dsh_site_bridge_ripple__'
  ripple.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:28px', 'height:28px', 'margin:-14px 0 0 -14px',
    'border-radius:50%', 'border:2px solid rgba(64,132,255,.95)', 'opacity:0',
    'transition:opacity 260ms ease-out, transform 260ms ease-out', 'transform:scale(.3)'
  ].join(';')
  host.appendChild(ripple)
  ;(document.documentElement || document.body).appendChild(host)
}

async function cursorMove(x, y) {
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const fn = ${cursorBootstrap.toString()};
      fn();
      const host = document.getElementById('${CURSOR_ID}');
      if (host) host.style.transform = 'translate(' + (${x}) + 'px,' + (${y}) + 'px)';
      return true;
    })()`,
    returnByValue: true
  })
}

async function cursorRipple(x, y) {
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const ripple = document.getElementById('__dsh_site_bridge_ripple__');
      if (!ripple) return false;
      ripple.style.left = '${x}px';
      ripple.style.top = '${y}px';
      ripple.style.opacity = '1';
      ripple.style.transform = 'scale(1)';
      setTimeout(() => { ripple.style.opacity = '0'; ripple.style.transform = 'scale(.3)'; }, 220);
      return true;
    })()`,
    returnByValue: true
  })
}

/* ------------------------------------------------------------------- input */

/**
 * Injected into every page evaluation: resolves a selector that may cross
 * shadow roots and same-origin iframes.
 *
 * Syntax: `host >>> inner`, any depth. A plain selector falls back to a search
 * across same-origin iframes, so most existing selectors keep working.
 * Returns { el, ox, oy } where ox/oy are the accumulated frame offsets in
 * top-window coordinates (Input.dispatchMouseEvent works in those).
 */
const PAGE_RESOLVER = `
  const __dshChildRoot = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try { return el.contentDocument || null; } catch { return null; }
    }
    return null;
  };
  const __dshFind = (selector) => {
    const parts = String(selector).split('>>>').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    let root = document, ox = 0, oy = 0, el = null;
    for (let i = 0; i < parts.length; i += 1) {
      el = root.querySelector(parts[i]);
      if (!el) return null;
      if (i < parts.length - 1) {
        const r = el.getBoundingClientRect();
        ox += r.left; oy += r.top;
        root = __dshChildRoot(el);
        if (!root) return null;
      }
    }
    return { el, ox, oy };
  };
  const __dshDeep = (selector) => {
    const hit = __dshFind(selector);
    if (hit) return hit;
    for (const frame of document.querySelectorAll('iframe')) {
      let doc = null;
      try { doc = frame.contentDocument; } catch { doc = null; }
      if (!doc) continue;
      let el = null;
      try { el = doc.querySelector(selector); } catch { el = null; }
      if (el) {
        const r = frame.getBoundingClientRect();
        return { el, ox: r.left, oy: r.top };
      }
    }
    return null;
  };
`

/** Evaluates in the page or in an attached child frame. */
async function evaluateInPage(session, child, expression) {
  if (!child) {
    const { result, exceptionDetails } = await chrome.debugger.sendCommand(
      { tabId: session.tabId },
      'Runtime.evaluate',
      { expression, returnByValue: true }
    )
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed')
    return result?.value
  }
  const payload = await tunnelSend(session.tabId, child.sessionId, 'Runtime.evaluate', { expression, returnByValue: true })
  if (payload?.exceptionDetails) {
    throw new Error(payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? 'evaluate failed in frame')
  }
  return payload?.result?.value
}

/** A child session whose URL matches the frame's src, or the only child. */
function findChildByUrl(session, src) {
  const children = [...(session.children?.values() ?? [])]
  if (children.length === 0) return null
  const wanted = String(src || '')
  const exact = children.find((child) => {
    if (!child.url || !wanted) return false
    const a = child.url.split('?')[0]
    const b = wanted.split('?')[0]
    return a === b || a.startsWith(b) || b.startsWith(a)
  })
  return exact ?? (children.length === 1 ? children[0] : null)
}

/**
 * Resolves `frame >>> inner`. A same-origin frame is left to the existing page
 * resolver; a cross-origin one hands the rest of the selector to its session and
 * remembers the frame's offset inside the page.
 */
async function selectorContext(session, selector) {
  const parts = String(selector).split('>>>').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return { child: null, selector: String(selector), dx: 0, dy: 0 }
  const frameSelector = parts[0]
  const inner = parts.slice(1).join(' >>> ')
  const frameHit = await evaluateInPage(session, null, `(() => {
    ${PAGE_RESOLVER}
    const found = __dshFind(${JSON.stringify(frameSelector)});
    if (!found) return null;
    const el = found.el;
    if (el.tagName !== 'IFRAME') return { notFrame: true };
    let cross = false;
    try { cross = !el.contentDocument; } catch { cross = true; }
    const r = el.getBoundingClientRect();
    return { x: r.left + found.ox, y: r.top + found.oy, src: String(el.src || ''), cross };
  })()`)
  if (!frameHit) throw new Error(`frame not found: ${frameSelector}`)
  if (!frameHit.cross) return { child: null, selector: String(selector), dx: 0, dy: 0 }
  const child = findChildByUrl(session, frameHit.src)
  if (!child) throw new Error(`cross-origin frame is not attached yet: ${frameHit.src}`)
  return { child, selector: inner, dx: frameHit.x, dy: frameHit.y }
}

async function elementCenter(selector) {
  const session = requireSession()
  const ctx = await selectorContext(session, selector)
  const value = await evaluateInPage(session, ctx.child, `(() => {
    ${PAGE_RESOLVER}
    const hit = __dshDeep(${JSON.stringify(ctx.selector)});
    if (!hit) return null;
    const el = hit.el;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { x: 0, y: 0, empty: true };
    return { x: r.left + r.width / 2 + hit.ox + ${ctx.dx}, y: r.top + r.height / 2 + hit.oy + ${ctx.dy}, w: r.width, h: r.height };
  })()`)
  if (!value) throw new Error(`element not found: ${selector}`)
  return value
}

async function mouseClick(x, y, { button = 'left', clickCount = 1 } = {}) {
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount })
}

async function typeInto(selector, value) {
  const center = await elementCenter(selector)
  await mouseClick(center.x, center.y)
  // select existing content so the insert replaces it, like a human would
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      ${PAGE_RESOLVER}
      const hit = __dshDeep(${JSON.stringify(selector)});
      if (!hit) return false;
      const el = hit.el;
      if (typeof el.select === 'function') el.select();
      else if (el.isContentEditable) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const selection = el.ownerDocument.defaultView.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return true;
    })()`,
    returnByValue: true
  })
  await cdp('Input.insertText', { text: String(value) })
}

/* ------------------------------------------------------------------- steps */

async function runSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps must be a non-empty array')
  const results = []
  for (const step of steps) {
    const op = String(step?.op ?? '')
    try {
      const detail = await runStep(op, step)
      results.push({ op, ok: true, ...detail })
      if (detail?.stop === true) break
    } catch (error) {
      results.push({ op, ok: false, error: String(error?.message ?? error) })
      break
    }
  }
  return { results, ok: results.every((item) => item.ok) }
}

async function runStep(op, step) {
  switch (op) {
    case 'exists': {
      const center = await cdp('Runtime.evaluate', {
        expression: `(() => {
          ${PAGE_RESOLVER}
          const hit = __dshDeep(${JSON.stringify(step.selector)});
          if (!hit) return null;
          const el = hit.el;
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height, visible: !!(el.offsetParent || r.width || r.height), frame: { ox: hit.ox, oy: hit.oy } };
        })()`,
        returnByValue: true
      })
      return { exists: Boolean(center.result?.value), box: center.result?.value ?? null }
    }
    case 'click': {
      if (typeof step.x === 'number' && typeof step.y === 'number') {
        await cursorMove(step.x, step.y)
        await cursorRipple(step.x, step.y)
        await mouseClick(step.x, step.y, step)
        return { clicked: { x: step.x, y: step.y } }
      }
      const center = await elementCenter(step.selector)
      await cursorMove(center.x, center.y)
      await cursorRipple(center.x, center.y)
      await mouseClick(center.x, center.y, step)
      return { clicked: { selector: step.selector, x: Math.round(center.x), y: Math.round(center.y) } }
    }
    case 'hover': {
      const center = await elementCenter(step.selector)
      await cursorMove(center.x, center.y)
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, buttons: 0 })
      return { hovered: step.selector }
    }
    case 'fill': {
      const fillSession = requireSession()
      const fillCtx = await selectorContext(fillSession, step.selector)
      const result = { value: await evaluateInPage(fillSession, fillCtx.child, `(() => {
          ${PAGE_RESOLVER}
          const hit = __dshDeep(${JSON.stringify(fillCtx.selector)});
          if (!hit) return { ok: false, error: 'not found' };
          const el = hit.el;
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, ${JSON.stringify(String(step.value ?? ''))});
          else el.value = ${JSON.stringify(String(step.value ?? ''))};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: el.value };
        })()`) }
      if (!result?.value?.ok) throw new Error(`fill failed for ${step.selector}: ${result?.value?.error ?? 'unknown'}`)
      return { filled: step.selector, value: result.value.value }
    }
    case 'type': {
      await typeInto(step.selector, step.value ?? '')
      return { typed: step.selector }
    }
    case 'select': {
      const selectSession = requireSession()
      const selectCtx = await selectorContext(selectSession, step.selector)
      const result = { value: await evaluateInPage(selectSession, selectCtx.child, `(() => {
          ${PAGE_RESOLVER}
          const hit = __dshDeep(${JSON.stringify(selectCtx.selector)});
          if (!hit) return { ok: false, error: 'not found' };
          const el = hit.el;
          const value = ${JSON.stringify(String(step.value ?? ''))};
          if (el instanceof HTMLSelectElement) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, value: el.value };
          }
          el.click();
          return { ok: true, custom: true };
        })()`) }
      if (!result?.value?.ok) throw new Error(`select failed for ${step.selector}`)
      return { selected: step.selector, value: result.value.value ?? null }
    }
    case 'press': {
      const key = String(step.key ?? 'Enter')
      const code = step.code ?? key
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vkFor(key) })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vkFor(key) })
      return { pressed: key }
    }
    case 'scroll': {
      if (step.selector) {
        await cdp('Runtime.evaluate', {
          expression: `(() => {
            ${PAGE_RESOLVER}
            const hit = __dshDeep(${JSON.stringify(step.selector)});
            if (!hit) return false;
            hit.el.scrollIntoView({ block: 'center' });
            return true;
          })()`,
          returnByValue: true
        })
        return { scrolledTo: step.selector }
      }
      const x = Number(step.x ?? 400)
      const y = Number(step.y ?? 400)
      await cdp('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: Number(step.dx ?? 0), deltaY: Number(step.dy ?? 600)
      })
      return { scrolled: { dx: Number(step.dx ?? 0), dy: Number(step.dy ?? 600) } }
    }
    case 'upload': {
      const files = Array.isArray(step.files) ? step.files : []
      if (files.length === 0) throw new Error('upload needs files: absolute paths on the DSH host')
      const { result } = await cdp('Runtime.evaluate', {
        expression: `(() => {
          ${PAGE_RESOLVER}
          const hit = __dshDeep(${JSON.stringify(step.selector)});
          return hit ? hit.el : null;
        })()`,
        returnByValue: false
      })
      if (!result?.objectId) throw new Error(`upload target not found: ${step.selector}`)
      try {
        await cdp('DOM.setFileInputFiles', { files, objectId: result.objectId })
      } finally {
        await cdp('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
      }
      return { uploaded: files.length, to: step.selector }
    }
    case 'goto': {
      if (step.back === true || step.forward === true) {
        await cdp('Runtime.evaluate', {
          expression: step.back === true ? 'history.back(); true' : 'history.forward(); true',
          returnByValue: true
        })
        return { navigated: step.back === true ? 'back' : 'forward' }
      }
      await cdp('Page.navigate', { url: String(step.url) })
      return { navigated: step.url }
    }
    case 'reload': {
      await cdp('Page.reload', { ignoreCache: step.hard === true })
      return { reloaded: true }
    }
    case 'wait': {
      if (step.ms) {
        await sleep(Math.min(Number(step.ms), 60000))
        return { waitedMs: Number(step.ms) }
      }
      if (step.state === 'settle') {
        const quietMs = Math.min(Number(step.quietMs ?? 400), 5000)
        const budget = Math.min(Number(step.timeoutMs ?? 15000), 60000)
        const { result } = await cdp('Runtime.evaluate', {
          expression: `new Promise((resolve) => {
            let timer = null;
            const done = () => { observer.disconnect(); resolve(true); };
            const restart = () => { clearTimeout(timer); timer = setTimeout(done, ${quietMs}); };
            const observer = new MutationObserver(restart);
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            restart();
            setTimeout(() => { observer.disconnect(); resolve(false); }, ${budget});
          })`,
          awaitPromise: true,
          returnByValue: true
        })
        if (result?.value !== true) throw new Error(`page did not settle within ${budget} ms`)
        return { settled: true, quietMs }
      }
      const wantHidden = step.state === 'hidden'
      const deadline = Date.now() + Math.min(Number(step.timeoutMs ?? 15000), 60000)
      let lastValue = null
      while (Date.now() < deadline) {
        const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
          expression: `(() => {
            ${PAGE_RESOLVER}
            const hit = __dshDeep(${JSON.stringify(step.selector)});
            if (!hit || !hit.el) return ${wantHidden ? 'true' : 'false'};
            if (${wantHidden ? 'true' : 'false'}) {
              const el = hit.el;
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ||
                (rect.width === 0 && rect.height === 0);
            }
            return true;
          })()`,
          returnByValue: true
        })
        if (exceptionDetails) throw new Error(`не удалось проверить ${step.selector}: ${exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'ошибка в странице'}`)
        lastValue = result?.value
        if (lastValue === true) {
          return wantHidden ? { hidden: step.selector } : { appeared: step.selector }
        }
        await sleep(200)
      }
      throw new Error(`timed out waiting for ${step.selector} to be ${wantHidden ? 'hidden' : 'visible'} (last value: ${JSON.stringify(lastValue)})`)
    }
    case 'eval': {
      const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
        expression: String(step.expression ?? ''),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
      if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluation failed')
      return { value: result?.value ?? null }
    }
    case 'screenshot': {
      const shot = await cdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: step.fullPage === true
      })
      return { png: shot.data }
    }
    default:
      throw new Error(`unknown step op: ${op}`)
  }
}

function vkFor(key) {
  const table = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }
  return table[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
}

/* ---------------------------------------------------------------- snapshot */

function snapshotInPage(options) {
  const maxNodes = options.maxNodes || 4000
  const scopeSelector = options.selector || null

  const nodes = []
  const styles = {}
  const counts = { shadowRoots: 0, frames: 0, crossOriginFrames: 0 }

  // Resolve the scope through the same `host >>> inner` syntax the tools use.
  const deepRoot = (el) => {
    if (el.shadowRoot) return el.shadowRoot
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try { return el.contentDocument || null } catch { return null }
    }
    return null
  }
  const resolveScope = (selector) => {
    const parts = String(selector).split('>>>').map((s) => s.trim()).filter(Boolean)
    let scope = document
    let el = null
    for (let i = 0; i < parts.length; i += 1) {
      el = scope.querySelector(parts[i])
      if (!el) return null
      if (i < parts.length - 1) {
        scope = deepRoot(el)
        if (!scope) return null
      }
    }
    return el
  }

  const root = scopeSelector ? resolveScope(scopeSelector) : document.body
  if (!root) return { error: `selector not found: ${scopeSelector}` }
  const scopeDoc = root.ownerDocument || document
  const all = scopeDoc.querySelectorAll('*')
  const styleProps = [
    'display', 'position', 'color', 'background-color', 'background-image', 'font-family', 'font-size',
    'font-weight', 'line-height', 'letter-spacing', 'border-top-width', 'border-color', 'border-radius',
    'box-shadow', 'padding-top', 'padding-left', 'margin-top', 'margin-left', 'gap', 'row-gap',
    'column-gap', 'justify-content', 'align-items', 'flex-direction', 'grid-template-columns', 'opacity',
    'z-index', 'text-transform', 'width', 'height'
  ]
  const attrNames = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-id', 'data-action', 'name', 'type', 'href', 'placeholder', 'title', 'alt', 'value']

  const seenIds = new Map()

  function escape(value) {
    return String(value).replace(/["\\]/g, '\\$&')
  }

  function unique(scope, selector) {
    try {
      return scope.querySelectorAll(selector).length
    } catch {
      return -1
    }
  }

  function pathFor(el, scope) {
    const parts = []
    let current = el
    let guard = 0
    while (current && current.nodeType === 1 && guard < 12) {
      let part = current.tagName.toLowerCase()
      if (current.id) {
        parts.unshift(`#${escape(current.id)}`)
        break
      }
      const parent = current.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((node) => node.tagName === current.tagName)
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
        parts.unshift(part)
        current = parent
      } else {
        parts.unshift(part)
        break
      }
      guard += 1
    }
    return parts.join(' > ')
  }

  function xpathFor(el) {
    const parts = []
    let current = el
    while (current && current.nodeType === 1) {
      let index = 1
      let sibling = current.previousElementSibling
      while (sibling) {
        if (sibling.tagName === current.tagName) index += 1
        sibling = sibling.previousElementSibling
      }
      const total = current.parentElement
        ? [...current.parentElement.children].filter((node) => node.tagName === current.tagName).length
        : 1
      parts.unshift(current.tagName.toLowerCase() + (total > 1 ? '[' + index + ']' : ''))
      current = current.parentElement
    }
    return '/' + parts.join('/')
  }

  // Everything is resolved inside `scope` (document or shadow root), and the
  // result is prefixed with the chain that reaches that scope.
  function candidates(el, scope, prefix) {
    const list = []
    if (el.id) list.push(`#${escape(el.id)}`)
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const value = el.getAttribute(attr)
      if (value) list.push(`[${attr}="${escape(value)}"]`)
    }
    if (el.getAttribute('name')) list.push(`${el.tagName.toLowerCase()}[name="${escape(el.getAttribute('name'))}"]`)
    if (el.getAttribute('aria-label')) list.push(`[aria-label="${escape(el.getAttribute('aria-label'))}"]`)
    if (el.getAttribute('role')) list.push(`${el.tagName.toLowerCase()}[role="${escape(el.getAttribute('role'))}"]`)
    const classes = [...el.classList].filter((name) => /^[a-zA-Z][\w-]{2,}$/.test(name)).slice(0, 2)
    if (classes.length > 0) list.push(el.tagName.toLowerCase() + classes.map((name) => `.${escape(name)}`).join(''))
    list.push(pathFor(el, scope))
    const checked = [...new Set(list)]
      .map((selector) => ({ selector: prefix + selector, matches: unique(scope, selector) }))
      .filter((item) => item.matches > 0)
    const best = checked.find((item) => item.matches === 1) ?? checked[0] ?? { selector: prefix, matches: 0 }
    return { best: best.selector, unique: best.matches === 1, candidates: checked.slice(0, 6) }
  }

  function textOf(el) {
    if (el.children.length > 0) return ''
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  }

  function visit(el, parentIndex, depth, scope, prefix) {
    if (nodes.length >= maxNodes) return
    if (depth > (options.maxDepth ?? 30) || depth > 40) return
    const index = nodes.length
    const rect = el.getBoundingClientRect()
    const view = (el.ownerDocument && el.ownerDocument.defaultView) || window
    const style = view.getComputedStyle(el)
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && (rect.width > 0 || rect.height > 0)
    const attrs = {}
    for (const name of attrNames) {
      const value = el.getAttribute(name)
      if (value !== null) attrs[name] = value.slice(0, 200)
    }
    const node = {
      i: index,
      p: parentIndex,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: [...el.classList].slice(0, 4),
      role: el.getAttribute('role') || '',
      name: el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '',
      text: textOf(el),
      attrs,
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      vis: visible,
      d: depth,
      frame: prefix === '' ? null : prefix.replace(/ >>> $/, ''),
      xpath: xpathFor(el),
      sel: candidates(el, scope, prefix)
    }
    nodes.push(node)

    const interesting =
      visible &&
      (node.id !== '' ||
        Object.keys(attrs).length > 0 ||
        ['button', 'a', 'input', 'select', 'textarea', 'label', 'h1', 'h2', 'h3', 'nav', 'header', 'footer', 'form', 'table'].includes(node.tag) ||
        ['button', 'link', 'tab', 'menuitem', 'textbox', 'checkbox', 'combobox'].includes(node.role))
    if (interesting && Object.keys(styles).length < 250) {
      const snapshot = {}
      for (const prop of styleProps) snapshot[prop] = style.getPropertyValue(prop)
      styles[index] = snapshot
    }

    for (const child of el.children) {
      visit(child, index, depth + 1, scope, prefix)
    }

    if (el.shadowRoot) {
      counts.shadowRoots += 1
      const hostSelector = candidates(el, scope, prefix).best
      for (const child of el.shadowRoot.children) {
        visit(child, index, depth + 1, el.shadowRoot, hostSelector + ' >>> ')
      }
    }

    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      let frameDoc = null
      try {
        frameDoc = el.contentDocument
      } catch {
        frameDoc = null
      }
      if (frameDoc && frameDoc.body) {
        counts.frames += 1
        const frameSelector = candidates(el, scope, prefix).best
        for (const child of frameDoc.body.children) {
          visit(child, index, depth + 1, frameDoc, frameSelector + ' >>> ')
        }
      } else {
        counts.crossOriginFrames += 1
      }
    }
  }

  visit(root, -1, 0, scopeDoc, '')

  const cssVars = {}
  try {
    for (const sheet of document.styleSheets) {
      let rules
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of rules || []) {
        if (!rule.style) continue
        const selector = rule.selectorText || ''
        if (!/:root|^html\b/.test(selector)) continue
        for (const prop of rule.style) {
          if (!prop.startsWith('--')) continue
          const value = rule.style.getPropertyValue(prop).trim()
          if (value && !cssVars[prop]) cssVars[prop] = value.slice(0, 200)
        }
        if (Object.keys(cssVars).length > 300) break
      }
    }
  } catch {
    // cross-origin stylesheets are not readable; :root vars from inline styles still are
  }

  const frameworks = []
  try {
    if (window.__NEXT_DATA__) frameworks.push('next')
    if (window.__NUXT__) frameworks.push('nuxt')
    if (window.__remixContext) frameworks.push('remix')
    if (window.__sveltekit) frameworks.push('sveltekit')
    if (document.querySelector('[ng-version]')) frameworks.push('angular')
    if (window.Vue || document.querySelector('[data-v-app]')) frameworks.push('vue')
    if (document.querySelector('[data-reactroot], #__next, #root')) frameworks.push('react-ish')
  } catch {
    // ignore
  }

  const html = root.outerHTML || ''
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || '',
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    scroll: { x: window.scrollX, y: window.scrollY, w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    ua: navigator.userAgent,
    frameworks,
    counts,
    cssVars,
    styles,
    nodes,
    html: html.length > 3000000 ? html.slice(0, 3000000) : html,
    htmlTruncated: html.length > 3000000,
    totalElements: all.length
  }
}

/* ----------------------------------------------------------------- dispatch */

/**
 * Pins the tab named in `args.tabId` for the duration of the call, so every
 * helper (cdp, steps, snapshot) resolves the same session. The command queue
 * does this too; doing it here makes direct callers — the debug hook, tests —
 * behave exactly like the wire protocol.
 */
async function handle(op, args = {}) {
  const previous = state.commandTabId
  if (args?.tabId != null && args.tabId !== '') state.commandTabId = Number(args.tabId)
  try {
    return await dispatch(op, args)
  } finally {
    state.commandTabId = previous
  }
}

async function dispatch(op, args) {
  switch (op) {
    case 'ping':
      return { ok: true, version: EXT_VERSION }
    case 'tabs.list': {
      const tabs = await chrome.tabs.query({})
      // Window type explains why a tab can be listed but not read: app windows
      // belong to another extension, and Chrome refuses access to them.
      const windows = await chrome.windows.getAll({}).catch(() => [])
      const windowType = new Map(windows.map((window) => [window.id, window.type ?? 'normal']))
      const list = tabs
        .filter((tab) => /^https?:|^file:/.test(tab.url ?? ''))
        .map((tab) => {
          const type = windowType.get(tab.windowId) ?? 'unknown'
          return {
            id: tab.id,
            title: tab.title,
            url: tab.url,
            active: tab.active,
            windowId: tab.windowId,
            windowType: type,
            readable: type === 'normal',
            attached: state.sessions.has(tab.id),
            target: tab.id === state.activeTabId
          }
        })
      await evt('tabs', { tabs: list })
      return { tabs: list }
    }
    case 'tab.claim':
      return { target: await claimTab(Number(args.tabId)) }
    case 'tab.use': {
      const tabId = Number(args.tabId)
      const session = state.sessions.get(tabId)
      if (!session) throw new Error(`tab ${tabId} is not attached`)
      state.activeTabId = tabId
      await evt('active', { tabId })
      return { target: session.target }
    }
    case 'tab.release': {
      const tabId = Number(args.tabId ?? state.activeTabId)
      await detach(tabId)
      return { detached: tabId }
    }
    case 'tab.info': {
      const active = activeSession()
      return { target: active?.target ?? null, attached: state.activeTabId, tabs: [...state.sessions.keys()] }
    }
    case 'tab.close': {
      const id = Number(args.tabId ?? state.activeTabId)
      if (!Number.isFinite(id)) throw new Error('нечего закрывать: передайте tabId')
      await detach(id).catch(() => {})
      await chrome.tabs.remove(id)
      return { closed: id }
    }
    case 'tab.open': {
      const tab = await chrome.tabs.create({ url: String(args.url ?? 'about:blank'), active: args.active !== false })
      await attach(tab.id, 'agent')
      // A fresh tab has no title yet: wait for the load so the caller gets a
      // target it can show, instead of an empty string.
      const deadline = Date.now() + Math.min(Number(args.waitMs ?? 10000), 30000)
      let info = tab
      while (Date.now() < deadline) {
        info = await chrome.tabs.get(tab.id).catch(() => info)
        if (info.status === 'complete' && info.title) break
        await sleep(150)
      }
      const session = state.sessions.get(tab.id)
      if (session) {
        session.target = { id: info.id, url: info.url, title: info.title, attachedBy: session.attachedBy }
        await evt('target', { tab: session.target, tabId: tab.id })
      }
      return { target: session?.target ?? { id: tab.id, url: tab.url, title: tab.title } }
    }
    case 'tab.focus': {
      const session = requireSession(args.tabId)
      await chrome.tabs.update(session.tabId, { active: true })
      const tab = await chrome.tabs.get(session.tabId)
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
      return { focused: session.tabId }
    }
    case 'tab.diagnose': {
      const id = Number(args.tabId)
      if (!Number.isFinite(id)) throw new Error('нужен tabId')
      const info = await chrome.tabs.get(id).catch((error) => ({ error: String(error?.message ?? error) }))
      const windows = await chrome.windows.getAll({}).catch(() => [])
      const window = windows.find((item) => item.id === info?.windowId) ?? null
      const targets = await chrome.debugger.getTargets().catch(() => [])
      const frames = await chrome.webNavigation.getAllFrames({ tabId: id }).catch(() => null)
      const mine = targets
        .filter((target) => target.tabId === id)
        .map((target) => ({
          id: target.id,
          type: target.type,
          url: String(target.url ?? '').slice(0, 300),
          title: String(target.title ?? '').slice(0, 120),
          attached: target.attached === true
        }))
      return {
        tab: info
          ? {
              id: info.id,
              url: String(info.url ?? '').slice(0, 300),
              pendingUrl: String(info.pendingUrl ?? '').slice(0, 300),
              title: String(info.title ?? '').slice(0, 120),
              status: info.status,
              active: info.active,
              discarded: info.discarded,
              windowId: info.windowId,
              index: info.index
            }
          : { error: info?.error },
        window: window ? { id: window.id, type: window.type, state: window.state } : null,
        targets: mine,
        frames: Array.isArray(frames)
          ? frames.map((frame) => ({
              frameId: frame.frameId,
              parentFrameId: frame.parentFrameId,
              url: String(frame.url ?? '').slice(0, 200)
            }))
          : null,
        targetCount: targets.length
      }
    }
    case 'snapshot.compact': {
      const session = requireSession(args.tabId)
      const value = await evaluateInPage(
        session,
        null,
        `(${compactSnapshotInPage.toString()})(${JSON.stringify({ limit: args.limit })})`
      )
      const snapshot = value ?? { items: [], total: 0, returned: 0, truncated: false }
      // Cross-origin frames are separate documents: snapshot each and splice its
      // items in with a frame-prefixed selector and page coordinates.
      for (const child of [...(session.children?.values() ?? [])]) {
        if (!child.url) continue
        const frame = await evaluateInPage(session, null, `(() => {
          const wanted = ${JSON.stringify(child.url)};
          const frames = [...document.querySelectorAll('iframe')];
          const el = frames.find((node) => node.src && (node.src === wanted || node.src.split('?')[0] === wanted.split('?')[0]));
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const candidate = 'iframe[src="' + String(el.src).replace(/"/g, '\\"') + '"]';
          let unique = false;
          try { unique = document.querySelectorAll(candidate).length === 1; } catch {}
          return { x: rect.left, y: rect.top, selector: unique ? candidate : 'iframe:nth-of-type(' + (frames.indexOf(el) + 1) + ')' };
        })()`).catch(() => null)
        if (!frame) continue
        const childSnapshot = await evaluateInPage(session, child, `(${compactSnapshotInPage.toString()})(${JSON.stringify({ limit: args.limit })})`).catch(() => null)
        if (!childSnapshot?.items) continue
        for (const item of childSnapshot.items) {
          snapshot.items.push({
            ...item,
            selector: `${frame.selector} >>> ${item.selector}`,
            frame: child.url,
            box: { x: item.box.x + frame.x, y: item.box.y + frame.y, w: item.box.w, h: item.box.h }
          })
        }
        snapshot.total += childSnapshot.total ?? childSnapshot.items.length
      }
      snapshot.returned = snapshot.items.length
      snapshot.truncated = snapshot.total > snapshot.items.length
      return snapshot
    }
    case 'text.get': {
      const session = requireSession(args.tabId)
      const maxChars = Math.max(20, Math.min(Number(args.maxChars ?? 8000), 40000))
      const ctx = args.selector
        ? await selectorContext(session, String(args.selector))
        : { child: null, selector: null, dx: 0, dy: 0 }
      // __dshDeep returns { el, ox, oy }, not an element.
      const root = ctx.selector
        ? `((__dshDeep(${JSON.stringify(ctx.selector)}) || {}).el || null)`
        : 'document.body'
      const value = await evaluateInPage(session, ctx.child, `(() => {
          ${PAGE_RESOLVER}
          const root = ${root};
          if (!root) return { error: 'element not found' };
          const text = (root.innerText ?? root.textContent ?? '').replace(/\\n{3,}/g, '\\n\\n').trim();
          return {
            text: text.slice(0, ${maxChars}),
            chars: text.length,
            truncated: text.length > ${maxChars},
            url: location.href,
            title: document.title
          };
        })()`)
      return value ?? { text: '', chars: 0, truncated: false }
    }
    case 'net.start': {
      const session = requireSession(args.tabId)
      return { recording: await setRecording(session, true), tabId: session.tabId }
    }
    case 'net.stop': {
      const session = requireSession(args.tabId)
      return { recording: await setRecording(session, false), captured: session.entries.length, tabId: session.tabId }
    }
    case 'net.clear': {
      const session = requireSession(args.tabId)
      session.entries = []
      state.dirty = state.dirty.filter((item) => item.tabId !== session.tabId)
      await evt('netclear', { tabId: session.tabId })
      return { captured: 0 }
    }
    case 'pick.arm': {
      const session = requireSession(args.tabId)
      await armPicker(session.tabId)
      session.picking = true
      return { picking: true, tabId: session.tabId }
    }
    case 'pick.wait': {
      const session = requireSession(args.tabId)
      await armPicker(session.tabId)
      session.picking = true
      const deadline = Date.now() + Math.min(Number(args.timeoutMs ?? 60000), 120000)
      while (Date.now() < deadline) {
        const pick = await readPick(session.tabId)
        if (pick) {
          session.picking = false
          if (pick.cancelled) throw new Error('выбор элемента отменён')
          session.picks = [...(session.picks ?? []), pick].slice(-20)
          await evt('pick', { tabId: session.tabId, pick })
          return { pick }
        }
        await sleep(250)
      }
      session.picking = false
      await stopPicker(session.tabId)
      throw new Error('элемент не выбран за отведённое время')
    }
    case 'pick.last': {
      const session = requireSession(args.tabId)
      // A pick armed from the popup lands in the page, not in the queue: pull it
      // in the first time someone asks for it.
      const fresh = await readPick(session.tabId).catch(() => null)
      if (fresh && !fresh.cancelled) {
        session.picks = [...(session.picks ?? []), fresh].slice(-20)
        session.picking = false
        await cdp('Runtime.evaluate', { expression: 'window.__dshPickResult = null', returnByValue: true }, session.tabId).catch(() => {})
      }
      return { pick: session.picks?.[session.picks.length - 1] ?? null }
    }
    case 'pick.list': {
      const session = requireSession(args.tabId)
      return { picks: session.picks ?? [] }
    }
    case 'pick.stop': {
      const session = requireSession(args.tabId)
      session.picking = false
      await stopPicker(session.tabId)
      return { picking: false }
    }
    case 'net.list': {
      const session = requireSession(args.tabId)
      const query = String(args.query ?? '').toLowerCase()
      const limit = Math.min(Number(args.limit ?? 50), 200)
      const items = session.entries
        .filter((entry) => (query === '' ? true : `${entry.method} ${entry.url}`.toLowerCase().includes(query)))
        .slice(-limit)
        .map((entry) => ({
          id: entry.id,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          type: entry.type,
          mimeType: entry.mimeType,
          failed: entry.failed,
          frame: entry.frame ?? null,
          hasBody: Boolean(entry.response?.body)
        }))
      return { captured: session.entries.length, items }
    }
    case 'net.get': {
      const session = requireSession(args.tabId)
      const entry = session.entries.find((item) => String(item.id) === String(args.id))
      if (!entry) throw new Error(`no captured request ${args.id}`)
      return { entry }
    }
    case 'dom.snapshot': {
      const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
        expression: `(${snapshotInPage.toString()})(${JSON.stringify({
          selector: args.selector ?? null,
          maxNodes: args.maxNodes ?? 4000,
          maxDepth: args.maxDepth ?? 30
        })})`,
        returnByValue: true,
        awaitPromise: true
      })
      if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'snapshot failed')
      if (!result?.value) throw new Error('snapshot returned no value')
      return result.value
    }
    case 'act':
      return runSteps(args.steps)
    case 'cursor': {
      const x = Number(args.x)
      const y = Number(args.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('cursor needs numeric x and y')
      await cursorMove(x, y)
      if (args.click === true) {
        await sleep(180)
        await cursorRipple(x, y)
        await mouseClick(x, y, { button: args.button ?? 'left', clickCount: args.clickCount ?? 1 })
      }
      return { x, y, clicked: args.click === true }
    }
    case 'eval': {
      const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
        expression: String(args.expression ?? ''),
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluation failed')
      return { value: result?.value ?? null }
    }
    case 'inject': {
      if (args.css) {
        await cdp('Runtime.evaluate', {
          expression: `(() => {
            const id = 'dsh-injected-style';
            let el = document.getElementById(id);
            if (!el) { el = document.createElement('style'); el.id = id; (document.head || document.documentElement).appendChild(el); }
            el.textContent = ${JSON.stringify(String(args.css))};
            return true;
          })()`,
          returnByValue: true
        })
      }
      let value = null
      if (args.js) {
        const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
          expression: `(async () => { ${String(args.js)} })()`,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true
        })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'injected script threw')
        value = result?.value ?? null
      }
      return { injected: true, value }
    }
    case 'shot': {
      const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: args.fullPage === true })
      return { png: shot.data, fullPage: args.fullPage === true }
    }
    default:
      throw new Error(`unknown op: ${op}`)
  }
}

void ensureLoop()

// Reachable only from inside this worker's context (CDP during development,
// or a future options page). It exposes nothing the extension could not
// already do, and no page can reach it.
globalThis.__dshSiteBridge = { state, claimTab, attach, detach, handle, setRecording, EXT_VERSION }
