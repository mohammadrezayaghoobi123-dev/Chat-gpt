# EGIS-001 — Integrated Engineering Evolution and System Integrity Governance

**Version:** 1.0.2  
**Status:** Design baseline; formal and implementation conformance NOT_ESTABLISHED  
**Supersedes:** v1.0.1 for review purposes only; v1.0.1 remains immutable historical evidence  
**Date:** 2026-11-25

## 1. Purpose and authority

EGIS defines a single governance contract for controlled engineering change, evidence, authorization, release, deployment, and recovery. It combines broad engineering intelligence with falsification, independent verification, security, traceability, bounded cost, and rollback controls.

EGIS is a governance standard, not a claim that a repository, model, database, cloud service, or deployment is conformant. Design, formal-model, implementation, and operational conformance are separate evidence-backed states.

No agent, producer, model, evaluator, or governance engine may approve its own consequential output or policy change.

## 2. Canonical architecture and ownership

The architecture consists of:
1. Supreme Command Core — policy authority and cross-domain coordination.
2. Strategic Intelligence/Cognition — mandatory decomposition, routing, impact analysis, hypothesis competition, and evidence orchestration.
3. Domain Profiles — isolated domain-specific requirements and controls.
4. Project Overlays — project-specific constraints that may strengthen but not silently weaken core invariants.
5. Environment Policies — environment-specific authorization and operational constraints.
6. AI, agents, plugins, and tools — untrusted capability providers operating through versioned contracts.
7. Governance Control Plane — canonical registries, policy evaluation, evidence ledger, decisions, and lifecycle coordination.

Canonical ownership is single-writer by data class:
- Scope and membership registry owns tenant/project/principal membership and revisions.
- Change registry owns change and component revisions.
- Requirement registry owns requirement revisions and applicability declarations.
- Dependency registry owns graph versions, sources, completeness attestations, and canonical digests.
- Evidence service owns claims, artifacts, attestations, verification records, and revocation state.
- Trust service owns identities, keys, authority, revocation, and trust epochs.
- Policy registry owns policy revisions and evaluator versions.
- Exception registry owns exception records and revocation.
- Commit authority owns operation uniqueness, authorization consumption, and durable CommitRecords.
- Ledger service owns append-only audit events and external anchoring references.
- Release and Deployment services own distinct lifecycle records.

Consumers may propose changes but cannot write another registry's canonical state. Cross-context changes use versioned commands/events with explicit idempotency and authorization semantics.

## 3. Canonical identity and scope

Canonical Scope:
`Scope = (tenant_id, project_id, change_id, principal_id, membership_revision)`

Distinguish:
- `RequestedScope`: untrusted scope supplied by a caller.
- `ResolvedScope`: scope derived by trusted identity, tenant, project, and membership services.
- `AuthorizedScope`: exact scope bound into the authorization.

Required condition:
`RequestedScope == ResolvedScope == AuthorizedScope`

This equality is necessary but not sufficient. Principal status, active membership, capability, project permission, tenant isolation, and environment authorization must independently pass.

No caller-, agent-, or model-supplied tenant/project field is authoritative by itself. Membership and authority are revalidated at the consequential action boundary, including queued/background execution.

## 4. Canonical records

All records are versioned, tenant-scoped where applicable, and immutable after acceptance except through superseding records.

### 4.1 Operation identity

`OperationKey = (tenant_id, project_id, operation_id)`

`OperationFingerprint = H(canonical_action, change_revision, snapshot_digest, artifact_digest)`

The same OperationKey with a different fingerprint is a conflict, not a retry. The production registry enforces uniqueness over the full key. Attempt IDs, authorization IDs, commit IDs, principal IDs, and authority IDs are distinct namespaces and types.

### 4.2 Snapshot

Snapshot binds:
- resolved Scope and membership revision;
- operation identity and fingerprint;
- change/component revisions;
- requirement set and revisions;
- dependency graph ID, revision, canonical edge set digest, source provenance, completeness attestation, and closure result;
- evidence claim, artifact, attestation, verification, and revocation references;
- producer, primary verifier, oracle, and approver identities and authority revisions;
- trust epoch, policy revision, evaluator version, exception revisions;
- environment identity, time basis, and relevant external dependency revisions.

A decision-relevant mutation invalidates the snapshot. Snapshot identity and manifest digest are immutable.

### 4.3 Evidence

Evidence validity has four independent dimensions:
1. Integrity — canonical artifact digest and immutable artifact reference.
2. Authenticity — signature and identity binding.
3. Provenance/trust — source, builder, toolchain, inputs, environment, authority, and revocation.
4. Semantic validity — exact claim, scope, revision, acceptance criteria, coverage, and independent review.

A valid signature does not prove a valid claim. Evidence from another tenant, project, change, revision, environment, or policy is not reusable unless an explicit, reviewed portability contract permits it.

### 4.4 Dependency graph and N/A

