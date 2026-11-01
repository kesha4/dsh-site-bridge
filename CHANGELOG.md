# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule of this repository: every commit that changes shipped code bumps the version and adds a section
here; docs-only commits do not. `node tools/version.mjs check` enforces that `package.json`,
`extension/manifest.json` and this file agree, and `node tools/version.mjs bump <kind>` updates all
three at once.

## [Unreleased]

_Nothing yet._

## [0.3.1] — 2026-11-02

### Added

- **Connection progress.** While the bridge is not answering, the popup shows a spinner and
  "Подключаюсь к мосту… попытка N" (`Waiting for the bridge… attempt N`, `正在连接网桥… 第 N 次`)
  instead of a dead end, so waiting is an obvious option.
- Transport errors are translated into actionable hints: a token mismatch and "DSH is not running"
  read differently, and the raw error only appears after two attempts.

### Fixed

- `hidden` elements with `display: flex` stayed visible — an empty tab switcher showed up in the popup.
- `node tools/version.mjs bump` stamped the date in UTC and dropped the `[Unreleased]` body; it now uses
  the local date and keeps the section intact, covered by `test/version.test.mjs`.

## [0.3.0] — 2026-11-02

### Added

- **Several tabs per session.** The worker keeps one debugger session per tab with its own recording
  flag and request buffer; the bridge tracks every attached target with an active one; every `site_*`
  tool accepts an optional `tab` id; `site_tabs` gained `use` and `release`; the popup shows a tab
  switcher once more than one tab is attached.

### Changed

- Commands run sequentially in the worker, so a pinned tab applies to the whole command.
- Captured traffic is tagged with its tab and `site_capture` only includes the captured tab.

### Fixed

- The bridge did not expose the per-tab recording flag, so `site_capture` started from a clean buffer
  and lost the click that produced the BFF call.

## [0.2.2] — 2026-11-02

### Fixed

- The capture toggle said "Запись: выкл" without saying what is recorded, and the counter said
  "записей" while the bundle contains HTTP requests. Now "Запись API: вкл/выкл" (`API capture`,
  `接口录制`) and the counter counts requests (en/ru/zh).

## [0.2.1] — 2026-11-02

### Fixed

- The popup was taller than Chrome's popup limit and scrolled. Pairing moved into a collapsed
  `<details>`, the capture toggle became a compact row, and hints were shortened: ~330 px instead of
  ~600 px.

### Added

- The token field is masked and reveals only while focused, with a live length counter.

## [0.2.0] — 2026-11-02

### Added

- **Response bodies are no longer silently cut at 400 KB.** The extension keeps up to 5 MB per body
  (`maxBodyChars`), records `bodyChars` and an explicit `truncated` flag; the host writes anything
  above 200 KB to `bodies/<id>.json` with `bodyRef`/`bodyChars` in `network.jsonl`, and `api.md`
  points at the file. Base64 bodies are reported by size instead of a placeholder string.
- Test coverage for the spill path.

### Changed

- `docs/limitations.md` tracks the status of each limitation.

## [0.1.0] — 2026-11-02

Initial public release: a DSH plugin and a Chrome/Edge MV3 extension that work as one bridge.

### Added

- **Host half (`dsh-site-bridge`)** — loopback HTTP bridge with long-poll transport, per-request token
  auth, FIFO command queue, redaction on ingest, and a snapshot bundle writer (`dom.html`, `dom.json`,
  `styles.json`, `selectors.md`, `network.jsonl`, `api.md`, `meta.json`, `README.md`,
  `screenshot.png`).
- **Tools** — `site_status`, `site_tabs`, `site_capture`, `site_network`, `site_act`, `site_cursor`,
  `site_shot`, `site_inject`.
- **Browser half** — MV3 service worker driving the page over `chrome.debugger`: network capture with
  headers and bodies, trusted input (`Input.dispatchMouseEvent` / `insertText` /
  `setFileInputFiles`), virtual cursor overlay, screenshots, DOM snapshot with computed styles and
  selector candidates.
- **Deep element resolution** — `host >>> inner` selectors that cross open shadow roots and
  same-origin iframes, with click coordinates corrected for frame offsets.
- **Popup** — pairing with autosave, `bridge.json` import, target tab, capture toggle.
- **Localization** — English, Russian and Simplified Chinese for the popup and the manifest.
- **Icon** — inverted page mark with the DSH whale and a browser bar, rendered at 16/32/48/128 by the
  same Chrome that runs the extension.
- **Tests** — unit, integration and end-to-end checks against a real Chrome.

### Security

- Credential-shaped header values, query parameters and JSON/form fields are replaced with
  `«redacted»` before anything is written to disk.
- Captured traffic is limited to the inspected site's own `xhr`/`fetch` calls and third-party JSON.
- The bridge binds `127.0.0.1` only and rejects every request without the pairing token.
