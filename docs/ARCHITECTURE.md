# Architecture — System Boundaries

## Purpose

Define hard boundaries between components so they can evolve independently without accidental coupling.

## Components

### 1. Cloud Engineering Connector

- **Deployable unit**: Cloudflare Worker (`cloud-engineering-connector/worker.js`)
- **Protocol**: MCP over HTTP (JSON-RPC 2.0), dual-era support (legacy 2025-03-26 / 2025-11-25 + modern path)
- **Trust boundary**: inbound requests are untrusted; repository content is untrusted; only explicit env secrets are trusted
- **Write model**: append-only proposals via draft PRs on `assistant/*` branches
- **Identity**: `serverInfo.name = "cloud-engineering-connector"`

### 2. OpenClaw

- **Deployable unit**: none in this repository (bootstrap assets only)
- **Runtime location**: operator machine / private workspace (`~/.openclaw/` or equivalent)
- **Relationship to connector**: none. OpenClaw may *use* an MCP connector in later phases; the connector must not import OpenClaw code or policies.

## Data flow (connector)

```
Client (ChatGPT / Claude / other MCP client)
    │  HTTPS + Bearer (or explicit PUBLIC_READ_ONLY)
    ▼
Cloudflare Worker
    │  allowlist check → schema validation → tool dispatch
    ├─► GitHub API (read)     [optional GITHUB_TOKEN]
    └─► GitHub API (write)    [GITHUB_TOKEN required; draft PR only]
```

## Configuration surface (connector)

| Variable | Required | Purpose |
|----------|----------|---------|
| `MCP_AUTH_TOKEN` | Yes (prod) | Bearer auth for MCP endpoint |
| `GITHUB_TOKEN` | For writes / private reads | Fine-grained, repo-scoped |
| `ALLOWED_REPOSITORIES` | No | Comma-separated `owner/repo` allowlist; default = this repo only |
| `ALLOWED_BASE_BRANCH` | No | Branch that draft PRs target; default = `feature/cloud-engineering-connector` |
| `MCP_ALLOWED_ORIGINS` | For browser clients | Exact Origin allowlist for CORS |
| `PUBLIC_READ_ONLY` | No | If `"true"`, permits unauthenticated use of read-only tools only |

## Non-goals

- Multi-tenant arbitrary-repo access without per-repo authorization design
- Execution of project test suites inside the Worker
- Persistent project memory across tenants
- Browser automation or shell execution

## Evolution rules

1. New tools require: schema, positive test, negative/security test, README update, version bump.
2. Expanding allowlist requires negative tests proving non-listed repos are still rejected.
3. Protocol version additions must not break existing handshake tests.
