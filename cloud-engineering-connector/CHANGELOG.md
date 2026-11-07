# Changelog

## [0.2.0] - 2026-11-07

### Added
- `lib/allowlist.js` — configurable repository allowlist (`ALLOWED_REPOSITORIES`) and base branch (`ALLOWED_BASE_BRANCH`)
- Default remain fail-closed to `mohammadrezayaghoobi123-dev/Chat-gpt` and `feature/cloud-engineering-connector`
- Negative tests scaffold for allowlist expansion and invalid config

### Changed
- Package version 0.2.0
- Connector README documents new env surface

### Security
- Invalid allowlist entries fail closed
- Non-listed repositories rejected before GitHub API calls (same guarantee, now config-driven)

## [0.1.0]

Initial MCP worker with tools, draft-PR safety, path guards, dual-era protocol path.
