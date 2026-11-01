# dsh-site-bridge

**English** · [Русский](README.ru.md) · [中文](README.zh-CN.md)

**Hands and eyes for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) in your own browser.**
Capture a page's markup and its BFF traffic into files an agent can read, drive the page with trusted
input, and verify the extension you just wrote — live, in the same tab.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Two halves, one bridge:

| Half | What it does |
|---|---|
| **DSH plugin** (`lib/`) | Owns the loopback bridge and exposes eight tools to the model. Writes the snapshot bundle into the session workspace. |
| **MV3 extension** (`extension/`) | Lives in your Chrome/Edge profile, works with your cookies, captures markup and network over CDP, drives the page with real input events. Localized: English, Русский, 中文. |

Neither half is useful alone: the plugin holds the model-facing surface and the files, the extension
holds the browser session and the fidelity.

---

## Why

Writing an extension that embeds into someone else's site is mostly archaeology: what the markup is
actually made of, which selector survives the next deploy, and which BFF endpoint this button calls
with which payload. By hand that means DevTools, copy-paste and guesses.

This project turns the archaeology into a capture:

```
site_capture → captures/<host>/<timestamp>/
  dom.html          serialized markup of the captured scope
  dom.json          element tree: boxes, attributes, selector candidates
  styles.json       computed styles of key nodes + CSS custom properties
  selectors.md      shortlist of stable selectors, with why each is stable
  network.jsonl     every captured xhr/fetch, one JSON object per line
  api.md            endpoints grouped by method+path, with request/response contracts
  screenshot.png    optional full-page render
```

The agent reads those files like any other source and writes the extension. Then `site_inject` runs
that code in the live page, so "it should work" becomes "it works here".

## Features

- **Markup** — element tree with boxes and visibility, computed styles of interactive nodes, CSS
  variables of the theme, and selector candidates ranked by stability (`data-testid` > `id` > `name` >
  `aria-label` > class path > positional path), each checked for uniqueness against the live DOM.
- **BFF traffic** — `xhr`/`fetch` with method, status, request headers, request body, response
  headers and response body, scoped to the inspected site.
- **Trusted input** — clicks, typing, select, key presses, scrolling and file uploads through CDP
  `Input.*` / `DOM.setFileInputFiles`: events the page cannot tell apart from a human's.
- **Virtual cursor** — a DOM overlay that moves to the target plus a real mouse event at those
  coordinates, for controls that ignore synthetic `click()`.
- **Deep selectors** — `host >>> inner` resolves through open shadow roots and same-origin iframes;
  click coordinates are corrected for frame offsets.
- **Works in background tabs** — reading, clicking, typing and screenshots work while the tab is not
  focused (Chrome throttles only timers and animation there).
