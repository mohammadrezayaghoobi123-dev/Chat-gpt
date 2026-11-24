# Engineering Evolution and System Integrity Governance (EGIS)

**Document ID:** EGIS-001  
**Version:** 1.0.1  
**Status:** Integrated design baseline; not implementation authorization  
**Date:** 2026-11-25  
**Supersedes:** EGIS-001 v0.2 and EGIS-DESIGN-08 v0.6.0-v1.0.0 design fragments  
**Scope:** Cross-domain engineering governance, evidence validity, authorization, release commit, recovery, and audit integrity

## 1. Purpose and normative language

EGIS defines one versioned governance contract for controlled engineering change. It integrates requirements, architecture, dependency impact, evidence, trust, policy, exceptions, authorization, release commit, deployment, and audit into one decision model.

The key principle is falsifiability: material claims must be exposed to counter-evidence, rival explanations, explicit falsification conditions, and discriminating tests. Outcomes are **SUPPORTED**, **DISPUTED**, **REJECTED**, or **UNKNOWN**. UNKNOWN is neither success nor failure.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

This document is a design baseline. It does not prove that a repository implementation, database transaction, cloud deployment, cryptographic control, or formal model conforms.

## 2. Architectural composition and ownership

EGIS has five responsibility layers:

1. **Core Governance:** canonical object definitions, invariants, lifecycle, authority boundaries, and meta-governance.
2. **Domain Profiles:** typed control requirements for AI/agents, data/distributed systems, cloud/infrastructure, security/trust, UI/clients, and plugins/integrations.
3. **Project Overlays:** project-specific requirements, risk thresholds, protected resources, and approved exceptions. Overlays may strengthen but MUST NOT weaken Core invariants.
4. **Environment Policies:** development, test, staging, and production constraints. Production policies are not inferred from staging.
5. **Governance Control Plane:** versioned registries, applicability resolution, evidence evaluation, authorization, decision records, and reconciliation.

The Strategic Intelligence/Cognition layer may decompose work, select specialists, generate hypotheses, and propose tests. It is not an authority source. Model or agent output is untrusted input until independently verified.

### 2.1 Single-writer ownership

| Canonical data class | Authoritative owner | Prohibited mutation by |
|---|---|---|
| Principal, membership, identity assurance | Identity and Membership | Agents, project workflows |
| Tenant and project scope | Tenant/Project Registry | Caller-supplied request fields |
| Requirements and applicability policy | Governance Registry | Evidence verifier |
| Component and dependency graph | Architecture/Dependency Registry | Release evaluator |
| Evidence artifacts and attestations | Evidence Registry | Policy evaluator |
| Verification results | Verifier Registry | Evidence producer |
| Trust, key status, authority grants | Trust Registry | Producer or agent |
| Policy versions | Policy Registry | Runtime evaluator |
| Exceptions | Exception Registry | Exception beneficiary |
| Authorization and decision records | Policy/Gate Service | Evidence producer or verifier |
| Commit and operation idempotency records | Release Commit Authority | Deployment controller |
| Deployment observations | Deployment Controller | Release authorizer |
| Audit events | Append-only Audit Service | Ordinary domain writers |

A service may own multiple data classes only where the trust boundary and authority model explicitly permit it. A component MUST NOT rewrite another owner's canonical records. Cross-context updates use commands, versioned events, or projections with reconciliation.

## 3. Canonical object model

All identifiers are opaque, stable, tenant-aware where applicable, and revisioned. Display names are not identifiers.

