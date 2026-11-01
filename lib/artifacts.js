/**
 * Snapshot bundle: turn one capture into files the agent can read.
 *
 * The bundle is the contract between "I looked at the site" and "I write an
 * extension that embeds into it": selectors and styles for the markup side,
 * endpoint contracts for the BFF side.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_HTML_BYTES = 2_000_000
const MAX_BODY_CHARS = 200_000
// Above this a response body is written to bodies/<id>.json instead of being
// inlined into network.jsonl and api.md.
const BODY_SPILL_CHARS = 200_000

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function captureDirName(host, date = new Date()) {
  const safe = String(host || 'site').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 64) || 'site'
  return `${safe}/${stamp(date)}`
}

function pretty(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2)
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return value
    }
  }
  return value
}

function truncate(value, limit = MAX_BODY_CHARS) {
  if (typeof value !== 'string') return value ?? null
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated (${value.length} chars)` : value
}

function selectorReason(node) {
  const best = node.sel?.best ?? ''
  if (best.startsWith('#')) return 'id-based, most stable'
  if (best.includes('data-testid')) return 'test hook, stable by design'
  if (best.includes('data-')) return 'data attribute, fairly stable'
  if (best.includes('[name=')) return 'form name, stable'
  if (best.includes('[aria-label=')) return 'accessibility label, semantics-bound'
  if (best.includes(':nth-of-type')) return 'positional, fragile under layout changes'
  return 'class-based, verify against a fresh capture'
}

/** Markdown table of the elements worth targeting from an injected script. */
export function renderSelectorsMd(snapshot) {
  const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
  const interesting = nodes
    .filter((node) => node.vis !== false)
    .filter((node) => {
      const role = String(node.role ?? '')
      const tag = String(node.tag ?? '')
      return (
        node.attrs?.['data-testid'] !== undefined ||
        node.id !== '' ||
        ['button', 'a', 'input', 'select', 'textarea'].includes(tag) ||
        ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem'].includes(role)
      )
    })
    .slice(0, 400)

  const lines = [
    `# Selectors — ${snapshot?.title ?? ''}`,
    '',
    `URL: ${snapshot?.url ?? ''}`,
    `Captured nodes: ${nodes.length}; interactive/semantic: ${interesting.length}`,
    '',
    '| # | tag | role | text | best selector | matches | why |',
    '|---|-----|------|------|---------------|---------|-----|'
  ]
  for (const node of interesting) {
    const text = String(node.text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 40)
    const best = String(node.sel?.best ?? '').replace(/\|/g, '\\|')
    const matches = node.sel?.unique === false ? 'NOT unique' : 'unique'
    lines.push(
      `| ${node.i} | ${node.tag ?? ''} | ${node.role ?? ''} | ${text} | \`${best}\` | ${matches} | ${selectorReason(node)} |`
    )
  }
  lines.push(
    '',
    '## Notes for the extension author',
    '',
    '- Prefer `data-testid`/`id`/`name`/`aria-label` over class chains; the class-based candidates in `dom.json` are positional and break on redeploy.',
    '- Every selector above was checked against the live DOM at capture time; re-check with `site_act { op: "exists" }` before shipping.',
    '- If the site renders into shadow roots or iframes, `dom.json.counts` reports how many were seen but not traversed.'
  )
  return lines.join('\n')
}

