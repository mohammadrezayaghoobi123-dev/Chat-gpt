# EGIS Formal Model Contract and Verification Plan

**Model ID:** EGIS-FM-001  
**Target:** EGIS-001 v1.0.1  
**Status:** Formalization contract; executable TLA+ model NOT_REGISTERED and NOT_RUN  
**Date:** 2026-11-25

## 1. Purpose

This document defines the single canonical state and transition contract to be translated into TLA+/TLC. It deliberately does not register the prior v0.9 code fragment as authoritative: that fragment has unresolved type, lifecycle, graph-binding, and recovery defects.

The formal model is an abstract safety model. It cannot prove that a particular database, cloud provider, cryptographic library, verifier, or deployment environment conforms. Those require refinement and implementation evidence.

## 2. Canonical state

The model state is:

`S = (Scope, Change, Requirements, Graph, Evidence, Trust, Policy, Exceptions, Snapshot, Authorization, Attempts, Commit, Release, Deployment, Ledger)`

Each field has exactly one definition in EGIS-001:
- **Scope:** server-derived tenant/project/change/principal tuple and membership revision.
- **Change:** operation identity, change revision, affected components, and status.
- **Requirements:** applicable requirement IDs and exact revisions.
- **Graph:** graph ID, revision, canonical edges, digest, completeness, source provenance.
- **Evidence:** immutable claim/artifact/attestation/verification references and revocation state.
- **Trust:** identity/key status, trust epoch, authority revision.
- **Policy:** policy revision and evaluator version.
- **Exceptions:** exact-scope, pre-approved, expiring exception records.
- **Snapshot:** immutable manifest binding every decision-relevant field.
- **Authorization:** single-use, expiring authorization bound to operation, scope, snapshot, policy, trust, and authority.
- **Attempts:** finite set of attempts for one logical operation, each with explicit state.
- **Commit:** zero or one durable CommitRecord for that operation.
- **Release:** artifact commit status.
- **Deployment:** independent environment deployment status and observations.
- **Ledger:** ordered append-only event sequence.

A model instance represents one logical operation. Cross-operation uniqueness is enforced by the production operation registry and must be tested in an integration model that composes multiple operation instances.

## 3. State domains

### 3.1 Lifecycle

`IDLE, PREPARED, EVALUATED, AUTHORIZED, COMMIT_PENDING, RECOVERY_PENDING, COMMITTED, ABORTED`.

### 3.2 Gate outcomes

`PASS, FAIL, UNKNOWN, DISPUTED, EXPIRED, REVOKED, SUPERSEDED, NOT_APPLICABLE, EXCEPTION_APPROVED`.

### 3.3 Attempt outcomes

`NEW, PENDING, WON, REJECTED, CANCELLED`.

### 3.4 Commit observation

`NOT_ATTEMPTED, UNKNOWN, COMMITTED, AUTHORITATIVELY_ABSENT`.

Storage truth and caller observation are separate variables. The model must allow acknowledgement loss after a durable write and ambiguous outcomes where reconciliation has not yet established authoritative truth.

## 4. Required transitions

1. **PrepareSnapshot:** resolve exact scope, membership, change/component revisions, requirements, graph, evidence, trust, policy, exceptions, environment, and time basis; create immutable snapshot.
2. **Evaluate:** evaluate only the prepared snapshot; record primary and oracle results; freeze all results for that snapshot.
3. **Authorize:** issue only when every applicable mandatory gate is acceptable and all authority/snapshot checks pass.
4. **StartAttempt:** create one of several attempts for the same operation while authorization remains valid and unconsumed.
5. **CommitAttempt:** atomically revalidate all bindings, consume authorization, enforce operation uniqueness, create CommitRecord, and couple audit intent.
6. **RejectStaleAttempt:** abort when any snapshot, scope, policy, trust, authority, membership, exception, or evidence-revocation input changed.
7. **LoseAcknowledgement:** make observation UNKNOWN without rewriting durable commit truth.
8. **Reconcile:** resolve only from authoritative storage evidence; otherwise remain UNKNOWN.
9. **MutateDecisionInput:** allow graph, policy, trust, membership, authority, or exception changes to interleave and prove stale authorization is rejected.
10. **Deploy:** require a valid CommitRecord and deployment-specific authorization.
11. **DeploymentFailure/Rollback:** preserve historical release truth and append separate deployment records.

