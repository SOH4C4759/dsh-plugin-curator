// Real-data check of tool → package attribution.
//
// Reads the profile's actual installed packages, takes the tool names the
// activity scan observed, and shows what `attributeToolNames()` makes of them —
// so "which plugin owns `agent_teams_status`" is answered by the same code the
// panel uses, on the same files, not by a fixture.
//
//   node tools/scan-attribution.mjs [packageName ...]
//
// Prints the owned map and the ambiguous names. Exit 0 on success.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { attributeToolNames, scanToolCalls } from '../entry.js'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profiles = join(home, 'profiles')
const profileDir = join(profiles, readdirSync(profiles)[0] ?? 'desktop')
const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const deps = { ...manifest.dependencies, ...manifest.devDependencies }
const require = createRequire(join(profileDir, 'package.json'))

const activity = await scanToolCalls({ home, windowDays: 14 })
const names = Object.keys(activity.tools)

const wanted = process.argv.slice(2)
const targets = wanted.length > 0 ? wanted : Object.keys(deps)
const dirs = []
for (const name of targets) {
  const spec = deps[name]
  let dir = null
  if (typeof spec === 'string' && spec.startsWith('link:')) {
    const candidate = spec.slice('link:'.length)
    if (existsSync(candidate)) dir = candidate
  }
  if (dir === null) {
    try {
      dir = dirname(require.resolve(`${name}/package.json`))
    } catch {
      dir = null
    }
  }
  if (dir !== null && existsSync(join(dir, 'package.json'))) dirs.push({ key: name, dir })
}

console.log(`profile   ${profileDir}`)
console.log(`packages  ${String(dirs.length)} scanned of ${String(targets.length)} named`)
console.log(`observed  ${String(names.length)} distinct tool names over 14 days`)
console.log('')

const started = Date.now()
const result = attributeToolNames(dirs, names)
console.log(`attribution took ${String(Date.now() - started)} ms`)
const owned = Object.entries(result.owned).sort((a, b) => b[1].length - a[1].length)
for (const [pkg, tools] of owned) {
  console.log(`\n${pkg}  (${String(tools.length)})`)
  for (const tool of tools.slice(0, 12)) {
    const fact = activity.tools[tool]
    console.log(`   ${String(fact.calls).padStart(5)} calls  ${tool}`)
  }
  if (tools.length > 12) console.log(`   … ${String(tools.length - 12)} more`)
}
const ambiguous = Object.entries(result.ambiguous)
if (ambiguous.length > 0) {
  console.log('\nambiguous (found in more than one package, attributed to none):')
  for (const [tool, packages] of ambiguous) console.log(`   ${tool} → ${packages.join(', ')}`)
}
const unattributed = names.filter((name) => !name.startsWith('mcp__') && !Object.values(result.owned).some((tools) => tools.includes(name)))
console.log(`\nunattributed: ${String(unattributed.length)} (built-in DSH tools or names not present as literals)`)
