// Tests for the keyless GitHub-OIDC → dighub CI-session exchange (#23).
//
// The action requests a GitHub Actions OIDC id-token (audience=dighub), exchanges
// it with the hub control plane for a short-lived, store-scoped session, and
// writes that session where digstore reads it. The wire shapes here are pinned to
// what shipped in hub.dig.net:
//   - request:  POST <api-base>/auth/ci/github-oidc  { "token": "<jwt>" }
//     (services/api/src/aws/router.rs route ["auth","ci","github-oidc"];
//      services/api/src/dto.rs GithubOidcRequest)
//   - response: { "access_token", "store_id", "expires_in" }  (dto.rs GithubOidcResponse)
//   - the OIDC audience MUST be "dighub" (dighub-core constants GITHUB_OIDC_AUDIENCE).
//   - the on-disk session digstore consumes (ops/dighub.rs Session) is:
//     { access_token, api_base, obtained_at, expires_in, account_ph?, handle? }.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OIDC_AUDIENCE,
  exchangeUrl,
  requestOidcToken,
  exchangeOidc,
  buildSessionJson,
} from "../src/oidc.mjs";

const API = "https://hub.dig.net/v1";

test("the OIDC audience is pinned to dighub (matches GITHUB_OIDC_AUDIENCE)", () => {
  // The hub verifier pins aud=dighub; a token minted for any other audience fails closed.
  assert.equal(OIDC_AUDIENCE, "dighub");
});

test("exchangeUrl joins the api base and the exchange route, tolerating a trailing slash", () => {
  assert.equal(exchangeUrl(API), `${API}/auth/ci/github-oidc`);
  assert.equal(exchangeUrl(`${API}/`), `${API}/auth/ci/github-oidc`);
});

test("requestOidcToken calls the Actions token endpoint with audience=dighub and Bearer auth", async () => {
  const seen = { url: undefined, headers: undefined };
  const fakeFetch = async (url, opts) => {
    seen.url = url;
    seen.headers = opts?.headers ?? {};
    return {
      ok: true,
      status: 200,
      async json() {
        return { value: "the.jwt.token" };
      },
      async text() {
        return JSON.stringify({ value: "the.jwt.token" });
      },
    };
  };
  const tok = await requestOidcToken({
    requestUrl: "https://pipelines.actions.example/idtoken?api-version=2.0",
    requestToken: "runtime-bearer",
    fetchImpl: fakeFetch,
  });
  assert.equal(tok, "the.jwt.token");
  assert.match(seen.url, /audience=dighub/, "must request the dighub audience");
  assert.equal(seen.headers.authorization, "Bearer runtime-bearer");
});

test("requestOidcToken fails clearly when id-token permission is missing", async () => {
  await assert.rejects(
    () =>
      requestOidcToken({
        requestUrl: "",
        requestToken: "",
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      }),
    /id-token: write|ACTIONS_ID_TOKEN_REQUEST/i,
    "missing OIDC request env must point the user at permissions: id-token: write",
  );
});

test("exchangeOidc posts the token and returns the scoped session fields", async () => {
  const seen = { url: undefined, body: undefined, headers: undefined };
  const fakeFetch = async (url, opts) => {
    seen.url = url;
    seen.headers = opts?.headers ?? {};
    seen.body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: "scoped.session.jwt",
          store_id: "a".repeat(64),
          expires_in: 900,
        };
      },
      async text() {
        return "";
      },
    };
  };
  const out = await exchangeOidc({
    apiBase: API,
    token: "the.jwt.token",
    fetchImpl: fakeFetch,
  });
  assert.equal(seen.url, `${API}/auth/ci/github-oidc`);
  assert.equal(seen.body.token, "the.jwt.token", "sends { token } per GithubOidcRequest");
  assert.equal(seen.headers["content-type"], "application/json");
  assert.equal(out.accessToken, "scoped.session.jwt");
  assert.equal(out.storeId, "a".repeat(64));
  assert.equal(out.expiresIn, 900);
});

test("exchangeOidc surfaces a 403 (no binding) as a clear, actionable error", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    async json() {
      return { error: "Forbidden", message: "no project is bound to this repository + ref" };
    },
    async text() {
      return JSON.stringify({ message: "no project is bound to this repository + ref" });
    },
  });
  await assert.rejects(
    () => exchangeOidc({ apiBase: API, token: "x", fetchImpl: fakeFetch }),
    /bound|binding|repo-binding/i,
    "an unbound repo must tell the user to register a repo binding",
  );
});

test("buildSessionJson produces the on-disk Session shape digstore reads", () => {
  const now = 1_700_000_000;
  const s = JSON.parse(
    buildSessionJson({
      accessToken: "scoped.session.jwt",
      apiBase: API,
      expiresIn: 900,
      now,
    }),
  );
  // Fields digstore's ops/dighub.rs Session expects (others default).
  assert.equal(s.access_token, "scoped.session.jwt");
  assert.equal(s.api_base, API);
  assert.equal(s.obtained_at, now);
  assert.equal(s.expires_in, 900);
});
