// dsh-plugin-curator — Host half.
//
// 插件管家 answers four questions about this profile's plugins, and every
// number it answers with names its own measurement basis:
//
//   1. WHAT IS INSTALLED — the live Loader entries behind
//      `ctx.pluginManager.listPlugins()` / `listBundles()`, resolved to their
//      real package directory, version and client bundle. Nothing here is
//      re-derived from the YAML by hand.
//   2. HOW MUCH STARTUP EACH ONE COSTS — three separate numbers, never mixed
//      into one made-up figure:
//        settledMs   the whole process: process start → every enabled entry in a
//                    terminal Loader phase (active | failed).
//        bootMs      per plugin: cold module evaluation in an isolated child
//                    process (bench-probe.mjs), min of 3 runs.
//        uiDurationMs per plugin: the browser's own Resource Timing entry for
//                    that plugin's client bundle, posted back by the panel.
//      The A/B truth is the boot history: every boot is recorded with a
//      composition fingerprint, so turning something off and restarting shows a
//      measured delta instead of a guess.
//   3. HOW ACTIVE IT IS — `tool/call` events in this profile's session logs over
//      a rolling window, attributed to the package whose host code declares the
//      tool name, or to the MCP row whose `serverName` prefixes it. UI-only
//      plugins have no tool calls at all; they are reported as 未观测, never as
//      "unused".
//   4. WHAT CAN BE CLEANED — entries the Loader reports as failed or version-
//      incompatible, plus entries already disabled. Cleaning is a quarantine
//      record plus `setPluginEnabled(id, false)`, so 找回 is a real reverse
//      operation, not a reinstall.
//
// Management is delegated to the services DSH already ships (`pluginManager`,
// `configEditor`, `clientModules`); this package keeps no second copy of the
// composition and never parses the patch layer itself — except when re-inserting
// a row that was removed, where it appends an `insert` block to the profile
// patch, backs the file up first, and says so in the result.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  promises as fsp,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

/** Route prefix the panel talks to. */
const ROUTE = '/api/plugin-curator'
/** State directory name, created inside the profile. */
const STATE_DIRNAME = '.plugin-curator'
/** How many boots to keep for the A/B history. */
const BOOT_HISTORY_LIMIT = 40
/** Default activity window. */
const ACTIVITY_WINDOW_DAYS = 14
/** Activity scan ceiling: files, decompressed bytes, wall clock. */
const ACTIVITY_MAX_FILES = 400
const ACTIVITY_MAX_BYTES = 512 * 1024 * 1024
const ACTIVITY_BUDGET_MS = 25_000
/** Cold-load bench: runs per plugin and the ceiling for one run. */
const BENCH_RUNS = 3
const BENCH_TIMEOUT_MS = 20_000
/** A plugin entry that never settles inside this window is recorded as unsettled. */
const SETTLE_TIMEOUT_MS = 120_000
/** A process older than this was not started by a boot this plugin witnessed. */
const HOT_INSTALL_SECONDS = 180

/** This package's own directory; also how the profile is identified. */
const SELF_DIR = safeRealpath(dirname(fileURLToPath(import.meta.url)))
/** The isolated cold-load probe shipped beside this file. */
const PROBE_FILE = join(SELF_DIR, 'bench-probe.mjs')
/** A one-line module the probe imports to prove a launcher can run at all. */
const SELFCHECK_FILE = join(SELF_DIR, 'probe-selfcheck.mjs')

export const name = 'dsh-plugin-curator'

/** Services this half consumes. Everything else is optional and guarded. */
export const inject = ['webServer']

/* ------------------------------------------------------------------ utils -- */

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function sleep(ms) {
  // Deliberately NOT `unref()`ed: a sleep that cannot outlive an idle event loop
  // resolves never, and one caller (`watchSettle`) is the only pending work in a
  // freshly started Host.
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex')
}

function statSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function readJsonSafe(path, fallback) {
  try {
    const body = readFileSync(path, 'utf8')
    if (body.trim() === '') return fallback
    return JSON.parse(body)
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(path, value) {
  const body = JSON.stringify(value, null, 2)
  const temp = `${path}.tmp-${String(process.pid)}`
  await fsp.writeFile(temp, body, 'utf8')
  await fsp.rename(temp, path)
}

function listDirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Answer one JSON response. `no-store` keeps the panel's polling honest. */
function sendJson(res, status, value) {
  let body
  try {
    body = Buffer.from(JSON.stringify(value), 'utf8')
  } catch {
    body = Buffer.from(JSON.stringify({ ok: false, error: 'unserializable result' }), 'utf8')
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read one bounded JSON request body; never throws, never hangs. */
function readJsonBody(req, { limit = 512 * 1024, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let size = 0
    const chunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'request body timeout' })
    }, timeoutMs)
    timer?.unref?.()
    req?.on?.('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, error: 'request body too large' })
        return
      }
      chunks.push(chunk)
    })
    req?.on?.('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish({ ok: true, value: parsed !== null && typeof parsed === 'object' ? parsed : {} })
      } catch {
        finish({ ok: false, error: 'invalid JSON body' })
      }
    })
    req?.on?.('error', () => {
      finish({ ok: false, error: 'request stream error' })
    })
  })
}

/**
 * Environment for the probe child.
 *
 * Windows environment variable names are case-insensitive, and a copied
 * `process.env` can carry both `NO_PROXY` and `no_proxy`; handing that to
 * CreateProcess is what makes some launchers throw. One spelling per name also
 * keeps the measurement independent of the parent's environment.
 */
function probeEnv(extra = {}) {
  const out = {}
  const seen = new Set()
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    const folded = key.toUpperCase()
    if (seen.has(folded)) continue
    seen.add(folded)
    out[key] = value
  }
  return { ...out, ...extra }
}

/**
 * Candidate `node` executables for the probe, best first.
 *
 * The bundled runtime comes first: it is the Node DSH already ships and runs the
 * Host under, and it needs no `ELECTRON_RUN_AS_NODE` trick that would start a
 * second application instance if the flag were ever ignored.
 */
function nodeCandidates() {
  const out = []
  const push = (path) => {
    if (typeof path !== 'string' || path === '') return
    if (!out.includes(path)) out.push(path)
  }
  push(process.env.DSH_PLUGIN_CURATOR_NODE)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  for (const entry of listDirSafe(join(home, 'dsh-runtimes'))) {
    if (!entry.isDirectory()) continue
    push(join(home, 'dsh-runtimes', entry.name, 'dependencies', 'node', 'bin', 'node.exe'))
    push(join(home, 'dsh-runtimes', entry.name, 'dependencies', 'node', 'bin', 'node'))
  }
  if (/^node(\.exe)?$/i.test(process.execPath ?? '')) push(process.execPath)
  push(process.platform === 'win32' ? 'node.exe' : 'node')
  return out.filter((path) => path === 'node' || path === 'node.exe' || existsSync(path))
}

/* -------------------------------------------------- profile identification -- */

/**
 * Find the profile directory this process was started from.
 *
 * Three signals, strongest first, because guessing here would scatter state into
 * the wrong profile:
 *   1. `<dir>/node_modules/<this package>` resolves to this very directory —
 *      self-verifying, works for `link:` installs and for copies;
 *   2. `<dir>/package.json` depends on this package by name;
 *   3. the Loader's own `ctx.baseUrl`, which DSH sets to the profile directory.
 *
 * @param ctx - Host plugin context.
 * @param env - environment to read (injectable for tests).
 * @returns `{ dir, basis }`, or `{ dir: null }` when nothing matched.
 */
