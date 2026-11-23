# Multi-Actor Orchestrator Linearizability Audit

## Purpose

Extend the Owner-command adversarial test surface across the real Durable Object Ledger when Owner, Agent, Outbox Publisher, and Queue Consumer operations overlap. The audit is test-only unless a reproduced product defect requires a separately reviewed minimal fix.

## Scope

In scope:
- Owner `cancel` and `quarantine` against active Agent operations.
- Publisher `completeOutbox` against Owner Outbox invalidation.
- Consumer `recordOutboxReceipt` on both sides of the Owner transition's linearization point.
- Durable task, execution-lease, Outbox, receipt, consumed-assertion, Owner-receipt, and audit state after each forced ordering.
- Mutation experiments on isolated branches.

Out of scope:
- Production behavior changes without a failing integration test.
- New Validator identity, key, policy, or runtime.
- Any `VALIDATING → READY` or `VALIDATING → SCHEDULED` transition.
- Scheduler signer expansion, synthetic leases, Cloudflare configuration or secret changes, deployment, live smoke tests, merge, or Production activity.
- Main-branch writes.

## Existing Invariants Exercised

1. Owner commands derive task state and version from the Ledger snapshot and retry when the task or audit head changes before commit.
2. Owner Cancel/Quarantine atomically changes task state/version, revokes the execution lease, dead-letters pending/in-progress Outbox work, and records one Owner receipt and one audit event.
3. Agent transitions require a matching active Worker lease and generation.
4. Agent lease release may linearize before Owner commit; Owner must still revoke the resulting lease generation and prevent subsequent use of the old generation.
5. Publisher completion requires the exact active publisher identity, lease generation, and non-expired lease.
6. A Consumer receipt committed before an Owner command remains durable historical evidence; a stale receipt arriving after the Owner state/version change is rejected.
7. Consumer receipt rejection consumes the authenticated one-time assertion but does not create a receipt row. Publisher lease-fence rejection occurs before assertion consumption.
8. Owner and Consumer idempotency remain intact: one Owner receipt/audit event and at most one durable Consumer receipt for the event.

## Deterministic Interleaving Matrix

### Case 1 — Agent transition, then Owner Cancel, then late Publisher/Consumer operations

Initial state:
- Task `SCHEDULED`, version 1.
- Agent lease generation 1 is active.
- One task Outbox event is `IN_PROGRESS` under Publisher lease generation 1.

Forced order:
1. Start Owner Cancel and hold its audit digest after it captures the version-1 task snapshot.
2. Commit Agent `SCHEDULED → RUNNING`, version 2.
3. Resume Owner Cancel. Its optimistic snapshot is stale; it must retry against version 2 and commit `RUNNING → CANCELLED`, version 3.
4. Attempt Publisher `completeOutbox` with the pre-cancel lease generation.
5. Attempt Consumer `recordOutboxReceipt` for the version-1 event.

Expected results:
- Agent transition succeeds at version 2; Owner Cancel succeeds at version 3.
- Task is `CANCELLED` version 3; execution lease is ownerless, expired, generation 2.
- Outbox event is `DEAD_LETTER`, ownerless, generation 2; late Publisher completion is rejected with `LEASE_FENCE_MISMATCH`.
- Late Consumer receipt is rejected with `TASK_VERSION_FENCED`; no receipt row is inserted.
- Agent assertion is consumed; Publisher assertion is not consumed on lease-fence rejection; authenticated Consumer assertion is consumed on rejected receipt.
- Exactly one Owner Cancel receipt and audit event exist.

### Case 2 — Agent releaseLease, then Owner Quarantine, then stale operations

Initial state:
- Task `SCHEDULED`, version 1.
- Agent lease generation 1 is active.
- One task Outbox event is pending.

Forced order:
1. Start Owner Quarantine and hold its audit digest after its task snapshot.
2. Agent calls `releaseLease` with lease generation 1 and commits first.
3. Resume Owner Quarantine.
4. Attempt another Agent `releaseLease` with a fresh assertion but the revoked generation 1.
5. Attempt a Consumer receipt for the version-1 event.

Expected results:
- The first Agent release succeeds at generation 1.
- Owner Quarantine commits `SCHEDULED → QUARANTINED`, version 2, and advances the execution lease to ownerless generation 2.
- The later Agent release is rejected with `LEASE_FENCE_MISMATCH` before its assertion is consumed.
- The late Consumer receipt is rejected with `TASK_VERSION_FENCED`; no receipt row is inserted.
- Pending Outbox work is dead-lettered and cannot be claimed.
- Exactly one Owner Quarantine receipt and audit event exist.

### Case 3 — Consumer receipt, then Owner Cancel or Quarantine

Initial state:
- Task `SCHEDULED`, version 1.
- One matching Outbox event is pending.

Forced order:
1. Start Owner Cancel or Quarantine and hold its audit digest after its task snapshot.
2. Consumer records a valid receipt for the version-1 event.
3. Resume the Owner command.
4. Replay the same receipt with a fresh Consumer assertion.

