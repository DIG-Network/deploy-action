// Shared helpers for talking to the GitHub Actions runner from the composite
// action's Node entrypoints (mode.mjs, auth.mjs, report.mjs, teardown.mjs) —
// step outputs, the job summary, boolean-ish env vars, and the triggering PR
// number. Pure glue to the Actions file-based commands; no deploy logic here.

import { appendFileSync, readFileSync } from "node:fs";

/**
 * Append one `key=value` step output using the heredoc-safe multiline form
 * (`key<<DELIM\nvalue\nDELIM\n`) GitHub Actions requires for any value that might
 * contain a newline — a JSON blob, a URL, an error message, … — see
 * https://docs.github.com/actions/using-workflows/workflow-commands-for-github-actions#multiline-strings.
 * A random per-call delimiter avoids collision with the value's own content.
 * No-op outside Actions (when `$GITHUB_OUTPUT` isn't set, e.g. running locally).
 */
export function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `__dig_eof_${Math.random().toString(36).slice(2)}__`;
  appendFileSync(file, `${key}<<${delim}\n${value}\n${delim}\n`);
}

/** Append every `[key, value]` in `outputs` as a step output (see {@link emitOutput}). */
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