export function detectProfile(ctx, env = process.env) {
  const home = env?.DSH_HOME || join(homedir(), '.dsh')
  const candidates = []
  const push = (dir) => {
    if (typeof dir === 'string' && dir.trim() !== '') candidates.push(resolvePath(dir.trim()))
  }
  push(ctx?.baseUrl)
  for (const entry of listDirSafe(join(home, 'profiles'))) {
    if (entry.isDirectory()) push(join(home, 'profiles', entry.name))
  }
  const self = SELF_DIR
  for (const dir of candidates) {
    const linked = join(dir, 'node_modules', 'dsh-plugin-curator')
    if (existsSync(linked) && safeRealpath(linked) === self) return { dir, basis: 'node-modules' }
  }
  for (const dir of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const deps = { ...manifest?.dependencies, ...manifest?.devDependencies }
      if (deps && typeof deps['dsh-plugin-curator'] === 'string') return { dir, basis: 'manifest' }
    } catch {
      /* not a profile directory */
    }
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'cordis.patch.yml'))) return { dir, basis: 'patch' }
  }
  return { dir: null, basis: 'none' }
}

/* ------------------------------------------------- session log → activity -- */

/** zstd frame magic; v4 session logs are an append-only run of these frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode an append-only zstd session log.
 *
 * DSH appends one zstd frame per flush, so a session file is hundreds of
 * concatenated frames. `zlib` decodes only the FIRST frame, which is why a plain
 * `zstdDecompressSync` returns a few hundred bytes for a multi-megabyte log. This
 * walks the frames, and when a candidate boundary does not decode it extends to
 * the next magic (a 4-byte sequence can occur inside compressed data).
 *
 * @param buffer - raw file bytes.
 * @param budget - stop after this many decompressed bytes.
 * @returns `{ text, frames, failed, bytes }`; `text` is UTF-8 JSONL.
 */
export function decodeSessionFrames(buffer, budget = 64 * 1024 * 1024) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (
      buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]
    ) starts.push(i)
  }
  const parts = []
  let bytes = 0
  let failed = 0
  for (let k = 0; k < starts.length; k += 1) {
    if (bytes >= budget) break
    let next = k + 1
    let decoded = null
    while (next <= starts.length) {
      const end = next < starts.length ? starts[next] : buffer.length
      try {
        decoded = zlib.zstdDecompressSync(buffer.subarray(starts[k], end))
        break
      } catch {
        next += 1
      }
    }
    if (decoded === null) {
      failed += 1
      continue
    }
    bytes += decoded.length
    parts.push(decoded.toString('utf8'))
  }
  return { text: parts.join(''), frames: starts.length, failed, bytes }
}

/** Whether this runtime can decode zstd at all. */
export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function'
}

/**
 * Collect session log files newer than a cutoff.
 * @returns newest-first `[{ path, sessionId, mtimeMs, size }]`.
 */
export function findSessionFiles(home, cutoffMs, maxFiles = ACTIVITY_MAX_FILES) {
  const root = join(home, 'sessions')
  const found = []
  for (const workspace of listDirSafe(root)) {
    if (!workspace.isDirectory()) continue
    for (const session of listDirSafe(join(root, workspace.name))) {
      if (!session.isDirectory()) continue
      const dir = join(root, workspace.name, session.name)
      for (const file of listDirSafe(dir)) {
        if (!file.isFile()) continue
        if (!/^session(\.v\d+)?\.jsonl\.zstd$/.test(file.name)) continue
        const path = join(dir, file.name)
        const info = statSafe(path)
        if (info === null || info.mtimeMs < cutoffMs) continue
        found.push({ path, sessionId: session.name, mtimeMs: info.mtimeMs, size: info.size })
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.slice(0, maxFiles)
}

/**
 * Scan session logs for `tool/call` events.
 *
 * Every counter here is observed data or is absent — nothing is extrapolated. A
 * plugin with no matching tool name simply has `calls: 0`, and its usage verdict
 * says 未观测, which is a different statement from "unused".
 *
 * @param options - `home`, `windowDays`, `maxFiles`, `budgetMs`, `now`.
 * @returns counts per tool name plus scan coverage.
 */
export async function scanToolCalls(options = {}) {
  const home = options.home ?? join(homedir(), '.dsh')
  const windowDays = Number.isFinite(options.windowDays) ? Number(options.windowDays) : ACTIVITY_WINDOW_DAYS
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000
  const files = findSessionFiles(home, cutoff, options.maxFiles ?? ACTIVITY_MAX_FILES)
  const budgetMs = options.budgetMs ?? ACTIVITY_BUDGET_MS
  const started = Date.now()
  const toolCalls = new Map()
  const toolSessions = new Map()
  const toolLast = new Map()
  const sessions = new Set()
  let bytes = 0
  let frames = 0
  let failedFrames = 0
  let read = 0
  let stopped = false
  for (const file of files) {
    if (Date.now() - started > budgetMs) {
      stopped = true
      break
    }
    let buffer
    try {
      buffer = await fsp.readFile(file.path)
    } catch {
      continue
    }
    const decoded = decodeSessionFrames(buffer, ACTIVITY_MAX_BYTES - bytes)
    bytes += decoded.bytes
    frames += decoded.frames
    failedFrames += decoded.failed
    read += 1
    for (const line of decoded.text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!event || event.type !== 'tool/call') continue
      const tool = event.data?.name
      if (typeof tool !== 'string' || tool === '') continue
      const at = Number.isFinite(event.time) ? Number(event.time) : now
      toolCalls.set(tool, (toolCalls.get(tool) ?? 0) + 1)
      toolLast.set(tool, Math.max(toolLast.get(tool) ?? 0, at))
      let bucket = toolSessions.get(tool)
      if (bucket === undefined) {
        bucket = new Set()
        toolSessions.set(tool, bucket)
      }
      bucket.add(file.sessionId)
      sessions.add(file.sessionId)
    }
  }
  const tools = {}
  for (const [tool, calls] of toolCalls) {
    tools[tool] = {
      calls,
      sessions: toolSessions.get(tool)?.size ?? 0,
      lastAt: toolLast.get(tool) ?? null,
    }
  }
  return {
    scannedAt: now,
    windowDays,
    cutoff,
    tools,
    sessionCount: sessions.size,
    coverage: {
      files: files.length,
      filesRead: read,
      bytesRead: bytes,
      frames,
      failedFrames,
      stoppedEarly: stopped,
      bytesBudgetExhausted: bytes >= ACTIVITY_MAX_BYTES,
      elapsedMs: Date.now() - started,
      zstd: zstdAvailable(),
    },
  }
}

/* ---------------------------------------- tool name → owning package scan -- */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'tests', 'test'])
/** This package registers no tools; scanning it would only pollute attribution. */
const SELF_PACKAGE = 'dsh-plugin-curator'

/** List candidate host JS files inside one package (browser halves excluded). */
function collectPackageSources(dir, limit = 240) {
  const out = []
  const walk = (current, depth) => {
    if (out.length >= limit || depth > 4) return
    for (const entry of listDirSafe(current)) {
      if (out.length >= limit) return
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path, depth + 1)
        continue
      }
      const ext = extname(entry.name)
      if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') continue
      // Browser halves never register Host tools, and they are the biggest files:
      // `client.js`, but also the split chunks a plugin ships next to it
      // (`client-editor.js`, `client-locale.js`, …).
      if (/^client([-._].*)?\.(js|mjs|cjs)$/i.test(entry.name)) continue
      const info = statSafe(path)
      if (info === null || info.size > 1_500_000) continue
      out.push(path)
    }
  }
  walk(dir, 0)
  return out
}

/** Escape one tool name for a regular expression. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match observed tool names against the *registration shapes* a package carries.
 *
 * Bare string literals are not evidence: a plugin that merely calls `read` or
 * `send_message` mentions the name, and counting that would credit the caller
 * with owning the tool. What counts is a declaration —
 * `{ name: 'foo' }`, `name:"foo"`, `toolName = 'foo'` — which is what
 * `defineTool` / `tools.register` compile down to.
 *
 * This is still inference, and the report labels it as such: a name declared by
 * exactly one package is attributed to it; a name declared by two is reported as
 * ambiguous and attributed to neither.
 *
 * @param dirs - `[{ key, dir }]` package roots.
 * @param names - observed tool names.
 * @returns `{ owned: { [key]: string[] }, ambiguous: { [name]: string[] } }`.
 */
