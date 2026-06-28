// Tests for the PR comment body construction (#24: capsule + URLs + cost).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCommentBody, COMMENT_MARKER } from "../src/comment.mjs";
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
  assert.match(body, /dig:\/\//, "dig:// url");
  assert.match(body, new RegExp(`hub\\.dig\\.net/stores/${STORE}`), "hub url");
  assert.match(body, new RegExp(COIN), "coin id");
  assert.match(body, /100 DIG/, "DIG cost (#24)");
  assert.match(body, /deadbeef/, "commit sha");
});

test("a preview deploy is labelled as a free preview (Wave-2 #18)", () => {
  const body = buildCommentBody({ result: success(), sha: "abc", preview: true });
  assert.match(body, /preview/i);
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
  assert.doesNotMatch(body, /100 DIG/, "skipped deploys cost nothing");
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