| Object | Required identity and content |
|---|---|
| Tenant | tenant_id, lifecycle_state, revision |
| Project | project_id, tenant_id, revision, policy_ref |
| Principal | principal_id, principal_type, issuer, subject, assurance_state |
| Membership | principal_id, tenant_id, status, role/grants, revision, validity |
| Requirement | requirement_id, revision, control_class, applicability_rule, acceptance_rule |
| Component | component_id, revision, owner, contract_refs, lifecycle_state |
| DependencyGraphSnapshot | graph_id, revision, canonical_edges, digest, completeness_attestation, source_refs |
| Change | change_id, revision, tenant_id, project_id, scope, class, status |
| EvidenceClaim | claim_id, revision, claim_text, target_requirement, scope, evidence_refs |
| EvidenceArtifact | artifact_id, immutable_locator, digest, media_type, size, captured_at |
| Attestation | attestation_id, signer_identity, signature, key_id, signed_payload_digest |
| VerificationRecord | verification_id, claim_revision, artifact_digest, verifier_identity, policy_revision, outcome, provenance |
| TrustState | trust_epoch, identity_status, key_status, revocation_state, authority_revision |
| PolicyRevision | policy_id, revision, evaluator_version, effective_interval |
| Exception | exception_id, revision, exact_scope, permitted_controls, approver, expiry, compensating_controls, evidence_refs, policy_revision |
| Snapshot | snapshot_id, immutable_manifest, manifest_digest, prepared_at, time_basis |
| Authorization | authorization_id, operation_id, snapshot_id, exact_scope, principal_id, policy_revision, trust_epoch, authority_revision, issued_at, expires_at, consumed_at |
| Attempt | attempt_id, operation_id, state, started_at, terminal_reason |
| CommitRecord | commit_id, operation_id, winning_attempt_id, authorization_id, snapshot_id, exact_scope, committed_at, artifact_digest, ledger_event_id |
| DeploymentRecord | deployment_id, commit_id, environment_id, state, observation_refs |
| DecisionRecord | decision_id, snapshot_id, gate_results, evidence_refs, exceptions, outcome, evaluator, approver, validity |
| LedgerEvent | sequence, event_id, event_type, actor, scope, operation_id, snapshot_ref, occurred_at, recorded_at, previous_event_digest, event_digest |

### 3.1 Identity and scope

A request's tenant or project selector is not proof of authority. The trusted boundary MUST derive principal identity from validated credentials, resolve active tenant membership, and independently resolve project permission. Scope is the tuple:

`Scope = (tenant_id, project_id, change_id, principal_id)`

Authorization MUST bind the exact tuple and the required action. A change in any member invalidates the authorization.

Cross-tenant membership is explicit. Tenant membership does not imply access to every project. Agent identities are workload identities with bounded, expiring capabilities; they cannot grant themselves authority.

### 3.2 Dependency closure

For affected components `A` and a graph snapshot `G=(V,E)`, define the dependency closure as the least set containing `A` and closed under the graph's directed dependency relation:

`Closure(A,G) = least R such that A ⊆ R and Successors(R,G) ⊆ R`.

The graph digest MUST bind the canonical graph representation, revision, source references, and completeness attestation. A graph with unknown or incomplete source coverage is not eligible to justify NOT_APPLICABLE.

The graph registry is authoritative. An evaluator MUST NOT invent, silently normalize, or repair dependency edges during authorization.

## 4. Evidence and verification protocol

Evidence validity has four independent layers:

1. **Integrity:** canonicalization, digest, immutable artifact reference, and tamper detection.
2. **Authenticity:** signer identity, signature verification, key status, and authority to make the attestation.
3. **Provenance and trust:** producer, build/test runner, toolchain, inputs, dependencies, environment, and chain of custody.
4. **Semantic validity:** exact claim, scope, revision, acceptance criteria, coverage, counter-evidence, and independent review.

The following implications are prohibited:

- Valid signature does not imply valid evidence.
- Valid evidence does not imply the claim is true.
- A green test does not prove test completeness.
- A producer's assertion does not prove verifier independence.
- Missing evidence does not prove failure.
- Unknown does not become PASS by default, timeout, retry, or aggregation.

Evidence lifecycle:

`CAPTURED → QUARANTINED → STRUCTURALLY_VALIDATED → INTEGRITY_VERIFIED → AUTHENTICITY_VERIFIED → PROVENANCE_VERIFIED → SCOPE_VERIFIED → SEMANTICALLY_REVIEWED → ACCEPTED`

