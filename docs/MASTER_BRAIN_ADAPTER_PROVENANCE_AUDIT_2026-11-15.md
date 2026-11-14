# Master Brain — Adapter and Backend Provenance Audit
**Date:** 2026-11-15  
**Mission:** MB-G2B-ADAPTER-PROVENANCE-2026-11-15-001  
**Workspace:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Target branch:** `integration/master-brain-unification-2026-11-15`  
**Mode:** Read-only source and repository-index inspection; documentation only.

## 1. Mission and boundaries

This audit continues Gate 2 by tracing actual source call paths among:
- Master-Brain-MCP-Hub;
- Master Brain Cloud Agent;
- Cloud Engineering Connector;
- Node Durable Object stores;
- Python Mission API candidate.

The objective is to distinguish deployed/documented components from components that are actually connected by source-level calls. A Durable Object binding, README statement, API contract, or passing unit test is not by itself proof of a live end-to-end integration.

No runtime resources, credentials, Cloudflare settings, branches other than the isolated documentation branch, or production systems were modified.

## 2. Exact source snapshot

### 2.1 Chat-gpt repository, main = `919b19ca3d3887352cdef06b03c668ead04fbce7`

| Component | File | Blob SHA-1 |
|---|---|---|
| Cloud Agent documentation | `cloud-agent/README.md` | `375021623e9831455f7effa3cca9e967162f65a6` |
| Cloud Agent Worker | `cloud-agent/src/worker.js` | `95b90c0fd962876ff92c8c675575d72f01bf0c4d` |
| Cloud Agent policy/budget core | `cloud-agent/src/core.js` | `1705374d055c061eca58509ad3021e2f692005b5` |
| Cloud Agent Wrangler config | `cloud-agent/wrangler.toml` | `60f5cb322f4849531cb05f7a9abc93c6799fe78a` |
| Connector documentation | `cloud-engineering-connector/README.md` | `03e3260d09454a7927e9408cdbabdeb255ba721c` |
| Connector Worker | `cloud-engineering-connector/worker.js` | `8911b4fc7df279ecbea7689506e0f814b2414dff` |
| Connector entrypoint | `cloud-engineering-connector/index.js` | `1a8a3f50cc4bbd2d1522311f48d21a36bf5adc33` |
| Connector Wrangler config | `cloud-engineering-connector/wrangler.toml` | `6c81ef6761497f6e8889a1ed8aa715b70922a949` |
| Tenant context | `cloud-engineering-connector/identity/tenant-context.js` | `2282a056d1b0436ad8e573f7c8d7873d4fe5c34b` |
| Tenant Directory Durable Object | `cloud-engineering-connector/identity/tenant-directory.js` | `47647f84afc03c554b808060b6adce200d31e13d` |

The full recursive tree for this repository was read at SHA `919b19ca3d3887352cdef06b03c668ead04fbce7`; response was not truncated.

### 2.2 Hub repository

Repository: `mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub`  
Default branch: `main`  
Recursive tree SHA: `e6f7d0828ab1fd8c23f2bcb01f7d585a36453d66`  
Tree response: not truncated.

| File | Blob SHA-1 |
|---|---|
| `src/brain/client.ts` | `695cb694ea12f3a6867f9c0c12d2ea91daa9338b` |
| `CONTRACTS/api_contract.md` | `53ae9ab2c0f16fc1d647a33b897708e79637c6e8` |
| `CONTRACTS/data_contract.md` | `5e7ba695ee2c7d2d17fe294626342569109bdbfc` |
| `src/index.ts` | `eeac622af9bb6bdb154fcc2ff4a78796376e1027` |

## 3. Source-level integration findings

### 3.1 Master-Brain-MCP-Hub is a client adapter, not the Brain backend

The Hub repository's complete tree contains the MCP entrypoint, tools, Brain HTTP client, contracts, tests, and a local Auto-Memory dedup store. It does not contain an HTTP Brain backend server, Brain database implementation, or server route implementation for `/api/brain/*`.

The client consumes these routes:
- `POST /api/brain/entries`;
- `GET /api/brain/search`;
- `GET /api/brain/stats`;
- `GET /api/brain/recent`;
- `GET /api/brain/health`;
- `DELETE /api/brain/entries/:id`.

The API contract says Bearer auth is recommended but may be omitted on a network-trusted deployment. The client adds `Authorization: Bearer ...` only when `BRAIN_API_KEY` is configured. The data contract describes a server-generated BrainEntry ID and timestamp; `source.user_id` is optional. The README explicitly describes the Hub as the MCP edge, not the Brain storage/embedding engine.

**Result:** the Hub's consumer contract is confirmed in source; its backend owner, implementation, persistence, auth enforcement, tenant isolation, deployment URL, and live status remain **UNKNOWN**.

Repository-index searches scoped to the current GitHub owner for repositories matching Brain, Memory, Backend, and Master found the Hub repository but did not identify a separate Brain backend repository. This is a bounded repository-index result, not proof that no backend exists outside the indexed GitHub repositories or under another name.

### 3.2 Cloud Agent is an independent read-only engineering assistant

