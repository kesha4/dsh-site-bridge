# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Response bodies are no longer silently cut at 400 KB.** The extension keeps up to 5 MB per body
  (`maxBodyChars` in `chrome.storage.local`), records `bodyChars` and an explicit `truncated` flag,
  and the host writes anything above 200 KB to `bodies/<id>.json` with `bodyRef`/`bodyChars` in
  `network.jsonl`. `api.md` points at the file instead of printing a megabyte. Base64 bodies are
  reported as a byte count instead of a fake string.

### Added

- Test coverage for the spill path (`test/artifacts.test.mjs`).

## [0.1.0] — 2026-11-02

Initial public release: a DSH plugin and a Chrome/Edge MV3 extension that work
as one bridge.

### Added

- **Host half (`dsh-site-bridge`)** — loopback HTTP bridge with long-poll
  transport, per-request token auth, command queue, redaction on ingest, and a
  snapshot bundle writer (`dom.html`, `dom.json`, `styles.json`,
  `selectors.md`, `network.jsonl`, `api.md`, `meta.json`, `README.md`).
- **Tools** — `site_status`, `site_tabs`, `site_capture`, `site_network`,
  `site_act`, `site_cursor`, `site_inject`, `site_shot`.
- **Browser half** — MV3 service worker driving the page over
  `chrome.debugger`: network capture with headers and bodies, trusted input
  (`Input.dispatchMouseEvent` / `insertText` / `setFileInputFiles`), virtual
  cursor overlay, screenshots, DOM snapshot with computed styles and selector
  candidates.
- **Deep element resolution** — `host >>> inner` selectors that cross open
  shadow roots and same-origin iframes, with click coordinates corrected for
  frame offsets.
- **Popup** — pairing with autosave, `bridge.json` import, masked token with a
  live length counter, connection state, target tab and capture toggle.
- **Localization** — the popup and the manifest follow the browser language:
  English, Russian and Simplified Chinese (`extension/_locales`).
- **Icon** — inverted page mark with the DSH whale and a browser bar, rendered
  at 16/32/48/128 by the same Chrome that runs the extension.
- **Tests** — 22 unit/integration checks, 31 end-to-end checks against a real
  Chrome through the wire protocol, 19 checks through the tool layer.

### Security

- Credential-shaped header values, query parameters and JSON/form fields are
  replaced with `«redacted»` before anything is written to disk.
- Captured traffic is limited to the inspected site's own `xhr`/`fetch` calls
  and third-party JSON, so page source dumps from injected telemetry never
  reach the bundle.
- The bridge binds `127.0.0.1` only and rejects every request without the
  pairing token.
