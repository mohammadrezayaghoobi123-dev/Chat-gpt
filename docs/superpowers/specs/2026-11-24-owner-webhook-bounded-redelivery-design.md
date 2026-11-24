# Owner Webhook Bounded Redelivery Design

## Intent

Allow a GitHub Owner issue-comment delivery that was already authenticated and failed specifically because the Ledger exhausted its bounded Audit-head contention retries to be manually redelivered after the normal five-minute comment freshness window, without making old first-seen comments executable.

## Goals

- Preserve the existing five-minute freshness rule for every first-seen Owner command.
- Authorize only the same GitHub delivery ID, exact raw-body SHA-256, comment ID, canonical command hash, repository, actor, task, operation, and original comment timestamp recorded on a retryable contention failure.
- Bound recovery to three manually initiated redeliveries and a hard 72-hour expiry measured by the Ledger clock.
- Make successful or terminal Owner receipts authoritative: return their stored outcome without replaying state transitions.
- Persist only bounded metadata and hashes; never persist webhook body or comment text.
- Keep retries idempotent under concurrent requests and process restarts.

## Non-goals

- No automatic GitHub redelivery, Scheduler, Durable Object alarm, Queue, cron, or background worker.
- No GitHub App/PAT credentials, webhook-management permissions, Hook ID storage, Cloudflare secret/configuration changes, or external network calls.
- No change to the Owner assertion protocol, Task state machine, Audit schema/hash chain, Ledger retry budget, or release authority.
- No merge, deployment, live Worker/Queue operation, or change to main.

## Approaches

1. Globally extend Owner comment freshness to 72 hours. Rejected: old commands that never reached the Ledger would become executable.
2. Add a retry marker for every webhook before command execution. Rejected: it expands the admission surface and complicates rollback semantics before a transient failure exists.
3. Persist a bounded recovery marker only after verified Owner execution returns AUDIT_CHAIN_CONTENTION. Chosen: first-seen policy remains unchanged; only a previously authenticated and specifically failed delivery may use the narrow recovery path.

## Contract

- The Ledger records a retry marker only after the Owner assertion has been verified and the three-attempt Audit contention loop is exhausted.
- Marker identity includes delivery ID, body digest, comment ID, command hash, repository ID, actor ID, task ID, operation, issue number, and comment creation time.
- Marker lifetime is 72 hours from the first recorded contention failure; subsequent failures do not extend expiry.
- The first failed attempt is not counted as a redelivery. The Ledger grants at most three retry authorizations, atomically incrementing the counter before execution.
- A mismatched identity, expired marker, or exhausted counter is denied.
- A matching Owner receipt is returned as the stored terminal outcome and is never re-executed.
- The Worker continues to require GitHub HMAC authentication, configured Owner identity, valid command parsing, and a fresh Ledger-issued Owner assertion for every execution attempt.
- The normal five-minute freshness window remains mandatory unless the Ledger explicitly authorizes the exact previously failed delivery.

## Atomicity and failure behavior

- Marker creation is a bounded SQLite transaction in the same Durable Object as Owner receipts and delivery claims.
- Successful/terminal receipt persistence and marker closure occur in the existing Owner transaction.
- The Ledger verifies a fresh signed Owner assertion bound to the exact context before authorizing recovery. Retry authorization and retry-count increment occur in one synchronous SQLite transaction.
- No external I/O occurs inside a transaction.
- Missing Ledger capability, storage failure, or malformed marker state fails closed with service unavailability or conflict; it never widens freshness.

## Verification

- RED/GREEN Worker tests: stale first-seen delivery rejected; matching recorded retry admitted; changed body/comment/task/operation denied; completed receipt returned without invoking Owner execution.
- RED/GREEN Durable Object tests: real N-way contention creates exactly one marker for the exhausted delivery; exact identity gets three authorizations; fourth is denied; 72-hour boundary enforced; mismatched identity is denied; successful retry closes marker and yields one Task transition, JTI, Delivery, Receipt, and Audit event.
- Mutation: remove identity comparisons, retry-cap check, or marker closure and confirm a targeted test fails.
- Full Node and Durable Object suites, syntax checks, npm audit, Wrangler Production/Staging dry-runs, and PR-diff secret scan must be checked on the exact candidate head.
- No staging smoke or live deployment is part of this change.
