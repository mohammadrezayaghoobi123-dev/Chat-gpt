# Execution Attempt Schema Migration Review V0

Status: design review; no migration implementation or test execution is claimed.

## Finding

The registry creates `execution_attempts` with `UNIQUE(execution_key)` only when the table is first created. SQLite's `CREATE TABLE IF NOT EXISTS` does not retrofit that constraint onto a database created by an earlier schema version. The Python-level existing-attempt check prevents ordinary duplicate reservations, but it is not a substitute for a database constraint under every future code path or concurrent writer.

## Required migration behavior

1. Introduce a numbered/versioned schema migration rather than relying only on `CREATE TABLE IF NOT EXISTS`.
2. Inspect existing rows before creating a unique index on `execution_key`.
3. If duplicates exist, stop and return a clear migration error. Do not silently delete, merge, or choose a winning attempt; these rows may represent uncertain external side effects.
4. If no duplicates exist, create a unique index such as `idx_attempts_one_per_execution` inside a transaction where supported, and record the applied schema version only after the migration succeeds.
5. Convert migration failures into a stable registry-level error while preserving the original database error as the cause. Do not open dispatch if schema validation/migration failed.
6. Keep the Python-level duplicate guard as defense in depth. The database uniqueness constraint is the concurrency backstop.

## Required tests

- Fresh database receives the unique index and reserves only one attempt per execution.
- A database with the legacy table but no unique constraint migrates successfully when rows are unique.
- A legacy database containing two attempts for one execution fails closed, leaves rows unchanged, and does not claim migration success.
- Reopening an already migrated database is idempotent.
- Two concurrent attempt reservations for one execution produce at most one committed attempt.
- A migration failure prevents adapter invocation.
- Existing execution and audit records remain unchanged by migration.

## Non-goals

This migration does not prove whether a provider side effect occurred, authorize retries, or enable `SUCCEEDED`. Those require separate provider-specific reconciliation and verified completion evidence.

## Release gate

Do not describe this schema as production-ready until migration tests, concurrency tests, recovery tests, and the repository's applicable CI checks have been observed passing. An empty status-check response is not a passing result.
