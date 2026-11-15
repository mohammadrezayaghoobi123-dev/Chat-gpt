# Master Brain — ADR-G2N-01: Dedicated WriteControl Bounded Context
**Date:** 2026-11-15  
**Decision ID:** MB-ADR-G2N-WRITECONTROL-2026-11-15-001  
**Related gates:** 2K, 2L, 2M, 2N  
**Branch:** integration/master-brain-unification-2026-11-15  
**Status:** PROPOSED — OWNER APPROVAL PENDING — NOT FROZEN  
**Implementation authorization:** NONE  
**Deployment authorization:** NONE

## 1. Context

The protected GitHub write path currently performs external GitHub POST operations directly in `createChangePr`. It has no durable write-operation reservation, full-scope idempotency, phase ledger, lease/fencing, or general UNKNOWN recovery.

The existing `OrchestratorLedger` owns task projections, task transitions, execution leases, task-linked outbox events, owner-command receipts, and task-associated audit events. Its outbox and audit APIs require task identity and worker/task semantics. A GitHub write operation is a separate lifecycle and may exist without an OrchestrationTask.

`TenantDirectory` remains the authoritative owner of membership and project authorization. GitHub remains the authority for the external repository state.

Gate 2M accepted a service-only v1 identity direction. That decision does not authorize this storage decision or implementation.

## 2. Proposed decision

Create a dedicated `WriteControl` Durable Object bounded context to own only the lifecycle of protected external write operations.

WriteControl owns:
- full-scope operation admission and idempotency;
- canonical request fingerprint;
- lease generation and fencing;
- durable phase transitions;
- UNKNOWN quarantine;
- privileged reconciliation receipts;
- operation audit events and transactional outbox;
- global emergency, tenant, service-principal, project, repository and unresolved-operation limits.

WriteControl does not own:
- human/service authentication or credential secrets;
- TenantDirectory membership or project policy;
- Mission or OrchestrationTask lifecycle;
- KnowledgeStore or BrainEntry content;
- GitHub repository data or final truth about remote state.

## 3. Initial topology proposal

For constrained service-only v1, use one logical WriteControl coordinator instance so that admission, idempotency, per-tenant counters, unresolved-operation counts and the global emergency ceiling can be coordinated in one local transaction.

This topology is conditional on measured throughput, latency, storage, cost, and availability evidence. It is not a global single-writer mandate for Master Brain and is not approved for unlimited traffic.

Do not shard in v1. Any later sharding requires a separate ADR covering stable operation identity, partitioning, migration of UNKNOWN operations, duplicate prevention, global ceiling semantics, backup/restore, and rollback.

## 4. Alternatives considered

### A. Add WriteOperation to OrchestratorLedger

**Rejected for current design.** It would couple independent external-write lifecycle to task lifecycle, task IDs, task leases, task outbox, and task-oriented audit semantics. Synthetic task creation would create false ownership and complicate idempotency and recovery.

### B. Dedicated WriteControl DO

**Recommended.** It preserves bounded-context ownership and gives the external write path an operation-native state machine and audit boundary.

### C. Reuse TenantDirectory as the write-operation store

**Rejected.** TenantDirectory owns authorization state. Mixing high-frequency GitHub operation state with membership and policy changes would couple unrelated availability, retention, migration, and transaction boundaries.

### D. Store operation state only in Orchestrator outbox

**Rejected.** The existing outbox is task-linked and does not provide the required write-operation phase model or exact full-scope operation identity.

## 5. Required invariants

