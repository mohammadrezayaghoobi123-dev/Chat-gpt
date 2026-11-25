# Orphan INTENT Recovery Contract

## Status and decision authority

**Status: ARCHITECTURE POLICY RATIFIED / DURABLE IMPLEMENTATION NOT YET VERIFIED.**

This document specifies the recovery protocol required for RS-08. It does not select a production backend, implement a durable journal, authorize reviewer activation, or authorize model/provider execution or GitHub publication.

The accepted policy is recorded in [ADR-001](./ADR-001-ORPHAN-INTENT-TERMINAL-ABORT.md): when complete authoritative evidence proves that the exact attempt boundary was never committed, the orphan INTENT is terminally aborted and a final append-only ledger event is recorded. A committed boundary is recovered using its exact persisted receipt. Ambiguous, unavailable, stale, incomplete, or conflicting evidence remains quarantined. This policy does not authorize automatic continuation or any provider/GitHub side effect.

## 1. Scope and crash window

An orphan INTENT is an EffectLedger INTENT whose durable append acknowledgement was returned to the writer, but whose corresponding ReservationStore attempt-boundary transition has not been conclusively established.

The target crash window is:

1. Writer submits `appendIntent(key, stage, attemptId, requestDigest)`.
2. EffectLedger durably commits INTENT and returns a verifiable acknowledgement.
3. Writer process terminates before invoking the ReservationStore attempt-boundary operation.

This protocol also treats lost acknowledgements, stale reads, partial restore, and concurrent recovery as potentially ambiguous. A timeout or missing local cache entry is not proof that a durable operation did not commit.

Out of scope: exactly-once external effects, production backend selection, cryptographic key provisioning, and reviewer/provider activation.

## 2. Immutable operation identity

Every attempt MUST have one immutable identity tuple:

```text
operation_id
reservation_key = (repository_id, pull_request_number, head_sha, base_sha)
stage = MODEL | COMMENT
attempt_id
request_digest
protocol_version
```

The canonical encoding and digest algorithm MUST be versioned and unambiguous. The durable stores MUST retain the full tuple, not only its digest. Any same-ID/different-tuple observation is an integrity conflict and MUST fail closed without mutation.

The operation identity MUST be generated before the first durable write and reused for every retry, lookup, reconciliation, and recovery action. Recovery MUST NOT mint a replacement attempt ID.

## 3. Required durable evidence

### 3.1 EffectLedger

The ledger MUST expose:
- `appendIntent(operation)` — idempotent for the same immutable operation; conflicting reuse returns `INTEGRITY_CONFLICT`.
- `readIntent(operation_id)` — returns the immutable event and a completeness/freshness proof, or an explicit non-authoritative result.
- `appendRecoveryDisposition(operation_id, disposition, evidence, recovery_fence)` — append-only, idempotent, and uniquely constrained per recovery decision generation.
- `readRecoveryHistory(operation_id)` — complete ordered history with a verifiable high-water mark.

An acknowledgement MUST identify the committed event, sequence/version, payload digest, and authority. A caller-generated object is not an acknowledgement.

### 3.2 ReservationStore

The reservation authority MUST expose:
- `readAttemptBoundary(operation)` — returns `COMMITTED`, `DEFINITIVELY_NOT_COMMITTED`, `UNKNOWN`, `INTEGRITY_CONFLICT`, or `RECOVERY_LOCKED`.
- `readAttemptBoundaryReceipt(operation)` — returns the exact committed receipt only when the authoritative record proves the matching transition.
- `readRecoveryFence(operation_id)` — returns the current monotonic fencing generation and owner.
- `acquireRecoveryFence(operation_id, expected_generation, owner)` — linearizable compare-and-swap with a durable acknowledgement.

`DEFINITIVELY_NOT_COMMITTED` is permitted only after a complete, authoritative, non-stale read over the relevant key and transaction history. A 404, timeout, cache miss, partial listing, or unavailable replica MUST return `UNKNOWN`, never `DEFINITIVELY_NOT_COMMITTED`.

## 4. State model

The protocol states are:

