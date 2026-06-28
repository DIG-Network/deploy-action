// Keyless CI auth: GitHub-OIDC → dighub CI-session exchange (#23).
//
// Instead of shipping a long-lived dighub secret into the repo, the action
// presents the workflow's short-lived GitHub Actions OIDC id-token. The hub
// control plane verifies it (signature + issuer + audience + expiry, fail-closed
// against GitHub's JWKS) and, if the repo+ref is bound to a store by its owner,
// mints a short-lived store-scoped dighub session. That session authorizes the
// §21 head push to DIGHub — there is NO static secret in the repo.
//
// Wire contract (pinned to hub.dig.net as shipped):
//   - OIDC token is requested with audience=dighub          (dighub-core GITHUB_OIDC_AUDIENCE)
//   - exchange:  POST <api-base>/auth/ci/github-oidc { token }        (router + dto GithubOidcRequest)
//   - response:  { access_token, store_id, expires_in }               (dto GithubOidcResponse)
//   - the on-disk session digstore consumes (digstore ops/dighub.rs Session):
//       { access_token, api_base, obtained_at, expires_in }
//
// This module is pure logic over an injectable `fetch`, so it is unit-tested
// without any network (the action passes Node 20's global `fetch`).

/**
 * The OIDC audience the hub verifier pins (`GITHUB_OIDC_AUDIENCE = "dighub"`).
 * A token minted for any other audience fails the hub's fail-closed check.
 */
export const OIDC_AUDIENCE = "dighub";

/** The hub control-plane route that exchanges an OIDC token for a CI session. */
const EXCHANGE_PATH = "/auth/ci/github-oidc";

/** Join the dighub API base and the exchange route (tolerating a trailing slash). */
export function exchangeUrl(apiBase) {
  return `${String(apiBase ?? "").replace(/\/+$/, "")}${EXCHANGE_PATH}`;
}

/**
 * Request a GitHub Actions OIDC id-token for `audience=dighub`.
 *
 * In a workflow with `permissions: id-token: write`, the runner exposes
 * `ACTIONS_ID_TOKEN_REQUEST_URL` + `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; GET-ing the
 * URL (with the runtime bearer) and the requested audience returns `{ value }` —
 * the signed JWT. Missing env means the permission was not granted.
 *
 * @param {object} args
 * @param {string} args.requestUrl    ACTIONS_ID_TOKEN_REQUEST_URL
 * @param {string} args.requestToken  ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @param {string} [args.audience]    OIDC audience (default "dighub")
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<string>} the raw OIDC id-token (a JWT)
 */
export async function requestOidcToken({
  requestUrl,
  requestToken,
  audience = OIDC_AUDIENCE,
  fetchImpl = fetch,
} = {}) {
  if (!requestUrl || !requestToken) {
    throw new Error(
      "no OIDC token available: ACTIONS_ID_TOKEN_REQUEST_URL / _TOKEN are unset. " +
        "Add `permissions: id-token: write` to the job so GitHub issues a keyless OIDC token.",
    );
  }
  const sep = requestUrl.includes("?") ? "&" : "?";
  const url = `${requestUrl}${sep}audience=${encodeURIComponent(audience)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${requestToken}`,
      accept: "application/json; api-version=2.0",
      "user-agent": "dig-network-deploy-action",
    },
  });
  if (!res.ok) {
    const detail = await safeMessage(res);
    throw new Error(`OIDC token request failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const body = await res.json();
  const token = body && typeof body.value === "string" ? body.value : "";
  if (!token) {
    throw new Error("OIDC token request returned no `value` (token)");
  }
  return token;
}

/**
 * Exchange a verified OIDC token with the hub for a store-scoped CI session.
 *
 * @param {object} args
 * @param {string} args.apiBase  e.g. https://hub.dig.net/v1
 * @param {string} args.token    the OIDC id-token
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{ accessToken: string, storeId: string, expiresIn: number }>}
 */
export async function exchangeOidc({ apiBase, token, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(exchangeUrl(apiBase), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "dig-network-deploy-action",
    },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const detail = await safeMessage(res);
    // Make the most common failure (no repo binding) self-explanatory.
    if (res.status === 403) {
      throw new Error(
        `keyless deploy not authorized (403)${detail ? `: ${detail}` : ""}. ` +
          "Bind this repository + ref to your store on hub.dig.net " +
          "(Project → Settings → CI deploy → add a repo binding) so OIDC can mint a session.",
      );
    }
    if (res.status === 401) {
      throw new Error(
        `OIDC token rejected by the hub (401)${detail ? `: ${detail}` : ""}. ` +
          "Ensure the token audience is `dighub` and the job has `id-token: write`.",
      );
    }
    throw new Error(`OIDC exchange failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const body = await res.json();
  const accessToken = body?.access_token ?? "";
  const storeId = body?.store_id ?? "";
  const expiresIn = typeof body?.expires_in === "number" ? body.expires_in : undefined;
  if (!accessToken) {
    throw new Error("OIDC exchange returned no access_token");
  }
  return { accessToken, storeId, expiresIn };
}

/**
 * Build the on-disk dighub session JSON digstore reads from its identity dir
 * (`session.json`). Matches digstore's `ops/dighub.rs` `Session` struct; only the
 * fields the keyless flow has are set (the rest default in digstore).
 *
 * @param {object} args
 * @param {string} args.accessToken
 * @param {string} args.apiBase
 * @param {number} [args.expiresIn]
 * @param {number} [args.now]  unix seconds (defaults to now)
 * @returns {string} pretty JSON to write to <identity-dir>/session.json
 */
export function buildSessionJson({ accessToken, apiBase, expiresIn, now } = {}) {
  const obtained_at = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const session = {
    access_token: accessToken,
    api_base: String(apiBase ?? "").replace(/\/+$/, ""),
    obtained_at,
  };
  if (expiresIn !== undefined) session.expires_in = expiresIn;
  return `${JSON.stringify(session, null, 2)}\n`;
}

/** Best-effort human message from an error response body ({message}|{error}|text). */
async function safeMessage(res) {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const j = JSON.parse(text);
      return j?.message || j?.error || text;
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}
