// Tests for the event → deploy-mode decision (the PR-preview vs push-deploy fork).
//
// On a pull_request the action runs `digstore deploy --preview` (free, no chain,
// no spend) and comments the preview URL. On a push to the repo's DEFAULT branch
// it runs `digstore deploy --if-changed` (a real capsule) and sets the GitHub
// deployment status + live URL. Anything else (push to a non-default branch,
// other events) defaults to a safe no-op preview unless explicitly forced.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideMode, previewSpendGuard } from "../src/event.mjs";

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

// ---------------------------------------------------------------------------
// preview-spend guard: an EXPLICIT `preview: true` input must never SILENTLY
// publish a real (paid) capsule while the free-preview infra is absent. It must
// fail closed unless the user explicitly opts in via `allow-paid-preview: true`.
// The AUTO event-based preview (a PR / non-default push) is unaffected.
// ---------------------------------------------------------------------------

test("explicit preview:true is BLOCKED by default (paid preview not allowed)", () => {
  const g = previewSpendGuard({ forcePreview: true, allowPaidPreview: false });
  assert.equal(g.blocked, true);
  assert.match(g.reason, /preview/i);
});

test("explicit preview:true is ALLOWED when allow-paid-preview is set", () => {
  const g = previewSpendGuard({ forcePreview: true, allowPaidPreview: true });
  assert.equal(g.blocked, false);
});

test("an auto event-based preview is NEVER blocked (no explicit preview input)", () => {
  // A PR / non-default push previews without the user setting `preview: true`.
  assert.equal(previewSpendGuard({ forcePreview: false, allowPaidPreview: false }).blocked, false);
  assert.equal(previewSpendGuard({ forcePreview: false, allowPaidPreview: true }).blocked, false);
});

test("decideMode reports whether the preview was FORCED by the input", () => {
  // Forced preview on a default-branch push: forced=true.
  const forced = decideMode({ eventName: "push", ref: "refs/heads/main", defaultBranch: "main", forcePreview: true });
  assert.equal(forced.preview, true);
  assert.equal(forced.forced, true, "the preview was forced by the input");
  // Auto preview on a PR: not forced.
  const auto = decideMode({ eventName: "pull_request", ref: "refs/heads/f", defaultBranch: "main" });
  assert.equal(auto.preview, true);
  assert.equal(auto.forced, false, "an event-derived preview is not forced");
});

// ---------------------------------------------------------------------------
// Teardown: a closed pull_request has nothing left to preview. decideMode must
// flag `teardown: true` so the composite action skips the build/deploy steps
// entirely and instead marks that PR's preview deployment(s) inactive.
// ---------------------------------------------------------------------------

test("a closed pull_request → teardown (no build, mark preview deployments inactive)", () => {
  const m = decideMode({
    eventName: "pull_request",
    eventAction: "closed",
    ref: "refs/heads/feature",
    defaultBranch: "main",
  });
  assert.equal(m.teardown, true);
  assert.equal(m.preview, true, "still reported as the preview environment");
  assert.equal(m.environment, "preview");
});

test("a closed pull_request_target → teardown too", () => {
  const m = decideMode({
    eventName: "pull_request_target",
    eventAction: "closed",
    ref: "refs/heads/feature",
    defaultBranch: "main",
  });
  assert.equal(m.teardown, true);
});

for (const action of ["opened", "synchronize", "reopened", "labeled", undefined]) {
  test(`a pull_request '${action}' is NOT teardown (still builds a preview)`, () => {
    const m = decideMode({
      eventName: "pull_request",
      eventAction: action,
      ref: "refs/heads/feature",
      defaultBranch: "main",
    });
    assert.equal(m.teardown, false);
    assert.equal(m.preview, true);
  });
}

test("teardown is false on every non-pull_request-closed decision", () => {
  assert.equal(
    decideMode({ eventName: "push", ref: "refs/heads/main", defaultBranch: "main" }).teardown,
    false,
  );
  assert.equal(
    decideMode({ eventName: "push", ref: "refs/heads/dev", defaultBranch: "main" }).teardown,
    false,
  );
  assert.equal(
    decideMode({ eventName: "push", ref: "refs/heads/main", defaultBranch: "main", forcePreview: true })
      .teardown,
    false,
  );
});
