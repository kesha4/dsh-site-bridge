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

## [0.11.1] — 2026-11-04

### Fixed

- **The popup could sit on "Служба расширения не отвечает" forever.** A message to a sleeping worker, or
  to a popup whose extension was just reloaded ("Extension context invalidated"), rejected once and the
  popup showed a dead end. `send` now retries three times, and the note shows the actual reason — with a
  specific hint when the extension was reloaded and the popup must be reopened.


## [0.11.0] — 2026-11-04

### Added

- **Pause button in the popup.** One click cuts the link inside the browser: the worker stops polling,
  marks itself disconnected for the bridge and refuses every command. No tool can reach the extension
  or turn the link back on — only that button (or the person reopening the popup) can, and the flag is
  kept in `chrome.storage`, so it survives a worker restart. While paused the popup says so and dims
  its actions.
- `test/pause.mjs` (9 checks) and a bridge-level check that a pause event marks the extension
  unreachable.


## [0.10.0] — 2026-11-03

### Added

- **DOM and actions inside cross-origin frames.** A selector may now cross an OOPIF boundary as
  `iframe[src="…"] >>> #inner`: the worker finds the frame in the page, hands the rest of the selector
  to the frame's session and adds the frame's offset back to the coordinates, so a click lands where a
  person would click. `site_snapshot` merges the frame's interactive elements in with prefixed
  selectors and page coordinates, and `site_text`, `fill` and `select` evaluate inside the frame.
- `test/oopif.mjs` grew to 8 checks: snapshot from the frame, prefixed selector, text inside the frame,
  a real click through the boundary, and the frame's own JSON call in the capture.

### Fixed

- `site_text` silently returned an empty string for any selector: it treated the resolver's
  `{ el, ox, oy }` hit as the element itself. This was true before frames existed — the page-wide form
  just never exercised it.

### Known gaps

- A second nested OOPIF (a cross-origin frame inside a cross-origin frame) is not walked yet, and
  `upload` does not reach into a frame.


## [0.9.0] — 2026-11-02

### Added

- **Network capture inside cross-origin frames (OOPIF).** The worker arms
  `Target.setAutoAttach` on every attached tab, watches child targets and drives them through
  `Target.sendMessageToTarget` — `chrome.debugger` cannot address a child target by id, so the tunnel
  is the only way in. Requests from such frames now reach the bundle, each entry carries the `frame`
  URL it came from, and `api.md` prints `- frame: …` next to the contract. Bodies are fetched inside
  the child session, so widget APIs are documented like the page's own.
- `test/oopif.mjs` (4 checks): a page on one site embeds a frame from another site; the frame's JSON
  call must appear in the capture with its frame URL.

### Fixed

- The session is registered before the debugger talks to the tab. A child-frame event arrives the
  moment auto-attach is armed, and the listener used to drop events for tabs it did not know yet.


## [0.8.2] — 2026-11-02

### Added

- `site_tabs {action:"diagnose"}` now lists the tab's frames (`webNavigation.getAllFrames`): frame id,
  parent and URL. A refused `chrome.debugger.attach` names another extension's `chrome-extension://`
  frame, and this makes the culprit identifiable by id instead of guessed at.
- The extension asks for the `webNavigation` permission, used only by that diagnostic.


## [0.8.1] — 2026-11-02

### Fixed

- **The worker could park on a Chrome call and stop polling for good.** One `await` that never settles
  (a stuck `chrome.debugger.attach`) held the loop forever while it still looked "running", so the
  popup stayed at "попытка 1" and nothing reconnected — not even after importing the right token. Every
  command now runs under a 120 s deadline, `loadCfg` moved inside the loop's try, and a 30 s watchdog
  restarts a loop that has not ticked for 90 s.
- `status` exposes `loopAlive` and `lastTickAgoMs`, so this state is visible instead of guessed.


## [0.8.0] — 2026-11-02

### Added

- `site_tabs {action:"diagnose", tabId}` — asks Chrome directly what it thinks a tab is: the full tab
  record (`url`, `pendingUrl`, `status`, `discarded`, window), the window type, and every debugger
  target Chrome sees for that tab (`type`, `url`, `attached`). Read-only.
  It exists because a plain `mail.google.com` tab was refused by `chrome.debugger.attach` with
  "Cannot access a chrome-extension:// URL of different extension", and guessing the cause twice was
  twice too many.


## [0.7.5] — 2026-11-02

### Changed

- A failed claim now says **which call** Chrome refused: `chrome.tabs.get отказал: …` or
  `chrome.debugger.attach отказал: …`. Both used to surface as a bare Chrome message, which made a
  real diagnosis impossible — the app-window explanation from 0.7.3/0.7.4 was a guess and is not
  assumed any more; the wording only mentions it when Chrome's own error looks like an extension URL.


## [0.7.4] — 2026-11-02

