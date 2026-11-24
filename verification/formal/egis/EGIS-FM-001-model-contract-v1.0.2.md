# EGIS-FM-001 — Canonical Formal Model Contract

**Version:** 1.0.2  
**Target:** EGIS-001 v1.0.2  
**Status:** Formalization contract; executable TLA+ module NOT_REGISTERED; SANY/TLC NOT_RUN  
**Date:** 2026-11-25

## 1. Single source of truth

This contract formalizes EGIS-001. It does not redefine Scope, Snapshot, Authorization, OperationKey, Gate, Evidence, CommitRecord, or LedgerEvent. Those records have exactly one canonical definition in EGIS-001 v1.0.2.

The model is an abstraction for safety and bounded liveness analysis. It cannot establish provider transaction guarantees, cryptographic security, production identity correctness, or implementation refinement by itself.

## 2. Model decomposition

Use two compositional models that import one canonical type module:

- **AtomicOperation:** one OperationKey, multiple attempts, two or more scopes/principals, interleaved graph/policy/trust/membership/evidence changes, commit ambiguity, and recovery.
- **OperationComposition:** multiple concurrent OperationKeys across tenants/projects, collision/replay tests, shared resources, and registry-level uniqueness.

The type module owns all record definitions and state domains. Child modules may add variables and transitions but MUST NOT redefine canonical record fields or meanings.

## 3. Canonical state

`S = (ScopeRegistry, ChangeRegistry, RequirementRegistry, DependencyRegistry, EvidenceRegistry, TrustRegistry, PolicyRegistry, ExceptionRegistry, Snapshot, Authorization, Attempts, CommitTruth, CommitObservation, CommitRecord, Release, Deployment, Ledger, Time)`

Each registry is versioned and has one authoritative writer. Model state includes both the current registry state and immutable captured Snapshot/Commit records. Historical records are never recomputed from mutable current values.

## 4. Finite model domains

Initial bounded instance:
- 2 tenants, 2 projects, 2 principals;
- 2 membership states and 2 authority revisions;
- 2 affected components plus one transitive dependency;
- 2 graph revisions: one complete, one incomplete;
- 2 mandatory gates, one hard invariant;
- 2 policy revisions and 2 trust epochs;
- 2 evidence claims, one revoked between authorization and commit;
- 2 attempts for one operation;
- 2 distinct OperationKeys for composition and one deliberate cross-tenant collision candidate;
- bounded time values covering authorization and exception expiry;
- finite event kinds and bounded ledger length.

Every set, sequence, revision, time, and attempt count must be finite. Use explicit TLC model values and finite constraints; no unbounded counters or unconstrained strings.

## 5. Required transitions

1. ResolveScope from trusted identity and membership registries; caller-supplied scope is not authoritative.
2. PrepareSnapshot, binding exact registry revisions and canonical digests.
3. Evaluate, freezing gate and evidence results for the exact snapshot.
4. Authorize, binding operation key/fingerprint, scope, snapshot, trust, policy, authority, membership, exception revisions, and expiry.
5. StartAttempt, creating a distinct attempt under the same logical authorization.
6. CommitAttempt, modeled as one abstract atomic action that validates all bindings, consumes authorization, reserves OperationKey, creates CommitRecord, and appends audit intent.
7. MutateGraph, ChangePolicy, RevokeTrust, RevokeEvidence, RevokeMembership, ChangeAuthority, AdvanceTrustedTime, and MutateException, all permitted to interleave before commit.
8. LoseAcknowledgement, changing observation but not durable truth.
9. Reconcile from authoritative storage evidence; stale replica reads cannot establish absence.
10. FinalizeAttempts, setting one winner and terminal loser states after authoritative reconciliation.
11. Deploy, DeploymentFailure, and Rollback as independent transitions with immutable history.
12. Append/AnchorAudit, modeling local append and independent anchor state separately.

The abstract CommitAttempt action does not prove the implementation transaction is atomic. A separate refinement obligation maps it to a concrete transaction/CAS and outbox design.

## 6. Required invariants

### Type and identity
- TypeOK covers every variable and every nested record field.
- OperationKey is tenant/project namespaced.
- OperationKey reuse with a different fingerprint is rejected.
- operation_id, attempt_id, authorization_id, commit_id, principal_id, and authority_id are distinct types.

