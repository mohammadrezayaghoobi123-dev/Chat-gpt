# ADR-001: Terminal Abort of Orphan Effect-Ledger INTENT

- **Status:** ACCEPTED
- **Decision date:** 2026-11-25
- **Decision authority:** Explicit user decision in the project conversation
- **Scope:** RS-08 orphan-INTENT recovery only
- **Implementation status:** Design ratified; durable implementation and T57 evidence are still pending

## Context

An EffectLedger INTENT may be durably acknowledged before the writer invokes the ReservationStore attempt-boundary transition. If the writer terminates in that interval, recovery must distinguish a definitely absent boundary from a committed boundary whose acknowledgement was lost. Missing cache entries, timeouts, unavailable stores, and incomplete reads are not evidence of absence.

A ledger-only terminal marker is insufficient: a delayed or stale worker could otherwise attempt to turn the same attempt into a permit after the ledger had been closed. Conversely, a ReservationStore tombstone without a corresponding terminal ledger event leaves the audit record incomplete.

## Decision

**When, and only when, authoritative complete evidence proves that the matching attempt boundary was never committed, the orphan INTENT MUST be terminally aborted and a final append-only ledger event MUST be recorded.**

The terminal decision is bound to the exact immutable operation identity:
- operation ID;
- full reservation tuple (repository_id, pull_request_number, head_sha, base_sha);
- stage;
- attempt ID;
- request digest;
- protocol version;
- original durable INTENT event ID and digest.

The same operation/attempt ID MUST never be resumed or used to obtain a later permit after terminal abort.

## Mandatory preconditions

All of the following MUST be true before abort is allowed:

1. The exact INTENT exists and its durable acknowledgement and complete ledger history verify.
2. The ReservationStore read is authoritative, complete, fresh, and bound to the same full operation identity.
3. The ReservationStore proves that no matching attempt boundary, receipt, permit, or boundary event was committed.
4. The trusted invocation protocol makes an external effect impossible before a committed matching boundary receipt; independent effect evidence contains no invocation for this attempt.
5. A current recovery fencing generation is acquired and acknowledged.
6. The reservation record and immutable snapshot still match the INTENT; no cross-store or integrity conflict exists.

Any missing, stale, incomplete, unavailable, or contradictory evidence produces RECOVERY_QUARANTINED or INTEGRITY_CONFLICT; it MUST NOT authorize an abort.

If the exact boundary is committed, recovery returns the same persisted receipt. It MUST NOT abort the attempt or mint a replacement receipt. If the boundary or external-effect outcome is ambiguous, the operation remains quarantined.

## Required commit order

The two stores do not share one distributed transaction. The protocol therefore uses a fail-closed, convergent order:

1. **Fence:** acquire a monotonic recovery fence by compare-and-swap. Every later write checks the current generation and owner.
2. **Reservation tombstone:** in one ReservationStore transaction, re-check complete boundary absence and insert a unique terminal tombstone for the operation. The tombstone is bound to the full tuple, stage, attempt ID, request digest, INTENT event ID/digest, evidence digest, and fence generation. The same transaction makes the exact attempt ID permanently ineligible for a permit.
3. **Ledger terminal event:** only after the ReservationStore tombstone is durably acknowledged, append ORPHAN_INTENT_ABORTED to EffectLedger. Enforce a unique terminal disposition per operation ID and immutable payload equality on retry.
4. **Reconciliation:** re-read both stores and verify the exact tombstone, final ledger event, fence generation, event digests, and high-water marks before reporting ABORTED_ORPHAN.

The ReservationStore tombstone is the deny-side safety barrier. If the process dies after the tombstone commits but before the ledger event commits, the next recovery worker MUST recover the exact tombstone and idempotently append the same terminal ledger event. It MUST NOT create a second tombstone, change the decision identity, or issue a permit.

If the tombstone commit acknowledgement is lost, the worker performs a complete authoritative read. A matching tombstone is recovered; a complete proof of no tombstone permits a safe retry under a fresh valid fence; any ambiguous or incomplete read remains quarantined. A lost ledger-event acknowledgement is reconciled by the same operation ID and exact payload.

## Required interfaces

ReservationStore:
- readAttemptBoundary(operation)
- acquireRecoveryFence(operation_id, expected_generation, owner)
- abortOrphanAttempt(operation, absence_evidence, intent_ack, fence)
- readOrphanAbort(operation_id)
- beginAttempt MUST reject an operation ID already covered by a terminal orphan-abort tombstone. It MUST also verify the exact matching durable INTENT before issuing a permit, and atomically reject starts while a recovery fence is active (`RECOVERY_FENCED`). Tombstone precedence is stronger: a terminally aborted attempt returns `ORPHAN_ABORTED` regardless of fence state.

EffectLedger:
- readIntent(operation_id)
- appendOrphanIntentAborted(operation_id, tombstone_ack, evidence)
- readRecoveryHistory(operation_id)

These interfaces are protocol requirements, not a claim that the current in-memory reference adapter or any production backend already implements them.

## Idempotency and conflict behavior

- Exact replay of the same abort request returns the original durable acknowledgement.
- Same operation ID with a different full tuple, stage, attempt ID, request digest, INTENT reference, evidence digest, or tombstone payload returns INTEGRITY_CONFLICT.
- A stale recovery fence is rejected before mutation.
- A boundary appearing before the tombstone transaction commits prevents abort.
- A valid existing boundary receipt is recovered, not aborted.
- A partial restore, regressed high-water mark, missing tombstone, or ledger/store disagreement enters RECOVERY_LOCKED or quarantine pending independent reconciliation.
- No process-local mutex or in-memory cache is an authority.

## T57 acceptance requirements

T57 must prove the decision across independent processes and durable backing stores:
1. Process A durably appends INTENT, receives its acknowledgement, and terminates before any boundary invocation.
2. Process B reopens both stores, verifies the exact INTENT and complete boundary absence, acquires a fence, writes the tombstone, and appends the final ledger event.
3. A fault after tombstone commit but before ledger append is recovered by process C without a second tombstone or a second terminal event.
4. Two independent recovery workers racing under the same expected fence cannot both mutate; the stale worker is rejected.
5. A late beginAttempt for the aborted attempt is rejected without a permit.
6. An incomplete/unavailable read leaves both stores unchanged and the operation quarantined.
7. Repeated recovery after another restart returns the same terminal disposition and preserves monotonic high-water marks.
8. No model/provider/GitHub side effect is invoked.

A filesystem or SQLite harness may establish process-restart and database-transaction behavior for a test adapter only. It does not qualify a deployed ReservationStore, an independent cloud failure domain, hardware power-loss durability, or the production reviewer path.

## Consequences

- This policy favors safety over liveness: an orphan with definitively absent boundary is terminal and cannot be resumed.
- Recovery may complete the ledger audit event after a previously committed reservation tombstone; this is deterministic convergence, not a cross-store atomic transaction.
- A later fresh attempt, if the product permits one, requires a distinct higher-level authorization and a new immutable operation identity. It MUST NOT reuse this attempt ID or silently bypass the terminal tombstone.
- Production qualification remains blocked until the durable store interfaces, cross-process fencing, recovery authority, and T57 fault matrix are implemented and independently verified.

## Non-goals and restrictions

This ADR does not select or provision a production backend, wire runReview(), enable reviewer/provider dispatch, register or activate a workflow, modify secrets, deploy, merge, or modify main.
