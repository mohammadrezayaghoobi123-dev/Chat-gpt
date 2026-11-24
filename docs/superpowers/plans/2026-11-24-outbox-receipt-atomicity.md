# Outbox Receipt-Gated Completion Implementation Plan

> For agentic workers: Use the host's available task-by-task workflow. Steps use checkbox syntax for tracking.

**Goal:** Make a verified, generation-fenced downstream receipt the atomic commit condition for completing a Durable Object Outbox event.

**Architecture:** Keep the Durable Object SQLite ledger authoritative. The authenticated consumer records an exact receipt and completes the Outbox row in one transactionSync transaction; stable event IDs make retries safe only when the downstream provider supports idempotency.

**Tech Stack:** JavaScript ES modules, Cloudflare Durable Objects SQLite storage, cloudflare:test, Vitest 4, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-11-24-outbox-receipt-atomicity-design.md

## Global Constraints

- Work only on test/outbox-receipt-atomicity-2026-11-24, based on PR #457 head 5dc4d02a9ed7feefd9a202273faf3e39e7068246.
- Do not change main, merge, deploy, provision Cloudflare resources, or change secrets/configuration.
- Keep all code, identifiers, comments, documentation, test names, and commit messages in English.
- Preserve tenant/project, source-event identity, Task-version, assertion-JTI, and Lease-generation fencing.
- Schema v10 adds receipt lease_generation additively; legacy rows default to 0 and cannot satisfy new receipt-gated completion.
- Treat delivery as at-least-once. Do not claim exactly-once network delivery.
- Tests use only test-scoped fake external sinks; no real network destination is called.

## Review Focus

- Completion without a receipt must fail closed.
- A receipt for an expired or superseded Lease generation must not settle the event.
- Receipt insertion and Outbox completion must roll back together if SQLite aborts.
- Replayed receipts must not create another receipt row or change a conflicting event.
- External idempotency and non-idempotency must produce distinguishable test outcomes.

---

### Task 1: Require a durable receipt before Outbox completion

**Files:**
- Modify: cloud-engineering-connector/orchestrator-ledger.js
- Modify: cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-tenant-fencing.test.js
- Test: cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js

**Interfaces:**
- Consumes: OrchestratorLedger.completeOutbox({ eventId, workerId, workerAssertion, leaseGeneration, now })
- Produces: { completed: false, reason: OUTBOX_RECEIPT_REQUIRED } when no receipt exists; idempotent completion replay only when a matching receipt is persisted.

- [ ] Step 1: Add the failing test
  - Create a valid Task and IN_PROGRESS Outbox event with generation 1.
  - Call completeOutbox with a valid publisher assertion and no receipt.
  - Assert completed: false, reason OUTBOX_RECEIPT_REQUIRED, and persisted status remains IN_PROGRESS.
- [ ] Step 2: Verify the relevant failure
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js
  - Expected: the new assertion fails because current code completes without a receipt.
- [ ] Step 3: Implement the minimum behavior
  - Check the receipt row inside the existing completion transaction after Lease fencing and assertion verification.
  - Reject completion without a receipt; preserve the current generation and status.
  - Permit completed replay only when the receipt exists for the same event.
- [ ] Step 4: Verify the focused pass
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js
  - Expected: all assertions in the focused test pass.
- [ ] Step 5: Verify the affected integration test
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-tenant-fencing.test.js
  - Expected: stale generation remains rejected; no-receipt completion is rejected; receipt-backed completion passes.

### Task 2: Atomically record receipt and complete the event

**Files:**
- Modify: cloud-engineering-connector/orchestrator-ledger.js
- Modify: cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-receipt-scope.test.js
- Test: cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js

**Interfaces:**
- Consumes: recordOutboxReceipt({ eventId, eventType, idempotencyKey, taskId, payload, createdAt, schemaVersion, envelopeSha256, consumerId, workerAssertion, leaseGeneration, now })
- Produces: { recorded: true, completed: true, eventId, leaseGeneration }, { recorded: false, replay: true, eventId }, or an explicit lease/source/conflict rejection.

- [ ] Step 1: Add the failing tests
  - Assert a fresh receipt is rejected for a stale generation and for an expired Lease.
  - Assert the accepted receipt row stores the exact active generation; a conflicting event fingerprint is rejected.
  - Assert a valid receipt insert changes status to COMPLETED and clears publisher lease ownership.
  - Install a SQLite trigger that aborts receipt insertion; assert both receipt and completion roll back.
  - Evict/reconstruct the object and verify event state persists.
  - Retry with a valid consumer assertion and assert the same event can settle once.
- [ ] Step 2: Verify the relevant failures
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js
  - Expected: generation fencing, atomic completion, and rollback assertions fail against current behavior.
- [ ] Step 3: Implement the minimum behavior
  - Add and validate the required leaseGeneration argument.
  - Read source status, generation, and lease deadline in the same transaction.
  - Keep receipt replay/conflict checks before current-generation checks.
  - For a new receipt, require IN_PROGRESS, exact generation, and unexpired lease.
  - Insert the receipt, update the Outbox event to COMPLETED, clear lease owner/deadline, and verify the persisted row inside one transaction.
- [ ] Step 4: Verify the focused pass
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js
  - Expected: all failure-window, replay, generation, and eviction assertions pass.
- [ ] Step 5: Verify the affected receipt-scope test
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-receipt-scope.test.js
  - Expected: cross-tenant Task-version mismatch remains blocked and no receipt is written.

### Task 3: Prove provider idempotency and duplicate-effect boundary

**Files:**
- Modify: cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js

**Interfaces:**
- Consumes: the real Durable Object Outbox/receipt methods and isolated test-only provider sinks.
- Produces: observable side-effect counts for idempotent and non-idempotent destinations using the same stable event ID.

- [ ] Step 1: Add the failing tests
  - Simulate provider acceptance before forced receipt SQL failure.
  - Reclaim after Lease expiry and resend the same event ID.
  - Assert an idempotent sink records one effect, while a non-idempotent sink records two.
- [ ] Step 2: Verify the relevant failure
  - Run: npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js
  - Expected: the new atomic receipt and generation assertions fail before implementation.
- [ ] Step 3: Refactor only if needed
  - Keep the fake sink outside production code and use no network calls.
  - Do not add a provider abstraction to production merely for test convenience.
- [ ] Step 4: Verify the focused pass
  - Run the same focused command.
  - Expected: one effect for the idempotent sink; two effects for the non-idempotent sink; one durable receipt for the event.

### Final verification gate

- Run: npm test
  - Expected: all Node and Workers Vitest tests pass.
- Run: npm run check
  - Expected: syntax validation and Wrangler default/staging dry-runs pass; no deployment occurs.
- Run: npm audit --audit-level=moderate
  - Expected: no reported vulnerabilities.
- Run a PR-diff secret scan and inspect the exact PR head plus CI logs.
- Perform a destructive mutation that removes the receipt gate; the new no-receipt test must fail. Keep the mutation unmerged and separate from the deliverable branch.
- Record limitations: no real Queue producer/consumer or HTTPS destination is added in this increment; production delivery remains UNKNOWN.
