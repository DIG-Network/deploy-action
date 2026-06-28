// Build the PR comment body for a DIG deploy (roadmap #24: capsule + URLs +
// cost commented back on the PR). Pure string construction — no I/O — so it is
// fully unit-testable. The hidden HTML marker lets the action find and UPDATE
// its own prior comment (upsert) instead of posting a new one every push.

/** Hidden marker, kept in the body so we can find this action's comment later. */
export const COMMENT_MARKER = "<!-- dig-network/deploy-action -->";

/** Short-form a long hex id for display, keeping it copy-pasteable in full code. */
function short(hex, head = 8, tail = 6) {
  const s = String(hex ?? "");
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Build the Markdown body of the deploy comment.
 *
 * @param {object} args
 * @param {import("./parse.mjs").parseDeployJson extends (s: string) => infer R ? R : any} args.result
 *   the normalized deploy result from parseDeployJson
 * @param {string} args.sha  the commit SHA being deployed
 * @param {boolean} [args.preview=false]  PR preview deploy (Wave-2 #18) vs. production
 * @returns {string} GitHub-flavored Markdown
 */
export function buildCommentBody({ result, sha, preview = false }) {
  const lines = [];
  const shortSha = String(sha ?? "").slice(0, 12);
  const kind = preview ? "Preview" : "Deployment";

  // --- Header ---------------------------------------------------------------
  if (result.skipped) {
    lines.push(`### DIG ${kind} — unchanged, nothing published`);
    lines.push("");
    lines.push(
      `Your build is byte-identical to the live version (\`--if-changed\`), so nothing was deployed and **nothing was spent**.`,
    );
  } else if (result.dryRun) {
    lines.push(`### DIG ${kind} — dry run (no spend)`);
    lines.push("");
    lines.push("This is a preview of the resulting version and its cost. Nothing was published or spent.");
  } else if (result.pushed === false && result.pushError) {
    lines.push(`### DIG ${kind} — anchored on-chain, hub publish failed`);
    lines.push("");
    lines.push(
      `The new version was anchored on Chia, but publishing the capsule to DIGHub failed:`,
    );
    lines.push("");
    lines.push("```");
    lines.push(String(result.pushError));
    lines.push("```");
  } else if (preview) {
    lines.push("### DIG Preview");
    lines.push("");
    lines.push(
      "> [!NOTE]",
      "> Free per-PR preview deploys (no on-chain spend) are a planned Wave-2 feature (#18). " +
        "Until the preview infrastructure ships, `preview: true` publishes a real capsule on Chia " +
        "(100 DIG). Treat this as a real deployment for now.",
    );
  } else {
    lines.push("### DIG Deployment — live and permanent");
  }

  lines.push("");

  // --- Capsule + addresses --------------------------------------------------
  if (result.capsule) {
    lines.push(`**Capsule** \`${result.capsule}\``);
    lines.push("");
  }

  const rows = [];
  if (result.digUrl) rows.push(["dig:// URL", `\`${result.digUrl}\``]);
  if (result.urn) rows.push(["URN (permalink)", `\`${result.urn}\``]);
  if (result.hubUrl) rows.push(["Open on the hub", `[${result.hubUrl}](${result.hubUrl})`]);
  if (result.root) rows.push(["Root", `\`${short(result.root)}\``]);
  // Full coin id (not shortened): it is the on-chain provenance a developer
  // copies to look the deploy up on a block explorer (#24).
  if (result.coinId) rows.push(["On-chain coin", `\`${result.coinId}\``]);

  if (rows.length > 0) {
    lines.push("| | |");
    lines.push("|---|---|");
    for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
    lines.push("");
  }

  // --- Cost (#24) -----------------------------------------------------------
  if (result.dryRun) {
    const cost = result.costDigDisplay ?? (result.costDig != null ? `${result.costDig} DIG` : null);
    if (cost) {
      const fee = result.feeXchDisplay ? ` + up to ${result.feeXchDisplay} fee` : "";
      lines.push(`**Would cost** ${cost}${fee} — nothing spent.`);
      lines.push("");
    }
  } else if (result.spent) {
    // A real publish always costs the flat capsule price (see ROADMAP: 100 DIG).
    lines.push("**Cost** 100 DIG + a small XCH fee.");
    lines.push("");
  }

  // --- Footer ---------------------------------------------------------------
  if (shortSha) {
    lines.push(`<sub>Commit \`${shortSha}\` · deployed by the DIG Network deploy action.</sub>`);
  }
  lines.push("");
  lines.push(COMMENT_MARKER);

  return lines.join("\n");
}