### Added

- `site_tabs {action:"list"}` marks tabs that live in a non-normal window (`[окно: app, недоступно]`).
  A tab can be listed with a normal https URL and still be unreadable when it belongs to another
  extension's app window — the marker makes that visible instead of guessing, and `tabs.list` now
  carries `windowType` and `readable` per tab.


## [0.7.3] — 2026-11-02

### Fixed

- **The extension reported version 0.1.0 forever.** `EXT_VERSION` was a hardcoded literal that nobody
  updated, so every diagnosis of "is the new build loaded?" was guesswork. It now reads
  `chrome.runtime.getManifest().version`.
- A tab that Chrome refuses to read (an app window of another extension) produced its internal
  "Cannot access a chrome-extension:// URL of different extension". The message now says the tab looks
  like another extension's app window and suggests opening it as a normal tab; the popup also probes
  candidate tabs with `chrome.tabs.get` and skips the unreadable ones instead of offering them.


## [0.7.2] — 2026-11-02

### Fixed

- **"Cannot access a chrome-extension:// URL of different extension" while the popup sat on a normal
  site.** The popup resolved "its" tab with `currentWindow: true`, which from a popup can point at the
  popup's own extension page instead of the page underneath. It now looks for an active tab in the
  focused normal window and prefers a real http(s)/file page; the worker's no-id fallback does the same.
  The 0.7.1 message fix stays — it now only triggers for genuinely unreadable pages.


## [0.7.1] — 2026-11-02

### Fixed

- **"Cannot access a chrome-extension:// URL of different extension" in the popup.** Claiming a service
  page or another extension's page leaked Chrome's internal error. The popup now detects an unreadable
  scheme, disables the attach buttons and explains why in the tooltip; the worker's own refusal names the
  scheme and says what to open instead.
- `test/browser-ops.mjs` covers an unreadable tab (12 checks).


## [0.7.0] — 2026-11-02

### Added

- **Consent rule for tabs the user did not attach.** `site_tabs {action:"claim"}` now refuses with a
  message naming the tab unless the call carries `confirmed: true`; closing a tab the user attached
  needs the same confirmation. The worker records who attached each tab (`attachedBy: "user" | "agent"`)
  so the rule can tell a human gesture from an agent one, and the refusal text gives the agent what it
  needs to ask the question.
- README (en/ru/zh): a `Consent` section explaining that this is a plugin rule, not an OS permission.

### Fixed

- The bridge rebuilt target objects field by field, dropping `attachedBy`; it now keeps the fields the
  extension sends. Covered by a new check in `test/bridge.test.mjs` (9 checks) and two in
  `test/plugin.test.mjs`.


## [0.6.4] — 2026-11-02

### Changed

- README (en/ru/zh) states the division of labour explicitly: the popup is a manual control for the
  person — attach, detach, record, pick — while the agent can do the same through the tools, including
  claiming any tab it sees in `site_tabs {action:"list"}`. The attach button is a human gesture, not a
  permission gate; the bridge token is what decides who may drive the browser.


## [0.6.3] — 2026-11-02

### Fixed

- **A freshly opened tab reported an empty title and address.** The session target was captured right
  after `chrome.tabs.create`, before the page loaded, and nothing refreshed it afterwards. `tab.open`
  now waits for the load and the worker listens to `chrome.tabs.onUpdated`, so titles update as pages
  navigate.
- A tab closed by hand (not through the bridge) left a stale session behind; `chrome.tabs.onRemoved`
  now drops it and re-points the default tab.
- `test/e2e.mjs` no longer races the worker: it waits for the `chrome` bindings before the first
  evaluate, which occasionally failed with "chrome is not defined".


## [0.6.2] — 2026-11-02

### Added

- `site_tabs {action:"close", tabId}` — closes a tab and drops its debugger session. Opening a tab was
  possible since 0.5.0, closing it was not, so an agent that opened a page for a check could not clean
  up after itself. Covered by a round-trip check in `test/multitab.mjs` (7 checks).


## [0.6.1] — 2026-11-02

### Changed

- The tab list no longer marks one tab as active. Every block shows its own request count and a dot
  while that tab records; "Запись API" toggles recording for **all** attached tabs and the counter
  sums them. Tools address any attached tab through their optional `tab` argument, so there is no
  primary tab to switch.
- Blocks are informational: they are not clickable any more, only the cross detaches a tab. The
  worker keeps an internal default for calls that omit `tab` (the first attached tab), which is a
  convenience, not a restriction.


## [0.6.0] — 2026-11-02

### Changed

- The popup lists attached tabs as blocks instead of a dropdown: title, address and a cross per tab.
  The active tab is outlined, clicking a block switches to it, the cross detaches that tab. The list
  scrolls on its own and fits three blocks without scrolling, so the popup keeps its height.


## [0.5.3] — 2026-11-02

