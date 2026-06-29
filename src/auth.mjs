#!/usr/bin/env node
// Keyless auth entrypoint: the composite action shells into this BEFORE the
// deploy. It performs the GitHub-OIDC → dighub CI-session exchange (#23) and
// writes the resulting short-lived, store-scoped session where digstore reads it,
// so the §21 head push to DIGHUb is authorized WITHOUT a static secret in the repo.
//
// Steps:
//   1. Request a GitHub Actions OIDC id-token for audience=dighub
//      (needs `permissions: id-token: write`).
//   2. Exchange it at <api-base>/auth/ci/github-oidc for { access_token, store_id }.
//   3. Write <DIG_IDENTITY_DIR>/session.json (the on-disk shape digstore consumes).
//   4. Emit `store-id` to $GITHUB_OUTPUT so the deploy step targets the bound store.
//
// It writes ONLY the session token to disk (owner-readable) and NEVER prints the
// OIDC token, the session token, or any secret.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  OIDC_AUDIENCE,
  requestOidcToken,
  exchangeOidc,
  buildSessionJson,
} from "./oidc.mjs";

function emitOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `__dig_eof_${Math.random().toString(36).slice(2)}__`;
  writeFileSync(file, `${key}<<${delim}\n${value}\n${delim}\n`, { flag: "a" });
}

async function main() {
  const apiBase = (process.env.DIG_API_BASE || "https://hub.dig.net/v1").trim();
  const identityDir = process.env.DIG_IDENTITY_DIR;
  if (!identityDir) {
    throw new Error("DIG_IDENTITY_DIR is not set (the action must set it before keyless auth)");
  }

  // 1. OIDC token (audience=dighub).
  const oidcToken = await requestOidcToken({
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: OIDC_AUDIENCE,
  });

  // 2. Exchange for a scoped CI session bound to the store.
  const { accessToken, storeId, expiresIn } = await exchangeOidc({
    apiBase,
    token: oidcToken,
  });

  // 3. Persist the session where digstore looks (owner-readable; mode 0600 on POSIX).
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(join(identityDir, "session.json"), buildSessionJson({ accessToken, apiBase, expiresIn }), {
    mode: 0o600,
  });

  // 4. Hand the bound store id to the deploy step (never prints the token).
  if (storeId) emitOutput("store-id", storeId);
  console.log(
    `Keyless dighub session acquired for store ${storeId || "(unspecified)"} ` +
      `(expires in ${expiresIn ?? "?"}s).`,
  );
}

main().catch((err) => {
  console.error(`::error::keyless OIDC auth failed: ${err.message}`);
  process.exitCode = 1;
});
