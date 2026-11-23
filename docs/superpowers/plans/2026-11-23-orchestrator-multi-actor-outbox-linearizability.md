# Multi-Actor Outbox Linearizability Implementation Plan

> **For agentic workers:** Use the native execution workflow task-by-task. Keep all work on the isolated feature branch and preserve a fresh verification record for each mutation.

**Goal:** Add deterministic integration evidence for Owner/Agent/Publisher/Consumer interleavings without changing production behavior unless a failing test demonstrates a defect.

**Architecture:** Exercise the existing Durable Object Ledger and SQLite state directly through the established Cloudflare Vitest harness. Gate Owner audit hashing after the task snapshot but before the transaction to force each intended interleaving; inspect persisted task, lease, Outbox, receipt, consumed-assertion, Owner-receipt, and audit rows after the operations.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers Durable Objects, `cloudflare:test`, Vitest 4.1.12, Node.js 22+, GitHub Actions.

**Spec:** `docs/specs/2026-11-23-orchestrator-multi-actor-linearizability-audit.md`

## Global Constraints

- Base the isolated branch on PR #300 head `39719922c7a3b660c007c6efb9797c548f7ddfd5`.
- Do not modify `main`, merge, deploy, run live smoke tests, or touch Cloudflare configuration/secrets.
- Do not invent Validator identity, evidence policy, Scheduler authority, or a lease for `VALIDATING`.
- Keep tests on real Durable Object Ledger and SQLite; use only the narrow deterministic WebCrypto digest gate already used by the neighboring race test.
- Do not emit secret values, tokens, private key material, or secret fingerprints.
- Report skipped checks as skipped, and distinguish test/mutation failures from harness failures.

## Review Focus

1. Stale Owner snapshot after Agent state transition — test exact retry to the latest task version.
2. Publisher ACK after Outbox invalidation — test generation/owner fencing and assertion non-consumption.
3. Consumer receipt after Owner state/version change — test rejection, absence of a receipt row, and assertion consumption.
4. Consumer receipt before Owner commit — test durable historical receipt and replay idempotency.
5. Agent releaseLease during Owner's pre-commit window — test that Owner revokes the resulting generation and stale follow-up release is rejected.

---

### Task 1: Add deterministic multi-actor integration tests

**Files:**
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-multi-actor-linearizability.test.js`
- Exercise: `cloud-engineering-connector/orchestrator-ledger.js` without production edits.

**Interfaces:**
- Uses real Ledger methods: `createTask`, `claimTask`, `transitionTask`, `releaseLease`, `enqueueOutbox`, `claimOutbox`, `completeOutbox`, `recordOutboxReceipt`, `executeOwnerCommand`, and `getTask`.
- Uses operation-scoped assertions and the existing Owner assertion verifier configuration.

- [x] **Step 1: Write the deterministic tests first.**
  - `linearizes Owner Cancel after an Agent transition and fences late Publisher ACK and Consumer receipt`
  - `linearizes Owner Quarantine after Agent releaseLease and rejects a late Consumer receipt`
  - Parameterized `preserves a valid Consumer receipt committed before Owner cancel/quarantine`

- [x] **Step 2: Run the focused Cloudflare Vitest test.**
  - Run in CI: `npx vitest run --config vitest.config.js cloudflare-test/orchestrator-multi-actor-linearizability.test.js`
  - Expected: all new deterministic interleavings pass; any failure is investigated from the exact assertion and persisted state, not papered over.

- [x] **Step 3: Run the complete connector test and check suite.**
  - Run: `npm test` and `npm run check`.
  - Expected: zero test failures, zero syntax failures, successful Wrangler dry-runs; staging smoke remains skipped unless separately authorized.

- [x] **Step 4: Review persisted-state coverage.**
  - Confirm exact Task state/version, execution lease owner/generation/expiry, Outbox status/retry-state/lease fields, receipt cardinality, consumed JTI cardinality, Owner receipt cardinality, and Owner audit cardinality for each interleaving.

### Task 2: Preserve the protocol and audit rationale

**Files:**
- Create: `docs/specs/2026-11-23-orchestrator-multi-actor-linearizability-audit.md`
- Create: `docs/superpowers/plans/2026-11-23-orchestrator-multi-actor-outbox-linearizability.md`

- [x] **Step 1: Record the three interleaving families, expected outcomes, falsification conditions, and evidence rules.**
- [x] **Step 2: Cross-check every documented expected outcome against the exact test assertion and observed CI result.**
- [x] **Step 3: Ensure the documents do not imply production readiness or authorize an unimplemented Validator path.**

### Task 3: Run isolated mutation experiments

**Files:**
- Create temporary mutant branches from the exact candidate commit; do not merge them.
- Mutate only one predicate/side effect per mutant branch.

- [x] **Step 1: Owner stale-snapshot CAS mutant.**
  - Remove the in-transaction task state/version snapshot recheck.
  - Expected: the stale-snapshot linearization test fails because Owner commits from an obsolete version rather than retrying.

- [x] **Step 2: Outbox Publisher fence mutant.**
  - Remove Owner's Outbox publisher lease invalidation (owner clear/generation advance) for pending/in-progress events.
  - Expected: late `completeOutbox` succeeds or the exact persisted lease invariant fails.

- [x] **Step 3: Consumer task-version fence mutant.**
  - Remove the current task version/state rejection in `recordOutboxReceipt`.
  - Expected: a stale post-Owner receipt is incorrectly inserted and the focused test fails.

- [x] **Step 4: Classify each mutation outcome.**
  - Mark killed only when the exact mutant CI failure is attributable to the intended new assertion.
  - Mark harness, syntax, setup, or unrelated failures inconclusive.

### Task 4: Candidate PR and independent verification

- [x] **Step 1: Open a Draft PR targeting the PR #300 feature branch, never `main`.**
- [x] **Step 2: Verify the exact PR head SHA and successful CI run.**
- [x] **Step 3: Verify PR diff secret scan; separately record the unresolved full-history Gitleaks findings without disclosing any values.**
- [x] **Step 4: Verify all candidate and predecessor PRs remain open/Draft/unmerged and `main` SHA has not changed.**
- [ ] **Step 5: Report exact evidence, residual risks, and skipped checks; do not merge or deploy.**
