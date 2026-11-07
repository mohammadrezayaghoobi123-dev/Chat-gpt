# Mission Execution Idempotency and Recovery — V0

## Status

**SPECIFIED — NOT IMPLEMENTED OR TESTED AS A COMPLETE PROTOCOL.** This document defines the next implementation boundary for the Master Brain prototype. The current `AuditStore` is a local single-writer JSONL store and is not a concurrency-safe execution registry. Reusing an audit event ID blocks some sequential retries; it does not establish distributed idempotency.

## Problem statement

An adapter may cause an external side effect and then lose its response, or the caller may fail to persist the result. In either case the system cannot safely infer whether the side effect occurred. Automatically retrying can duplicate the action; automatically marking success can falsely claim completion.

## Required identities

Each logical execution must have a caller-stable `idempotency_key`, scoped to a tenant/principal and operation class. Store a canonical contract digest and a payload digest alongside it. Reuse of a key with a different contract or payload digest must be rejected as a conflict, not treated as a retry. Do not store secrets in the key or digest input logs.

## State machine

- `PENDING`: key reserved; no adapter invocation is permitted yet.
- `RUNNING`: execution claim committed before invoking the adapter.
- `SUCCEEDED`: a valid adapter/provider receipt has been stored; the meaning of the receipt is provider-specific.
- `FAILED`: failure is known to have occurred before any external side effect, or a provider has authoritatively reported failure.
- `OUTCOME_UNKNOWN`: invocation may have caused an external side effect, but authoritative completion evidence is missing.
- `RECONCILIATION_REQUIRED`: a recovery worker or authorized human must query provider state or inspect evidence before deciding what to do next.

Allowed transitions must be explicit and enforced atomically. In particular, `OUTCOME_UNKNOWN` must never transition directly to a fresh invocation by an automatic retry policy.

## Safety invariants

1. The idempotency key has a unique constraint in the authoritative execution registry.
2. Reserving a key and claiming a transition use an atomic transaction/compare-and-swap, not a read-then-write check.
3. A duplicate request with the same key and same digests returns the existing execution record and does not invoke the adapter again.
4. A duplicate key with different digests is rejected as `idempotency_conflict`.
5. A lease timeout alone does not prove the previous worker caused no side effect. Expired `RUNNING` work becomes `OUTCOME_UNKNOWN` unless adapter/provider semantics prove safe recovery.
6. Where supported, propagate the same provider-side idempotency key on every transport retry. Provider idempotency windows and scope must be documented and tested.
7. Persist the invocation intent before dispatch; persist provider receipt/result after dispatch. If result persistence fails, surface `OUTCOME_UNKNOWN`/reconciliation state and never blind-retry.
8. Audit history and execution registry have distinct responsibilities. Hash chaining is tamper-evidence for a retained chain, not identity authentication, a transaction coordinator, or proof of external effects.
9. Never report external effect confirmed solely because an adapter returned a JSON object. Require a typed, provider-specific evidence contract.
10. Fail closed on corrupted registry state, invalid transitions, mismatched digests, missing authorization, or unverifiable audit history.

## Required record fields (minimum)

- execution ID and idempotency key (appropriately scoped)
- mission ID, canonical contract digest, payload digest
- state and monotonically increasing version
- created/updated timestamps and actor/service identity from a trusted source
- adapter/provider identifier and adapter contract version
- attempt number and provider idempotency key, when supported
- invocation-intent event reference
- provider receipt/evidence reference and evidence type, if any
- sanitized error category; never raw credentials or sensitive payloads
- reconciliation owner/status for unknown outcomes

## Recovery policy

- Before invocation: a durable reservation/intent failure means do not call the adapter.
- Definite pre-side-effect failure: transition to `FAILED`; retry only through an explicit policy and the same logical idempotency key.
- Timeout, connection reset after send, process crash during invocation, or failure persisting the result: transition to `OUTCOME_UNKNOWN` unless the adapter contract proves the request was not sent.
- Recovery first queries provider status or retrieves a durable provider receipt. If no authoritative status exists, require human reconciliation for consequential actions.
- Do not infer failure from missing telemetry or infer success from a request acknowledgement.

## Verification plan

1. Sequential duplicate: same key/digests produces one adapter call.
2. Conflicting duplicate: same key, changed digest is rejected before dispatch.
3. Concurrent duplicate: N callers racing for one key produce one owner and at most one adapter invocation.
4. Crash after reservation but before invocation: recover without falsely marking success.
5. Crash/timeout after send: enter `OUTCOME_UNKNOWN`; no automatic second invocation.
6. Result persistence failure after adapter return: preserve unknown outcome and reconcile without blind retry.
7. Corrupt registry/audit: fail closed.
8. Provider receipt invalid, mismatched, expired, or absent: never mark external effect confirmed.
9. Lease expiry while the original worker is still alive: fencing/version checks prevent stale worker state overwrites; note these cannot prevent an already-issued external side effect unless the provider supports idempotency/fencing.
10. Property-based/state-machine tests: reject every unlisted transition and verify audit/event ordering.

## Implementation decision

Prefer a transactional execution registry with a unique constraint and conditional state transitions (for example SQLite for a single-host prototype, with explicit limits; a transactional server database for multi-worker deployment). Keep the append-only audit trail as a separate evidence stream. Do not claim exactly-once external execution: absent provider-side idempotency or reconciliation, the strongest honest guarantee is at-most-one local dispatch claim plus explicit handling of unknown outcomes.

## Maturity

This is a design specification only. No SQLite registry, concurrency guarantee, provider receipt verification, identity service, or recovery worker is implemented by this document.
