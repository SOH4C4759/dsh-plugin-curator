// Offline integration of the Host half against a fake Host.
//
// The real DSH Host is not available to a test process, so this harness supplies
// the four seams `apply()` actually uses — `webServer.register`, `ctx.get(...)`
// for `pluginManager` / `clientModules` / `configEditor`, `ctx.effect`, and a
// logger — plus a temporary profile directory that `detectProfile` can recognise
// through the `node_modules/<this package>` junction.
//
// What it proves, and what a syntax check cannot:
//   - `apply()` registers one route per suffix and survives a missing service;
//   - `/report` classifies builtin vs third-party, turns a failed entry into a
//     cleanup verdict, and resolves link-installed packages from the profile;
//   - `/measure` really spawns the probe and writes per-plugin cold-load times;
//   - `/toggle`, `/quarantine` and `/restore` call the manager and persist state;
//   - `/restore` re-inserts a removed row into the patch, with a backup.
//
//   node tools/verify-routes.mjs
//
// Exit 0 = every assertion held. Nothing here touches the real profile.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'curator-routes-'))
process.on('exit', () => {
  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/* ------------------------------------------------------------- fixtures -- */

const profileDir = join(temp, 'profiles', 'desktop')
mkdirSync(profileDir, { recursive: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

// One real link-installed package: a tiny entry that takes measurable work to
// import, so the bench has something to time.
const fixtureDir = join(temp, 'fixture-plugin')
mkdirSync(join(fixtureDir, 'lib'), { recursive: true })
writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
  name: 'fixture-plugin',
  version: '1.2.3',
  description: 'fixture',
  type: 'module',
  exports: { '.': './lib/index.js' },
  meta: { title: '夹具插件', description: 'fixture package' },
  dsh: { client: { platform: 'web' } },
}, null, 2))
writeFileSync(join(fixtureDir, 'lib', 'index.js'), [
  'export const name = "fixture-plugin"',
  'export function apply() {}',
  'export const meta = { title: "夹具插件" }',
  '',
].join('\n'))
writeFileSync(join(fixtureDir, 'lib', 'client.js'), 'window.__x = 1\n')

const BROKEN_DIR = join(temp, 'broken-plugin')
mkdirSync(BROKEN_DIR, { recursive: true })
writeFileSync(join(BROKEN_DIR, 'package.json'), JSON.stringify({ name: 'broken-plugin', version: '0.0.1' }, null, 2))

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-test',
  private: true,
  dependencies: {
    'dsh-plugin-curator': `link:${root}`,
    'fixture-plugin': `link:${fixtureDir}`,
  },
  dsh: { profile: { bundles: ['fixture-plugin'], patchReload: 'live' } },
}, null, 2))
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '# fixture patch',
  '- insert:',
  '    - id: plugin-curator',
  "      name: 'dsh-plugin-curator'",
  '- insert:',
  '    - id: fixture-plugin',
  "      name: 'fixture-plugin'",
  '',
].join('\n'))

// The junction `detectProfile` verifies: node_modules/<package> → this checkout.
symlinkSync(root, join(profileDir, 'node_modules', 'dsh-plugin-curator'), 'junction')

/* ---------------------------------------------------------- fake services -- */

const managerCalls = []
const plugins = [
  { entryId: 'include:fixture-plugin', moduleName: 'fixture-plugin', patchId: 'fixture-plugin', enabled: true, fiberPhase: 'active' },
  { entryId: 'include:broken-plugin', moduleName: 'broken-plugin', patchId: 'broken-plugin', enabled: true, fiberPhase: 'failed' },
  { entryId: 'include:off-plugin', moduleName: 'off-plugin', patchId: 'off-plugin', enabled: false, fiberPhase: null },
  { entryId: 'include:llm', moduleName: '@deepseek-ai/dsh-llm', patchId: 'llm', enabled: true, fiberPhase: 'active' },
]

const pluginManager = {
  async listPlugins() {
    return plugins.map((plugin) => ({ ...plugin }))
  },
  async listBundles() {
    return [
      { name: 'fixture-plugin', version: '1.2.3', enabled: true, official: false, rows: [{ rowId: 'fixture-plugin', moduleName: 'fixture-plugin' }] },
      { name: 'broken-plugin', enabled: true, official: false, rows: [{ rowId: 'broken-plugin', moduleName: 'broken-plugin' }], error: { code: 'incompatible-version' } },
    ]
  },
  async setPluginEnabled(entryId, enabled) {
    managerCalls.push({ entryId, enabled })
    const target = plugins.find((plugin) => plugin.entryId === entryId)
    if (target === undefined) return { changed: false, application: 'failed', stage: 'enable', target: entryId, error: { code: 'unknown-plugin' } }
    target.enabled = enabled
    target.fiberPhase = enabled ? 'active' : null
    return { changed: true, application: 'applied', stage: 'enable', target: entryId, enabled }
  },
}

