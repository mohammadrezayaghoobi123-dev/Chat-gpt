# EGIS-FM-002 — Atomic Operation Model v1.0.3 Hostile Review

**Target:** EGIS_AtomicOperation_v1_0_3.tla and EGIS_AtomicOperation_v1_0_3.cfg  
**Review mode:** Static hostile review only  
**Status:** Candidate; NOT_FORMALLY_VERIFIED  
**Date:** 2026-11-25

## 1. Verdict

NOT READY FOR FORMAL CONFORMANCE. This is a bounded AtomicOperation candidate, not a verified TLA+ model. SANY, TLC, and mutation execution were NOT_RUN.

## 2. Integrated coverage

The candidate has one finite operation context, two or more tenant values, multiple attempts, caller-requested versus server-resolved tenant, captured policy and trust epochs, dependency completeness, evidence revocation, single-use authorization, an abstract atomic commit, separate durable truth and observation, ambiguous outcome, reconciliation, and an ordered commit sequence.

It intentionally does not claim full EGIS coverage or multi-operation composition.

## 3. Hostile findings

| ID | Severity | Finding | Required repair |
|---|---|---|---|
| FMH-001 | Critical | NoCommitWithoutBindings compares mutable current state with snapshot during recovery; it does not validate an immutable CommitRecord | Add immutable CommitRecord and separate historical validity from future revocation |
| FMH-002 | Critical | MakeStoreTruthUnknown has no durable intent/reservation state and abstracts away whether the write occurred | Add operation intent and possible-commit state before ambiguous acknowledgement |
| FMH-003 | High | ResolveStoreCommitted can assert COMMITTED without a record/fingerprint lookup | Model authoritative record and binding verification |
| FMH-004 | High | ResolveStoreAbsent trusts an abstract label without consistency epoch/read proof | Model authoritative read token and stale-replica exclusion |
| FMH-005 | High | Recovery blocks NEW attempts but does not fully finalize all PENDING attempts on committed reconciliation | Add explicit finalization for winner/losers after authoritative reconciliation |
| FMH-006 | High | NoDuplicateLedgerCommit is a global one-entry bound, not uniqueness per OperationKey | Add operation-keyed CommitRecord map in composition model |
| FMH-007 | High | Ledger lacks actor, scope, sequence number, previous digest, anchor, and outbox delivery state | Extend canonical audit event and outbox model |
| FMH-008 | High | Evaluate requires PASS but no transition computes PASS from evidence or an independent oracle | Add evidence evaluator and separately sourced oracle outcome |
| FMH-009 | High | Authorization has no approver principal, authority revision, or exception binding | Add role-separated approver and exception record |
| FMH-010 | High | Snapshot absence uses numeric sentinel 0 | Replace with typed presence flag or option representation |
| FMH-011 | High | Snapshot does not bind graph/evidence revisions and provenance | Add immutable graph and evidence snapshot identities |
| FMH-012 | High | Scope only models tenant; project, principal, capability, and membership revision are absent | Extend scope tuple and membership registry |
| FMH-013 | Medium | Time can advance after terminal states | Restrict or explicitly define global time semantics |
| FMH-014 | Medium | No conditional fairness or checked liveness property | Add fairness only after safety model stabilizes |
| FMH-015 | Medium | Recovery invariants confuse historical commit validity with current policy/trust/evidence state | Use immutable commit basis and explicit revocation semantics |

## 4. Mutation plan

Mutate one guard at a time and require a counterexample:
- requested/resolved/snapshot scope equality;
- snapshot/current policy equality;
- snapshot/current trust epoch equality;
- graph completeness;
- evidence revocation;
- authorization single-use;
- winner uniqueness;
- recovery attempt prohibition;
- UNKNOWN truth handling;
- authoritative absence requirement;
- acknowledgement/truth consistency.

No mutation has been executed. No mutant is claimed killed.

## 5. Acceptance conditions

1. Repair FMH-001 through FMH-015.
2. Add evidence-derived gate evaluation and independent oracle.
3. Add immutable CommitRecord and operation-keyed uniqueness.
4. Model intent/reservation before ambiguous commit observation.
5. Require authoritative read proof for recovery.
6. Add finite OperationComposition with at least two operations across two tenants.
7. Run SANY and TLC on exact committed module/config.
8. Execute mutations and preserve counterexamples.
9. Obtain independent review of assumptions and abstraction boundaries.

Current: SANY NOT_RUN; TLC NOT_RUN; mutation execution NOT_RUN; implementation refinement NOT_ESTABLISHED.
