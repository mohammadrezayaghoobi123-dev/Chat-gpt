# EGIS-001 — Integrated Engineering Evolution and System Integrity Governance

**Version:** 1.1.0  
**Status:** Integrated design candidate; formal and implementation conformance NOT_ESTABLISHED  
**Baseline:** EGIS-001 v1.0.2  
**Formal recovery baseline:** EGIS Atomic Recovery v1.0.4  
**Composition increment:** EGIS Operation Composition v1.1.0  
**Date:** 2026-11-25

## 1. Authority and version relationship

This document is the integrated v1.1.0 design candidate. It retains the v1.0.2 architecture, governance, evidence, exception, lifecycle, release/deployment, and conformance requirements except where the operation-identity, attempt, commit, and recovery rules are explicitly refined below.

The following v1.0.2 clauses remain the baseline for all unaffected requirements: architecture and registry ownership; scope semantics; evidence and graph provenance; exceptions; verifier/oracle independence; gate lattice; release/deployment separation; bounded exposure; meta-governance; and conformance labels.

The following v1.0.2 clauses are refined by this candidate: Section 4.1 Operation identity; Section 4.6 Authorization; Section 4.7 Commit and audit; Sections 5.4–5.6; and CORE-019, CORE-023, and their related operation-level uniqueness/replay semantics. No other v1.0.2 requirement is silently weakened.

## 2. Canonical architecture retained

The canonical layers remain:
1. Supreme Command Core.
2. Strategic Intelligence/Cognition as mandatory decomposition, routing, impact-analysis, hypothesis-competition, and evidence-orchestration layer.
3. Domain Profiles.
4. Project Overlays.
5. Environment Policies.
6. AI, agents, plugins, and tools as untrusted capability providers.
7. Governance Control Plane with canonical registries, policy evaluation, evidence ledger, decisions, and lifecycle coordination.

Single-writer ownership by data class, producer/verifier/oracle/approver separation, immutable accepted records, falsification discipline, and UNKNOWN-preserving decision semantics remain mandatory.

## 3. Canonical identity model

The single canonical type source for the v1.1.0 operation-composition slice is `EGIS_CanonicalTypes_v1_1_0.tla`.

```text
OperationKey = (tenant_id, project_id, operation_id)
Scope = (tenant_id, project_id, change_id, principal_id,
         membership_revision, capability)
OperationEntry = (fingerprint, Scope)
CommitRecord = (OperationKey, fingerprint, Scope, winning_attempt,
                policy_revision, trust_epoch)
```

The OperationKey identifies one logical operation within a tenant/project namespace. Attempt IDs are subordinate to an OperationKey and are not operation identities. CommitRecord is unique per OperationKey in the model.

The full Scope is bound into the immutable registry entry and CommitRecord. Initial registration rejects a tenant or project mismatch, inactive membership, or missing capability grant. A repeated OperationKey with a different fingerprint or scope is a conflict, not a retry.

## 4. Replay and collision contract

| Existing registry state | Incoming key/fingerprint/scope | Result | Registry mutation |
|---|---|---|---|
| No entry | New key + valid scope | ACCEPTED | Create immutable entry |
| Existing entry | Same key + same fingerprint + same scope | REPLAY | None |
| Existing entry | Same key + different fingerprint | CONFLICT | None |
| Existing entry | Same key + different scope | CONFLICT | None |
| No entry | Tenant/project/membership/capability invalid | SCOPE_REJECTED | None |

The fingerprint remains an opaque typed value in the formal model. Canonical serialization, cryptographic digest choice, domain separation, and collision-resistance evidence are unresolved implementation obligations.

## 5. Per-OperationKey lifecycle and recovery

Lifecycle, attempts, intent reservation, durable outcome, CommitRecord, store epoch, lookup result, lookup epoch, and caller observation are all indexed by OperationKey.

Multiple attempts may become PENDING for one key. Exactly one may reserve that key's intent. After reservation, no additional attempt may start for that key. Different keys may progress independently, including while another key is RECOVERY_PENDING.

The abstract commit transition binds the winning attempt, fingerprint, scope, policy revision, and trust epoch into one CommitRecord. A lost acknowledgement leaves caller observation UNKNOWN. Stale replica absence cannot finalize. Reconciliation requires a matching CommitRecord or authoritative absence at the current per-key store epoch.

No blind retry is allowed while a key is RECOVERY_PENDING. Same-key/same-fingerprint replay returns the existing operation state and does not create a second commit. Same-key/different-fingerprint reuse is rejected as CONFLICT.

## 6. Safety invariants

The v1.1.0 finite model adds explicit checks for:
- one immutable registry entry per OperationKey;
- CommitRecord-to-OperationKey/fingerprint/scope/winning-attempt binding;
- CommitRecord policy and trust snapshot binding;
- tenant and project isolation;
- at most one winning attempt per OperationKey;
- one intent reservation per OperationKey;
- stale-replica non-finalization and authoritative-epoch reconciliation;
- independent recovery state across distinct OperationKeys;
- authorization consumption before durable commit;
- no acknowledgement without corresponding durable evidence.

A model-level single CommitRecord slot does not prove global uniqueness across multiple stores, regions, or deployments. Concrete storage must provide and demonstrate an equivalent linearizable uniqueness boundary.

## 7. Verification artifacts

- `verification/formal/egis/EGIS_CanonicalTypes_v1_1_0.tla`
- `verification/formal/egis/EGIS_OperationComposition_v1_1_0.tla`
- `verification/formal/egis/EGIS_OperationComposition_v1_1_0.cfg`
- `verification/formal/egis/tests/test_operation_composition_reference.py`
- `verification/formal/egis/EGIS-FM-004-v1.1.0-hostile-review.md`
- `docs/architecture/egis/EGIS-OPC-001-operation-composition-v1.1.0.md`

The Python reference suite passes 18/18 tests. SANY, TLC, mutation execution, differential evaluation, independent review, and implementation refinement are NOT_RUN or NOT_ESTABLISHED. Formal verification is not claimed.

## 8. Explicit refinement gaps

Before promotion, the project must resolve:
- dynamic capability-grant revocation and authority revision binding;
- approver authority and signed authorization authenticity;
- canonical fingerprint encoding/hash and collision handling;
- authoritative store identity, linearizability, CAS/unique constraints, and crash behavior;
- transactionally coupled audit intent/outbox and external anchoring;
- epoch rollover, cross-region recovery, and store corruption assumptions;
- external side-effect idempotency without claiming unsupported exactly-once semantics;
- TLA+ parser/model-checker execution, mutation traces, differential checks, and independent review.

UNKNOWN remains neither success nor failure. Formal model conformance, implementation conformance, and operational conformance remain separate evidence-backed states.