const clientModules = {
  clientPath(id) {
    if (id === 'fixture-plugin') return join(fixtureDir, 'lib', 'client.js')
    return undefined
  },
}

const configEditor = {
  configuration() {
    return []
  },
}

const routes = new Map()
const effects = []
let registered = 0
const ctx = {
  baseUrl: profileDir,
  logger: { info() {}, warn() {} },
  get(key) {
    if (key === 'pluginManager') return pluginManager
    if (key === 'clientModules') return clientModules
    if (key === 'configEditor') return configEditor
    return null
  },
  effect(fn) {
    const dispose = fn()
    registered += 1
    effects.push(dispose)
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => {
        routes.delete(route.path)
      }
    },
  },
}

/* --------------------------------------------------------------- harness -- */

function fakeReq(method, body) {
  const stream = new Readable({ read() {} })
  stream.method = method
  process.nextTick(() => {
    stream.push(JSON.stringify(body ?? {}))
    stream.push(null)
  })
  return stream
}

function fakeRes() {
  const parts = { status: 0, body: null }
  return {
    parts,
    writeHead(status) {
      parts.status = status
    },
    end(buffer) {
      try {
        parts.body = JSON.parse(String(buffer))
      } catch {
        parts.body = String(buffer)
      }
    },
  }
}