Terminal or non-accepting states include `UNKNOWN`, `DISPUTED`, `REJECTED`, `EXPIRED`, `SUPERSEDED`, and `REVOKED`.

Each test attempt is retained. Outcomes include PASS, FAIL, FLAKY, INCONCLUSIVE, INFRASTRUCTURE_FAILURE, and NOT_RUN. A later PASS does not erase a prior failure. Attempts in different environments are not identical retries.

## 5. Applicability, gates, and exceptions

The gate lattice is:

`PASS | FAIL | UNKNOWN | DISPUTED | EXPIRED | REVOKED | SUPERSEDED | NOT_APPLICABLE | EXCEPTION_APPROVED`.

A mandatory gate is acceptable only if:
- its applicable evidence is valid for the exact snapshot and claim revision, and required independent verification passes; or
- NOT_APPLICABLE is independently justified by a complete, trusted dependency closure and exact requirement revision; or
- a valid exception covers that exact permitted control and exact scope.

A proven mandatory failure rejects the affected change. A mandatory UNKNOWN blocks authorization for the affected scope. A dispute blocks until resolved. These states do not automatically block unrelated scopes when non-applicability and isolation are independently proven.

### 5.1 NOT_APPLICABLE proof

NOT_APPLICABLE MUST include:
- requirement ID and revision;
- exact tenant/project/change scope;
- complete dependency graph revision and digest;
- closure computation result and source provenance;
- evidence that no applicable dependency path exists;
- independent reviewer identity and rationale.

Absence from an incomplete graph is not proof of non-applicability.

### 5.2 Exception controls

Exceptions MUST be created and approved before the final snapshot is prepared. The snapshot binds the exception ID, revision, scope, approver authority revision, policy revision, expiry, compensating controls, and evidence references.

An exception is valid only when:
- its scope exactly matches the change;
- the approver is authorized at the captured authority revision;
- the exception is unexpired at commit time;
- the policy revision matches;
- compensating controls and supporting evidence are present;
- the control is explicitly exceptionable.

Hard invariants MUST NOT be waived. A revoked, expired, superseded, or out-of-scope exception is invalid. Changing an exception after Prepare invalidates the snapshot.

## 6. Independent verification and contradiction discipline

Producer, primary verifier, independent oracle, and approver are separate roles. No identity may approve its own produced evidence or its own verification result.

Independence assessment MUST examine known shared failure domains, authority, code lineage, data source, toolchain, execution environment, and evidence path. Distinct labels or accounts do not establish independence. Independence here is structural and threat-model-based; it is not a claim of statistical independence or proof that no hidden common cause exists.

Material claims require:
- a falsification condition;
- at least one plausible rival hypothesis;
- counter-evidence search;
- a discriminating test;
- retained negative and inconclusive results;
- a record of why a decision changed.

## 7. Atomic lifecycle and transition contract

Canonical lifecycle:

`PROPOSED → PREPARED → EVALUATED → AUTHORIZED → COMMIT_PENDING → COMMITTED`

Alternative states include `BLOCKED_UNKNOWN`, `BLOCKED_DISPUTED`, `REJECTED`, `ABORTED`, and `RECOVERY_PENDING`.

### 7.1 Prepare

Prepare resolves and freezes:
- exact scope and active membership revision;
- change and component revisions;
- applicable requirement set and revisions;
- dependency graph revision, canonical digest, completeness attestation, and closure;
- evidence claims, artifact digests, attestations, verification records, and revocation state;
- primary and oracle identities and independence assessment;
- trust epoch, authority revision, policy revision, and evaluator version;
- exception revisions and expiry;
- environment identity and time basis.

The snapshot is immutable. A decision-relevant mutation invalidates it.

### 7.2 Evaluate

Evaluate operates only on the prepared snapshot. Gate results, evidence selections, and oracle outcomes are immutable for that evaluation. A changed input requires a new snapshot and a new evaluation.

### 7.3 Authorize

