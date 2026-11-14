# Master Brain — Bounded-Context Contract and Ownership Map
**Date:** 2026-11-15  
**Mission:** MB-G2-CONTRACT-MAP-2026-11-15-001  
**Repository workspace:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Target branch:** `integration/master-brain-unification-2026-11-15`  
**Mode:** Evidence-led architecture mapping; documentation only; no runtime or application-code changes.

## 1. Purpose and decision boundary

This document advances Gate 2 from a high-level principle to a source-backed ownership map. It distinguishes:
- an aggregate's authoritative state from its audit history and derived read models;
- an MCP/client adapter from the backend that owns its data;
- a code-defined contract from a deployed/live contract;
- identity, tenant, and project scopes, which are not interchangeable.

**Architecture rule:** one authoritative writer per aggregate, not one writer for the entire product. Do not merge distinct aggregates merely because they share identifiers, storage technology, or event terminology.

This is a candidate ownership map, not a production architecture freeze. Every item marked UNKNOWN remains unresolved.

## 2. Evidence snapshot

### 2.1 Workspace and source refs

| Source | Ref | File / object | Blob SHA-1 |
|---|---|---|---|
| Python Mission service | `master-brain/integrated` | `src/master_brain/mission_service.py` | `0bfc5ef134dba6384175104cd231a7b74dd95ead` |
| Python Mission lifecycle | `master-brain/integrated` | `src/master_brain/mission_lifecycle.py` | `eab2da3658331bd0883bb68d53237614f290b3d5` |
| Python Mission contract | `master-brain/integrated` | `src/master_brain/mission_contract.py` | `9d2bc4180024934f9170f9407e9665171c531293` |
| Python API contracts | `master-brain/integrated` | `src/master_brain/api_contracts.py` | `31bb3f22cc7a30e1120c4f0761a056c59dd71cc9` |
| Python Identity seam | `master-brain/integrated` | `src/master_brain/identity.py` | `d5abaa87beae5a4a72052caafacb482bf33e9314` |
| Python Audit Store | `master-brain/integrated` | `src/master_brain/audit_store.py` | `d77c1989cffa76717fcb0682036a26d231cbc939` |
| Python Approval | `master-brain/integrated` | `src/master_brain/mission_approval.py` | `b4c19544e21044a438e98aa1bfcdcc1afb857524` |
| Python execution | `master-brain/integrated` | `src/master_brain/mission_execution.py` | `aa82653ae9e62c98af99190dcd8bba163706c2af` |
| Python execution registry | `master-brain/integrated` | `src/master_brain/execution_registry.py` | `6bc71d9a86246b57bb2434e1a8e6c87ec52c0252` |
| Node Orchestrator Ledger | `main` | `cloud-engineering-connector/orchestrator-ledger.js` | `ba32281b3698d40917505096d2a61501f8c0f9e4` |
| Node Orchestrator state machine | `main` | `cloud-engineering-connector/orchestrator-core.js` | `6fff43bf231273e4cf03d2ad87baf5437ddc9c77` |
| Node Knowledge Store | `main` | `cloud-engineering-connector/knowledge-store.js` | `aad5d80356e02ecff973c9359e71d4f824e3c01c` |
| MCP Hub repository | `main` | `src/brain/client.ts` | `695cb694ea12f3a6867f9c0c12d2ea91daa9338b` |
| MCP Hub repository | `main` | `CONTRACTS/api_contract.md` | `53ae9ab2c0f16fc1d647a33b897708e79637c6e8` |
| MCP Hub repository | `main` | `CONTRACTS/data_contract.md` | `5e7ba695ee2c7d2d17fe294626342569109bdbfc` |
| MCP Hub repository | `main` | `src/index.ts` | `eeac622af9bb6bdb154fcc2ff4a78796376e1027` |

MCP Hub repository tree SHA: `e6f7d0828ab1fd8c23f2bcb01f7d585a36453d66`; tree response was not truncated.

### 2.2 Workspace preservation check

