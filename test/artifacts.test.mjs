import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { captureDirName, renderApiMd, renderSelectorsMd, writeBundle } from '../lib/artifacts.js'

const ROOT = join(process.cwd(), '.test-out', 'captures')

const snapshot = {
  url: 'https://shop.test/cart',
  title: 'Корзина',
  viewport: { w: 1440, h: 900, dpr: 1 },
  scroll: { x: 0, y: 0, w: 1440, h: 1800 },
  frameworks: ['next'],
  counts: { shadowRoots: 0, frames: 0 },
  cssVars: { '--brand': '#1a73e8', '--radius': '12px' },
  nodes: [
    {
      i: 0,
      p: -1,
      tag: 'button',
      id: '',
      cls: ['btn', 'btn-primary'],
      role: 'button',
      name: '',
      text: 'Купить',
      attrs: { 'data-testid': 'buy' },
      rect: { x: 30, y: 400, w: 160, h: 44 },
      vis: true,
      d: 4,
      sel: { best: '[data-testid="buy"]', unique: true, candidates: [{ selector: '[data-testid="buy"]', matches: 1 }] }
    },
    {
      i: 1,
      p: -1,
      tag: 'div',
      id: '',
      cls: ['decor'],
      role: '',
      name: '',
      text: '',
      attrs: {},
      rect: { x: 0, y: 0, w: 1440, h: 200 },
      vis: true,
      d: 2,
      sel: { best: 'div > div.decor', unique: false, candidates: [] }
    }
  ],
  styles: { 0: { color: 'rgb(255, 255, 255)', 'background-color': 'rgb(26, 115, 232)' } },
  html: '<button data-testid="buy" class="btn btn-primary">Купить</button>'
}

const entries = [
  {
    id: '1',
    method: 'POST',
    url: 'https://shop.test/api/orders?draft=1',
    status: 201,
    type: 'xhr',
    mimeType: 'application/json',
    request: { headers: { 'content-type': 'application/json', 'x-csrf-token': '«redacted»' }, body: '{"qty":1}' },
    response: { headers: { 'content-type': 'application/json' }, body: '{"id":9,"items":[{"sku":"A1"}]}' }
  },
  {
    id: '2',
    method: 'GET',
    url: 'https://shop.test/api/cart',
    status: 200,
    type: 'fetch',
    mimeType: 'application/json',
    request: { headers: { accept: 'application/json' }, body: null },
    response: { headers: {}, body: '{"items":[]}' }
  }
]

test('capture directory name is filesystem safe', () => {
  const name = captureDirName('shop.test:443', new Date('2026-11-01T10:20:30'))
  assert.equal(name, 'shop.test_443/20261101-102030')
  assert.equal(captureDirName('', new Date('2026-11-01T10:20:30')), 'site/20261101-102030')
})

test('selectors.md shortlists interactive nodes and explains stability', () => {
  const md = renderSelectorsMd(snapshot)
  assert.match(md, /data-testid="buy"/)
  assert.match(md, /unique/)
  assert.match(md, /Купить/)
  assert.doesNotMatch(md, /decor/)
  assert.match(md, /test hook/)
})

test('api.md groups by method and path and shows the contract', () => {
  const md = renderApiMd(entries)
  assert.match(md, /## POST \/api\/orders/)
  assert.match(md, /## GET \/api\/cart/)
  assert.match(md, /x-csrf-token/)
  assert.match(md, /"qty": 1/)
  assert.match(md, /items\[\]\.sku/)
})

test('writeBundle writes every artifact and nothing secret', async () => {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
  const result = await writeBundle({
    root: ROOT,
    host: 'shop.test',
    snapshot,
    entries,
    meta: { host: 'shop.test', url: snapshot.url, title: snapshot.title, capturedAt: new Date().toISOString() }
  })
  assert.deepEqual(
    result.files.sort(),
    ['README.md', 'api.md', 'dom.html', 'dom.json', 'meta.json', 'network.jsonl', 'selectors.md', 'styles.json']
  )
  const dom = JSON.parse(await readFile(join(result.dir, 'dom.json'), 'utf8'))
  assert.equal(dom.nodes.length, 2)
  assert.equal(dom.frameworks[0], 'next')
  const styles = JSON.parse(await readFile(join(result.dir, 'styles.json'), 'utf8'))
  assert.equal(styles.cssVars['--brand'], '#1a73e8')
  const network = await readFile(join(result.dir, 'network.jsonl'), 'utf8')
  assert.equal(network.trim().split('\n').length, 2)
  const api = await readFile(join(result.dir, 'api.md'), 'utf8')
  assert.doesNotMatch(api, /Bearer /)
  assert.match(await readFile(join(result.dir, 'selectors.md'), 'utf8'), /Купить/)
})
