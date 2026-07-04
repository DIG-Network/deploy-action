// Tests for the tiny Octokit-shaped GitHub REST client (src/rest.mjs). The
// client wraps Node 20's global `fetch`, so it is exercised against a LOCAL echo
// HTTP server (no real GitHub, no network) that records the method/path/headers/
// body it receives and returns canned responses — the same technique the smoke
// workflow uses for the OIDC exchange. This closes the gap where every other
// suite mocks the REST client and never runs the real fetch-backed one.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { makeRest } from "../src/rest.mjs";

/** A local HTTP server that records requests and replies with a scripted body/status. */
function startEchoServer() {
  const requests = [];
  let next = { status: 200, body: { ok: true } };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body || undefined,
      });
      res.statusCode = next.status;
      res.setHeader("content-type", "application/json");
      res.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        requests,
        base: `http://127.0.0.1:${port}`,
        reply(status, body) {
          next = { status, body };
        },
      });
    });
  });
}

let echo;
let prevApiUrl;

before(async () => {
  echo = await startEchoServer();
  prevApiUrl = process.env.GITHUB_API_URL;
  // makeRest() reads GITHUB_API_URL lazily (per call), so pointing it at the echo
  // server here redirects every subsequent call — no dynamic re-import needed.
  process.env.GITHUB_API_URL = echo.base;
});

after(() => {
  echo.server.close();
  if (prevApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevApiUrl;
});

function freshRest(token) {
  return makeRest(token);
}

test("makeRest is the module's exported factory", () => {
  assert.equal(typeof makeRest, "function");
});

test("listComments issues a GET with auth + version headers and returns { data }", async () => {
  const { rest } = await freshRest("tok-123");
  echo.reply(200, [{ id: 1, body: "hi" }]);
  const out = await rest.issues.listComments({
    owner: "DIG-Network",
    repo: "example",
    issue_number: 7,
    per_page: 100,
  });
  assert.deepEqual(out.data, [{ id: 1, body: "hi" }]);
  const req = echo.requests.at(-1);
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/repos/DIG-Network/example/issues/7/comments?per_page=100");
  assert.equal(req.headers.authorization, "Bearer tok-123");
  assert.equal(req.headers["x-github-api-version"], "2022-11-28");
  assert.equal(req.headers.accept, "application/vnd.github+json");
});

test("createComment POSTs the body as JSON", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(201, { id: 42 });
  const out = await rest.issues.createComment({
    owner: "o",
    repo: "r",
    issue_number: 3,
    body: "hello world",
  });
  assert.equal(out.data.id, 42);
  const req = echo.requests.at(-1);
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/repos/o/r/issues/3/comments");
  assert.deepEqual(JSON.parse(req.body), { body: "hello world" });
});

test("updateComment PATCHes the comment by id", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(200, { id: 55 });
  await rest.issues.updateComment({ owner: "o", repo: "r", comment_id: 55, body: "edited" });
  const req = echo.requests.at(-1);
  assert.equal(req.method, "PATCH");
  assert.equal(req.url, "/repos/o/r/issues/comments/55");
  assert.deepEqual(JSON.parse(req.body), { body: "edited" });
});

test("createDeployment POSTs the deployment fields (owner/repo stripped from body)", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(201, { id: 4242 });
  const out = await rest.repos.createDeployment({
    owner: "o",
    repo: "r",
    ref: "deadbeef",
    environment: "production",
    auto_merge: false,
    required_contexts: [],
    transient_environment: false,
    description: "Published",
  });
  assert.equal(out.data.id, 4242);
  const req = echo.requests.at(-1);
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/repos/o/r/deployments");
  const sent = JSON.parse(req.body);
  assert.equal(sent.ref, "deadbeef");
  assert.equal(sent.environment, "production");
  assert.equal(sent.owner, undefined, "owner is a path param, not a body field");
  assert.equal(sent.repo, undefined, "repo is a path param, not a body field");
});

test("createDeploymentStatus POSTs under the deployment id", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(201, { id: 1 });
  await rest.repos.createDeploymentStatus({
    owner: "o",
    repo: "r",
    deployment_id: 4242,
    state: "success",
    environment: "production",
  });
  const req = echo.requests.at(-1);
  assert.equal(req.url, "/repos/o/r/deployments/4242/statuses");
  const sent = JSON.parse(req.body);
  assert.equal(sent.state, "success");
  assert.equal(sent.deployment_id, undefined, "deployment_id is a path param");
});

test("listDeployments GETs filtered by environment", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(200, [{ id: 1, ref: "abc", payload: { pr: 7 } }]);
  const out = await rest.repos.listDeployments({ owner: "o", repo: "r", environment: "preview" });
  assert.deepEqual(out.data, [{ id: 1, ref: "abc", payload: { pr: 7 } }]);
  const req = echo.requests.at(-1);
  assert.equal(req.method, "GET");
  assert.equal(req.url, "/repos/o/r/deployments?environment=preview&per_page=100");
});

test("listDeployments omits the environment filter when none is given", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(200, []);
  await rest.repos.listDeployments({ owner: "o", repo: "r" });
  const req = echo.requests.at(-1);
  assert.equal(req.url, "/repos/o/r/deployments?per_page=100");
});

test("createCommitStatus POSTs under the sha", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(201, { id: 1 });
  await rest.repos.createCommitStatus({
    owner: "o",
    repo: "r",
    sha: "abc123",
    state: "failure",
    context: "DIG deploy",
    description: "Deploy failed",
  });
  const req = echo.requests.at(-1);
  assert.equal(req.url, "/repos/o/r/statuses/abc123");
  const sent = JSON.parse(req.body);
  assert.equal(sent.state, "failure");
  assert.equal(sent.context, "DIG deploy");
  assert.equal(sent.sha, undefined, "sha is a path param");
});

test("a non-2xx response throws an Error carrying the GitHub message and status", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(422, { message: "Validation Failed" });
  await assert.rejects(
    () => rest.issues.createComment({ owner: "o", repo: "r", issue_number: 1, body: "x" }),
    (err) => {
      assert.match(err.message, /Validation Failed/);
      assert.equal(err.status, 422);
      return true;
    },
  );
});

test("a non-2xx response with no JSON message falls back to status text", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(500, "upstream exploded"); // non-JSON body → data becomes the raw text
  await assert.rejects(
    () => rest.repos.createCommitStatus({ owner: "o", repo: "r", sha: "s", state: "success" }),
    (err) => {
      assert.equal(err.status, 500);
      // No {message} field → the client uses `${status} ${statusText}`.
      assert.match(err.message, /500/);
      return true;
    },
  );
});

test("an empty 2xx body yields data: undefined (no JSON parse throw)", async () => {
  const { rest } = await freshRest("tok");
  echo.reply(204, ""); // No Content
  const out = await rest.repos.createDeploymentStatus({
    owner: "o",
    repo: "r",
    deployment_id: 1,
    state: "success",
  });
  assert.equal(out.data, undefined);
});
