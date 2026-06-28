// GitHub API side effects for the deploy action, kept separate from the parse /
// comment-body logic so they can be unit-tested against a mock REST client:
//   - upsertComment: post the deploy comment, or UPDATE this action's prior one
//     (found via COMMENT_MARKER) so a PR accrues one comment, not one-per-push.
//   - reportDeployment: create a GitHub Deployment + Deployment Status AND a
//     commit status (#24 — a red X on a failed/timed-out anchor so it can gate
//     merge), pointing at the live hub URL when there is one.
//
// The `rest` argument is an Octokit-shaped client (github.getOctokit(token).rest
// in the action entrypoint); only the handful of methods used here are required,
// which is exactly what the tests mock.

import { COMMENT_MARKER } from "./comment.mjs";

/**
 * Decide the commit-status / deployment-status state for a parsed result.
 * success → "success"; a skipped no-op is still a green check; a failed or
 * timed-out anchor/push is "failure" (the red X that can block merge, #24).
 *
 * @param {{ skipped?: boolean, pushed?: boolean, pushError?: string,
 *           timedOut?: boolean, dryRun?: boolean }} result
 * @returns {"success"|"failure"}
 */
export function statusState(result) {
  if (result.timedOut) return "failure";
  if (result.pushError) return "failure";
  if (result.pushed === false && result.spent) {
    // Anchored on-chain but the hub push did not succeed → not fully live.
    return "failure";
  }
  return "success";
}

/**
 * Post or update the action's PR comment (idempotent per PR via COMMENT_MARKER).
 *
 * @param {object} rest  Octokit `.rest` client
 * @param {{ owner: string, repo: string, issue_number: number, body: string }} args
 */
export async function upsertComment(rest, { owner, repo, issue_number, body }) {
  const { data: comments } = await rest.issues.listComments({
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const mine = (comments ?? []).find(
    (c) => typeof c.body === "string" && c.body.includes(COMMENT_MARKER),
  );
  if (mine) {
    return rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  }
  return rest.issues.createComment({ owner, repo, issue_number, body });
}

/**
 * Create a GitHub Deployment + Deployment Status and a commit status for a SHA.
 * Best-effort: each call is independent so one failing (e.g. missing
 * `deployments: write` permission) does not abort the others.
 *
 * @param {object} rest  Octokit `.rest` client
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.sha
 * @param {string} args.environment  e.g. "production" or "preview"
 * @param {import("./parse.mjs").parseDeployJson extends (s: string) => infer R ? R : any} args.result
 * @param {string} [args.context]  commit-status context label
 */
export async function reportDeployment(
  rest,
  { owner, repo, sha, environment, result, context = "DIG deploy" },
) {
  const state = statusState(result);
  const envUrl = result.hubUrl || undefined;
  const description = result.skipped
    ? "Unchanged — nothing published"
    : state === "success"
      ? result.capsule
        ? `Published ${result.capsule}`
        : "Published"
      : result.pushError || "Deploy failed";

  // GitHub Deployment (transient_environment for previews so they auto-inactivate).
  let deploymentId;
  try {
    const { data: deployment } = await rest.repos.createDeployment({
      owner,
      repo,
      ref: sha,
      environment,
      auto_merge: false,
      required_contexts: [],
      transient_environment: environment !== "production",
      description: description.slice(0, 140),
    });
    deploymentId = deployment?.id;
  } catch {
    deploymentId = undefined;
  }

  if (deploymentId != null) {
    try {
      await rest.repos.createDeploymentStatus({
        owner,
        repo,
        deployment_id: deploymentId,
        state,
        environment,
        environment_url: envUrl,
        description: description.slice(0, 140),
      });
    } catch {
      // ignore — the commit status below still reflects the outcome.
    }
  }

  // Commit status — the merge-gating signal (#24).
  try {
    await rest.repos.createCommitStatus({
      owner,
      repo,
      sha,
      state,
      context,
      target_url: envUrl,
      description: description.slice(0, 140),
    });
  } catch {
    // ignore — non-fatal reporting.
  }

  return { state, deploymentId };
}
