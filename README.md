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

1. Installs the pinned `digstore` CLI on the runner.
2. Restores your deploy credential from a repo secret.
3. Runs `digstore deploy --output-dir <directory> --json` (with `--if-changed` by default).
4. Parses the result and exposes the **capsule**, root, store id, `dig://` URL, URN, hub URL, and
   on-chain coin id as step outputs.
5. On a PR, upserts a comment with the capsule + URLs + cost (the flat 100 DIG), creates a GitHub
   Deployment, and sets a commit status (a red X if the on-chain anchor or hub push failed/timed out
   — so a broken deploy can block merge).

You create the store once (`digstore init`, which mints it and spends 100 DIG). This action only
**advances** an existing store — it never mints. Each real deploy is a new capsule costing **100 DIG
+ a small XCH fee**, paid from your deploy wallet.

---

## Usage

### Push-to-deploy (deploy on every push to `main`)

```yaml
name: Deploy to DIG
on:
  push:
    branches: [main]

permissions:
  contents: read
  deployments: write   # for the GitHub Deployment + commit status

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci && npm run build        # produces ./dist

      - name: Deploy to DIG
        id: dig
        uses: DIG-Network/deploy-action@v1   # pin to @v1 once released (SHA until then)
        with:
          directory: dist
          digstore-version: v0.5.29          # PIN for reproducible CI
          passphrase: ${{ secrets.DIGSTORE_PASSPHRASE }}
          mnemonic:   ${{ secrets.DIG_MNEMONIC }}
          deploy-key: ${{ secrets.DIG_DEPLOY_KEY }}
          # store-id is read from dig.toml; pass store-id: here to override.

      - run: echo "Published ${{ steps.dig.outputs.capsule }} -> ${{ steps.dig.outputs.hub-url }}"
```

With `if-changed` (the default `true`), a push whose build is byte-identical to the live version is
a **no-op** — no spend, nothing published — so it is safe to run on every push.

### Preview per pull request

```yaml
name: DIG Preview
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # to comment the preview URL on the PR
  deployments: write

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci && npm run build

      - name: Preview on DIG
        uses: DIG-Network/deploy-action@v1
        with:
          directory: dist
          preview: true                      # see the preview note below
          digstore-version: v0.5.29
          passphrase: ${{ secrets.DIGSTORE_PASSPHRASE }}
          mnemonic:   ${{ secrets.DIG_MNEMONIC }}
          deploy-key: ${{ secrets.DIG_DEPLOY_KEY }}
```

> [!IMPORTANT]
> **Preview infrastructure is not live yet (Wave-2, roadmap #18).** Free, no-spend, expiring per-PR
> preview capsules (`{hash}.preview.dig.net`) are planned. **Until they ship, `preview: true`
> publishes a *real* capsule on Chia (100 DIG)** — it is labelled as a preview in the PR comment and
> the deployment is marked transient, but it does spend. The `preview` flag is scaffolded now so
> your workflows are forward-compatible; treat it as a real deploy for the moment.

---

## Security — read this before putting a wallet in CI

> [!CAUTION]
> **v1 puts your deploy wallet's seed in CI.** `passphrase` + `mnemonic` unlock a seed that **can
> spend all of that wallet's DIG and XCH**. Protect yourself:
>
> - Use a **dedicated deploy wallet**, never your main wallet.
> - Fund it with only **enough DIG for your expected deploys** (each = 100 DIG + a small fee).
> - Store both as GitHub **encrypted secrets** — never in `dig.toml` or any committed file.
>
> **The future safe path is scoped deploy tokens (roadmap #17):** a store-bound, spend-capped,
> revocable credential that advances *one* store **without** the master seed. The `deploy-token`
> input is reserved for it now (using it today is an error). Cut over to deploy tokens as soon as
> they ship — they remove the funded-seed-in-CI risk entirely.

The **deploy key** (`deploy-key`) is a separate credential: it authorizes publishing the capsule to
DIGHub but has **no spend authority**. Still treat it like a secret.

### One-time setup

On the machine where you created the store:

```sh
digstore log --json          # copy the "store_id" field (or set it in dig.toml)
digstore deploy-key export   # copy the 64-hex publisher deploy key
```

Then add three repository secrets (Settings -> Secrets and variables -> Actions):

| Secret | Value |
|---|---|
| `DIGSTORE_PASSPHRASE` | The passphrase that unlocks the deploy wallet's seed in CI |
| `DIG_MNEMONIC` | The dedicated deploy wallet's BIP-39 mnemonic |
| `DIG_DEPLOY_KEY` | The 64-hex key from `digstore deploy-key export` |

And commit a `dig.toml` to your repo root (so `store-id` / `output-dir` don't have to be passed):

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
| `store-id` | from `dig.toml` | The 64-hex store id to advance. |
| `if-changed` | `true` | Skip the deploy (and the spend) when the build is byte-identical to the live version. |
| `preview` | `false` | PR preview deploy. **Not yet free/no-spend** — see the preview note (#18). |
| `digstore-version` | `latest` | The `digstore` CLI version (a release tag, e.g. `v0.5.29`). **Pin this.** |
| `passphrase` | — | The deploy wallet's `DIGSTORE_PASSPHRASE` (v1 credential). **Use a dedicated wallet.** |
| `deploy-token` | — | **Reserved** for scoped deploy tokens (#17). Not yet implemented — using it errors. |
| `deploy-key` | — | The store's 64-hex publisher deploy key (no spend authority). |
| `mnemonic` | — | The deploy wallet's BIP-39 mnemonic, imported under `passphrase`. |
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
| `skipped` | `true` when `--if-changed` skipped a no-op deploy. |
| `spent` | `true` when the deploy spent DIG (a real publish). |
| `pushed` | `true` when the capsule was published to the hub. |

> Note: `*.on.dig.net` is an **optional, user-chosen** human domain you register for a store; it is
> not derivable from a deploy, so the action surfaces the always-available `hub-url` and `dig://`
> URL instead. If you have a registered domain, your site is also live at `<your-name>.on.dig.net`.

---

## How it works

The action wraps `digstore deploy`, which is built for CI: on a fresh checkout it reconstructs the
store locally from the deploy key + the current on-chain root, stages your output directory, advances
the root, and pushes the new capsule — all non-interactively. You can run the same flow yourself:

```sh
digstore seed import --mnemonic "$DIG_MNEMONIC"            # DIGSTORE_PASSPHRASE set
DIGSTORE_DEPLOY_KEY=<64-hex> digstore deploy --output-dir dist --json --if-changed
```

The parsing, PR-comment, and deployment-reporting logic lives in `src/` (`parse.mjs`,
`comment.mjs`, `github.mjs`, `report.mjs`) as plain Node ESM with **zero npm dependencies** (the
GitHub REST calls use Node 20's global `fetch`), and is unit-tested with `node --test`.

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
