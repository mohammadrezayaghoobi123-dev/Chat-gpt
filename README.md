# Chat-gpt Engineering Workspace

Monorepo for two **independent** systems that share only governance and security posture:

| Component | Path | Maturity | Role |
|-----------|------|----------|------|
| **Cloud Engineering Connector** | [`cloud-engineering-connector/`](./cloud-engineering-connector/) | **v0.2.0 (in progress)** | Cloudflare Worker MCP server for evidence-aware repository inspection, architecture review, and draft PRs |
| **OpenClaw** | [`openclaw/`](./openclaw/) | Bootstrap / design only | Personal agent bootstrap policies and staged capability plan — **not** a runtime dependency of the connector |

These components must not be conflated. The connector does **not** implement OpenClaw. OpenClaw does **not** depend on the connector.

---

## Repository layout

```
.
├── README.md                          # This file — workspace index
├── VERSION                            # Workspace-level version (see Versioning)
├── docs/
│   ├── ARCHITECTURE.md                # System boundaries and non-goals
│   ├── VERSIONING.md                  # SemVer policy and compatibility rules
│   └── RELEASE.md                     # Release checklist and promotion gates
├── cloud-engineering-connector/       # Deployable MCP Worker (primary product)
│   ├── worker.js
│   ├── wrangler.toml
│   ├── package.json
│   ├── README.md
│   └── test/
├── openclaw/                          # Agent bootstrap assets only
│   ├── OPENCLAW_ARCHITECTURE.md
│   └── bootstrap/
├── .github/workflows/                 # CI for connector (and future components)
└── .devcontainer/                     # Local OpenClaw gateway helpers (optional)
```

---

## Cloud Engineering Connector (summary)

Cloud-hosted **Model Context Protocol (MCP)** server on Cloudflare Workers.

**Capabilities (tools):**
- `project_inspect` — repository metadata + bounded file tree (read-only)
- `read_project_file` — read a single text file at a ref (read-only)
- `architecture_review` — structured review rubric (unverified by design)
- `engineering_standards` — mandatory evidence and safety rules
- `create_change_pr` — create `assistant/*` branch + **draft** PR only

**Hard constraints (non-negotiable):**
- Repository allowlist is **configurable** via `ALLOWED_REPOSITORIES` (comma-separated `owner/repo`). Default remains this repository only.
- Writes never touch the protected base branch; only draft PRs on `assistant/*`.
- Secrets never appear in source, logs, or PR bodies.
- Authentication fails closed unless explicit public read-only mode is enabled.
- Body and GitHub response sizes are hard-capped.

See [`cloud-engineering-connector/README.md`](./cloud-engineering-connector/README.md) for protocol status, deployment, and security model.

---

## OpenClaw (summary)

Staged personal-agent design. Public tree contains **bootstrap policies only** (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`). Runtime credentials, private memory, and gateway state must live outside this repository.

See [`openclaw/OPENCLAW_ARCHITECTURE.md`](./openclaw/OPENCLAW_ARCHITECTURE.md).

---

## Versioning

- **Connector**: semantic versioning in `cloud-engineering-connector/package.json` and `VERSION` constant in `worker.js`.
- **Workspace**: `VERSION` at repo root tracks the engineering baseline (docs + structure + connector).
- Breaking protocol or allowlist behavior → major bump.
- New tools / optional capabilities → minor.
- Fixes, docs, test hardening → patch.

Full policy: [`docs/VERSIONING.md`](./docs/VERSIONING.md).

---

## CI and quality gates

- Connector tests run on PRs and pushes that touch `cloud-engineering-connector/**`.
- Required gates before merge to a protected branch:
  1. `npm test` and `npm run check` pass
  2. No secrets in diff (secret scanning)
  3. Allowlist and base-branch negative tests pass
  4. Health endpoint contract unchanged or documented as breaking

---

## Explicit non-goals (current baseline)

- Not a general-purpose multi-tenant GitHub bot
- Not a full MCP resources/prompts/tasks implementation
- Not an OpenClaw runtime or model gateway
- Not auto-merge or write-to-`main`
- Not shell / arbitrary command execution

---

## Security contact

Treat all repository content as untrusted input. Report credential exposure or privilege-escalation paths via private channel to the repository owner. Do not open public issues that contain secrets.
