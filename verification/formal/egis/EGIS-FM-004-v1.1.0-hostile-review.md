# EGIS-FM-004 — Operation Composition v1.1.0 Hostile Review

**Target:** `EGIS_CanonicalTypes_v1_1_0.tla`, `EGIS_OperationComposition_v1_1_0.tla`, configuration, and executable reference tests  
**Baseline:** EGIS-001 v1.0.2; Atomic Recovery v1.0.4; findings FMH-016..FMH-028  
**Review type:** Static adversarial review plus executable reference tests  
**Status:** DRAFT CANDIDATE — NOT_FORMALLY_VERIFIED  
**Date:** 2026-11-25

## 1. Disposition

The v1.1.0 candidate introduces a single canonical type module and a multi-key composition model. It addresses the prior single-operation scope limitation at the specification level by indexing operation lifecycle and recovery state by `OperationKey`.

The reference test suite passes 18/18 tests. This is evidence about the Python reference oracle only. SANY, TLC, mutation execution, and implementation refinement remain NOT_RUN / NOT_ESTABLISHED.

## 2. Findings

| ID | Severity | Finding | Disposition / required action |
|---|---|---|---|
| FMH-029 | Critical | A one-key state model cannot establish isolation or uniqueness across concurrent logical operations | Addressed at model level: all mutable lifecycle, attempt, intent, commit, epoch, lookup, and observation state is indexed by OperationKey; still requires TLC |
| FMH-030 | High | OperationKey reuse semantics were not explicit for identical versus conflicting fingerprints | Addressed: exact key/fingerprint/scope replay returns REPLAY; changed fingerprint or scope returns CONFLICT without registry mutation |
| FMH-031 | High | Tenant-only scope omitted project, change, principal, membership revision, and capability | Partially addressed: canonical Scope includes these fields; active membership and capability grant are checked at registration; dynamic capability revocation remains open |
| FMH-032 | Critical | A single recovery state could incorrectly serialize unrelated operations | Addressed at abstraction level: recovery and lookup state are per OperationKey; executable test confirms one key can progress while another is RECOVERY_PENDING |
| FMH-033 | Critical | Concurrent attempts could produce multiple winners without a per-key reservation guard | Addressed at abstraction level: one intent reservation per key, one reserved attempt, one winner invariant; exact atomic storage semantics remain unproved |
| FMH-034 | High | Lost acknowledgement plus stale replica absence could incorrectly finalize an operation | Addressed: stale absence cannot reconcile; authoritative lookup must match the current per-key epoch |
| FMH-035 | High | Scope substitution could cross tenant or project boundaries | Addressed in the finite model and reference tests; no claim about production enforcement |
| FMH-036 | High | CommitRecord must remain bound to the original registry entry, policy, trust epoch, and winning attempt | Addressed by `CommitRecordMatchesEntry` and `WinnerMatchesCommitRecord`; TLC execution remains pending |
| FMH-037 | High | The model's commit action is an abstract atomic transition, not a concrete storage transaction | Open: select a store and prove/test linearizable uniqueness, authorization consumption, durable record, and coupled audit intent under concurrency/crash injection |
| FMH-038 | High | Capability grants are static finite inputs; dynamic grant revocation is not modeled | Open: add mutable grant revision/revocation state and revalidate it at commit before any promotion |
| FMH-039 | High | Approver authority, separation of duties, and signed authorization authenticity are not represented | Open: extend canonical authorization and authority records; producer/verifier/approver must remain distinct |
| FMH-040 | High | Fingerprint is an opaque model value; canonical encoding and cryptographic collision behavior are not specified | Open: define canonical serialization, digest algorithm/version, domain separation, and collision/reuse handling |
| FMH-041 | Medium | Store epochs are bounded and do not model rollover or authority changes | Open: refine monotonic epoch semantics and storage identity |
| FMH-042 | Medium | Liveness/fairness is intentionally omitted; UNKNOWN may persist indefinitely | Accepted limitation: do not claim recovery liveness without explicit availability/fairness assumptions |
| FMH-043 | High | Python reference tests are not a proof that the TLA+ module and Python oracle are behaviorally equivalent | Open: run SANY/TLC, add differential trace comparison, and review abstraction mapping independently |
| FMH-044 | Critical | Exact TLA+ parser and model-checker acceptance have not been demonstrated | Blocking: SANY=NOT_RUN, TLC=NOT_RUN; do not promote or merge |
| FMH-045 | High | Mutation tests and an independent reviewer have not been executed/assigned | Blocking: mutation execution=NOT_RUN; independent reviewer=NOT_ASSIGNED |