The Cloud Agent Worker defines:
- a fixed repository target: `mohammadrezayaghoobi123-dev/Chat-gpt`;
- read-only tools: `project_inspect`, `read_project_file`, `engineering_standards`;
- bearer authentication through `AGENT_AUTH_TOKEN`, with optional principal registry `AGENT_USER_KEYS`;
- `POST /api/sessions`, `POST /api/sessions/{id}/chat`, and `GET /api/sessions/{id}/history`;
- Durable Objects `AgentSession` and `AgentBudget`;
- a bounded Workers AI model call and budget accounting.

The Worker system prompt and tool allow-list explicitly prohibit code changes, PR creation, merges, deployment, shell commands, and project test execution. Session capabilities and principal credential fingerprints are stored as hashes, not raw bearer values.

The Cloud Agent source and its Wrangler bindings do not reference `BRAIN_API_URL`, `/api/brain/entries`, Python `/v1/missions`, `KNOWLEDGE_STORE`, or `ORCHESTRATOR_LEDGER`. It therefore does not act as a Mission API adapter, Hub backend, or Node orchestrator client in the inspected source.

The README records a separate Cloudflare Worker deployment and a public health check, but also explicitly says valid-bearer session creation, authenticated chat, and the Worker's end-to-end AI invocation remained unverified at the documented checkpoint. Those README deployment statements are **DOCUMENTED, NOT INDEPENDENTLY RE-VERIFIED IN THIS AUDIT**.

**Result:** Cloud Agent is a separate read-only repository reasoning/session service, not the central Mission orchestrator and not the BrainEntry backend.

### 3.3 Cloud Engineering Connector exposes a separate MCP boundary

The Connector Worker implements `/mcp` and `/healthz`; it does not expose `/api/brain/*` or `/v1/missions`. Its tool surface includes:
- repository inspection and file reading;
- architecture review rubric generation;
- engineering standards;
- `create_change_pr`, which creates a new assistant branch and draft PR, without merging.

The Worker is restricted by source code to the repository `mohammadrezayaghoobi123-dev/Chat-gpt`. It uses the GitHub API and the configured GitHub credential for repository access. Its documentation states that it does not execute arbitrary project test suites in an isolated sandbox.

The MCP authentication path maps the configured shared bearer credential to a service principal (`service:shared-mcp-bearer`). For `create_change_pr`, the Worker then resolves a tenant membership and asks the policy authority for a project-specific `project.create_pr` authorization decision. The tenant selector is only a selector; membership and policy stores are authoritative. Missing membership, missing policy service, scope mismatch, or non-allow decisions fail closed.

### 3.4 Tenant Directory is wired; Knowledge and Orchestrator stores are bound but not called by this Worker

The Connector Wrangler configuration declares and migrates these Durable Object classes:
- `KNOWLEDGE_STORE` → `KnowledgeStore`;
- `ORCHESTRATOR_LEDGER` → `OrchestratorLedger`;
- `TENANT_DIRECTORY` → `TenantDirectory`.

The Connector entrypoint exports all three classes. However, direct source inspection of `cloud-engineering-connector/worker.js` found:
- a runtime reference to `env.TENANT_DIRECTORY` through `createTenantDirectoryAdapters`;
- **zero** references to `env.KNOWLEDGE_STORE`;
- **zero** references to `env.ORCHESTRATOR_LEDGER`.

The Worker therefore uses Tenant Directory in its current `create_change_pr` authorization path, but the inspected MCP request path does not call KnowledgeStore or OrchestratorLedger. The fact that those classes are exported and bound in Wrangler proves that the classes/configuration exist; it does not prove they are integrated into this Worker’s MCP tool flow.

This is a material integration gap. The stores may be intended for another caller or a future route, but their active producer/consumer paths are not established by this source snapshot.

### 3.5 Tenant Directory is a distinct security aggregate

Tenant Directory stores:
- tenant memberships and roles;
- tenant/project policy rules;
- append-only directory audit events;
- provisioning operations protected by a tenant-scoped admin assertion.

The context adapter derives an opaque principal from a trusted authenticator, resolves active membership from the membership store, and requires the policy authority to bind its decision to the same principal, tenant, project, action, and resource digest. Default behavior is deny.

This is a stronger authorization boundary than the Hub API contract's optional Bearer mode. But the sources do not define a trusted bridge from:
`Cloud Agent principal` or `Connector service principal` or Python `Identity.subject`
to the Hub's optional `BrainEntry.source.user_id`.

Do not equate these identifiers or use a caller-supplied `user_id` as authorization proof.

## 4. Revised component responsibility map