At the time of this map, GitHub compare reported the target branch as **2 commits ahead / 0 behind** `main`, merge base exactly `919b19ca3d3887352cdef06b03c668ead04fbce7`, and only two added Markdown files before this document. This change is intended to add one further Markdown file to the same isolated branch. No code path is changed by this document.

## 3. Aggregate ownership matrix

| Aggregate / record family | Bounded context and candidate owner | Authoritative state / writer | Scope and identity | Read model / derived state | Status |
|---|---|---|---|---|---|
| Mission Contract | Python Mission domain; `MissionService` + lifecycle functions | Registration event in Python `AuditStore`; `register_mission_contract` enforces one registration per mission ID and digest conflict | Mission ID; creation ID is derived from authenticated subject + idempotency key in `mission_service.py` | Contract snapshot loaded from verified audit history; lifecycle is replay-derived | CODE-DEFINED; runtime deployment UNKNOWN |
| Mission Lifecycle | Python Mission domain; `mission_lifecycle.py` | No independent mutable status row; lifecycle is derived from the Mission audit history | Mission ID / event subject `mission:<id>`; actor recorded on events | `derive_mission_state` replays history; states include planned, approved, dispatch_unresolved, response_received, effect_reconciled, dispatch_failed_no_effect, inconsistent | CODE-DEFINED; no COMPLETED/VERIFIED state |
| Approval Challenge / Receipt | Python Mission approval boundary; `MissionService` + `mission_approval.py` | Challenge and approval events appended to the same Python AuditStore; cryptographic verification precedes approval recording | Authenticated subject, approver role, signing key ID, algorithm, contract digest, optional action digest, expiry | Approval state derived from events and signature checks | CODE-DEFINED; production key custody and provider UNKNOWN |
| Execution Reservation / Attempt / Completion Receipt | Python execution subsystem; `SQLiteExecutionRegistry` | File-backed SQLite registry with atomic per-key reservations and compare-and-swap transitions | Execution key includes mission ID and request idempotency key; provider/scope/receipt namespace fields exist | Registry record and attempt/receipt queries | CODE-DEFINED; single-host primitive, not exactly-once external execution |
| Python Audit Event | Python Mission trust/evidence context; `AuditStore` | Append-only JSONL with exclusive local sidecar lock, hash chain, and local `.head` anchor | Event ID, event type, actor, subject_ref, payload, recorded_at | Verified history via `read_all`; Mission lifecycle projections replay this stream | CODE-DEFINED; external anchoring absent |
| Orchestration Task | Node Orchestration context; `OrchestratorLedger` Durable Object | `orchestrator_tasks` table; `createTask` and `transitionTask` are ledger commands; transition uses expected version/CAS | Explicit tenant_id + project_id; idempotency is namespaced by the tenant/project tuple | Task JSON/state/version read via `getTask`; state machine helpers in `orchestrator-core.js` | CODE-DEFINED in main; live Durable Object binding/runtime UNKNOWN |
| Execution Lease | Node Orchestration context; `OrchestratorLedger` | `orchestrator_execution_leases`; claim/renew/release methods and lease generation | Task + tenant/project + worker identity + generation + expiry | Lease row joined to task; claim candidates are a derived scheduling index | CODE-DEFINED; operational contention/failure tests not executed here |
| Orchestration Outbox | Node Orchestration context; `OrchestratorLedger` | `orchestrator_outbox_events`; enqueue/claim/fail/complete commands; receipts and dead letters are separate records | Tenant/project scoped; idempotency key; event ID/type; payload; attempts and lease generation | Pending/retry/dead-letter queues and outbox receipts | CODE-DEFINED; consumer delivery guarantees require runtime tests |
| Orchestration Audit Event | Node Orchestration context; `OrchestratorLedger` | `orchestrator_audit_events` append path with previous/event hash fields | Task, actor ID/role, tenant/project scope | Per-task audit query/order | CODE-DEFINED; not proven externally anchored or host-independent |
| Knowledge Entity / Relationship / Tag | Node Knowledge context; `KnowledgeStore` Durable Object | Versioned `knowledge_*_v4` tables and scoped upsert/create methods | Tenant + project + entity/relationship/tag ID | FTS/index sources are derived projections and rebuildable | CODE-DEFINED; live binding UNKNOWN |
| Knowledge Document Reference / Sync State | Node Knowledge context; `KnowledgeStore` | `knowledge_document_refs_v4` and `knowledge_document_sync_v4` | Tenant + project + document ID + repository/path/commit | Document history and sync status query methods | CODE-DEFINED; external source freshness policy UNKNOWN |
| Knowledge Vault Proposal | Node Knowledge context; `KnowledgeStore` | `knowledge_vault_proposals_v4`; `recordVaultProposal` / `updateVaultProposal` | Tenant + project + proposal ID; PR number unique in the scoped table | Proposal lookup and pending-proposal list | CODE-DEFINED; GitHub merge reconciliation runtime UNKNOWN |
| Knowledge Outbox | Node Knowledge context; `KnowledgeStore` | `knowledge_outbox_v4`; enqueue/claim/complete/defer/fail methods | Tenant + project + event ID/idempotency key | Outbox queue projection | CODE-DEFINED; distinct from Orchestrator outbox |
| BrainEntry / Memory API | External Brain Backend context; Hub is a client adapter, not owner | Backend writer and persistence are NOT IDENTIFIED in inspected Hub repository | Hub schema includes optional `source.user_id`; tenant/project enforcement not defined in its published API contract | Hub calls search/recent/stats/health; local dedup SQLite is only for Auto-Memory duplicate suppression | BACKEND OWNER UNKNOWN; contract consumer confirmed |