async function call(suffix, body, method = 'POST') {
  const handler = routes.get(`/api/plugin-curator/${suffix}`)
  assert.ok(handler !== undefined, `route /${suffix} was not registered`)
  const res = fakeRes()
  await handler(fakeReq(method, body), res)
  return res.parts
}

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} — ${label}`)
}

const host = await import('../entry.js')
host.apply(ctx)

/* ---------------------------------------------------------------- checks -- */

check('apply registers one exact route per suffix', () => {
  assert.ok(registered >= 6, `expected at least 6 registrations, got ${registered}`)
  for (const suffix of ['report', 'toggle', 'quarantine', 'restore', 'measure', 'activity', 'client-timing']) {
    assert.ok(routes.has(`/api/plugin-curator/${suffix}`), `missing ${suffix}`)
  }
})

{
  const result = await call('report', {})
  check('report answers with ok and a value', () => {
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(typeof result.body.value, 'object')
  })
  const value = result.body.value
  check('the profile was identified through the node_modules junction', () => {
    assert.equal(value.profile.detection, 'node-modules')
    assert.equal(value.profile.dir, profileDir)
  })
  check('builtin rows are separated from third-party rows', () => {
    const builtin = value.plugins.filter((plugin) => plugin.origin === 'builtin')
    const third = value.plugins.filter((plugin) => plugin.origin === 'third-party')
    assert.equal(builtin.length, 1)
    assert.equal(builtin[0].moduleName, '@deepseek-ai/dsh-llm')
    assert.equal(third.length, 3)
  })
  check('the link-installed package was resolved from the profile manifest', () => {
    const fixture = value.plugins.find((plugin) => plugin.moduleName === 'fixture-plugin')
    assert.equal(fixture.packageDir, fixtureDir)
    assert.equal(fixture.version, '1.2.3')
    assert.equal(fixture.title, '夹具插件')
    assert.equal(fixture.client.bytes, Buffer.byteLength('window.__x = 1\n'))
  })
  check('a failed entry becomes a cleanup verdict and stays out of advice for builtins', () => {
    const broken = value.plugins.find((plugin) => plugin.moduleName === 'broken-plugin')
    assert.equal(broken.verdict, 'cleanup')
    assert.equal(broken.reasons[0].code, 'load-failed')
    assert.ok(value.cleanup.broken.some((plugin) => plugin.moduleName === 'broken-plugin'))
    assert.ok(!value.suggestions.some((item) => item.moduleName === '@deepseek-ai/dsh-llm'))
  })
  check('an unscanned profile reports null activity, not zero calls', () => {
    assert.equal(value.activity, null)
    const fixture = value.plugins.find((plugin) => plugin.moduleName === 'fixture-plugin')
    assert.equal(fixture.activity, null)
    assert.equal(fixture.verdict, 'review')
  })
  check('the boot record array is present', () => {
    assert.ok(Array.isArray(value.boot.history))
  })
  // `watchSettle` runs concurrently with the first report, so give it a moment
  // rather than depending on which promise wins the race.
  let settled = value.boot.current
  const settleDeadline = Date.now() + 8000
  while (Date.now() < settleDeadline && settled.settled !== true) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    settled = (await call('report', {})).body.value.boot.current
  }
  check('the settle watcher measured this process and saw terminal phases', () => {
    assert.equal(settled.settled, true)
    assert.equal(settled.complete, 'terminal')
    assert.ok(settled.entryCount >= 4, 'settle watcher should have counted entries')
    assert.deepEqual(settled.stalled, [])
  })
}

{
  const started = await call('measure', { force: true })
  check('measure starts a bench job', () => {
    assert.equal(started.body.ok, true)
    assert.equal(typeof started.body.value.started, 'object')
  })
  // Wait for the job (three runs per package, one package with an entry).
  let report = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const result = await call('report', {})
    report = result.body.value
    if (report.jobs.bench.state !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  check('the bench finished and produced a cold-load time for the fixture', () => {
    assert.equal(report.jobs.bench.state, 'done', `bench state ${JSON.stringify(report.jobs.bench)}`)
    const fixture = report.plugins.find((plugin) => plugin.moduleName === 'fixture-plugin')
    assert.ok(Number.isFinite(fixture.bootMs), 'fixture bootMs missing')
    assert.ok(Array.isArray(fixture.bootSamples))
    assert.ok(fixture.bootSamples.length >= 1)
  })
}

{
  const toggled = await call('toggle', { entryId: 'include:fixture-plugin', enabled: false })
  check('toggle calls the manager and records the disabled timestamp', () => {
    assert.equal(toggled.body.ok, true)
    assert.ok(managerCalls.some((entry) => entry.entryId === 'include:fixture-plugin' && entry.enabled === false))
    const flags = JSON.parse(readFileSync(join(profileDir, '.plugin-curator', 'flags.json'), 'utf8'))
    assert.ok(Number.isFinite(flags.disabledSince['include:fixture-plugin']))
  })
}

{
  await call('toggle', { entryId: 'include:fixture-plugin', enabled: true })
  const quarantined = await call('quarantine', {
    entryId: 'include:broken-plugin',
    reasons: ['load-failed'],
  })
  check('quarantine disables the row and writes a recoverable record', () => {
    assert.equal(quarantined.body.ok, true)
    assert.ok(managerCalls.some((entry) => entry.entryId === 'include:broken-plugin' && entry.enabled === false))
    const state = JSON.parse(readFileSync(join(profileDir, '.plugin-curator', 'quarantine.json'), 'utf8'))
    const item = state.items.find((entry) => entry.entryId === 'include:broken-plugin')
    assert.ok(item !== undefined)
    assert.equal(item.patchId, 'broken-plugin')
    assert.equal(item.priorEnabled, true)
  })
  const report = (await call('report', {})).body.value
  check('the quarantined entry shows up in the bin', () => {
    assert.ok(report.cleanup.trash.some((item) => item.entryId === 'include:broken-plugin'))
  })
}

{
  const restored = await call('restore', { entryId: 'include:broken-plugin' })
  check('restore re-enables the row and empties the bin', async () => {
    assert.equal(restored.body.ok, true)
    assert.equal(restored.body.value.present, true)
    const state = JSON.parse(readFileSync(join(profileDir, '.plugin-curator', 'quarantine.json'), 'utf8'))
    assert.equal(state.items.filter((item) => item.entryId === 'include:broken-plugin').length, 0)
    assert.equal(state.history.length, 1)
  })
}

{
  // A row recorded in the bin but absent from the Loader: restore must write an
  // insert block back into the patch, after backing the patch up.
  const statePath = join(profileDir, '.plugin-curator', 'quarantine.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.items.push({
    entryId: 'include:gone-plugin',
    moduleName: 'gone-plugin',
    patchId: 'gone-plugin',
    title: '已消失的插件',
    reasons: ['disabled-long'],
    priorEnabled: false,
    at: Date.now() - 40 * 86400000,
  })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const result = await call('restore', { entryId: 'include:gone-plugin' })
  check('restore re-inserts a removed row into the patch, with a backup', () => {
    assert.equal(result.body.ok, true)
    const after = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.notEqual(after, before)
    assert.match(after, /id: gone-plugin/)
    const backup = result.body.value.reinserted?.backup
    assert.equal(typeof backup, 'string')
    assert.ok(existsSync(backup), 'backup file missing')
    assert.equal(readFileSync(backup, 'utf8'), before)
  })
}

{
  const wrongMethod = await call('report', {}, 'GET')
  check('a GET is refused with 405 instead of running the report', () => {
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.body.ok, false)
  })
  const missing = await call('toggle', {})
  check('a missing entryId is a 400, not a crash', () => {
    assert.equal(missing.status, 400)
  })
  const unknown = await call('quarantine', { entryId: 'include:nope' })
  check('an unknown entry is a 404, not a crash', () => {
    assert.equal(unknown.status, 404)
  })
}

console.log(`\n${checks} checks passed`)
