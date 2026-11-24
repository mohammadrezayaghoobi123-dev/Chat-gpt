# EGIS-OPC-001 — Operation Composition Contract v1.1.0

**Status:** Formal-model candidate; NOT_FORMALLY_VERIFIED  
**Baseline:** EGIS integrated standard v1.0.2 and Atomic Recovery model v1.0.4  
**Date:** 2026-11-25

## 1. Purpose

This slice lifts the single-operation recovery abstraction into a finite multi-operation composition model. Its purpose is to state and test isolation, replay/collision behavior, per-key attempt serialization, and recovery independence without claiming distributed exactly-once effects.

## 2. Canonical identity and scope

The canonical type module is the only type-definition source for this slice.

- `OperationKey = (tenant, project, operation_id)`.
- `Scope = (tenant, project, change, principal, membership_revision, capability)`.
- `OperationEntry = (fingerprint, scope)`.
- `CommitRecord = (operation_key, fingerprint, scope, winning_attempt, policy, trust_epoch)`.

A valid initial registration requires:
1. The requested scope tenant equals the OperationKey tenant.
2. The requested scope project equals the OperationKey project.
3. The membership tuple is present in the active-membership set.
4. The principal/capability tuple is present in the active-capability-grant set.

Membership revocation is modeled as mutable state and is rechecked at authorization and commit. Capability grants are currently a static finite input; dynamic capability revocation is an explicit refinement gap.

## 3. Registration and replay semantics

For a previously unseen OperationKey:
- valid scope + fingerprint creates the immutable registry entry and returns `ACCEPTED`;
- invalid scope returns `SCOPE_REJECTED` without creating an entry.

For an existing OperationKey:
- identical fingerprint and identical scope returns `REPLAY` and does not create another operation or attempt;
- any fingerprint or scope mismatch returns `CONFLICT` and does not mutate the canonical entry.

The fingerprint is an opaque finite model value. The model does not specify canonical serialization or a cryptographic hash algorithm.

## 4. Per-key state and atomic reservation

All lifecycle, attempt, intent, commit, store-epoch, lookup, and observation state is indexed by OperationKey. No mutable recovery or reservation state is shared across different keys.

Multiple attempts may enter `PENDING` for one key before reservation. `ReserveIntent(key, attempt)` is guarded by `intentState[key] = NONE`; the first successful transition sets the reserved attempt and `RESERVED` intent. Subsequent reservations and new attempts for that key are disabled. Attempts for another key remain independent.

`CommitAndLoseAck(key)` represents one abstract atomic durable transition. It creates the key's single CommitRecord, consumes authorization, marks one winner, rejects other pending attempts, advances that key's store epoch, and leaves caller observation `UNKNOWN` in `RECOVERY_PENDING`.

This action is an abstraction, not a database protocol. It does not prove that a particular storage engine provides linearizable compare-and-swap, serializable transactions, a unique constraint, or transactionally coupled audit outbox behavior.

## 5. Recovery semantics

Lookup, epoch, durable outcome, CommitRecord, and caller observation are per key.

- Stale replica absence sets `STALE_ABSENT`; it cannot finalize.
- Authoritative lookup of a present record returns `FOUND_VALID` at the current key epoch.
- Authoritative lookup after an aborted intent returns `ABSENT_AUTHORITATIVE` at the current key epoch.
- Reconciliation requires matching key, fingerprint, scope, reserved attempt, durable outcome, and current lookup epoch.
- An unresolved key remains `RECOVERY_PENDING`; that does not block progress on a distinct key.

`UNKNOWN` remains unresolved. No liveness guarantee or unconditional recovery deadline is asserted.

## 6. Safety properties

The finite model checks:
- type correctness;
- CommitRecord-to-registry binding;
- CommitRecord-to-snapshot policy/trust binding;
- tenant/project isolation;
- authoritative absence consistency;
- stale-replica non-finalization;
- authorization consumption before a durable record;
- at most one winning attempt per OperationKey;
- winning-attempt/CommitRecord agreement;
- acknowledged outcomes backed by corresponding durable evidence.

A single CommitRecord slot per key is a modeling representation of per-key uniqueness. It is not evidence of global uniqueness across independent stores or deployments.

## 7. Executable reference tests

`test_operation_composition_reference.py` is a deterministic in-memory executable oracle. It covers:
- same-key/same-fingerprint replay;
- same-key/different-fingerprint conflict;
- same-key/scope mismatch conflict;
- independent progress for distinct keys;
- tenant/project isolation;
- membership and capability-grant rejection;
- single intent reservation;
- commit/lost-ack/stale-replica/authoritative-reconciliation path;
- abort/lost-ack/authoritative-absence path;
- per-key recovery independence;
- shared membership revocation;
- policy, trust, membership, evidence, and graph invalidation before commit;
- replay after commit without a second winner.

Command:

```bash
python -m unittest -v verification/formal/egis/tests/test_operation_composition_reference.py
```

The reference tests are not a refinement proof of the TLA+ model, a database implementation, or a distributed concurrency test.

## 8. Explicit exclusions and refinement obligations

Not modeled or not established:
- SANY parsing and TLC state-space exploration;
- mutation execution and independent differential oracle;
- canonical fingerprint encoding/hash and collision resistance;
- dynamic capability-grant revocation;
- approver authority, role separation, and signed authorization token authenticity;
- authoritative store identity, quorum, linearizability, CAS/unique-constraint behavior;
- transactionally coupled outbox and ledger anchoring;
- cross-region failover, epoch rollover, storage corruption, and Byzantine store behavior;
- external side-effect idempotency and exactly-once semantics;
- implementation refinement and operational conformance.

Promotion is prohibited until the exact committed modules pass SANY and TLC, required counterexample/mutation tests are executed, storage semantics are selected and fault-injected, and an independent reviewer evaluates the refinement.
