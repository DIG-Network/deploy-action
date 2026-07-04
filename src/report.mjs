#!/usr/bin/env node
// Action entrypoint: the composite action shells into this after running
// `digstore deploy --json`. It:
//   1. reads the captured deploy JSON (from $1 file, else stdin),
//   2. parses + normalizes it (src/parse.mjs),
//   3. writes the step outputs to $GITHUB_OUTPUT,
//   4. writes a job-summary block to $GITHUB_STEP_SUMMARY,
//   5. on a PR (and when comment-on-pr is on), upserts the deploy comment and
//      creates a GitHub deployment + commit status (src/github.mjs).
//
// It is intentionally tolerant: a reporting failure (e.g. missing token scope)
// must NOT fail the deploy that already succeeded on-chain — those steps are
// wrapped so the action's exit code reflects the DEPLOY, not the PR cosmetics.
// The one hard failure it DOES surface is a deploy whose hub push failed or
// timed out (exit 1), so CI goes red on a broken deploy.

import { readFileSync, appendFileSync } from "node:fs";

import { parseDeployJson, toOutputs, OUTCOMES } from "./parse.mjs";
import { buildCommentBody } from "./comment.mjs";
import { upsertComment, reportDeployment, statusState } from "./github.mjs";
import { makeRest } from "./rest.mjs";

function readInput(argvPath) {
  if (argvPath && argvPath !== "-") {
    try {
      return readFileSync(argvPath, "utf8");
    } catch {
      return ""; // the deploy step wrote no JSON file — treat as a pre-deploy failure
    }
  }
  try {
    return readFileSync(0, "utf8"); // fd 0 = stdin
  } catch {
    return ""; // no stdin attached — treat as no deploy output (a pre-deploy failure)
  }
}

function envBool(name, dflt = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes)$/i.test(v.trim());
}

/** Append `key=value` step outputs using the multiline-safe GITHUB_OUTPUT form. */
function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return; // running outside Actions (e.g. local) — nothing to write to.
  let body = "";
  for (const [k, v] of Object.entries(outputs)) {
    const delim = `__dig_eof_${Math.random().toString(36).slice(2)}__`;
    body += `${k}<<${delim}\n${v}\n${delim}\n`;
  }
  appendFileSync(file, body);
}

function writeSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${md}\n`);
}

/** Pull the PR number from the Actions event payload, if this run is a PR. */
function prNumber() {
  try {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) return undefined;
    const event = JSON.parse(readFileSync(path, "utf8"));
    return (
      event.pull_request?.number ??
      event.issue?.number ??
      (event.number != null ? event.number : undefined)
    );
  } catch {
    return undefined;
  }
}

/**
 * When `digstore` produced no parseable JSON, an earlier step (the spend guard, the funding-credential
 * guard, keyless OIDC, or the deploy command itself) failed before a result existed. Emit the
 * catalogued failure outcome + reason so an agent can branch on the CAUSE without scraping logs.
 * The aborting step passes a hint via DIG_PRIOR_OUTCOME / DIG_PRIOR_REASON.
 * @returns {{ outcome: string, "failure-reason": string, json: string }}
 */
function failureOutputs() {
  let outcome = (process.env.DIG_PRIOR_OUTCOME || "").trim();
  if (!OUTCOMES.includes(outcome)) outcome = "failed";
  const reason =
    (process.env.DIG_PRIOR_REASON || "").trim() ||
    "the deploy failed before producing a result";
  return {
    outcome,
    "failure-reason": reason,
    json: JSON.stringify({ outcome, failureReason: reason }),
  };
}

async function main() {
  const raw = readInput(process.argv[2]);

  // No deploy JSON → a pre-deploy failure. Still write a catalogued outcome + reason (this step runs
  // with `if: always()`), so a later step / an agent learns the cause from outputs, not log scraping.
  let result;
  try {
    result = raw && raw.trim() ? parseDeployJson(raw) : null;
  } catch {
    result = null;
  }
  if (!result) {
    const out = failureOutputs();
    writeOutputs(out);
    writeSummary(`### DIG Deploy — failed\n\n\`${out.outcome}\`: ${out["failure-reason"]}`);
    console.error(`::error::DIG deploy ${out.outcome}: ${out["failure-reason"]}`);
    process.exitCode = 1;
    return;
  }

  const outputs = toOutputs(result);

  writeOutputs(outputs);

  // A preview is whatever the CLI reported (a real `--preview` free build), OR an
  // explicit DIG_PREVIEW request from the action — either marks this PR-preview.
  const preview = result.preview === true || envBool("DIG_PREVIEW", false);
  const sha =
    process.env.DIG_DEPLOY_SHA ||
    process.env.GITHUB_SHA ||
    "";

  // Job summary (always — visible even on non-PR pushes).
  writeSummary(buildCommentBody({ result, sha, preview }));

  // PR reporting (best-effort; never fails the deploy).
  const wantComment = envBool("DIG_COMMENT_ON_PR", true);
  const token = process.env.GITHUB_TOKEN || "";
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  const pr = prNumber();

  if (wantComment && token && owner && repo && pr) {
    try {
      const { rest } = makeRest(token);
      const body = buildCommentBody({ result, sha, preview });
      await upsertComment(rest, { owner, repo, issue_number: pr, body });
      await reportDeployment(rest, {
        owner,
        repo,
        sha,
        environment: preview ? "preview" : "production",
        result,
        // Stamped into the deployment's payload so a later PR-close teardown
        // (src/teardown.mjs) can find every deployment this PR produced across
        // ALL of its pushes, not just the one matching the final sha.
        prNumber: preview ? pr : undefined,
      });
    } catch (err) {
      console.error(`::warning::deploy succeeded but PR reporting failed: ${err.message}`);
    }
  }

  // Surface a human line in the log.
  if (result.skipped) {
    console.log(`DIG deploy skipped (unchanged): ${result.capsule ?? ""}`);
  } else if (result.preview) {
    console.log(`DIG preview (free, no spend): ${result.contentAddress ?? result.capsule ?? ""}`);
  } else if (result.dryRun) {
    console.log(`DIG dry run: would publish ${result.capsule ?? ""}`);
  } else {
    console.log(`DIG deploy: ${result.capsule ?? "(no capsule)"}`);
    if (result.hubUrl) console.log(`  ${result.hubUrl}`);
  }

  // Hard-fail the action only when the deploy itself failed (anchor/push) so CI
  // goes red. A skipped no-op and a dry-run are both successes.
  if (statusState(result) === "failure") {
    console.error(`::error::DIG deploy failed: ${result.pushError || "anchor/push did not complete"}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exitCode = 1;
});
