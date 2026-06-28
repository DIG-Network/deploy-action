// Decide the deploy MODE from the triggering GitHub event — the PR-preview vs.
// push-deploy fork at the heart of git-push-to-deploy:
//
//   - pull_request                       → preview  (free, no chain, no spend)
//   - push / workflow_dispatch to the
//     repository DEFAULT branch           → production deploy (a real capsule)
//   - anything else (a push to a non-
//     default branch, etc.)               → preview, so a branch push never
//                                           triggers a surprise 100-DIG spend.
//
// `forcePreview` (the action's `preview: true` input) pins preview regardless, so
// a user can preview a default-branch push on purpose. Pure function — unit-tested.

/**
 * @param {object} args
 * @param {string} args.eventName      GITHUB_EVENT_NAME (e.g. "push", "pull_request")
 * @param {string} [args.ref]          GITHUB_REF (e.g. "refs/heads/main")
 * @param {string} [args.defaultBranch] the repo's default branch (e.g. "main")
 * @param {boolean} [args.forcePreview] the `preview` input — force preview mode
 * @returns {{ preview: boolean, environment: "preview"|"production" }}
 */
export function decideMode({ eventName, ref, defaultBranch, forcePreview = false } = {}) {
  if (forcePreview) {
    return { preview: true, environment: "preview" };
  }
  // A pull request is always a preview — there is no merge yet to publish.
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return { preview: true, environment: "preview" };
  }
  // A real deploy happens ONLY on the default branch (push or manual dispatch).
  const onDefault =
    !!defaultBranch && ref === `refs/heads/${defaultBranch}`;
  const isDeployEvent = eventName === "push" || eventName === "workflow_dispatch";
  if (isDeployEvent && onDefault) {
    return { preview: false, environment: "production" };
  }
  // Everything else previews — never a surprise spend off a branch push.
  return { preview: true, environment: "preview" };
}
