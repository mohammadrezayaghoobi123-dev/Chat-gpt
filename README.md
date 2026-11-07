# Chat-gpt Engineering Workspace

Monorepo for two **independent** systems that share only governance and security posture:

| Component | Path | Maturity | Role |
|-----------|------|----------|------|
| **Cloud Engineering Connector** | [`cloud-engineering-connector/`](./cloud-engineering-connector/) | **`main`: v0.1.0 deployable · `engineering/hardening-v0.2.0`: FAIL-CLOSED** | Cloudflare Worker MCP server |
| **OpenClaw** | [`openclaw/`](./openclaw/) | Bootstrap / design only | Personal agent policies — **not** a runtime dependency of the connector |

These components must not be conflated. The connector does **not** implement OpenClaw. OpenClaw does **not** depend on the connector.

> **Engineering branch warning:** On `engineering/hardening-v0.2.0` the connector runtime is intentionally **unavailable** (HTTP 503). See [`cloud-engineering-connector/BRANCH_STATUS.md`](./cloud-engineering-connector/BRANCH_STATUS.md). **Do not merge or deploy that branch** until recovery gates pass. Production truth remains `main`.

---

## Repository layout

```
.
├── README.md                          # This file — workspace index
├── VERSION                            # Workspace-level version
├── docs/
│   ├── ARCHITECTURE.md
│   ├── VERSIONING.md
│   └── RELEASE.md
├── cloud-engineering-connector/       # MCP Worker (primary product)
├── openclaw/                          # Agent bootstrap assets only
├── .github/workflows/
└── .devcontainer/
```

---

## Cloud Engineering Connector (summary)

On **`main`**: cloud-hosted MCP server with tools for inspection, review standards, and draft-only PRs.

**Hard constraints (non-negotiable):**
- Fail-closed auth unless explicit public read-only mode
- Draft PRs only on `assistant/*` — never auto-merge
- Secrets only as Worker secrets
- Bounded request/response sizes; blocked credential paths

Allowlist configurability (`ALLOWED_REPOSITORIES`, `ALLOWED_BASE_BRANCH`) is designed in `lib/allowlist.js` and documented for v0.2.0; **runtime wiring ships only after recovery gates**.

---

## OpenClaw (summary)

Bootstrap policies only in-repo. Runtime state stays off the public tree.

---

## Versioning & release

See [`docs/VERSIONING.md`](./docs/VERSIONING.md) and [`docs/RELEASE.md`](./docs/RELEASE.md).

## Explicit non-goals

- Not multi-tenant arbitrary-repo bot without per-repo auth design
- Not full MCP resources/prompts/tasks
- Not OpenClaw runtime
- Not auto-merge / write-to-`main`
- Not shell execution