## 4. Critical contract observations

### 4.1 Python Mission and Node Orchestration are not the same aggregate

Evidence:
- Python `mission_service.py` states that creating a Mission registers a contract and starts it as `planned / not_started`; it does not dispatch work as part of creation.
- Python `mission_lifecycle.py` derives lifecycle state by replaying verified AuditStore history. It intentionally has no `COMPLETED/VERIFIED` state.
- Node `orchestrator-ledger.js` owns worker-oriented task transitions, execution leases, processed messages, outbox queues, worker assertions, and task-scoped audit.
- Node `orchestrator-core.js` contains explicit task transition and completion-evidence checks.

**Decision:** keep Mission and OrchestrationTask as distinct aggregates. A Mission may reference one or more OrchestrationTask IDs through an adapter/projection, but no one-to-one equivalence or shared writer is established by current evidence.

### 4.2 Python execution registry and Python audit stream are separate persistence responsibilities

The SQLite registry explicitly describes itself as a single-host coordination primitive, not exactly-once external execution. The Mission lifecycle and approval evidence live in the AuditStore. These stores serve different aggregates/purposes; however, the source review does not establish a single atomic transaction spanning both stores.

**Blocking design question:** define recovery/reconciliation behavior for a crash between registry reservation/transition and audit append. Do not claim cross-store atomicity. Add crash-point tests before any integration that relies on a consistent combined view.

### 4.3 Orchestrator and Knowledge each have their own Outbox

The Node Orchestrator has `orchestrator_outbox_events`; Knowledge has `knowledge_outbox_v4`. They belong to different bounded contexts and carry different aggregate ownership. Do not merge them into a global queue. If cross-context delivery is required, define an explicit consumer contract, idempotency namespace, retry/dead-letter policy, and receipt semantics.

### 4.4 Hub contract consumer is confirmed; backend implementation is not

The user-owned repository `mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub` was located. Its complete `main` tree includes MCP tools, `src/brain/client.ts`, API/data contracts, tests, and local dedup storage. The tree contains no backend server entrypoint or backend persistence implementation.

The Hub `BrainClient` sends:
- `POST /api/brain/entries` for save;
- `GET /api/brain/search`;
- `GET /api/brain/stats`;
- `GET /api/brain/recent`;
- `GET /api/brain/health`;
- `DELETE /api/brain/entries/:id`.

