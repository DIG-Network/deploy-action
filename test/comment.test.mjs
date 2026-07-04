// Tests for the PR comment body construction (#24: capsule + URLs + cost).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCommentBody, buildTeardownCommentBody, COMMENT_MARKER } from "../src/comment.mjs";
import { parseDeployJson } from "../src/parse.mjs";

const STORE = "a".repeat(64);
const ROOT = "b".repeat(64);
const COIN = "c".repeat(64);

function success() {
  return parseDeployJson(
    [
      JSON.stringify({
        root: ROOT,
        capsule: `${STORE}:${ROOT}`,
        coin_id: COIN,
        anchor_status: "confirmed",
        pushed: true,
        claimed: true,
      }),
      JSON.stringify({ hub_url: `https://hub.dig.net/stores/${STORE}` }),
    ].join("\n"),
  );
}

test("the comment body carries a stable hidden marker for upsert", () => {
  const body = buildCommentBody({ result: success(), sha: "deadbeef" });
  assert.match(body, new RegExp(COMMENT_MARKER));
});

test("a successful deploy comment includes capsule, URLs, coin and cost", () => {
  const body = buildCommentBody({ result: success(), sha: "deadbeef0123" });
  assert.match(body, new RegExp(`${STORE}:${ROOT}`), "capsule");
  // The open address is the user-facing chia:// content-open URL (NOT dig://).
  assert.match(body, new RegExp(`chia://${STORE}/`), "chia:// open url");
  assert.match(body, /\bOpen\b/, "an 'Open' row pointing the user at the deployment");
  assert.doesNotMatch(body, /dig:\/\/\b/, "no bare dig:// open URL in the comment");
  assert.match(body, new RegExp(`hub\\.dig\\.net/stores/${STORE}`), "hub url");
  assert.match(body, new RegExp(COIN), "coin id");
  assert.match(body, /\$DIG/, "$DIG cost (#24) — dynamic per-capsule price");
  assert.match(body, /deadbeef/, "commit sha");
});

test("a preview deploy is labelled as a free preview (Wave-2 #18)", () => {
  const body = buildCommentBody({ result: success(), sha: "abc", preview: true });
  assert.match(body, /preview/i);
});

test("a FREE preview build (#18) shows the shareable address and no spend", () => {
  const r = parseDeployJson(
    JSON.stringify({
      preview: true,
      spent: false,
      mocked: false,
      root: ROOT,
      store_id: STORE,
      capsule: `${STORE}:${ROOT}`,
      content_address: `chia://${STORE}:${ROOT}/`,
      artifact: "/tmp/.dig-preview/x.dig",
      artifact_size: 4096,
      resources: 3,
    }),
  );
  const body = buildCommentBody({ result: r, sha: "abc", preview: true });
  assert.match(body, /preview/i, "labelled a preview");
  assert.match(body, new RegExp(`chia://${STORE}:${ROOT}/`), "shows the shareable chia:// content address");
  assert.doesNotMatch(body, /\*\*Cost\*\*/, "a free preview shows no cost line");
  assert.match(body, /free|no.?spend|nothing (was )?spent/i, "states it is free");
});

test("a skipped (--if-changed) deploy says nothing was spent", () => {
  const r = parseDeployJson(
    JSON.stringify({
      skipped: true,
      reason: "unchanged",
      root: ROOT,
      capsule: `${STORE}:${ROOT}`,
      store_id: STORE,
      spent: false,
      pushed: false,
    }),
  );
  const body = buildCommentBody({ result: r, sha: "abc" });
  assert.match(body, /unchanged|no.?op|nothing (was )?(deployed|spent|published)/i);
  assert.doesNotMatch(body, /\*\*Cost\*\*/, "skipped deploys show no cost line");
});

test("a failed hub push surfaces the error in the comment", () => {
  const r = parseDeployJson(
    JSON.stringify({
      root: ROOT,
      capsule: `${STORE}:${ROOT}`,
      coin_id: COIN,
      pushed: false,
      push_error: "remote rejected",
    }),
  );
  const body = buildCommentBody({ result: r, sha: "abc" });
  assert.match(body, /remote rejected/);
});

// ---------------------------------------------------------------------------
// buildTeardownCommentBody: the PR comment posted when a PR closes and its
// preview deployment(s) are marked inactive (roadmap #18 teardown).
// ---------------------------------------------------------------------------

test("the teardown comment carries the same hidden marker for upsert", () => {
  const body = buildTeardownCommentBody({ deactivated: 1 });
  assert.match(body, new RegExp(COMMENT_MARKER));
});

test("the teardown comment states how many preview deployments were deactivated", () => {
  const body = buildTeardownCommentBody({ deactivated: 2 });
  assert.match(body, /closed/i);
  assert.match(body, /2 preview deployments/i);
  assert.match(body, /nothing was spent/i);
});

test("the teardown comment uses singular phrasing for exactly one deployment", () => {
  const body = buildTeardownCommentBody({ deactivated: 1 });
  assert.match(body, /1 preview deployment\b/i);
  assert.doesNotMatch(body, /1 preview deployments/i);
});

test("the teardown comment handles zero deactivated deployments gracefully", () => {
  const body = buildTeardownCommentBody({ deactivated: 0 });
  assert.match(body, /closed/i);
  assert.doesNotMatch(body, /undefined/);
});

test("buildTeardownCommentBody defaults deactivated to 0 when omitted", () => {
  const body = buildTeardownCommentBody();
  assert.match(body, new RegExp(COMMENT_MARKER));
});