function collectJsonShape(body, depth = 0, prefix = '', out = new Set()) {
  if (depth > 3 || body === null) return out
  if (Array.isArray(body)) {
    const first = body.find((item) => item !== null && item !== undefined)
    if (first !== undefined) collectJsonShape(first, depth + 1, `${prefix}[]`, out)
    return out
  }
  if (typeof body !== 'object') return out
  for (const [key, value] of Object.entries(body)) {
    const path = prefix ? `${prefix}.${key}` : key
    const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    out.add(`${path}: ${kind}`)
    if (value && typeof value === 'object') collectJsonShape(value, depth + 1, path, out)
  }
  return out
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Group captured traffic into endpoints and document each contract. */
export function renderApiMd(entries, { redactedNote = true } = {}) {
  const groups = new Map()
  for (const entry of entries) {
    const method = String(entry?.method ?? 'GET').toUpperCase()
    let path = String(entry?.url ?? '')
    try {
      const parsed = new URL(path)
      path = parsed.pathname
    } catch {
      // relative URL: keep as is
    }
    const key = `${method} ${path}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }

  const lines = [
    '# BFF API',
    '',
    `Endpoints: ${groups.size}; captured requests: ${entries.length}`,
    ''
  ]
  if (redactedNote) {
    lines.push(
      'Credential-shaped header values, query parameters and JSON values are replaced with `«redacted»`.',
      'A selector like `x-csrf-token: «redacted»` still tells you the header is required — read its value',
      'from the page at runtime instead of hardcoding it.',
      ''
    )
  }

  for (const [key, items] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const sample = items[0]
    const statuses = [...new Set(items.map((item) => item?.status ?? '?'))].join(', ')
    lines.push(`## ${key}`, '')
    lines.push(`- calls: ${items.length}`)
    lines.push(`- status: ${statuses}`)
    if (sample?.type) lines.push(`- resource: ${sample.type}`)
    if (sample?.mimeType) lines.push(`- mime: ${sample.mimeType}`)
    lines.push('')

    const reqHeaders = sample?.request?.headers ?? {}
    const headerNames = Object.keys(reqHeaders)
    if (headerNames.length > 0) {
      lines.push('Request headers: `' + headerNames.join('`, `') + '`', '')
    }
    const reqBody = truncate(pretty(sample?.request?.body), 8000)
    if (reqBody) {
      lines.push('Request body:', '```', reqBody, '```', '')
    }
    const respBody = truncate(pretty(sample?.response?.body), 12000)
    if (sample?.response?.bodyRef) {
      lines.push(
        `Response body: saved separately in \`${sample.response.bodyRef}\` (${sample.response.bodyChars} chars)`,
        ''
      )
    } else if (respBody) {
      const shape = collectJsonShape(parseMaybeJson(sample?.response?.body))
      if (shape.size > 0) {
        lines.push('Response fields: `' + [...shape].slice(0, 40).join('`, `') + '`', '')
      }
      const truncated = sample?.response?.truncated
        ? ' (truncated by the capture limit — raise `maxBodyChars` for the full body)'
        : ''
      lines.push(`Response body${truncated}:`, '```', respBody, '```', '')
    }
    if (items.length > 1) {
      const variants = items.slice(1, 3).map((item, index) => {
        const body = truncate(pretty(item?.request?.body), 2000)
        return body ? `  ${index + 2}. \`${body.replace(/\s+/g, ' ').slice(0, 240)}\`` : ''
      }).filter(Boolean)
      if (variants.length > 0) {
        lines.push('Other request variants:', ...variants, '')
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function renderBundleReadme({ meta, snapshot, entries }) {
  return [
    '# Snapshot bundle',
    '',
    `- site: ${meta.host}`,
    `- url: ${meta.url}`,
    `- captured: ${meta.capturedAt}`,
    `- browser: ${meta.browser ?? 'chromium'}`,
    '',
    '## Files',
    '',
    '| file | what is inside |',
    '|---|---|',
    '| `meta.json` | capture metadata, viewport, framework hints |',
    '| `dom.html` | serialized markup of the captured scope |',
    '| `dom.json` | element tree with boxes, attributes, selector candidates |',
    '| `styles.json` | computed styles of key nodes + CSS custom properties |',
    '| `selectors.md` | shortlist of stable selectors for injected scripts |',
    '| `network.jsonl` | every captured xhr/fetch, one JSON per line |',
    '| `api.md` | grouped endpoint contracts (method, headers, bodies) |',
    '',
    '## How to use it',
    '',
    '1. `selectors.md` -> anchors for the UI you inject.',
    '2. `styles.json` -> colors, spacing and font tokens so the injected UI looks native.',
    '3. `api.md` -> the BFF contract; call it from the page context so the browser attaches cookies itself.',
    '4. After writing the extension, verify it live: `site_inject` with your script source.',
    '',
    `Nodes: ${snapshot?.nodes?.length ?? 0}; requests: ${entries.length}.`
  ].join('\n')
}

/**
 * Write the whole bundle.
 * @param {{root: string, host: string, snapshot: object, entries: object[], meta: object}} input
 */
export async function writeBundle({ root, host, snapshot, entries, meta }) {
  const dir = join(root, captureDirName(host))
  await mkdir(dir, { recursive: true })

  // Large bodies go to their own files: markdown stays readable, the model
  // never receives a two-megabyte blob, and nothing is silently lost.
  const spilled = []
  const slimEntries = entries.map((entry) => {
    const body = entry?.response?.body
    if (typeof body !== 'string' || body.length <= BODY_SPILL_CHARS) return entry
    const name = `bodies/${String(entry.id).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`
    spilled.push({ name, body })
    return {
      ...entry,
      response: { ...entry.response, body: null, bodyRef: name, bodyChars: body.length }
    }
  })
  if (spilled.length > 0) await mkdir(join(dir, 'bodies'), { recursive: true })
  for (const item of spilled) await writeFile(join(dir, item.name), item.body, 'utf8')

  const html = truncate(String(snapshot?.html ?? ''), MAX_HTML_BYTES)
  const networkLines = slimEntries.map((entry) => JSON.stringify(entry)).join('\n')
  const domJson = {
    url: snapshot?.url ?? meta.url,
    title: snapshot?.title ?? '',
    viewport: snapshot?.viewport ?? null,
    scroll: snapshot?.scroll ?? null,
    frameworks: snapshot?.frameworks ?? [],
    counts: snapshot?.counts ?? null,
    nodes: snapshot?.nodes ?? []
  }
  const stylesJson = {
    cssVars: snapshot?.cssVars ?? {},
    nodes: snapshot?.styles ?? {}
  }
  const files = {
    'meta.json': JSON.stringify(
      { ...meta, captured: new Date().toISOString(), requests: entries.length, nodes: snapshot?.nodes?.length ?? 0 },
      null,
      2
    ),
    'dom.html': html,
    'dom.json': JSON.stringify(domJson, null, 2),
    'styles.json': JSON.stringify(stylesJson, null, 2),
    'selectors.md': renderSelectorsMd(snapshot),
    'network.jsonl': networkLines,
    'api.md': renderApiMd(slimEntries),
    'README.md': renderBundleReadme({ meta, snapshot, entries })
  }

  const written = []
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8')
    written.push(name)
  }
  for (const item of spilled) written.push(item.name)
  return { dir, files: written, nodes: snapshot?.nodes?.length ?? 0, requests: entries.length, spilled: spilled.length }
}
