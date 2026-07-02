# deploy-action — normative specification

This document is the authoritative contract for `dig-network/deploy-action`, the official GitHub
composite Action that deploys a build to the DIG Network. It is written so an independent
reimplementation of the Action (or a consumer that reads its inputs/outputs) can be built against it
without reading the source. Requirement keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are
used in the RFC 2119 sense.

The Action wraps the `digstore` CLI: it installs `digstore`, decides preview-vs-deploy from the
triggering event, authorizes the deploy (keyless GitHub-OIDC exchange), runs `digstore deploy`,
parses the result, and reports it (step outputs + job summary + PR comment + GitHub deployment and
commit status).

---

## 1. Composition and runtime

- The Action is a **composite** Action (`runs.using: "composite"`), declared in `action.yml`.
- The JavaScript glue is plain Node ESM (`.mjs`) executed with **Node >= 20** and has **ZERO npm
  dependencies**. All HTTP (GitHub REST + GitHub OIDC + the hub exchange) uses Node 20's global
  `fetch`. A reimplementation MUST NOT introduce a runtime dependency that requires `npm install`
  or vendoring inside the Action.
- The composite steps run, in order:
  1. **Decide mode** (`src/mode.mjs`) — preview vs production; fails closed on a paid forced preview.
  2. **Funding-credential guard** — a real deploy with no `passphrase` aborts.
  3. **Install digstore** (`scripts/install-digstore.sh`) — pinned CLI resolution.
  4. **Keyless auth** (`src/auth.mjs` → `src/oidc.mjs`) — GitHub OIDC → hub session (real deploy only).
  5. **Import wallet** — `digstore seed import` when a `mnemonic` is provided (real deploy only).
  6. **Deploy** — `digstore deploy … --json`, tee'd to a temp file.
  7. **Report** (`src/report.mjs`) — runs with `if: always()`; outputs + summary + PR reporting.

---

## 2. Inputs

All inputs are optional and carry the defaults below. Every credential MUST be supplied from a
repository secret, never inline.

