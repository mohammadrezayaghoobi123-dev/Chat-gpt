# EGIS-001 v1.0.1 — Integrated Adversarial Review

**Review ID:** EGIS-AR-001  
**Target:** EGIS-001 v1.0.1  
**Review mode:** Design-level hostile review  
**Date:** 2026-11-25  
**Execution status:** Static design review only; SANY, TLC, implementation tests, and mutation execution are NOT_RUN.

## 1. Review verdict

**Verdict: DESIGN BASELINE ACCEPTABLE FOR REVIEW; NOT FORMALLY VERIFIED; NOT IMPLEMENTATION-READY.**

The v1.0.1 design resolves the previously identified schema ambiguity, operation/authority identity conflation, scope mutation gap, exception lifecycle ambiguity, historical-state comparison defect, and retry/recovery ambiguity at the contract level.

It does not prove:
- that the selected storage provider can implement the required atomic commit boundary;
- that the graph digest or completeness attestation is cryptographically and operationally trustworthy;
- that verifier/oracle independence has no hidden common-cause failure;
- that the ledger resists total rewrite without external anchoring;
- that a concrete TLA+ model parses or satisfies the invariants;
- that an implementation conforms.

## 2. Prior finding disposition

| Prior finding | Severity | v1.0.1 disposition | Residual evidence required |
|---|---|---|---|
| ADV-101 Undefined graph/applicability constants | Critical | Resolved in canonical contract: graph registry, edges, closure, and applicability have one owner and explicit data fields | Formal model constants and graph fixtures |
| ADV-102 Incomplete record types | Critical | Resolved at design level: canonical schemas for Snapshot, Authorization, Exception, Commit, and Ledger Event are specified | Schema validation and generated type tests |
| ADV-103 Operation ID conflated with authority ID | Critical | Resolved: operation_id, authorization_id, attempt_id, commit_id, principal_id, and authority revision are distinct | Type-level and persistence uniqueness tests |
| ADV-104 Scope mutation not modeled | Critical | Resolved: exact Scope tuple is bound into snapshot, authorization, and commit; revalidated at commit | Cross-tenant and project-substitution mutation tests |
| ADV-105 Atomic storage boundary assumed | Critical | Contract corrected; implementation proof remains OPEN | Provider-specific serializable transaction/CAS and crash-race evidence |
| ADV-106 Free-floating verifier results | Critical | Corrected: gate acceptance requires scoped, revision-bound, four-layer evidence and independent verification | Evidence fixture model and oracle mutation tests |
| ADV-107 Graph digest not bound to graph | High | Corrected: digest binds canonical graph, revision, source refs, and completeness attestation | Canonicalization vectors, signature validation, incomplete-source attacks |
| ADV-108 Exception lifecycle incomplete | High | Corrected: exceptions precede Prepare and are snapshot-bound; changes invalidate snapshot | Approver, revocation, expiry, and replay tests |
| ADV-109 Ledger chain not rewrite-resistant | High | Explicit residual risk: hash chain alone is insufficient; external anchor/immutable store required | Anchor outage, total-rewrite, key-compromise tests |
| ADV-110 Ambiguous commit recovery incomplete | High | Corrected at contract level with separate truth/observation and authoritative reconciliation | Crash injection at every persistence boundary |
| ADV-111 Current state compared to historical commit | High | Corrected: commit invariants use immutable commit snapshot; later revocation is prospective unless artifact policy says otherwise | Historical-decision regression tests |
| ADV-112 Losing attempts remain pending | High | Corrected: all non-winning attempts reach explicit terminal states after reconciliation | Concurrent-attempt and timeout tests |
| ADV-113 Oracle independence overclaimed | High | Corrected: structural independence only; hidden common causes remain residual | Supply-chain, shared-data, shared-authority, and environment analysis |
| ADV-114 Unbounded event type | Medium | Corrected: EventKinds is a closed versioned enum in the canonical schema | Schema compatibility and unknown-event rejection tests |
| ADV-115 Deployment rollback incomplete | High | Corrected: release, deployment, failure, and rollback are separate records and lifecycles | Deploy-failure and rollback fault-injection tests |

## 3. Adversarial scenarios

