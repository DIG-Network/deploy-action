// Tests for the event → deploy-mode decision (the PR-preview vs push-deploy fork).
//
// On a pull_request the action runs `digstore deploy --preview` (free, no chain,
// no spend) and comments the preview URL. On a push to the repo's DEFAULT branch
// it runs `digstore deploy --if-changed` (a real capsule) and sets the GitHub
// deployment status + live URL. Anything else (push to a non-default branch,
// other events) defaults to a safe no-op preview unless explicitly forced.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideMode } from "../src/event.mjs";

test("pull_request → preview (free, no spend)", () => {
  const m = decideMode({ eventName: "pull_request", ref: "refs/heads/feature", defaultBranch: "main" });
  assert.equal(m.preview, true);
  assert.equal(m.environment, "preview");
});

test("push to the default branch → production deploy (if-changed)", () => {
  const m = decideMode({ eventName: "push", ref: "refs/heads/main", defaultBranch: "main" });
  assert.equal(m.preview, false);
  assert.equal(m.environment, "production");
});

test("push to a non-default branch → preview (never a surprise production spend)", () => {
  const m = decideMode({ eventName: "push", ref: "refs/heads/dev", defaultBranch: "main" });
  assert.equal(m.preview, true, "only the default branch deploys for real");
  assert.equal(m.environment, "preview");
});

test("an explicit preview input forces preview even on a default-branch push", () => {
  const m = decideMode({
    eventName: "push",
    ref: "refs/heads/main",
    defaultBranch: "main",
    forcePreview: true,
  });
  assert.equal(m.preview, true);
});

test("workflow_dispatch on the default branch deploys for real", () => {
  const m = decideMode({ eventName: "workflow_dispatch", ref: "refs/heads/main", defaultBranch: "main" });
  assert.equal(m.preview, false);
  assert.equal(m.environment, "production");
});

test("a non-default default branch (e.g. master) is honored", () => {
  const m = decideMode({ eventName: "push", ref: "refs/heads/master", defaultBranch: "master" });
  assert.equal(m.preview, false);
});
