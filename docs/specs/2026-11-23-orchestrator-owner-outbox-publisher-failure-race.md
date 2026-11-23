# Owner Revocation Versus In-Flight Outbox Publisher — Adversarial Specification

## Intent

Prove that an Owner Cancel or Quarantine remains authoritative when an Outbox Publisher has already claimed an event and is blocked inside the Queue transport. The Queue operation may later report success or fail after the Owner transaction commits. Neither late Publisher callback may complete, retry, or otherwise resurrect the invalidated event.

This is a test-only extension of PR #307. No production behavior change is assumed or authorized unless a focused failing integration test demonstrates a defect.

## System Under Test

- Real Cloudflare Durable Object `OrchestratorLedger` and SQLite storage.
- Real Worker `processOrchestratorOutbox`, `completeOutbox`, and `failOutbox`.
- Real Worker `consumeOrchestratorOutbox` and `recordOutboxReceipt`.
- Real Owner assertion verification and one-time JTI consumption.
- A deterministic Queue transport gate that records the offered message and withholds its completion until after the Owner transaction.

The Queue fixture is the only external boundary double. It records the exact JSON envelope, blocks on a promise, and then either returns success or throws to model an accepted send whose acknowledgement is lost. The Ledger, Worker code, assertions, SQLite transactions, and Consumer remain real.

## Required Linearization Histories

Initial state:
- Task: `SCHEDULED v1`.
- One `task.transitioned` Outbox event: `PENDING`, attempts 0, no Publisher owner, generation 0.
- Publisher claims it: `IN_PROGRESS`, attempts 1, Publisher lease generation 1.

The Queue transport is then held after recording the message. Owner commits either Cancel or Quarantine before the Queue operation settles.

Four independently executed histories cover the Cartesian product:

| Owner operation | Queue transport outcome | Late callback | Required behavior |
|---|---|---|---|
| Cancel | Success | `completeOutbox` | Reject stale lease; Worker records `completionPending: 1`. |
| Cancel | Accepted, acknowledgement lost | `failOutbox` | Reject stale lease; do not schedule a retry. |
| Quarantine | Success | `completeOutbox` | Reject stale lease; Worker records `completionPending: 1`. |
| Quarantine | Accepted, acknowledgement lost | `failOutbox` | Reject stale lease; do not schedule a retry. |

After the Owner transaction, the Queue message may still arrive. Consumer must classify its task-version mismatch as deterministic/stale, acknowledge it, and persist no receipt.

## Atomic Invariants

1. Owner Cancel/Quarantine increments task version to 2 and atomically marks pending/in-progress Outbox work `DEAD_LETTER`, clears Publisher ownership/expiry, and increments the Outbox lease generation from 1 to 2.
2. A Publisher callback carrying the old generation 1 cannot complete or retry the event after Owner commit.
3. Rejected stale Publisher callbacks do not consume their operation-scoped JTI.
4. Queue acceptance before an acknowledgement loss does not override the Owner state.
5. Consumer receipt for the version-1 event after Owner state/version change returns a deterministic blocked outcome; the Queue message is acknowledged and no receipt row is persisted.
6. A later claim attempt, even after the original Publisher lease duration, cannot reclaim the dead-lettered event.
7. Exactly one Owner command receipt and matching Owner audit record exist.

## Falsifiable Hypotheses

| Hypothesis | Mutation / falsification condition |
|---|---|
| Owner invalidation fences an in-flight Publisher failure callback. | Remove Owner's Outbox dead-letter/lease revocation; the late failure callback schedules a retry or the persisted event remains claimable. |
| `failOutbox` validates ownership/generation/expiry before consuming its JTI. | Remove its lease-fence predicate; the stale failure assertion is consumed or the event is reopened. |
| `completeOutbox` validates ownership/generation/expiry before consuming its JTI. | Remove its lease-fence predicate; the stale success callback is reported as completed or its JTI is consumed. |
| Consumer cannot make a stale task event durable after Owner. | Remove task version/state validation; a receipt row is inserted instead of deterministic stale-message acknowledgement. |

Each mutation is a separate temporary branch from the exact test candidate. A mutant is killed only when its CI failure is attributable to the expected assertion, not to syntax, setup, or harness failure.

## Explicit Non-Goals

- No changes to production code in the initial candidate.
- No Scheduler/Validator identity or capability changes.
- No transition out of `VALIDATING`.
- No Cloudflare configuration or secret changes.
- No live Queue/Worker operations, deployment, staging smoke, merge, or Production activity.
- No secret values, keys, tokens, or fingerprints in test output or reports.

## Acceptance Criteria

- All four deterministic histories pass using the real Worker and Ledger.
- Persisted task, Outbox, receipt, audit, and consumed-assertion state are checked directly in SQLite.
- A future claim after the original lease duration still returns `NO_OUTBOX_AVAILABLE`.
- The three targeted mutations described above are killed on isolated commits.
- The candidate remains Draft/open/unmerged and targets PR #307's feature branch, not `main`.
- Main remains unchanged.