export function attributeToolNames(dirs, names) {
  const wanted = [...new Set(names)].filter((name) => typeof name === 'string' && name !== '')
  const owned = {}
  const hits = new Map()
  if (wanted.length === 0) return { owned, ambiguous: {} }
  const shapes = wanted.map((name) => ({
    name,
    re: new RegExp(`(?:name|toolName|tool_name|id)\\s*[:=]\\s*['"\`]${escapeRe(name)}['"\`]`),
  }))
  for (const { key, dir } of dirs) {
    if (key === SELF_PACKAGE) continue
    const declared = new Set()
    for (const file of collectPackageSources(dir)) {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const shape of shapes) {
        if (declared.has(shape.name)) continue
        if (shape.re.test(text)) declared.add(shape.name)
      }
    }
    if (declared.size === 0) continue
    owned[key] = [...declared].sort()
    for (const literal of declared) {
      const bucket = hits.get(literal)
      if (bucket === undefined) hits.set(literal, [key])
      else bucket.push(key)
    }
  }
  const ambiguous = {}
  for (const [literal, keys] of hits) {
    if (keys.length < 2) continue
    ambiguous[literal] = keys
    for (const key of keys) {
      owned[key] = (owned[key] ?? []).filter((item) => item !== literal)
      if (owned[key].length === 0) delete owned[key]
    }
  }
  return { owned, ambiguous }
}

/* ------------------------------------------------------------- suggestions -- */

/** Threshold above which a quiet plugin's cold-load cost is worth mentioning. */
const SLOW_HOST_MS = 60
/** Threshold above which a quiet plugin's UI bundle is worth mentioning. */
const HEAVY_UI_BYTES = 300 * 1024
/** How long a disabled entry is left alone before 清理 suggests removing it. */
const DISABLED_GRACE_DAYS = 14

/**
 * Turn the observed facts about one plugin into a verdict.
 *
 * Pure: every input is a plain number/boolean/string, so the rules can be
 * exercised offline and read in the report as `reasons[].code`. Order matters —
 * an entry that fails to load is a cleanup problem even if it is also quiet, and
 * "no tool calls" is never by itself proof of disuse for a plugin that ships UI.
 *
 * @param facts - see the call site in `describePlugins`.
 * @returns `{ verdict, reasons: [{ code, text }] }`.
 */
export function suggestFor(facts) {
  const reasons = []
  const push = (code, text) => reasons.push({ code, text })
  const disabledDays = Number.isFinite(facts.disabledDays) ? facts.disabledDays : null

  if (facts.broken === true) {
    push('load-failed', '该条目在 Loader 中加载失败，占着启动时间却不可用')
    return { verdict: 'cleanup', reasons }
  }
  if (facts.incompatible === true) {
    push('incompatible-version', '声明的 DSH 版本要求未满足，可能无法启动或中途崩溃')
    return { verdict: 'cleanup', reasons }
  }
  if (facts.stalled === true) {
    push('stalled-pending', `启动后一直停在 ${String(facts.stalledPhase ?? 'pending')}：它等的服务没有出现，这条在跑但没起作用`)
    return { verdict: 'cleanup', reasons }
  }
  if (facts.enabled !== true) {
    if (disabledDays !== null && disabledDays >= DISABLED_GRACE_DAYS) {
      push('disabled-long', `已停用 ${String(Math.round(disabledDays))} 天，仍留在组合里`)
      return { verdict: 'cleanup', reasons }
    }
    push('disabled', '已在组合中停用（不参与启动）')
    return { verdict: 'idle', reasons }
  }

  const calls = Number.isFinite(facts.calls) ? facts.calls : null
  const quiet = calls === 0
  const unobserved = calls === null
  const slow = Number.isFinite(facts.bootMs) && facts.bootMs >= SLOW_HOST_MS
  const hasUi = Number.isFinite(facts.clientBytes)
  const heavyUi = hasUi && facts.clientBytes >= HEAVY_UI_BYTES

  if (quiet && hasUi && slow) {
    push('slow-and-quiet', `窗口内 0 次调用，模块冷加载 ${String(Math.round(facts.bootMs))} ms`)
    push('ui-unobserved', '带了 UI 但没有可观测的调用通道，请人工确认还在用')
    return { verdict: 'disable', reasons }
  }
  if (quiet && !hasUi) {
    push('quiet-host-only', '窗口内 0 次调用，且没有 UI —— 它只在被调用时才有意义')
    if (slow) push('slow', `模块冷加载 ${String(Math.round(facts.bootMs))} ms`)
    return { verdict: 'disable', reasons }
  }
  if (quiet && hasUi) {
    if (heavyUi) {
      push('heavy-ui', `UI 资源 ${(facts.clientBytes / 1024).toFixed(0)} KB，窗口内 0 次调用`)
      return { verdict: 'review', reasons }
    }
    push('ui-unobserved', '窗口内 0 次调用；UI 插件的使用无法从会话日志观测，保留')
    return { verdict: 'keep', reasons }
  }
  if (unobserved) {
    push('unobserved', facts.activityReason ?? '活跃度尚未扫描，无法判断')
    return { verdict: 'review', reasons }
  }
  push('in-use', `窗口内 ${String(calls)} 次调用，${String(facts.sessions ?? 0)} 个会话`)
  if (slow) push('slow', `模块冷加载 ${String(Math.round(facts.bootMs))} ms`)
  return { verdict: 'keep', reasons }
}

/* -------------------------------------------------------------- bench job -- */

/** Resolve the module specifier the Loader would import for one package. */
export function entryCandidates(packageDir, manifest) {
  const out = []
  const push = (relative) => {
    if (typeof relative !== 'string' || relative === '') return
    const path = resolvePath(packageDir, relative)
    if (existsSync(path)) out.push(path)
  }
  const exported = manifest?.exports
  if (typeof exported === 'string') push(exported)
  else if (exported && typeof exported === 'object') {
    const dot = exported['.']
    if (typeof dot === 'string') push(dot)
    else if (dot && typeof dot === 'object') {
      push(dot.default)
      push(dot.import)
      push(dot.require)
    }
  }
  push(manifest?.module)
  push(manifest?.main)
  push('index.js')
  push('entry.js')
  return [...new Set(out)]
}

/* ------------------------------------------------------------------- state -- */

/**
 * Everything the Host half persists, all inside `<profile>/.plugin-curator/`.
 * Mutations go through these small helpers so the panel always reads one shape.
 */