| State | Meaning | Permitted automatic action |
| --- | --- | --- |
| `INTENT_ACKNOWLEDGED` | Durable INTENT acknowledgement exists | None until boundary reconciliation |
| `ORPHAN_SUSPECTED` | Writer disappeared or boundary acknowledgement is absent | Read-only reconciliation |
| `RECOVERY_QUARANTINED` | Evidence is incomplete, stale, unavailable, conflicting, or ambiguous | No permit; no external effect |
| `BOUNDARY_COMMITTED` | Reservation authority proves the exact boundary and receipt | Recover the same receipt; never mint another |
| `BOUNDARY_DEFINITIVELY_ABSENT` | Complete authoritative evidence proves no boundary committed | Acquire a fence and execute the ratified terminal-abort protocol |
| `ABORTED_ORPHAN` | The ADR-001 terminal tombstone and final ledger event are durably reconciled | Terminal; no continuation |
| `INTEGRITY_CONFLICT` | Identity, receipt, store history, or sequence disagreement | Global/key quarantine and investigation |

State changes MUST be monotonic in the durable audit history. A state label is derived from evidence; it MUST NOT overwrite or erase earlier events.

## 5. Recovery algorithm

1. Start in read-only mode. Do not call a model/provider, create a comment, or issue an attempt permit.
2. Load the exact operation identity from the durable INTENT acknowledgement or a complete ledger read.
3. Verify the INTENT event identity, payload digest, stage, immutable reservation tuple, and request digest.
4. Acquire a monotonic recovery fence using compare-and-swap. A stale worker MUST be unable to append a disposition or use a recovered receipt.
5. Query ReservationStore for the exact attempt boundary and receipt using an authoritative, complete, fresh read.
6. Apply the evidence lattice:
   - Exact committed boundary plus matching persisted receipt: record/reconcile `BOUNDARY_COMMITTED`; return only the same receipt. Do not abort.
   - Complete authoritative proof of no boundary, receipt, permit, or boundary event: proceed to the terminal-abort sequence below.
   - Incomplete, stale, unavailable, ambiguous, or conflicting evidence: append/retain `RECOVERY_QUARANTINED`; no permit, tombstone, terminal abort, or external effect.
7. In one ReservationStore transaction, re-check boundary absence and the current fence, then insert a unique immutable orphan-abort tombstone that permanently blocks the exact attempt ID from obtaining a permit. The transaction and tombstone acknowledgement MUST be durable.
8. Only after the tombstone acknowledgement, append the exact `ORPHAN_INTENT_ABORTED` event to EffectLedger. The append is unique and idempotent by operation ID and exact payload. A crash between steps 7 and 8 is repaired by reading the same tombstone and appending the same terminal event; no second tombstone or permit may be created.
9. Re-read both stores and verify the exact tombstone, terminal ledger event, fence generation, payload digests, and high-water marks before returning `ABORTED_ORPHAN`.

If either store cannot prove a complete and mutually consistent view, the operation remains quarantined. Recovery MUST NOT infer absence from a negative partial read.

## 6. Concurrency, fencing, and idempotency

- Recovery fencing MUST be monotonic and linearizable.
- Every write MUST include the current fence generation and owner identity.
- A stale fence MUST be rejected before mutation.
- One immutable recovery-decision ID MUST identify each intended disposition.
- Repeating the same request with the same decision ID and payload returns the original acknowledgement.
- Reusing a decision ID with different payload returns `INTEGRITY_CONFLICT`.
- Two independent recovery workers MUST converge on one durable disposition; no process-local mutex is authoritative.
- The reservation boundary remains single-use. Recovery MUST NOT increment its generation, record version, or boundary event ID merely to recover an existing committed receipt.

## 7. Safety invariants

1. No model/provider call or GitHub POST before a durably acknowledged matching boundary receipt.
2. No recovery action turns `UNKNOWN` into success or absence.
3. No new attempt ID is created to escape an ambiguous attempt.
4. No automatic retry of an external effect is permitted after an ambiguous outcome.
5. No receipt is minted by the recovery worker.
6. No incomplete or stale read may authorize abort or continuation.
7. Every recovery decision is append-only, attributable, and bound to exact evidence digests and a fence generation.
8. Any full-tuple, receipt, authority, sequence, or cross-store mismatch enters quarantine.
9. Rollback or partial restore that cannot be reconciled against an independent complete inventory enters `RECOVERY_LOCKED`.
10. A reference-oracle test is not evidence of durable, cross-process, or production recovery.

## 8. Failure matrix

