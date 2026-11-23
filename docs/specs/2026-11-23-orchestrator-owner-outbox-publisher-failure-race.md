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


## Observed Verification Record

### Candidate CI

Exact code-tested candidate: `a177c4f40f3ca90684e0bfc66a2291418e12a0b5` (PR #311).

- Cloud Engineering Connector CI run `45186365668`: success.
- Node test suite: 416 passed, 0 failed.
- Durable Object/Vitest suite: 13 files, 211 passed, 0 failed. The four new Publisher/Owner interleavings all passed.
- `npm audit --audit-level=moderate`: 0 vulnerabilities.
- JavaScript syntax checks and default/staging Wrangler dry-runs: passed.
- Post-deploy Staging smoke: skipped; there was no deployment or live operation.

The first CI attempts exposed test-harness defects, not product regressions: the test needed to set its test-only active signing key explicitly, the Worker adapter needed to route to the same global Durable Object identity used by the Worker, and consumed-assertion counts needed per-case baselines because the test reused the global Ledger. Each was corrected on the isolated branch; the exact candidate above passed the full configured suite.

### Mutation Experiments

Each mutant was created from the exact candidate above, changed one invariant, ran CI, and was closed unmerged after its intended assertion failed.

| Invariant removed | Temporary PR / mutant commit | CI run | Falsifying observation |
|---|---|---:|---|
| Owner Cancel/Quarantine Outbox invalidation | #313 / `9d683d07b59ebe35bad0222710a55c325ee60fb5` | `45186554481` | New in-flight Publisher tests observed `RETRY_WAIT` / `OUTBOX_QUEUE_PUBLISH_FAILED` and a late success callback reported `completed: true`; Owner-terminal Outbox state was not preserved. |
| `failOutbox` lease owner/generation/expiry fence | #314 / `65097023faf0fbc422142957df2e8e0f65595696` | `45186576125` | The stale failure callback consumed its operation-scoped JTI; per-case assertion-consumption delta failed for Cancel and Quarantine. |
| `completeOutbox` lease owner/generation/expiry fence | #315 / `aa0d2c315cdde60df2c1f80c5448aa5808c036f8` | `45186595358` | The stale success callback returned `completed: true` rather than `completionPending: 1`; the new and existing stale-ACK tests failed. |

All three mutations were killed by their intended behavioral or persisted-state assertions. The failed jobs are expected mutation evidence on deliberately weakened branches, not candidate failures.

### Security Scan and Boundaries

- Gitleaks run `45186365624`: PR diff scan covered 7 commits and found no leaks.
- Full reachable history: 4,277 commits scanned; 11 historical `generic-api-key` findings remain unclassified. The scan alone does not establish whether these are live credentials or false positives. No values or fingerprints are included.
- Main comparison against `919b19ca3d3887352cdef06b03c668ead04fbce7`: identical, 0 commits ahead/behind.
- PR #311 remains Draft/open/unmerged. Parent PRs #307 and #300 remain Draft/open/unmerged. Mutation PRs #313–#315 are closed and unmerged.
- No production code was modified, no Validator/Scheduler authority was added, and no `VALIDATING` transition was introduced.
- No Cloudflare configuration/secret mutation, live Worker/Queue action, deployment, Staging smoke, merge, or Production activity occurred.


## Final-Head Verification

- Code/test HEAD: `c73c5ad2cc75585542fc4fe4c15aab20e22c1053`.
- Cloud Engineering Connector CI run `45187099701`: success on that exact head.
- Node: 416/416 passed; Durable Object/Vitest: 13/13 files and 211/211 tests passed.
- npm audit: 0 vulnerabilities. Syntax checks and both Wrangler dry-runs passed. Staging smoke was skipped.
- Gitleaks run `45187099715`: PR diff scan covered 11 commits, no leaks found; 4,286 reachable commits scanned, 11 historical `generic-api-key` findings remain unclassified.
- The later commit that only appends this final verification record changes this Markdown file only. The tested code/test behavior is unchanged.
