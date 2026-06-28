// Integration test for the action entrypoint (src/report.mjs): runs it as a
// subprocess with a captured deploy JSON file and a fake $GITHUB_OUTPUT /
// $GITHUB_STEP_SUMMARY, and asserts it writes the right outputs and exit code.
// PR reporting is suppressed here (no GITHUB_TOKEN / no event), exercising the
// "outputs + summary only" path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "..", "src", "report.mjs");

const STORE = "a".repeat(64);
const ROOT = "b".repeat(64);
const COIN = "c".repeat(64);

function run(json, { expectFail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dig-report-"));
  const jsonFile = join(dir, "deploy.json");
  const outFile = join(dir, "out.txt");
  const sumFile = join(dir, "summary.md");
  writeFileSync(jsonFile, json);
  writeFileSync(outFile, "");
  writeFileSync(sumFile, "");

  const env = {
    ...process.env,
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: sumFile,
    GITHUB_SHA: "deadbeefcafe",
    DIG_COMMENT_ON_PR: "false", // no PR reporting in this unit
    GITHUB_TOKEN: "",
    GITHUB_EVENT_PATH: "",
    GITHUB_REPOSITORY: "DIG-Network/example",
  };

  let failed = false;
  try {
    execFileSync("node", [ENTRY, jsonFile], { env, stdio: "pipe" });
  } catch {
    failed = true;
  }
  assert.equal(failed, expectFail, expectFail ? "expected nonzero exit" : "expected zero exit");
  return {
    outputs: readFileSync(outFile, "utf8"),
    summary: readFileSync(sumFile, "utf8"),
  };
}

test("report writes step outputs for a successful deploy and exits 0", () => {
  const json = [
    JSON.stringify({ root: ROOT, capsule: `${STORE}:${ROOT}`, coin_id: COIN, pushed: true }),
    JSON.stringify({ hub_url: `https://hub.dig.net/stores/${STORE}` }),
  ].join("\n");
  const { outputs, summary } = run(json);
  assert.match(outputs, new RegExp(`capsule<<`), "capsule output written");
  assert.match(outputs, new RegExp(`${STORE}:${ROOT}`));
  assert.match(outputs, /store-id<</);
  assert.match(outputs, /dig-url<</);
  assert.match(outputs, new RegExp(`dig://${STORE}/`));
  assert.match(outputs, /hub-url<</);
  assert.match(summary, new RegExp(`${STORE}:${ROOT}`), "summary carries the capsule");
});

test("report exits 1 when the hub push failed (red CI)", () => {
  const json = JSON.stringify({
    root: ROOT,
    capsule: `${STORE}:${ROOT}`,
    coin_id: COIN,
    pushed: false,
    push_error: "remote rejected",
  });
  const { outputs } = run(json, { expectFail: true });
  // Even on failure the outputs are still written (so a later step can read them).
  assert.match(outputs, new RegExp(`${STORE}:${ROOT}`));
});

test("report exits 0 on an --if-changed skip", () => {
  const json = JSON.stringify({
    skipped: true,
    reason: "unchanged",
    root: ROOT,
    capsule: `${STORE}:${ROOT}`,
    store_id: STORE,
    spent: false,
    pushed: false,
  });
  const { outputs } = run(json);
  assert.match(outputs, /skipped<</);
  assert.match(outputs, /spent<<[\s\S]*\nfalse\n/);
});