| Failure/evidence | Required result |
| --- | --- |
| INTENT append not durably acknowledged | No boundary call and no external effect |
| INTENT acknowledged; writer dies before boundary invocation | `ORPHAN_SUSPECTED`; reconcile read-only |
| Boundary committed; response lost | Recover exact persisted receipt; no second boundary |
| Boundary read is 404 but listing/read completeness is unknown | `RECOVERY_QUARANTINED` |
| ReservationStore unavailable | `RECOVERY_QUARANTINED` |
| EffectLedger unavailable or history incomplete | `RECOVERY_QUARANTINED` |
| Full tuple or request digest mismatch | `INTEGRITY_CONFLICT` |
| Two recovery workers race | One current fence; stale worker rejected without mutation |
| Recovery disposition append acknowledgement lost | Read by same decision ID and exact payload |
| Partial restore or high-water mark rollback | `RECOVERY_LOCKED` pending independent reconciliation |

## 9. T57 conformance acceptance criteria

T57 MUST run against a genuinely durable adapter with an explicit close/reopen boundary. Constructing a second in-memory oracle or copying Maps does not satisfy restart testing.

Required test sequence:

1. Start independent writer process A against durable test stores.
2. Append INTENT and verify its durable acknowledgement.
3. Inject process termination after acknowledgement and before any boundary method invocation.
4. Confirm process A is terminated; do not reuse its heap, Maps, or object references.
5. Start independent recovery process B and reopen both stores from their durable backing state.
6. Verify the same operation identity and exact INTENT event are recovered.
7. Verify no boundary receipt/permit and no external-effect invocation exists for this attempt.
8. Force an incomplete or unavailable ReservationStore read; assert quarantine and byte-for-byte unchanged authoritative state.
9. Restore complete reads; verify the exact evidence classification.
10. Run two recovery workers concurrently; prove stale fencing rejection and one append-only disposition.
11. Kill process B after disposition commit but before acknowledgement; process C must recover the same disposition without a second event.
12. Repeat after a fresh restart and verify monotonic high-water marks, no duplicate terminal events, no new attempt ID, no second boundary, and no external effect.

Required assertions include durable record versions, event IDs, exact payload digests, fence generations, ledger high-water marks, and unchanged state on every rejected/incomplete path.

T57 is not considered GREEN until the above runs against the selected durable backend and the full affected regression suite is observed. The preserved duplicate-publication race remains a separate failure and MUST NOT be weakened or hidden.

## 10. Required fault-injection matrix

- Crash before INTENT commit.
- INTENT commit succeeds but acknowledgement is lost.
- Crash after INTENT acknowledgement and before boundary invocation.
- Boundary transaction commits but acknowledgement is lost.
- Boundary transaction definitely aborts.
- Boundary query returns stale/partial/timeout/404.
- Ledger read is unavailable or returns incomplete history.
- Recovery fence acquisition acknowledgement is lost.
- Two recovery workers race with same operation ID.
- Stale worker attempts append after fence takeover.
- Recovery disposition commits but acknowledgement is lost.
- Crash after disposition acknowledgement.
- Partial restore rolls back one store but not the other.
- Authority/key identity changes during recovery.
- Same operation ID is replayed with altered tuple, stage, request digest, or payload.

## 11. Remaining operational decisions

The terminal-abort policy itself is ratified by ADR-001. The following operational decisions remain unresolved and MUST NOT be silently selected:

1. **Quarantine scope:** per operation, per reservation key, or system-wide `RECOVERY_LOCKED` after cross-store inconsistency.
2. **Retention:** minimum durable retention for INTENT, recovery history, receipts, fences, tombstones, and independent backups.
3. **Recovery liveness:** maximum quarantine duration and escalation path; no timeout may silently authorize a disposition.
4. **Authority trust root:** ownership, rotation, revocation, and compromise response for the recovery-fence signer.

Until these are specified, ambiguity remains quarantined. A definitively absent boundary follows the terminal-abort protocol in ADR-001; continuation of that operation is prohibited.

## 12. Reference implementation boundary

The current reference oracle uses process-local Maps and a deterministic non-cryptographic receipt token. It has no durable adapter injection, process reopen API, independent ledger, cross-process fencing, or recovery authority. It can later serve as a state-machine unit-test oracle, but it cannot satisfy T57 or production qualification.

No production implementation, backend provisioning, workflow activation, secret change, deployment, merge, or local desktop operation is authorized by this design contract.
