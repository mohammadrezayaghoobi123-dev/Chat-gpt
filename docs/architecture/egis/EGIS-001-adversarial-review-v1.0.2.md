# EGIS-001 v1.0.2 — Integrated Adversarial Review

**Review ID:** EGIS-AR-002  
**Target:** EGIS-001 v1.0.2  
**Mode:** Static hostile design review  
**Date:** 2026-11-25  
**Execution:** SANY, TLC, mutation execution, integration tests, and provider fault injection NOT_RUN.

## 1. Review verdict

**DESIGN COHERENCE: CONDITIONALLY ACCEPTABLE. FORMAL VERIFICATION: NOT_ESTABLISHED. IMPLEMENTATION READINESS: NOT_ESTABLISHED.**

The v1.0.2 standard consolidates scope, operation identity, evidence, dependency completeness, exception lifecycle, authorization, commit truth, recovery, audit, deployment, and conformance under one canonical contract.

This review is not independent organizational approval. It is a hostile design review against the declared threat model. No production system or repository runtime is declared conformant.

## 2. Disposition of prior findings

| Finding | v1.0.2 treatment | Residual |
|---|---|---|
| ADV-101 Undefined graph/applicability inputs | Single Dependency Registry and explicit graph record | Formal fixture and schema validation required |
| ADV-102 Incomplete record types | Canonical record inventory and field bindings | Machine-readable schema not yet generated |
| ADV-103 Operation/authority ID conflation | Distinct ID namespaces and types | Type-checking required |
| ADV-104 Scope mutation | Requested, Resolved, Authorized Scope separated | Identity provider refinement required |
| ADV-105 Atomicity assumed | Storage-enforced unique key and atomic transaction/CAS contract | Provider proof and crash/race tests |
| ADV-106 Free-floating verifier results | Evidence-bound primary/oracle evaluation | Executable evidence model required |
| ADV-107 Graph digest disconnected | Canonical digest binds graph identity/revision/edges/sources | Canonicalization and signature tests |
| ADV-108 Exception lifecycle | Pre-Prepare, scope-bound, versioned, expiring exceptions | Revocation and approver tests |
| ADV-109 Ledger total rewrite | External anchor/immutable store required | Not implemented |
| ADV-110 Ambiguous recovery | CommitTruth and CommitObservation separated | Storage consistency model and fault injection |
| ADV-111 Historical/current state confusion | Historical snapshot is immutable basis | Artifact revocation semantics need profile policy |
| ADV-112 Pending losing attempts | Explicit terminal attempt states | Race and reconciliation tests |
| ADV-113 Oracle independence overclaim | Only known structural independence claimed | Hidden common causes remain residual |
| ADV-114 Unbounded event type | Versioned closed EventKind contract | Schema evolution tests |
| ADV-115 Deployment rollback | Separate deployment/rollback records | Runtime orchestration tests |
| ADV-116 Caller scope authority | Server-derived ResolvedScope required | Identity adapter tests |
| ADV-117 Commit truth ambiguity | Truth and observation are distinct | Concrete store semantics unresolved |
| ADV-118 Multi-tenant operation collision | OperationKey includes tenant/project namespace | Composition model required |
| ADV-119 Attempt lifecycle gaps | Winner/loser/cancel states defined | Model checking required |
| ADV-120 Evidence revocation race | Revalidate revocation at commit boundary | Atomic revocation/commit ordering test |
| ADV-121 Storage assumptions | Explicit provider capability gate | Provider-specific evidence absent |
| ADV-122 Rollback lifecycle | New deployment operation; history immutable | Failure-injection tests absent |

## 3. Adversarial attack matrix

For each case, attack the weakened mutant first. The mutant must produce the expected invariant violation; the hardened model must block the trace or preserve UNKNOWN safely.

