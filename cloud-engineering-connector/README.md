# Cloud Engineering Connector

Cloud-hosted **MCP** server (Cloudflare Workers) for evidence-aware repository inspection, architecture review, and **draft-only** code changes.

Version: **0.2.0** (see `package.json` / `CHANGELOG.md`).

## Design principles

- **Cloud execution:** no laptop process required at request time.
- **Fail-closed allowlist:** repositories must appear in `ALLOWED_REPOSITORIES` (default: this repo only).
- **Evidence discipline:** tool output is not proof; distinguish facts, assumptions, and verification gaps.
- **Safe autonomy:** writes only create `assistant/*` + **draft** PR; never merge; never write the protected base branch.
- **Least privilege:** secrets are Worker secrets only; fine-grained GitHub token recommended.
- **Bounded changes:** max 12 files / 500 KB; credential and workflow paths blocked.
- **Auth fail-closed:** bearer required unless `PUBLIC_READ_ONLY=true` (read-only tools only).

## Configuration (Worker secrets / vars)

| Name | Required | Default | Purpose |
|------|----------|---------|---------|
| `MCP_AUTH_TOKEN` | yes (prod) | — | Bearer token for `/mcp` |
| `GITHUB_TOKEN` | for writes / private reads | — | Fine-grained, repo-scoped |
| `ALLOWED_REPOSITORIES` | no | `mohammadrezayaghoobi123-dev/Chat-gpt` | Comma-separated `owner/repo` |
| `ALLOWED_BASE_BRANCH` | no | `feature/cloud-engineering-connector` | Sole allowed PR base |
| `MCP_ALLOWED_ORIGINS` | browser clients | — | Exact Origin allowlist (CORS) |
| `PUBLIC_READ_ONLY` | no | unset | If `true`, unauthenticated read-only tools only |

Implementation of configurable allowlist lives in [`lib/allowlist.js`](./lib/allowlist.js). Wire it into `worker.js` via `repoPath(owner, repo, env)` and `allowedBaseBranch(env)` (replace any hardcoded single-repo constant).

## MCP tools

| Tool | Mode |
|------|------|
| `project_inspect` | read |
| `read_project_file` | read |
| `architecture_review` | pure (unverified rubric) |
| `engineering_standards` | pure |
| `create_change_pr` | write (draft PR only) |

## Protocol status

- Legacy: `2025-03-26`, `2025-11-25` handshake path.
- Modern path (draft): `2026-07-28` metadata / discover — **not** full MCP conformance; live ChatGPT/Claude interop **unverified**.
- Successful CI ≠ production interoperability.

## Local verification

Node.js 22+.

```sh
npm test
npm run check
```

## Deploy (Cloudflare Workers)

Source commit ≠ live Worker version. Always record Worker version ID.

1. Secrets: `MCP_AUTH_TOKEN`, `GITHUB_TOKEN` (never commit).
2. Optional vars: `ALLOWED_REPOSITORIES`, `ALLOWED_BASE_BRANCH`, `MCP_ALLOWED_ORIGINS`.
3. Smoke: `GET /healthz` → authenticated `initialize` / `tools/list` → allowlist deny for foreign repo → draft PR only on disposable token if testing writes.
4. Rollback: previous Worker version ID.

## Security boundaries

- No shell / arbitrary command execution.
- No auto-merge.
- Body and GitHub response size caps enforced.
- Repository content is untrusted input.

## Roadmap (connector-only)

1. Finish wiring `lib/allowlist.js` into `worker.js` (remove remaining hardcode).
2. Enhanced `/healthz` + Prometheus `/metrics` (no secrets).
3. Staging interop tests with real MCP clients.
4. Multi-repo only with per-repo authorization design + negative tests.
