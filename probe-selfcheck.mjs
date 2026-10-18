// probe-selfcheck.mjs — the smallest importable module in this package.
//
// `pickNode()` runs the cold-load probe against THIS file before trusting an
// executable: a launcher that exists but cannot run must be skipped, not turned
// into a bench full of failures. Importing this file proves the probe can start,
// parse and print — nothing else is measured, and nothing else is touched.
export const ok = true
