/**
 * Redaction of authorization artifacts.
 *
 * Policy of this plugin: the browser keeps the credentials. The bridge may
 * *see* them in flight (it has to, otherwise a BFF contract cannot be
 * understood), but nothing credential-shaped is ever written to disk and
 * nothing credential-shaped is handed to the model.
 *
 * Two layers:
 *   1. header names -> value replaced with «redacted» (names are kept, because
 *      "this endpoint needs x-csrf-token" is part of the contract we want);
 *   2. JSON / form bodies -> values of secret-looking keys replaced.
 */

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'csrf-token',
  'x-session-id',
  'x-session-token',
  'x-id-token',
  'x-refresh-token',
  'authentication',
  'www-authenticate'
])

const SECRET_KEY = /(^|[_-])(token|secret|password|passwd|pwd|authorization|auth|apikey|api[_-]?key|csrf|xsrf|session|credential|cookie|signature|bearer)([_-]|$)/i

const REDACTED = '«redacted»'

/** True when a header name is credential-shaped. */
export function isSensitiveHeader(name) {
  return SENSITIVE_HEADERS.has(String(name).toLowerCase())
}

/** True when a JSON/form key is credential-shaped. */
export function isSensitiveKey(key) {
  // camelCase -> snake_case so sessionCount and session_count behave the same,
  // while tokenizer/author stay innocent.
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return SECRET_KEY.test(normalized)
}

/** Redact credential-shaped headers, keep everything else byte-for-byte. */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers ?? null
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? REDACTED : value
  }
  return out
}

/**
 * Redact secret-looking values inside a body.
 * Handles JSON objects/arrays, query strings and urlencoded form bodies.
 * Returns the original string when nothing looks structured.
 */
export function redactBody(body) {
  if (typeof body !== 'string' || body === '') return body ?? null
  const trimmed = body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed)))
    } catch {
      return body
    }
  }
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed)
    let touched = false
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) {
        params.set(key, REDACTED)
        touched = true
      }
    }
    return touched ? params.toString() : body
  }
  return body
}

function redactJson(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key) && (item === null || typeof item !== 'object')) {
      out[key] = REDACTED
      continue
    }
    out[key] = redactJson(item, depth + 1)
  }
  return out
}

/** Redact a URL's credential-shaped query parameters, keeping the shape. */
export function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return rawUrl ?? ''
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  let touched = false
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      parsed.searchParams.set(key, REDACTED)
      touched = true
    }
  }
  return touched ? parsed.toString() : rawUrl
}

/**
 * Normalize one captured network entry: redact URL, header values, bodies.
 * Never throws; unknown shapes pass through untouched.
 */
export function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const out = { ...entry }
  if (typeof out.url === 'string') out.url = redactUrl(out.url)
  if (out.request && typeof out.request === 'object') {
    out.request = {
      ...out.request,
      headers: redactHeaders(out.request.headers),
      body: redactBody(out.request.body)
    }
  }
  if (out.response && typeof out.response === 'object') {
    out.response = {
      ...out.response,
      headers: redactHeaders(out.response.headers),
      body: redactBody(out.response.body)
    }
  }
  return out
}

export const REDACTED_MARK = REDACTED