## 5. Required state invariants

- Type correctness for every variable and record field.
- At most one winning attempt.
- Winning attempt equals CommitRecord.winning_attempt_id.
- A CommitRecord exists only for the exact authorization and snapshot.
- Commit scope equals authorization scope equals snapshot scope.
- Authorization is consumed at most once.
- Commit snapshot, policy, trust, authority, membership, and exception revisions match the values validated at the commit linearization point.
- Mandatory UNKNOWN, DISPUTED, FAIL, EXPIRED, REVOKED, or SUPERSEDED gates cannot be accepted.
- NOT_APPLICABLE requires a complete trusted graph and independently validated closure.
- Hard invariants cannot be excepted.
- Evidence claim, artifact, attestation, verifier result, scope, revision, and policy are bound.
- Primary verifier and oracle have no known shared failure domain, authority, or evidence path in the declared threat model.
- No duplicate durable commit record for the logical operation.
- RECOVERY_PENDING has UNKNOWN observation and cannot start another attempt.
- Reconciliation cannot infer authoritative absence from an eventually consistent replica.
- Release and deployment states are independent.
- Ledger sequence and previous-event links are continuous.
- Historical commit validity is evaluated against its captured snapshot, not mutable current policy/trust state.

## 6. Required temporal properties

Safety and liveness MUST be checked separately.

Safety examples:
- `[] (CommitRecordExists => CommitBindingsValid)`
- `[] (RecoveryPending => NoNewAttempt)`
- `[] (DeploymentState = DEPLOYED => CommitRecordExists)`

Liveness is conditional:
- `[] (RecoveryPending => <> (Committed / Aborted))` may be asserted only under explicit assumptions that the authoritative store becomes available, reconciliation is scheduled fairly, and the operation record remains queryable.

A liveness property without its fairness and availability assumptions is invalid.

## 7. Bounded TLC strategy

The first model must be finite and include:
- 2 tenants;
- 2 projects;
- 2 principals with different membership scopes;
- 2 affected components and at least one transitive dependency;
- 2 mandatory gates, including one hard invariant;
- 2 graph revisions, one complete and one incomplete;
- 2 policy revisions;
- 2 trust epochs;
- 2 authority revisions;
- 2 attempts;
- one exceptionable gate and one non-exceptionable hard gate;
- one shared-failure-domain mutant and one structurally independent verifier/oracle case;
- bounded time with an expiring authorization and exception.

The configuration must include all model values explicitly. No unbounded natural-number counters are allowed; sequence length, revisions, time, and attempts are bounded.

## 8. Mutation and differential verification

Run each MUT-001 through MUT-020 from EGIS-AR-001. The hardened model must satisfy the intended invariant; each weakened mutant must produce a counterexample. Preserve the counterexample trace and exact model configuration.

The model, reference evaluator, and test oracle must not all be generated from the same implementation logic. Differential tests must use independently authored expected outcomes. Shared source code, fixtures, or assumptions are recorded as common-cause risk.

## 9. Tool execution and evidence requirements

Required commands after a TLA+ module and finite config exist:

- SANY parser: `java -cp tla2tools.jar tla2sany.SANY EGIS_AtomicCore.tla`
- TLC model checking: `java -cp tla2tools.jar tlc2.TLC -config EGIS_AtomicCore.cfg EGIS_AtomicCore.tla`

The actual tool version, JAR digest, command line, configuration digest, output, state count, depth, invariant results, and counterexample artifacts must be retained.

Current result:
- SANY: NOT_RUN
- TLC: NOT_RUN
- Mutation tests: NOT_RUN
- Differential tests: NOT_RUN
- Implementation refinement: NOT_ESTABLISHED

Do not convert these states to PASS or FAIL.

## 10. Exit criteria for formal-model readiness

The TLA+ model may be registered as executable only after:
1. every canonical record has a finite, type-checked representation;
2. all transitions are defined without implicit state mutation;
3. every invariant is syntactically valid and state-level;
4. every temporal property has explicit fairness/availability assumptions;
5. SANY parses the exact committed module;
6. TLC explores the declared finite bounds;
7. each mutation has the expected counterexample;
8. independent review checks the abstraction against EGIS-001;
9. limitations and omitted behaviors are listed.

Formal-model readiness does not grant implementation or deployment authorization.
