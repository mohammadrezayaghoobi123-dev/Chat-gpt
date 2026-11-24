# EGIS-FM-003 — Atomic Recovery Model v1.0.4 Hostile Review

**Target:** EGIS_AtomicRecovery_v1_0_4.tla and EGIS_AtomicRecovery_v1_0_4.cfg  
**Baseline:** EGIS-FM-001 v1.0.2; findings FMH-001..FMH-015 from v1.0.3  
**Review type:** Static adversarial review; independent execution NOT_AVAILABLE  
**Status:** DRAFT CANDIDATE — NOT_FORMALLY_VERIFIED  
**Date:** 2026-11-25

## 1. Disposition

The v1.0.4 candidate addresses the direct v1.0.3 recovery defects by introducing:
- a typed immutable CommitRecord value;
- an explicit intent reservation and reserved attempt;
- distinct durable outcome and caller observation;
- authoritative lookup with store epoch;
- a stale-replica lookup state that cannot finalize;
- reconciliation predicates bound to the immutable record;
- evidence-derived gate evaluation from graph, evidence, and oracle inputs;
- explicit no-commit/no-authorization and record/intent consistency invariants.

This is a bounded single-operation recovery slice. It is not a complete implementation of the EGIS canonical model and does not include OperationComposition.

## 2. Static hostile findings and residual blockers

| ID | Severity | Finding | Required next action |
|---|---|---|---|
| FMH-016 | Critical | CommitAndLoseAck and AbortAndLoseAck are abstract store outcomes, but no concrete transactional write protocol is modeled | Treat as abstract outcomes only; later refine against transactional DB/CAS contract |
| FMH-017 | High | AuthoritativeLookup is an abstract oracle over commitRecord and intentState; it does not model storage quorum, linearizability, read-token authenticity, or store identity | Add authority proof/token and store identity in refinement model |
| FMH-018 | High | Single-operation model has no OperationKey namespace or fingerprint collision/reuse map | Implement separate OperationComposition model before cross-operation uniqueness claims |
| FMH-019 | High | Scope remains tenant-only; project, principal, membership revision, capability, and approver authority are omitted | Extend scope/authority model using canonical EGIS record fields |
| FMH-020 | High | Exception records and hard-invariant non-waivability are not modeled | Add exception lifecycle and hard-invariant guard |
| FMH-021 | High | Graph completeness is a Boolean abstraction; graph provenance and independent closure attestation are not represented | Add graph ID/revision/digest/source and closure attestation |
| FMH-022 | High | Evidence is a Boolean; artifact authenticity, provenance, verifier authority, and revocation ordering are not represented | Add typed evidence/verification records and revocation sequence |
| FMH-023 | Medium | Store epoch and lookup epoch are small bounded integers; rollover and epoch authority are abstracted | Document finite bound and add monotonic epoch proof in refinement model |
| FMH-024 | Medium | Liveness is intentionally omitted; permanent UNKNOWN remains possible | Add conditional fairness only after safety invariants pass TLC |
| FMH-025 | Medium | Snapshot fields are arbitrary typed values before snapshotPresent becomes TRUE | Ensure all consumers require snapshotPresent; consider option types in later cleanup |
| FMH-026 | Medium | ChangePolicy and RevokeTrust rely on finite-set difference semantics | Confirm with SANY/TLC using the exact committed config; no execution claimed |
| FMH-027 | Medium | One OperationKey is modeled implicitly; multiple attempts do not prove uniqueness across operations | Keep global uniqueness claims out of this slice |
| FMH-028 | High | The finite configuration uses model values; parser and TLC acceptance are not yet demonstrated | Run SANY and TLC against exact committed files before any promotion |

## 3. Required attack traces

1. Two attempts start; exactly one reserves intent; the other cannot reserve.
2. Commit succeeds but acknowledgement is lost; stale replica says absent; no abort is finalized; authoritative lookup finds the record; reconciliation commits.
3. Abort occurs with acknowledgement lost; authoritative lookup confirms absence; reconciliation aborts.
4. Policy changes after snapshot and before commit; commit action is disabled.
5. Trust epoch changes after snapshot; commit action is disabled.
6. Evidence is revoked after evaluation/authorization; commit action is disabled.
7. Dependency graph becomes incomplete; evaluation cannot produce PASS.
8. Requested tenant changes after snapshot; commit action is disabled.
9. UNKNOWN lookup remains unresolved; no new attempt can start because phase is RECOVERY_PENDING.
10. CommitRecord mutation violates record/snapshot and record/intent invariants.

## 4. Mutation matrix

Required one-at-a-time mutations:
- Remove requested/resolved/snapshot tenant equality.
- Remove policy revision binding.
- Remove trust epoch binding.
- Remove graph completeness guard.
- Remove evidence validity guard.
- Remove oracle PASS guard.
- Remove intent reservation exclusivity.
- Permit commit without authorization.
- Permit authoritative absence with a record present.
- Permit stale-replica absence to reconcile.
- Remove CommitRecord-to-snapshot binding.
- Remove CommitRecord-to-reserved-attempt binding.
- Permit second winner.
- Permit a new attempt while phase is RECOVERY_PENDING.

Mutation execution status: NOT_RUN. No mutant is reported as killed.

## 5. Verification status

- Git branch and exact file retrieval checks: PASS only for repository integrity, not model correctness.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Mutation execution: NOT_RUN.
- Differential evaluator: NOT_RUN.
- Independent reviewer: NOT_ASSIGNED.
- Implementation refinement: NOT_ESTABLISHED.

## 6. Exit gate

Do not promote or merge this candidate until:
1. exact committed module passes SANY;
2. exact committed config completes TLC exploration with Safety intact;
3. all required attack traces are either observed or explained as unreachable;
4. each mutant is killed by a counterexample;
5. a second independent oracle checks commit/recovery outcomes;
6. OperationComposition proves per-OperationKey uniqueness;
7. abstraction and refinement gaps are documented and independently reviewed.

No production, runtime, secrets, bindings, deployment, or default-branch changes are included.