Authorization is issued only when every applicable mandatory gate is acceptable, the scope and authority are valid, evidence and independence checks pass, no unresolved mandatory UNKNOWN or DISPUTED state remains, and the snapshot is current.

Authorization binds:
- operation_id and authorization_id;
- exact snapshot_id and manifest digest;
- exact Scope tuple and principal;
- policy, trust, and authority revisions;
- issuance and expiry;
- single-use consumption state.

### 7.4 Attempt and Commit

Multiple attempts may race for one logical operation. A commit authority MUST enforce at most one durable CommitRecord for the operation using a storage-enforced uniqueness constraint or equivalent linearizable compare-and-swap.

The following must be one atomic storage boundary:
1. revalidate authorization, expiry, scope, snapshot, policy, trust, authority, exception, evidence revocation, and gate state;
2. consume the authorization;
3. reserve the operation/idempotency key;
4. create the immutable CommitRecord;
5. append the corresponding audit event or a transactionally coupled outbox record.

If the storage system cannot guarantee this boundary, the implementation is not authorized to perform release commits.

This is an implementation contract, not a proof that a particular database or cloud provider provides the required transaction semantics.

### 7.5 Retry and idempotency

The platform MUST NOT claim exactly-once execution of external effects. It MUST provide durable operation identity, at-most-one logical commit record, explicit attempt history, replay detection, and reconciliation.

A retry uses the same logical operation identity and must first inspect authoritative durable state. A new attempt is not a new authorization. A consumed authorization cannot be reused.

### 7.6 Ambiguous commit and recovery

Separate:
- `CommitTruth`: durable storage outcome;
- `CommitObservation`: what the caller has reliably observed.

If the acknowledgement is lost, observation is UNKNOWN. The system enters RECOVERY_PENDING and does not blindly retry.

Reconciliation:
- If an authoritative, linearizable read finds the matching CommitRecord, verify its scope, authorization, snapshot, and operation identity, then resolve COMMITTED.
- If an authoritative read proves the record absent after the storage system's consistency boundary, resolve ABORTED.
- If the storage system is unavailable, stale, or cannot establish authoritative absence, remain UNKNOWN/RECOVERY_PENDING.

Absence from an eventually consistent replica is not proof of non-commit.

## 8. Release, deployment, and rollback

Release Artifact commit and Deployment are separate state machines.

- A committed release artifact does not imply deployment.
- Deployment requires a valid committed artifact, target environment authorization, deployment policy, and deployment-specific evidence.
- Deployment failure does not erase the release commit.
- Rollback is a new controlled deployment operation referencing a previously accepted artifact; it is not deletion or rewriting of history.
- Recovery and reconciliation preserve the original commit and deployment observations.

## 9. Audit and chain of custody

Ledger events are append-only and include monotonically increasing sequence, event ID/type, actor, scope, operation, snapshot reference, occurred_at, recorded_at, previous-event digest, event digest, and trusted timestamp reference where required.

A hash chain alone does not prevent an attacker with full rewrite access from rewriting the entire chain. High-assurance environments require an independent immutable store or externally controlled periodic anchor, key separation, retention controls, and verifiable timestamping.

Audit write failure MUST NOT silently convert a release commit into an unaudited success. Use a transactionally coupled outbox or a storage boundary that commits the release record and audit intent atomically, followed by independently reconciled external anchoring.

## 10. Core invariants

