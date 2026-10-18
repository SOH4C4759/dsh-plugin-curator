// Offline render of the browser half in a stub React.
//
// The real thing runs inside the DSH Web shell, which is not available here. What
// this harness proves instead, and what a syntax check cannot:
//
//   - `window.__ModuleLoader__.load` is called with the package's own module id;
//   - the returned plugin object injects `slots` and registers the `main` key and
//     the sidebar entry with the SAME id, so the icon and the panel are linked;
//   - the page component renders for EVERY tab against a report fixture that
//     carries each verdict, an empty profile and a populated one;
//   - no view reads a field the Host never sends (the fixture is shaped by
//     entry.js's `buildReport`, and unknown reads show up as crashes).
//
//   node tools/verify-client.mjs
//
// Exit 0 = every assertion held.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/* ------------------------------------------------------------ stub React -- */

/**
 * A React good enough to run one render pass.
 *
 * `useState` consumes a supplied queue so a test can put the page into any tab
 * with a loaded report; everything else only has to return something sensible.
 */
function createReact(values) {
  let cursor = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(4) }
    },
    useState(initial) {
      const supplied = cursor < values.length ? values[cursor] : initial
      cursor += 1
      return [supplied, () => {}]
    },
    useEffect() {
      return undefined
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
  }
  return React
}

/* ------------------------------------------------------------- fixtures -- */

function plugin(overrides) {
  return {
    entryId: 'entry',
    moduleName: 'pkg',
    patchId: 'patch',
    readOnlyReason: null,
    enabled: true,
    fiberPhase: 'active',
    packageName: 'pkg',
    version: '1.0.0',
    title: '插件',
    description: null,
    kind: 'link',
    source: 'link:F:/CodeProj/pkg',
    packageDir: 'F:/CodeProj/pkg',
    hasUi: false,
    client: null,
    ui: null,
    bootMs: 12,
    bootSamples: [12, 14, 13],
    activity: { calls: 0, sessions: 0, lastAt: null, tools: {}, mcpMatched: false },
    bundle: null,
    error: null,
    incompatible: false,
    verdict: 'keep',
    reasons: [{ code: 'in-use', text: '窗口内 3 次调用' }],
    ...overrides,
  }
}

