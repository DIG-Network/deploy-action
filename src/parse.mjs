// Parse `digstore deploy --json` stdout into one normalized deploy result, and
// map that result to the action's step outputs.
//
// Why this is non-trivial: the digstore CLI's `--json` mode does NOT emit a
// single merged object. It writes several pretty-printed JSON objects to stdout
// back-to-back (see digstore commands/deploy.rs + commands/commit.rs):
//   - a successful publish: the commit block
//       { root, capsule, module, size, coin_id, anchor_status, mocked,
//         pushed, claimed | push_error }
//     followed by a separate block { hub_url }.
//   - an --if-changed no-op: a single { skipped, reason, root, capsule,
//       store_id, spent, pushed } block.
//   - a --dry-run preview: a single { dry_run, root, capsule, store_id,
//       cost_dig, cost_dig_display, fee_xch_mojos, fee_xch_display, spent,
//       hub_url? } block.
//   - a --preview free build (#18): a single { preview, spent:false, mocked,
//       root, store_id, capsule, content_address, artifact, artifact_size,
//       resources } block — an EPHEMERAL preview store (content-derived id, NOT
//       the production store), no chain, no spend.
// We extract every top-level JSON object from the stream, merge them (last value
// wins), and normalize to camelCase. We also DERIVE the dig:// URL and the
// root-pinned URN, which the CLI does not emit, from store id + root (the URN
// shape matches hub.dig.net apps/web/lib/address.js: urn:dig:chia:<store>:<root>).

/**
 * Extract every top-level `{ ... }` JSON object from a stdout stream, in order.
 * Brace-balanced scan (string- and escape-aware) so pretty-printed multi-line
 * objects and any interleaved human/log lines are handled. Non-JSON noise is
 * skipped rather than throwing.
 *
 * @param {string} stdout
 * @returns {object[]} the parsed objects, in stream order
 */
export function extractJsonObjects(stdout) {
  const objects = [];
  const s = String(stdout ?? "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const candidate = s.slice(start, i + 1);
          try {
            objects.push(JSON.parse(candidate));
          } catch {
            // Not valid JSON (e.g. a brace inside un-quoted human text) — skip.
          }
          start = -1;
        }
      }
    }
  }
  return objects;
}

/** Pull the `<storeId>` out of a `storeId:rootHash` capsule string. */
function storeIdFromCapsule(capsule) {
  if (typeof capsule !== "string") return undefined;
  const i = capsule.indexOf(":");
  return i > 0 ? capsule.slice(0, i) : undefined;
}

/**
 * Parse `digstore deploy --json` stdout into a normalized result object.
 *
 * @param {string} stdout
 * @returns {{
 *   capsule?: string, root?: string, storeId?: string, coinId?: string,
 *   hubUrl?: string, digUrl?: string, urn?: string,
 *   pushed: boolean, pushError?: string, spent: boolean,
 *   skipped: boolean, reason?: string, dryRun: boolean,
 *   preview: boolean, contentAddress?: string, artifact?: string,
 *   costDig?: number, costDigDisplay?: string,
 *   feeXchMojos?: number, feeXchDisplay?: string,
 *   anchorStatus?: string, mocked?: boolean,
 * }}
 */
export function parseDeployJson(stdout) {
  const objects = extractJsonObjects(stdout);
  if (objects.length === 0) {
    throw new Error(
      "no JSON in `digstore deploy --json` output — the deploy may have failed before emitting a result",
    );
  }
  // Merge all blocks; later blocks (e.g. the hub_url block) win on overlap.
  const merged = Object.assign({}, ...objects);

  const capsule = merged.capsule;
  const root = merged.root;
  const storeId = merged.store_id ?? storeIdFromCapsule(capsule);
  const skipped = merged.skipped === true;
  const dryRun = merged.dry_run === true;
  const preview = merged.preview === true;

  // `spent` semantics: the CLI emits an explicit `spent: false` on skipped /
  // dry-run / preview blocks; a real publish block omits it but DID spend (it
  // anchored an on-chain root). So: explicit value wins, else infer from "did it
  // publish" (a preview/dry-run/skip never publishes).
  let spent;
  if (typeof merged.spent === "boolean") {
    spent = merged.spent;
  } else {
    spent = !skipped && !dryRun && !preview;
  }

  // Derive the addresses the CLI doesn't emit.
  // dig://<storeId>/  — the browser-navigable scheme (rootless = latest tip).
  // urn:dig:chia:<storeId>:<root> — the root-pinned URN (matches hub address.js).
  const digUrl = storeId ? `dig://${storeId}/` : undefined;
  const urn = storeId
    ? `urn:dig:chia:${storeId}${root ? `:${root}` : ""}`
    : undefined;

  return {
    capsule,
    root,
    storeId,
    coinId: merged.coin_id,
    hubUrl: merged.hub_url,
    digUrl,
    urn,
    pushed: merged.pushed === true,
    pushError: merged.push_error,
    spent,
    skipped,
    reason: merged.reason,
    dryRun,
    preview,
    // Preview-only: the shareable root-pinned dig:// address + the local artifact
    // (the compiled `.dig` module) the action serves to preview hosting.
    contentAddress: merged.content_address,
    artifact: merged.artifact,
    costDig: merged.cost_dig,
    costDigDisplay: merged.cost_dig_display,
    feeXchMojos: merged.fee_xch_mojos,
    feeXchDisplay: merged.fee_xch_display,
    anchorStatus: merged.anchor_status,
    mocked: merged.mocked,
  };
}