Expected results:
- The pre-Owner Consumer receipt is accepted and remains durable historical evidence.
- Owner command then commits version 2 and dead-letters pending Outbox work.
- Replaying the exact receipt returns the replay outcome and does not create a second receipt.
- One Owner receipt, one matching Owner audit event, and exactly one Consumer receipt remain.

## Falsifiable Hypotheses

| Hypothesis | Counterexample / falsification condition |
|---|---|
| Owner task snapshot revalidation prevents stale-snapshot overwrite. | Removing the in-transaction state/version comparison lets Owner commit from stale version 1 instead of retrying and committing version 3. |
| Owner Outbox invalidation fences an already leased Publisher. | Removing Outbox lease owner/generation invalidation lets a post-Cancel Publisher completion succeed. |
| Consumer receipt validation is bound to the current task version/state. | Removing task version/state validation lets a post-Cancel/Quarantine stale receipt persist. |
| Owner command and Outbox state changes are atomic. | A forced failure or partial state leaves task, lease, Outbox, receipt, or audit state inconsistent. |
| Consumer receipts are linearized against Owner state. | A receipt committed before Owner is lost, duplicated, or rewritten; a receipt after Owner is incorrectly accepted. |

## Evidence and Interpretation Rules

- A passing CI run proves only the tested commit and its configured checks.
- A mutation is considered killed only when the exact mutant commit's relevant CI fails on the intended assertion.
- A mutation run failing for setup, syntax, harness, or unrelated reasons is inconclusive, not a killed mutant.
- A skipped Staging smoke test is recorded as skipped, not passed.
- Historical Gitleaks findings remain unclassified until separately triaged; a clean PR diff does not prove clean repository history.
- No secret values, tokens, key material, or secret fingerprints are to be copied into reports.

## Acceptance Criteria

- All new deterministic integration tests pass on the exact candidate PR head.
- At least the Owner stale-snapshot CAS, Outbox publisher fencing, and stale Consumer task-version mutations are killed on isolated mutant commits.
- The relevant mutant failure is attributable to the new focused test, not an unrelated harness failure.
- The candidate remains a Draft PR, open and unmerged.
- Main HEAD remains unchanged.
- No deployment, Cloudflare configuration/secret mutation, live smoke, or Production operation occurs.


## Observed Verification Record

Candidate: `ed7bb81bcc822959aef508d35ba8ec1daab7f400` (PR #307, Draft, open, unmerged).

### Candidate CI

- Cloud Engineering Connector CI run `45182926716`: success.
- Node test suite: 416 passed, 0 failed.
- Cloudflare Durable Object/Vitest suite: 12 files, 207 passed, 0 failed.
- `npm audit --audit-level=moderate`: 0 vulnerabilities.
- JavaScript syntax checks and default/staging Wrangler dry-runs: passed.
- Post-deploy Staging smoke: skipped; this was not a deployment or live test.
- The initial candidate run exposed an invalid Agent actor fixture in the newly added Cancel race. The fixture was corrected to include the required authenticated identity flags; the exact final candidate above passed.

### Mutation Experiments

Each mutant was created from the exact candidate SHA above, changed one production invariant, ran CI, and its temporary PR was closed without merge.

| Invariant removed | Mutant commit / PR | CI run | Falsifying observation |
|---|---|---:|---|
| Owner task state/version snapshot CAS | `e3c40023f10a70452b0ceea833fb3bea7fc958ff` / #308 (closed) | `45183115644` | The new Cancel race observed Owner commit `CANCELLED v2` instead of the required retry result `CANCELLED v3`; the existing Quarantine race also detected the same stale-snapshot behavior. |
| Owner Outbox publisher lease invalidation | `d516cf03ac4bb030b847e60b7fc09ccc8226be44` / #309 (closed) | `45183136219` | Late Publisher `completeOutbox` returned `completed: true` instead of `LEASE_FENCE_MISMATCH`; persisted lease-generation assertions also failed. |
| Consumer task-version/state fence | `38575e44b5524883b3e60fd858309c032a7d87c8` / #310 (closed) | `45183154896` | Post-Owner stale Consumer receipts returned `recorded: true` instead of `TASK_VERSION_FENCED` in both Cancel and Quarantine interleavings. |

All three mutations were killed by the intended assertions. These are mutation-test failures on deliberately weakened code, not failures of the candidate.

### Secret Scan and Repository Boundary

- Gitleaks PR-diff scan in run `45182926610`: 6 commits scanned; no new leaks found.
- Full reachable history: 4,264 commits scanned; 11 pre-existing `generic-api-key` findings remain unclassified. The scan does not establish whether they are live credentials or false positives. No values or fingerprints were copied into this report.
- Main comparison: `main` is identical to `919b19ca3d3887352cdef06b03c668ead04fbce7` (0 commits ahead/behind).
- PR #307 remains Draft/open/unmerged. Parent PR #300 remains Draft/open/unmerged. Mutation PRs #308–#310 are closed/unmerged.
- No deployment, Cloudflare configuration/secret change, live Worker/Queue operation, or Production action occurred.
