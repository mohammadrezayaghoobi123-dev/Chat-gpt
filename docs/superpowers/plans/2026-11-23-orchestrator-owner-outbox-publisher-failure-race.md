# Owner Outbox Publisher Failure Race Implementation Plan

> **For agentic workers:** Use the native execution workflow task-by-task. Keep implementation and mutants isolated; do not merge or deploy.

**Goal:** Prove that Owner Cancel/Quarantine fences both success and failure callbacks from an Outbox Publisher whose Queue send was already in flight.

**Architecture:** Run the real Worker publisher and Consumer against the real Durable Object Ledger. A deterministic Queue gate holds the send after recording the message; the Owner commits before the gate is released. Exercise four histories and inspect durable SQLite state, including assertion-consumption records.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers, Durable Objects, SQLite, `cloudflare:test`, Vitest, Node.js 22+.

**Spec:** `docs/specs/2026-11-23-orchestrator-owner-outbox-publisher-failure-race.md`

## Global Constraints

- Base: PR #307 final head `733f953e425c53a5e4d23a73c9875fade72b5ac4`.
- Base branch: `security/orchestrator-multi-actor-outbox-linearizability-2026-11-23`.
- No `main` writes, merge, deployment, live smoke, Cloudflare config/secrets, or Production actions.
- English only for source, identifiers, comments, docs, test names, and commit metadata.
- No new Validator/Scheduler authority or `VALIDATING` transition.
- Use real Ledger, Worker, assertion verification, and SQLite. The Queue gate is the only deterministic external transport fixture.
- Report exact-head evidence only; skipped staging smoke is not a pass.

## Review Focus

1. Queue send succeeds after Owner commit — late `completeOutbox` must remain fenced.
2. Queue accepted the message but its acknowledgement is lost after Owner commit — late `failOutbox` must not schedule retry.
3. Consumer receives the old Queue message after Owner commit — deterministic stale event must be acknowledged without receipt persistence.
4. Original Publisher lease duration expires — dead-lettered event must remain unclaimable.
5. A stale callback must be rejected before its assertion JTI is consumed.

---

### Task 1: Add deterministic end-to-end integration tests

**Files:**
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-owner-outbox-publisher-failure-race.test.js`
- Exercise without production edits: `cloud-engineering-connector/worker.js`, `cloud-engineering-connector/orchestrator-ledger.js`

**Interfaces:**
- Worker functions: `processOrchestratorOutbox(env, { maxEvents })` and `consumeOrchestratorOutbox(batch, env)`.
- Ledger functions exercised through the real Durable Object binding: `createTask`, `enqueueOutbox`, `executeOwnerCommand`, `getTask`, and `claimOutbox`.
- Operation assertions use the configured test-only key binding and real verification/consumption.

- [x] **Step 1: Write the four failing/passing histories as table-driven tests.**
  - Cancel × Queue success.
  - Cancel × accepted-send/ack-loss.
  - Quarantine × Queue success.
  - Quarantine × accepted-send/ack-loss.

- [x] **Step 2: Run the focused Cloudflare Vitest file.**
  - Command: `npx vitest run --config vitest.config.js cloudflare-test/orchestrator-owner-outbox-publisher-failure-race.test.js`
  - Expected: four histories pass; task remains Owner-terminal, Outbox stays DEAD_LETTER, late callback JTI is not consumed, and Consumer acknowledges stale delivery without storing a receipt.

- [x] **Step 3: Review all persisted state.**
  - Assert task state/version, Outbox status/attempts/retry state/lease owner/generation/expiry/last error/dead-letter timestamp, Consumer receipt count, Owner receipt/audit counts, and assertion JTI counts.
  - Advance logical time beyond the original Publisher lease and prove the event remains unclaimable.

### Task 2: Record the protocol and evidence

**Files:**
- Create: `docs/specs/2026-11-23-orchestrator-owner-outbox-publisher-failure-race.md`
- Create: `docs/superpowers/plans/2026-11-23-orchestrator-owner-outbox-publisher-failure-race.md`

- [x] **Step 1: Define the four histories, invariants, mutations, and scope boundaries.**
- [x] **Step 2: Verify that every written expectation maps to an executable assertion.**

### Task 3: Run isolated mutation experiments

Each mutant must start from the exact code-tested candidate and change one invariant only.

- [x] **Step 1: Owner Outbox invalidation mutant.**
  - Remove Owner's Outbox dead-letter/lease-revocation update.
  - Expected: a late send-failure callback schedules/reopens a retry; the test fails on persisted state or late reclaim.

- [x] **Step 2: Publisher `failOutbox` lease-fence mutant.**
  - Remove only the pre-consumption owner/generation/expiry fence from `failOutbox`.
  - Expected: the stale failure callback consumes its JTI; the assertion-count check fails.

- [x] **Step 3: Publisher `completeOutbox` lease-fence mutant.**
  - Remove only the pre-consumption owner/generation/expiry fence from `completeOutbox`.
  - Expected: the stale callback is treated as completed and/or consumes its JTI; the test fails.

- [x] **Step 4: Classify each result.**
  - Killed only when the exact intended assertion fails on the exact mutant CI run.
  - Harness, setup, syntax, or unrelated failures are inconclusive.

### Task 4: Candidate PR and final verification

- [x] **Step 1: Open a Draft PR targeting `security/orchestrator-multi-actor-outbox-linearizability-2026-11-23`, not `main`.**
- [x] **Step 2: Verify full CI on the exact final PR head.**
- [x] **Step 3: Verify Gitleaks PR diff and record full-history findings without disclosing secret values/fingerprints.**
- [x] **Step 4: Verify PR #307 and predecessor PR #300 remain Draft/open/unmerged and main SHA is unchanged.**
- [ ] **Step 5: Report exact evidence and residual risks; do not merge or deploy.**


## Completed Execution Evidence

Candidate code head `a177c4f40f3ca90684e0bfc66a2291418e12a0b5` passed CI run `45186365668`: 416/416 Node tests, 211/211 Durable Object/Vitest tests across 13 files, 0 npm audit vulnerabilities, syntax checks, and both Wrangler dry-runs. All four deterministic histories passed. Three isolated mutants were killed: Owner Outbox invalidation (#313, run `45186554481`), `failOutbox` lease fence (#314, run `45186576125`), and `completeOutbox` lease fence (#315, run `45186595358`). Temporary mutation PRs are closed unmerged. Gitleaks diff scan `45186365624` was clean; full history still reports 11 unclassified historical findings. Main is unchanged. No deployment, merge, or Production action occurred.