/**
 * The catalogued, stable `outcome` enum. An agent branches on these instead of scraping `::error::`
 * log lines. Documented in the README. The first set is reachable from a parsed deploy result; the
 * pre-deploy failure causes (no-credential / unauthorized / oidc-error) are emitted by the report
 * step when an earlier step aborted before `digstore` produced any JSON (see report.mjs).
 * @type {string[]}
 */
export const OUTCOMES = Object.freeze([
  "success",
  "skipped",
  "preview",
  "dry-run",
  "anchor-failed",
  "push-failed",
  "timed-out",
  // Pre-deploy guard/auth failures (set by report.mjs from the aborting step, not parse):
  "no-credential",
  "unauthorized",
  "oidc-error",
  "blocked-paid-preview",
  "failed",
]);

/**
 * Map a parsed deploy result to a single stable {@link OUTCOMES} value.
 *
 * @param {Partial<ReturnType<typeof parseDeployJson>> & { timedOut?: boolean }} r
 * @returns {string}
 */
export function computeOutcome(r = {}) {
  if (r.timedOut) return "timed-out";
  if (r.skipped) return "skipped";
  if (r.preview) return "preview";
  if (r.dryRun) return "dry-run";
  if (r.pushError) return "push-failed";
  // Anchored on-chain (spent) but the hub push did not complete and gave no explicit error.
  if (r.spent && r.pushed === false) return "anchor-failed";
  return "success";
}

/**
 * The human/machine failure reason for a parsed result, or "" when there is none.
 * @param {Partial<ReturnType<typeof parseDeployJson>> & { timedOut?: boolean }} r
 * @returns {string}
 */
export function failureReason(r = {}) {
  if (r.timedOut) return "on-chain confirmation timed out";
  if (r.pushError) return String(r.pushError);
  if (r.spent && r.pushed === false) return "anchored on-chain but the hub push did not complete";
  return "";
}

/** Coerce any value to a GitHub-Actions output string ("" for null/undefined). */
function str(v) {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

/**
 * Map a parsed deploy result to the action's step outputs (all string values,
 * kebab-case keys — the names declared in action.yml).
 *
 * @param {ReturnType<typeof parseDeployJson>} r
 * @returns {Record<string, string>}
 */
export function toOutputs(r) {
  const outcome = computeOutcome(r);
  const reason = failureReason(r);
  // The single aggregated blob: the whole normalized result + the derived outcome, so an agent can
  // `JSON.parse(steps.dig.outputs.json)` once instead of re-stitching the scalar outputs (and new
  // fields don't require a new declared output each time).
  const aggregate = { ...r, outcome, ...(reason ? { failureReason: reason } : {}) };
  return {
    capsule: str(r.capsule),
    root: str(r.root),
    "store-id": str(r.storeId),
    "dig-url": str(r.digUrl),
    urn: str(r.urn),
    "hub-url": str(r.hubUrl),
    "coin-id": str(r.coinId),
    // `content-address` is the shareable preview address (a --preview build);
    // empty on a real deploy (use `dig-url`/`urn`/`hub-url` there).
    "content-address": str(r.contentAddress),
    skipped: str(r.skipped),
    spent: str(r.spent),
    pushed: str(r.pushed),
    preview: str(r.preview),
    // Aggregated + catalogued machine outputs (see OUTCOMES).
    json: JSON.stringify(aggregate),
    outcome: str(outcome),
    "failure-reason": str(reason),
  };
}