Every scenario is a required regression case. “Expected violation” means the deliberately weakened mutant must violate the named invariant; the hardened design must reject or safely contain the trace.

| Attack ID | Preconditions and attack trace | Expected violation in mutant | Invariant | Countermeasure and regression |
|---|---|---|---|---|
| ATK-001 Cross-tenant substitution | Prepare under Tenant A; alter caller scope to Tenant B before commit | Cross-tenant commit | CORE-008, CORE-016 | Bind server-derived Scope into snapshot and authorization; mutate tenant/project/principal independently |
| ATK-002 Stale dependency graph | Prepare on graph G1; replace with G2 before commit | Stale impact analysis | CORE-004, CORE-013 | Compare graph ID, revision, digest, and completeness at commit |
| ATK-003 Digest substitution | Keep graph ID but substitute edge set or digest | Digest/graph mismatch accepted | CORE-004, CORE-010 | Canonical graph digest and signed completeness/source attestation; mutation of each field |
| ATK-004 False N/A | Remove a dependency edge from an incomplete graph and mark gate N/A | Unjustified non-applicability | CORE-004, CORE-018 | Require trusted complete graph and independently recomputed closure |
| ATK-005 UNKNOWN downgrade | Change UNKNOWN to PASS during aggregation or timeout handling | Unknown bypass | CORE-017 | Closed gate lattice and explicit accept predicate; mutate each aggregation branch |
| ATK-006 Evidence scope substitution | Reuse valid evidence from another tenant, project, change, or revision | Cross-scope evidence accepted | CORE-010, CORE-016 | Bind claim, artifact, attestation, and verification to exact scope and revision |
| ATK-007 Signature-only acceptance | Present a valid signature over semantically irrelevant or stale artifact | Invalid claim accepted | CORE-009, CORE-010 | Four-layer evidence validation; mutate semantic and freshness checks separately |
| ATK-008 Shared oracle failure | Primary and oracle share code, source data, authority, or execution domain | False independence | CORE-009 | Compare known failure-domain descriptors and provenance; inject shared dependencies |
| ATK-009 Expired exception | Issue exception then advance time beyond expiry before commit | Expired exception accepted | CORE-013 | Check expiry at commit time and bind exception revision into snapshot |
| ATK-010 Hard-invariant waiver | Attach exception to a hard invariant | Protected invariant bypass | CORE-001, CORE-013 | Hard invariant controls are not in exceptionable set; mutation must fail closed |
| ATK-011 Policy drift | Change policy revision after authorization | Stale authorization accepted | CORE-013, CORE-020 | Revalidate policy revision at commit; test policy change before and after commit |
| ATK-012 Trust revocation race | Revoke principal/key after authorization but before commit | Revoked authority commits | CORE-008, CORE-013 | Trust epoch and revocation revalidation in atomic commit transaction |
| ATK-013 Concurrent winner race | Two attempts observe authorization as unused and race to commit | Two durable commits | CORE-019 | Unique operation constraint plus atomic consume-and-insert; barrier-controlled race test |
| ATK-014 Authorization replay | Reuse consumed authorization with another attempt | Duplicate operation commit | CORE-013, CORE-019 | Single-use authorization and durable operation record; replay same auth and operation |
| ATK-015 Lost acknowledgement | Commit persists but response is dropped; caller retries blindly | Duplicate external action or inconsistent state | CORE-007, CORE-021 | RECOVERY_PENDING; authoritative read before retry; drop ACK after durable write |
| ATK-016 Stale replica absence | Primary contains commit but read replica reports absent | False abort and duplicate retry | CORE-021 | Require authoritative linearizable read or remain UNKNOWN; simulate lagging replica |
| ATK-017 Ledger middle deletion | Delete one event while retaining later events | Broken chain/sequence accepted | CORE-010, CORE-021 | Sequence continuity, previous digest, independent anchor; delete/reorder/replace events |
| ATK-018 Full ledger rewrite | Rewrite the entire local hash chain | False claim of tamper resistance | CORE-010 | External anchor or immutable independent store; test anchor gap and key compromise |
| ATK-019 Post-commit policy mutation | Change current policy after a valid historical commit | Historical commit incorrectly invalidated or rewritten | CORE-020 | Validate commit against captured historical snapshot; prospective policy test |
| ATK-020 Deployment without release | Trigger deployment without accepted CommitRecord | Unauthorized deployment | CORE-022 | Deployment requires immutable commit reference and environment authorization |
| ATK-021 Deployment failure | Deployment partially fails after artifact commit | Release record overwritten as failed | CORE-022 | Preserve release truth; append deployment failure and reconcile actual environment |
| ATK-022 Rollback erases history | Rewrite prior release/deployment state to simulate rollback | Audit history loss | CORE-010, CORE-022 | Rollback is a new deployment operation referencing prior artifact |
| ATK-023 Membership revoked in background | Queue a task while membership active; revoke before execution/commit | Stale background authority | CORE-008, CORE-013 | Revalidate current membership at consequential action boundary |
| ATK-024 Producer self-approval | Producer identity submits verification and approval | False separation of duties | CORE-009, CORE-013 | Distinct producer/verifier/approver authority; identity collision tests |