### Scope and authority
- RequestedScope is never accepted as ResolvedScope without trusted resolution.
- Commit Scope equals Authorization Scope equals Snapshot Scope.
- Membership, capability, principal status, and authority revision are valid at commit linearization.
- Cross-tenant and cross-project commit is impossible.

### Evidence and graph
- Evidence claim/artifact/attestation/verification bind exact scope and revision.
- Revoked or stale evidence cannot satisfy a mandatory gate.
- N/A requires trusted complete graph and independently validated closure.
- Graph digest matches canonical graph ID, revision, edges, and source references.
- Primary/oracle known failure-domain, authority, and evidence-path independence is checked; statistical independence is not asserted.

### Authorization and commit
- Mandatory UNKNOWN/DISPUTED/FAIL/EXPIRED/REVOKED/SUPERSEDED cannot be accepted.
- Hard invariant exceptions are impossible.
- Authorization is single-use.
- At most one durable CommitRecord exists per OperationKey.
- CommitRecord binds exact authorization, snapshot, fingerprint, scope, and validated revisions.
- No stale policy, trust, authority, membership, exception, or evidence-revocation state at the commit linearization point.

### Recovery and audit
- CommitTruth and CommitObservation are separate.
- UNKNOWN never becomes COMMITTED or AUTHORITATIVELY_ABSENT without authoritative evidence.
- RECOVERY_PENDING forbids new attempts.
- Stale/lagging replica absence is not authoritative absence.
- Audit intent is transactionally coupled to CommitRecord.
- Ledger sequence and previous-event digest continuity are checked.
- External anchoring is a separate state; a local hash chain alone is not tamper-proof.

### Release and deployment
- Deployment requires a valid committed artifact and deployment authorization.
- Deployment failure does not rewrite Release.
- Rollback appends a new deployment operation and preserves history.

## 7. Temporal properties

Safety examples:
- `[] (CommitRecordExists => CommitBindingsValid)`
- `[] (RecoveryPending => NoNewAttempt)`
- `[] (CommitCount(OperationKey) <= 1)`
- `[] (DeploymentExists => ReferencedCommitExists)`

Conditional liveness:
- `[] (RecoveryPending => <> (Committed / Aborted))`

This liveness property is admissible only under explicit assumptions: authoritative storage eventually becomes available, reconciliation is scheduled fairly, required records remain retained/readable, and no permanent trust/policy block prevents resolution. Without these assumptions, the model must permit permanent UNKNOWN.

## 8. Mutation and differential strategy

Use MUT-001 through MUT-028 in EGIS-AR-002. For every mutant:
1. Apply exactly one guard removal or semantic weakening.
2. Run the same finite configuration.
3. Record the first counterexample or surviving mutant.
4. Link the counterexample to the invariant and attack ID.
5. Restore the guard and rerun.
6. Preserve tool version, module/config digests, state count, trace, and result.

The reference evaluator and expected-outcome oracle must be independently authored from the model. Shared source, fixtures, assumptions, and infrastructure are declared common-cause risks.

## 9. Tool and evidence protocol

Once executable modules exist, record:
- TLA+ tools version and JAR digest;
- SANY command and full output;
- TLC command, exact config, state count, depth, symmetry settings, and output;
- invariant and temporal-property results;
- every counterexample trace;
- mutation score and surviving mutants;
- independent reviewer and review scope.

Commands:
`java -cp tla2tools.jar tla2sany.SANY EGIS_AtomicOperation.tla`

`java -cp tla2tools.jar tlc2.TLC -config EGIS_AtomicOperation.cfg EGIS_AtomicOperation.tla`

No result is PASS until the exact committed module and config are executed and outputs retained.

## 10. Exit criteria

The formal model is eligible for registration as executable only after:
1. canonical records are represented with finite, complete types;
2. all transitions are explicit and type-correct;
3. AtomicOperation and OperationComposition use the same canonical types;
4. SANY parses the exact candidate;
5. TLC explores all declared finite bounds;
6. required invariants hold;
7. each weakened mutant yields the expected counterexample;
8. liveness assumptions are explicit and tested;
9. independent review reconciles model and EGIS standard;
10. limitations and abstraction gaps are recorded.

Current status: SANY NOT_RUN; TLC NOT_RUN; mutation tests NOT_RUN; differential tests NOT_RUN; provider fault injection NOT_RUN; implementation refinement NOT_ESTABLISHED.