function createStore(profileDir) {
  const stateDir = join(profileDir, STATE_DIRNAME)
  return {
    stateDir,
    bootsPath: join(stateDir, 'boots.json'),
    benchPath: join(stateDir, 'bench.json'),
    activityPath: join(stateDir, 'activity.json'),
    clientPath: join(stateDir, 'client.json'),
    flagsPath: join(stateDir, 'flags.json'),
    quarantinePath: join(stateDir, 'quarantine.json'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
    packPath: join(profileDir, 'package.json'),
    async init() {
      await fsp.mkdir(stateDir, { recursive: true })
    },
    async readBoots() {
      const value = readJsonSafe(this.bootsPath, [])
      return Array.isArray(value) ? value : []
    },
    async readQuarantine() {
      const value = readJsonSafe(this.quarantinePath, null)
      const items = Array.isArray(value?.items) ? value.items : []
      const history = Array.isArray(value?.history) ? value.history : []
      return { items, history }
    },
    async writeQuarantine(value) {
      await writeJsonAtomic(this.quarantinePath, value)
    },
    async readBench() {
      const value = readJsonSafe(this.benchPath, {})
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    },
    async readFlags() {
      const value = readJsonSafe(this.flagsPath, null)
      const disabledSince = value?.disabledSince
      return {
        disabledSince: disabledSince !== null && typeof disabledSince === 'object' && !Array.isArray(disabledSince)
          ? disabledSince
          : {},
      }
    },
    async writeFlags(value) {
      await writeJsonAtomic(this.flagsPath, value)
    },
  }
}

/* ------------------------------------------------------------------ plugin -- */

export function apply(ctx) {
  const logger = ctx.logger
  const detection = detectProfile(ctx)
  const bootStart = Date.now() - Math.round(process.uptime() * 1000)

  /** Mutable runtime facts for this process. */
  const runtime = {
    profileDir: detection.dir,
    detection,
    store: detection.dir === null ? null : createStore(detection.dir),
    boot: {
      startedAt: bootStart,
      applyMs: Date.now() - bootStart,
      /** True when this apply happened long after the process started. */
      hot: process.uptime() > HOT_INSTALL_SECONDS,
      settledMs: null,
      settled: false,
      /** How the settle watch ended: 'terminal' | 'stable' | 'timeout'. */
      complete: null,
      /** Enabled entries that never reached a terminal phase. */
      stalled: [],
      settleError: null,
      fingerprint: null,
      entryCount: 0,
      enabledCount: 0,
      phases: {},
    },
    jobs: {
      bench: { state: 'idle', done: 0, total: 0, current: '', message: '', finishedAt: null, force: false, launcher: null },
      activity: { state: 'idle', done: 0, total: 0, message: '', finishedAt: null },
    },
    lastError: null,
  }

  if (runtime.store === null) {
    logger?.warn?.('plugin-curator: no profile directory could be identified; the panel reports the failure instead of guessing')
  } else {
    logger?.info?.(`plugin-curator: profile ${runtime.profileDir} (via ${detection.basis})`)
    void runtime.store.init().then(() => persistBoot()).catch((error) => {
      runtime.lastError = String(error?.message ?? error)
      logger?.warn?.('plugin-curator: could not create the state directory', error)
    })
  }

  /* -- service accessors (all optional, all guarded) ---------------------- */

  const service = (key) => {
    try {
      return ctx.get(key) ?? null
    } catch {
      return null
    }
  }

  async function listPlugins() {
    const manager = service('pluginManager')
    if (manager === null) return { plugins: [], error: 'pluginManager service is missing in this profile' }
    try {
      const plugins = await manager.listPlugins()
      return { plugins: Array.isArray(plugins) ? plugins : [], error: null }
    } catch (error) {
      return { plugins: [], error: `pluginManager.listPlugins failed: ${String(error?.message ?? error)}` }
    }
  }

  async function listBundles() {
    const manager = service('pluginManager')
    if (manager === null) return []
    try {
      const bundles = await manager.listBundles()
      return Array.isArray(bundles) ? bundles : []
    } catch {
      return []
    }
  }

  /** `serverName` of every MCP row, so `mcp__<server>__<tool>` maps exactly. */
  function mcpServerOwners() {
    const editor = service('configEditor')
    const owners = new Map()
    if (editor === null || typeof editor.configuration !== 'function') return owners
    try {
      for (const item of editor.configuration()) {
        const id = item?.entry?.id ?? item?.entry?.options?.id
        const merged = { ...(item?.inherited ?? {}), ...(item?.override ?? {}) }
        const server = merged?.serverName
        if (typeof id === 'string' && typeof server === 'string' && server !== '') owners.set(server, id)
      }
    } catch {
      /* config projection is optional */
    }
    return owners
  }

  /* -- per-plugin description -------------------------------------------- */

  /**
   * Per-apply caches.
   *
   * A report resolves ~230 entries and the panel polls it, so the three
   * expensive lookups (directory resolution, manifest read, client path) are
   * memoized for the life of the process. They describe installed files, which
   * only change across a restart.
   */
  const cache = { dirs: new Map(), manifests: new Map(), clients: new Map() }

  function profileRequire() {
    if (runtime.store === null) return null
    try {
      return createRequire(join(runtime.profileDir, 'package.json'))
    } catch {
      return null
    }
  }

  function resolvePackageDir(moduleName, profileManifest) {
    const hit = cache.dirs.get(moduleName)
    if (hit !== undefined) return hit
    const resolved = resolvePackageDirUncached(moduleName, profileManifest)
    cache.dirs.set(moduleName, resolved)
    return resolved
  }

  function resolvePackageDirUncached(moduleName, profileManifest) {
    const deps = { ...(profileManifest?.dependencies ?? {}), ...(profileManifest?.devDependencies ?? {}) }
    const spec = deps?.[moduleName]
    for (const prefix of ['link:', 'file:']) {
      if (typeof spec === 'string' && spec.startsWith(prefix)) {
        const target = resolvePath(runtime.profileDir, spec.slice(prefix.length))
        if (existsSync(target)) return safeRealpath(target)
      }
    }
    const require = profileRequire()
    if (require !== null) {
      try {
        return safeRealpath(dirname(require.resolve(`${moduleName}/package.json`)))
      } catch {
        /* fall through */
      }
    }
    const direct = join(runtime.profileDir, 'node_modules', moduleName)
    if (existsSync(direct)) return safeRealpath(direct)
    return null
  }

  function readManifest(dir) {
    if (dir === null) return null
    const hit = cache.manifests.get(dir)
    if (hit !== undefined) return hit
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      manifest = null
    }
    cache.manifests.set(dir, manifest)
    return manifest
  }

  function clientFact(moduleName) {
    const hit = cache.clients.get(moduleName)
    if (hit !== undefined) return hit
    const modules = service('clientModules')
    let fact = null
    if (modules !== null && typeof modules.clientPath === 'function') {
      try {
        const path = modules.clientPath(moduleName)
        if (typeof path === 'string' && path !== '') {
          const info = statSafe(path)
          fact = { path, bytes: info?.size ?? null }
        }
      } catch {
        fact = null
      }
    }
    cache.clients.set(moduleName, fact)
    return fact
  }

  function bundleErrors(bundles) {
    const byModule = new Map()
    for (const bundle of bundles) {
      if (!bundle || typeof bundle !== 'object') continue
      if (!bundle.error) continue
      byModule.set(bundle.name, bundle.error)
      for (const row of bundle.rows ?? []) {
        if (typeof row?.moduleName === 'string') byModule.set(row.moduleName, bundle.error)
      }
    }
    return byModule
  }

  /**
   * Whether a module ships inside the DSH installation rather than the profile.
   *
   * Either signal is sufficient: the `@deepseek-ai/` scope (the framework's own
   * packages including the cordis core) or a resolved path inside the packaged
   * `app.asar`. Everything else came from the user's profile and is fair game.
   */
  function isBuiltin(moduleName, packageDir) {
    if (moduleName.startsWith('@deepseek-ai/') || moduleName.startsWith('cordis:')) return true
    if (packageDir === null) return false
    return /[\\/]app\.asar([\\/]|$)/.test(packageDir) || /[\\/]resources[\\/]app([\\/]|$)/.test(packageDir)
  }

  /** Classify one profile dependency spec. */
  function dependencyKind(spec) {
    if (typeof spec !== 'string') return 'inbox'
    if (spec.startsWith('link:')) return 'link'
    if (spec.startsWith('file:')) return 'file'
    if (spec.startsWith('workspace:')) return 'workspace'
    if (spec.startsWith('git') || spec.includes('github:')) return 'git'
    return 'registry'
  }

  function localized(value) {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
      if (typeof value.zh === 'string') return value.zh
      if (typeof value.en === 'string') return value.en
      for (const key of Object.keys(value)) if (typeof value[key] === 'string') return value[key]
    }
    return undefined
  }

  function benchKeyFor(packageDir, manifest) {
    if (packageDir === null) return null
    const info = statSafe(packageDir)
    const version = typeof manifest?.version === 'string' ? manifest.version : '0'
    return `${manifest?.name ?? packageDir}@${version}@${String(Math.round(info?.mtimeMs ?? 0))}`
  }

  async function describePlugins({ activity, bench, bundles, ui, disabledSince }) {
    const { plugins, error } = await listPlugins()
    const profileManifest = runtime.store === null ? null : readJsonSafe(runtime.store.packPath, null)
    const owners = mcpServerOwners()
    const errors = bundleErrors(bundles)
    const bundleByName = new Map()
    for (const bundle of bundles) {
      if (bundle && typeof bundle?.name === 'string') bundleByName.set(bundle.name, bundle)
    }
    const activityTools = activity?.tools ?? {}
    const sinceMap = disabledSince ?? {}
    const stalledById = new Map((runtime.boot.stalled ?? []).map((item) => [item.entryId, item]))

    const dirs = []
    const seenDir = new Set()
    const described = []
    for (const plugin of plugins) {
      const moduleName = String(plugin?.moduleName ?? '')
      const packageDir = resolvePackageDir(moduleName, profileManifest)
      const manifest = readManifest(packageDir)
      const declared = manifest?.dsh ?? {}
      const bundle = bundleByName.get(moduleName) ?? null
      const readOnly = plugin?.readOnlyReason
      described.push({
        plugin,
        moduleName,
        packageDir,
        manifest,
        bundle,
        readOnly,
        kind: dependencyKind(profileManifest?.dependencies?.[moduleName]),
        // DSH's own components are not the user's to prune: they ship inside the
        // installation and their rows are frequently unaddressable. They stay in
        // the inventory (so the count is honest) but never become a suggestion.
        origin: isBuiltin(moduleName, packageDir) ? 'builtin' : 'third-party',
        hasUi: typeof declared?.client === 'object' && declared?.client !== null,
      })
      if (packageDir !== null && !seenDir.has(packageDir) && typeof manifest?.name === 'string') {
        seenDir.add(packageDir)
        dirs.push({ key: moduleName, dir: packageDir })
      }
    }

    const attribution = attributeToolNames(dirs, Object.keys(activityTools))

    const out = []
    for (const item of described) {
      const { plugin, moduleName, packageDir, manifest, bundle } = item
      const entryId = String(plugin?.entryId ?? '')
      const title = localized(plugin?.meta?.title) ?? localized(manifest?.meta?.title) ?? moduleName
      const description = localized(plugin?.meta?.description) ?? localized(manifest?.meta?.description)
        ?? (typeof manifest?.description === 'string' ? manifest.description : undefined)

      let calls = 0
      let sessions = 0
      let lastAt = null
      const tools = {}
      const addTool = (toolName, fact) => {
        tools[toolName] = fact
        calls += fact.calls
        sessions = Math.max(sessions, fact.sessions)
        if (fact.lastAt !== null && (lastAt === null || fact.lastAt > lastAt)) lastAt = fact.lastAt
      }
      for (const [toolName, fact] of Object.entries(activityTools)) {
        if (toolName.startsWith('mcp__')) {
          const server = toolName.split('__')[1]
          if (typeof server === 'string' && owners.get(server) === entryId) addTool(toolName, fact)
          continue
        }
        if ((attribution.owned[moduleName] ?? []).includes(toolName)) addTool(toolName, fact)
      }

      const benchKey = benchKeyFor(packageDir, manifest)
      const benchFact = benchKey === null ? undefined : bench?.[benchKey]
      const client = clientFact(moduleName)
      const uiFact = ui?.entries?.[moduleName] ?? null
      const error = errors.get(moduleName) ?? null
      const incompatible = error?.code === 'incompatible-version'
      const since = Number.isFinite(sinceMap[entryId]) ? sinceMap[entryId] : null
      const disabledDays = plugin?.enabled === false && since !== null
        ? (Date.now() - since) / 86400000
        : null

      const facts = {
        enabled: plugin?.enabled === true,
        broken: plugin?.fiberPhase === 'failed',
        incompatible,
        stalled: stalledById.has(entryId),
        stalledPhase: stalledById.get(entryId)?.phase ?? null,
        // `null` means "no scan has run", which is a different statement from
        // "the scan ran and this plugin was never called".
        calls: activity === null ? null : calls,
        sessions,
        bootMs: Number.isFinite(benchFact?.ms) ? benchFact.ms : null,
        clientBytes: client?.bytes ?? null,
        disabledDays,
        activityReason: activity === null ? '活跃度尚未扫描（点「扫描活跃度」）' : '窗口内 0 次调用',
      }
      const suggestion = suggestFor(facts)

      out.push({
        entryId,
        moduleName,
        patchId: typeof plugin?.patchId === 'string' ? plugin.patchId : null,
        readOnlyReason: typeof item.readOnly === 'string' ? item.readOnly : null,
        enabled: plugin?.enabled === true,
        fiberPhase: plugin?.fiberPhase ?? null,
        packageName: typeof manifest?.name === 'string' ? manifest.name : moduleName,
        version: typeof manifest?.version === 'string' ? manifest.version : (bundle?.version ?? null),
        title,
        description: description ?? null,
        kind: item.kind,
        origin: item.origin,
        source: typeof profileManifest?.dependencies?.[moduleName] === 'string'
          ? profileManifest.dependencies[moduleName]
          : null,
        packageDir,
        hasUi: item.hasUi,
        client,
        ui: uiFact,
        bootMs: facts.bootMs,
        bootSamples: benchFact?.samples ?? null,
        activity: activity === null ? null : { calls, sessions, lastAt, tools },
        bundle: bundle === null ? null : {
          name: bundle.name,
          version: bundle.version ?? null,
          enabled: bundle.enabled === true,
          official: bundle.official === true,
          error: bundle.error ?? null,
        },
        error,
        incompatible,
        stalled: facts.stalled,
        stalledPhase: facts.stalledPhase,
        verdict: suggestion.verdict,
        reasons: suggestion.reasons,
      })
    }
    return { plugins: out, error, attribution, observedNames: Object.keys(activityTools) }
  }

  /* -- boot settle + history --------------------------------------------- */

  function phaseSummary(plugins) {
    const phases = {}
    for (const plugin of plugins) {
      const phase = plugin?.fiberPhase ?? 'unknown'
      phases[phase] = (phases[phase] ?? 0) + 1
    }
    return phases
  }

  async function watchSettle() {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS
    const startedAt = runtime.boot.startedAt
    let plugins = []
    let sawList = false
    let quietPolls = 0
    let lastSignature = ''
    /**
     * A boot is "done" when either every enabled entry reached a terminal phase
     * (active | failed), or the phase vector stopped moving for three polls.
     *
     * The second condition is not a shortcut, it is the honest one: some rows
     * legitimately sit in `pending` forever because the service they wait for is
     * absent (`waiting for service: webRuntime`). Waiting the full two minutes
     * would turn the headline number into the timeout, and calling that a startup
     * duration would be a lie. Those rows are reported as `stalled` instead.
     */
    while (Date.now() < deadline) {
      const listed = await listPlugins()
      if (listed.error === null) {
        sawList = true
        plugins = listed.plugins
        const enabled = plugins.filter((plugin) => plugin?.enabled === true)
        const terminal = enabled.filter((plugin) => plugin.fiberPhase === 'active' || plugin.fiberPhase === 'failed')
        if (enabled.length > 0 && terminal.length === enabled.length) {
          runtime.boot.complete = 'terminal'
          break
        }
        const signature = enabled
          .map((plugin) => `${String(plugin?.entryId)}:${String(plugin?.fiberPhase ?? 'null')}`)
          .sort()
          .join('|')
        if (signature === lastSignature && signature !== '') {
          quietPolls += 1
          if (quietPolls >= 3 && Date.now() - startedAt > 1500) {
            runtime.boot.complete = 'stable'
            break
          }
        } else {
          lastSignature = signature
          quietPolls = 0
        }
      } else if (runtime.boot.settleError === null) {
        runtime.boot.settleError = listed.error
      } else if (Date.now() - runtime.boot.startedAt > 20_000) {
        runtime.boot.complete = 'timeout'
        break
      }
      await sleep(250)
    }
    if (!sawList) {
      runtime.boot.settled = false
      runtime.boot.complete = runtime.boot.complete ?? 'timeout'
      runtime.boot.settleError = runtime.boot.settleError ?? 'pluginManager never answered'
      return
    }
    if (runtime.boot.complete === undefined) runtime.boot.complete = 'timeout'
    const enabled = plugins.filter((plugin) => plugin?.enabled === true)
    runtime.boot.stalled = enabled
      .filter((plugin) => plugin.fiberPhase !== 'active' && plugin.fiberPhase !== 'failed')
      .map((plugin) => ({
        entryId: String(plugin?.entryId ?? ''),
        moduleName: String(plugin?.moduleName ?? ''),
        phase: plugin?.fiberPhase ?? null,
      }))
    runtime.boot.entryCount = plugins.length
    runtime.boot.enabledCount = enabled.length
    runtime.boot.phases = phaseSummary(plugins)
    runtime.boot.fingerprint = sha1(enabled
      .map((plugin) => String(plugin?.entryId))
      .sort()
      .join('|')).slice(0, 16)

    // A hot install (this row added while the process was already running) has
    // no meaningful "time from process start": the process started minutes
    // before this plugin existed. Keep the composition, refuse the duration, and
    // let the panel show the previous boot's history instead.
    if (runtime.boot.hot === true) {
      runtime.boot.settled = false
      runtime.boot.settledMs = null
      return
    }

    runtime.boot.settled = true
    runtime.boot.settledMs = Date.now() - startedAt
    await persistBoot()
  }

  async function persistBoot() {
    if (runtime.store === null || runtime.boot.hot === true) return
    try {
      const history = await runtime.store.readBoots()
      const record = {
        at: runtime.boot.startedAt,
        settledMs: runtime.boot.settledMs,
        settled: runtime.boot.settled,
        complete: runtime.boot.complete ?? null,
        stalled: runtime.boot.stalled ?? [],
        fingerprint: runtime.boot.fingerprint,
        entryCount: runtime.boot.entryCount,
        enabledCount: runtime.boot.enabledCount,
        phases: runtime.boot.phases,
      }
      const existing = history.findIndex((item) => item?.at === record.at)
      if (existing >= 0) history[existing] = record
      else history.push(record)
      history.sort((a, b) => Number(b?.at ?? 0) - Number(a?.at ?? 0))
      await writeJsonAtomic(runtime.store.bootsPath, history.slice(0, BOOT_HISTORY_LIMIT))
    } catch (error) {
      runtime.lastError = String(error?.message ?? error)
    }
  }

  /* -- jobs --------------------------------------------------------------- */

  /** One probe run; resolves a parsed result, never throws. */
  function runProbe(nodePath, entryPath) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let child
      try {
        child = spawn(nodePath, [PROBE_FILE, pathToFileURL(entryPath).href], {
          cwd: SELF_DIR,
          env: probeEnv({ DSH_PLUGIN_CURATOR_PROBE: '1' }),
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
      } catch (error) {
        // `spawn:` marks a launcher that never started; callers use that prefix
        // to tell "this node is unusable" from "the probe imported something and
        // it failed".
        finish({ error: `spawn: ${String(error?.message ?? error)}` })
        return
      }
      let stdout = ''
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        finish({ error: 'probe timeout' })
      }, BENCH_TIMEOUT_MS)
      timer?.unref?.()
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < 64 * 1024) stdout += String(chunk)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        finish({ error: `spawn: ${String(error?.message ?? error)}` })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        const line = stdout.trim().split('\n').pop() ?? ''
        try {
          const parsed = JSON.parse(line)
          finish(Number.isFinite(parsed?.ms) ? { ms: parsed.ms } : { error: String(parsed?.error ?? 'no duration') })
        } catch {
          finish({ error: `no-output: exit ${String(code ?? '?')}` })
        }
      })
    })
  }

  /**
   * Resolve one `node` executable for the probes, once per process.
   *
   * Candidates are tried by running the probe itself: an executable that exists
   * but cannot run (a stub, a wrong architecture) must not silently make every
   * measurement fail.
   */
  let launcherPromise = null
  function pickNode() {
    if (launcherPromise !== null) return launcherPromise
    launcherPromise = (async () => {
      const explicit = process.env.DSH_PLUGIN_CURATOR_NODE
      for (const candidate of nodeCandidates()) {
        const result = await runProbe(candidate, SELFCHECK_FILE)
        // The self-check module always imports cleanly, so a duration OR a
        // non-spawn error both prove the executable ran. Only a launcher that
        // never started (or printed nothing) is skipped.
        const ran = Number.isFinite(result.ms)
          || (typeof result.error === 'string' && !result.error.startsWith('spawn:') && !result.error.startsWith('no-output:'))
        if (ran) return candidate
        if (candidate === explicit) return candidate
      }
      return null
    })()
    return launcherPromise
  }

  function measureEntry(entryPath, nodePath) {
    return (async () => {
      const samples = []
      let error = null
      for (let run = 0; run < BENCH_RUNS; run += 1) {
        const result = await runProbe(nodePath, entryPath)
        if (Number.isFinite(result.ms)) samples.push(Math.round(result.ms * 10) / 10)
        else error = result.error ?? 'failed'
      }
      if (samples.length === 0) return { ms: null, samples, error }
      return { ms: Math.min(...samples), samples, error }
    })()
  }

  async function runBench(force) {
    if (runtime.jobs.bench.state === 'running') return { started: false, reason: 'already running' }
    if (runtime.store === null) return { started: false, reason: 'no profile directory' }
    const { plugins } = await listPlugins()
    const profileManifest = readJsonSafe(runtime.store.packPath, null)
    const targets = []
    const seen = new Set()
    for (const plugin of plugins) {
      if (plugin?.enabled !== true) continue
      const moduleName = String(plugin?.moduleName ?? '')
      const dir = resolvePackageDir(moduleName, profileManifest)
      if (dir === null || seen.has(dir)) continue
      seen.add(dir)
      const manifest = readManifest(dir)
      const entry = entryCandidates(dir, manifest)[0]
      if (entry === undefined) continue
      targets.push({
        key: benchKeyFor(dir, manifest),
        moduleName,
        entry,
        thirdParty: isBuiltin(moduleName, dir) !== true,
      })
    }
    // Third-party first: if the run is interrupted, the rows the user can act on
    // are already measured.
    targets.sort((a, b) => Number(b.thirdParty) - Number(a.thirdParty))

    const job = runtime.jobs.bench
    job.state = 'running'
    job.done = 0
    job.total = targets.length
    job.current = ''
    job.finishedAt = null
    job.force = force === true

    const node = await pickNode()
    job.launcher = node
    if (node === null) {
      job.state = 'error'
      job.finishedAt = Date.now()
      job.message = '找不到可用的 node 可执行文件；可用 DSH_PLUGIN_CURATOR_NODE 指定'
      return { started: false, reason: 'no node executable' }
    }
    job.message = '正在逐个隔离测量（子进程冷加载）'

    const cache = await runtime.store.readBench()
    void (async () => {
      try {
        for (const target of targets) {
          job.current = target.moduleName
          if (force !== true && cache[target.key] !== undefined) {
            job.done += 1
            continue
          }
          const result = await measureEntry(target.entry, node)
          cache[target.key] = { ...result, at: Date.now() }
          await writeJsonAtomic(runtime.store.benchPath, cache)
          job.done += 1
        }
        job.state = 'done'
        job.message = `已测量 ${String(job.total)} 个插件`
      } catch (error) {
        job.state = 'error'
        job.message = String(error?.message ?? error)
      } finally {
        job.current = ''
        job.finishedAt = Date.now()
      }
    })()
    return { started: true, total: targets.length, launcher: node }
  }

  async function runActivity(windowDays) {
    if (runtime.jobs.activity.state === 'running') return { started: false, reason: 'already running' }
    if (runtime.store === null) return { started: false, reason: 'no profile directory' }
    const job = runtime.jobs.activity
    job.state = 'running'
    job.message = '正在读取会话日志中的 tool/call 事件'
    job.finishedAt = null
    job.done = 0
    job.total = 0
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    void (async () => {
      try {
        if (!zstdAvailable()) throw new Error('this runtime has no zstd decoder (zlib.zstdDecompressSync)')
        const result = await scanToolCalls({
          home,
          windowDays: Number.isFinite(windowDays) ? windowDays : ACTIVITY_WINDOW_DAYS,
        })
        job.done = result.coverage.filesRead
        job.total = result.coverage.files
        await writeJsonAtomic(runtime.store.activityPath, result)
        job.state = 'done'
        job.message = `读了 ${String(result.coverage.filesRead)} 个会话日志，发现 ${String(Object.keys(result.tools).length)} 个被调用过的工具`
      } catch (error) {
        job.state = 'error'
        job.message = String(error?.message ?? error)
      } finally {
        job.finishedAt = Date.now()
      }
    })()
    return { started: true }
  }

  /* -- report ------------------------------------------------------------- */

  async function buildReport() {
    const bundles = await listBundles()
    const bench = runtime.store === null ? {} : await runtime.store.readBench()
    const activity = runtime.store === null ? null : readJsonSafe(runtime.store.activityPath, null)
    const clientState = runtime.store === null ? null : readJsonSafe(runtime.store.clientPath, null)
    const quarantine = runtime.store === null ? { items: [], history: [] } : await runtime.store.readQuarantine()
    const flags = runtime.store === null ? { disabledSince: {} } : await runtime.store.readFlags()
    const boots = runtime.store === null ? [] : await runtime.store.readBoots()

    /**
     * When did each disabled entry get disabled?
     *
     * Two observed sources: the quarantine record written when this plugin turned
     * the row off, and the flag written by a plain toggle. An entry disabled
     * before this plugin existed has no timestamp and therefore no grace-period
     * verdict — the panel says nothing rather than inventing an age.
     */
    const disabledSince = { ...flags.disabledSince }
    for (const item of quarantine.items) {
      if (typeof item?.entryId === 'string' && Number.isFinite(item?.at)) {
        disabledSince[item.entryId] = Math.min(disabledSince[item.entryId] ?? item.at, item.at)
      }
    }

    const described = await describePlugins({
      activity: activity === null ? null : { tools: activity.tools ?? {} },
      bench,
      bundles,
      ui: clientState,
      disabledSince,
    })

    const plugins = described.plugins
    const byId = new Map(plugins.map((plugin) => [plugin.entryId, plugin]))

    /**
     * Only third-party rows become suggestions.
     *
     * A DSH-internal service being "quiet" says nothing about whether it is
     * needed — it is a service, not a tool anyone calls — and its row is often
     * unaddressable anyway. Counting them would bury the handful of real
     * findings under two hundred false ones.
     */
    const thirdParty = plugins.filter((plugin) => plugin.origin === 'third-party')
    const suggestions = thirdParty
      .filter((plugin) => plugin.verdict === 'disable' || plugin.verdict === 'cleanup' || plugin.verdict === 'review')
      .map((plugin) => ({
        entryId: plugin.entryId,
        moduleName: plugin.moduleName,
        title: plugin.title,
        verdict: plugin.verdict,
        reasons: plugin.reasons,
        savedMs: plugin.bootMs,
        clientBytes: plugin.client?.bytes ?? null,
      }))
      .sort((a, b) => {
        const weight = (item) => (item.verdict === 'cleanup' ? 1000 : item.verdict === 'disable' ? 100 : 0)
        const delta = weight(b) - weight(a)
        if (delta !== 0) return delta
        return Number(b.savedMs ?? 0) - Number(a.savedMs ?? 0)
      })

    const cleanup = {
      broken: thirdParty.filter((plugin) => plugin.verdict === 'cleanup' && plugin.enabled),
      disabled: thirdParty.filter((plugin) => plugin.enabled === false),
      trash: quarantine.items.filter((item) => item?.restoredAt === undefined).map((item) => ({
        ...item,
        live: byId.has(item.entryId) ? byId.get(item.entryId).enabled : null,
      })),
      history: quarantine.history.slice(-20),
    }

    const history = boots.map((record, index) => {
      const previous = boots[index + 1]
      const changed = previous === undefined || previous?.fingerprint === record?.fingerprint
        ? null
        : {
          deltaMs: Number(record?.settledMs ?? 0) - Number(previous?.settledMs ?? 0),
          entryCount: Number(record?.enabledCount ?? 0) - Number(previous?.enabledCount ?? 0),
        }
      return { ...record, changed }
    })

    const sumBytes = (list) => list.reduce((sum, plugin) => sum + (plugin.client?.bytes ?? 0), 0)
    const sumBoot = (list) => list.reduce((sum, plugin) => sum + (plugin.bootMs ?? 0), 0)
    return {
      generatedAt: Date.now(),
      dsh: {
        version: readDshVersion(),
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        pid: process.pid,
      },
      profile: runtime.store === null ? null : {
        dir: runtime.profileDir,
        detection: detection.basis,
        patchPath: runtime.store.patchPath,
        stateDir: runtime.store.stateDir,
      },
      boot: {
        current: { ...runtime.boot, stalled: [...(runtime.boot.stalled ?? [])] },
        history,
        basis: {
          settledMs: '本进程实测：进程启动 → 所有已启用条目到达终态（或相位不再变化）',
          bootMs: '单插件实测：隔离子进程冷加载模块，3 次取最小',
          uiDurationMs: '单插件实测：浏览器 Resource Timing 中该插件 client bundle 的耗时',
        },
      },
      jobs: runtime.jobs,
      plugins,
      totals: {
        plugins: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        disabled: plugins.filter((plugin) => !plugin.enabled).length,
        builtin: plugins.filter((plugin) => plugin.origin === 'builtin').length,
        thirdParty: thirdParty.length,
        builtinFailed: plugins.filter((plugin) => plugin.origin === 'builtin' && plugin.fiberPhase === 'failed').length,
        failed: thirdParty.filter((plugin) => plugin.verdict === 'cleanup' && plugin.enabled).length,
        clientBytes: sumBytes(plugins),
        thirdPartyBytes: sumBytes(thirdParty),
        measuredBootMs: sumBoot(plugins),
        measuredThirdPartyMs: sumBoot(thirdParty),
      },
      activity: activity === null ? null : {
        scannedAt: activity.scannedAt,
        windowDays: activity.windowDays,
        sessionCount: activity.sessionCount,
        coverage: activity.coverage,
        toolCount: Object.keys(activity.tools ?? {}).length,
        observedNames: described.observedNames.length,
      },
      attribution: {
        ambiguous: described.attribution.ambiguous,
        owned: described.attribution.owned,
      },
      suggestions,
      cleanup,
      quarantine,
      ui: clientState,
      error: described.error,
      lastError: runtime.lastError,
    }
  }

  function readDshVersion() {
    const require = profileRequire()
    if (require === null) return null
    try {
      return require('@deepseek-ai/dsh-brand/package.json')?.version ?? null
    } catch {
      return null
    }
  }

  /* -- route handlers ----------------------------------------------------- */

  const guard = (handler) => async (req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await readJsonBody(req)
    if (body.ok !== true) {
      sendJson(res, 400, { ok: false, error: body.error })
      return
    }
    try {
      await handler(body.value ?? {}, res)
    } catch (error) {
      runtime.lastError = String(error?.message ?? error)
      sendJson(res, 500, { ok: false, error: runtime.lastError })
    }
  }

  const handlers = {
    report: guard(async (_input, res) => {
      if (runtime.store === null) {
        sendJson(res, 503, {
          ok: false,
          error: '找不到本进程所属的 profile 目录（node_modules 反查、package.json 依赖、cordis.patch.yml 三条线索都没有命中）',
        })
        return
      }
      sendJson(res, 200, { ok: true, value: await buildReport() })
    }),

    toggle: guard(async (input, res) => {
      const manager = service('pluginManager')
      if (manager === null) {
        sendJson(res, 503, { ok: false, error: 'pluginManager service is missing in this profile' })
        return
      }
      const entryId = typeof input.entryId === 'string' ? input.entryId : ''
      const enabled = input.enabled === true
      if (entryId === '') {
        sendJson(res, 400, { ok: false, error: 'entryId is required' })
        return
      }
      const result = await manager.setPluginEnabled(entryId, enabled)
      // The grace period in `suggestFor` needs to know WHEN a row became
      // disabled; that fact exists nowhere in DSH, so it is recorded here.
      if (runtime.store !== null) {
        const flags = await runtime.store.readFlags()
        if (enabled) delete flags.disabledSince[entryId]
        else flags.disabledSince[entryId] = Date.now()
        await runtime.store.writeFlags(flags)
      }
      sendJson(res, 200, { ok: true, value: result })
    }),

    quarantine: guard(async (input, res) => {
      if (runtime.store === null) {
        sendJson(res, 503, { ok: false, error: 'no profile directory' })
        return
      }
      const manager = service('pluginManager')
      const entryId = typeof input.entryId === 'string' ? input.entryId : ''
      if (entryId === '') {
        sendJson(res, 400, { ok: false, error: 'entryId is required' })
        return
      }
      const { plugins } = await listPlugins()
      const target = plugins.find((plugin) => String(plugin?.entryId) === entryId) ?? null
      if (target === null) {
        sendJson(res, 404, { ok: false, error: 'this entry is not in the live Loader tree' })
        return
      }
      const reasons = Array.isArray(input.reasons) ? input.reasons.filter((item) => typeof item === 'string') : []
      let change = null
      if (target.enabled === true && manager !== null) {
        change = await manager.setPluginEnabled(entryId, false)
      }
      const flags = await runtime.store.readFlags()
      flags.disabledSince[entryId] = Date.now()
      await runtime.store.writeFlags(flags)
      const state = await runtime.store.readQuarantine()
      const record = {
        entryId,
        moduleName: String(target.moduleName ?? ''),
        patchId: typeof target.patchId === 'string' ? target.patchId : null,
        title: localized(target?.meta?.title) ?? String(target.moduleName ?? entryId),
        reasons,
        priorEnabled: target.enabled === true,
        fiberPhase: target.fiberPhase ?? null,
        at: Date.now(),
        change,
      }
      state.items = state.items.filter((item) => item?.entryId !== entryId)
      state.items.push(record)
      await runtime.store.writeQuarantine(state)
      sendJson(res, 200, { ok: true, value: { record, change } })
    }),

    restore: guard(async (input, res) => {
      if (runtime.store === null) {
        sendJson(res, 503, { ok: false, error: 'no profile directory' })
        return
      }
      const manager = service('pluginManager')
      if (manager === null) {
        sendJson(res, 503, { ok: false, error: 'pluginManager service is missing in this profile' })
        return
      }
      const entryId = typeof input.entryId === 'string' ? input.entryId : ''
      if (entryId === '') {
        sendJson(res, 400, { ok: false, error: 'entryId is required' })
        return
      }
      const state = await runtime.store.readQuarantine()
      const record = state.items.find((item) => item?.entryId === entryId) ?? null
      const steps = []

      // 1. A row that still exists in the composition is simply re-enabled.
      let change = null
      try {
        change = await manager.setPluginEnabled(entryId, true)
        steps.push({ step: 'set-enabled', result: change })
      } catch (error) {
        steps.push({ step: 'set-enabled', error: String(error?.message ?? error) })
      }

      // 2. A row that is gone has to be re-inserted, and re-inserting means
      //    writing the profile patch. That is the only place this plugin edits
      //    YAML, so it backs the file up first and reports what it wrote.
      let reinserted = null
      const before = await listPlugins()
      const live = before.plugins.some((plugin) => String(plugin?.entryId) === entryId)
      if (!live && record !== null && typeof record.patchId === 'string' && typeof record.moduleName === 'string') {
        reinserted = appendInsertRow(runtime.store, record.patchId, record.moduleName)
        steps.push({ step: 'reinsert', result: reinserted })
        if (reinserted?.appended === true) {
          const deadline = Date.now() + 4000
          while (Date.now() < deadline) {
            await sleep(250)
            const after = await listPlugins()
            if (after.plugins.some((plugin) => String(plugin?.entryId) === entryId)) break
          }
        }
      }

      const after = await listPlugins()
      const present = after.plugins.some((plugin) => String(plugin?.entryId) === entryId)
      if (record !== null) {
        state.items = state.items.filter((item) => item?.entryId !== entryId)
        state.history.push({ ...record, restoredAt: Date.now(), steps })
        await runtime.store.writeQuarantine(state)
      }
      const flags = await runtime.store.readFlags()
      delete flags.disabledSince[entryId]
      await runtime.store.writeFlags(flags)
      sendJson(res, 200, {
        ok: true,
        value: {
          entryId,
          present,
          steps,
          change,
          reinserted,
          restartLikely: reinserted?.appended === true && !present,
        },
      })
    }),

    measure: guard(async (input, res) => {
      if (runtime.store === null) {
        sendJson(res, 503, { ok: false, error: 'no profile directory' })
        return
      }
      const started = await runBench(input.force === true)
      sendJson(res, 200, { ok: true, value: { started, job: runtime.jobs.bench } })
    }),

    activity: guard(async (input, res) => {
      if (runtime.store === null) {
        sendJson(res, 503, { ok: false, error: 'no profile directory' })
        return
      }
      const started = await runActivity(input.windowDays)
      sendJson(res, 200, { ok: true, value: { started, job: runtime.jobs.activity } })
    }),

    'client-timing': guard(async (input, res) => {
      if (runtime.store === null) {
        sendJson(res, 503, { ok: false, error: 'no profile directory' })
        return
      }
      const entries = {}
      if (input?.entries !== null && typeof input?.entries === 'object') {
        for (const [id, fact] of Object.entries(input.entries)) {
          if (fact === null || typeof fact !== 'object') continue
          entries[id] = {
            durationMs: Number.isFinite(fact.durationMs) ? Math.round(fact.durationMs * 10) / 10 : null,
            transferSize: Number.isFinite(fact.transferSize) ? fact.transferSize : null,
            encodedBodySize: Number.isFinite(fact.encodedBodySize) ? fact.encodedBodySize : null,
            startMs: Number.isFinite(fact.startMs) ? Math.round(fact.startMs) : null,
          }
        }
      }
      const value = {
        at: Date.now(),
        navigationMs: Number.isFinite(input?.navigationMs) ? Math.round(input.navigationMs) : null,
        panelReadyMs: Number.isFinite(input?.panelReadyMs) ? Math.round(input.panelReadyMs) : null,
        entries,
      }
      await writeJsonAtomic(runtime.store.clientPath, value)
      sendJson(res, 200, { ok: true, value: { at: value.at, count: Object.keys(entries).length } })
    }),
  }

  /** Append one `insert` row to the profile patch, with a timestamped backup. */
  function appendInsertRow(store, patchId, moduleName) {
    let text
    try {
      text = readFileSync(store.patchPath, 'utf8')
    } catch (error) {
      return { appended: false, reason: `patch unreadable: ${String(error?.message ?? error)}` }
    }
    const escaped = patchId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`^\\s*-\\s*id:\\s*['"]?${escaped}['"]?\\s*$`, 'm').test(text)) {
      return { appended: false, reason: 'row-already-declared' }
    }
    const backup = `${store.patchPath}.bak-plugin-curator-${String(Date.now())}`
    const block = `${text.endsWith('\n') ? '' : '\n'}\n# dsh-plugin-curator 找回：${new Date().toISOString()}\n- insert:\n    - id: ${patchId}\n      name: '${moduleName}'\n`
    try {
      copyFileSync(store.patchPath, backup)
      appendFileSync(store.patchPath, block, 'utf8')
      return { appended: true, backup }
    } catch (error) {
      return { appended: false, reason: String(error?.message ?? error) }
    }
  }

  /* -- registration ------------------------------------------------------- */

  const server = ctx.webServer
  if (server === undefined || typeof server.register !== 'function') {
    logger?.warn?.('plugin-curator: webServer is unavailable; the panel has nothing to talk to')
    return
  }

  for (const [suffix, handler] of Object.entries(handlers)) {
    ctx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/${suffix}`,
      handler,
    }), `plugin-curator: ${suffix} route`)
  }

  // The settle watcher is what turns "the Host started" into a number the panel
  // can show. It is bounded, silent on failure, and writes its record once.
  void watchSettle().catch((error) => {
    runtime.lastError = String(error?.message ?? error)
    logger?.warn?.('plugin-curator: settle watcher failed', error)
  })
}

/** Shown by the package manager / docs. */
export const meta = {
  title: '插件管家',
  description: '实测启动开销、活跃度与禁用建议；清理不兼容与已停用条目并可找回。',
}
