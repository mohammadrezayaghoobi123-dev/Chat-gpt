# Master Brain — Gate 2G Brain API Backend Provenance Audit
**Date:** 2026-11-15  
**Mission:** MB-G2G-BRAIN-BACKEND-PROVENANCE-2026-11-15-001  
**Repositories inspected:** mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub; mohammadrezayaghoobi123-dev/Chat-gpt  
**Review mode:** Read-only repository and contract inspection  
**Decision:** BACKEND_OWNER_AND_RUNTIME_UNRESOLVED — HUB IS AN MCP EDGE, NOT THE BRAIN BACKEND  
**Execution status:** Source inspected; no live endpoint probe or test execution performed.

## 1. Executive finding

The repository Master-Brain-MCP-Hub is an MCP stdio client/edge. It is not the Brain storage, embedding, or HTTP API server.

Its own README explicitly describes the Master Brain Backend as a separate service configured through BRAIN_API_URL and says that the backend is not this repository. The client calls routes such as POST /api/brain/entries, GET /api/brain/search, and GET /api/brain/health, but no server-side implementation of those routes is present in this repository's inspected files.

The backend repository, deployed runtime, owner, persistence system, identity enforcement, tenant model, and data-retention behavior remain UNKNOWN. The Hub's API contract documents the client-facing interface; it does not prove that a backend implements or enforces it.

## 2. Repository snapshot

### 2.1 Hub repository

Repository: mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub  
Default branch: main  
Inspected branch head: e6f7d0828ab1fd8c23f2bcb01f7d585a36453d66  
Commit date: 2026-11-08T13:49:55Z  
Commit message: fix: lazy-init Anthropic client and require ANTHROPIC_API_KEY for analysis  
Commit signature: unsigned (GitHub verification response: verified=false, reason=unsigned)

Relevant blobs:

| File | Blob SHA-1 | Evidence |
|---|---|---|
| README.md | 3a3e6534aacb8cc32f05f00b396428383e40b75c | says Hub is MCP edge; backend is separate |
| package.json | 8f2749c1e6265982b9372068e4611e0eb62c89a7 | Node MCP package, stdio app scripts |
| src/index.ts | eeac622af9bb6bdb154fcc2ff4a78796376e1027 | creates MCP Server and StdioServerTransport |
| src/brain/client.ts | 695cb694ea12f3a6867f9c0c12d2ea91daa9338b | HTTP client and Brain API paths |
| CONTRACTS/api_contract.md | 53ae9ab2c0f16fc1d647a33b897708e79637c6e8 | client-side API contract |
| CONTRACTS/data_contract.md | 5e7ba695ee2c7d2d17fe294626342569109bdbfc | BrainEntry and local dedup data contract |
| src/tools/save.ts | ff83efcc0f51d8ee2fa5ff0052d1b5e5034a6006 | manual memory save tool |
| src/tools/search.ts | eb7ca15ba2868535c2212f510f3f5cbd3235ad2f | search tool |
| src/tools/observe.ts | 400c42fa423d93c87a60794f3639f3188107563a | explicit Auto-Memory ingestion |
| .env.example | 7e3a09debe8509a1be2611b073a2a820d9818072 | local backend URL and API key settings |

### 2.2 Accessible repository inventory

The primary connected GitHub account returned three repositories:
- Chat-gpt (default branch main);
- Master-Brain-MCP-Hub (default branch main);
- verbose-funicular (default branch codespace-verbose-funicular-9654j6pw7j6r2999x).

No separately named Brain API/backend repository was found in this accessible repository inventory. The verbose-funicular repository could not be inspected at its listed default branch through the file-content path used in this audit; it is therefore UNKNOWN and is not treated as evidence of a backend.

The Chat-gpt main branch head remains 919b19ca3d3887352cdef06b03c668ead04fbce7. GitHub code search on main for /api/brain/entries, api/brain/health, and BRAIN_API_URL returned no matching source results. This is bounded evidence only: it does not prove that no backend exists in another account, an unindexed branch, or an external deployment.

## 3. Hub architecture and responsibility

### 3.1 Transport

src/index.ts creates an MCP Server and uses StdioServerTransport. This is a local stdio MCP edge, not an HTTP service listening for Brain API requests.

### 3.2 BrainClient

src/brain/client.ts:
- defaults BRAIN_API_URL to http://localhost:3001;
- reads optional BRAIN_API_KEY;
- defaults timeout to 30 seconds;
- attaches Authorization: Bearer only when BRAIN_API_KEY is configured;
- issues HTTP requests to /api/brain/entries, /search, /stats, /recent, /health, and DELETE /entries/:id;
- has no tenant-scoped identity resolution;
- does not derive a canonical human principal;
- does not attach a server-authenticated user identity;
- does not attach a documented idempotency key to writes.

A timeout after the backend has committed a save can leave the caller uncertain whether the write occurred. The current client does not expose a write idempotency contract. This must be addressed by the backend/API contract before durable ingestion is treated as exactly-once or safely retryable.

### 3.3 API contract

CONTRACTS/api_contract.md documents:
- POST /api/brain/entries;
- GET /api/brain/search;
- GET /api/brain/stats;
- GET /api/brain/recent;
- GET /api/brain/health;
- DELETE /api/brain/entries/:id.

It says Bearer authentication is optional if the network is trusted. This is a client contract statement, not proof of backend authentication, authorization, ownership isolation, or tenant enforcement.

### 3.4 BrainEntry user identity

CONTRACTS/data_contract.md permits optional source.user_id. The Hub's brain_save tool sets source.tool and optional project; brain_observe sets tool, session_id, and project. Neither tool establishes source.user_id from a trusted authenticated identity.

