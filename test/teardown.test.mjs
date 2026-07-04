// Integration test for the PR-close teardown entrypoint (src/teardown.mjs): run
// as a subprocess (like test/report.test.mjs does for report.mjs) against a
// LOCAL echo GitHub API, so the real REST client (src/rest.mjs) runs end to end.
//
// Teardown never runs digstore and never touches the chain — it only lists +
// deactivates GitHub Deployments and updates the PR comment. It must ALWAYS
// exit 0 (best-effort cleanup on an already-closing PR is never a red check).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "..", "src", "teardown.mjs");

function runEntry(env) {
  return new Promise((resolve, reject) => {
    const child = execFile("node", [ENTRY], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number" && err.killed) {
        return reject(new Error(`entry timed out: ${err.message}`));
      }
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
    child.on("error", reject);
  });
}

function eventFileWithPr(dir, number = 77) {
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, JSON.stringify({ action: "closed", pull_request: { number } }));
  return eventFile;
}

/** A local stand-in for api.github.com. `onRequest` may inspect/reply per call. */
function startGitHubApi({ deployments = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: body || undefined });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url.startsWith("/repos/") && req.url.includes("/deployments?")) {
        return res.end(JSON.stringify(deployments));
      }
      if (req.method === "GET") return res.end("[]"); // comment listing → empty, so it CREATEs
      res.end(JSON.stringify({ id: 4242 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("teardown exits 0 and does nothing when there is no PR context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dig-teardown-"));
  const env = {
    ...process.env,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    GITHUB_TOKEN: "",
    GITHUB_EVENT_PATH: "",
    GITHUB_REPOSITORY: "DIG-Network/example",
  };
  writeFileSync(env.GITHUB_STEP_SUMMARY, "");
  const { code, stdout } = await runEntry(env);
  assert.equal(code, 0);
  assert.match(stdout, /nothing to tear down/i);
});

test("teardown deactivates the PR's preview deployments and updates the comment", async () => {
  const api = await startGitHubApi({
    deployments: [
      { id: 1, payload: { pr: 77 } },
      { id: 2, payload: { pr: 999 } }, // a different PR — must be left alone
    ],
  });
  try {
    const dir = mkdtempSync(join(tmpdir(), "dig-teardown-pr-"));
    const eventFile = eventFileWithPr(dir, 77);
    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "");
    const env = {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "DIG-Network/example",
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_API_URL: api.base,
      DIG_COMMENT_ON_PR: "true",
    };
    const { code, stdout } = await runEntry(env);
    assert.equal(code, 0);
    assert.match(stdout, /deactivated 1 deployment/i);

    const paths = api.requests.map((r) => `${r.method} ${r.url}`);
    assert.ok(
      paths.some((p) => p.startsWith("GET /repos/DIG-Network/example/deployments?")),
      "listed the repo's deployments",
    );
    assert.ok(
      paths.some((p) => p === "POST /repos/DIG-Network/example/deployments/1/statuses"),
      "deactivated deployment 1 (belongs to PR 77)",
    );
    assert.ok(
      !paths.some((p) => p === "POST /repos/DIG-Network/example/deployments/2/statuses"),
      "left deployment 2 alone (a different PR)",
    );
    const status1 = api.requests.find((r) => r.url === "/repos/DIG-Network/example/deployments/1/statuses");
    assert.equal(JSON.parse(status1.body).state, "inactive");

    assert.ok(
      paths.some((p) => p === "POST /repos/DIG-Network/example/issues/77/comments"),
      "posted the teardown comment",
    );
    const comment = api.requests.find((r) => r.url === "/repos/DIG-Network/example/issues/77/comments");
    assert.match(JSON.parse(comment.body).body, /closed/i);

    const summary = readFileSync(summaryFile, "utf8");
    assert.match(summary, /torn down/i);
  } finally {
    api.server.close();
  }
});

test("teardown skips the PR comment when comment-on-pr is disabled", async () => {
  const api = await startGitHubApi({ deployments: [{ id: 1, payload: { pr: 77 } }] });
  try {
    const dir = mkdtempSync(join(tmpdir(), "dig-teardown-nocomment-"));
    const eventFile = eventFileWithPr(dir, 77);
    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "");
    const env = {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "DIG-Network/example",
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_API_URL: api.base,
      DIG_COMMENT_ON_PR: "false",
    };
    const { code } = await runEntry(env);
    assert.equal(code, 0);
    const paths = api.requests.map((r) => `${r.method} ${r.url}`);
    assert.ok(!paths.some((p) => p.includes("/comments")), "no comment call when disabled");
  } finally {
    api.server.close();
  }
});

test("teardown is best-effort: exits 0 even when the GitHub API errors", async () => {
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
    const dir = mkdtempSync(join(tmpdir(), "dig-teardown-err-"));
    const eventFile = eventFileWithPr(dir, 77);
    const summaryFile = join(dir, "summary.md");
    writeFileSync(summaryFile, "");
    const env = {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_TOKEN: "test-token",
      GITHUB_REPOSITORY: "DIG-Network/example",
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      DIG_COMMENT_ON_PR: "true",
    };
    const { code } = await runEntry(env);
    assert.equal(code, 0, "teardown must never fail the workflow over cleanup cosmetics");
  } finally {
    server.close();
  }
});