| Component | Current evidenced responsibility | Not evidenced / must not be assumed |
|---|---|---|
| Python Mission service | Mission contract, approval, dispatch lifecycle, audit-backed state | Cloud Agent session service; Node Task ownership; Hub BrainEntry persistence |
| Node OrchestratorLedger | Tenant/project-scoped task, lease, outbox, worker assertion, task audit | Connected to current Connector MCP request path; Mission lifecycle authority |
| Node KnowledgeStore | Tenant/project-scoped knowledge records, document refs/sync, Vault proposals, local outbox | BrainEntry backend; connected to current Connector MCP request path |
| TenantDirectory | Membership, project authorization policy, provisioning audit | Global identity provider for all components; mapped to Python/Hub identities |
| Cloud Agent | Read-only repository reasoning, authenticated sessions, budget control | Code execution, tests, GitHub writes, Mission dispatch, persistent Brain knowledge |
| Cloud Engineering Connector | MCP repository inspection and bounded draft-PR action with tenant/project authorization | Arbitrary test execution, Brain API backend, Mission service, Knowledge/Orchestrator integration |
| Master-Brain-MCP-Hub | MCP tools and HTTP client for an external Brain API | Backend server, primary Brain database, verified link to Mission or KnowledgeStore |
| Brain API backend | No owner/implementation found in inspected sources | Any live endpoint, schema, authorization, tenant boundary, or persistence behavior |

## 5. Contradictions and falsification tests

| Hypothesis | Current evidence | Falsification / discriminating test |
|---|---|---|
| Cloud Agent is the Brain backend | Its source has session/budget DOs and read-only GitHub tools; no Brain API route or database | Find an exact deployed server route and persistence implementation in its source/runtime. Until then reject this hypothesis provisionally. |
| Connector MCP calls KnowledgeStore and OrchestratorLedger | Wrangler binds and entrypoint exports them, but Worker has zero env references to those bindings | Trace a concrete tool request through a call site into each Durable Object and assert persisted state in isolated tests. |
| Hub is connected to Python Mission API | Hub client only calls `/api/brain/*`; no `/v1/missions` adapter found | Locate a versioned adapter with explicit mapping, auth, idempotency, and contract tests. |
| Tenant Directory is a universal identity authority | Connector uses it for its service principal; no mapping for Python/Cloud Agent/Hub shown | Add signed principal mapping tests and cross-context negative authorization tests for each integration. |
| A successful Worker health response proves service integration | Health is a liveness route and does not exercise Brain API, DO stores, or authenticated end-to-end tool calls | Run authenticated end-to-end flows and verify exact durable state and audit receipts in the target environment. |

## 6. Required architectural decisions

1. Keep Cloud Agent, Cloud Engineering Connector, Hub, Python Mission, Node Orchestrator, KnowledgeStore, and TenantDirectory as distinct components until a concrete adapter contract and call path is verified.
2. Do not repurpose Cloud Agent as an orchestrator: its documented and implemented tool boundary is read-only.
3. Do not claim KnowledgeStore or OrchestratorLedger are active MCP capabilities merely because Wrangler binds them. Add explicit route/tool call paths and tests in a later, separately approved change.
4. Treat TenantDirectory as the current Connector authorization authority only; design cross-component identity federation as its own ADR.
5. Keep BrainEntry backend as UNKNOWN. Do not redirect Hub writes to KnowledgeStore or Mission AuditStore without a schema mapping, retention/privacy policy, tenant model, and reversible migration plan.
6. Treat README deployment records as documentation evidence only. Live deployment and authenticated flow must be re-verified before operational claims.

## 7. Gate 2B result

| Criterion | Status |
|---|---|
| Hub repository and client-consumed API identified | CONFIRMED IN SOURCE |
| Hub backend server/persistence identified | UNKNOWN |
| Cloud Agent source and tool boundary inspected | CONFIRMED IN SOURCE |
| Cloud Agent end-to-end authenticated live path | NOT_VERIFIED |
| Connector MCP tool boundary inspected | CONFIRMED IN SOURCE |
| TenantDirectory actual Connector call path inspected | CONFIRMED IN SOURCE |
| KnowledgeStore and OrchestratorLedger call paths from Connector Worker | NOT_FOUND IN INSPECTED WORKER |
| Shared identity mapping across Hub, Python, Cloud Agent, Connector | UNKNOWN |
| BrainEntry cross-context migration path | NOT_AUTHORIZED |
| Runtime tests or live deployment verification performed in this audit | NOT_RUN |

**Gate 2B is PARTIALLY COMPLETE, NOT PASSED.** The adapter responsibilities and missing links are now source-backed. Brain backend ownership, live authenticated flows, and cross-context identity remain blocking unknowns.

## 8. Next atomic gate

Proceed to **Gate 2C — identity, authorization, and trust-boundary contract**:
- define principal namespaces and issuer semantics;
- define tenant membership and project policy authority;
- define service-principal versus human-principal permissions;
- map (or explicitly refuse to map) Python Identity, Connector principal, Cloud Agent principal, and Hub BrainEntry source metadata;
- define event actor attribution, revocation, session expiry, and idempotency scope;
- write positive and negative golden fixtures, including cross-tenant denial and forged-identity rejection.

Do not enable cross-context writes or begin data migration before Gate 2C is reviewed and accepted.

## 9. Safety

This audit is documentation-only. No code, runtime state, Cloudflare configuration, secrets, GitHub PRs, main branch, or production resource was changed. Production remains **NO-GO** pending exact-SHA independent review and operational verification.
