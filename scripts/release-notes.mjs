// Extract one version's section from CHANGELOG.md, for the GitHub Release body.
//
// The release workflow pipes this to `release-body.md`; the section shape is the
// only contract: `## v<version>` heading, everything until the next `## `.
//
//   node scripts/release-notes.mjs [version]
//
// Exits 1 when the section is missing, because a release with an empty body is
// exactly what the release播报 degenerates into.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = process.argv[2] ?? manifest.version
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

const lines = changelog.split('\n')
const start = lines.findIndex((line) => line.startsWith(`## v${version}`))
if (start < 0) {
  console.error(`release-notes: no "## v${version}" section in CHANGELOG.md`)
  process.exit(1)
}
const body = []
for (const line of lines.slice(start + 1)) {
  if (line.startsWith('## ')) break
  body.push(line)
}
const text = body.join('\n').trim()
if (text === '') {
  console.error(`release-notes: the "## v${version}" section is empty`)
  process.exit(1)
}
process.stdout.write(`${text}\n`)
