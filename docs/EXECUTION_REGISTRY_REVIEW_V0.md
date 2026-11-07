# Execution Registry Review — V0

## Review status

Reviewed components: `src/master_brain/execution_registry.py` and `src/master_brain/mission_execution.py` on `master-brain/proof-protocol-v0`.
Current maturity: **IMPLEMENTED PROTOTYPE; not independently validated as a production safety control**. Earlier registry integration tests had a successful CI run; the latest recovery-discovery and corrupt-state regression commits have no reported status checks in the currently inspected GitHub status endpoint, so those changes are not yet verified by CI. This does not establish provider-side exactly-once behavior or production readiness.

## Positive properties visible in source

- The idempotency key is a database primary key.
- Reservation starts with `BEGIN IMMEDIATE`, reads existing state, and inserts only if absent.
- Same key with a different mission ID, contract digest, or payload digest raises `IdempotencyConflict`.
- State changes are constrained by an explicit transition map.
- State changes compare the expected version and update the version in the same SQL statement.
- Registry read/write SQLite exceptions are converted to domain-specific errors.
- `OUTCOME_UNKNOWN` cannot transition directly to `RUNNING`.

## Gaps and threat boundaries

1. **Optional integration only.** `execute_mission_idempotently(...)` now uses the registry, but the older `execute_mission_once(...)` remains available without it. Callers must explicitly choose the registry-backed entry point where deduplication is required.
2. **Test coverage is still incomplete.** Dedicated tests cover duplicate reservation, digest conflict, concurrency, lock timeout, corrupted state, and the registry-backed dispatch path. Crash recovery, process-level races, and broader fault injection remain.
3. **No provider idempotency.** A local key does not deduplicate a side effect at a remote provider.
4. **No durable invocation intent/receipt fields.** The current record stores state and digests but no attempt ID, adapter identity/version, provider receipt, result reference, or reconciliation owner.
5. **Recovery discovery only; no recovery decision API.** `list_recovery_candidates()` now returns RUNNING, OUTCOME_UNKNOWN, and RECONCILIATION_REQUIRED records without mutation. It validates every persisted row before filtering and fails closed on an unknown/corrupt state. It does not determine whether an external effect occurred, transition stale RUNNING records, or authorize redispatch; those remain unimplemented.
6. **Caller-supplied timestamps.** `recorded_at` is validated as non-empty text but is not sourced from a trusted clock or validated as canonical UTC.
7. **Key scoping is a caller responsibility.** The primary key is global within the database. Multi-tenant deployments must construct an unambiguous scoped key or change the schema to a composite unique key.
8. **Audit is separate.** Registry transactions do not atomically commit with the JSONL hash-chain audit store. A transactional outbox or explicit reconciliation is needed to bridge them.
9. **SQLite deployment boundary.** This is a local/single-host primitive. Do not treat a database file on arbitrary network storage as a distributed lock service.
10. **Result state is not evidence.** The generic transition to SUCCEEDED is now blocked. A future evidence-aware API must verify provider-specific receipts before allowing success.
11. **Provider and distributed boundaries remain.** The local SQLite key prevents duplicate local reservations, not remote side effects across machines, databases, or provider retries. No provider-side idempotency key is sent by this prototype.
12. **Connection lifecycle and timeout were hardened.** The connection is explicitly closed and the busy timeout is derived from the validated constructor timeout; tests cover lock contention.

## Follow-up hardening: success is now fail-closed

The generic `transition(..., target=SUCCEEDED)` path is deliberately blocked until an evidence-aware completion API exists. The registry does not yet verify provider receipts, so allowing a caller to set `SUCCEEDED` would overstate what the system knows. This makes the prototype stricter but also means there is currently no supported path to mark an execution successful. A future API must validate a provider-specific evidence contract before enabling that transition.

## Required tests and remaining verification

- duplicate reservation, including after state is RUNNING and after terminal states
- same key with changed mission ID, contract digest, or payload digest
- parallel reservation race with many independent connections; exactly one `created=True`
- stale version and illegal transition rejection
- invalid/corrupted persisted state fails closed, including during recovery inventory listing
- lock contention and configured busy-timeout behavior return a controlled error
- connection cleanup on success and exception paths
- crash simulation around reservation, dispatch claim, and result persistence
- no adapter call when reservation fails or an identical existing key is returned — covered by current unit tests
- recovery inventory lists uncertain states without mutation; tests cover expected states, deterministic ordering, empty inventory, and corrupt-state failure. CI verification for the latest recovery test commit remains outstanding
- no automatic redispatch from RUNNING or OUTCOME_UNKNOWN — duplicate requests return the existing record and do not reclaim it; evidence-based recovery decisions still need implementation
- successful terminal transition requires validated evidence, not a bare caller-supplied state — generic success transition is now blocked

## Next safe implementation slice

1. Ensure the recovery test module is collected by the repository's actual CI workflow and verify the latest commit's result.
2. Add failure-injection tests for crashes before dispatch, after a possible side effect, and during result persistence.
3. Add durable attempt/adapter metadata and a typed evidence reference for terminal outcomes.
4. Specify provider-specific evidence verification and reconciliation decisions before enabling SUCCEEDED.
5. Integrate any recovery state transitions with `execute_mission_once` only after failure-injection tests exist.
6. Keep automated redispatch disabled for uncertain outcomes unless provider-side idempotency and reconciliation semantics are explicitly verified.

## Explicit non-claims

This implementation does not guarantee exactly-once external effects, distributed locking, trusted identity, tamper-proof audit history, or production-safe automated recovery.
