// Tests for the GitHub API side effects: upsert a single PR comment, create a
// GitHub deployment + deployment status, and set a commit status (#24 — red X
// on a failed/timed-out anchor). The GitHub client is mocked; no network.

import { test } from "node:test";
import assert from "node:assert/strict";

import { upsertComment, reportDeployment, statusState, deactivateDeployments } from "../src/github.mjs";
import { COMMENT_MARKER } from "../src/comment.mjs";

// Minimal mock of the subset of the GitHub REST client we use, recording calls.
function mockGitHub({ existingComments = [], deploymentsList = [] } = {}) {
  const calls = {
    created: [],
    updated: [],
    listed: 0,
    deployments: [],
    deploymentStatuses: [],
    statuses: [],
    listedDeployments: 0,
  };
  return {
    calls,
    rest: {
      issues: {
        listComments: async () => {
          calls.listed += 1;
          return { data: existingComments };
        },
        createComment: async (args) => {
          calls.created.push(args);
          return { data: { id: 999 } };
        },
        updateComment: async (args) => {
          calls.updated.push(args);
          return { data: { id: args.comment_id } };
        },
      },
      repos: {
        listDeployments: async (args) => {
          calls.listedDeployments += 1;
          calls.listDeploymentsArgs = args;
          return { data: deploymentsList };
        },
        createDeployment: async (args) => {
          calls.deployments.push(args);
          return { data: { id: 4242 } };
        },
        createDeploymentStatus: async (args) => {
          calls.deploymentStatuses.push(args);
          return { data: { id: 1 } };
        },
        createCommitStatus: async (args) => {
          calls.statuses.push(args);
          return { data: { id: 1 } };
        },
      },
    },
  };
}

const REPO = { owner: "DIG-Network", repo: "example-site" };

test("upsertComment creates a new comment when none exists", async () => {
  const gh = mockGitHub();
  await upsertComment(gh.rest, { ...REPO, issue_number: 7, body: "hello" });
  assert.equal(gh.calls.created.length, 1);
  assert.equal(gh.calls.updated.length, 0);
  assert.equal(gh.calls.created[0].issue_number, 7);
  assert.equal(gh.calls.created[0].body, "hello");
});

test("upsertComment updates the existing marked comment instead of adding a second", async () => {
  const gh = mockGitHub({
    existingComments: [
      { id: 1, body: "unrelated chatter" },
      { id: 55, body: `prior deploy report\n${COMMENT_MARKER}` },
    ],
  });
  await upsertComment(gh.rest, { ...REPO, issue_number: 7, body: `new\n${COMMENT_MARKER}` });
  assert.equal(gh.calls.created.length, 0, "must not create a duplicate");
  assert.equal(gh.calls.updated.length, 1);
  assert.equal(gh.calls.updated[0].comment_id, 55);
});

test("statusState maps a parsed result to a commit-status state", () => {
  // success → success; failed push or timeout → failure; skipped → success.
  assert.equal(statusState({ skipped: true, spent: false }), "success");
  assert.equal(statusState({ pushed: true, spent: true }), "success");
  assert.equal(statusState({ pushed: false, pushError: "x", spent: true }), "failure");
  assert.equal(statusState({ timedOut: true }), "failure");
});

test("reportDeployment creates a deployment, a status, and a commit status (success)", async () => {
  const gh = mockGitHub();
  const result = {
    capsule: "a:b",
    pushed: true,
    spent: true,
    hubUrl: "https://hub.dig.net/stores/a",
  };
  await reportDeployment(gh.rest, {
    ...REPO,
    sha: "deadbeef",
    environment: "production",
    result,
  });
  assert.equal(gh.calls.deployments.length, 1);
  assert.equal(gh.calls.deployments[0].ref, "deadbeef");
  assert.equal(gh.calls.deployments[0].environment, "production");
  assert.equal(gh.calls.deploymentStatuses.length, 1);
  assert.equal(gh.calls.deploymentStatuses[0].state, "success");
  assert.equal(
    gh.calls.deploymentStatuses[0].environment_url,
    "https://hub.dig.net/stores/a",
  );
  assert.equal(gh.calls.statuses.length, 1);
  assert.equal(gh.calls.statuses[0].state, "success");
  assert.equal(gh.calls.statuses[0].sha, "deadbeef");
});