`GraphSnapshot = (graph_id, revision, canonical_edges, digest, source_provenance, completeness_attestation)`

The digest must be computed over a specified canonical encoding of graph identity, revision, edges, and source references. Completeness must be attested by an authority distinct from the change producer and must identify the source inventory and known omissions.

`Closure(AffectedComponents, GraphSnapshot)` is computed from the complete directed graph. A gate may be NOT_APPLICABLE only if:
- graph completeness and provenance are valid;
- closure is independently recomputed or checked;
- no applicable component or dependency path exists;
- the N/A rationale is bound to the exact graph and requirement revisions.

An incomplete or untrusted graph makes N/A UNKNOWN, never PASS.

### 4.5 Exceptions

ExceptionRecord binds exact tenant/project/change, permitted gate IDs, approver principal and authority revision, issue/expiry time, policy revision, compensating controls, evidence references, and revocation state.

Exceptions must exist before Prepare and be included in the Snapshot. A later exception change requires a new snapshot and evaluation. Hard invariants are never exceptionable.

### 4.6 Authorization

AuthorizationRecord binds authorization_id, operation key/fingerprint, exact Scope, snapshot ID/digest, policy revision, trust epoch, authority revision, membership revision, exception revisions, issuance/expiry, permitted action, and single-use state.

A new attempt is not a new authorization. A consumed, expired, revoked, scope-mismatched, or stale authorization cannot be reused.

### 4.7 Commit and audit

CommitRecord binds commit_id, OperationKey/fingerprint, winning attempt, authorization, snapshot, exact Scope, all validated revisions, durable commit time, and audit intent ID.

LedgerEvent includes sequence number, event ID/type, actor, scope, operation, snapshot reference, occurred_at, recorded_at, previous-event digest, event digest, and trusted timestamp/anchor reference where required.

A hash chain alone does not prevent total rewrite. High-assurance deployments require independent immutable storage or externally controlled anchoring, key separation, retention controls, and verifiable timestamps.

## 5. Canonical lifecycle

`PROPOSED → PREPARED → EVALUATED → AUTHORIZED → COMMIT_PENDING → COMMITTED`

Alternative terminal or controlled states:
`BLOCKED_UNKNOWN, BLOCKED_DISPUTED, REJECTED, ABORTED, RECOVERY_PENDING`.

Release and Deployment have separate state machines.

### 5.1 Prepare

Resolve and freeze every decision-relevant field listed in Snapshot. Reject incomplete identity, membership, dependency, evidence, provenance, or policy inputs. A prepare operation does not authorize a write.

### 5.2 Evaluate

Evaluate only the immutable Snapshot. Primary and oracle results, evidence selections, and gate outcomes are frozen for that evaluation. Any changed input requires a new Snapshot and new evaluation.

### 5.3 Authorize

Authorize only when every applicable mandatory gate is acceptable, no mandatory UNKNOWN or DISPUTED remains, scope and authority are valid, evidence and independence checks pass, and the Snapshot remains current.

### 5.4 Attempts and atomic Commit

Multiple attempts may race for one OperationKey. The commit authority must enforce at most one durable CommitRecord using a storage-enforced unique constraint or equivalent linearizable compare-and-swap.

One atomic storage boundary must:
1. Re-resolve/revalidate Scope, membership, capability, authorization expiry/revocation, snapshot, graph completeness, evidence revocation, trust, policy, authority, and exceptions.
2. Consume the single-use authorization.
3. Reserve the OperationKey and verify its fingerprint.
4. Create exactly one immutable CommitRecord.
5. Persist the audit intent in the same transaction or a transactionally coupled outbox.

If the selected storage system cannot demonstrate this boundary under concurrency and crash injection, release commits are prohibited. This is an implementation requirement, not a proof about any provider.

### 5.5 Commit truth and observation

Keep independent variables:
- `CommitTruth ∈ {COMMITTED, AUTHORITATIVELY_ABSENT, UNKNOWN}`
- `CommitObservation ∈ {ACKNOWLEDGED_COMMITTED, ACKNOWLEDGED_ABORTED, UNKNOWN}`

Lost acknowledgement does not change durable truth. UNKNOWN is neither success nor failure. No blind retry is permitted.

Reconciliation:
- A matching CommitRecord found through an authoritative, linearizable read resolves COMMITTED after binding verification.
- Absence resolves ABORTED only after the store's documented consistency boundary proves authoritative absence.
- Replica absence, timeout, stale reads, or unavailable storage remain UNKNOWN/RECOVERY_PENDING.

While RECOVERY_PENDING, no new attempt may start for that OperationKey.

### 5.6 Attempt finalization

After the durable outcome is reconciled, exactly one attempt is WON if committed. All other attempts become REJECTED or CANCELLED with reason and evidence. No attempt remains indefinitely PENDING after terminal reconciliation. Timeout alone does not prove failure.

## 6. Gate lattice and decision rules

