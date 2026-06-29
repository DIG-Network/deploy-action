// Tests for parsing `digstore deploy --json` stdout into a normalized deploy result.
//
// The digstore CLI does NOT emit one merged JSON object: in `--json` mode it
// prints several pretty-printed JSON objects back-to-back on stdout (the commit
// object, then a separate `{ "hub_url": ... }` object; or a single `skipped` /
// `dry_run` object). These fixtures are taken verbatim from the field set
// emitted by digstore's commands/deploy.rs + commands/commit.rs so the parser
// is pinned to the real wire shape, not an invented one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDeployJson, toOutputs, computeOutcome, OUTCOMES } from "../src/parse.mjs";

const STORE = "a".repeat(64);
const ROOT = "b".repeat(64);
const COIN = "c".repeat(64);

// A successful publish: commit emits one block, deploy appends a hub_url block.
const SUCCESS_STDOUT = [
  JSON.stringify(
    {
      root: ROOT,
      capsule: `${STORE}:${ROOT}`,
      module: "/tmp/x/module.dig",
      size: 12345,
      coin_id: COIN,
      anchor_status: "confirmed",
      mocked: false,
      pushed: true,
      claimed: true,
    },
    null,
    2,
  ),
  JSON.stringify({ hub_url: `https://hub.dig.net/stores/${STORE}` }, null, 2),
].join("\n");

// `--if-changed` no-op: single skipped object, nothing spent or pushed.
const SKIPPED_STDOUT = JSON.stringify(
  {
    skipped: true,
    reason: "unchanged",
    root: ROOT,
    capsule: `${STORE}:${ROOT}`,
    store_id: STORE,
    spent: false,
    pushed: false,
  },
  null,
  2,
);

// `--preview` (#18): a FREE preview capsule — no chain, no spend. Single object
// taken verbatim from digstore commands/deploy.rs `preview()` JSON emit. NOTE the
// store_id is the EPHEMERAL preview store (content-derived), not the production
// store, and `content_address` is the root-pinned dig:// URL of the preview.
const PREVIEW_STDOUT = JSON.stringify(
  {
    preview: true,
    spent: false,
    mocked: false,
    root: ROOT,
    store_id: STORE,
    capsule: `${STORE}:${ROOT}`,
    content_address: `dig://${STORE}:${ROOT}/`,
    artifact: "/tmp/x/.dig-preview/bbb.dig",
    artifact_size: 4096,
    resources: 7,
  },
  null,
  2,
);

// `--dry-run` preview: single object with the cost fields, nothing spent.
const DRY_RUN_STDOUT = JSON.stringify(
  {
    dry_run: true,
    root: ROOT,
    capsule: `${STORE}:${ROOT}`,
    store_id: STORE,
    cost_dig: 100,
    cost_dig_display: "100 DIG",
    fee_xch_mojos: 1000,
    fee_xch_display: "0.000000001 XCH",
    spent: false,
    hub_url: `https://hub.dig.net/stores/${STORE}`,
  },
  null,
  2,
);

test("parses a successful multi-block deploy and merges the blocks", () => {
  const r = parseDeployJson(SUCCESS_STDOUT);
  assert.equal(r.capsule, `${STORE}:${ROOT}`);
  assert.equal(r.root, ROOT);
  assert.equal(r.storeId, STORE);
  assert.equal(r.coinId, COIN);
  assert.equal(r.hubUrl, `https://hub.dig.net/stores/${STORE}`);
  assert.equal(r.pushed, true);
  assert.equal(r.skipped, false);
  assert.equal(r.dryRun, false);
  // store_id is derivable from the capsule even though the success block omits it.
  assert.equal(r.spent, true, "a real publish spends DIG");
});

test("derives the dig:// URL from store id + root (CLI does not emit it)", () => {
  const r = parseDeployJson(SUCCESS_STDOUT);
  assert.equal(r.digUrl, `dig://${STORE}/`);
  // Root-pinned URN, matching hub address.js (urn:dig:chia:<store>:<root>).
  assert.equal(r.urn, `urn:dig:chia:${STORE}:${ROOT}`);
});

test("parses an --if-changed skipped no-op", () => {
  const r = parseDeployJson(SKIPPED_STDOUT);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "unchanged");
  assert.equal(r.spent, false);
  assert.equal(r.pushed, false);
  assert.equal(r.capsule, `${STORE}:${ROOT}`);
  assert.equal(r.storeId, STORE);
});

test("parses a --dry-run preview with cost fields", () => {
  const r = parseDeployJson(DRY_RUN_STDOUT);
  assert.equal(r.dryRun, true);
  assert.equal(r.spent, false);
  assert.equal(r.costDig, 100);
  assert.equal(r.costDigDisplay, "100 DIG");
  assert.equal(r.feeXchDisplay, "0.000000001 XCH");
});

test("parses a --preview free build (no chain, no spend)", () => {
  const r = parseDeployJson(PREVIEW_STDOUT);
  assert.equal(r.preview, true);
  assert.equal(r.spent, false, "a preview never spends");
  assert.equal(r.skipped, false);
  assert.equal(r.dryRun, false);
  assert.equal(r.capsule, `${STORE}:${ROOT}`);
  assert.equal(r.root, ROOT);
  assert.equal(r.storeId, STORE);
  // The preview's shareable address (root-pinned dig:// URL from the CLI).
  assert.equal(r.contentAddress, `dig://${STORE}:${ROOT}/`);
  assert.equal(r.artifact, "/tmp/x/.dig-preview/bbb.dig");
  // A preview is a success, never a failure (it pushed nothing on-chain).
  assert.equal(r.pushed, false);
  assert.equal(r.pushError, undefined);
});

