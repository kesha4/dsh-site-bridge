const $ = (id) => document.getElementById(id)
const MIN_TOKEN_LENGTH = 16

const send = (message) => chrome.runtime.sendMessage(message)

/** chrome.i18n with a readable fallback when a key is missing. */
const t = (key, substitutions) => {
  try {
    const message = chrome.i18n.getMessage(key, substitutions)
    return message || key
  } catch {
    return key
  }
}

/** Fills every [data-i18n] / [data-i18n-placeholder] node from _locales. */
function applyLocale() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const message = t(node.dataset.i18n)
    if (message && message !== node.dataset.i18n) node.textContent = message
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    const message = t(node.dataset.i18nPlaceholder)
    if (message && message !== node.dataset.i18nPlaceholder) node.placeholder = message
  }
  const ui = (chrome.i18n.getUILanguage?.() || 'en').split('-')[0]
  document.documentElement.lang = ui
}

let noteTimer = null
let pairingInitialized = false

function setNote(text, isError = false) {
  const note = $('status-note')
  if (!text) {
    note.hidden = true
    return
  }
  note.hidden = false
  note.textContent = text
  note.className = isError ? 'status-note err' : 'status-note'
  clearTimeout(noteTimer)
  if (!isError) noteTimer = setTimeout(() => { note.hidden = true }, 2500)
}

function render(status) {
  const dot = $('dot')
  const text = $('connection-text')
  const claim = $('claim')
  const release = $('release')
  const capture = $('capture')
  const target = $('target-block')

  if (!status) {
    dot.className = 'dot err'
    text.textContent = t('statusWorkerDown')
    claim.disabled = true
    capture.disabled = true
    return
  }

  const connected = status.connected === true
  const configured = status.configured === true
  const hasTarget = Boolean(status.target)

  dot.className = 'dot'
  if (connected) {
    dot.classList.add('ok')
    text.textContent = t('statusConnected')
  } else if (configured) {
    dot.classList.add('warn')
    text.textContent = t('statusNoBridge')
  } else {
    dot.classList.add('warn')
    text.textContent = t('statusNotConfigured')
  }

  target.classList.toggle('empty', !hasTarget)
  $('target-title').textContent = hasTarget ? status.target.title || status.target.url : t('targetNoneTitle')
  $('target-url').textContent = hasTarget ? String(status.target.url || '') : t('targetNoneUrl')

  // Several attached tabs: a compact switcher, nothing else changes.
  const targets = Array.isArray(status.targets) ? status.targets : []
  const tabsRow = $('tabs-row')
  const tabsSelect = $('tabs-select')
  if (targets.length > 1) {
    tabsRow.hidden = false
    tabsSelect.textContent = ''
    for (const item of targets) {
      const option = document.createElement('option')
      option.value = String(item.id)
      option.textContent = item.title || item.url || `#${item.id}`
      option.selected = item.id === status.activeTabId
      tabsSelect.appendChild(option)
    }
  } else {
    tabsRow.hidden = true
  }

  // Nothing to claim once a tab is bound: the action would be a no-op.
  claim.hidden = hasTarget
  claim.disabled = !connected || hasTarget
  claim.textContent = hasTarget ? t('tabConnected') : t('connectTab')
  release.hidden = !hasTarget

  capture.disabled = !connected
  capture.textContent = status.recording ? t('captureShortOn') : t('captureShortOff')
  $('captured').textContent = t('records', [String(status.captured || 0)])
  $('endpoint').textContent = `127.0.0.1:${status.port || 47321}`

  // Pairing is advanced once it works: open it only when it is not configured
  // yet, and never fight the user's own toggle afterwards.
  if (!pairingInitialized) {
    $('pairing').open = !configured
    pairingInitialized = true
  }

  if (configured && !connected && status.lastError) {
    setNote(String(status.lastError), true)
  } else if (connected) {
    const note = $('status-note')
    if (note.classList.contains('err')) setNote('')
  }
}

async function refresh() {
  try {
    render(await send({ type: 'status' }))
  } catch {
    render(null)
  }
}

/* Autosave: a complete pair is stored as soon as it appears, no button. */
let saveTimer = null

function updateTokenHint() {
  const { value } = $('token')
  const length = value.trim().length
  const hint = $('token-len')
  hint.textContent = length === 0 ? '' : t('tokenLength', [String(length)])
  hint.style.color = length >= MIN_TOKEN_LENGTH ? 'var(--ok)' : 'var(--muted)'
}

function scheduleSave(delay = 350) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, delay)
}

async function saveNow() {
  const port = Number($('port').value)
  const token = $('token').value.trim()
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return
  if (token.length < MIN_TOKEN_LENGTH) return
  const stored = await chrome.storage.local.get({ port: 0, token: '' })
  if (Number(stored.port) === port && stored.token === token) return
  await send({ type: 'save', port, token })
  await refresh()
}

/* The token is a secret: readable while focused, masked as soon as focus leaves. */
function setupTokenField() {
  const input = $('token')
  input.addEventListener('focus', () => { input.type = 'text' })
  input.addEventListener('blur', () => { input.type = 'password' })
  input.addEventListener('input', updateTokenHint)
  updateTokenHint()
}

async function init() {
  applyLocale()
  const stored = await chrome.storage.local.get({ port: 47321, token: '' })
  $('port').value = stored.port
  $('token').value = stored.token
  setupTokenField()

  $('port').addEventListener('input', () => scheduleSave())
  $('port').addEventListener('change', () => scheduleSave(0))
  $('token').addEventListener('input', () => scheduleSave())
  $('token').addEventListener('paste', () => scheduleSave(120))

  await refresh()
  setInterval(refresh, 2000)
}

$('import').addEventListener('click', () => $('import-file').click())

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    const port = Number(parsed?.port)
    const token = String(parsed?.token ?? '').trim()
    if (!Number.isFinite(port) || token === '') throw new Error('port or token missing')
    $('port').value = port
    $('token').value = token
    $('token').type = 'password'
    updateTokenHint()
    await send({ type: 'save', port, token })
    await refresh()
    setNote(t('imported'))
  } catch (error) {
    setNote(t('importFailed', [String(error?.message ?? error)]), true)
  } finally {
    event.target.value = ''
  }
})

$('claim').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  const result = await send({ type: 'claim', tabId: tab.id })
  if (!result?.ok) {
    setNote(t('claimFailed', [String(result?.error ?? t('claimFailedUnknown'))]), true)
    return
  }
  await refresh()
})

$('capture').addEventListener('click', async () => {
  const status = await send({ type: 'status' })
  await send({ type: 'toggle-capture', on: !status?.recording })
  await refresh()
})

$('release').addEventListener('click', async () => {
  await send({ type: 'release' })
  await refresh()
})

$('tabs-select').addEventListener('change', async (event) => {
  const tabId = Number(event.target.value)
  if (!Number.isFinite(tabId)) return
  await send({ type: 'use', tabId })
  await refresh()
})

void init()
