// Integration test for the action entrypoint (src/report.mjs): runs it as a
// subprocess with a captured deploy JSON file and a fake $GITHUB_OUTPUT /
// $GITHUB_STEP_SUMMARY, and asserts it writes the right outputs and exit code.
// PR reporting is suppressed here (no GITHUB_TOKEN / no event), exercising the
// "outputs + summary only" path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

// Async spawn: the PR-reporting tests below run a LOCAL HTTP server in THIS
// process, so the entrypoint must be spawned WITHOUT blocking this event loop —
// a synchronous execFileSync would deadlock (the child's fetch waits on a server
// this process can't service while blocked). Resolves with { code, stdout, stderr }.
function runEntry(args, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "node",
      [ENTRY, ...args],
      { env, timeout: 30_000 },
      (err, stdout, stderr) => {
        // A nonzero exit is reported via err.code, not a reject — we assert on it.
        if (err && typeof err.code !== "number" && err.killed) {
          return reject(new Error(`entry timed out: ${err.message}`));
        }
        resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
      },
    );
    child.on("error", reject);
  });
}

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
  assert.match(outputs, /chia-url<</);
  assert.match(outputs, /dig-url<</);
  // Both chia-url and the deprecated dig-url alias carry the chia:// content-open value.
  assert.match(outputs, new RegExp(`chia://${STORE}/`));
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

test("report writes the aggregated json + outcome outputs on success", () => {
  const json = [
    JSON.stringify({ root: ROOT, capsule: `${STORE}:${ROOT}`, coin_id: COIN, pushed: true }),
    JSON.stringify({ hub_url: `https://hub.dig.net/stores/${STORE}` }),
  ].join("\n");
  const { outputs } = run(json);
  assert.match(outputs, /outcome<<[\s\S]*\nsuccess\n/);
  assert.match(outputs, /json<</, "aggregated json output written");
});

// A pre-deploy failure (no JSON): report still writes a catalogued outcome + reason from the
// DIG_PRIOR_* hints and exits 1, so an agent learns the CAUSE from outputs (not log scraping).
function runFailure({ priorOutcome, priorReason } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dig-report-fail-"));
  const outFile = join(dir, "out.txt");
  const sumFile = join(dir, "summary.md");
  writeFileSync(outFile, "");
  writeFileSync(sumFile, "");
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outFile,
    GITHUB_STEP_SUMMARY: sumFile,
    DIG_COMMENT_ON_PR: "false",
    GITHUB_TOKEN: "",
    GITHUB_EVENT_PATH: "",
    GITHUB_REPOSITORY: "DIG-Network/example",
    ...(priorOutcome ? { DIG_PRIOR_OUTCOME: priorOutcome } : {}),
    ...(priorReason ? { DIG_PRIOR_REASON: priorReason } : {}),
  };
  let failed = false;
  try {
    // Pass an empty file path arg → readInput returns "" → the pre-deploy failure path.
    execFileSync("node", [ENTRY, ""], { env, stdio: "pipe", input: "" });
  } catch {
    failed = true;
  }
  return { failed, outputs: readFileSync(outFile, "utf8") };
}

test("report emits a catalogued failure outcome when there is no deploy JSON", () => {
  const { failed, outputs } = runFailure({
    priorOutcome: "blocked-paid-preview",
    priorReason: "preview: true would publish a real capsule",
  });
  assert.equal(failed, true, "a pre-deploy failure exits nonzero");
  assert.match(outputs, /outcome<<[\s\S]*\nblocked-paid-preview\n/);
  assert.match(outputs, /failure-reason<</);
});

test("report falls back to the `failed` outcome for an unrecognized prior hint", () => {
  const { failed, outputs } = runFailure({ priorOutcome: "not-a-real-outcome" });
  assert.equal(failed, true);
  assert.match(outputs, /outcome<<[\s\S]*\nfailed\n/);
});

// ---------------------------------------------------------------------------
// The PR-reporting path: with a GITHUB_TOKEN, an event payload carrying a PR
// number, and a GITHUB_REPOSITORY, report.mjs upserts a PR comment and creates a
// GitHub deployment + deployment status + commit status. We drive it against a
// LOCAL echo GitHub API (GITHUB_API_URL) so the real REST client (src/rest.mjs)
// runs end to end — no network, no real GitHub. This covers the branch every
// other unit skips by leaving the token/PR unset.
// ---------------------------------------------------------------------------

