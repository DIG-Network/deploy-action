// Tests for the `digstore deploy` argv builder (the preview-vs-real-deploy
// branch previously inline bash in action.yml's "Deploy to DIG" step).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDeployArgs } from "../src/deploy-args.mjs";

test("preview: --output-dir + --json + --preview, nothing else", () => {
  const args = buildDeployArgs({ preview: true, directory: "dist" });
  assert.deepEqual(args, ["deploy", "--output-dir", "dist", "--json", "--preview"]);
});

test("preview + a build-command: appends --build-command", () => {
  const args = buildDeployArgs({ preview: true, directory: "dist", buildCommand: "npm run build" });
  assert.deepEqual(args, [
    "deploy",
    "--output-dir",
    "dist",
    "--json",
    "--preview",
    "--build-command",
    "npm run build",
  ]);
});

test("preview ignores every real-deploy-only option", () => {
  const args = buildDeployArgs({
    preview: true,
    directory: "dist",
    ifChanged: true,
    storeId: "a".repeat(64),
    remote: "dig://store",
    message: "release",
    waitTimeout: "120",
  });
  assert.deepEqual(args, ["deploy", "--output-dir", "dist", "--json", "--preview"]);
});

test("real deploy: bare minimum is just --output-dir + --json", () => {
  const args = buildDeployArgs({ preview: false, directory: "build" });
  assert.deepEqual(args, ["deploy", "--output-dir", "build", "--json"]);
});

test("real deploy: --if-changed only when truthy", () => {
  assert.ok(buildDeployArgs({ preview: false, directory: "d", ifChanged: true }).includes("--if-changed"));
  assert.ok(!buildDeployArgs({ preview: false, directory: "d", ifChanged: false }).includes("--if-changed"));
});

test("real deploy: --store-id / --remote / --message / --wait-timeout each appear only when set", () => {
  const empty = buildDeployArgs({ preview: false, directory: "d" });
  assert.ok(!empty.includes("--store-id"));
  assert.ok(!empty.includes("--remote"));
  assert.ok(!empty.includes("--message"));
  assert.ok(!empty.includes("--wait-timeout"));

  const full = buildDeployArgs({
    preview: false,
    directory: "d",
    storeId: "a".repeat(64),
    remote: "dig://store",
    message: "release notes",
    waitTimeout: "300",
  });
  assert.deepEqual(full, [
    "deploy",
    "--output-dir",
    "d",
    "--json",
    "--store-id",
    "a".repeat(64),
    "--remote",
    "dig://store",
    "--message",
    "release notes",
    "--wait-timeout",
    "300",
  ]);
});

test("real deploy: every optional flag together, in the action's declared order", () => {
  const args = buildDeployArgs({
    preview: false,
    directory: "dist",
    ifChanged: true,
    storeId: "s",
    remote: "r",
    message: "m",
    buildCommand: "b",
    waitTimeout: "600",
  });
  assert.deepEqual(args, [
    "deploy",
    "--output-dir",
    "dist",
    "--json",
    "--if-changed",
    "--store-id",
    "s",
    "--remote",
    "r",
    "--message",
    "m",
    "--build-command",
    "b",
    "--wait-timeout",
    "600",
  ]);
});

test("real deploy: a numeric waitTimeout of 0 is still passed (falsy string check, not truthiness)", () => {
  const args = buildDeployArgs({ preview: false, directory: "d", waitTimeout: 0 });
  assert.ok(args.includes("--wait-timeout"), "0 is a meaningful (submit-and-don't-block) value, not 'unset'");
  assert.ok(args.includes("0"));
});

test("real deploy: an empty-string waitTimeout is omitted (mirrors bash's [ -n ... ] check)", () => {
  const args = buildDeployArgs({ preview: false, directory: "d", waitTimeout: "" });
  assert.ok(!args.includes("--wait-timeout"));
});
