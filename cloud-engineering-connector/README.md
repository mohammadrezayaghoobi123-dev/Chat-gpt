# Cloud Engineering Connector

Cloud-hosted **MCP** server (Cloudflare Workers) for evidence-aware repository inspection, architecture review, and **draft-only** code changes.

| Track | Version | Notes |
|-------|---------|-------|
| `main` | **0.1.0** | Hardcoded single-repo allowlist; deployable |
| `engineering/hardening-v0.2.0` | **0.2.0** | Configurable allowlist; full body on branch; **not merged** |

See [`BRANCH_STATUS.md`](./BRANCH_STATUS.md) and [`docs/BUILD_AND_PROVENANCE.md`](./docs/BUILD_AND_PROVENANCE.md).

## Design principles

- **Cloud execution:** no laptop process required at request time.
- **Fail-closed allowlist:** repositories must appear in `ALLOWED_REPOSITORIES` (default: this repo only).
- **Evidence discipline:** tool output is not proof; distinguish facts, assumptions, and verification gaps.
- **Safe autonomy:** writes only create `assistant/*` + **draft** PR; never merge; never write the protected base branch.
- **Least privilege:** secrets are Worker secrets only; fine-grained GitHub token recommended.
- **Bounded changes:** max 12 files / 500 KB; credential and workflow paths blocked.
- **Auth fail-closed:** bearer required unless `PUBLIC_READ_ONLY=true` (read-only tools only).
- **Provenance:** v0.2.0 body = pure function of `main` 0.1.0 baseline + `scripts/apply-v0.2-allowlist.mjs`.

## Configuration (Worker secrets / vars)

| Name | Required | Default | Purpose |
|------|----------|---------|---------|
| `MCP_AUTH_TOKEN` | yes (prod) | — | Bearer token for `/mcp` |
| `GITHUB_TOKEN` | for writes / private reads | — | Fine-grained, repo-scoped |
| `ALLOWED_REPOSITORIES` | no | `mohammadrezayaghoobi123-dev/Chat-gpt` | Comma-separated `owner/repo` |
| `ALLOWED_BASE_BRANCH` | no | `feature/cloud-engineering-connector` | Sole allowed PR base |
| `MCP_ALLOWED_ORIGINS` | browser clients | — | Exact Origin allowlist (CORS) |
| `PUBLIC_READ_ONLY` | no | unset | If `true`, unauthenticated read-only tools only |

Design module: [`lib/allowlist.js`](./lib/allowlist.js).

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
# Optional: rebuild from main baseline (should match committed worker.js)
curl -fsSL \
  "https://raw.githubusercontent.com/mohammadrezayaghoobi123-dev/Chat-gpt/main/cloud-engineering-connector/worker.js" \
  -o /tmp/baseline-worker-0.1.0.js
node scripts/apply-v0.2-allowlist.mjs /tmp/baseline-worker-0.1.0.js

npm test          # allowlist unit tests
npm run test:full # full suite (expect 106 pass)
npm run check     # syntax
```

## Deploy (Cloudflare Workers)

1. Confirm CI byte-identity gate is green on the commit you deploy.
2. Set secrets: `MCP_AUTH_TOKEN`, `GITHUB_TOKEN` (never commit).
3. Optional vars: `ALLOWED_REPOSITORIES`, `ALLOWED_BASE_BRANCH`, `MCP_ALLOWED_ORIGINS`.
4. Smoke: `GET /healthz` → authenticated `initialize` / `tools/list` → allowlist deny for foreign repo.
5. Record Worker version ID; rollback = previous version ID.

Source commit ≠ live Worker version. Always record the deployed version ID.

## Security boundaries

- No shell / arbitrary command execution.
- No auto-merge.
- Body and GitHub response size caps enforced.
- Repository content is untrusted input.
- Invalid allowlist configuration fails closed.

## Roadmap (connector-only, gated)

1. Staging interop tests with real MCP clients.
2. Merge to `main` only after conflict check + independent authorization.
3. Multi-repo only with per-repo authorization design + negative tests.
