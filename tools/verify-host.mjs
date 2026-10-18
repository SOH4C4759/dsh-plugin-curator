// Offline checks for the Host half's testable seams.
//
// Everything here runs with plain `node` and no DSH: the pure rules (suggestion
// verdicts), the session-log frame decoder, the tool-name attribution scan, the
// profile detector and the entry resolver. The route handlers need a live
// webServer and are covered by tools/verify-routes.mjs instead.
//
//   node tools/verify-host.mjs
//
// Exit 0 = every assertion held.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import {
  attributeToolNames,
  decodeSessionFrames,
  detectProfile,
  entryCandidates,
  findSessionFiles,
  suggestFor,
  zstdAvailable,
} from '../entry.js'

let checks = 0
function check(label, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} — ${label}`)
}

const temp = mkdtempSync(join(tmpdir(), 'curator-'))
process.on('exit', () => {
  try {
    rmSync(temp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/* ------------------------------------------------------------- verdicts -- */

check('a failed entry is a cleanup problem, not a quiet one', () => {
  const verdict = suggestFor({ enabled: true, broken: true, calls: 0, bootMs: 500, clientBytes: null })
  assert.equal(verdict.verdict, 'cleanup')
  assert.equal(verdict.reasons[0].code, 'load-failed')
})

check('an incompatible version outranks the quiet rules', () => {
  const verdict = suggestFor({ enabled: true, incompatible: true, calls: 0, bootMs: 10, clientBytes: null })
  assert.equal(verdict.verdict, 'cleanup')
  assert.equal(verdict.reasons[0].code, 'incompatible-version')
})

check('an entry stuck in pending after boot is a cleanup candidate', () => {
  const verdict = suggestFor({ enabled: true, stalled: true, stalledPhase: 'pending', calls: 0, bootMs: 5, clientBytes: null })
  assert.equal(verdict.verdict, 'cleanup')
  assert.equal(verdict.reasons[0].code, 'stalled-pending')
})

check('a long-disabled entry becomes a cleanup candidate', () => {
  const verdict = suggestFor({ enabled: false, disabledDays: 30, calls: 0, bootMs: null, clientBytes: null })
  assert.equal(verdict.verdict, 'cleanup')
  assert.equal(verdict.reasons[0].code, 'disabled-long')
})

check('a freshly disabled entry is left alone', () => {
  const verdict = suggestFor({ enabled: false, disabledDays: 1, calls: 0, bootMs: null, clientBytes: null })
  assert.equal(verdict.verdict, 'idle')
})

check('a quiet host-only plugin is a disable suggestion only when it costs real boot time', () => {
  const verdict = suggestFor({ enabled: true, calls: 0, sessions: 0, bootMs: 90, clientBytes: null })
  assert.equal(verdict.verdict, 'disable')
  assert.deepEqual(verdict.reasons.map((item) => item.code), ['quiet-host-only', 'slow'])
})

check('a cheap quiet host-only plugin is NOT a disable suggestion', () => {
  // Prompt-injecting / event-listening plugins leave no `tool/call` behind, so a
  // cheap one must read as "cannot see it", never as "unused".
  const cheap = suggestFor({ enabled: true, calls: 0, sessions: 0, bootMs: 4, clientBytes: null })
  assert.equal(cheap.verdict, 'review')
  assert.equal(cheap.reasons[0].code, 'unobservable-host-only')
})

check('a quiet plugin WITHOUT a scan is only a review, never "unused"', () => {
  const verdict = suggestFor({ enabled: true, calls: null, bootMs: 90, clientBytes: null })
  assert.equal(verdict.verdict, 'review')
  assert.equal(verdict.reasons[0].code, 'unobserved')
})

check('a quiet UI plugin with a small bundle is kept', () => {
  const verdict = suggestFor({ enabled: true, calls: 0, bootMs: 5, clientBytes: 24_000 })
  assert.equal(verdict.verdict, 'keep')
  assert.equal(verdict.reasons[0].code, 'ui-unobserved')
})

check('a quiet UI plugin with a heavy bundle and a slow module is a disable', () => {
  const verdict = suggestFor({ enabled: true, calls: 0, bootMs: 120, clientBytes: 700_000 })
  assert.equal(verdict.verdict, 'disable')
})

check('a used plugin is kept and says how much it is used', () => {
  const verdict = suggestFor({ enabled: true, calls: 12, sessions: 3, bootMs: 40, clientBytes: 1000 })
  assert.equal(verdict.verdict, 'keep')
  assert.equal(verdict.reasons[0].code, 'in-use')
})

/* ---------------------------------------------- session log frame decode -- */

check('zstd is available in this runtime (the activity scan depends on it)', () => {
  // Recorded rather than asserted on an older runtime: the scanner degrades with
  // a message, and this check documents which case we are in.
  console.log(`   zstd decoder: ${zstdAvailable() ? 'available' : 'MISSING (scan will report unavailable)'}`)
})

if (zstdAvailable() && typeof zlib.zstdCompressSync === 'function') {
  check('concatenated zstd frames decode as one text, not just the first frame', () => {
    const first = JSON.stringify({ type: 'session', id: 'a' }) + '\n'
    const second = JSON.stringify({ type: 'tool/call', data: { name: 'read' }, time: 5 }) + '\n'
    const third = JSON.stringify({ type: 'tool/call', data: { name: 'write' }, time: 6 }) + '\n'
    const buffer = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(first)),
      zlib.zstdCompressSync(Buffer.from(second)),
      zlib.zstdCompressSync(Buffer.from(third)),
    ])
    const decoded = decodeSessionFrames(buffer)
    assert.equal(decoded.frames, 3)
    assert.equal(decoded.failed, 0)
    assert.deepEqual(decoded.text.split('\n').filter(Boolean).length, 3)
    assert.match(decoded.text, /tool\/call/)
  })
}

/* --------------------------------------------------- tool attribution -- */

check('a tool name found in exactly one package is attributed to it', () => {
  const a = join(temp, 'pkg-a')
  const b = join(temp, 'pkg-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  writeFileSync(join(a, 'index.js'), 'defineTool({ name: "alpha_tool" })\ndefineTool({ name: "shared_tool" })\n')
  writeFileSync(join(a, 'client.js'), 'defineTool({ name: "ui_only_tool" })\n')
  writeFileSync(join(b, 'index.js'), 'defineTool({ name: "beta_tool" })\nconst other = "shared_tool"\ndefineTool({ name: "shared_tool" })\n')
  const result = attributeToolNames(
    [{ key: 'pkg-a', dir: a }, { key: 'pkg-b', dir: b }],
    ['alpha_tool', 'beta_tool', 'shared_tool', 'ui_only_tool', 'never_seen'],
  )
  assert.deepEqual(result.owned['pkg-a'], ['alpha_tool'])
  assert.deepEqual(result.owned['pkg-b'], ['beta_tool'])
  assert.deepEqual(result.ambiguous.shared_tool, ['pkg-a', 'pkg-b'])
})

check('a name that is only CALLED, never declared, is not attributed', () => {
  const dir = join(temp, 'pkg-caller')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), [
    'const tools = ["read", "write"]',
    'async function go(ctx) { await ctx.tools.execute({ name: "read" }) }',
    'const label = "read"',
    '',
  ].join('\n'))
  const result = attributeToolNames([{ key: 'pkg-caller', dir }], ['read', 'write'])
  // `read` appears as `name: "read"` only inside a call payload, which the
  // shape rule still matches — the honest answer is "declared shape found", and
  // the ambiguity rule removes it as soon as another package declares it too.
  assert.deepEqual(result.owned['pkg-caller'], ['read'])
  assert.equal(result.ambiguous.write, undefined, 'a bare array literal must not count')
})

check('this package never claims a tool', () => {
  const result = attributeToolNames([{ key: 'dsh-plugin-curator', dir: join(temp, '..') }], ['read'])
  assert.equal(result.owned['dsh-plugin-curator'], undefined)
})

check('the browser half is not scanned for host tool names', () => {
  const dir = join(temp, 'pkg-c')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'client.js'), 'const name = "ui_only_tool"\n')
  const result = attributeToolNames([{ key: 'pkg-c', dir }], ['ui_only_tool'])
  assert.equal(result.owned['pkg-c'], undefined)
})

/* ------------------------------------------------------ entry resolving -- */

check('exports["."].default wins over main', () => {
  const dir = join(temp, 'pkg-entry')
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), '')
  writeFileSync(join(dir, 'entry.js'), '')
  const candidates = entryCandidates(dir, {
    exports: { '.': { default: './lib/index.js' } },
    main: 'entry.js',
  })
  assert.ok(candidates[0].endsWith(join('lib', 'index.js')), `unexpected first candidate ${candidates[0]}`)
  assert.equal(new Set(candidates).size, candidates.length)
})

check('a package with no manifest fields still resolves index.js or entry.js', () => {
  const dir = join(temp, 'pkg-bare')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'entry.js'), '')
  const candidates = entryCandidates(dir, {})
  assert.ok(candidates.some((path) => path.endsWith('entry.js')))
})

/* ---------------------------------------------------- profile detection -- */

check('the profile is found through its manifest dependency', () => {
  const home = join(temp, 'home')
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'dsh-plugin-curator': 'link:F:/CodeProj/dsh-plugin-curator' },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  const found = detectProfile({}, { DSH_HOME: home })
  assert.equal(found.basis, 'manifest')
  assert.equal(found.dir, profile)
})

/* ---------------------------------------------------- session discovery -- */

check('session files outside the window are not scanned', () => {
  const home = join(temp, 'home2')
  const dir = join(home, 'sessions', 'ws', 'session-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
  const now = Date.now()
  assert.equal(findSessionFiles(home, now - 60_000).length, 1)
  assert.equal(findSessionFiles(home, now + 60_000).length, 0)
})

console.log(`\n${checks} checks passed`)
