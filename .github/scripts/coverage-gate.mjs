#!/usr/bin/env node
// Dependency-free coverage gate for the `src/` logic (CI-gated at >= 80% lines,
// per the ecosystem coverage rule). Node 20's `node --test --experimental-test-
// coverage` prints an ASCII summary table but has NO built-in fail-under flag
// (that landed in Node 22 as --test-coverage-lines). So we run the suite with
// coverage, parse the "all files" row, and exit non-zero when the line % is below
// the threshold — keeping the action's zero-npm-dependency design (no c8/nyc).
//
// It also enforces per-file floors on the shipped runtime modules so a single
// well-covered file cannot mask a wholly-untested one.
//
// Usage: node .github/scripts/coverage-gate.mjs [threshold]     (default 80)

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const THRESHOLD = Number(process.argv[2] ?? 80);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Run the full suite with coverage. The coverage table is printed to stdout.
const res = spawnSync(
  process.execPath,
  ["--test", "--experimental-test-coverage", "--test-reporter=tap"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const out = `${res.stdout || ""}\n${res.stderr || ""}`;

// The tests themselves must pass first — a coverage number from a red suite is meaningless.
if (res.status !== 0) {
  process.stdout.write(out);
  console.error(`\ncoverage-gate: the test suite failed (exit ${res.status}); not evaluating coverage.`);
  process.exit(res.status || 1);
}

// Parse the coverage table rows: "# <path> | <line%> | <branch%> | <funcs%> | <uncovered>".
// We look at the shipped runtime files under src/ plus the "all files" summary.
const rows = [];
for (const line of out.split(/\r?\n/)) {
  const m = line.match(
    /^#\s+(.+?)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/,
  );
  if (!m) continue;
  const file = m[1].trim();
  rows.push({ file, line: Number(m[2]), branch: Number(m[3]), funcs: Number(m[4]) });
}

if (rows.length === 0) {
  console.error("coverage-gate: could not find a coverage table — did --experimental-test-coverage run?");
  process.stdout.write(out);
  process.exit(1);
}

const all = rows.find((r) => /^all files$/i.test(r.file));
// Shipped runtime modules (exclude the tests themselves and any tooling).
const srcRows = rows.filter((r) => /(^|[\\/])src[\\/].+\.mjs$/.test(r.file));

let ok = true;
const report = [];

if (!all) {
  console.error("coverage-gate: no 'all files' summary row found.");
  ok = false;
} else {
  report.push(`overall lines: ${all.line.toFixed(2)}% (threshold ${THRESHOLD}%)`);
  if (all.line < THRESHOLD) ok = false;
}

// Per-file floor: every shipped module must itself clear the threshold, so a
// fully-untested file can't hide behind well-covered siblings.
for (const r of srcRows) {
  const pass = r.line >= THRESHOLD;
  if (!pass) ok = false;
  report.push(`  ${pass ? "PASS" : "FAIL"} ${r.file}: ${r.line.toFixed(2)}% lines`);
}

// Surface the full coverage table for the CI log.
process.stdout.write(out);
console.log("\ncoverage-gate ---------------------------------------------------------------");
for (const line of report) console.log(line);

if (!ok) {
  console.error(`\ncoverage-gate: FAILED — line coverage below ${THRESHOLD}%.`);
  process.exit(1);
}
console.log(`\ncoverage-gate: OK — all shipped src/ modules and the overall total are >= ${THRESHOLD}% lines.`);