const report = {
  generatedAt: Date.now(),
  dsh: { version: '0.2.1', node: '24.21.0', electron: '38.0.0', platform: 'win32', pid: 1234 },
  profile: { dir: 'C:/Users/x/.dsh/profiles/desktop', detection: 'manifest', patchPath: 'p', stateDir: 's' },
  boot: {
    current: { startedAt: Date.now() - 8000, applyMs: 520, settledMs: 8100, settled: true, entryCount: 4, enabledCount: 3, phases: { active: 3, failed: 1 }, fingerprint: 'abc123' },
    history: [
      { at: Date.now(), settledMs: 8100, enabledCount: 3, fingerprint: 'abc123', changed: { deltaMs: -420, entryCount: -1 } },
      { at: Date.now() - 60000, settledMs: 8520, enabledCount: 4, fingerprint: 'def456', changed: null },
    ],
    basis: { applyMs: 'a', settledMs: 'b', bootMs: 'c', uiDurationMs: 'd' },
  },
  jobs: { bench: { state: 'done', done: 3, total: 3, current: '', message: '已测量 3 个插件', finishedAt: null }, activity: { state: 'idle', done: 0, total: 0, message: '', finishedAt: null } },
  plugins: [
    plugin({ entryId: 'a', moduleName: 'dsh-used', title: '在用的插件', bootMs: 120, activity: { calls: 42, sessions: 3, lastAt: Date.now(), tools: {}, mcpMatched: false }, reasons: [{ code: 'in-use', text: '窗口内 42 次调用' }] }),
    plugin({ entryId: 'b', moduleName: 'dsh-quiet', title: '安静的宿主插件', kind: 'registry', verdict: 'disable', bootMs: 88, reasons: [{ code: 'quiet-host-only', text: '窗口内 0 次调用' }, { code: 'slow', text: '模块冷加载 88 ms' }] }),
    plugin({ entryId: 'c', moduleName: 'dsh-ui', title: '带界面的插件', hasUi: true, client: { path: 'x', bytes: 480000 }, verdict: 'review', reasons: [{ code: 'ui-unobserved', text: '窗口内 0 次调用' }] }),
    plugin({ entryId: 'd', moduleName: 'dsh-broken', title: '坏掉的插件', patchId: null, readOnlyReason: 'unaddressable', fiberPhase: 'failed', verdict: 'cleanup', error: { code: 'operation-error' }, reasons: [{ code: 'load-failed', text: '加载失败' }] }),
    plugin({ entryId: 'e', moduleName: 'dsh-off', title: '已停用的插件', enabled: false, verdict: 'idle', bootMs: null, activity: null, reasons: [{ code: 'disabled', text: '已在组合中停用' }] }),
  ],
  totals: { plugins: 5, enabled: 3, disabled: 2, failed: 1, clientBytes: 480000, measuredBootMs: 220 },
  activity: { scannedAt: Date.now(), windowDays: 14, sessionCount: 281, coverage: { files: 300, filesRead: 281, bytesRead: 1, frames: 2, failedFrames: 0, stoppedEarly: false, elapsedMs: 12000, zstd: true }, toolCount: 37, ambiguous: {}, observedNames: 37 },
  attribution: { ambiguous: { shared: ['a', 'b'] }, owned: {} },
  suggestions: [
    { entryId: 'd', moduleName: 'dsh-broken', title: '坏掉的插件', verdict: 'cleanup', reasons: [{ code: 'load-failed', text: '加载失败' }], savedMs: null, clientBytes: null },
    { entryId: 'b', moduleName: 'dsh-quiet', title: '安静的宿主插件', verdict: 'disable', reasons: [{ code: 'quiet-host-only', text: '窗口内 0 次调用' }], savedMs: 88, clientBytes: null },
    { entryId: 'c', moduleName: 'dsh-ui', title: '带界面的插件', verdict: 'review', reasons: [{ code: 'ui-unobserved', text: '窗口内 0 次调用' }], savedMs: 12, clientBytes: 480000 },
  ],
  cleanup: {
    broken: [plugin({ entryId: 'd', moduleName: 'dsh-broken', title: '坏掉的插件', verdict: 'cleanup', error: { code: 'operation-error' }, fiberPhase: 'failed' })],
    disabled: [plugin({ entryId: 'e', moduleName: 'dsh-off', title: '已停用的插件', enabled: false, verdict: 'idle', activity: null })],
    trash: [{ entryId: 'f', moduleName: 'dsh-trashed', title: '回收站里的插件', at: Date.now() - 3600000, live: null }],
    history: [{ entryId: 'g', moduleName: 'dsh-restored', restoredAt: Date.now() - 600000 }],
  },
  quarantine: { items: [], history: [] },
  ui: { at: Date.now(), entries: { 'dsh-ui': { durationMs: 42, transferSize: 12000 } } },
  error: null,
  lastError: null,
}

/* --------------------------------------------------------------- harness -- */