Its API contract is version 1.1.0 and says Bearer authentication is recommended, but optional on a network-trusted deployment. Its data contract defines `BrainEntry` with server-generated ID/timestamp, type/content/tags/source/metadata; `source.user_id` is optional. The client attaches a Bearer token only if `BRAIN_API_KEY` is configured. The Hub README explicitly says this repository is the MCP edge and not the Brain storage/embedding engine.

**Disposition:** the route family is a real *client-consumed contract*, not a verified backend implementation. The backend repository, deployed URL, auth enforcement, tenant isolation, database, schema migrations, and live consumers remain UNKNOWN. Do not map this API to Python `/v1/missions` or Node Knowledge Store without a separately verified adapter and data migration plan.

### 4.5 Identity and scope are incompatible until explicitly mapped

Python Mission derives mission IDs from authenticated `Identity.subject` plus the idempotency key. The Python identity seam defines subject and roles but explicitly leaves the authentication provider as an open decision. Node Orchestrator and Knowledge use tenant + project scoping. Hub BrainEntry exposes optional `source.user_id` but does not establish tenant/project scope in the API contract.

No source inspected establishes a trusted mapping:
`Identity.subject ↔ tenant_id ↔ project_id ↔ BrainEntry.source.user_id`.

This mapping is a **security blocker** for cross-context writes. Never accept tenant, project, owner, or actor identity solely from an untrusted request body.

### 4.6 Event envelope is not yet a shared cross-context contract

Node Orchestrator outbox receipts include a schema version and envelope hash; Python AuditEvent and Knowledge outbox have their own local shapes. The inspected sources do not establish one shared versioned event envelope across Python Mission, Node Orchestrator, Knowledge, and Hub.

A future integration envelope should be proposed as a new contract, not retroactively claimed as existing:
- `event_id`, `event_type`, `schema_version`;
- `aggregate_type`, `aggregate_id`;
- `tenant_id`, `project_id` where applicable;
- authenticated `principal_ref` and source system;
- `correlation_id`, `causation_id`;
- idempotency scope/key and payload digest;
- explicit `occurred_at` and `recorded_at` semantics;
- provenance/evidence references and payload classification.

Domain-local persistence and audit remain authoritative; cross-context envelopes are transport records, not new aggregate owners.

## 5. Candidate ADR decisions

| ADR | Proposed decision | Rationale | Rejected alternative |
|---|---|---|---|
| ADR-001 | One authoritative writer per aggregate; no global single-writer mandate | Preserves bounded-context autonomy while preventing dual-writer divergence | One universal DB/service owning every aggregate |
| ADR-002 | Mission and OrchestrationTask remain separate aggregates | Different lifecycle, identity/scope, persistence, and execution responsibilities | Treat every task as a Mission or vice versa |
| ADR-003 | Keep Orchestrator Outbox and Knowledge Outbox domain-local | Distinct transaction boundaries, payload semantics, retry policies | One global outbox without transactional ownership |
| ADR-004 | Keep Hub as MCP adapter until Brain Backend is identified and verified | Hub tree contains client/contracts/tools, not the storage backend | Promote Hub local dedup DB to Brain Store |
| ADR-005 | Require explicit Identity-to-Tenant/Project mapping before cross-context writes | Prevents cross-tenant authorization confusion | Infer tenant/project from optional user_id or request payload |
| ADR-006 | Add a versioned integration envelope only after contract tests are specified | Existing local event formats are not identical | Claim current events already form a universal envelope |
| ADR-007 | Preserve Python AuditStore and Node audit stream as domain-local evidence pending trust analysis | Their trust boundaries and persistence models differ | Collapse audit streams before defining external anchoring |

These ADRs are **PROPOSED**, not approved/frozen.

## 6. Blocking gaps and discriminating tests

