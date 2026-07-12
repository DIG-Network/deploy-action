# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org) and
[Conventional Commits](https://www.conventionalcommits.org).

## [0.2.1] - 2026-07-12

### Bug Fixes
- **deploy-action:** Correct Discord invite (imposter link -> official) (#2)

## [0.2.0] - 2026-07-04

### Features
- Tear down PR preview deployments on pull_request close (#1)

## [0.1.0] - 2026-07-04

### Features
- Parse + render digstore `deploy --preview` free builds (#18)- Keyless CI deploy — GitHub OIDC → dighub session + writer deploy-key (#17/#23)

### Bug Fixes
- Drive deploy-mode from DIG_* env, not the reserved GITHUB_* (smoke green)

### CI
- Enforce version increment in PRs (package.json / Cargo.toml)- Enforce Conventional Commits with commitlint on PRs- Enforce Conventional Commits with commitlint on PRs- Release automation + auto-publish on version tag (#230 auto-publish-everything)

### Chores
- **changelog:** Add git-cliff config for Conventional-Commit changelog

### Chia
- // content-open URL + UX-consistency pass