| Input | Default | Meaning |
|---|---|---|
| `directory` | `dist` | Built-output directory to publish (`digstore deploy --output-dir`). |
| `store-id` | `""` | 64-hex store id to advance. Falls back to the OIDC binding, then `dig.toml`. |
| `if-changed` | `true` | Skip the deploy (and spend) when the build is byte-identical to the live version. |
| `preview` | `false` | Force a preview even off the default branch. Fails closed unless `allow-paid-preview` (see §4). |
| `allow-paid-preview` | `false` | Opt in to the paid `preview: true` path while free previews (#18) are unavailable. |
| `digstore-version` | `v0.6.0` | digstore CLI version: a release tag, git ref/branch, or `latest`. |
| `keyless` | `true` | Keyless CI auth via GitHub OIDC (§3). Requires `id-token: write`. |
| `api-base` | `https://hub.dig.net/v1` | Hub control-plane API base for the OIDC exchange. |
| `writer-key` | `""` | On-chain writer delegate key (64-hex): advances root only, revocable. `DIGSTORE_WRITER_KEY`. |
| `passphrase` | `""` | Funding wallet `DIGSTORE_PASSPHRASE` — pays the on-chain fee on a real deploy. |
| `deploy-key` | `""` | §21 publisher deploy key (no spend authority). `DIGSTORE_DEPLOY_KEY`. |
| `mnemonic` | `""` | Funding wallet BIP-39 mnemonic, imported under `passphrase`. |
| `salt` | `""` | 64-hex secret salt for a private store. `DIGSTORE_STORE_SALT`. |
| `remote` | `""` | Remote to publish to (defaults to the public DIGHub). |
| `message` | `""` | Commit message for the new capsule (defaults to the deployed commit). |
| `build-command` | `""` | Optional shell build command run before deploying. |
| `wait-timeout` | `600` | Seconds to wait for on-chain confirmation (`0` = submit, don't block). |
| `comment-on-pr` | `true` | On a PR, upsert the comment and set the deployment + commit status. |
| `github-token` | `${{ github.token }}` | Token for the PR comment / deployment / commit status. |
| `working-directory` | `.` | Directory to run `digstore` from (where `dig.toml` lives). |

Inputs are passed to the deploy shell exclusively through `env:` (never interpolated into the `run:`
body), so an input value can never inject shell — this script-injection-safe pattern MUST be
preserved by any reimplementation.

---

## 3. Keyless auth — GitHub OIDC → hub CI session (`src/oidc.mjs`, `src/auth.mjs`)

Keyless auth removes the long-lived hub secret from the repo. On a real deploy (not a preview) with
`keyless: true`, the Action:

1. **Requests a GitHub Actions OIDC id-token** for a fixed audience:
   - Audience: **`dighub`** (`OIDC_AUDIENCE`). A token minted for any other audience MUST be rejected
     by the hub verifier (fail-closed).
   - Request: `GET {ACTIONS_ID_TOKEN_REQUEST_URL}&audience=dighub` with headers
     `authorization: Bearer {ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
     `accept: application/json; api-version=2.0`, `user-agent: dig-network-deploy-action`.
   - Response body MUST contain `{ "value": "<jwt>" }`; an empty/absent `value` is an error.
   - Missing `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` MUST fail with a message directing the user to
     add `permissions: id-token: write`.

2. **Exchanges the OIDC token** with the hub control plane:
   - `POST {api-base}/auth/ci/github-oidc` with `content-type: application/json`, body
     `{ "token": "<oidc-jwt>" }`. The exchange URL is formed by trimming trailing slashes from
     `api-base` and appending `/auth/ci/github-oidc`.
   - Success response: `{ "access_token": <string>, "store_id": <string>, "expires_in": <number> }`.
     A missing `access_token` is an error.
   - `403` MUST surface as an actionable error telling the user to bind the repo+ref to their store
     on the hub. `401` MUST surface as an audience/permission error. Other non-2xx surface the status
     plus any `{message}`/`{error}`/text body.

3. **Writes the on-disk session** digstore consumes, at `{DIG_IDENTITY_DIR}/session.json`, mode
   `0600`. Shape (`buildSessionJson`):
   ```json
   { "access_token": "<string>", "api_base": "<api-base, trailing slashes trimmed>",
     "obtained_at": <unix-seconds>, "expires_in": <number, optional> }
   ```
   `obtained_at` defaults to the current unix time. Fields beyond these default inside digstore.

4. **Emits `store-id`** to `$GITHUB_OUTPUT` (multiline heredoc form) so the deploy step targets the
   bound store. The deploy step prefers `steps.keyless.outputs.store-id` over the `store-id` input.

**Secrecy invariant:** the Action MUST NOT print the OIDC token, the session token, or any secret to
the log or to `$GITHUB_OUTPUT`. Only the (non-secret) `store-id` is emitted.

---

## 4. Deploy mode decision (`src/event.mjs`, `src/mode.mjs`)

`decideMode({ eventName, ref, defaultBranch, forcePreview })` returns
`{ preview: boolean, environment: "preview"|"production", forced: boolean }`:

- `forcePreview` (the `preview: true` input) → `{ preview: true, environment: "preview", forced: true }`.
- `eventName` in `{ pull_request, pull_request_target }` → preview, `forced: false`.
- `eventName` in `{ push, workflow_dispatch }` AND `ref === "refs/heads/{defaultBranch}"` →
  `{ preview: false, environment: "production", forced: false }`.
- Everything else → preview, `forced: false` (a non-default-branch push never triggers a surprise
  spend).

**Fail-closed paid-preview guard** (`previewSpendGuard({ forcePreview, allowPaidPreview })`): because
free no-spend previews (#18) are not yet available, an EXPLICIT `preview: true` input would still
publish a real (paid) capsule. Therefore:

- When the preview was **forced by the input** (`forced === true`) and `allow-paid-preview` is not
  set → `{ blocked: true, reason: <message> }`. `mode.mjs` MUST exit non-zero before any
  install/deploy/spend and emit `paid-preview-blocked=true`.
- An **event-derived** preview (a PR, or a non-default push) MUST NEVER be blocked.

`mode.mjs` reads the event from `DIG_EVENT_NAME` / `DIG_REF` / `DIG_DEFAULT_BRANCH` (the reserved
`GITHUB_*` vars cannot be overridden by a step `env:`), `DIG_FORCE_PREVIEW`, and
`DIG_ALLOW_PAID_PREVIEW` (each truthy on `/^(1|true|yes)$/i`). It writes `key=value` lines to
`$GITHUB_OUTPUT`: `preview`, `environment`, `forced-preview`, `paid-preview-blocked`.

**Funding-credential guard:** a non-preview deploy with an empty `passphrase` MUST abort with a clear
error before installing/deploying (previews are free and need no credential).

---

## 5. Running digstore

The deploy step invokes digstore non-interactively (`digstore --non-interactive --yes …`), always in
`--json` mode, and tees stdout to `${RUNNER_TEMP}/dig-deploy.json`, exposing the path as the step
output `json-file`.

- **Preview** (`preview=true`): `deploy --output-dir <dir> --json --preview [--build-command <cmd>]`.
  No store id / key / wallet is used.
- **Real deploy** (`preview=false`): `deploy --output-dir <dir> --json` plus, when set,
  `--if-changed`, `--store-id`, `--remote`, `--message`, `--build-command`, `--wait-timeout`. The
  on-chain root advance uses `DIGSTORE_WRITER_KEY`; the head push uses the keyless session (or
  `DIGSTORE_DEPLOY_KEY`); the fee is paid under `DIGSTORE_PASSPHRASE`.

### 5.1 digstore install (`scripts/install-digstore.sh`)

Given a version (a release tag such as `v0.6.0`, a git ref/branch, or `latest`), resolution order:

1. A prebuilt headless-CLI asset `digstore-<os>-<arch>[.exe]` attached to the pinned GitHub Release
   of `DIG-Network/digstore` (fast path; a no-op until the public installer publishes such assets).
2. `cargo install --git … --tag <tag> --locked digstore-cli` (or `--branch` for `latest` → `main`),
   installing a Rust toolchain first if absent, and adding the `wasm32-unknown-unknown` target
   (digstore-cli's `build.rs` embeds the guest wasm).

OS is derived from `RUNNER_OS` (fallback `uname -s`); arch from `uname -m` (`x86_64`/`aarch64`).

---

## 6. Parsing `digstore deploy --json` (`src/parse.mjs`)

digstore's `--json` mode does NOT emit one merged object: it prints several pretty-printed top-level
JSON objects back-to-back on stdout, possibly interleaved with non-JSON human/log lines.

- `extractJsonObjects(stdout)` MUST perform a brace-balanced, string/escape-aware scan and return
  every top-level `{…}` object in stream order, skipping non-JSON noise without throwing.
- `parseDeployJson(stdout)` merges all objects (later objects win on key overlap; e.g. a trailing
  `{ hub_url }` block augments the commit block) and normalizes to the camelCase result in §6.1. It
  MUST throw a clear "no JSON" error when no object is present.

The recognized digstore emit shapes are:

- **Successful publish:** a commit block `{ root, capsule, module, size, coin_id, anchor_status,
  mocked, pushed, claimed | push_error }` followed by a separate `{ hub_url }` block.
- **`--if-changed` no-op:** `{ skipped: true, reason, root, capsule, store_id, spent: false,
  pushed: false }`.
- **`--dry-run`:** `{ dry_run: true, root, capsule, store_id, cost_dig, cost_dig_display,
  fee_xch_mojos, fee_xch_display, spent: false, hub_url? }`.
- **`--preview` free build:** `{ preview: true, spent: false, mocked, root, store_id, capsule,
  content_address, artifact, artifact_size, resources }` — an EPHEMERAL preview store
  (content-derived id), no chain, no spend.

### 6.1 Normalized result shape

`parseDeployJson` returns:

```
capsule?, root?, storeId?, coinId?, hubUrl?, chiaUrl?, digUrl?, urn?,
pushed: boolean, pushError?, spent: boolean, skipped: boolean, reason?,
dryRun: boolean, preview: boolean, contentAddress?, artifact?,
costDig?, costDigDisplay?, feeXchMojos?, feeXchDisplay?, anchorStatus?, mocked?
```

Derivation rules (MUST hold):

- `storeId` = `store_id`, else the `<storeId>` prefix of a `storeId:rootHash` capsule.
- `spent` = the explicit `spent` when the CLI emits one; otherwise `!skipped && !dryRun && !preview`
  (a real publish anchors on-chain and therefore spent even when the block omits `spent`).
- `chiaUrl` = `chia://<storeId>/` when a store id is known (rootless = latest tip) — the user-facing
  content-open scheme the DIG Browser/extension register. It mirrors digstore's own `chia_url`.
- `digUrl` = the SAME `chia://` value as `chiaUrl` — a DEPRECATED back-compat alias. It is NOT the
  §21 remote `dig://` locator (a distinct concept).
- `urn` = `urn:dig:chia:<storeId>[:<root>]` — the root-pinned URN permalink. The `urn:dig:` namespace
  is exempt from the user-facing `chia://` rename.
- `contentAddress` = the CLI's `content_address` (a `chia://` address), passed through unchanged.

### 6.2 Outcome enum

`OUTCOMES` is a frozen, catalogued set an agent branches on instead of scraping `::error::` lines:

```
success | skipped | preview | dry-run | anchor-failed | push-failed | timed-out |
no-credential | unauthorized | oidc-error | blocked-paid-preview | failed
```

`computeOutcome(result)` maps a parsed result: `timedOut`→`timed-out`; `skipped`→`skipped`;
`preview`→`preview`; `dryRun`→`dry-run`; `pushError`→`push-failed`; `spent && pushed === false`
→`anchor-failed`; else `success`. The pre-deploy causes (`no-credential`, `unauthorized`,
`oidc-error`, `blocked-paid-preview`, `failed`) are set by the report step from `DIG_PRIOR_OUTCOME`
when no deploy JSON exists.

`failureReason(result)` returns a human/machine string for `timed-out`, `push-failed`, and
`anchor-failed`, else `""`.

### 6.3 Step outputs (`toOutputs`)

`toOutputs(result)` maps the normalized result to string-valued, kebab-case outputs (GitHub Actions
outputs are always strings; null/undefined → `""`). The keys MUST match the `outputs:` declared in
`action.yml` (enforced in CI by `.github/scripts/check-action.mjs`, with `environment` sourced from
the mode step):

```
capsule, root, store-id, chia-url, dig-url, urn, hub-url, coin-id, content-address,
skipped, spent, pushed, preview, json, outcome, failure-reason
```

- `json` is the whole normalized result plus `outcome` (and `failureReason` when non-empty) as ONE
  JSON blob, so a consumer can `JSON.parse` once instead of re-stitching scalars. Adding a new field
  to the result MUST NOT require declaring a new scalar output — it appears inside `json`.
- `outcome` and `failure-reason` are the catalogued §6.2 values.
- `environment` (`preview`|`production`) is emitted by the mode step, not `toOutputs`.

---

## 7. Reporting (`src/report.mjs`, `src/comment.mjs`, `src/github.mjs`, `src/rest.mjs`)

The report step runs with `if: always()` so a catalogued outcome is written even on the failure path.

- **No deploy JSON** (a pre-deploy guard/auth/deploy failure aborted before any result): report emits
  the failure outcome + reason from the `DIG_PRIOR_OUTCOME` / `DIG_PRIOR_REASON` hints (an
  unrecognized `DIG_PRIOR_OUTCOME` falls back to `failed`), writes a summary line, and exits 1.
- **With a result:** report writes all step outputs, appends a job-summary block, and — on a PR when
  `comment-on-pr` is on, a `github-token` is present, and a PR number is resolvable from the event
  payload — upserts the PR comment and creates the GitHub deployment + statuses.
- **Best-effort PR reporting:** a reporting failure (e.g. a missing token scope, a GitHub API error)
  MUST NOT fail a deploy that already succeeded — those calls are wrapped and downgraded to a warning.
- **Hard failure:** the Action exits 1 only when the DEPLOY itself failed (`statusState(result) ===
  "failure"`) — a push error, or anchored-but-not-pushed — so CI goes red on a broken deploy. A
  `skipped` no-op and a `dry-run` are successes.

### 7.1 PR comment body (`src/comment.mjs`)

`buildCommentBody({ result, sha, preview })` returns GitHub-flavored Markdown. It is pure (no I/O),
so it is fully unit-testable. Invariants:

- It MUST end with the hidden marker `<!-- dig-network/deploy-action -->` (`COMMENT_MARKER`), which
  is how the Action finds and UPDATES its own prior comment (upsert — one comment per PR).
- The header branches on the result: free preview / skipped no-op / dry-run / anchored-but-push-failed
  / (forced) preview / live deployment.
- A free preview MUST show the shareable `content_address` and NO cost line; a real publish MUST show
  the `$DIG` per-capsule cost sigil (never a hardcoded amount) plus a small XCH fee; a skipped/dry-run
  MUST state nothing was spent.
- The open address shown to users is the `chia://` content-open URL; a bare `dig://` open URL MUST NOT
  appear.

### 7.2 GitHub side effects (`src/github.mjs`)

- `statusState(result)`: `failure` when `timedOut`, when `pushError`, or when
  `pushed === false && spent`; otherwise `success`.
- `upsertComment(rest, {owner, repo, issue_number, body})`: lists issue comments, and if one contains
  `COMMENT_MARKER`, PATCHes it; otherwise POSTs a new one. Idempotent per PR.
- `reportDeployment(rest, {owner, repo, sha, environment, result, context})`: creates a GitHub
  Deployment (`transient_environment: true` for non-production so previews auto-inactivate), a
  Deployment Status, and a commit Status on the sha (the merge-gating signal). Each call is
  independent and best-effort: one failing (e.g. missing `deployments: write`) MUST NOT abort the
  others. Descriptions are truncated to 140 chars; `environment_url`/`target_url` = the hub URL when
  present.

### 7.3 REST client (`src/rest.mjs`)

`makeRest(token)` returns an object whose `.rest` matches the Octokit subset the Action calls
(`issues.listComments|createComment|updateComment`, `repos.createDeployment|createDeploymentStatus|
createCommitStatus`), each returning `{ data }`. It uses `fetch` against `GITHUB_API_URL`
(default `https://api.github.com`) with headers `accept: application/vnd.github+json`,
`authorization: Bearer <token>`, `x-github-api-version: 2022-11-28`, `content-type: application/json`,
`user-agent: dig-network-deploy-action`. A non-2xx response MUST throw an `Error` whose `.status` is
the HTTP status and whose message carries the GitHub `{message}` when present (else `status
statusText`). An empty body yields `data: undefined`. The shape is interchangeable with a mocked
Octokit `.rest`, so the same code path serves tests and production.

---

## 8. Security properties

- **No static hub secret in the repo:** the head push is authorized by the per-run keyless OIDC
  session (§3). A long-lived secret path remains available only when `keyless: false`.
- **Least-privilege credentials:** the `writer-key` advances the on-chain root ONLY (never owner,
  never melt; revocable). The funding wallet (`passphrase` + `mnemonic`) only PAYS the fee and is
  needed solely on a real deploy. Previews require no OIDC, no writer-key, and no wallet.
- **Secret hygiene:** tokens are never logged or emitted; the session file is `0600`; inputs reach
  the shell only via `env:` (injection-safe).
- **Merge-gating:** a failed/timed-out anchor or push sets a `failure` commit status (a red X) so a
  broken deploy can block merge.

---

## 9. Versioning

The Action follows the standard major-tag convention: reference `DIG-Network/deploy-action@v1` for
the latest v1.x; a floating `v1` tag moves forward to each v1.x release; pin an exact tag or commit
SHA for reproducibility. The first `@v1` is human-gated; pin to a commit SHA until it ships. The
`digstore-version` default (`v0.6.0`) is the minimum carrying the keyless writer deploy-key
(`--writer-key`) and the free `deploy --preview` path.

---

## 10. Conformance

- CI (`.github/workflows/ci.yml`) runs the unit suite (`node --test`), the coverage gate
  (`.github/scripts/coverage-gate.mjs`, >= 80% lines per shipped `src/` module and overall), the
  `action.yml`↔`toOutputs` contract check (`.github/scripts/check-action.mjs`), `shellcheck`, and
  `actionlint`.
- The smoke workflow (`.github/workflows/smoke.yml`) exercises the composite glue and the full
  keyless path (OIDC request → exchange → session write → `store-id` emit) against a LOCAL echo
  server — no real GitHub OIDC, no real hub, no secrets.
- `action.yml`'s declared `outputs:` keys MUST exactly match the keys `toOutputs()` emits (plus the
  mode-sourced `environment`); a drift fails CI.
- The `chia://` open URL, the `urn:dig:chia:<store>:<root>` grammar, and the `$DIG` per-capsule
  pricing sigil are shared ecosystem contracts and MUST agree with digstore, hub.dig.net, and the
  docs.dig.net protocol pages.
