# Scheduler Task Admission Integration

**Status:** Draft implementation evidence  
**Scope:** Source and Cloudflare Vitest integration only  
**PR:** #426  
**Production activation:** Not performed

## 1. Design decision

The standalone scheduler commit `2729a325991c989cbab182967135aa76f864ac29` is not cherry-picked. Its `issueAdmissionReceipt` API belongs to a different TenantDirectory contract and its scheduler-specific HMAC assertion is not bound to the complete Task admission request.

The integrated path uses the current protocol:

1. `TenantDirectory.prepareTaskAdmission()` authorizes a tenant-scoped service principal against active membership and the `task.create` policy, then issues an Ed25519 `ad1` grant bound to the exact Task digest, tenant, project, principal, Task ID, idempotency digest, and input hash.
2. `OrchestratorLedger.createTask()` independently verifies the canonical Task and the `ad1` grant, verifies a short-lived Scheduler worker assertion, and commits the Task, immutable admission receipt, `task.admitted` Outbox event, consumed worker JTI, and claim-candidate index in one Ledger-local transaction.

The generic Scheduler worker assertion is not treated as Task authorization. It only proves the fixed Scheduler system identity at the Ledger boundary; the Directory-issued Ed25519 grant carries the tenant- and Task-specific authorization.

## 2. Entry-point isolation

`orchestrator-scheduler-worker.js` is a separate Worker entry module. It exports the `TenantDirectory` and `OrchestratorLedger` Durable Object classes and exposes a `scheduled()` handler only. It has no `fetch()` handler and is not imported by the public/MCP `index.js` entrypoint.

This module is intentionally not wired into `wrangler.toml`, a scheduler-specific Wrangler configuration, or any Cron Trigger. No Worker, Durable Object binding, secret, route, or schedule was changed or deployed by this work.

Before any future activation, `LEDGER_WORKER_ASSERTION_KEYS` and `LEDGER_WORKER_ASSERTION_ACTIVE_KID` must be provisioned only for the dedicated scheduler runtime and Ledger verifier path. They must not be added to the public fetch/MCP Worker merely to make this handler work.

## 3. Event identity and policy contract

The handler consumes the Cloudflare ScheduledController values:

- `cron`: exact Cron expression used to select the policy entry.
- `scheduledTime`: integer milliseconds since the Unix epoch.

The selected `SCHEDULED_ADMISSION_POLICIES` JSON entry has this shape:

```json
{
  "0 * * * *": {
    "servicePrincipalId": "scheduler-service",
    "tasks": [
      {
        "tenantId": "tenant-a",
        "projectId": "project-a",
        "taskIdPrefix": "scheduled-reconcile",
        "idempotencyPrefix": "cron-reconcile",
        "taskTemplate": {
          "executorId": "reconciliation-executor",
          "taskKind": "scheduled-reconciliation"
        }
      }
    ]
  }
}
```

The sample identifiers are illustrative, not deployed configuration.

For each entry, the handler deterministically derives:

- `taskId = taskIdPrefix + "-" + scheduledTime`
- `idempotencyKey = idempotencyPrefix + ":" + scheduledTime + ":" + taskId`

The Task also contains `scheduleCron` and `scheduledAt`. Its `createdAt` and `updatedAt` use the scheduled time, rather than the retry wall clock, so the canonical Task digest remains stable when the same Cron event is replayed. Reserved fields are overwritten by the adapter; the policy template cannot substitute tenant, project, Task ID, lifecycle state, version, or event time.

The adapter preflights the complete selected batch before the first Durable Object write. It enforces a 64 KiB policy-size limit, a maximum of 20 tasks per invocation, identifier bounds, unique Task/idempotency scopes, and canonical Task normalization. Invalid policy data therefore fails before any Directory reservation is attempted.

## 4. Execution and transactional boundaries

For each preflighted Task, the adapter:

