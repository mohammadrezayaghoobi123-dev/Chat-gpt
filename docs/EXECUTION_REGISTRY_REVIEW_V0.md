# Execution Registry Review — V0

## Review status

Reviewed source: `src/master_brain/execution_registry.py` at commit `fa2aeae9b84dbc5e34334d0d9533b0080c24a37b`.
Current maturity: **IMPLEMENTED PROTOTYPE; not independently validated as a safety control**. CI on the implementation commit passed the repository's existing unit-test and offline-demo steps, but the new registry has no dedicated test module yet. The review document itself has no observed CI run as of this review.

## Positive properties visible in source

- The idempotency key is a database primary key.
- Reservation starts with `BEGIN IMMEDIATE`, reads existing state, and inserts only if absent.
- Same key with a different mission ID, contract digest, or payload digest raises `IdempotencyConflict`.
- State changes are constrained by an explicit transition map.
- State changes compare the expected version and update the version in the same SQL statement.
- Registry read/write SQLite exceptions are converted to domain-specific errors.
- `OUTCOME_UNKNOWN` cannot transition directly to `RUNNING`.

## Gaps and threat boundaries

1. **No execution-path integration.** `mission_execution.py` does not call this registry. Existing dispatch can still run without reserving a registry key.
2. **No dedicated tests yet.** The existing green CI run proves the repository's configured checks passed, not that registry-specific race/failure cases were exercised.
3. **No provider idempotency.** A local key does not deduplicate a side effect at a remote provider.
4. **No durable invocation intent/receipt fields.** The current record stores state and digests but no attempt ID, adapter identity/version, provider receipt, result reference, or reconciliation owner.
5. **No stale RUNNING recovery API.** A process crash can leave a record in RUNNING. It must not simply be reclaimed and redispatched; recovery should transition to OUTCOME_UNKNOWN and reconcile.
6. **Caller-supplied timestamps.** `recorded_at` is validated as non-empty text but is not sourced from a trusted clock or validated as canonical UTC.
7. **Key scoping is a caller responsibility.** The primary key is global within the database. Multi-tenant deployments must construct an unambiguous scoped key or change the schema to a composite unique key.
8. **Audit is separate.** Registry transactions do not atomically commit with the JSONL hash-chain audit store. A transactional outbox or explicit reconciliation is needed to bridge them.
9. **SQLite deployment boundary.** This is a local/single-host primitive. Do not treat a database file on arbitrary network storage as a distributed lock service.
10. **Result state is not evidence.** The registry permits a transition to SUCCEEDED but currently stores no required evidence for that state. The caller can misuse the API unless a stricter typed transition API is added.
11. **Configured timeout is overridden.** `sqlite3.connect(..., timeout=self.timeout)` is followed by `PRAGMA busy_timeout=5000`, which sets a fixed five-second busy timeout. As a result, the constructor's `timeout` parameter does not reliably configure lock waiting. The implementation should derive the PRAGMA value from the validated timeout, or remove the redundant PRAGMA and use the connection setting consistently.
12. **Connection lifecycle is implicit.** `with self._db() as db` uses the SQLite connection's transaction context manager; it commits or rolls back but does not itself close the connection. Use explicit closure (for example, `contextlib.closing` around a transaction context) so connection lifetime is deterministic, including error paths.

## Required tests before integration

- duplicate reservation, including after state is RUNNING and after terminal states
- same key with changed mission ID, contract digest, or payload digest
- parallel reservation race with many independent connections; exactly one `created=True`
- stale version and illegal transition rejection
- invalid/corrupted persisted state fails closed
- lock contention and configured busy-timeout behavior return a controlled error
- connection cleanup on success and exception paths
- crash simulation around reservation, dispatch claim, and result persistence
- no adapter call when reservation fails or an identical existing key is returned
- no automatic redispatch from RUNNING or OUTCOME_UNKNOWN
- successful terminal transition requires validated evidence, not a bare caller-supplied state

## Next safe implementation slice

1. Add a dedicated test module and run it in CI.
2. Fix timeout configuration and deterministic connection closure, with regression tests.
3. Refine the API so callers must explicitly claim PENDING -> RUNNING and can distinguish a new claim from an existing record.
4. Add durable attempt/adapter metadata and a typed evidence reference for terminal outcomes.
5. Integrate with `execute_mission_once` only after failure-injection tests exist.
6. Define reconciliation behavior before implementing retry or worker recovery.

## Explicit non-claims

This implementation does not guarantee exactly-once external effects, distributed locking, trusted identity, tamper-proof audit history, or production-safe automated recovery.
