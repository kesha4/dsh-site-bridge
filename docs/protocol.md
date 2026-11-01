# Wire protocol

Transport is plain HTTP over loopback. There is no WebSocket: the extension long-polls for work,
which keeps the MV3 service worker alive and survives its restarts without reconnect logic.

```
extension  ──GET  /v1/poll?timeout=20000──►  host
           ◄──{ commands: [...] }──────────
           ──POST /v1/result {id, ok}───►
           ──POST /v1/evt   {kind}──────►
```

## Authentication

Every request carries `x-site-token: <token>`. The token is 24 random bytes (base64url, 32 chars)
generated once and stored next to the DSH home:

```
$DSH_HOME/site-bridge/bridge.json  →  { "port": 47321, "token": "..." }
```

A missing or wrong token yields `401`. The host compares in constant time and never logs the value.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/ping` | liveness probe; does **not** mark the extension as connected |
| `GET` | `/v1/poll?timeout=<ms>` | long-poll for queued commands (1–25 s, default 20 s) |
| `POST` | `/v1/result` | command result: `{ id, ok: true, data }` or `{ id, ok: false, error }` |
| `POST` | `/v1/evt` | asynchronous events (see below) |
| `GET` | `/v1/state` | host-side view, for diagnostics |

`/v1/poll` returns `{ ok: true, seq, commands: [{ id, seq, op, args, ts }] }`. A poll with nothing
queued returns an empty array after the timeout, which the extension answers with another poll.

## Commands (`op`)

| `op` | `args` | `data` |
|---|---|---|
| `tabs.list` | — | `{ tabs: [{ id, title, url, active, windowId, target }] }` |
| `tab.claim` | `{ tabId }` | `{ target: { id, url, title } }` |
| `tab.info` | — | `{ target, attached }` |
| `dom.snapshot` | `{ selector?, maxNodes? }` | node tree, styles, CSS variables, counts |
| `net.start` / `net.stop` | — | `{ recording, captured }` |
| `net.list` | `{ query?, limit? }` | `{ captured, items }` |
| `net.get` | `{ id }` | `{ entry }` |
| `net.clear` | — | `{ captured: 0 }` |
| `act` | `{ steps: [...] }` | `{ ok, results: [{ op, ok, ... }] }` |
| `cursor` | `{ x, y, click?, button? }` | `{ x, y, clicked }` |
| `eval` | `{ expression }` | `{ value }` |
| `inject` | `{ js?, css? }` | `{ injected, value }` |
| `shot` | `{ fullPage? }` | `{ png: <base64> }` |

`act` steps: `exists`, `click`, `hover`, `fill`, `type`, `select`, `press`, `scroll`, `upload`,
`goto`, `reload`, `wait`, `eval`, `screenshot`. A failing step stops the batch and is reported with
`ok: false` and `error`; earlier steps stay applied (actions are not rolled back).

## Events (`/v1/evt`)

| `kind` | Payload | Meaning |
|---|---|---|
| `hello` | `{ version, browser }` | extension came online (first successful poll) |
| `target` | `{ tab: { id, url, title } \| null }` | active tab changed or detached |
| `tabs` | `{ tabs }` | periodic tab inventory |
| `netcontrol` | `{ recording }` | recording toggled |
| `net` | `{ entries: [...] }` | captured requests, batched every ~400 ms |
| `netclear` | — | buffer dropped |
| `error` | `{ message }` | extension-side failure worth surfacing |

Network entries are redacted by the **host** on ingest, so the extension never needs to know which
header names or body keys are sensitive; the extension only reports what CDP gave it.

## Liveness

`lastSeen` is refreshed only by `/v1/poll`, `/v1/result` and `/v1/evt`. Diagnostics (`/v1/ping`,
`/v1/state`) deliberately do not touch it — otherwise a host-side probe would make a dead extension
look connected.

## Command lifecycle

1. A tool calls `bridge.enqueue(op, args, { timeout })`.
2. The command gets a monotonic `seq` and lands in a FIFO queue.
3. An open long-poll is answered immediately with everything queued.
4. The extension executes and posts `/v1/result`.
5. The waiting promise resolves; on `ok: false` it rejects with the reported error.
6. If no result arrives within the timeout (45 s by default, 90 s for `act`), the promise rejects and
   the command is dropped from the queue.

The host keeps a single in-flight client by design: one queue, one target tab. Multi-tab support is
tracked in [limitations.md](limitations.md).

## Failure modes

| Symptom | Cause |
|---|---|
| `401` on every poll | token in the popup does not match `bridge.json` |
| `bridge did not answer «op» within Nms` | service worker was suspended mid-command, or the tab was closed |
| `no page attached` | nothing claimed; `site_tabs {action:"claim"}` first |
| `element not found` | selector does not resolve in the page (see deep-selector syntax) |
| `browser not connected` | popup not paired, or DSH stopped |
