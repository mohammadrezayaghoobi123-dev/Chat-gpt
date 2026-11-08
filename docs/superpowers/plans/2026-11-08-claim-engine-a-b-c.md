# Claim Engine A+B+C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a lossless, bounded, concurrency-safe task-claim engine combining a transactional candidate index, query/index optimization, bounded keyset fallback, and authenticated task-specific reconciliation.

**Architecture:** The Durable Object's authoritative task and lease tables remain the source of truth. A derived candidate table is synchronized transactionally with every eligibility-changing mutation; optimized indexed lookup is primary, and a bounded resumable keyset scan is the controlled fallback. Reconciliation uses signed task/generation-bound evidence and remains fail-closed until a trusted producer and runtime call path are proven.

**Tech Stack:** Cloudflare Durable Objects SQLite, JavaScript ES modules, Node.js >=22, Vitest, `@cloudflare/vitest-plugin`, Wrangler.

**Spec:** `docs/superpowers/specs/2026-11-08-claim-engine-a-b-c-design.md`

## Global Constraints

- Keep `main`, Production, Cloudflare bindings, and Secrets unchanged.
- Work only on an isolated branch rooted at the reviewed PR #190 head unless a newer, verified dependency SHA requires a deliberate rebase.
- Preserve Durable Object `transactionSync` boundaries for task, lease, candidate, and evidence-consumption writes.
- Preserve deterministic `(created_at, task_id)` ordering and executor isolation.
- Never infer bounded internal work from SQL `LIMIT` alone.
- Fail closed for missing, forged, expired, replayed, wrong-task, wrong-generation, or unauthorized reconciliation evidence.
- Do not add dependencies without a demonstrated need.
- Every behavior change follows RED → GREEN → REFACTOR; verify the targeted test fails for the intended reason before production code is written.
- Do not merge, deploy, mutate secrets/bindings, or change `main`.

## Review Focus

- Equal `created_at` values across many tasks: stable tie-break by `task_id`; test in candidate ordering and cursor continuation.
- Candidate index drift after owner-command transitions or lease release: compare derived candidates to authoritative eligibility after each mutation.
- Expired leases with repeated generation values across tasks: evidence must bind both task and generation; test cross-task substitution.
- Candidate churn while a cursor is in use: keyset continuation must neither skip nor duplicate eligible work; test insertion, release, and claim between batches.
- Runtime has no verified reconciliation evidence producer: ensure expired-lease reclaim remains fail-closed and no untrusted request path can mint evidence.

---

## File Structure

**Existing files to modify**
- `cloud-engineering-connector/orchestrator-ledger.js`: schema bootstrap/backfill, candidate synchronization, claim query, batch fallback, mutation-path consistency, and atomic evidence consumption.
- `cloud-engineering-connector/orchestrator-worker-identity.js` only if the reviewed evidence design can safely reuse its key loading and MAC verification primitives without weakening worker assertion validation.
- `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`: Durable Object schema, invariants, mutation-path, concurrency, query behavior, fallback, and regression tests.
- `cloud-engineering-connector/package.json`: update `check` or test scripts only if new modules/tests require explicit inclusion.

**New file, only if separation is warranted by implementation review**
- `cloud-engineering-connector/orchestrator-reconciliation-evidence.js`: narrow, independently testable signer/verifier for task- and generation-bound evidence. It must reuse the existing configured key set and Web Crypto primitives; do not duplicate key parsing or introduce a parallel secret source.

**Runtime integration**
- First locate every real `claimTask` caller and every producer of reconciliation evidence across the repository. Modify only the proven call site(s), and name the exact file(s) in the execution log before changing them. If no trusted producer exists, do not invent one: keep the reclaim path fail-closed and report the missing integration as a release blocker.

## Task 1: Define Candidate Eligibility and Invariant Tests

