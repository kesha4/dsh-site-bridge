/**
 * dsh-site-bridge — host half.
 *
 * Owns the loopback bridge and exposes the tools the agent uses to look at a
 * real page and to poke it:
 *
 *   site_status   connection state, pairing info
 *   site_tabs     list tabs / claim the one to work on
 *   site_capture  markup + BFF traffic -> files in the workspace
 *   site_network  start/stop/list/read captured xhr-fetch traffic
 *   site_act      click, fill, type, select, press, scroll, upload, eval, wait
 *   site_cursor   virtual cursor: move / click at coordinates
 *   site_inject   run the agent's own script in the page to verify it
 *
 * The bridge never persists credentials: redaction happens on ingest, and the
 * extension itself only forwards what the CDP Network domain exposes.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Bridge, loadOrCreateCredentials } from './bridge.js'
import { writeBundle } from './artifacts.js'

export const name = 'dsh-site-bridge'
export const inject = ['tools']

const DEFAULTS = {
  port: 47321,
  captureDir: '',
  autoStart: true,
  settleMs: 1200
}

const DOCS = {
  steps: [
    'click {selector} | click {x,y} — real mouse event through CDP; the virtual cursor moves there first',
    'hover {selector}',
    'fill {selector, value} — sets the value the React/Vue way (native setter + input/change events)',
    'type {selector, value} — trusted typing: click, select all, Input.insertText',
    'select {selector, value}',
    'press {key}',
    'scroll {selector?} | scroll {dx, dy}',
    'upload {selector, files: ["C:\\\\abs\\\\path.pdf"]} — absolute paths on this machine',
    'goto {url} | reload {hard?}',
    'wait {selector, timeoutMs?} | wait {ms}',
    'exists {selector}',
    'eval {expression}',
    'screenshot {fullPage?} — лучше site_shot: он пишет файл, а не base64 в контекст'
  ].join('\n')
}

function tool(name, description, parameters, run) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true, description: 'whether the tool succeeded' },
          summary: { type: 'string', description: 'human readable result, shown to the model' }
        }
      },
      render: (_args, value) => [
        { type: 'text', text: String(value?.summary ?? JSON.stringify(value, null, 2)) }
      ]
    },
    execute: async (args, exec) => run(args ?? {}, exec)
  })
}

function fail(error) {
  return { ok: false, summary: `Ошибка: ${String(error?.message ?? error)}` }
}

function ok(summary, data = {}) {
  return { ok: true, summary, ...data }
}

function parseSteps(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('steps JSON must be an array')
      return parsed
    } catch (error) {
      throw new Error(`steps is not valid JSON: ${error.message}`)
    }
  }
  throw new Error('steps is required (JSON array of step objects)')
}

function truncate(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text
}

export function apply(ctx, config) {
  const settings = {
    port: Number(config?.port) || DEFAULTS.port,
    captureDir: String(config?.captureDir ?? DEFAULTS.captureDir),
    autoStart: config?.autoStart !== false,
    settleMs: Number(config?.settleMs) || DEFAULTS.settleMs
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

  let bridge = null
  let starting = null
  let credentials = null

  async function ensureBridge() {
    if (bridge) return bridge
    if (starting) return starting
    starting = (async () => {
      credentials = await loadOrCreateCredentials(dshHome, settings.port)
      const instance = new Bridge({
        port: credentials.port,
        homeDir: dshHome,
        token: credentials.token,
        log: (message) => ctx.logger?.info?.(message)
      })
      await instance.listen()
      bridge = instance
      return instance
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  function requireTarget(instance) {
    if (!instance.state().clientConnected) {
      throw new Error(
        'браузер не подключён: откройте popup расширения DSH Site Bridge, вставьте порт и токен, нажмите «Подключить вкладку»'
      )
    }
    if (!instance.target) {
      throw new Error('вкладка не выбрана: нажмите «Подключить вкладку» в popup расширения на нужной странице')
    }
    return instance.target
  }

  async function resolveWorkspaceCwd(exec) {
    try {
      const workingDirectory = ctx.get?.('workingDirectory')
      if (workingDirectory?.ensure && exec?.agent) {
        const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
        if (typeof cwd === 'string' && cwd !== '') return cwd
      }
    } catch {
      // host without the service, or the session has no workspace yet
    }
    const fromEnv = process.env.DSH_WORKSPACE
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return undefined
  }

  async function captureRoot(dir, exec) {
    if (typeof dir === 'string' && dir.trim() !== '') {
      return isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
    }
    if (settings.captureDir !== '') {
      return isAbsolute(settings.captureDir) ? settings.captureDir : resolve(process.cwd(), settings.captureDir)
    }
    // Never default into the harness profile directory (process.cwd() of the
    // host process is ~/.dsh/profiles/<name>): the bundle belongs to the
    // session workspace, where the agent can read it.
    const workspace = await resolveWorkspaceCwd(exec)
    if (workspace) return join(workspace, 'captures')
    return join(homedir(), 'dsh-captures')
  }

  async function waitSettle(ms) {
    await new Promise((done) => setTimeout(done, Math.min(Math.max(ms, 0), 20000)))
  }

  /* --------------------------------------------------------------- tools */

  ctx.tools.register(
    tool(
      'site_status',
      'Состояние моста до браузера: запущен ли, подключён ли расширение, какая вкладка выбрана, идёт ли запись API. ' +
      'Здесь же печатается путь к файлу с токеном для popup расширения.',
      {
        showToken: {
          type: 'boolean',
          description: 'Напечатать сам токен (он попадёт в контекст модели). По умолчанию печатается только путь к файлу.'
        }
      },
      async (args) => {
        const instance = await ensureBridge()
        const state = instance.state()
        if (args.showToken === true) {
          return ok(
            [
              `Мост: http://127.0.0.1:${state.port}`,
              `Токен: ${instance.token}`,
              `Файл: ${credentials?.file ?? join(dshHome, 'site-bridge', 'bridge.json')}`,
              `Расширение: ${state.clientConnected ? `подключено (${state.clientBrowser ?? 'browser'})` : 'не подключено'}`
            ].join('\n'),
            { port: state.port, connected: state.clientConnected }
          )
        }
        const lines = [
          `Мост: ${state.listening ? `слушает http://127.0.0.1:${state.port}` : 'не запущен'}`,
          `Расширение: ${state.clientConnected ? `подключено (${state.clientBrowser ?? 'browser'})` : 'не подключено'}`,
          `Вкладка: ${state.target
            ? `${state.target.title || ''} — ${state.target.url}${state.clientConnected ? '' : ' (устарело: подключите вкладку заново)'}`
            : 'не выбрана'}`,
          `Запись API: ${state.network.recording ? 'идёт' : 'выкл'}, захвачено ${state.network.captured}`,
          `Токен и порт для popup: ${credentials?.file ?? join(dshHome, 'site-bridge', 'bridge.json')}`,
          state.clientConnected
            ? 'Дальше: site_capture — снять разметку и API в пакет.'
            : 'Дальше: откройте popup расширения, вставьте порт и токен из этого файла, нажмите «Подключить вкладку».'
        ]
        return ok(lines.join('\n'), {
          port: state.port,
          connected: state.clientConnected,
          target: state.target,
          recording: state.network.recording,
          captured: state.network.captured,
          tokenFile: credentials?.file ?? null
        })
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_tabs',
      'Список вкладок браузера или выбор вкладки, с которой работаем. Вкладка должна быть http(s) или file://.',
      {
        action: { type: 'string', description: 'list | claim' },
        tabId: { type: 'number', description: 'id вкладки для action=claim (из action=list)' }
      },
      async (args) => {
        const instance = await ensureBridge()
        const action = String(args.action ?? 'list')
        if (action === 'claim') {
          const tabId = Number(args.tabId)
          if (!Number.isFinite(tabId)) throw new Error('tabId is required for action=claim')
          const result = await instance.enqueue('tab.claim', { tabId }, { timeout: 20000 })
          const target = result?.target ?? instance.target
          return ok(`Подключена вкладка: ${target?.title || ''} — ${target?.url || ''}`, { target })
        }
        const result = await instance.enqueue('tabs.list', {}, { timeout: 20000 })
        const tabs = Array.isArray(result?.tabs) ? result.tabs : []
        const lines = tabs.map(
          (tab) => `${tab.target ? '*' : ' '} [${tab.id}] ${tab.title || '(без названия)'} — ${tab.url}`
        )
        return ok(
          tabs.length === 0
            ? 'Нет доступных вкладок (нужны http(s)/file://).'
            : `Вкладки (* — текущая):\n${lines.join('\n')}`,
          { tabs }
        )
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_capture',
      'Снять пакет снимка с текущей вкладки: разметка (DOM, стили, селекторы) и API-трафик (xhr/fetch с заголовками и телами) ' +
      'складываются в папку в рабочем пространстве — dom.html, dom.json, styles.json, selectors.md, network.jsonl, api.md. ' +
      'Авторизация вырезается при записи. Используйте пакет как основу для написания расширения, встраивающегося в страницу.',
      {
        selector: { type: 'string', description: 'Ограничить снимок этим CSS-селектором (по умолчанию body)' },
        maxNodes: { type: 'number', description: 'Предел узлов в дереве (по умолчанию 4000)' },
        settleMs: { type: 'number', description: 'Сколько ждать завершения запросов после снимка, мс (по умолчанию 1200)' },
        screenshot: { type: 'boolean', description: 'Дополнительно сохранить screenshot.png' },
        dir: { type: 'string', description: 'Куда писать пакет (по умолчанию ./captures в рабочем пространстве)' }
      },
      async (args, exec) => {
        const instance = await ensureBridge()
        const target = requireTarget(instance)
        const settleMs = Number(args.settleMs ?? settings.settleMs)
        // If the agent already turned recording on, this capture must include
        // what happened before it (e.g. the click that produced the BFF call).
        // A fresh session is requested explicitly: site_network {action:"clear"}.
        const wasRecording = instance.state().network.recording
        if (!wasRecording) {
          instance.clearNetwork()
          await instance.enqueue('net.start', {}, { timeout: 15000 })
        }
        await waitSettle(settleMs)

        const snapshot = await instance.enqueue(
          'dom.snapshot',
          { selector: args.selector ?? null, maxNodes: Number(args.maxNodes ?? 4000) },
          { timeout: 45000 }
        )
        if (snapshot?.error) throw new Error(String(snapshot.error))

        let png = null
        if (args.screenshot === true) {
          try {
            const shot = await instance.enqueue('shot', { fullPage: true }, { timeout: 30000 })
            png = shot?.png ?? null
          } catch {
            png = null
          }
        }

        if (!wasRecording) await instance.enqueue('net.stop', {}, { timeout: 15000 })
        const entries = instance.net.slice()

        const root = await captureRoot(args.dir, exec)
        await mkdir(root, { recursive: true })
        let host = ''
        try {
          host = new URL(target.url).host || 'site'
        } catch {
          host = 'site'
        }
        const result = await writeBundle({
          root,
          host,
          snapshot,
          entries,
          meta: {
            host,
            url: target.url,
            title: target.title,
            viewport: snapshot?.viewport ?? null,
            frameworks: snapshot?.frameworks ?? [],
            browser: instance.client?.browser ?? null,
            capturedAt: new Date().toISOString()
          }
        })
        if (png) {
          await writeFile(join(result.dir, 'screenshot.png'), Buffer.from(png, 'base64'))
          result.files.push('screenshot.png')
        }

        const endpoints = new Set(entries.map((entry) => `${entry.method} ${String(entry.url).split('?')[0]}`))
        return ok(
          [
            `Пакет снимка: ${result.dir}`,
            `Файлы: ${result.files.join(', ')}`,
            `Узлов: ${result.nodes}; запросов: ${result.requests}; эндпоинтов: ${endpoints.size}`,
            'Дальше: читайте selectors.md и api.md, пишите расширение; проверить его в живой странице — site_inject.'
          ].join('\n'),
          { dir: result.dir, files: result.files, nodes: result.nodes, requests: result.requests }
        )
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_network',
      'Управление записью API-трафика вкладки: start/stop/list/get/clear. Заголовки и тела сохраняются в памяти моста ' +
      'с вырезанными авторизационными значениями; на диск ничего не пишется, пока вы не сделаете site_capture.',
      {
        action: { type: 'string', description: 'start | stop | list | get | clear' },
        query: { type: 'string', description: 'Фильтр по method+url для action=list' },
        limit: { type: 'number', description: 'Сколько записей вернуть для action=list (по умолчанию 50)' },
        id: { type: 'string', description: 'id запроса для action=get' }
      },
      async (args) => {
        const instance = await ensureBridge()
        const action = String(args.action ?? 'list')
        if (action === 'start') {
          requireTarget(instance)
          instance.clearNetwork()
          await instance.enqueue('net.start', {}, { timeout: 15000 })
          return ok('Запись API включена. Выполните действие на странице (site_act или вручную), затем site_network {action:"list"}.', {})
        }
        if (action === 'stop') {
          const result = await instance.enqueue('net.stop', {}, { timeout: 15000 })
          return ok(`Запись остановлена. Захвачено записей: ${result?.captured ?? instance.net.length}.`, {})
        }
        if (action === 'clear') {
          instance.clearNetwork()
          try {
            await instance.enqueue('net.clear', {}, { timeout: 10000 })
          } catch {
            // extension may be offline; local buffer is cleared anyway
          }
          return ok('Буфер очищен.', {})
        }
        if (action === 'get') {
          const id = String(args.id ?? '')
          const entry = instance.net.find((item) => String(item.id) === id)
          if (!entry) throw new Error(`нет записи с id=${id}`)
          const lines = [
            `${entry.method} ${entry.url}`,
            `status: ${entry.status}${entry.failed ? ` (failed: ${entry.failed})` : ''} type: ${entry.type} mime: ${entry.mimeType ?? ''}`,
            `request headers: ${JSON.stringify(entry.request?.headers ?? {})}`,
            `request body: ${truncate(entry.request?.body, 4000) || '(пусто)'}`,
            `response headers: ${JSON.stringify(entry.response?.headers ?? {})}`,
            `response body: ${truncate(entry.response?.body, 20000) || '(пусто)'}`
          ]
          return ok(lines.join('\n'), { entry })
        }
        const query = String(args.query ?? '').toLowerCase()
        const limit = Math.min(Number(args.limit ?? 50), 200)
        const items = instance.net
          .filter((entry) => (query === '' ? true : `${entry.method} ${entry.url}`.toLowerCase().includes(query)))
          .slice(-limit)
        const lines = items.map(
          (entry) => `[${entry.id}] ${entry.method} ${truncate(entry.url, 160)} → ${entry.status ?? (entry.failed ? 'FAIL' : '…')}`
        )
        return ok(
          items.length === 0
            ? 'Записей нет. Включите запись: site_network {action:"start"}, затем выполните действие.'
            : `Записей: ${instance.net.length}, показано ${items.length}:\n${lines.join('\n')}`,
          { items: items.map((entry) => ({ id: entry.id, method: entry.method, url: entry.url, status: entry.status })) }
        )
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_act',
      'Действия на подключённой вкладке доверенным вводом через CDP (клик мышью, ввод текста, загрузка файлов). ' +
      'Курсор визуально двигается к цели. steps — JSON-массив шагов.\n' + DOCS.steps,
      {
        steps: { type: 'string', description: 'JSON-массив шагов, например [{"op":"click","selector":"button.submit"}]' }
      },
      async (args) => {
        const instance = await ensureBridge()
        requireTarget(instance)
        const steps = parseSteps(args.steps)
        const result = await instance.enqueue('act', { steps }, { timeout: 90000 })
        const results = Array.isArray(result?.results) ? result.results : []
        const lines = results.map((item) => {
          const detail = Object.entries(item)
            .filter(([key]) => key !== 'op' && key !== 'ok')
            .map(([key, value]) => `${key}=${truncate(JSON.stringify(value), 120)}`)
            .join(' ')
          return `${item.ok ? '✓' : '✗'} ${item.op}${detail ? ` ${detail}` : ''}${item.error ? ` — ${item.error}` : ''}`
        })
        return ok(
          `${result?.ok ? 'Шаги выполнены' : 'Шаги прерваны на ошибке'}:\n${lines.join('\n')}`,
          { results }
        )
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_shot',
      'Скриншот подключённой вкладки в файл: PNG сохраняется в рабочее пространство и в контекст не тащится. ' +
      'Работает и для вкладки в фоне. fullPage=true снимает страницу целиком, а не только видимую часть.',
      {
        fullPage: { type: 'boolean', description: 'Снять всю страницу, а не только видимую область' },
        name: { type: 'string', description: 'Имя файла без расширения (по умолчанию host-время)' },
        dir: { type: 'string', description: 'Куда сохранить (по умолчанию captures/shots в рабочем пространстве)' }
      },
      async (args, exec) => {
        const instance = await ensureBridge()
        const target = requireTarget(instance)
        const shot = await instance.enqueue('shot', { fullPage: args.fullPage === true }, { timeout: 30000 })
        if (typeof shot?.png !== 'string' || shot.png === '') throw new Error('браузер не вернул изображение')
        const bytes = Buffer.from(shot.png, 'base64')
        const root = join(await captureRoot(args.dir, exec), 'shots')
        await mkdir(root, { recursive: true })
        let host = 'page'
        try {
          host = new URL(target.url).host || 'page'
        } catch {
          host = 'page'
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const requested = typeof args.name === 'string' ? args.name.trim() : ''
        const safeName = requested === '' ? `${host}-${stamp}` : requested.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
        const file = join(root, `${safeName}.png`)
        await writeFile(file, bytes)
        const mode = args.fullPage === true ? 'вся страница' : 'видимая область'
        return ok(`Скриншот (${mode}): ${file} — ${Math.round(bytes.length / 1024)} КБ`, {
          file,
          bytes: bytes.length,
          fullPage: args.fullPage === true
        })
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_cursor',
      'Виртуальный курсор: подвинуть его в координаты окна и, если нужно, кликнуть именно там — настоящим событием мыши. ' +
      'Нужен для кнопок, которые не реагируют на программный click() (canvas, карты, drag-зоны, кастомные виджеты).',
      {
        x: { type: 'number', description: 'Координата X в окне (CSS px)' },
        y: { type: 'number', description: 'Координата Y в окне (CSS px)' },
        click: { type: 'boolean', description: 'Кликнуть в этой точке после перемещения' },
        button: { type: 'string', description: 'left | right | middle (по умолчанию left)' }
      },
      async (args) => {
        const instance = await ensureBridge()
        requireTarget(instance)
        const x = Number(args.x)
        const y = Number(args.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('нужны числовые x и y')
        const result = await instance.enqueue(
          'cursor',
          { x, y, click: args.click === true, button: args.button ?? 'left' },
          { timeout: 20000 }
        )
        return ok(
          `Курсор ${result?.clicked ? 'кликнул' : 'перемещён'} в (${x}, ${y}).`,
          { x, y, clicked: result?.clicked === true }
        )
      }
    )
  )

  ctx.tools.register(
    tool(
      'site_inject',
      'Выполнить ваш собственный скрипт (и/или CSS) в подключённой странице — чтобы проверить, что написанное расширение ' +
      'встраивается: якорь найден, панель отрисована, BFF-вызов проходит с куками браузера.',
      {
        js: { type: 'string', description: 'Тело async-функции; return-значение вернётся как результат' },
        css: { type: 'string', description: 'CSS, который нужно внедрить' },
        waitForSelector: { type: 'string', description: 'Дождаться появления селектора до инъекции' },
        timeoutMs: { type: 'number', description: 'Таймаут ожидания селектора, мс (по умолчанию 15000)' }
      },
      async (args) => {
        const instance = await ensureBridge()
        requireTarget(instance)
        if (args.waitForSelector) {
          await instance.enqueue(
            'act',
            { steps: [{ op: 'wait', selector: String(args.waitForSelector), timeoutMs: Number(args.timeoutMs ?? 15000) }] },
            { timeout: 60000 }
          )
        }
        const result = await instance.enqueue(
          'inject',
          { js: args.js ?? '', css: args.css ?? '' },
          { timeout: 60000 }
        )
        return ok(
          `Скрипт выполнен. Результат: ${truncate(JSON.stringify(result?.value ?? null), 4000)}`,
          { value: result?.value ?? null }
        )
      }
    )
  )

  if (settings.autoStart) {
    void ensureBridge().catch((error) => {
      ctx.logger?.warn?.(`[dsh-site-bridge] bridge did not start: ${String(error?.message ?? error)}`)
    })
  }

  ctx.effect(() => () => {
    const instance = bridge
    bridge = null
    if (!instance) return undefined
    return instance.close()
  })
}
