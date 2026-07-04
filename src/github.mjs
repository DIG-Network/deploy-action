// GitHub API side effects for the deploy action, kept separate from the parse /
// comment-body logic so they can be unit-tested against a mock REST client:
//   - upsertComment: post the deploy comment, or UPDATE this action's prior one
//     (found via COMMENT_MARKER) so a PR accrues one comment, not one-per-push.
//   - reportDeployment: create a GitHub Deployment + Deployment Status AND a
//     commit status (#24 — a red X on a failed/timed-out anchor so it can gate
//     merge), pointing at the live hub URL when there is one.
//   - deactivateDeployments: on a PR close (roadmap #18 teardown), mark that
//     PR's preview deployment(s) `inactive` — see src/teardown.mjs.
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
 * @param {number} [args.prNumber]  when set, stamped into the deployment's `payload` as `{ pr }` so
 *   {@link deactivateDeployments} can find every deployment a PR produced across ALL of its pushes
 *   on PR close — the PR's head sha (`ref`) changes on every push, so a `ref` filter alone would
 *   miss every commit but the last.
 */
export async function reportDeployment(
  rest,
  { owner, repo, sha, environment, result, context = "DIG deploy", prNumber },
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
      ...(prNumber != null ? { payload: { pr: prNumber } } : {}),
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

/** Parse a deployment's `payload`, which GitHub may return as an object or a JSON string. */
function parsePayload(payload) {
  if (payload && typeof payload === "object") return payload;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Mark every GitHub Deployment for `environment` whose `payload.pr` matches `prNumber` as
 * `inactive` (roadmap #18 teardown: on a PR close, its preview no longer represents anything
 * live). Deployments are matched by `payload.pr` — stamped by {@link reportDeployment} — rather
 * than `ref`, because a PR's head sha changes on every push; a single-`ref` filter would only ever
 * catch the LAST commit's deployment and leave earlier ones active.
 *
 * Best-effort throughout: listing failure returns 0 (nothing to report yet); one deployment's
 * status update failing does not stop the rest from being deactivated.
 *
 * @param {object} rest  Octokit `.rest` client
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.environment  e.g. "preview"
 * @param {number} args.prNumber
 * @returns {Promise<number>} how many deployments were deactivated
 */
export async function deactivateDeployments(rest, { owner, repo, environment, prNumber }) {
  let deployments;
  try {
    const { data } = await rest.repos.listDeployments({ owner, repo, environment });
    deployments = Array.isArray(data) ? data : [];
  } catch {
    return 0; // no deployments to report on yet, or the API call itself failed — nothing to do.
  }

  let deactivated = 0;
  for (const deployment of deployments) {
    const payload = parsePayload(deployment.payload);
    if (!payload || payload.pr !== prNumber) continue;
    try {
      await rest.repos.createDeploymentStatus({
        owner,
        repo,
        deployment_id: deployment.id,
        state: "inactive",
        environment,
        description: "Preview closed — the pull request was closed.",
      });
      deactivated += 1;
    } catch {
      // best-effort — keep deactivating the rest even if one call fails.
    }
  }
  return deactivated;
}