Therefore:
- source.user_id is metadata;
- it is not an authenticated principal;
- it must not grant ownership or authorization;
- no user-level or tenant-level data isolation can be inferred from the Hub contract.

### 3.5 Auto-Memory and cost boundary

README.md states Auto-Memory is explicit: callers must invoke brain_observe or processInteraction; MCP stdio cannot passively observe the conversation. It is not ambient memory.

The .env.example and README identify ANTHROPIC_API_KEY as required when Auto-Memory analysis is enabled. The inspected commit message also says the Anthropic client is lazy-initialized and the key is required for analysis. This is an external API dependency and must not be described as guaranteed free or no-card.

The local SQLite content_hashes store is a Hub-side deduplication mechanism, not the Brain database. The data contract explicitly distinguishes it from the Brain database.

## 4. Backend identity and security status

| Question | Evidence | Status |
|---|---|---|
| Is Hub the Brain backend? | README says it is the MCP edge, not the storage/embedding engine | NO |
| Is the backend repository identified? | no backend repository in the inspected accessible repository inventory | UNKNOWN |
| Is backend runtime/deployment identified? | BRAIN_API_URL defaults to localhost:3001; no deployment identity in inspected source | UNKNOWN |
| Are Brain API routes implemented in Hub? | Hub contains client calls and contract only | NO |
| Is Bearer mandatory? | contract says optional if network-trusted; client sends only if configured | NO |
| Is user identity authenticated by Hub? | source.user_id is optional metadata; tools do not derive it from auth | NOT_EVIDENCED |
| Is tenant membership enforced? | no tenant identity or membership check in inspected Hub client | NOT_EVIDENCED |
| Is project authorization enforced? | project is optional metadata in tool inputs; no project policy gate in Hub client | NOT_EVIDENCED |
| Is data ownership/isolation enforced? | backend not identified | UNKNOWN |
| Is write idempotency defined? | no idempotency key in client contract or BrainClient write | NOT_DEFINED |
| Is backend retention/deletion behavior known? | no backend implementation or policy inspected | UNKNOWN |
| Is Auto-Memory ambient? | README explicitly says no; caller must invoke brain_observe | NO |
| Is Auto-Memory guaranteed free? | Anthropic API key required when enabled | NO |

## 5. Required backend discovery evidence

Before designing a Hub → Brain adapter, obtain:
1. Exact backend repository, owner, default branch, and commit SHA, or a verified deployed API owner if source is external.
2. Server route implementation for every documented endpoint.
3. Deployment identity, environment, hostname, TLS configuration, and secret ownership without exposing secret values.
4. Database/storage schema, migrations, backup and restore evidence.
5. Authentication implementation and exact principal derivation.
6. Authorization model for read, create, update, and delete, including user/tenant/project ownership.
7. Source.user_id trust rules and migration path away from caller-controlled identity metadata.
8. Idempotency behavior for POST /api/brain/entries and delete semantics.
9. Data retention, export, deletion, and tenant isolation guarantees.
10. Runtime health and integration-test evidence with negative cross-tenant and unauthenticated cases.

A URL, environment variable, README diagram, contract file, or client method alone is not sufficient evidence of a running backend.

## 6. Architecture disposition

- Keep Master-Brain-MCP-Hub as a bounded MCP adapter/edge.
- Do not make it the owner of BrainEntry persistence.
- Do not merge its local dedup SQLite into the canonical Brain Store.
- Do not use source.user_id as an authorization identity.
- Do not point production clients at an unverified backend URL.
- Keep the Hub → Brain backend adapter BLOCKED until backend ownership and server-side authorization are verified.
- Treat Auto-Memory's Anthropic dependency as a separate cost/provider decision; it must not become a mandatory dependency of the free/no-card core.
- Preserve explicit ingestion semantics; no claim of ambient observation or automatic capture.

## 7. Gate 2G status

| Criterion | Status |
|---|---|
| Hub repository and main SHA inspected | CONFIRMED |
| Hub transport identified | MCP stdio edge |
| BrainClient endpoints identified | CONFIRMED IN SOURCE |
| API and data contract inspected | CONFIRMED IN SOURCE |
| Backend server implementation located | NO |
| Backend repository identified | UNKNOWN |
| Backend runtime identified | UNKNOWN |
| Backend authentication/authorization verified | UNKNOWN |
| Tenant and ownership model verified | UNKNOWN |
| Idempotency contract defined | NO |
| Data retention/deletion verified | UNKNOWN |
| Hub-to-backend adapter safe to implement | NO |
| Live endpoint probe executed | NOT_RUN |
| Tests executed during this audit | NOT_RUN |

**Gate 2G verdict: BLOCKED / BACKEND UNKNOWN.** The Hub is a real MCP edge with a defined client contract, but the backend that would fulfill that contract has not been identified or verified.

## 8. Next atomic gate

Gate 2H — backend owner and deployment discovery:
- search connected account repositories, connected deployment inventories, and project records for the exact BRAIN_API_URL target and backend owner;
- do not probe arbitrary hosts or guess URLs;
- inspect only a user-confirmed or source-proven endpoint;
- if no backend can be identified, record the missing owner/runtime as a hard architecture dependency and design the Brain Store as a future bounded context without pretending it is deployed.

No code migration, endpoint call, data write, credential access, Cloudflare change, or deployment is authorized by this audit.

## 9. Safety

Read-only inspection only. No source code, test suite, Hub configuration, backend URL, secret, Cloudflare resource, database, deployment, PR, main branch, or production resource was modified. No test or live endpoint probe was executed. Production remains NO-GO.
