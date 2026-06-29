#!/usr/bin/env node
// Dependency-free structural check that action.yml's declared `outputs:` exactly
// match the keys src/parse.mjs's toOutputs() produces — so the action contract
// can't silently drift from the implementation. Runs in CI (node 20, no deps).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toOutputs } from "../../src/parse.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const actionYml = readFileSync(join(root, "action.yml"), "utf8");

// Extract the keys declared under the top-level `outputs:` block. We slice from
// `outputs:` to the next top-level key (`runs:`) and grab the 2-space-indented
// map keys — no YAML parser needed for this narrow, well-formed file.
const start = actionYml.indexOf("\noutputs:");
const end = actionYml.indexOf("\nruns:");
if (start < 0 || end < 0 || end < start) {
  console.error("check-action: could not locate the outputs: / runs: blocks");
  process.exit(1);
}
const block = actionYml.slice(start, end);
const declared = new Set(
  [...block.matchAll(/^ {2}([a-z0-9-]+):/gm)].map((m) => m[1]),
);

// The keys the implementation actually emits (values are irrelevant here).
const emitted = new Set(Object.keys(toOutputs({})));

// Outputs that are declared in action.yml but sourced from the MODE step (src/mode.mjs), not from
// parse.mjs's toOutputs(). They are legitimately declared without being emitted by toOutputs().
const MODE_SOURCED = new Set(["environment"]);

const missingInYml = [...emitted].filter((k) => !declared.has(k));
const missingInImpl = [...declared].filter((k) => !emitted.has(k) && !MODE_SOURCED.has(k));

let ok = true;
if (missingInYml.length) {
  console.error(`outputs emitted by toOutputs() but not declared in action.yml: ${missingInYml.join(", ")}`);
  ok = false;
}
if (missingInImpl.length) {
  console.error(`outputs declared in action.yml but never emitted: ${missingInImpl.join(", ")}`);
  ok = false;
}
if (!ok) process.exit(1);
console.log(`check-action: ${declared.size} outputs match between action.yml and src/parse.mjs`);
