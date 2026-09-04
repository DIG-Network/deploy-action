# Contributing to `dig-network/deploy-action`

Thanks for your interest in improving this project. It's the official GitHub Action that publishes
a build to the DIG Network on Chia (git-push-to-deploy) — a **composite action** implemented in
plain Node.js, with no bundling step. Please read this before opening a PR.

## Reporting an issue

File it at [DIG-Network/deploy-action/issues](https://github.com/DIG-Network/deploy-action/issues).
Include:

- What you observed vs. what you expected.
- A link to the failing **workflow run** and the `deploy` job/step.
- The relevant `action.yml` inputs you set (redact any secrets — `passphrase`, `mnemonic`,
  `writer-key`, `deploy-key`, `salt`).
- The `outcome` output if the run produced one (`success | skipped | preview | dry-run |
  anchor-failed | push-failed | timed-out | no-credential | unauthorized | oidc-error |
  blocked-paid-preview | failed`) and the `failure-reason`, if any.

## Prerequisites

- Node.js **>= 20** (`engines.node` in `package.json`).
- `npm ci` to install dev dependencies (ESLint, Prettier — the action itself ships with zero
  runtime `dependencies`, by design, so nothing else to install).
- No Rust/Chia toolchain is needed to work on this repo — it drives the `digstore` CLI as an
  external binary; it doesn't embed one.

**There is no build step and no `dist/` to commit.** `action.yml` declares `runs.using: "composite"`
and shells directly into the `.mjs` files under `src/` at run time (`node "$ACTION_PATH/src/mode.mjs"`,
etc.) — unlike a JavaScript-action (`runs.using: "node20"`), there's nothing to bundle with `ncc` and
nothing checked into `dist/`. A PR only needs to change `src/*.mjs` (and/or `action.yml` /
`scripts/install-digstore.sh`) directly; there is no separate "rebuild before you commit" step to
remember.

## Build & test

```sh
npm ci                                        # install dev deps
node --test                                   # run the unit tests (test/*.test.mjs)
node .github/scripts/coverage-gate.mjs 80     # tests + enforce >= 80% line coverage
node .github/scripts/check-action.mjs         # assert action.yml outputs match src/parse.mjs
npm run lint                                  # eslint .
npm run format:check                          # prettier --check .
shellcheck scripts/install-digstore.sh
actionlint                                    # lints action.yml + .github/workflows/*.yml
```

`node --test` covers everything reachable as a plain function call (`src/mode.mjs`, `src/parse.mjs`,
`src/deploy-args.mjs`, `src/report.mjs`, `src/github.mjs`, `src/oidc.mjs`, `src/rest.mjs`,
`src/event.mjs`, `src/comment.mjs`, `src/actions-io.mjs`, `src/teardown.mjs`), one `test/*.test.mjs`
per `src/*.mjs` module — those are the fast, fully local tests to run while iterating.

`.github/workflows/smoke.yml` ("Smoke (composite glue + keyless wiring)") covers what the unit tests
can't reach directly: the actual composite-YAML → JS entrypoints wiring, and the full keyless OIDC
exchange (`src/auth.mjs`) driven end-to-end against a **local echo server** standing in for both the
GitHub OIDC token endpoint and the hub exchange endpoint — no real GitHub OIDC token and no real hub
are involved, so it's fully reproducible in CI without secrets. It is **not** run by `npm test`
locally; it runs as its own GitHub Actions workflow on every push/PR to `main`. If you change
`action.yml`'s composite steps, `src/mode.mjs`, or `src/auth.mjs`, re-check `smoke.yml`'s assertions
by hand or push a branch and let it run — it's the thing standing between "the unit tests pass" and
"the action actually parses and wires together as a whole."

## The gate

`.github/workflows/ci.yml` and `.github/workflows/smoke.yml` both run on every push to `main` and
every PR; all of it must be green before merge:

- **`ci.yml` / Unit tests** — `npm ci`, `npm run lint`, `npm run format:check`, `node --test`,
  `node .github/scripts/coverage-gate.mjs 80` (>= 80% line coverage, gated per shipped `src/`
  module as well as overall — one well-tested file can't mask an untested one), and
  `node .github/scripts/check-action.mjs` (`action.yml`'s declared `outputs:` must exactly match
  the keys `src/parse.mjs`'s `toOutputs()` produces).
- **`ci.yml` / Lint** — `shellcheck scripts/install-digstore.sh` and `actionlint` over `action.yml`
  and every workflow.
- **`smoke.yml`** — the composite-glue + keyless-auth smoke test described above.
- **`.github/workflows/commitlint.yml`** — every commit on the PR, and the PR title, must be a
  [Conventional Commit](https://www.conventionalcommits.org/) (`commitlint.config.mjs`, extending
  `@commitlint/config-conventional`; allowed types: `feat fix docs style refactor perf test build
  ci chore revert`).
- **`.github/workflows/ensure-version-increment.yml`** — `package.json`'s `version` must strictly
  increase versus `main` (bump it as the last step before opening/updating your PR).

Beyond CI, `main` is protected: every review thread (including any CodeQL/bot comment) must be
resolved, and the PR is squash-merged — never merged with a direct push.

## Commit & PR conventions

- Conventional Commits, enforced by commitlint (see above): `type(scope): summary`, `!` or a
  `BREAKING CHANGE:` footer for a breaking change.
- **Bump `package.json`'s `version`** as the last step before merge — patch for a compatible
  fix/chore/docs/refactor with no behaviour change, minor for a compatible new input/output/capability,
  major for a breaking change (a removed/renamed input or output, a changed default, a changed
  `outcome` value's meaning).
- On merge, `.github/workflows/release.yml` regenerates `CHANGELOG.md` (git-cliff) from your commits,
  commits it, tags `vX.Y.Z`, and pushes the tag — write commit subjects with that in mind.
- **Note on the `@v1` major tag:** per the [README's Versioning section](./README.md#versioning),
  the first `@v1` tag is cut manually by a maintainer, not automatically by CI. A merged PR here
  advances `main` and gets its own `vX.Y.Z` tag; moving the floating `v1` tag to point at it is a
  separate, deliberate step.
- Keep the diff focused; update [`SPEC.md`](./SPEC.md) and the [README](./README.md) in the same PR
  when you change an input, output, the mode/decision logic, or the keyless auth flow — they are the
  normative contract and the user-facing docs for this action, and a behaviour change that leaves
  either one stale is incomplete.
- Never commit a real secret (a `passphrase`, `mnemonic`, `writer-key`, `deploy-key`, or `salt`) into
  a test fixture, workflow file, or example — every test that needs one uses an obviously-fake value
  (`test/*.test.mjs` and `smoke.yml` already do this).
