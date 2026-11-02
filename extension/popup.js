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
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    const message = t(node.dataset.i18nTitle)
    if (message && message !== node.dataset.i18nTitle) node.title = message
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

/** Turns transport errors into something a person can act on. */
function explain(error) {
  const text = String(error ?? '')
  if (/401|unauthorized/i.test(text)) return t('errorToken')
  if (/Failed to fetch|NetworkError|ECONNREFUSED|Load failed/i.test(text)) return t('errorNoBridge')
  return text
}

function render(status) {
  const dot = $('dot')
  const text = $('connection-text')
  const claim = $('claim')
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

  // While the bridge is being looked for, a spinner plus an attempt counter
  // says "this is in progress, waiting is fine" instead of a dead end.
  const connecting = configured && !connected
  const spin = $('spin')
  dot.className = 'dot'
  dot.hidden = connecting
  spin.hidden = !connecting

  if (connected) {
    dot.classList.add('ok')
    text.textContent = t('statusConnected')
  } else if (connecting) {
    text.textContent = t('statusRetrying', [String(status.attempts || 1)])
  } else {
    dot.classList.add('warn')
    text.textContent = t('statusNotConfigured')
  }

  // One block per attached tab: title, address and its own detach cross. The
  // list scrolls after three blocks so the popup keeps its height.
  const targets = Array.isArray(status.targets) ? status.targets : []
  target.classList.toggle('empty', targets.length === 0)
  target.hidden = targets.length > 0

  const list = $('tabs-list')
  list.hidden = targets.length === 0
  list.textContent = ''
  for (const item of targets) {
    const row = document.createElement('div')
    row.className = 'tab-item'
    row.dataset.id = String(item.id)
    row.title = item.url || ''

    const body = document.createElement('div')
    body.className = 'tab-item-text'
    const title = document.createElement('div')
    title.className = 'tab-item-title'
    title.textContent = item.title || item.url || `#${item.id}`
    const address = document.createElement('div')
    address.className = 'tab-item-url'
    address.textContent = item.url || ''
    body.append(title, address)

    const remove = document.createElement('button')
    remove.className = 'icon'
    remove.dataset.remove = String(item.id)
    remove.title = t('disconnectTab')
    remove.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'

    // Every tab carries its own numbers: nothing here is "the" tab.
    const meta = document.createElement('span')
    meta.className = 'tab-meta'
    if (item.recording) {
      const dot = document.createElement('i')
      dot.className = 'tab-dot'
      meta.append(dot)
    }
    meta.append(document.createTextNode(String(item.captured ?? 0)))
    row.append(body, meta, remove)
    list.append(row)
  }

  // Nothing to claim once a tab is bound: the action would be a no-op.
  const selfAttached = selfTabId != null && targets.some((item) => item.id === selfTabId)
  // Service pages (chrome://, other extensions, the Web Store) cannot be driven;
  // do not offer a button that Chrome will refuse.
  const claimable = selfTabUrl == null || /^(https?|file):/.test(selfTabUrl)
  claim.hidden = targets.length > 0
  claim.disabled = !connected || !claimable || targets.length > 0
  claim.title = claimable ? '' : t('notClaimable')
  claim.textContent = t('connectTab')
  const claimMore = $('claim-more')
  claimMore.hidden = targets.length === 0 || selfAttached
  claimMore.disabled = !connected || !claimable
  claimMore.title = claimable ? t('attachAnother') : t('notClaimable')

  const pick = $('pick')
  pick.classList.toggle('active', status.picking === true)
  pick.disabled = !connected || !hasTarget

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

  if (connecting && status.lastError && (status.attempts || 0) >= 2) {
    setNote(explain(status.lastError), true)
  } else if (connected) {
    const note = $('status-note')
    if (note.classList.contains('err')) setNote('')
  }
}

// Which tab this popup is open on: attaching that tab again is a no-op, so the
// attach button is only offered when the current tab is not attached yet.
let selfTabId = null
let selfTabUrl = null

async function refresh() {
  try {
    if (chrome.tabs?.query) {
      const tab = await currentBrowserTab()
      selfTabId = tab?.id ?? null
      selfTabUrl = tab?.url ?? null
    }
    render(await send({ type: 'status' }))
  } catch {
    render(null)
  }
}

/**
 * The browser tab this popup belongs to. `currentWindow` from a popup can point
 * at the popup's own extension page, and Chrome refuses to read other
 * extensions' pages, so prefer a real http(s)/file tab from the focused window.
 */
async function currentBrowserTab() {
  const scheme = (tab) => (/^(https?|file):/.test(String(tab?.url ?? '')) ? 'web' : 'other')
  const scopes = [
    { active: true, lastFocusedWindow: true, windowType: 'normal' },
    { active: true, windowType: 'normal' },
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true }
  ]
  for (const scope of scopes) {
    try {
      const tabs = await chrome.tabs.query(scope)
      if (!Array.isArray(tabs) || tabs.length === 0) continue
      return tabs.find((tab) => scheme(tab) === 'web') ?? tabs[0]
    } catch {
      // try the next scope
    }
  }
  return null
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

async function attachCurrentTab() {
  let tabId = null
  try {
    const tab = await currentBrowserTab()
    tabId = tab?.id ?? null
  } catch {
    tabId = null
  }
  if (tabId == null) {
    setNote(t('claimFailed', [t('claimFailedUnknown')]), true)
    return
  }
  try {
    const result = await send({ type: 'claim', tabId })
    if (!result?.ok) {
      setNote(t('claimFailed', [String(result?.error ?? t('claimFailedUnknown'))]), true)
      return
    }
    setNote('')
  } catch (error) {
    setNote(t('claimFailed', [String(error?.message ?? error)]), true)
    return
  }
  await refresh()
}

$('claim').addEventListener('click', attachCurrentTab)

$('capture').addEventListener('click', async () => {
  const status = await send({ type: 'status' })
  await send({ type: 'toggle-capture', on: !status?.recording })
  await refresh()
})

$('tabs-list').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove]')
  if (remove) {
    event.stopPropagation()
    await send({ type: 'release', tabId: Number(remove.dataset.remove) })
    await refresh()
    return
  }
})

$('pick').addEventListener('click', async () => {
  const status = await send({ type: 'status' })
  if (status?.picking) {
    await send({ type: 'release' }).catch(() => {})
    await refresh()
    return
  }
  const result = await send({ type: 'pick-arm' })
  if (!result?.ok) {
    setNote(String(result?.error ?? 'pick failed'), true)
    return
  }
  setNote(t('pickArmed'))
  await refresh()
})

$('claim-more').addEventListener('click', attachCurrentTab)



void init()
