// bench-probe.mjs — one isolated cold-load measurement.
//
// The Host half spawns this file once per plugin with `ELECTRON_RUN_AS_NODE=1`,
// passing the absolute path of the plugin's host entry. It measures how long a
// fresh process needs to import that entry and prints one JSON line.
//
// Scope, stated plainly: this measures MODULE EVALUATION — parse plus the
// top-level work of the entry and everything it imports. It does NOT run the
// plugin's `apply()`, so a plugin whose cost lives in apply is under-reported
// here and shows up in the whole-process boot total instead. Nothing else in
// the process is measured, so the number is comparable across plugins.
//
// The child is a real process with the same Node/Electron runtime as the Host,
// a 20 s ceiling enforced by the parent, and it exits immediately after the
// import. A failure to import is reported as `error`, never as a duration.

const url = process.argv[2]
const started = performance.now()

try {
  await import(url)
  process.stdout.write(JSON.stringify({ ms: performance.now() - started }) + '\n')
  process.exit(0)
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stdout.write(JSON.stringify({ error: message }) + '\n')
  process.exit(0)
}