- **No stored credentials** — see [Security](#security).

## Requirements

- DeepSeek Harness with the `dsh` CLI and a profile (Desktop or Web).
- Chrome or Edge 125+ (the extension uses `chrome.debugger` and MV3 service workers).
- Node.js 22+ for the tooling in `tools/` and for the tests.

## Install

### 1. Host half

```powershell
# from the repository root
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

The script links the plugin into your profile, adds it to `dsh.profile.bundles`, and stages the
extension into `%USERPROFILE%\.dsh\site-bridge\extension`. Manual equivalent:

```powershell
dsh plugin --profile desktop add <path-to-this-repo>
```

Add `"dsh-site-bridge"` to `dsh.profile.bundles` in `%USERPROFILE%\.dsh\profiles\desktop\package.json`
if the CLI did not, then restart DSH — the host half loads at profile start.

### 2. Browser half

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   `%USERPROFILE%\.dsh\site-bridge\extension`.
2. Open the popup. It shows the port and the path to `bridge.json` (the same is printed by
   `site_status`).
3. Click **Import bridge.json** (`Импорт bridge.json` / `导入 bridge.json`) and pick that file, or
   paste the token — it saves itself, no button.
4. Open the page you want to work on and click **Connect this tab**.

Chrome shows the "started debugging this browser" banner: that is the CDP session everything runs
on. It disappears when you press **Disconnect**.

The popup UI follows the browser language: English, Russian and Simplified Chinese ship in
`extension/_locales`.

## Usage

```text
site_status                     → bridge state, pairing path, current tab
site_tabs {action:"list"}       → tabs; {action:"claim", tabId} binds one
site_network {action:"start"}   → begin recording, then act on the page
site_capture {screenshot:true}  → write the bundle into the workspace
site_act {steps:"[...]"}        → click/fill/type/select/press/scroll/upload/wait/eval
site_cursor {x,y,click:true}    → virtual cursor, real mouse event
site_shot {fullPage:true}       → screenshot to captures/shots/*.png
site_inject {js:"..."}          → run your script in the page to verify it
```

A typical loop for writing a page-embedded extension:

1. `site_tabs` → bind the page.
2. `site_capture` → read `selectors.md`, `styles.json`, `api.md`.
3. Write the userscript / content script in your own repository.
4. `site_inject` with the script body → check that the anchor is found and the BFF call passes with
   the browser's cookies.
5. Iterate on the selectors the capture marked as fragile.

## Architecture

```
┌──────────────────────────── DSH host ────────────────────────────┐
│  tools (site_*)  ──►  bridge: 127.0.0.1, token, long-poll queue    │
│  redaction on ingest ──► in-memory buffer ──► artifacts writer     │
└───────────────────────────────┬───────────────────────────────────┘
                                │ HTTP long-poll (no websocket)
┌───────────────────────────────┴───────────────────────────────────┐
│  MV3 service worker: chrome.debugger ──► CDP                        │
│    Network domain  → requests with headers and bodies              │
│    Input domain    → trusted mouse/keyboard, file uploads          │
│    Runtime domain  → DOM snapshot, selectors, injected scripts     │
│  popup: pairing, target tab, capture toggle (ru / en / zh)         │
└────────────────────────────────────────────────────────────────────┘
```

The wire protocol is small and documented in [docs/protocol.md](docs/protocol.md).

## Security

- **Credentials never leave the browser.** The extension does not read cookies or tokens: the page
  makes its own requests and the browser attaches them. The bridge sees them in flight, but values of
  `cookie`, `authorization`, `x-csrf-token`, `x-api-key`, `set-cookie` and similar headers,
  credential-shaped query parameters and credential-shaped JSON/form fields are replaced with
  `«redacted»` **on ingest** — before anything is stored.
- **Nothing credential-shaped is written to disk.** Header *names* are kept, because "this endpoint
  needs `x-csrf-token`" is part of the contract; the value is not.
- **Capture is site-scoped.** Only the inspected site's own `xhr`/`fetch` (same host, same
  registrable domain, or third-party JSON) is recorded. Telemetry and security agents that POST a full
  page dump to their servers are filtered out — otherwise page source with inline tokens would land in
  the bundle.
- **Loopback only.** The bridge binds `127.0.0.1` and rejects any request without the 32-byte pairing
  token. `site_status` prints the path to the token file, not the token.
- **Residual risk.** Header values and bodies still pass through the DSH process in memory. If a site
  puts a secret under an unusual key, redaction will not recognise it. Treat a capture bundle as
  sensitive, exactly like any traffic dump.

## Limitations

Cross-origin iframes, closed shadow roots, body size caps and one tab per session are analysed in
[docs/limitations.md](docs/limitations.md) — with the exact code location, the plan to remove each and
the expected cost.

## Tests

```powershell
node test\redact.test.mjs     #  8 — redaction rules
node test\bridge.test.mjs     #  8 — wire protocol, token, liveness
node test\artifacts.test.mjs  #  4 — bundle layout
node test\plugin.test.mjs     #  2 — tool registration and the full tool path
node test\e2e.mjs             # 31 — real Chrome through the wire protocol
node test\tools-chrome.mjs    # 19 — real Chrome through the tools
```

`e2e.mjs` and `tools-chrome.mjs` launch a throwaway Chrome, load the extension with
`Extensions.loadUnpacked`, and exercise capture, trusted input, the virtual cursor, upload, injection
and screenshots against a local page with a working BFF endpoint.

## Repository layout

```
lib/            DSH plugin: tools, bridge, redaction, artifact writer
extension/      MV3: service worker (CDP), popup, icons, locales
docs/           protocol, limitations, detailed guide
scripts/        install.ps1
tools/          icon rasteriser, popup/icon previews, asar reader (dev only)
test/           unit, integration, end-to-end
```

## License

MIT — see [LICENSE](LICENSE).
