import test from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../lib/bridge.js'

const TOKEN = 'test-token-0123456789abcdef'

async function startBridge() {
  const bridge = new Bridge({ port: 0, homeDir: '.', token: TOKEN })
  await bridge.listen()
  return bridge
}

function authHeaders(extra = {}) {
  return { 'content-type': 'application/json', 'x-site-token': TOKEN, ...extra }
}

test('rejects a request without the pairing token', async () => {
  const bridge = await startBridge()
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/ping`)
    assert.equal(response.status, 401)
  } finally {
    await bridge.close()
  }
})

test('rejects a request with a wrong token of the same length', async () => {
  const bridge = await startBridge()
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/ping`, {
      headers: { 'x-site-token': TOKEN.replace('test', 'fake') }
    })
    assert.equal(response.status, 401)
  } finally {
    await bridge.close()
  }
})

test('delivers a queued command through a long poll and resolves its result', async () => {
  const bridge = await startBridge()
  try {
    const commandPromise = bridge.enqueue('dom.snapshot', { selector: 'body' }, { timeout: 5000 })
    const poll = await fetch(`http://127.0.0.1:${bridge.port}/v1/poll?timeout=2000`, { headers: authHeaders() })
    const body = await poll.json()
    assert.equal(body.commands.length, 1)
    const command = body.commands[0]
    assert.equal(command.op, 'dom.snapshot')
    assert.equal(command.args.selector, 'body')

    const result = await fetch(`http://127.0.0.1:${bridge.port}/v1/result`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: command.id, ok: true, data: { nodes: 3 } })
    })
    assert.equal(result.status, 200)
    assert.deepEqual(await commandPromise, { nodes: 3 })
  } finally {
    await bridge.close()
  }
})

test('a long poll with nothing queued comes back empty after the timeout', async () => {
  const bridge = await startBridge()
  try {
    const started = Date.now()
    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/poll?timeout=300`, { headers: authHeaders() })
    const body = await response.json()
    assert.deepEqual(body.commands, [])
    assert.ok(Date.now() - started >= 250)
  } finally {
    await bridge.close()
  }
})

test('a failed result rejects the pending command', async () => {
  const bridge = await startBridge()
  try {
    const commandPromise = bridge.enqueue('act', { steps: [] }, { timeout: 5000 })
    const expectation = assert.rejects(commandPromise, /element not found/)
    const poll = await fetch(`http://127.0.0.1:${bridge.port}/v1/poll`, { headers: authHeaders() })
    const { commands } = await poll.json()
    await fetch(`http://127.0.0.1:${bridge.port}/v1/result`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id: commands[0].id, ok: false, error: 'element not found' })
    })
    await expectation
  } finally {
    await bridge.close()
  }
})

test('network events are redacted on ingest and kept in memory', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`http://127.0.0.1:${bridge.port}/v1/evt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        kind: 'net',
        entries: [
          {
            id: 'r1',
            method: 'POST',
            url: 'https://shop.test/api/orders?access_token=secret-value',
            type: 'xhr',
            status: 200,
            request: {
              headers: { cookie: 'sid=abc', authorization: 'Bearer zzz', 'content-type': 'application/json' },
              body: JSON.stringify({ user: 'ivan', password: 'hunter2' })
            },
            response: {
              headers: { 'set-cookie': 'sid=abc' },
              body: JSON.stringify({ token: 'abc', items: [1, 2] })
            }
          }
        ]
      })
    })
    assert.equal(bridge.net.length, 1)
    const entry = bridge.net[0]
    assert.equal(entry.request.headers.cookie, '«redacted»')
    assert.equal(entry.request.headers.authorization, '«redacted»')
    assert.equal(entry.request.headers['content-type'], 'application/json')
    assert.equal(entry.response.headers['set-cookie'], '«redacted»')
    assert.equal(new URL(entry.url).searchParams.get('access_token'), '«redacted»')
    const requestBody = JSON.parse(entry.request.body)
    assert.equal(requestBody.user, 'ivan')
    assert.equal(requestBody.password, '«redacted»')
    const responseBody = JSON.parse(entry.response.body)
    assert.equal(responseBody.token, '«redacted»')
    assert.deepEqual(responseBody.items, [1, 2])
  } finally {
    await bridge.close()
  }
})

test('target and hello events describe the connection', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`http://127.0.0.1:${bridge.port}/v1/evt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ kind: 'hello', version: '0.1.0', browser: 'Chrome/145' })
    })
    await fetch(`http://127.0.0.1:${bridge.port}/v1/evt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ kind: 'target', tab: { id: 7, url: 'https://shop.test/cart', title: 'Cart' } })
    })
    const state = bridge.state()
    assert.equal(state.clientConnected, true)
    assert.equal(state.clientVersion, '0.1.0')
    assert.equal(state.target.url, 'https://shop.test/cart')
    assert.equal(state.target.id, 7)
  } finally {
    await bridge.close()
  }
})

test('an unanswered command times out instead of hanging forever', async () => {
  const bridge = await startBridge()
  try {
    await assert.rejects(bridge.enqueue('ping', {}, { timeout: 200 }), /did not answer/)
  } finally {
    await bridge.close()
  }
})

test('target events keep the fields the extension adds', async () => {
  const bridge = await startBridge()
  try {
    await fetch(`http://127.0.0.1:${bridge.port}/v1/evt`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        kind: 'target',
        tab: { id: 4, url: 'https://a.test/', title: 'A', attachedBy: 'user' }
      })
    })
    const target = bridge.state().targets.find((item) => item.id === 4)
    assert.ok(target, 'target should be stored')
    assert.equal(target.attachedBy, 'user')
  } finally {
    await bridge.close()
  }
})