/** A local stand-in for api.github.com that records the calls report.mjs makes. */
function startGitHubApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body || undefined });
      res.setHeader("content-type", "application/json");
      // GET the comment list → empty (so the action CREATES a comment);
      // every POST/PATCH → a minimal object with an id.
      if (req.method === "GET") {
        res.end("[]");
      } else {
        res.end(JSON.stringify({ id: 4242 }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function runWithPr(json, { environment = "production", preview = "false" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dig-report-pr-"));
  const jsonFile = join(dir, "deploy.json");
  const outFile = join(dir, "out.txt");
  const sumFile = join(dir, "summary.md");
  const eventFile = join(dir, "event.json");
  writeFileSync(jsonFile, json);
  writeFileSync(outFile, "");
  writeFileSync(sumFile, "");
  // A pull_request event payload the entrypoint reads to learn the PR number.
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 77 } }));
  return { dir, jsonFile, outFile, sumFile, eventFile, environment, preview };
}

test("report upserts a PR comment + deployment + commit status against a live (local) GitHub API", async () => {
  const api = await startGitHubApi();
  try {
    const json = [
      JSON.stringify({ root: ROOT, capsule: `${STORE}:${ROOT}`, coin_id: COIN, pushed: true }),
      JSON.stringify({ hub_url: `https://hub.dig.net/stores/${STORE}` }),
    ].join("\n");
    const t = runWithPr(json);
    const env = {
      ...process.env,
      GITHUB_OUTPUT: t.outFile,
      GITHUB_STEP_SUMMARY: t.sumFile,
      GITHUB_SHA: "deadbeefcafe",
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "DIG-Network/example",
      GITHUB_EVENT_PATH: t.eventFile,
      GITHUB_API_URL: api.base,
      DIG_COMMENT_ON_PR: "true",
    };
    const { code } = await runEntry([t.jsonFile], env);
    assert.equal(code, 0, "a successful deploy exits 0");

    // The comment list was fetched, then a comment created (none existed), then a
    // deployment + deployment status + commit status were posted.
    const paths = api.requests.map((r) => `${r.method} ${r.url}`);
    assert.ok(
      paths.some((p) => p === "GET /repos/DIG-Network/example/issues/77/comments?per_page=100"),
      "listed existing PR comments",
    );
    assert.ok(
      paths.some((p) => p === "POST /repos/DIG-Network/example/issues/77/comments"),
      "created the PR comment",
    );
    assert.ok(
      paths.some((p) => p === "POST /repos/DIG-Network/example/deployments"),
      "created a GitHub deployment",
    );
    assert.ok(
      paths.some((p) => /POST \/repos\/DIG-Network\/example\/deployments\/4242\/statuses/.test(p)),
      "created a deployment status",
    );
    assert.ok(
      paths.some((p) => p === "POST /repos/DIG-Network/example/statuses/deadbeefcafe"),
      "set a commit status on the sha",
    );
    // The created comment body carries the capsule.
    const created = api.requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/comments"),
    );
    assert.match(JSON.parse(created.body).body, new RegExp(`${STORE}:${ROOT}`));
  } finally {
    api.server.close();
  }
});

test("report does not fail the deploy when PR reporting errors (best-effort)", async () => {
  // A GitHub API that 500s on every write: the deploy already succeeded, so the
  // action must still exit 0 (PR cosmetics never fail a green deploy).
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "boom" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const json = JSON.stringify({ root: ROOT, capsule: `${STORE}:${ROOT}`, pushed: true });
    const t = runWithPr(json);
    const env = {
      ...process.env,
      GITHUB_OUTPUT: t.outFile,
      GITHUB_STEP_SUMMARY: t.sumFile,
      GITHUB_SHA: "cafe",
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "DIG-Network/example",
      GITHUB_EVENT_PATH: t.eventFile,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      DIG_COMMENT_ON_PR: "true",
    };
    const { code } = await runEntry([t.jsonFile], env);
    assert.equal(code, 0, "a reporting failure must NOT fail a successful deploy");
    // Outputs were still written.
    assert.match(readFileSync(t.outFile, "utf8"), new RegExp(`${STORE}:${ROOT}`));
  } finally {
    server.close();
  }
});