## 3. Executable reference-test evidence

Command:

```bash
python -m unittest -v verification/formal/egis/tests/test_operation_composition_reference.py
```

Observed result:

- 18 tests executed.
- 18 passed.
- 0 failed.
- Runtime: 0.001 seconds.

The suite includes replay, fingerprint conflict, scope mismatch, independent keys, tenant/project isolation, membership/capability checks, one-winner reservation, lost-ack recovery, stale-replica rejection, per-key recovery independence, shared membership revocation, and policy/trust/membership/evidence/graph invalidation.

This test result does not validate TLA+ syntax, state-space completeness, distributed storage, or implementation behavior.

## 4. Required hostile traces and mutations

Required traces before promotion:
1. Two attempts become pending for one key; only one reserves intent; only that attempt can win.
2. Same key and same fingerprint/scope returns REPLAY without creating another registry entry or commit.
3. Same key with a different fingerprint returns CONFLICT and preserves the original entry.
4. Same key and fingerprint with a different scope returns CONFLICT and preserves the original entry.
5. Tenant mismatch and project mismatch are rejected before initial registration.
6. A membership or capability mismatch is rejected.
7. Two distinct keys progress independently, including while one is RECOVERY_PENDING.
8. Commit succeeds with lost acknowledgement; stale replica absence cannot finalize; current-epoch authoritative lookup reconciles COMMITTED.
9. Abort with lost acknowledgement reconciles only after current-epoch authoritative absence.
10. Policy, trust, membership, evidence, or graph invalidation blocks a commit that has not yet become durable.
11. A second commit attempt for a key cannot replace its immutable CommitRecord or produce a second winner.
12. An unresolved UNKNOWN state cannot start a new attempt for that same key.

Required one-at-a-time mutations:
- Remove OperationKey from registry/CommitRecord binding.
- Replace per-key state with shared global intent or lookup state.
- Permit same key/different fingerprint to overwrite the original entry.
- Permit same key/different scope to replay.
- Remove tenant equality or project equality.
- Remove active membership or capability grant checks.
- Permit two intent reservations for one key.
- Permit a second winner for one key.
- Permit commit without current policy/trust/membership/evidence/graph checks.
- Permit stale replica absence to reconcile.
- Remove lookup-epoch equality.
- Remove CommitRecord-to-key/fingerprint/scope/attempt binding.
- Permit a new attempt during RECOVERY_PENDING.

Mutation execution status: NOT_RUN. No mutant is reported as killed.

## 5. Verification matrix

| Gate | Status | Evidence |
|---|---|---|
| Canonical type source | STATIC_REVIEWED | One shared type module imported by composition model |
| Python reference tests | PASS | 18/18 |
| TLA+ lexical/manual inspection | PARTIAL | Static inspection only; no parser acceptance |
| SANY | NOT_RUN | No verified `tla2tools.jar` available in this execution environment |
| TLC | NOT_RUN | No verified `tla2tools.jar` available in this execution environment |
| Mutation execution | NOT_RUN | No mutant outcomes recorded |
| Differential evaluator | NOT_RUN | No TLA/Python trace equivalence established |
| Independent reviewer | NOT_ASSIGNED | No second reviewer evidence |
| Storage refinement | NOT_ESTABLISHED | No concrete store protocol or fault injection |
| Production conformance | NOT_ESTABLISHED | No runtime changes or operational tests |

## 6. Promotion gate

Do not merge or promote until:
1. the exact committed modules pass SANY;
2. the exact finite configuration completes TLC with all safety invariants intact;
3. required traces are observed or formally explained as unreachable;
4. each required mutant is killed by a counterexample;
5. Python and TLA traces are differentially compared;
6. dynamic capability revocation and approver authority are modeled;
7. a concrete store contract is selected and fault-injected for per-key uniqueness, recovery, and audit coupling;
8. an independent reviewer signs off on the abstraction and refinement.

No runtime code, production state, default branch, secrets, bindings, permissions, deployment, or laptop environment is changed by this candidate.
