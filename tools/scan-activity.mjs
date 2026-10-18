// Real-data check of the activity scanner, without a Host.
//
// Reads the profile's actual session logs through the same `scanToolCalls()` the
// panel uses, and prints what it found plus how much it covered. This is the one
// check that cannot be faked by a fixture: the frame walker either decodes real
// multi-frame logs or it does not.
//
//   node tools/scan-activity.mjs [windowDays]
//
// Exit 0 on success; prints per-tool totals and the scan coverage.

import { homedir } from 'node:os'
import { join } from 'node:path'

import { scanToolCalls } from '../entry.js'

const windowDays = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 14
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const started = Date.now()
const result = await scanToolCalls({ home, windowDays })
const entries = Object.entries(result.tools).sort((a, b) => b[1].calls - a[1].calls)

console.log(`home          ${home}`)
console.log(`window        ${String(result.windowDays)} days`)
console.log(`sessions      ${String(result.sessionCount)} with tool calls`)
console.log(`coverage      files ${String(result.coverage.filesRead)}/${String(result.coverage.files)} · frames ${String(result.coverage.frames)} · failed frames ${String(result.coverage.failedFrames)}`)
console.log(`bytes         ${(result.coverage.bytesRead / (1024 * 1024)).toFixed(1)} MB decompressed`)
console.log(`stopped early ${String(result.coverage.stoppedEarly)} (budget ${String(Date.now() - started)} ms wall)`)
console.log(`tools         ${String(entries.length)} distinct`)
console.log('')
for (const [name, fact] of entries.slice(0, 30)) {
  console.log(`${String(fact.calls).padStart(5)} calls ${String(fact.sessions).padStart(3)} sessions  ${name}`)
}
if (entries.length === 0) {
  console.log('(no tool/call events in the window — the panel would report 未观测)')
}