test("toOutputs surfaces preview + content-address outputs", () => {
  const r = parseDeployJson(PREVIEW_STDOUT);
  const out = toOutputs(r);
  assert.equal(out.preview, "true");
  assert.equal(out.spent, "false");
  assert.equal(out["content-address"], `dig://${STORE}:${ROOT}/`);
});

test("tolerates leading human noise lines before the JSON blocks", () => {
  // Defensive: if a build step or spinner leaks a non-JSON line, parsing the
  // trailing JSON blocks must still succeed.
  const noisy = `▶ build: npm run build\nsome warning\n${SUCCESS_STDOUT}`;
  const r = parseDeployJson(noisy);
  assert.equal(r.capsule, `${STORE}:${ROOT}`);
  assert.equal(r.hubUrl, `https://hub.dig.net/stores/${STORE}`);
});

test("throws a clear error when no JSON object is present", () => {
  assert.throws(
    () => parseDeployJson("no json here at all\njust text"),
    /no JSON/i,
  );
});

test("captures a push_error block without throwing", () => {
  const withErr = JSON.stringify(
    {
      root: ROOT,
      capsule: `${STORE}:${ROOT}`,
      coin_id: COIN,
      anchor_status: "confirmed",
      pushed: false,
      push_error: "remote rejected: head not fast-forward",
    },
    null,
    2,
  );
  const r = parseDeployJson(withErr);
  assert.equal(r.pushed, false);
  assert.equal(r.pushError, "remote rejected: head not fast-forward");
  // It anchored on-chain (spent) even though the hub push failed.
  assert.equal(r.spent, true);
});

test("toOutputs maps a parsed result to the action's step outputs", () => {
  const r = parseDeployJson(SUCCESS_STDOUT);
  const out = toOutputs(r);
  assert.equal(out.capsule, `${STORE}:${ROOT}`);
  assert.equal(out.root, ROOT);
  assert.equal(out["store-id"], STORE);
  assert.equal(out["dig-url"], `dig://${STORE}/`);
  assert.equal(out.urn, `urn:dig:chia:${STORE}:${ROOT}`);
  assert.equal(out["hub-url"], `https://hub.dig.net/stores/${STORE}`);
  assert.equal(out["coin-id"], COIN);
  assert.equal(out.skipped, "false");
  assert.equal(out.spent, "true");
  assert.equal(out.pushed, "true");
  // Every output value must be a string (GitHub Actions outputs are strings).
  for (const v of Object.values(out)) {
    assert.equal(typeof v, "string", "outputs must be strings");
  }
});

test("toOutputs marks skipped deploys with spent=false", () => {
  const r = parseDeployJson(SKIPPED_STDOUT);
  const out = toOutputs(r);
  assert.equal(out.skipped, "true");
  assert.equal(out.spent, "false");
  assert.equal(out["hub-url"], "");
});

// ---------------------------------------------------------------------------
// Aggregated machine output: one `json` blob + a catalogued `outcome` enum, so
// an agent parses ONE value (and branches on a stable outcome) instead of
// re-stitching 12 string outputs.
// ---------------------------------------------------------------------------

test("computeOutcome catalogues each result kind to a stable enum value", () => {
  assert.equal(computeOutcome(parseDeployJson(SUCCESS_STDOUT)), "success");
  assert.equal(computeOutcome(parseDeployJson(SKIPPED_STDOUT)), "skipped");
  assert.equal(computeOutcome(parseDeployJson(PREVIEW_STDOUT)), "preview");
  assert.equal(computeOutcome(parseDeployJson(DRY_RUN_STDOUT)), "dry-run");
});

test("computeOutcome maps a hub-push failure to push-failed", () => {
  const withErr = JSON.stringify({
    root: ROOT,
    capsule: `${STORE}:${ROOT}`,
    pushed: false,
    push_error: "remote rejected",
  });
  assert.equal(computeOutcome(parseDeployJson(withErr)), "push-failed");
});

test("computeOutcome maps an anchored-but-not-pushed result to anchor-failed", () => {
  // Anchored on-chain (spent) but no push and no explicit push_error → anchor/push incomplete.
  const r = { spent: true, pushed: false, skipped: false, dryRun: false, preview: false };
  assert.equal(computeOutcome(r), "anchor-failed");
});

test("computeOutcome respects an explicit timedOut flag", () => {
  const r = { timedOut: true, spent: true, pushed: false };
  assert.equal(computeOutcome(r), "timed-out");
});

test("OUTCOMES enumerates every catalogued outcome value", () => {
  for (const v of ["success", "skipped", "preview", "dry-run", "anchor-failed", "push-failed", "timed-out"]) {
    assert.ok(OUTCOMES.includes(v), `OUTCOMES includes ${v}`);
  }
});

test("toOutputs adds an aggregated json blob, an outcome, and a failure-reason", () => {
  const r = parseDeployJson(SUCCESS_STDOUT);
  const out = toOutputs(r);
  // One parseable blob carrying the whole normalized result.
  const blob = JSON.parse(out.json);
  assert.equal(blob.capsule, `${STORE}:${ROOT}`);
  assert.equal(blob.storeId, STORE);
  assert.equal(blob.outcome, "success", "the aggregate carries the outcome too");
  // The scalar outcome output + an empty failure-reason on success.
  assert.equal(out.outcome, "success");
  assert.equal(out["failure-reason"], "");
});

test("toOutputs surfaces a failure-reason on a push failure", () => {
  const withErr = JSON.stringify({
    root: ROOT,
    capsule: `${STORE}:${ROOT}`,
    pushed: false,
    push_error: "remote rejected: head not fast-forward",
  });
  const out = toOutputs(parseDeployJson(withErr));
  assert.equal(out.outcome, "push-failed");
  assert.match(out["failure-reason"], /remote rejected/);
});
