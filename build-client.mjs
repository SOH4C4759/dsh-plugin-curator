// Publish lib/client.js from src/client.js.
//
// The browser half is a Cordis plugin object (`{ name, inject, apply }`) wrapped
// in the `window.__ModuleLoader__.load(...)` shell, so the build is a validated
// copy: a file that lost its shell, or that spells a different module id, is
// refused here instead of shipping a bundle the page cannot mount.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')

if (!source.includes('window.__ModuleLoader__.load({')) {
  throw new Error('build-client: src/client.js must carry its own loader shell')
}
if (!source.includes(`id: '${id}'`) && !source.includes(`id: ${JSON.stringify(id)}`)) {
  throw new Error(`build-client: src/client.js does not register the module id ${id}`)
}
if (!source.includes("inject: ['slots']")) {
  throw new Error('build-client: the plugin object must inject slots')
}

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), source)
console.log(`build-client: lib/client.js written (${String(source.length)} chars)`)