/** Evaluate the bundle and capture what it registers. */
function boot(initialValues, fixture) {
  const registrations = []
  let captured = null
  const window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  const document = {
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, append() {}, set textContent(value) { this._text = value } }),
    head: { append() {} },
  }
  const globalThisStub = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: fixture }) }),
    performance: { getEntriesByType: () => [], now: () => 10 },
    __DSH_BOOT__: { entries: [] },
    open: () => {},
  }
  const sandbox = {
    window,
    document,
    globalThis: globalThisStub,
    fetch: globalThisStub.fetch,
    performance: globalThisStub.performance,
    setTimeout: globalThisStub.setTimeout,
    clearTimeout: globalThisStub.clearTimeout,
    setInterval: globalThisStub.setInterval,
    clearInterval: globalThisStub.clearInterval,
    AbortController,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Date,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

  const pluginObject = captured.factory((id) => {
    if (id === 'react') return createReact(initialValues)
    throw new Error(`unexpected require(${id})`)
  })
  pluginObject.inject = pluginObject.inject ?? []
  return { pluginObject, captured, registrations, sandbox }
}

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} — ${label}`)
}

/** Walk a rendered node tree, collecting text, to prove a view actually drew. */
function textOf(node, depth = 0) {
  if (node === null || node === undefined || depth > 30) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'function') return textOf(node({}), depth + 1)
  if (Array.isArray(node)) return node.map((item) => textOf(item, depth + 1)).join(' ')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}), depth + 1)
    const own = node.props?.text !== undefined ? String(node.props.text) : ''
    return `${own} ${node.children.map((child) => textOf(child, depth + 1)).join(' ')}`
  }
  return ''
}

/** Render the page with a chosen tab already selected. */
function renderTab(tab) {
  // useState calls, in order: report, error, tab, busy, notice, filter, confirming.
  const values = [report, null, tab, '', null, '', '']
  const { pluginObject } = boot(values, report)
  const registered = []
  const ctx = {
    slots: {
      inject(_name, fn) {
        fn()
      },
      register(meta, component) {
        registered.push({ meta, component })
        return () => {}
      },
    },
  }
  pluginObject.apply(ctx)
  return { registered }
}

check('the bundle registers under the package module id', () => {
  const { captured } = boot([], report)
  assert.equal(captured.id, 'dsh-plugin-curator')
  assert.equal(typeof captured.factory, 'function')
})

check('slots is injected and both registrations are made', () => {
  const { pluginObject } = boot([], report)
  assert.ok(Array.isArray(pluginObject.inject))
  assert.ok(pluginObject.inject.includes('slots'))
  const { registered } = renderTab('overview')
  assert.equal(registered.length, 2)
})

check('the main panel key equals the sidebar entry id', () => {
  const { registered } = renderTab('overview')
  const main = registered.find((item) => item.meta.name === 'main')
  const side = registered.find((item) => item.meta.name === 'sidebar.panellist')
  assert.ok(main !== undefined && side !== undefined)
  assert.equal(main.meta.key, side.meta.id)
  assert.equal(side.meta.id, 'plugin-curator')
  assert.equal(typeof side.component, 'function')
})

for (const tab of ['overview', 'plugins', 'advice', 'startup', 'cleanup']) {
  check(`the ${tab} tab renders against a populated report`, () => {
    const { registered } = renderTab(tab)
    const page = registered.find((item) => item.meta.name === 'main').component
    const tree = page({})
    const text = textOf(tree)
    assert.ok(text.length > 30, 'the panel rendered almost nothing')
    if (tab === 'overview') {
      assert.match(text, /本机启动总时长/)
      assert.match(text, /插件模块冷加载合计/)
    }
    if (tab === 'plugins') assert.match(text, /冷加载/)
    if (tab === 'advice') assert.match(text, /可停用|可清理|待确认/)
    if (tab === 'startup') assert.match(text, /三个不同的数字/)
    if (tab === 'cleanup') assert.match(text, /回收站/)
  })
}

check('a pending report renders the loading shell instead of crashing', () => {
  const values = [null, null, 'overview', '', null, '', '']
  const { pluginObject } = boot(values, report)
  const registered = []
  pluginObject.apply({
    slots: { inject: (_n, fn) => fn(), register: (meta, component) => { registered.push({ meta, component }); return () => {} } },
  })
  const page = registered.find((item) => item.meta.name === 'main').component
  const text = textOf(page({}))
  assert.match(text, /插件管家/)
  assert.match(text, /正在读取插件清单/)
})

check('the sidebar glyph draws an svg at the requested size', () => {
  const { registered } = renderTab('overview')
  const icon = registered.find((item) => item.meta.name === 'sidebar.panellist').component
  const tree = icon({ size: 18, active: true })
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 18)
  assert.equal(tree.props.viewBox, '0 0 16 16')
})

console.log(`\n${checks} checks passed`)
