# Cloud Engineering Connector

Cloud-hosted **MCP** server (Cloudflare Workers) for evidence-aware repository inspection, architecture review, and **draft-only** code changes.

| Track | Version | Deployable from git blob? |
|-------|---------|---------------------------|
| `main` | **0.1.0** | Yes (monolithic worker) |
| `engineering/hardening-v0.2.0` | **0.2.0** (build-required) | **No** — committed file is fail-closed stub |

See [`BRANCH_STATUS.md`](./BRANCH_STATUS.md) and [`docs/BUILD_AND_PROVENANCE.md`](./docs/BUILD_AND_PROVENANCE.md).

## Design principles

- **Cloud execution:** no laptop process required at request time.
- **Fail-closed allowlist:** repositories must appear in `ALLOWED_REPOSITORIES` (default: this repo only).
- **Evidence discipline:** tool output is not proof; distinguish facts, assumptions, and verification gaps.
- **Safe autonomy:** writes only create `assistant/*` + **draft** PR; never merge; never write the protected base branch.
- **Least privilege:** secrets are Worker secrets only; fine-grained GitHub token recommended.
- **Bounded changes:** max 12 files / 500 KB; credential and workflow paths blocked.
- **Auth fail-closed:** bearer required unless `PUBLIC_READ_ONLY=true` (read-only tools only).
- **Provenance:** v0.2.0 bodies are derived only from `main` baseline + committed patch script.

## Configuration (Worker secrets / vars)

| Name | Required | Default | Purpose |
|------|----------|---------|---------|
| `MCP_AUTH_TOKEN` | yes (prod) | — | Bearer token for `/mcp` |
| `GITHUB_TOKEN` | for writes / private reads | — | Fine-grained, repo-scoped |
| `ALLOWED_REPOSITORIES` | no | `mohammadrezayaghoobi123-dev/Chat-gpt` | Comma-separated `owner/repo` |
| `ALLOWED_BASE_BRANCH` | no | `feature/cloud-engineering-connector` | Sole allowed PR base |
| `MCP_ALLOWED_ORIGINS` | browser clients | — | Exact Origin allowlist (CORS) |
| `PUBLIC_READ_ONLY` | no | unset | If `true`, unauthenticated read-only tools only |

Design module: [`lib/allowlist.js`](./lib/allowlist.js). Runtime wiring on the built worker is applied by [`scripts/apply-v0.2-allowlist.mjs`](./scripts/apply-v0.2-allowlist.mjs).

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

## Local verification (engineering branch)

Node.js 22+.

```sh
# 1) Obtain main baseline
curl -fsSL \
  "https://raw.githubusercontent.com/mohammadrezayaghoobi123-dev/Chat-gpt/main/cloud-engineering-connector/worker.js" \
  -o /tmp/baseline-worker-0.1.0.js

# 2) Build v0.2.0 body (overwrites worker.js)
node scripts/apply-v0.2-allowlist.mjs /tmp/baseline-worker-0.1.0.js

# 3) Tests
npm test          # allowlist unit tests
node --test       # full suite (expect 106 pass after version align)
npm run check     # syntax
```

Without the build step, committed `worker.js` is a **503 placeholder** by design.

## Deploy (Cloudflare Workers)

**Do not deploy the committed stub on the engineering branch.**

1. Run the same build step as CI (baseline from `main` + patch).
2. Set secrets: `MCP_AUTH_TOKEN`, `GITHUB_TOKEN` (never commit).
3. Optional vars: `ALLOWED_REPOSITORIES`, `ALLOWED_BASE_BRANCH`, `MCP_ALLOWED_ORIGINS`.
4. Smoke: `GET /healthz` → authenticated `initialize` / `tools/list` → allowlist deny for foreign repo → draft PR only on disposable token if testing writes.
5. Record Worker version ID; rollback = previous version ID.

Source commit ≠ live Worker version. Always record the deployed version ID.

## Security boundaries

- No shell / arbitrary command execution.
- No auto-merge.
- Body and GitHub response size caps enforced.
- Repository content is untrusted input.
- Invalid allowlist configuration fails closed.

## Roadmap (connector-only, gated)

1. Deploy pipeline generates worker (no reliance on long-lived full-body commit).
2. Staging interop tests with real MCP clients.
3. Enhanced `/healthz` + `/metrics` only if present in built body and covered by tests.
4. Multi-repo only with per-repo authorization design + negative tests.
5. Merge to `main` only after conflict check + independent authorization.
