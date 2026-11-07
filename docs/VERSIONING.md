# Versioning Policy

## Scope

- **Connector version**: `cloud-engineering-connector/package.json` → `version` and `worker.js` → `VERSION` must match.
- **Workspace version**: root `VERSION` file. Bumped when structure, docs, or multi-component contracts change.

## Semantic Versioning (SemVer 2.0.0)

Given `MAJOR.MINOR.PATCH`:

| Change type | Bump |
|-------------|------|
| Incompatible MCP/tool/auth/allowlist behavior | MAJOR |
| New tool, new optional env, backward-compatible protocol addition | MINOR |
| Bugfix, test/docs only, internal refactor with same contract | PATCH |

Pre-1.0 (`0.y.z`): MINOR may include breaking changes; still document them explicitly in release notes.

## Compatibility contracts (connector)

Breaking if any of the following change without MAJOR (or explicit 0.y breaking note):

- Tool names removed or required arguments added
- Default allowlist behavior becomes more permissive without config
- Auth fail-closed semantics weakened
- Health endpoint removes fields clients rely on (`status`, `execution`, `version`)

## Tagging

- Tags: `connector-vX.Y.Z` for connector releases
- Optional workspace tags: `workspace-vX.Y.Z`

## Changelog

Maintain `cloud-engineering-connector/CHANGELOG.md` (Keep a Changelog format).