### Fixed

- **"Подключить ещё вкладку" did nothing.** The button sent `{type:"claim"}` without a tab id, the
  worker tried to attach tab `NaN`, and the resulting rejection was swallowed — so the click was
  silent. Both attach buttons now share one handler that resolves the current tab, passes its id and
  shows any failure in the popup.
- `claimTab()` without an id now falls back to the active tab instead of `NaN`, so no caller can
  produce a silent no-op again. Covered by a 6th check in `test/multitab.mjs`.


## [0.5.2] — 2026-11-02

### Fixed

- The "Подключить ещё вкладку" button was shown even when the popup was opened on a tab that is
  already attached, where it would have been a no-op. The popup now asks for its own tab and hides the
  button in that case; it appears only when the current tab is not attached yet.


## [0.5.1] — 2026-11-02

### Added

- Plugin icon: `icon.svg` at the package root and `"icon": "./icon.svg"` in `package.json`, the
  convention the harness uses to show a plugin's own mark in Settings → Plugins. Without it the list
  fell back to the default glyph.


## [0.5.0] — 2026-11-02

### Added

- **`site_snapshot`** — a compact list of what a person can act on (buttons, links, fields, role-based
  controls) with a stable selector for each, returned in the tool result instead of a file. The agent
  can pick an element without opening the whole bundle.
- **`site_text`** — visible text of the page or a subtree, with a hard cap and an explicit truncation
  flag, for checking that an action produced the expected message.
- **`wait` grew two states**: `state:"hidden"` (element gone or not visible) and `state:"settle"`
  (no DOM mutations for `quietMs`, default 400 ms). Both matter for verification loops.
- **`site_tabs` gained `open` and `focus`**: open a URL in a new tab and attach it in one step, or
  bring an attached tab to the foreground.
- **History navigation**: `goto {back:true}` and `goto {forward:true}`.

### Fixed

- The popup had no way to attach a second tab once one was attached. It now has a full-width
  "Подключить ещё вкладку" button above the tab list, and the disconnect control moved into the tab
  card as a cross — it detaches that tab, not the connection.
- `wait` used the deep resolver's object as if it were a DOM element, so `state:"hidden"` always timed
  out; the resolver returns `{el, ox, oy}` and the check now uses `hit.el`. Failures also report the
  page exception instead of a bare "timed out".
- `site_text` silently raised tiny `maxChars` values to 200; the floor is now 20.

### Added (tests)

- `test/browser-ops.mjs`: 11 checks in a real Chrome — compact snapshot with a selector that resolves
  back to the element, text and truncation, settle, hidden wait, tab.open, tab.focus, history back.


## [0.4.1] — 2026-11-02

### Changed

- README (en/ru/zh): the security section is now a description of how this plugin works — token on
  every request, `debugger` instead of `<all_urls>`, permission per tab and session — with no
  judgement about how other plugins do it.
- The same edit removes the evaluative aside from the "how this differs" section: it states what this
  plugin is built for instead of commenting on other approaches.


## [0.4.0] — 2026-11-02

### Added

- **Element picker.** A cursor button in the popup arms an overlay in the page: hover highlights the
  element, a click opens a note field (Enter saves, Shift+Enter adds a line, Esc cancels), and the
  result — stable CSS selector, absolute XPath, text, box and the note — comes back through the new
  `site_pick` tool. Picks are appended to `captures/picks.jsonl`, so a capture session keeps the
  human's annotations next to the machine's snapshot.
- `dom.json` nodes now carry an absolute `xpath` next to the CSS selector candidates.
- README (en/ru/zh): a section on how this differs from browser automation plugins, and an explicit
  position on the security trade-off instead of an implicit claim of being better.
- `test/picker.mjs`: 8 checks in a real Chrome — arm, hover, real click, note, and both the selector
  and the XPath resolving to the clicked element.


## [0.3.3] — 2026-11-02

### Added

- docs/listing/awesome-dsh-plugin.yml: the entry for the community plugin list, with the checks it
  has to satisfy written next to it.
- Package metadata for distribution: epository, homepage and ugs pointing at the repository, so
  an npm release links back to it (the list maps packages by that field).

### Changed

- peerDependencies now spells out prerelease branches (>=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.3.0-rc.1).
  A plain >=0.1.0 range silently excludes every prerelease build of the harness, producing ERESOLVE
  for users on -rc releases.

## [0.3.2] — 2026-11-02

### Fixed

- `handle()` ignored `args.tabId` when called outside the command queue (the debug hook, tests), so a
  pinned tab silently fell back to the active one and captured traffic from the wrong tab. The pin now
  happens in `handle()` itself, which every caller goes through.

### Added

- `test/multitab.mjs`: two tabs attached at once, active-tab switching, and per-tab recording
  isolation, checked against a real Chrome (5 checks).

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
