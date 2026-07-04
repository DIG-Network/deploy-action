#!/usr/bin/env node
// Action entrypoint for the PR-close teardown step (roadmap #18): when a
// pull_request is closed (merged or abandoned), its "preview" environment no
// longer represents anything worth keeping active. This step:
//   1. marks every GitHub Deployment this action created for that PR — across
//      ALL of its pushes, not just the last one (src/github.mjs deactivateDeployments) —
//      `inactive`;
//   2. replaces the PR's deploy comment (same COMMENT_MARKER upsert used by
//      report.mjs) with a closed notice.
//
// It NEVER runs digstore and NEVER touches the chain — nothing here can spend
// $DIG. It is best-effort and ALWAYS exits 0: a PR that is already closing must
// never be blocked by a cleanup step, so failures are logged as warnings only.

import { readFileSync, appendFileSync } from "node:fs";

import { deactivateDeployments, upsertComment } from "./github.mjs";
import { buildTeardownCommentBody } from "./comment.mjs";
import { makeRest } from "./rest.mjs";

function writeSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${md}\n`);
}

function envBool(name, dflt = true) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes)$/i.test(v.trim());
}

/** Pull the PR number from the Actions event payload (a pull_request `closed` event). */
function prNumber() {
  try {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) return undefined;
    const event = JSON.parse(readFileSync(path, "utf8"));
    return event.pull_request?.number ?? event.number;
  } catch {
    return undefined;
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN || "";
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  const pr = prNumber();

  if (!token || !owner || !repo || !pr) {
    console.log("DIG preview teardown: nothing to tear down (no PR context).");
    writeSummary("### DIG Preview — nothing to tear down (no PR context)");
    return;
  }

  const { rest } = makeRest(token);

  let deactivated = 0;
  try {
    deactivated = await deactivateDeployments(rest, {
      owner,
      repo,
      environment: "preview",
      prNumber: pr,
    });
  } catch (err) {
    console.error(`::warning::preview teardown could not deactivate deployments: ${err.message}`);
  }

  if (envBool("DIG_COMMENT_ON_PR", true)) {
    try {
      const body = buildTeardownCommentBody({ deactivated });
      await upsertComment(rest, { owner, repo, issue_number: pr, body });
    } catch (err) {
      console.error(`::warning::preview teardown could not update the PR comment: ${err.message}`);
    }
  }

  writeSummary(
    `### DIG Preview — torn down\n\nDeactivated ${deactivated} preview deployment(s) for PR #${pr}.`,
  );
  console.log(`DIG preview teardown: deactivated ${deactivated} deployment(s) for PR #${pr}`);
}

main().catch((err) => {
  // Best-effort: a closing PR must never be blocked by a cleanup cosmetics failure.
  console.error(`::warning::DIG preview teardown failed: ${err.message}`);
});
