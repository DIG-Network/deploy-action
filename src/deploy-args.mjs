// Pure argv builder for `digstore deploy` — the preview-vs-real-deploy branch at
// the heart of the composite action's "Deploy to DIG" step. Extracted out of
// inline bash (which was untested) so the arg-mapping is unit-tested like the
// rest of the decision logic (event.mjs's decideMode). Pure function — no I/O;
// print-deploy-args.mjs is the thin entrypoint that wires env vars → this →ARGV.
//
//   preview (a PR, or preview: true)  → --preview [--build-command]
//     free build via the real read path — no chain, no store id/key/wallet.
//   real deploy (the default branch) → --if-changed / --store-id / --remote /
//     --message / --build-command / --wait-timeout, each ONLY when set — advances
//     the on-chain root (writer-key) + pushes to DIGHub (keyless / deploy-key).

/**
 * @param {object} args
 * @param {boolean} args.preview            this run's deploy mode (steps.mode.outputs.preview)
 * @param {string} args.directory           `--output-dir` value (present in both modes)
 * @param {boolean} [args.ifChanged=false]  real deploy only: skip a byte-identical no-op build
 * @param {string} [args.storeId=""]        real deploy only: the store id to advance
 * @param {string} [args.remote=""]         real deploy only: the publish target
 * @param {string} [args.message=""]        real deploy only: the capsule's commit message
 * @param {string} [args.buildCommand=""]   both modes: an optional pre-deploy build step
 * @param {string|number} [args.waitTimeout=""]  real deploy only: on-chain confirmation timeout
 * @returns {string[]} the `digstore` argv (after the fixed `digstore --non-interactive --yes` prefix)
 */
export function buildDeployArgs({
  preview,
  directory,
  ifChanged = false,
  storeId = "",
  remote = "",
  message = "",
  buildCommand = "",
  waitTimeout = "",
} = {}) {
  const args = ["deploy", "--output-dir", directory, "--json"];

  if (preview) {
    args.push("--preview");
    if (buildCommand) args.push("--build-command", buildCommand);
    return args;
  }

  if (ifChanged) args.push("--if-changed");
  if (storeId) args.push("--store-id", storeId);
  if (remote) args.push("--remote", remote);
  if (message) args.push("--message", message);
  if (buildCommand) args.push("--build-command", buildCommand);
  if (waitTimeout !== "" && waitTimeout != null) args.push("--wait-timeout", String(waitTimeout));
  return args;
}
