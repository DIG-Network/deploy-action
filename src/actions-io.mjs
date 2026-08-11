// Shared helpers for talking to the GitHub Actions runner from the composite
// action's Node entrypoints (mode.mjs, auth.mjs, report.mjs, teardown.mjs) —
// step outputs, the job summary, boolean-ish env vars, and the triggering PR
// number. Pure glue to the Actions file-based commands; no deploy logic here.

import { appendFileSync, readFileSync } from "node:fs";
// Imported as the module OBJECT (not `{ randomUUID }`) so tests can stub the
// delimiter and exercise a value that genuinely contains it — the only fixture
// that can tell the guard below apart from an unguarded UUID delimiter.
import crypto from "node:crypto";

/**
 * Build the heredoc block for one step output, in the multiline form
 * (`key<<DELIM\nvalue\nDELIM\n`) GitHub Actions requires for any value that might
 * contain a newline — a JSON blob, a URL, an error message, … — see
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions#multiline-strings.
 *
 * The delimiter is a fresh UUID per call, and neither the key nor the value may
 * contain it. Both halves matter: a value carrying the delimiter would close the
 * heredoc early and the runner would parse the remainder as FURTHER step outputs,
 * so attacker-influenced content could forge any output this action declares. The
 * untrusted values are the ones taken verbatim off `digstore` stdout and the hub's
 * OIDC response with no shape validation — `push_error` (which reaches
 * `failure-reason`), `store_id`, `capsule`, `root`, `coin_id`, `hub_url`. Note
 * `DIG_PRIOR_REASON` is NOT untrusted; `action.yml` resolves it to one of four
 * hardcoded literals. This mirrors `@actions/core`'s
 * `prepareKeyValueMessage`, deliberately including its throw-don't-truncate
 * behaviour: a UUID collision is not a realistic accident, so a value containing
 * one means the caller is doing something the runner cannot represent, and
 * failing the step loudly is safer than writing bytes with a different meaning
 * than the caller intended.
 *
 * @throws {Error} when the key or value contains the generated delimiter.
 */
function heredocBlock(key, value) {
  const delim = `__dig_eof_${crypto.randomUUID()}__`;
  const text = String(value);
  if (String(key).includes(delim) || text.includes(delim)) {
    throw new Error(`refusing to emit "${key}": key or value contains the heredoc delimiter`);
  }
  return `${key}<<${delim}\n${text}\n${delim}\n`;
}

/**
 * Append one `key=value` step output to `$GITHUB_OUTPUT` (see {@link heredocBlock}
 * for the format and its injection guard). No-op outside Actions (when
 * `$GITHUB_OUTPUT` isn't set, e.g. running locally).
 */
export function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, heredocBlock(key, value));
}

/**
 * Append every `[key, value]` in `outputs` as a step output (see {@link emitOutput}).
 *
 * NOT atomic: keys are appended one at a time, so a throw on key N leaves keys
 * 1..N-1 already in the file and the rest absent. The step then exits non-zero, so
 * a consumer that does not run on failure never sees the partial set — but one
 * using `if: always()` must not read a present output as proof the batch completed.
 */
export function emitOutputs(outputs) {
  for (const [key, value] of Object.entries(outputs)) emitOutput(key, value);
}

/** Append a Markdown block to the job's step summary (`$GITHUB_STEP_SUMMARY`). No-op outside Actions. */
export function writeSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${md}\n`);
}

/** Parse a boolean-ish env var (`1`/`true`/`yes`, case-insensitive); `dflt` when unset/empty. */
export function envBool(name, dflt = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes)$/i.test(v.trim());
}

/**
 * Pull the PR number from the Actions event payload (`$GITHUB_EVENT_PATH`), covering every shape
 * this action's steps run under: a `pull_request`/`pull_request_target` event (`pull_request.number`),
 * an `issue_comment`-shaped payload (`issue.number`), or a bare `number` field. Returns `undefined`
 * when there is no PR context (e.g. a `push`/`workflow_dispatch` run) or the payload can't be read.
 */
export function prNumber() {
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