## 4. Required mutation set

The following mutations must be independently applied. A test suite that only exercises the hardened path is insufficient.

- MUT-001: remove scope equality at commit.
- MUT-002: remove snapshot revision/digest comparison.
- MUT-003: map UNKNOWN to PASS.
- MUT-004: accept N/A when graph completeness is false.
- MUT-005: remove evidence scope/revision binding.
- MUT-006: accept signature without semantic verification.
- MUT-007: ignore trust revocation.
- MUT-008: ignore policy revision drift.
- MUT-009: permit exception on a hard invariant.
- MUT-010: ignore exception expiry.
- MUT-011: remove authorization single-use check.
- MUT-012: remove unique operation commit constraint.
- MUT-013: allow retry before authoritative reconciliation.
- MUT-014: treat replica absence as authoritative absence.
- MUT-015: allow primary and oracle to share a declared failure domain.
- MUT-016: permit audit event deletion/reordering without detection.
- MUT-017: validate historical commit against current rather than captured policy.
- MUT-018: infer deployment from artifact commit.
- MUT-019: allow agent or producer to approve its own output.
- MUT-020: allow background execution without current membership revalidation.

Each mutant must produce a counterexample or failing test. If a mutant survives, the relevant control is not demonstrated.

## 5. Safety and liveness separation

Safety properties include:
- no commit without a valid, unexpired, unconsumed authorization;
- no cross-scope commit;
- no mandatory UNKNOWN bypass;
- no false N/A;
- no hard-invariant exception;
- no stale graph, policy, trust, authority, membership, or exception at commit;
- at most one durable commit per logical operation;
- no blind retry under ambiguous outcome;
- no deployment without a committed release artifact;
- no mutation of historical decision records.

Liveness properties are conditional. Recovery eventually resolves only if the authoritative store becomes available, the reconciliation scheduler is fair, and the relevant records remain readable. No unconditional liveness claim is made.

## 6. Residual risks and release gates

| Residual risk | Current status | Required closure evidence |
|---|---|---|
| Provider transaction semantics | UNKNOWN | Documented provider guarantee plus crash/race integration tests |
| TLA+ syntax and model checking | NOT_RUN | SANY parse and bounded TLC run with archived config/output |
| Implementation refinement | NOT_ESTABLISHED | Traceability from model actions to storage/API implementation |
| Oracle common-cause risk | PARTIAL | Provenance and failure-domain audit; no statistical independence claim |
| External audit anchoring | NOT_IMPLEMENTED | Independent anchor and tamper-recovery test |
| Trusted time | NOT_ESTABLISHED | Trusted timestamp source, drift/rollback tests |
| Key compromise and rotation | NOT_ESTABLISHED | Revocation, rotation, compromised-key, and recovery tests |
| Distributed commit recovery | DESIGN_ONLY | Fault injection across write, outbox, acknowledgement, and reconciliation boundaries |

## 7. Final hostile disposition

The 15 prior findings are addressed or explicitly bounded at the design-contract level. Three areas remain non-negotiable implementation gates: atomic storage semantics, external audit anchoring, and independently verified trust/time infrastructure.

No formal verification, mutation execution, implementation test, deployment, or production conformance is claimed. Unknown results remain UNKNOWN.