| Gap | Why it blocks | Required evidence / test |
|---|---|---|
| Brain Backend repository and deployed service unknown | Hub contract has no verified server owner | Identify exact repo/ref, server routes, database schema, auth middleware, deployment identity, and live health response |
| Identity-to-tenant/project mapping unknown | Cross-context writes risk tenant escape or orphaned data | Negative tests for forged tenant/project/user IDs, cross-tenant reads/writes, role escalation, and mismatched principal mappings |
| Python registry + AuditStore cross-store atomicity undefined | Crash can leave divergent execution/audit views | Inject process termination after each write boundary; restart and prove deterministic reconciliation without duplicate dispatch |
| Node Orchestrator / Knowledge Durable Object live bindings unknown | Source code alone does not prove deployed bindings or namespace isolation | Inspect wrangler config and deployed environment read-only; run isolated namespace contract and tenant-isolation tests |
| Event envelope interoperability not specified | Correlation/replay across domains cannot be safely implemented | Golden fixtures, unknown-version rejection, idempotent replay, duplicate delivery, causal ordering, and schema migration tests |
| Audit external anchoring absent | Local hash chains do not prove protection from a privileged same-host rewrite | Independent external anchor, key custody, restore drill, and tamper/falsification tests |
| Hub optional authentication contract | Network-trusted optional Bearer policy may be inconsistent with platform zero-trust goals | Require explicit auth policy per deployment; unauthenticated read/write negative tests |
| Hub DELETE semantics | Deletion is destructive and not represented in Mission/Knowledge ownership map | Define retention/tombstone/approval/restore semantics and audit evidence before connecting it to shared storage |

No tests were executed as part of this read-only source inspection. Test status is **NOT_RUN** for all proposed contract and negative tests. Existing test files are not proof that tests pass on the selected integration SHA.

## 7. Gate 2 acceptance status

| Criterion | Status |
|---|---|
| Python Mission contract/lifecycle owner identified | PROVISIONALLY_SUPPORTED |
| Python approval and audit ownership identified | PROVISIONALLY_SUPPORTED |
| Python execution registry distinguished from audit history | PROVISIONALLY_SUPPORTED |
| Node Orchestration Task/Lease/Outbox ownership identified | PROVISIONALLY_SUPPORTED |
| Node Knowledge data/proposal/outbox ownership identified | PROVISIONALLY_SUPPORTED |
| Hub client-consumed API contract identified | CONFIRMED IN SOURCE |
| Hub backend owner and deployed implementation identified | UNKNOWN |
| Identity-to-tenant/project mapping verified | NOT_VERIFIED |
| Shared event envelope frozen | NOT_DONE |
| Golden cross-context fixtures authored and executed | NOT_RUN |
| Contract freeze / code migration authorized | NO |

**Gate 2 is PARTIALLY COMPLETE, NOT PASSED.** The selected source contexts and likely ownership boundaries are now mapped. Contract freeze remains blocked by backend ownership, identity mapping, cross-store recovery semantics, and executable interoperability evidence.

## 8. Next atomic step

Proceed to **Gate 2B — exact backend and adapter provenance**, with read-only inspection only:
1. Locate the actual Brain API backend repository or deployment owner; do not assume it is the Hub.
2. Inspect the Cloud Agent and MCP adapters for actual call paths and authentication boundaries.
3. Identify whether the Hub's BrainEntry store is implemented in another owned repository, a third-party service, or is currently absent.
4. Record exact refs, SHAs, route implementations, schema migrations, auth checks, and consumer tests.
5. If the backend cannot be identified, keep the BrainEntry backend boundary UNKNOWN and design no migration into it.

After Gate 2B, draft the first versioned cross-context contract and golden fixtures. Do not begin code migration until those fixtures and identity tests are independently reviewed.

## 9. Safety and scope

This document changes no application code and does not authorize:
- merges, PR updates, branch deletion, force-push, or changes to `main`;
- Cloudflare, Supabase, secrets, credentials, or deployment changes;
- production writes or local-machine changes;
- deletion or consolidation of historical records.

Production disposition remains **NO-GO** pending exact-SHA independent verification and operational acceptance.
