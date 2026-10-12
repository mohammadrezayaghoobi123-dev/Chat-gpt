# ADR: Provider-Scoped Completion Receipt Identity

Status: **Accepted design; implementation deferred until trusted scope is available**

## Context

The local `completion_receipts` table currently enforces one receipt per execution and one receipt per attempt. It stores an evidence digest, verifier identity/version, evidence type, and timestamps. It does **not** establish global replay uniqueness across execution keys.

A bare `provider_receipt_id` is not a safe uniqueness key: providers may scope identifiers to an account, tenant, project, region, or environment. Conversely, accepting scope copied from an untrusted evidence payload would let the payload choose the namespace in which its own uniqueness is checked.

The current attempt record stores `provider_id` but not a provider account/project/environment identity. The verifier contract currently returns only a boolean, so the trusted verifier has no typed channel to return a normalized identity that can be committed atomically. These are prerequisites, not details that a SQL index can solve by itself.

## Decision

Do not add a global UNIQUE constraint on `provider_receipt_id`, and do not claim cross-execution replay prevention is implemented.

Implement scoped replay protection only after the following trust chain is available:

1. **Trusted operation scope:** persist a normalized provider scope on the locally created attempt, sourced from deployment-owned integration configuration (not from the receipt). The scope must distinguish every provider namespace in which receipt IDs can collide, including environment and account/project where applicable.
2. **Typed verifier result:** replace the verifier's bare boolean success contract with a validated result that includes the canonical receipt identity and the verified provider scope. Only the trusted verifier may produce this result after checking authoritative provider state. Reject scope disagreement between the attempt, verifier result, and evidence.
3. **Atomic receipt claim:** persist the normalized identity in the same SQLite transaction that inserts the completion receipt and changes the execution to `SUCCEEDED`. Add a uniqueness constraint over the documented canonical identity tuple, conceptually `(provider_id, provider_scope, receipt_namespace, receipt_id)`. The exact columns and canonicalization must follow the selected provider's documented semantics; do not assume this illustrative tuple fits every provider.
4. **Safe retry semantics:** the same identity may be treated as an idempotent retry only when the existing execution, attempt, evidence digest, verifier ID/version, and canonical receipt identity all match. Reuse under a different execution or attempt must fail without state mutation.
5. **Fail closed on ambiguity:** missing scope, uncanonicalizable identifiers, unknown namespace semantics, or an identity collision must reject completion and leave execution/receipt state unchanged.

## Migration strategy

Do not retrofit a NOT NULL scope or uniqueness constraint in-place without a versioned migration. Existing rows lack sufficient scope to backfill safely.

- Introduce a schema version and an explicit migration path.
- Preserve all existing receipt rows and their original evidence digests; never infer account/environment from receipt text or merge records.
- Treat historical rows with unknown scope as legacy/unscoped. They must not silently reserve a fabricated global identity.
- Before enabling the new constraint, audit candidate identities for collisions and report them for evidence-based manual reconciliation. Do not auto-delete, overwrite, or merge conflicting rows.
- Perform table/index changes transactionally using SQLite's documented safe table-rebuild procedure where needed; take and verify a backup for deployed databases before migration.
- Keep production completion fail-closed until deployment configuration supplies a real reviewed verifier and the migration has passed tests on both fresh and legacy database fixtures.

## Required tests before implementation is considered complete

- Two executions with the same receipt ID but different provider scopes: both accepted if provider semantics define separate namespaces.
- Same canonical receipt identity presented for two execution keys: second rejected, with no state or receipt mutation.
- Exact same-execution retry: idempotent, with no duplicate receipt.
- Same execution/attempt but changed receipt identity, scope, evidence digest, or verifier version: rejected.
- Evidence attempts to spoof scope: rejected; scope is sourced from trusted persisted attempt/configuration.
- Legacy database with existing rows: migration preserves every row and fails safely on ambiguous collisions.
- Concurrent claims of the same scoped identity: at most one transaction commits the identity.
- Missing/malformed scope and verifier exceptions: fail closed.
- Recovery inventory and integrity checks detect orphaned, inconsistent, or unscoped newly-created receipts.
- Run focused tests and the full CI workflows on the exact commit.

## Consequences

This design intentionally leaves a documented security limitation until a provider/account/environment model exists. It avoids a false sense of security from a global receipt-ID index, and avoids corrupting legacy evidence by inventing missing scope. No real provider integration is enabled by this ADR.
