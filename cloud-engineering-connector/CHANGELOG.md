# Changelog

## [0.2.0] - 2026-11-07 (engineering/hardening-v0.2.0)

Status: **on engineering branch only** — not merged to `main`, not production-released.

### Added
- Configurable repository allowlist via Worker var `ALLOWED_REPOSITORIES` (comma-separated `owner/repo`, fail-closed validation).
- Configurable `ALLOWED_BASE_BRANCH` (default `feature/cloud-engineering-connector`).
- Pure module `lib/allowlist.js` + unit tests (source of design truth).
- Deterministic builder `scripts/apply-v0.2-allowlist.mjs` (main 0.1.0 baseline → v0.2.0 body).
- CI builds from `main` baseline before running the full suite (size + marker asserts).
- Fail-closed committed `worker.js` placeholder so accidental deploy without build returns 503.
- Technical provenance doc: `docs/BUILD_AND_PROVENANCE.md`.

### Changed
- Package version `0.2.0`.
- CI no longer depends on incomplete source-parts / assemble pipeline.

### Removed (from this branch)
- Incomplete `lib/source-parts/*` fragments.
- Obsolete `scripts/assemble.js`.

### Security
- Default allowlist remains this repository only.
- Invalid allowlist configuration fails closed before GitHub calls.
- Committed tree is non-deployable without explicit build step.

### Explicitly not in this release
- Live MCP client interop certification.
- Production deploy.
- Changes to `main`.

## [0.1.0]

Initial MCP worker on `main`: tools surface, draft-PR safety, path guards, dual-era protocol path, hardcoded single-repo allowlist.
