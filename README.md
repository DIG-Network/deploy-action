# `dig-network/deploy-action`

Official GitHub Action to deploy a build to the **DIG Network** on Chia — git-push-to-deploy.

It installs the [`digstore`](https://github.com/DIG-Network/digstore) CLI, runs `digstore deploy`
on your built output, and reports the published **capsule**, its URLs, and the cost back on the
pull request (a PR comment + a GitHub deployment + a commit status). Push to your default branch
and your site advances to a new on-chain version, served by a network no host can read, change, or
take down.

> **Status: pre-release.** This action is built and tested but **not yet tagged `@v1`** — a human
> gates the first release. See [Versioning](#versioning). Pin to a commit SHA until `@v1` ships.

---

## What it does

It does the right thing for the event automatically:

- **On a pull request → a free preview.** Runs `digstore deploy --preview` — your build is compiled
  and verified through the real `dig://` read path, producing a shareable, content-addressed preview.
  **No chain, no wallet, no spend.** The preview address is commented on the PR.
- **On a push to your default branch → a real deploy.** Runs `digstore deploy --if-changed` — it
  advances the store's on-chain root and publishes the new capsule to DIGHub, then sets a GitHub
  deployment status and comments the live URL.

Under the hood, on a real deploy it:

1. Installs the pinned `digstore` CLI on the runner.
2. **Authorizes the deploy keylessly** — exchanges the job's GitHub **OIDC** token (`audience=dighub`)
   for a short-lived, store-scoped dighub session. **No long-lived dighub secret lives in the repo.**
3. Advances the on-chain root with a **writer deploy-key** (a revocable, writer-delegated key that can
   change only the metadata root — never the owner, never melt), and publishes the capsule to DIGHub
   over the keyless session.
4. Parses the result and exposes the **capsule**, root, store id, `dig://` URL, URN, hub URL, on-chain
   coin id (and, for a preview, the **content address**) as step outputs.
5. Upserts a PR comment with the capsule + URLs + cost, creates a GitHub Deployment, and sets a commit
   status (a red X if the on-chain anchor or hub push failed/timed out — so a broken deploy can block
   merge).

You create the store once (`digstore init`, which mints it and spends **$DIG**). This action only
**advances** an existing store — it never mints. Each real deploy is a new capsule costing **$DIG**
(a per-capsule price) **+ a small XCH fee**, paid from your deploy wallet. **PR previews are free.**

---

## Usage

One workflow handles both: a **free preview on every PR** and a **real deploy on push to your
default branch**. The action picks the mode from the event — you don't configure it.

```yaml
name: Deploy to DIG
on:
  push:
    branches: [main]      # real deploy
  pull_request:           # free preview

permissions:
  contents: read
  id-token: write         # KEYLESS auth — exchange the OIDC token (no dighub secret)
  pull-requests: write    # comment the preview / live URL on the PR
  deployments: write      # the GitHub Deployment + commit status

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci && npm run build         # produces ./dist

      - name: Deploy to DIG
        id: dig
        uses: DIG-Network/deploy-action@v1   # pin to @v1 once released (SHA until then)
        with:
          directory: dist
          digstore-version: v0.6.0           # PIN for reproducible CI (carries #17/#18)
          # KEYLESS: no dighub secret. The on-chain spend still needs a funding wallet:
          writer-key: ${{ secrets.DIG_WRITER_KEY }}   # advances the root (revocable, root-only)
          passphrase: ${{ secrets.DIGSTORE_PASSPHRASE }}  # funds the $DIG + XCH fee
          mnemonic:   ${{ secrets.DIG_MNEMONIC }}
          # store-id comes from the OIDC binding (or dig.toml). Pass store-id: to override.

      - run: echo "Deployed ${{ steps.dig.outputs.capsule }} -> ${{ steps.dig.outputs.hub-url }}"
```

- **PRs** run `digstore deploy --preview`: a **free**, content-addressed build verified through the
  real `dig://` read path. No `id-token`/wallet is needed for a preview, but keeping the keyless
  permissions on the one job lets the same workflow also deploy on push. The preview address is
  output as `content-address` and commented on the PR.
- **Pushes to the default branch** run `digstore deploy --if-changed`: a push whose build is
  byte-identical to the live version is a **no-op** (no spend, nothing published), so it is safe to
  run on every push.
- A push to a **non-default** branch previews (never a surprise spend).
- The explicit `preview: true` input **fails closed**: until free no-spend previews (#18) ship,
  `--preview` would still publish a real (paid) capsule, so a flag named "preview" must not silently
  spend. Set `allow-paid-preview: true` to deliberately publish a paid build from `preview: true`.
  (The automatic PR / non-default-branch preview is event-derived and never blocked.)

### Keyless auth — one-time binding

Keyless auth removes the long-lived dighub secret from your repo. CI presents the workflow's
short-lived GitHub **OIDC** token; the hub verifies it (fail-closed against GitHub's JWKS) and, if
your repo + ref is **bound to your store**, mints a short-lived store-scoped session for the push.

Register the binding once (owner-only), then no dighub secret is ever stored in the repo:

- In the hub: **Project → Settings → CI deploy → add a repo binding** for `owner/repo` + the git ref
  (defaults to `refs/heads/main`).

If the repo isn't bound, the action fails with a clear `403` pointing you here.

---

## Security

There are three distinct credentials. Two of them are **keyless / spend-limited**; only the funding
wallet can spend, and that is needed solely on a real deploy (never for a preview):

| Credential | What it can do | How it's provided |
|---|---|---|
| **Keyless OIDC session** | Authorize the DIGHub head push for the bound store | Minted per-run from the GitHub OIDC token — **no secret in the repo** |
| **Writer deploy-key** (`writer-key`) | Advance the store's **on-chain root only** — never change owner, never melt; **revocable** | Repo secret |
| **Funding wallet** (`passphrase` + `mnemonic`) | **Pay** the $DIG + XCH fee for a real deploy | Repo secret |

> [!CAUTION]
> **The funding wallet's seed can spend all of that wallet's DIG and XCH.** It only signs the
> *payment* for the on-chain root update (the writer-key authorizes the change itself), but protect
> it anyway:
>
> - Use a **dedicated deploy wallet**, never your main wallet.
> - Fund it with only **enough $DIG for your expected deploys** (each real deploy = a per-capsule $DIG price + a fee).
> - Store it as GitHub **encrypted secrets** — never in `dig.toml` or any committed file.
> - **PR previews are free and need none of these** — no OIDC, no writer-key, no wallet.

The **publisher deploy-key** (`deploy-key`) is the §21 head-push credential (no spend authority); in
keyless mode the OIDC session covers the push, so you usually don't need it. It remains available for
self-hosted remotes or when not using keyless auth.

### One-time setup

On the machine where you created the store:

```sh
digstore log --json          # copy the "store_id" field (or set it in dig.toml)
```

1. **Bind the repo to your store (keyless):** in the hub, **Project → Settings → CI deploy → add a
   repo binding** for `owner/repo` + ref. No secret is generated — the binding is what authorizes the
   OIDC exchange.
2. **Authorize a writer deploy-key** for CI (hub Teams → add a "Deployer"), and store it as a secret.
3. **Add the funding wallet** as secrets.

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DIG_WRITER_KEY` | The 64-hex writer deploy-key that advances the store's root (revocable, root-only) |
| `DIGSTORE_PASSPHRASE` | The passphrase that unlocks the funding wallet's seed in CI |
| `DIG_MNEMONIC` | The dedicated funding wallet's BIP-39 mnemonic |

And commit a `dig.toml` to your repo root (so `output-dir` etc. don't have to be passed; `store-id` is
resolved from the OIDC binding but may also be pinned here):

```toml
store-id   = "<your 64-hex store id>"
output-dir = "dist"
# build-command = "npm ci && npm run build"   # optional
```

---

## Inputs

| Input | Default | Description |
|---|---|---|
| `directory` | `dist` | The built-output directory to publish. |
| `store-id` | OIDC binding / `dig.toml` | The 64-hex store id to advance. Resolved from the keyless OIDC binding when available. |
| `if-changed` | `true` | Skip the deploy (and the spend) when the build is byte-identical to the live version. |
| `preview` | `false` | Force a preview (`--preview`) even on a default-branch push. PRs preview automatically. **Fails closed** unless `allow-paid-preview: true` (see below) — a flag named "preview" must not silently spend. |
| `allow-paid-preview` | `false` | Opt in to the paid `preview: true` path while free no-spend previews (#18) are unavailable. Required **only** when you set `preview: true`. No effect on the automatic event-based preview. |
| `digstore-version` | `v0.6.0` | The `digstore` CLI version: a release tag, git ref/branch, or `latest`. **Pin this.** Needs #17/#18 (>= `v0.6.0`). |
| `keyless` | `true` | Keyless CI auth: exchange the GitHub OIDC token (`audience=dighub`) for a store-scoped session — no dighub secret. Needs `id-token: write`. |
| `api-base` | `https://hub.dig.net/v1` | The dighub control-plane API base for the OIDC exchange. |
| `writer-key` | — | The on-chain **writer** deploy-key (64-hex): advances the root only, revocable. `DIGSTORE_WRITER_KEY`. |
| `passphrase` | — | The funding wallet's `DIGSTORE_PASSPHRASE` — pays the on-chain fee on a real deploy. **Use a dedicated wallet.** |
| `deploy-key` | — | The store's 64-hex §21 publisher deploy key (no spend authority). Usually unneeded with keyless. |
| `mnemonic` | — | The funding wallet's BIP-39 mnemonic, imported under `passphrase`. |
| `salt` | — | Secret salt (64-hex) for a **private** store. Omit for public stores. |
| `remote` | public DIGHub | The remote to publish to (e.g. `dig://<store-id>` or a node URL). |
| `message` | the commit | Commit message for the new capsule. |
| `build-command` | — | Optional shell build command to run before deploying. |
| `wait-timeout` | `600` | Seconds to wait for on-chain confirmation (0 = don't block). |
| `comment-on-pr` | `true` | On a PR, upsert the comment and set the deployment + commit status. |
| `github-token` | `${{ github.token }}` | Token for the PR comment / deployment / commit status. |
| `working-directory` | `.` | Directory to run `digstore` from (where `dig.toml` lives). |

All credentials should be passed from **repo secrets**, never inline.

## Outputs

| Output | Description |
|---|---|
| `capsule` | The published capsule: `storeId:rootHash`. |
| `root` | The new on-chain root hash. |
| `store-id` | The store id that was advanced. |
| `dig-url` | The `dig://` URL of the deployment (rootless = latest tip). |
| `urn` | The root-pinned URN permalink (`urn:dig:chia:<store>:<root>`). |
| `hub-url` | The DIGHub URL for the store (`https://hub.dig.net/stores/<id>`). |
| `coin-id` | The on-chain coin id of the anchored root. |
| `content-address` | On a `--preview` build: the shareable root-pinned `dig://` address. Empty on a real deploy. |
| `preview` | `true` when this run produced a free preview (a PR), not a real on-chain deploy. |
| `skipped` | `true` when `--if-changed` skipped a no-op deploy. |
| `spent` | `true` when the deploy spent $DIG (a real publish). |
| `pushed` | `true` when the capsule was published to the hub. |
| `json` | The whole normalized deploy result (incl. `outcome`) as **one JSON blob** — parse this once instead of re-stitching the scalar outputs. |
| `outcome` | The catalogued result (see [Outcome enum](#outcome-enum)). Branch on this instead of scraping logs. Written even on the failure path. |
| `failure-reason` | A reason string when `outcome` is a failure; empty otherwise. |
| `environment` | The resolved environment: `preview` or `production` (from the event mode). |

> Note: `*.on.dig.net` is an **optional, user-chosen** human domain you register for a store; it is
> not derivable from a deploy, so the action surfaces the always-available `hub-url` and `dig://`
> URL instead. If you have a registered domain, your site is also live at `<your-name>.on.dig.net`.

### Outcome enum

`outcome` is one of a stable, catalogued set so an agent (or a downstream step) can branch on the
**cause** without scraping `::error::` log lines. It is written even when the deploy fails:

| `outcome` | Meaning |
|---|---|
| `success` | A real capsule was published (anchored + pushed). |
| `skipped` | `--if-changed` no-op — byte-identical to the live version; nothing spent. |
| `preview` | A free preview build (no chain, no spend). |
| `dry-run` | A `--dry-run` cost preview; nothing published or spent. |
| `anchor-failed` | Anchored on-chain but the hub push did not complete. |
| `push-failed` | The hub push was rejected (see `failure-reason`). |
| `timed-out` | On-chain confirmation timed out. |
| `no-credential` | A real deploy was attempted with no funding credential. |
| `unauthorized` | Auth was rejected (e.g. OIDC audience / token). |
| `oidc-error` | Keyless OIDC exchange failed (e.g. unbound repo→store). |
| `blocked-paid-preview` | `preview: true` was blocked because `allow-paid-preview` was not set. |
| `failed` | A failure that does not map to a more specific cause. |

### Machine-readable consumption

```yaml
- name: Deploy to DIG
  id: dig
  uses: DIG-Network/deploy-action@v1
  with: { directory: dist }

- name: Act on the result
  if: always()
  run: |
    echo "outcome=${{ steps.dig.outputs.outcome }}"
    # Parse the whole result once:
    node -e 'const r=JSON.parse(process.env.DIG);console.log(r.capsule, r.outcome)'
  env:
    DIG: ${{ steps.dig.outputs.json }}
```

---

## How it works

The action wraps `digstore deploy`, which is built for CI: on a fresh checkout it reconstructs the
store locally from the deploy key + the current on-chain root, stages your output directory, advances
the root (signed by the **writer** deploy-key, `--writer-key`), and pushes the new capsule — all
non-interactively. The composite steps, in order:

1. **Decide mode** (`src/mode.mjs`) — PR → preview, default-branch push → deploy.
2. **Keyless auth** (`src/auth.mjs` → `src/oidc.mjs`) on a real deploy — request the GitHub OIDC token
   (`audience=dighub`), `POST /auth/ci/github-oidc`, and write the scoped session to a temp identity
   dir digstore reads. No token is ever printed.
3. **Run `digstore`** — `deploy --preview` (PR) or `deploy --if-changed --writer-key …` (push).
4. **Report** (`src/report.mjs` → `parse.mjs`/`comment.mjs`/`github.mjs`) — outputs, PR comment, and
   the GitHub deployment + commit status.

You can run the deploy half yourself:

```sh
digstore seed import --mnemonic "$DIG_MNEMONIC"            # DIGSTORE_PASSPHRASE set (funds the fee)
DIGSTORE_WRITER_KEY=<64-hex> digstore deploy --output-dir dist --json --if-changed   # advance root + push
digstore deploy --preview --output-dir dist --json         # a free preview — no chain, no spend
```

The logic in `src/` is plain Node ESM with **zero npm dependencies** (the GitHub REST and OIDC calls
use Node 20's global `fetch`), unit-tested with `node --test`. The composite-YAML glue and the full
keyless path (OIDC request → exchange → session write) are exercised by `.github/workflows/smoke.yml`
against a local echo server (no real GitHub OIDC, no real hub, no secrets).

### digstore install

`scripts/install-digstore.sh` resolves the pinned CLI in this order:

1. A prebuilt headless-CLI binary attached to the pinned GitHub Release (the fast path the public
   one-line installer, roadmap #9, will feed).
2. `cargo install` from the pinned git tag (always works on a runner with Rust; the script installs
   a toolchain if needed). This is the current path until #9 publishes public per-OS CLI tarballs.

---

## Versioning

This action follows the standard GitHub Action major-tag convention:

- Reference it as `DIG-Network/deploy-action@v1` for the latest compatible v1.x release.
- A floating `v1` tag is moved forward to each v1.x release; pin to an exact tag (`@v1.2.3`) or a
  commit SHA for byte-for-byte reproducibility.

**Release flow (gated by a maintainer):**

1. Merge to `main` with CI green (`node --test` + actionlint + shellcheck).
2. Tag the release commit: `git tag v1.0.0 && git push origin v1.0.0`.
3. Move the floating major tag: `git tag -f v1 v1.0.0 && git push -f origin v1`.
4. Publish a GitHub Release for `v1.0.0` (and, when ready, list it on the GitHub Marketplace).

> The first `@v1` tag is **not** cut automatically — a human gates it. Until then, pin to a commit
> SHA.

> [!NOTE]
> **digstore pin:** the keyless writer deploy-key (`--writer-key`) and the free `deploy --preview`
> path (#17/#18) require digstore **>= `v0.6.0`** — which is the `digstore-version` default. Keep it
> pinned to an explicit tag for reproducible CI.

---

## Development

```sh
node --test                           # run the unit tests
node .github/scripts/check-action.mjs # assert action.yml outputs match the implementation
shellcheck scripts/install-digstore.sh
actionlint                            # lint the workflows
```

## Related

- [Deploy from GitHub Actions](https://docs.dig.net/docs/digstore/cli/deploy-from-github-actions) — the docs page
- [`digstore`](https://github.com/DIG-Network/digstore) — the CLI this action drives
- [DIGHub](https://hub.dig.net) — where your store and its capsules are managed

## License

MIT
