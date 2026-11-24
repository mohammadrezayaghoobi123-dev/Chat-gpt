# Scheduler Durable Recovery Design

**Status:** Implemented in Draft PR #426; production activation is not authorized by this design  
**Date:** 2026-11-24  
**Scope:** Cron-driven, tenant-authorized Task admission through Cloudflare Workflows, TenantDirectory, and OrchestratorLedger

## 1. Problem statement

The prior scheduler intake ran admission inline inside the Cron handler. It could reserve a Directory Grant and then fail before Ledger persistence. Recovery depended on an external replay of the same scheduled event, and the fixed 300-second Grant expiry created an additional recovery boundary. A committed Ledger Task whose RPC response was lost also needed a way to be recognized before attempting to use an expired Grant.

## 2. Decision

Use Cloudflare's native Cron-scheduled Workflow mechanism. Cron schedules are configured directly on the Workflow export. Each scheduled occurrence creates a Workflow instance, and the instance receives authoritative `event.schedule.cron` and numeric `event.schedule.scheduledTime` metadata.

The Worker does not implement a second `scheduled()` handoff or call `WorkflowBinding.create()`. Production configuration deliberately omits actual `schedules` until a separate activation approval exists.

## 3. Trust boundaries

- Platform schedule metadata is the source of Cron identity and scheduled time.
- The configured Scheduler policy is an explicit configuration input, not user-provided task authority.
- TenantDirectory remains the membership/policy decision and Grant issuer.
- The Ed25519 Task Admission Grant is the authorization capability bound to the exact Task input.
- The Scheduler worker assertion identifies the dedicated scheduler principal to Ledger; it is not a substitute for the Directory Grant.
- OrchestratorLedger remains the independent Grant verifier and the Task/Receipt/Outbox commit authority.
- The public Worker and its DO namespaces remain owned by `chat-gpt111`; the scheduler binds remotely to that same script using `script_name`.

## 4. Data and execution flow

1. Cloudflare creates a Workflow instance for the configured Cron occurrence.
2. `WorkflowEvent.schedule` supplies `cron` and `scheduledTime`.
3. Durable step `prepare-scheduled-admission` validates metadata, selects the exact policy, validates the entire batch (1..20 Tasks), normalizes Task shapes, computes deterministic Task/idempotency identities and digests, and resolves the required Directory/Ledger namespaces before any Directory reservation.
4. For each Task, a separate durable step:
   a. probes Ledger for an exact admission receipt;
   b. returns replay if Task and Receipt are already committed and match all requested scope/digest fields;
   c. otherwise prepares or renews the Directory Grant;
   d. creates a fresh worker assertion immediately before Ledger RPC;
   e. asks Ledger to atomically commit Task, receipt, Outbox, and associated indexes.
5. Workflow completion returns only safe Task identifiers, admission IDs, and created/replayed outcomes.

## 5. Deterministic identity

For the exact Cron expression and scheduled millisecond value:

- `taskId = taskIdPrefix + "-" + scheduledTime`
- `idempotencyKey = idempotencyPrefix + ":" + scheduledTime + ":" + taskId`
- Task timestamps and schedule metadata are derived from the original scheduled time.
- Task digest and input hash include canonical normalized Task state and the principal/tenant/project/schedule identity.

A repeated execution of the same Cron occurrence therefore addresses the same Task identity. Ledger receipt probing is always before Directory Grant preparation.

## 6. Grant renewal protocol

A reservation is eligible for renewal only after `old.expiresAt + 5 seconds`. Its original membership and exact policy snapshot must remain active and unchanged. The replacement Grant is signed before entering the synchronous transaction. The transaction re-reads the reservation, uses the previous admission ID/JTI as a CAS fence, re-reads the authorization snapshot, updates the reservation, and appends an audit event atomically.

Membership/policy drift is a permanent denial; no silent reauthorization under a new snapshot is allowed. Concurrent renewals converge on one replacement Grant/JTI. Failure to append the audit event rolls back the reservation replacement.

## 7. Transaction model

There is intentionally no cross-DO distributed transaction:

- Directory reservation + Directory audit event: one synchronous Directory transaction.
- Ledger Task + admission receipt + Outbox event + consumed worker JTI + claim-candidate index: one synchronous Ledger transaction.
- Batch execution: sequential per-task Workflow steps, not all-or-nothing.

The outcome is idempotent at the persistent state boundary, not exactly-once network delivery. If an earlier Task step committed and a later one permanently fails, earlier Task state remains committed and the Workflow reports failure.

## 8. Retry and error policy

Each Workflow step is bounded to six retries with exponential backoff beginning at ten seconds and a two-minute per-attempt timeout. Permanent configuration, malformed schedule metadata, invalid policy, authorization denial, membership/policy drift, idempotency conflict, and receipt integrity errors map to `NonRetryableError`. Transport and service-availability failures remain retryable within the finite budget.

There is one preflight step plus at most twenty Task steps (21 total). The bounded retry budget prevents unbounded hot loops. It does not guarantee eventual completion if the transient failure outlasts the retry budget; a failed instance requires operationally controlled replay/restart after root-cause review.

## 9. Falsification matrix

| Claim | Counterexample / attack | Required invariant |
|---|---|---|
| Same Cron occurrence does not duplicate Task | Repeat same `cron` + `scheduledTime` after success | One Task, one Receipt, one Outbox event; replay outcome |
| Lost Ledger response is recoverable | Commit Task, drop RPC response, expire Directory Grant, retry | Receipt probe returns admitted before Directory call |
| Grant renewal preserves authority | Revoke membership or alter policy before renewal | Renewal denied; old reservation unchanged |
| Renewal is single-winner | Concurrent calls race after expiration | One fresh admission ID/JTI and one audit event |
| Audit and Grant replacement are atomic | Abort audit insert | Reservation remains on previous Grant |
| Workflow payload/metadata cannot be spoofed | Remove Cron metadata or tamper with snapshot digest | NonRetryable failure before Task write |
| Batch does not claim atomic rollback | Task 1 commits, Task 2 denied | Task 1 remains; Task 2 absent; Workflow failed |
| Public Worker isolation is preserved | Inspect public Wrangler config and exports | No scheduler Workflow, Cron, secret, or binding added to public config |

## 10. Verification boundary

Tests exercise the Workflow class's `run()` method in the Cloudflare Workers test runtime with deterministic test control over `step.do`, plus local SQLite-backed Durable Objects. They do not establish a deployed Cloudflare Workflow engine, actual Cron delivery, live cross-script binding availability, production key custody, or staging/production correctness. Wrangler dry-run validates configuration syntax only.

## 11. Activation gates

No production schedule is configured in this PR. Activation requires explicit review of the actual Cron schedule and policy, live DO namespace/export verification, secure key provisioning and rotation, Workflow plan/billing/retention review, and a separately approved staging smoke test. Full History Secret Scan findings must be addressed before promotion.
