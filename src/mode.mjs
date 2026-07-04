#!/usr/bin/env node
// Mode entrypoint: decide preview-vs-deploy-vs-teardown from the triggering
// event and write the decision to $GITHUB_OUTPUT, so the (YAML) steps can
// branch on it:
//   - pull_request (closed)        → teardown=true (no build — deactivate the
//                                     PR's preview deployment(s) instead)
//   - pull_request (otherwise)     → preview=true  environment=preview
//   - push/dispatch to default br. → preview=false environment=production
//   - anything else                → preview=true  (no surprise spend)
//
// `DIG_FORCE_PREVIEW=true` (the action's `preview` input) pins preview. The pure
// decision lives in event.mjs (unit-tested); this only wires env → outputs.
// `DIG_EVENT_ACTION` carries `github.event.action` — GitHub does not expose the
// event's `action` field (e.g. "opened"/"closed") as a reserved GITHUB_* env
// var, so the action passes it explicitly (see action.yml's mode step).
//
// FAIL-CLOSED SPEND GUARD: until free no-spend previews (#18) ship, an EXPLICIT
// `preview: true` input would still publish a REAL (paid) capsule. We refuse to
// spend silently: a forced preview aborts here unless `allow-paid-preview: true`
// is set. The auto event-based preview (a PR / non-default push) is NOT guarded.

import { writeFileSync } from "node:fs";

import { decideMode, previewSpendGuard } from "./event.mjs";

function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`${key}=${value}`);
    return;
  }
  writeFileSync(file, `${key}=${value}\n`, { flag: "a" });
}

const forcePreview = /^(1|true|yes)$/i.test((process.env.DIG_FORCE_PREVIEW || "").trim());
const allowPaidPreview = /^(1|true|yes)$/i.test((process.env.DIG_ALLOW_PAID_PREVIEW || "").trim());
// Read the event from DIG_* overrides first, falling back to the runner's reserved
// GITHUB_* vars. The action sets only the DIG_* ones (a step `env:` CANNOT override
// a reserved GITHUB_* var, so the smoke test — and the action — must use DIG_*).
const { preview, environment, forced, teardown } = decideMode({
  eventName: process.env.DIG_EVENT_NAME || process.env.GITHUB_EVENT_NAME,
  eventAction: process.env.DIG_EVENT_ACTION,
  ref: process.env.DIG_REF || process.env.GITHUB_REF,
  defaultBranch: process.env.DIG_DEFAULT_BRANCH || process.env.GITHUB_REF_NAME,
  forcePreview,
});

emitOutput("preview", String(preview));
emitOutput("environment", environment);
emitOutput("forced-preview", String(forced));
emitOutput("teardown", String(teardown));

// Fail closed on a forced (input-driven) preview that would spend, unless opted in.
const guard = previewSpendGuard({ forcePreview: forced, allowPaidPreview });
emitOutput("paid-preview-blocked", String(guard.blocked));
if (guard.blocked) {
  console.error(`::error::${guard.reason}`);
  process.exitCode = 1;
} else if (teardown) {
  console.log("DIG deploy mode: teardown (PR closed — no build, marking preview deployment(s) inactive)");
} else {
  console.log(`DIG deploy mode: ${preview ? "preview (free, no spend)" : "production deploy"}`);
}
