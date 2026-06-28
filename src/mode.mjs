#!/usr/bin/env node
// Mode entrypoint: decide preview-vs-deploy from the triggering event and write
// the decision to $GITHUB_OUTPUT, so the (YAML) deploy step can branch on it:
//   - pull_request                 → preview=true  environment=preview
//   - push/dispatch to default br. → preview=false environment=production
//   - anything else                → preview=true  (no surprise spend)
//
// `DIG_FORCE_PREVIEW=true` (the action's `preview` input) pins preview. The pure
// decision lives in event.mjs (unit-tested); this only wires env → outputs.

import { writeFileSync } from "node:fs";

import { decideMode } from "./event.mjs";

function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`${key}=${value}`);
    return;
  }
  writeFileSync(file, `${key}=${value}\n`, { flag: "a" });
}

const forcePreview = /^(1|true|yes)$/i.test((process.env.DIG_FORCE_PREVIEW || "").trim());
const { preview, environment } = decideMode({
  eventName: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  defaultBranch: process.env.DIG_DEFAULT_BRANCH || process.env.GITHUB_REF_NAME,
  forcePreview,
});

emitOutput("preview", String(preview));
emitOutput("environment", environment);
console.log(`DIG deploy mode: ${preview ? "preview (free, no spend)" : "production deploy"}`);
