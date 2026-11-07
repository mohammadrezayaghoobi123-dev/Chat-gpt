# Durable Attempt-to-Audit Correlation Review V0

Status: design review; implementation is not yet complete.

## Finding

The idempotent mission path durably reserves an `attempt_id` and marks the dispatch boundary before invoking the adapter. However, the `mission.dispatch_started` and `mission.dispatch_finished` audit payloads currently identify the mission and integration but do not carry the durable `attempt_id`. The registry attempt and audit lifecycle therefore cannot be joined by a stable attempt identifier alone.

## Required change

1. Add an optional keyword-only `attempt_id` to `execute_mission_once` so existing direct callers remain source-compatible.
2. Include `attempt_id` in both `mission.dispatch_started` and `mission.dispatch_finished` payloads.
3. Have `execute_mission_idempotently` pass the value returned by `reserve_attempt`.
4. Keep direct, non-registry calls explicit: `attempt_id` may be null, but audit consumers must not interpret a null value as a durable attempt.
5. Add tests that assert the same non-empty attempt ID appears in both lifecycle events; assert that a failure to persist the start event does not invoke the adapter; assert that a post-dispatch audit failure remains uncertain and is not automatically retried.

## Invariants

- The attempt must be committed before the dispatch boundary can be entered.
- The start event must be persisted before the adapter is invoked.
- The finish event records the adapter/dispatch result, not independently verified external completion.
- Audit failure after dispatch must never trigger an automatic retry.
- Attempt ID is a correlation identifier, not authentication, approval, or completion evidence.

## Acceptance criteria

- A single idempotent execution produces start and finish events with the same durable attempt ID.
- A dispatch-start event without an attempt ID is only acceptable for legacy/direct non-registry callers and is visibly distinguishable.
- A malformed or conflicting attempt ID is rejected before dispatch.
- Tests verify both the happy path and pre-/post-dispatch audit failures.
- The test suite and CI results are checked before claiming this behavior is implemented.

## Remaining risks

This correlation alone does not make audit storage tamper-proof, establish actor identity, verify a provider-side side effect, or atomically commit provider state and local state. Those require the existing evidence-verification and trust-boundary work.
