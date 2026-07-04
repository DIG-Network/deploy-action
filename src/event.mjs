// Decide the deploy MODE from the triggering GitHub event — the PR-preview vs.
// push-deploy fork at the heart of git-push-to-deploy:
//
//   - pull_request (closed)              → teardown (mark the PR's preview
//                                           deployment(s) inactive; no build)
//   - pull_request (any other action)    → preview  (free, no chain, no spend)
//   - push / workflow_dispatch to the
//     repository DEFAULT branch           → production deploy (a real capsule)
//   - anything else (a push to a non-
//     default branch, etc.)               → preview, so a branch push never
//                                           triggers a surprise $DIG spend.
//
// `forcePreview` (the action's `preview: true` input) pins preview regardless, so
// a user can preview a default-branch push on purpose. Pure function — unit-tested.

/**
 * @param {object} args
 * @param {string} args.eventName      GITHUB_EVENT_NAME (e.g. "push", "pull_request")
 * @param {string} [args.eventAction]  the event's `action` field (e.g. "opened", "closed") —
 *   only meaningful for pull_request / pull_request_target; GitHub does not set this env var
 *   itself, so the action passes it explicitly as `github.event.action`.
 * @param {string} [args.ref]          GITHUB_REF (e.g. "refs/heads/main")
 * @param {string} [args.defaultBranch] the repo's default branch (e.g. "main")
 * @param {boolean} [args.forcePreview] the `preview` input — force preview mode
 * @returns {{ preview: boolean, environment: "preview"|"production", forced: boolean, teardown: boolean }}
 *   `forced` is true only when preview was pinned by the `preview: true` INPUT (vs. derived
 *   from the event). The spend guard keys off `forced` so an explicit "preview" flag can never
 *   silently spend (see {@link previewSpendGuard}); an event-derived preview is always safe.
 *   `teardown` is true only for a closed pull_request: there is nothing left to build, so the
 *   composite action skips install/deploy and instead deactivates that PR's preview deployment(s).
 */
export function decideMode({ eventName, eventAction, ref, defaultBranch, forcePreview = false } = {}) {
  if (forcePreview) {
    return { preview: true, environment: "preview", forced: true, teardown: false };
  }
  const isPullRequest = eventName === "pull_request" || eventName === "pull_request_target";
  // A CLOSED pull request (merged or abandoned) has nothing left to preview — tear
  // down its prior preview deployment(s) instead of building a new one.
  if (isPullRequest && eventAction === "closed") {
    return { preview: true, environment: "preview", forced: false, teardown: true };
  }
  // Any other pull_request action is always a preview — there is no merge yet to publish.
  if (isPullRequest) {
    return { preview: true, environment: "preview", forced: false, teardown: false };
  }
  // A real deploy happens ONLY on the default branch (push or manual dispatch).
  const onDefault =
    !!defaultBranch && ref === `refs/heads/${defaultBranch}`;
  const isDeployEvent = eventName === "push" || eventName === "workflow_dispatch";
  if (isDeployEvent && onDefault) {
    return { preview: false, environment: "production", forced: false, teardown: false };
  }
  // Everything else previews — never a surprise spend off a branch push.
  return { preview: true, environment: "preview", forced: false, teardown: false };
}

/**
 * Fail-closed guard for the EXPLICIT `preview: true` input.
 *
 * Wave-2 (#18) free, no-spend per-PR previews are not yet available; until that infra ships,
 * `digstore deploy --preview` still publishes a REAL capsule on Chia (a $DIG spend) merely labelled
 * "preview". A flag literally named `preview` must therefore NEVER silently spend: when the user
 * forces preview via the input (not via the event), we block the run unless they explicitly opt in
 * with `allow-paid-preview: true`.
 *
 * The AUTO event-based preview path (a PR, or a push to a non-default branch) is intentionally NOT
 * guarded here — that is the normal, expected preview flow and is the action's documented behavior.
 *
 * @param {object} args
 * @param {boolean} args.forcePreview     the `preview: true` INPUT was set
 * @param {boolean} [args.allowPaidPreview] the `allow-paid-preview: true` opt-in was set
 * @returns {{ blocked: boolean, reason: string }}
 */
export function previewSpendGuard({ forcePreview, allowPaidPreview = false } = {}) {
  if (forcePreview && !allowPaidPreview) {
    return {
      blocked: true,
      reason:
        "`preview: true` would publish a REAL capsule on Chia (a $DIG spend) — free no-spend " +
        "previews (#18) are not yet available. Refusing to spend silently. PRs already preview " +
        "automatically (free, event-derived). To deliberately publish a paid build from the " +
        "`preview` input, set `allow-paid-preview: true`.",
    };
  }
  return { blocked: false, reason: "" };
}
