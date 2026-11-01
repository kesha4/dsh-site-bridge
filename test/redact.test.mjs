import test from 'node:test'
import assert from 'node:assert/strict'
import { isSensitiveHeader, isSensitiveKey, redactBody, redactEntry, redactHeaders, redactUrl } from '../lib/redact.js'

test('known credential headers are recognised, ordinary ones are not', () => {
  assert.equal(isSensitiveHeader('Cookie'), true)
  assert.equal(isSensitiveHeader('AUTHORIZATION'), true)
  assert.equal(isSensitiveHeader('x-csrf-token'), true)
  assert.equal(isSensitiveHeader('content-type'), false)
  assert.equal(isSensitiveHeader('x-request-id'), false)
})

test('header names survive, values are replaced', () => {
  const redacted = redactHeaders({ Cookie: 'sid=1', Accept: 'application/json' })
  assert.deepEqual(redacted, { Cookie: '«redacted»', Accept: 'application/json' })
})

test('secret-looking JSON keys are redacted at any depth, ordinary keys are kept', () => {
  const body = JSON.stringify({
    order: { id: 12, status: 'new' },
    auth: { access_token: 'aaa', refreshToken: 'bbb' },
    items: [{ sku: 'A1', password: 'nope' }]
  })
  const redacted = JSON.parse(redactBody(body))
  assert.equal(redacted.order.status, 'new')
  assert.equal(redacted.auth.access_token, '«redacted»')
  assert.equal(redacted.auth.refreshToken, '«redacted»')
  assert.equal(redacted.items[0].sku, 'A1')
  assert.equal(redacted.items[0].password, '«redacted»')
})

test('urlencoded form bodies keep their shape', () => {
  const redacted = redactBody('user=ivan&password=hunter2&remember=1')
  assert.match(redacted, /user=ivan/)
  assert.match(redacted, /remember=1/)
  assert.match(redacted, /password=%C2%ABredacted%C2%BB|password=«redacted»/)
})

test('plain text bodies are left alone', () => {
  assert.equal(redactBody('hello world'), 'hello world')
  assert.equal(redactBody(''), '')
  assert.equal(redactBody(null), null)
})

test('credential-shaped query parameters are masked, the rest of the URL is intact', () => {
  const redacted = redactUrl('https://x.test/api?page=2&token=abc&sort=asc')
  const parsed = new URL(redacted)
  assert.equal(parsed.searchParams.get('page'), '2')
  assert.equal(parsed.searchParams.get('sort'), 'asc')
  assert.equal(parsed.searchParams.get('token'), '«redacted»')
})

test('redactEntry walks request and response without touching metadata', () => {
  const entry = redactEntry({
    id: '1',
    method: 'POST',
    url: 'https://x.test/a?api_key=1',
    status: 201,
    type: 'fetch',
    request: { headers: { 'x-api-key': 'k' }, body: '{"secret":"s"}' },
    response: { headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
  })
  assert.equal(entry.status, 201)
  assert.equal(entry.type, 'fetch')
  assert.equal(entry.request.headers['x-api-key'], '«redacted»')
  assert.equal(JSON.parse(entry.request.body).secret, '«redacted»')
  assert.equal(entry.response.body, '{"ok":true}')
})

test('isSensitiveKey does not fire on innocent words', () => {
  assert.equal(isSensitiveKey('tokenizer'), false)
  assert.equal(isSensitiveKey('author'), false)
  assert.equal(isSensitiveKey('sessionCount'), true)
  assert.equal(isSensitiveKey('user_password'), true)
})