| ID | Preconditions and trace | Expected mutant violation | Invariant | Required countermeasure/test |
|---|---|---|---|---|
| ATK-001 | Replace tenant after prepare | Cross-tenant commit | CORE-008/016 | Mutate resolved scope before commit |
| ATK-002 | Replace project while retaining principal | Cross-project action | CORE-008/016 | Project permission and scope binding test |
| ATK-003 | Revoke membership after queueing work | Stale background authority | CORE-024 | Revalidate at execution and commit |
| ATK-004 | Change graph edges but retain digest | Graph substitution | CORE-004/010 | Canonical digest differential test |
| ATK-005 | Mark incomplete graph as complete | False N/A | CORE-004/018 | Missing-source and false-attestation test |
| ATK-006 | Mark mandatory UNKNOWN as PASS | Unknown bypass | CORE-017 | Mutate each gate aggregation path |
| ATK-007 | Reuse evidence from another scope | Evidence scope substitution | CORE-010/016 | Cross-tenant/project/revision replay |
| ATK-008 | Valid signature over irrelevant artifact | Semantic evidence bypass | CORE-009/010 | Signature-only mutant |
| ATK-009 | Share source data between primary and oracle | False independence | CORE-009 | Common-source provenance injection |
| ATK-010 | Revoke evidence after authorization | Revoked evidence commit | CORE-010/013 | Race revocation against commit linearization |
| ATK-011 | Apply exception to hard invariant | Hard invariant waiver | CORE-001/013 | Hard-gate exception mutant |
| ATK-012 | Expire exception before commit | Expired exception accepted | CORE-013 | Advance bounded time before commit |
| ATK-013 | Change policy after authorization | Stale policy commit | CORE-013/020 | Policy revision interleaving |
| ATK-014 | Revoke trust after authorization | Revoked identity commits | CORE-008/013 | Trust epoch/revocation race |
| ATK-015 | Two attempts race on unused authorization | Two winners | CORE-019 | Barrier-controlled uniqueness test |
| ATK-016 | Replay consumed authorization | Duplicate commit | CORE-013/019 | Authorization single-use mutant |
| ATK-017 | Reuse OperationKey with different fingerprint | Wrong action treated as retry | CORE-023 | Fingerprint conflict test |
| ATK-018 | Lose ACK after durable commit | Blind retry/duplicate effect | CORE-007/021 | Crash after write, before response |
| ATK-019 | Query stale replica for absence | False abort | CORE-021 | Replica lag test; require authoritative read |
| ATK-020 | Fail transaction between auth consume and record insert | Partial commit | CORE-019/021 | Crash injection at every atomic write boundary |
| ATK-021 | Commit record persists but outbox intent does not | Audit gap | CORE-010/021 | Transactional outbox atomicity test |
| ATK-022 | Delete middle ledger event | Undetected audit gap | CORE-010 | Sequence and previous-digest mutation |
| ATK-023 | Rewrite entire local hash chain | False tamper-resistance claim | CORE-010 | External anchor and key-separation test |
| ATK-024 | Change current policy after historical commit | Historical record rewritten | CORE-020 | Validate against captured policy snapshot |
| ATK-025 | Deploy without committed artifact | Unauthorized deployment | CORE-022 | Deployment precondition mutant |
| ATK-026 | Deployment partially fails | Release marked failed/erased | CORE-022 | Preserve release and append deployment failure |
| ATK-027 | Rollback rewrites prior deployment record | History destruction | CORE-010/022 | Rollback as new operation |
| ATK-028 | Producer submits own approval | False separation of duties | CORE-009/013 | Identity-role collision test |
| ATK-029 | Unknown commit truth treated as absent | Unsafe retry | CORE-021 | Store unavailable and ambiguous read test |
| ATK-030 | Oracle and verifier share authority | False independence | CORE-009 | Authority-domain collision test |
| ATK-031 | Attempt remains pending after commit reconciliation | Orphan attempt | CORE-007/019 | Finalize every loser after durable outcome |
| ATK-032 | Operation ID collision across tenants | Cross-tenant operation collision | CORE-016/019/023 | Namespace collision composition test |

## 4. Required mutation matrix

- MUT-001 remove resolved-scope equality.
- MUT-002 trust caller-supplied tenant/project.
- MUT-003 skip membership revalidation.
- MUT-004 remove graph revision/digest binding.
- MUT-005 accept incomplete graph as complete.
- MUT-006 map UNKNOWN to PASS.
- MUT-007 allow N/A without closure.
- MUT-008 remove evidence scope/revision binding.
- MUT-009 accept signature without semantic validity.
- MUT-010 share verifier/oracle authority or source.
- MUT-011 ignore evidence revocation.
- MUT-012 allow exception on hard invariant.
- MUT-013 ignore exception expiry/revocation.
- MUT-014 skip policy revision revalidation.
- MUT-015 skip trust/authority revalidation.
- MUT-016 remove authorization single-use enforcement.
- MUT-017 remove OperationKey uniqueness.
- MUT-018 ignore operation fingerprint mismatch.
- MUT-019 allow retry before authoritative reconciliation.
- MUT-020 treat stale replica absence as authoritative.
- MUT-021 split authorization consumption and CommitRecord insertion across non-atomic writes.
- MUT-022 commit without transactionally coupled audit intent.
- MUT-023 permit ledger event deletion/reordering.
- MUT-024 remove external ledger anchoring while claiming tamper resistance.
- MUT-025 validate historical commit against current mutable policy.
- MUT-026 infer deployment from artifact commit.
- MUT-027 overwrite release history during rollback.
- MUT-028 permit producer self-approval.

Each mutant requires a counterexample or failing test. A surviving mutant means the relevant control is not demonstrated.

## 5. Newly discovered residual risks

| ID | Severity | Residual risk | Required closure |
|---|---|---|---|
| RISK-001 | Critical | Atomic ordering of evidence revocation and commit may be ambiguous if services use separate stores | Define a linearizable revocation epoch or bounded lease semantics; test races |
| RISK-002 | Critical | A transactional outbox does not guarantee external exactly-once delivery | Idempotent consumers, deduplication keys, replay-safe handlers, reconciliation |
| RISK-003 | High | Operation fingerprint canonicalization can diverge across services | Versioned canonical encoding and cross-language golden vectors |
| RISK-004 | High | Snapshot size and dependency closure may exceed bounded cost/time | Explicit size/depth limits, fail-closed truncation, measured budgets |
| RISK-005 | High | Clock rollback or inconsistent clocks may affect expiry | Trusted time source or bounded lease protocol; clock rollback tests |
| RISK-006 | High | External anchor outage can create an unanchored ledger window | Explicit max unanchored interval and policy response |
| RISK-007 | High | Identity/tenant registry outage may tempt stale-cache authorization | Cache lease bounds and fail-closed policy for high-risk actions |
| RISK-008 | Medium | Schema evolution can make old events unreadable | Versioned event envelope and compatibility fixtures |

## 6. Safety and liveness

Safety properties are unconditional within the declared model assumptions. Liveness is conditional on store availability, fair scheduling, and record retention. Do not assert unconditional eventual recovery.

The formal model must distinguish:
- CommitTruth from CommitObservation;
- operation identity from attempt identity;
- requested scope from server-resolved scope;
- historical decision basis from current revocation state;
- release commit from deployment;
- known structural independence from statistical independence.

## 7. Final hostile disposition

v1.0.2 is internally more coherent than v1.0.1 and explicitly closes the new design-level gaps. It remains a design baseline only.

No SANY parse, TLC exploration, mutation execution, provider-specific transaction test, external anchor test, or implementation conformance test has been run. All such results remain NOT_RUN or NOT_ESTABLISHED. No production authorization is implied.