Gate outcomes:
`PASS, FAIL, UNKNOWN, DISPUTED, EXPIRED, REVOKED, SUPERSEDED, NOT_APPLICABLE, EXCEPTION_APPROVED`.

Mandatory acceptance requires:
- PASS with accepted, fresh, scope-bound evidence and independent verification; or
- valid NOT_APPLICABLE under Section 4.4; or
- permitted EXCEPTION_APPROVED under Section 4.5.

FAIL rejects the affected change scope. Mandatory UNKNOWN blocks that scope. DISPUTED blocks until resolved. Unrelated scopes may proceed only when isolation is proven and the dependency graph is complete.

Unknown is never converted into PASS or FAIL without new evidence.

## 7. Verifier and oracle independence

Producer, primary verifier, independent oracle, and approver are distinct roles. Structural independence checks known common failure domains, code/toolchain, source data, evidence path, identity authority, and execution environment.

This establishes only independence against declared and known common causes. It does not prove statistical independence or absence of hidden common causes. Shared dependencies must be recorded as residual risk; where independence is mandatory and unknown, the gate remains UNKNOWN.

## 8. Release, deployment, and rollback

A committed artifact does not imply deployment. Deployment requires a valid CommitRecord, target environment authorization, deployment policy, and deployment-specific evidence.

Deployment failure does not erase or rewrite the release commit. Rollback is a new authorized deployment operation referencing a previously accepted artifact, with current revocation and compatibility checks. Historical release and deployment events remain immutable.

## 9. Safety, liveness, and bounded exposure

Safety includes no cross-scope commit, no stale authorization, no UNKNOWN bypass, no false N/A, no hard-invariant exception, no duplicate logical commit, no blind retry, no unauthorized deployment, and no historical record rewrite.

Liveness is conditional on store availability, fair reconciliation scheduling, and durable record retention. No unconditional liveness or exactly-once external-effect claim is made.

Compute, time, retries, external calls, storage, and financial exposure are bounded by policy. Risk classes C0-C3 are impact-based, not author-selected.

## 10. Core invariants

- CORE-001 Established invariant preservation.
- CORE-002 One authoritative writer per canonical data class.
- CORE-003 Explicit versioned contract boundaries.
- CORE-004 Complete direct and transitive impact analysis.
- CORE-005 Compatibility verification.
- CORE-006 Controlled, recoverable migration.
- CORE-007 Explicit distributed failure and retry semantics.
- CORE-008 Identity, tenant, project, capability, and environment isolation.
- CORE-009 Independent verification and separation of duties.
- CORE-010 Evidence provenance and audit traceability.
- CORE-011 Bounded resource and economic exposure.
- CORE-012 Controlled standard evolution.
- CORE-013 Scoped, expiring, single-use authorization.
- CORE-014 Forecast and assumption reassessment.
- CORE-015 Safe component and key retirement.
- CORE-016 Commit Scope equals authorization and Snapshot Scope.
- CORE-017 Mandatory UNKNOWN never bypasses.
- CORE-018 N/A requires complete trusted graph and independent closure.
- CORE-019 At most one durable CommitRecord per OperationKey.
- CORE-020 Historical decisions retain their captured basis; later revocation governs future actions unless an explicit revocation policy applies to the artifact.
- CORE-021 Ambiguous outcomes remain UNKNOWN until authoritative reconciliation.
- CORE-022 Release and Deployment remain separate.
- CORE-023 OperationKey reuse with a different fingerprint is rejected.
- CORE-024 Background execution revalidates current membership and capability.

## 11. Meta-governance and conformance

Changes to EGIS require invariant impact analysis, schema/policy migration, compatibility tests, adversarial mutations, independent review, effective date, supersession record, and rollback criteria. EGIS cannot approve its own policy changes.

Conformance states:
`NOT_ASSESSED, DESIGN_CONFORMANT, TESTED_CONFORMANT, INDEPENDENTLY_VERIFIED, OPERATIONALLY_OBSERVED, NONCONFORMANT`.

No state advances without evidence. Formal model checking does not prove implementation correctness.

Required traceability:
`Requirement → Risk → Architecture Decision → Contract → Component → Implementation → Test → Evidence → Independent Review → Release Decision → Operational Observation`.

## 12. Explicit non-claims and open decisions

This standard does not select a database, transaction isolation level, cryptographic algorithm, timestamp authority, immutable ledger vendor, deployment provider, or first domain profile.

Before implementation, select and evidence:
- authoritative commit store and its linearizability/transaction guarantees;
- transactionally coupled outbox mechanism;
- evidence/artifact immutability and revocation;
- trust/key lifecycle and authoritative membership source;
- external ledger anchor and trusted timestamp;
- first bounded domain profile;
- finite model bounds and abstraction assumptions.

Current conformance: design baseline only. SANY, TLC, mutation tests, provider fault injection, and implementation refinement are NOT_RUN or NOT_ESTABLISHED.