1. No external GitHub write before authentication, current membership, exact project/action/resource authorization, durable operation admission, and initial local audit/outbox commit.
2. The full security scope is principal type/ID, tenant, project, action, and normalized resource.
3. The operation identity and request fingerprint are separate values.
4. The request fingerprint includes the exact normalized PR summary and every other operation-affecting input.
5. Replay and UNKNOWN continuation re-check current service credential and current authorization.
6. Each external dispatch is preceded by a durable DISPATCHED phase.
7. Ambiguous network outcomes remain UNKNOWN; no blind replay of ambiguous non-idempotent POST operations.
8. Lease generation fences stale workers.
9. Reconciliation is a separate capability and requires exact independently observed external evidence.
10. IN_PROGRESS and UNKNOWN are never silently pruned.
11. Audit/outbox reservation is atomic with operation admission inside WriteControl storage.
12. TenantDirectory and WriteControl are separate DOs; no cross-DO atomicity is claimed.
13. No end-user receives the shared bearer; no human attribution is inferred.
14. Unknown or unexecuted evidence is never labelled PASS or FAIL.

## 6. Authorization boundary

TenantDirectory remains authoritative. WriteControl stores the authorization decision reference, membership version, policy version, exact resource digest and decision time.

Because separate Durable Objects cannot participate in one storage transaction, the contract must define a point-in-time authorization linearization rule. Current authorization is checked before admission, on replay/reconciliation, and immediately before each new external dispatch. Revocation after an already-dispatched external request cannot retroactively cancel that request; the recorded authorization version must make this boundary auditable.

Wildcard resource rules for `project.create_pr` remain DENY unless separately approved. The current code's wildcard fallback is an open blocker, not an implemented guarantee.

## 7. Credential lifecycle boundary

The Worker authenticator must eventually resolve the shared bearer to:
- stable principal `service:shared-mcp-bearer`;
- non-secret credential identifier;
- credential version/key ID;
- current validity/revocation status.

Secret values remain only in the platform secret manager. The operation record and audit event may contain only non-secret credential metadata. Rotation, bounded overlap, expiry, revocation propagation, and emergency disable must be explicitly designed and tested. This ADR does not read, rotate, replace, or alter any live secret.

## 8. Consequences

**Positive**
- Separates authorization, task orchestration, and external side-effect lifecycle.
- Prevents a synthetic task from becoming a prerequisite for every external write.
- Enables operation-native idempotency, phase tracking, fencing, UNKNOWN, and reconciliation.
- Keeps the current OrchestratorLedger contract stable.

**Negative / residual risks**
- Adds a new DO class, binding, schema, tests, dashboards, and operational ownership.
- One global coordinator may become a bottleneck or availability dependency.
- Cross-DO authorization is not atomic with WriteControl admission.
- Strict global quota semantics become more complex if the coordinator is later sharded.
- Credential versioning and wildcard DENY are not yet implemented.

## 9. Approval and implementation gates

This ADR is not frozen. Before implementation:
- [ ] Owner approves the dedicated WriteControl bounded context.
- [ ] Owner approves or revises the single-coordinator v1 topology after capacity analysis.
- [ ] Independent reviewer challenges aggregate ownership and cross-DO authorization semantics.
- [ ] Service credential issuer/custodian and lifecycle are identified.
- [ ] Wildcard write behavior is enforced as DENY and covered by negative tests.
- [ ] Membership version is carried into trusted operation context.
- [ ] Operation schema, canonicalization and request fingerprint have golden fixtures.
- [ ] Crash/failure injection matrix is implemented and executed.
- [ ] Worker + real TenantDirectory + WriteControl integration is verified.
- [ ] Rollback, backup/restore, monitoring and emergency disable are evidenced.

Owner acceptance of the service-only identity direction in Gate 2M does not satisfy these approvals.

## 10. Status

**PROPOSED ARCHITECTURE:** dedicated WriteControl DO.  
**ORCHESTRATOR LEDGER:** remains task-owned.  
**TENANT DIRECTORY:** remains authorization-owned.  
**OWNER APPROVAL:** PENDING.  
**INDEPENDENT REVIEW:** NOT_RUN.  
**IMPLEMENTATION:** NOT_AUTHORIZED.  
**TESTS:** NOT_RUN.  
**STAGING/PRODUCTION:** NO-GO.
