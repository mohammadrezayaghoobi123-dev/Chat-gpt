# Orchestrator Ledger PITR Recovery Runbook

## Status and scope

This is a **manual operational procedure** for a restore of the SQLite-backed `OrchestratorLedger` Durable Object using Cloudflare Point-in-Time Recovery (PITR).

The Ledger currently stores all of the following inside the same Durable Object SQLite database:

- `orchestrator_security_clock.high_water_ms`
- `orchestrator_consumed_assertions` and `orchestrator_owner_consumed_assertions`
- `orchestrator_audit_events`

Cloudflare PITR restores the entire SQLite database, including SQL and key-value data, to the selected bookmark. It does not selectively preserve newer rows from those tables. Therefore, a restore can remove assertion-consumption records and later audit events written after the selected bookmark. The persisted high-water mark can also be restored to an earlier value; the runtime still computes trusted time as the maximum of the current wall clock and the restored high-water, but this does not recover the rows that were rolled back.

A previously consumed signed assertion may become replayable **only when** its JTI-consumption row is absent from the restored snapshot and the assertion remains temporally valid after the restore. This is a conditional replay window, not a claim that every restore causes a successful replay.

This runbook does not implement automatic restore detection, automatic write quarantine, or an independent external audit anchor. Treat the state as **UNKNOWN / RECOVERY_PENDING** until the checks below have been completed and independently evidenced.

## Mandatory quarantine

Immediately before a planned restore, or immediately after an emergency restore is identified:

1. Stop all Worker, Executor, and Owner assertion issuers for this Ledger.
2. Stop authenticated Ledger consumers and all privileged Ledger writes. Do not allow retries, queue redrive, scheduled jobs, or operator tools to issue or consume fresh assertions during quarantine.
3. Record the selected PITR bookmark, the restore request time, and the confirmed restore-completion time using an operator-controlled clock.
4. Keep issuance and authenticated consumption paused for at least **75 seconds after confirmed restore completion**.

### Quarantine bound

The current code's maximum assertion lifetimes are 60 seconds for Worker and Executor assertions and 30 seconds for Owner assertions. The current temporal checks accept a five-second clock skew in either direction.

For a pre-restore assertion, the conservative maximum post-restore acceptance window is:

`60s maximum lifetime + 5s future-iat allowance + 5s expiry-skew allowance = 70s`

The 75-second pause adds a five-second operational margin. This is a time-window precaution only. It does not restore deleted JTI rows, recover audit events, prove clock correctness, or replace an independent integrity checkpoint. Any assertion issued during quarantine restarts the relevant quarantine interval; keep issuers stopped.

Reconfirm these constants in all three assertion implementations before relying on this bound after any protocol change:

- `orchestrator-worker-identity.js`
- `orchestrator-executor-assertion.js`
- `orchestrator-owner-assertion.js`

## Integrity verification before resuming writes

After quarantine, keep authenticated writes disabled while performing these checks:

1. **Audit continuity:** Export the restored audit chain and verify sequence ordering, event-ID uniqueness, each `previous_hash` link, and each event hash against canonical event content.
2. **Independent anchor:** Compare the restored final sequence and hash with a checkpoint that was created before the restore and stored outside the restored Durable Object database, under an independently controlled trust boundary.
3. **Assertion replay state:** Reconcile consumed assertion JTIs against issuer-side records or another independently retained issuance/consumption log, where available. Do not treat the restored database as proof that an assertion was never consumed.
4. **Business state:** Reconcile task transitions, leases, Outbox events, receipts, and DLQ archives against independent source records and delivery logs. Resolve any gaps before enabling downstream side effects.
5. **Evidence record:** Preserve the bookmark, timestamps, pre-restore and post-restore audit heads, checkpoint source, reconciliation results, unresolved discrepancies, and operator approvals in an append-only incident record outside this database.

### No independent checkpoint

If no independently trusted audit-head checkpoint or assertion-consumption evidence exists, integrity is **UNKNOWN**. Do not infer completeness from a valid hash chain alone: a restored earlier prefix can itself be internally consistent. Keep privileged writes and irreversible downstream operations quarantined and classify the incident as **UNKNOWN / RECOVERY_PENDING**.

A checkpoint stored in the same SQLite database is not independent. Another Durable Object is not automatically independent either; its namespace, storage, access path, and recovery boundary must be assessed separately. Cross-object writes are not one atomic SQLite transaction, so any future external-anchor design requires an explicit idempotent reservation/commit/reconciliation protocol.

## Resume criteria

Resume authenticated issuance and Ledger writes only after all of the following are true:

- The 75-second quarantine interval completed with no new assertion issuance or authenticated consumption.
- Audit continuity and the pre-restore external checkpoint comparison are verified.
- Assertion replay state and business side effects are reconciled, with no unresolved integrity-critical discrepancy.
- The restore and verification evidence is retained outside the restored database.
- An accountable operator explicitly approves resumption.

Otherwise, remain **UNKNOWN / RECOVERY_PENDING**. Do not downgrade an unknown result to pass or fail merely because the application starts or `ping()` succeeds.

## Test and deployment limitations

- Local Vitest and Wrangler dry-runs can validate the application's migration and transaction logic; they do **not** execute Cloudflare's production PITR change log. Cloudflare documents PITR as unavailable in local development.
- A successful schema migration test does not prove a PITR restore, independent checkpoint, or post-restore operational quarantine.
- Durable Object code updates may be deferred, and older and newer code versions can overlap during rollout. Keep schema changes additive and compatible with every version that may still access the same database. Do not assume a code rollback reverses a database migration.
- This runbook is manual. No automatic recovery-state transition, external audit anchor, or automated post-restore gate is claimed by this change.

## Primary references

- [Cloudflare Durable Object SQLite Storage API and PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Rules of Durable Objects: schema migration and initialization](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Cloudflare Durable Object code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)
