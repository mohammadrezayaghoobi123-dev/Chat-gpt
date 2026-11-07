# Changelog

## [0.2.0] - 2026-11-07

### Added
- Configurable repository allowlist via `ALLOWED_REPOSITORIES` (comma-separated `owner/repo`)
- Configurable `ALLOWED_BASE_BRANCH` (default `feature/cloud-engineering-connector`)
- Enhanced `/healthz` (allowlist_count, protocol, flags) and Prometheus-text `/metrics`
- Source-parts packaging (`lib/source-parts/part*.js`) + `scripts/assemble.js` → `worker.generated.js`
- Negative tests for allowlist expansion and invalid configuration

### Changed
- Package version 0.2.0
- Wrangler main entry is `worker.generated.js` (assemble before deploy)
- CI runs assemble before tests

### Security
- Default allowlist remains this repository only (fail-closed)
- Invalid allowlist entries fail closed before GitHub calls

## [0.1.0]

Initial MCP worker with tools, draft-PR safety, path guards, dual-era protocol path.