- **EGIS-CORE-001 Established invariant preservation:** no change may silently weaken a protected invariant.
- **EGIS-CORE-002 Authoritative ownership:** one authoritative writer per canonical data class.
- **EGIS-CORE-003 Explicit contract boundaries:** cross-context writes use versioned commands/events.
- **EGIS-CORE-004 Complete impact analysis:** direct and transitive impact is resolved from a complete graph.
- **EGIS-CORE-005 Compatibility verification:** API, schema, event, data, and client compatibility is evidenced.
- **EGIS-CORE-006 Controlled migration:** migrations are versioned, rehearsed, observable, and recoverable.
- **EGIS-CORE-007 Distributed failure semantics:** retries, duplicates, ordering, leases, fencing, and ambiguous outcomes are explicit.
- **EGIS-CORE-008 Security and trust boundaries:** identity, tenant, project, capability, and environment are independently checked.
- **EGIS-CORE-009 Independent verification:** producer output is not self-approval.
- **EGIS-CORE-010 Evidence provenance:** claims bind immutable artifacts, attestations, revisions, and verification records.
- **EGIS-CORE-011 Bounded exposure:** compute, time, cost, retries, and external effects have explicit limits.
- **EGIS-CORE-012 Controlled standard evolution:** changes to EGIS itself require compatibility and governance regression.
- **EGIS-CORE-013 Explicit authorization:** consequential actions require scoped, version-bound, expiring, single-use authorization.
- **EGIS-CORE-014 Assumption reassessment:** forecasts and assumptions have measurable triggers and expiry.
- **EGIS-CORE-015 Safe retirement:** components, keys, policies, and interfaces have migration and retirement paths.
- **EGIS-CORE-016 No cross-scope commit:** commit scope equals the authorization and snapshot scope.
- **EGIS-CORE-017 No UNKNOWN bypass:** mandatory UNKNOWN cannot be interpreted as PASS.
- **EGIS-CORE-018 No false N/A:** non-applicability requires complete graph and independent justification.
- **EGIS-CORE-019 Single logical commit:** one operation has at most one durable winning CommitRecord.
- **EGIS-CORE-020 Historical decision integrity:** later policy/trust changes do not rewrite the historical basis of a prior commit; current revocation affects future actions and any explicitly revocable artifact.
- **EGIS-CORE-021 Recovery honesty:** ambiguous outcomes remain UNKNOWN until authoritative reconciliation.
- **EGIS-CORE-022 Release/deployment separation:** artifact commit and deployment observations remain distinct.

## 11. Change risk and progressive adoption

Change classes C0-C3 are impact-based, not labels chosen by the author. Classification considers protected data, security boundary, tenant scope, external side effects, compatibility, reversibility, blast radius, and cost exposure.

A low-risk change may use a reduced evidence set only where the profile proves that omitted controls are not applicable. A high-risk change requires stronger independent evidence. Unknown evidence blocks only the affected mandatory scope, not unrelated scopes with proven isolation.

## 12. Meta-governance

Changes to EGIS require:
- impact analysis against all core invariants;
- migration and backward-compatibility strategy;
- policy and schema versioning;
- adversarial mutation tests;
- independent review;
- explicit effective date and supersession record;
- rollback and recovery criteria.

The governance engine MUST NOT approve its own policy change. Policy author, verifier, and approver authority are separated.

## 13. Conformance and implementation boundary

Conformance states:
- `NOT_ASSESSED`
- `DESIGN_CONFORMANT`
- `TESTED_CONFORMANT`
- `INDEPENDENTLY_VERIFIED`
- `OPERATIONALLY_OBSERVED`
- `NONCONFORMANT`

A state can advance only with evidence. Design conformance is not implementation conformance. Unit tests do not establish production readiness. Formal model checking does not prove implementation correctness.

Required traceability:

`Requirement → Risk → Architecture Decision → Contract → Component → Implementation → Test → Evidence → Independent Review → Release Decision → Operational Observation`

## 14. Explicit exclusions and open implementation decisions

This baseline does not select a database, cryptographic algorithm, timestamp authority, immutable audit vendor, deployment provider, or specific transaction isolation level. Those choices require provider-specific capability evidence and failure testing.

Before production implementation, the project must identify:
- the authoritative commit store and its linearizability/transaction guarantees;
- the transactional outbox or equivalent audit coupling mechanism;
- the immutable evidence and artifact store;
- trust/key lifecycle and external revocation source;
- independent timestamp and ledger anchoring mechanism;
- the first bounded domain profile and its measurable acceptance criteria;
- the finite model bounds and abstraction assumptions for formal verification.

No production or repository runtime is declared conformant by this design document.