**Files:**
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`
- Modify: `cloud-engineering-connector/orchestrator-ledger.js` only after RED is observed

**Interfaces:**
- Define one internal eligibility predicate from authoritative task state, executor assignment, and lease state. Candidate rows must not encode a second, divergent business rule.
- Test helper: `assertCandidateIndexConsistent(ledger)` compares the candidate relation with the authoritative predicate.

- [ ] **Step 1: Write failing tests**
  - `initializes_candidate_index_and_backfills_existing_eligible_tasks`: create legacy tasks before candidate schema bootstrap where the fixture permits it; after bootstrap, candidate rows equal the expected eligible set.
  - `candidate_index_excludes_terminal_unassigned_and_active_leased_tasks`: assert only eligible tasks appear.
  - `candidate_order_is_stable_for_equal_created_at`: assert `task_id` tie-break ordering.
- [ ] **Step 2: Run the focused Vitest file and confirm the expected missing-table/invariant failures**
  - Run: `npm run test:do -- cloudflare-test/orchestrator-ledger.test.js`
  - Expected: FAIL on the new assertions, not test syntax or fixture setup.
- [ ] **Step 3: Define the canonical eligibility predicate and candidate schema in `ensureSchema()`**
  - Add a candidate table keyed by `task_id`, with indexed executor/order columns `(executor_id, created_at, task_id)`.
  - Add an idempotent backfill from authoritative task and lease tables.
  - Ensure initialization is safe on existing Durable Objects and repeatable after restart.
- [ ] **Step 4: Run the focused tests and candidate invariant helper**
  - Expected: PASS; candidate set exactly equals the authoritative eligibility set.
- [ ] **Step 5: Commit**
  - `feat(ledger): add transactional claim candidate index`

## Task 2: Transactional Synchronization Across Every Mutation Path

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`

**Interfaces:**
- Internal helper: `syncClaimCandidateInTransaction(sql, taskId, now)` reads current task and lease state and inserts, updates, or deletes exactly one derived candidate row.
- Internal helper: `assertClaimCandidateInvariantInTransaction(sql, taskId)` is used by tests/debug assertions, not as an unbounded production scan.

- [ ] **Step 1: Write failing tests for candidate consistency after** `createTask`, `transitionTask`, `claimTask`, `releaseLease`, and `executeOwnerCommand`.
- [ ] **Step 2: Run each new test and confirm it fails on the expected stale/missing candidate row.**
- [ ] **Step 3: Add candidate synchronization inside each existing `transactionSync` block after the authoritative task/lease write and before transaction return.**
  - Audit every SQL mutation to `orchestrator_tasks` and `orchestrator_execution_leases`, not only the named public methods.
  - Include Owner Command sub-operations and lease release/reassignment.
  - Explicitly prove whether `renewLease` and `advanceAgentRound` affect eligibility; synchronize if and only if the canonical predicate depends on their fields.
  - On persistence mismatch, throw so the entire Durable Object transaction rolls back.
- [ ] **Step 4: Run targeted tests and assert the invariant after each operation and replay path.**
- [ ] **Step 5: Commit**
  - `fix(ledger): keep claim candidates atomic with task and lease state`

## Task 3: Query and Index Optimization (B)

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`

**Interfaces:**
- Candidate query consumes `workerId`, `now`, and an optional continuation cursor; returns at most the configured candidate window and stable ordering.
- Keep explicit `taskId` lookup separate from scheduler candidate discovery.

- [ ] **Step 1: Add failing tests** for executor filtering before limit, stable ordering, all-active-leased queues, expired leases, and exact explicit-`taskId` outcomes.
- [ ] **Step 2: Verify RED** with the focused Durable Object tests.
- [ ] **Step 3: Replace task JSON expression scans in the scheduler hot path with the candidate index lookup.**
  - Use the indexed executor/order columns.
  - Re-check authoritative task and lease state before claim in the same transaction.
  - Preserve the existing response reason precedence: `RECONCILIATION_REQUIRED`, `ASSIGNEE_MISMATCH`, `NO_TASK_AVAILABLE`.
- [ ] **Step 4: Add query-plan assertions/diagnostics for representative dense fixtures.**
  - Verify intended index use with `EXPLAIN QUERY PLAN`.
  - Record a defensible internal-work metric; do not label `LIMIT 1` as bounded scan proof.
  - Compare baseline and candidate-index query behavior on sparse, dense, and all-leased queues.
- [ ] **Step 5: Run focused tests and confirm query-plan expectations.**
- [ ] **Step 6: Commit**
  - `perf(ledger): use indexed claim candidate lookup`

## Task 4: Bounded Keyset Fallback (C)

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`

**Interfaces:**
- Internal result shape: `{ candidates, nextCursor, exhausted, budgetExhausted }`.
- Cursor: opaque validated tuple `(createdAt, taskId)`, scoped to the executor and query version.
- Define one explicit maximum number of candidate rows examined per invocation; select the value from measured tests and document it as a named constant.

- [ ] **Step 1: Write failing tests** for multi-batch continuation, equal timestamps, retrying the same cursor, budget exhaustion, and concurrent candidate insert/remove between batches.
- [ ] **Step 2: Verify RED** and ensure failures demonstrate skipped/duplicated work or missing cursor behavior.
- [ ] **Step 3: Implement bounded keyset pagination using tuple ordering, never OFFSET pagination.**
  - Cursor advances only past candidates conclusively examined.
  - Unprocessed candidates remain reachable on the next invocation.
  - Fallback revalidates authoritative state before mutation.