1. Resolves TenantDirectory and OrchestratorLedger stubs.
2. Calls `prepareTaskAdmission()` with the exact principal, tenant, project, Task ID, canonical Task digest, idempotency key, and deterministic input hash.
3. Mints a fresh Scheduler worker assertion for the specific Ledger call. The existing assertion contract has a 60-second maximum lifetime.
4. Calls `OrchestratorLedger.createTask()` with the Task, idempotency key, input hash, worker assertion, and Directory grant.

The adapter maps TenantDirectory and OrchestratorLedger stubs with `idFromName(tenantId)`. This establishes a tenant-scoped Ledger shard key for this scheduler intake path. All future claim, dispatch, reconciliation, and Outbox consumers must use the same mapping; that downstream runtime routing has not yet been established by this PR.

There is no distributed transaction across the two Durable Objects and no batch-wide transaction. Directory reservation and Ledger persistence remain separate linearization points. The adapter processes tasks sequentially and reports partial completion rather than implying all-or-nothing batch semantics.

If a Ledger RPC fails after Directory has committed a reservation, the retry uses the same Cron expression, scheduled time, Task ID, Task digest, input hash, and idempotency key. The test suite injects a one-time Ledger transport failure, observes one Directory reservation and zero Ledger Tasks, then replays the same event and observes one Task, one admission receipt, and one Outbox event.

The Directory grant has a bounded validity window of 300 seconds. A retry that arrives after that window is not silently re-authorized; the Directory's existing retry-window rejection remains a recovery blocker. A separate expired-reservation recovery protocol is required before claiming durable recovery across arbitrarily delayed retries.

The recovery test explicitly invokes the same `ScheduledController` again after an injected transport interruption. It proves deterministic same-event replay at the application boundary; it does **not** prove that Cloudflare Cron Triggers automatically redeliver the same `scheduledTime` after a thrown exception. The reviewed Scheduled Handler and Cron Trigger documentation describes the event API, `noRetry()`, and event history, but does not establish a retry-delivery guarantee sufficient for this protocol. No automatic platform retry is assumed. A durable run coordinator, Workflow, or equivalent persisted retry mechanism must be designed and verified before runtime activation.

## 5. Hostile verification

The new Cloudflare Durable Object tests cover:

- Successful Scheduler → TenantDirectory Grant → OrchestratorLedger admission.
- Repeated delivery of the same scheduled event without duplicate Task, receipt, or Outbox rows.
- An injected failure after Directory reservation and before Ledger persistence, followed by replay of the same event.
- Invalid later task-policy entries being rejected during preflight before the first Directory reservation.
- The scheduler entry module having no public `fetch()` handler.

Existing PR tests continue to exercise membership and policy fences, signature verification, tenant/project/Task substitution, grant expiry, worker assertion expiry, idempotency conflicts, replay protection, and Ledger transaction rollback.

A Cloudflare Vitest `createScheduledController()` test exercises the handler contract and its numeric `scheduledTime`. It does not prove a deployed Cron Trigger, production binding, key custody, or platform-origin attestation.

## 6. Known blockers before activation

1. Design and verify a durable retry/run-coordination mechanism that preserves the original Cron event identity; do not assume platform Cron redelivery after handler failure.
2. Create and review a dedicated scheduler Worker configuration and bind its Cron expressions explicitly; do not alter the existing public Worker configuration.
3. Provision the Directory grant signing/verifying key material and Scheduler/Ledger assertion keys under a documented custody/rotation model. Keep the Scheduler assertion signing key out of public fetch/MCP code.
4. Confirm and enforce the tenant-scoped Ledger ID mapping across all future Task claim, dispatch, reconciliation, and Outbox consumers.
5. Design a bounded recovery/re-authorization protocol for Directory reservations whose 300-second grant window has expired.
6. Add runtime monitoring for partial admission, stale reservations, signer failures, and Ledger RPC failures; then perform a separately approved staging activation and platform Cron smoke test.

## 7. Evidence and provenance

- Cloudflare Scheduled Handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cloudflare Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare Vitest test APIs: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- PR #426 remains Draft and unmerged. This document records a source/test integration only; it does not authorize deployment.
