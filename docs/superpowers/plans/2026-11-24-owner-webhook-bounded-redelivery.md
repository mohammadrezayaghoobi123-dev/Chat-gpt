# Owner Webhook Bounded Redelivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit at most three exact-match manual redeliveries of an Owner webhook previously rejected only by bounded Audit-chain contention, without relaxing first-seen freshness.

**Architecture:** The Orchestrator Ledger owns a SQLite retry-marker table and the recovery decision. The Worker computes the signed event identity, asks the Ledger for an atomic bounded authorization, preserves the five-minute rule when no marker exists, and returns stored terminal receipts without re-execution.

**Tech Stack:** Cloudflare Workers, SQLite-backed Durable Objects, Vitest, GitHub webhook HMAC, existing Owner assertion protocol.

**Spec:** `docs/superpowers/specs/2026-11-24-owner-webhook-bounded-redelivery-design.md`

## Global Constraints

- Base commit: `7cc00d7cb77bda1c108f5d5f92a5a360ef7d8afd` (PR #408 head).
- Never modify `main`, merge, deploy, or change Cloudflare secrets/configuration.
- No new credential, GitHub API redelivery client, Alarm, Queue, Scheduler, or background retry worker.
- Keep the normal first-seen Owner freshness limit at 300,000 ms by default.
- Ledger clock is authoritative; client-supplied timestamps never grant recovery.
- Retry cap is exactly three manual redeliveries; TTL is exactly 259,200,000 ms.
- No raw webhook body, comment body, assertion, or secret is persisted in the retry table.

## Review Focus

- Old first-seen comment with no marker: remains 422 and causes no Ledger command execution.
- Same delivery ID with modified body/comment/command context: rejected as conflict.
- Expired marker at the exact 72-hour boundary: denied.
- Fourth retry after three grants: denied without counter increment.
- Successful/terminal receipt: replay returns stored result and performs no additional state transition.

---

### Task 1: Persist and authorize bounded retry markers

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js`

**Interfaces:**
- Add RPC `authorizeOwnerWebhookRetry(input)`.
- Input: `{ deliveryId, bodySha256, commentId, commandHash, repositoryId, actorId, taskId, operation, commentCreatedAt }`.
- Result: one of `{ registered: false }`, `{ registered: true, retryAuthorized: true, retryCount }`, `{ registered: true, completed: true, result }`, or `{ registered: true, denied: true, reason }`.
- Create markers privately inside `executeOwnerCommand` only after final `AUDIT_CHAIN_CONTENTION`.
- Close matching markers in the same transaction that persists a terminal Owner receipt.

- [ ] Write a real Durable Object contention test using four concurrent distinct Owner commands and three controlled shared-Audit-head waves; assert one final contention result and one durable marker.
- [ ] Run the focused test and observe failure for the missing retry-marker/authorization behavior.
- [ ] Implement the SQLite schema, atomic marker creation, identity-bound authorizer, three-retry cap, 72-hour expiry, and receipt closure.
- [ ] Verify the identical focused test passes.
- [ ] Add and run boundary tests for body/context mismatch, three successful authorizations, fourth denial, expiry, and completed receipt replay.

### Task 2: Apply Ledger authorization at the Worker boundary

**Files:**
- Modify: `cloud-engineering-connector/worker.js`
- Test: `cloud-engineering-connector/cloudflare-test/github-webhook-worker.test.js`

**Interfaces:**
- Worker calls `authorizeOwnerWebhookRetry` with verified delivery/body/comment/command identity.
- A matching completed receipt returns its stored terminal outcome without calling `executeOwnerCommand`.
- A registered retry marker authorizes only while valid and below the cap.
- An absent marker leaves the five-minute freshness check unchanged.
- A stale first-seen delivery remains 422; a matching retry can proceed with a newly minted Owner assertion.

- [ ] Add tests for stale first-seen rejection, exact retry admission, mismatch denial, and completed-result replay.
- [ ] Run focused tests and observe failure for the intended behavior.
- [ ] Implement the minimum Worker changes and preserve all existing status mappings.
- [ ] Re-run focused tests and verify first-seen freshness remains unchanged.

### Task 3: Adversarial verification

**Files:**
- Existing affected tests only; no additional production surface.

- [ ] Run the full Node test suite.
- [ ] Run the full Durable Object/Vitest suite.
- [ ] Run all repository syntax checks and Wrangler dry-runs.
- [ ] Run npm audit and PR-diff secret scanning.
- [ ] Perform targeted mutations for marker identity, retry-cap enforcement, expiry, and terminal receipt closure; confirm each mutation is detected.
- [ ] Verify the final branch head, base SHA, open Draft PR, CI runs, and unchanged main SHA.
- [ ] Record that no independent reviewer, staging smoke, or live deployment was performed if unavailable/not authorized.