test("reportDeployment sets a failure commit status (red X) on a failed anchor", async () => {
  const gh = mockGitHub();
  const result = { capsule: "a:b", pushed: false, pushError: "remote rejected", spent: true };
  await reportDeployment(gh.rest, {
    ...REPO,
    sha: "deadbeef",
    environment: "production",
    result,
  });
  assert.equal(gh.calls.statuses[0].state, "failure");
  assert.equal(gh.calls.deploymentStatuses[0].state, "failure");
});

test("reportDeployment stamps the PR number into the deployment payload when given", async () => {
  const gh = mockGitHub();
  await reportDeployment(gh.rest, {
    ...REPO,
    sha: "deadbeef",
    environment: "preview",
    result: { preview: true, spent: false },
    prNumber: 7,
  });
  assert.deepEqual(gh.calls.deployments[0].payload, { pr: 7 });
});

test("reportDeployment omits the payload when no PR number is given", async () => {
  const gh = mockGitHub();
  await reportDeployment(gh.rest, {
    ...REPO,
    sha: "deadbeef",
    environment: "production",
    result: { pushed: true, spent: true },
  });
  assert.equal(gh.calls.deployments[0].payload, undefined);
});

// ---------------------------------------------------------------------------
// deactivateDeployments: on a PR close, mark that PR's preview deployment(s)
// `inactive` — nothing about a closed PR's preview is worth keeping active.
// Deployments are associated with a PR via `payload.pr` (stamped by
// reportDeployment above), NOT `ref`, because a PR's head sha changes on every
// push — a ref-based filter would miss every commit but the last.
// ---------------------------------------------------------------------------

test("deactivateDeployments marks every deployment whose payload.pr matches, inactive", async () => {
  const gh = mockGitHub({
    deploymentsList: [
      { id: 1, payload: { pr: 7 } },
      { id: 2, payload: { pr: 9 } }, // a different PR — must be left alone
      { id: 3, payload: { pr: 7 } },
    ],
  });
  const count = await deactivateDeployments(gh.rest, {
    ...REPO,
    environment: "preview",
    prNumber: 7,
  });
  assert.equal(count, 2);
  assert.equal(gh.calls.listedDeployments, 1);
  assert.equal(gh.calls.listDeploymentsArgs.environment, "preview");
  const ids = gh.calls.deploymentStatuses.map((s) => s.deployment_id).sort();
  assert.deepEqual(ids, [1, 3]);
  for (const s of gh.calls.deploymentStatuses) assert.equal(s.state, "inactive");
});

test("deactivateDeployments tolerates a stringified JSON payload", async () => {
  const gh = mockGitHub({
    deploymentsList: [{ id: 5, payload: JSON.stringify({ pr: 3 }) }],
  });
  const count = await deactivateDeployments(gh.rest, { ...REPO, environment: "preview", prNumber: 3 });
  assert.equal(count, 1);
});

test("deactivateDeployments returns 0 when nothing matches the PR", async () => {
  const gh = mockGitHub({ deploymentsList: [{ id: 1, payload: { pr: 9 } }] });
  const count = await deactivateDeployments(gh.rest, { ...REPO, environment: "preview", prNumber: 7 });
  assert.equal(count, 0);
  assert.equal(gh.calls.deploymentStatuses.length, 0);
});

test("deactivateDeployments is best-effort: one failing status doesn't stop the rest", async () => {
  const gh = mockGitHub({
    deploymentsList: [
      { id: 1, payload: { pr: 7 } },
      { id: 2, payload: { pr: 7 } },
    ],
  });
  gh.rest.repos.createDeploymentStatus = async (args) => {
    if (args.deployment_id === 1) throw new Error("boom");
    return { data: { id: 1 } };
  };
  const count = await deactivateDeployments(gh.rest, { ...REPO, environment: "preview", prNumber: 7 });
  assert.equal(count, 1, "the failing deployment is skipped, the rest still get deactivated");
});

test("deactivateDeployments returns 0 when listing deployments itself fails", async () => {
  const gh = mockGitHub();
  gh.rest.repos.listDeployments = async () => {
    throw new Error("network error");
  };
  const count = await deactivateDeployments(gh.rest, { ...REPO, environment: "preview", prNumber: 7 });
  assert.equal(count, 0);
});