- [ ] **Step 4: Run targeted tests and assert no skips or duplicates across repeated batches.**
- [ ] **Step 5: Commit**
  - `feat(ledger): add bounded resumable claim fallback`

## Task 5: Cryptographically Bound Reconciliation Evidence

**Files:**
- Create if needed: `cloud-engineering-connector/orchestrator-reconciliation-evidence.js`
- Modify: `cloud-engineering-connector/orchestrator-worker-identity.js` only for safe shared primitives
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`

**Interfaces:**
- Evidence claims bind `taskId`, `priorGeneration`, `jti`, `issuer`, `operation`, `issuedAt`, and `expiresAt`.
- Verifier input includes configured key set, evidence token, expected task, expected prior generation, expected authorized issuer/operation, and current time.
- Evidence JTI consumption and lease generation increment occur in the same `transactionSync`.

- [ ] **Step 1: Write failing tests** for valid evidence, missing signature, tampering, expired evidence, replay, unauthorized issuer, wrong task, wrong generation, and cross-task evidence substitution where generation numbers coincide.
- [ ] **Step 2: Verify RED** on the existing caller-supplied `checked/evidenceRef` contract.
- [ ] **Step 3: Implement a narrow signed-evidence verifier using the existing configured key source and Web Crypto HMAC; do not create a new secret source or accept evidence claims from user-controlled request data.**
- [ ] **Step 4: Add durable one-time JTI consumption and bind evidence to the exact lease row being reclaimed.**
- [ ] **Step 5: Trace the real reconciliation evidence producer and `claimTask` caller. Wire only a verified authorized producer. If none exists, keep reclaim fail-closed and do not create a synthetic production principal.**
- [ ] **Step 6: Run all evidence tests, including replay and transaction rollback cases.**
- [ ] **Step 7: Commit**
  - `fix(security): bind lease reconciliation evidence to task generation`

## Task 6: Full Invariant, Concurrency, and Stress Verification

**Files:**
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`
- Modify: relevant test helpers only if required

- [ ] **Step 1: Add stress fixtures** for at least 30,000 tasks across multiple executors, dense active leases, sparse candidates, expired leases, and equal timestamps.
- [ ] **Step 2: Add concurrency tests** with multiple workers claiming across multiple tasks; assert no duplicate task/generation lease and no stale-fence success.
- [ ] **Step 3: Add mutation interleaving tests**: create, claim, release, transition, owner command, and fallback continuation.
- [ ] **Step 4: Verify query plans and bounded batch work against documented thresholds.**
- [ ] **Step 5: Run targeted test suite**
  - Run: `npm run test:do -- cloudflare-test/orchestrator-ledger.test.js`
  - Expected: PASS with zero skipped assertions and no unhandled warnings.
- [ ] **Step 6: Run full project suite**
  - Run: `npm test`
  - Expected: Node tests and all Durable Object Vitest tests pass.
- [ ] **Step 7: Run static/build checks**
  - Run: `npm run check`
  - Expected: syntax checks and Wrangler dry-runs complete with exit code 0.
- [ ] **Step 8: Commit**
  - `test(ledger): stress candidate consistency and bounded claims`

## Task 7: Branch-Level Review and Release Gate

**Files:** no production files unless review discovers a defect; fixes must return through the relevant TDD task.

- [ ] **Step 1: Re-read the approved design and this plan; map every acceptance criterion to a test or inspectable artifact.**
- [ ] **Step 2: Compare the implementation branch against its exact parent SHA; inspect every changed line and every task/lease SQL mutation.**
- [ ] **Step 3: Re-run full tests and checks on the final exact SHA.**
- [ ] **Step 4: Verify no changes to `main`, Cloudflare production/staging, bindings, or secrets.**
- [ ] **Step 5: Report evidence, unresolved limitations, and GO/NO-GO.**
- [ ] **Step 6: Keep the branch unmerged and deployment-free pending independent review and separate authorization.**

## Execution Stop Conditions

Stop without proceeding to later tasks if:
- The current PR #190 head or dependency branch has changed and the intended base is ambiguous.
- A mutation path cannot be included in the same Durable Object transaction.
- Candidate-index consistency cannot be maintained under a supported operation.
- The fallback cannot prove lossless cursor advancement.
- No trusted reconciliation evidence producer exists; in that case only the evidence-free-safe behavior may be implemented, and production reclaim remains NO-GO.
- Any test failure is unexplained or a security invariant is weakened.
