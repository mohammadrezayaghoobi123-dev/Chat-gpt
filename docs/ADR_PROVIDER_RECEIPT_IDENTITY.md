# ADR: Provider-Scoped Completion Receipt Identity

Status: **Core registry enforcement implemented; production provider integration remains deferred**

## Context

The local `completion_receipts` table now enforces one receipt per execution and one receipt per attempt, and adds a partial unique index over `(provider_id, provider_scope, receipt_namespace, provider_receipt_id)` for scoped receipts. It stores an evidence digest, verifier identity/version, evidence type, timestamps, and the scoped identity. Legacy rows remain nullable/unscoped and are excluded from the index. The production provider integration remains disabled until deployment-owned configuration is implemented and reviewed.

A bare `provider_receipt_id` is not a safe uniqueness key: providers may scope identifiers to an account, tenant, project, region, or environment. Conversely, accepting scope copied from an untrusted evidence payload would let the payload choose the namespace in which its own uniqueness is checked.

The current attempt record stores `provider_id` but not a provider account/project/environment identity. The verifier contract now accepts a typed `ProviderVerificationResult` for durable completion. A bare boolean remains available to validation-only callers but cannot authorize completion because it carries no scoped identity. `reserve_attempt` persists optional scope and namespace fields; completion rejects attempts without both. These fields must come from deployment-owned integration configuration, never from evidence or user input. No provider-specific deployment configuration currently exists, so the production completion entry point continues to fail closed.

## Decision

Do not add a global UNIQUE constraint on `provider_receipt_id`, and do not claim cross-execution replay prevention is implemented.

The generic persistence and enforcement path is implemented. The remaining provider-specific trust chain must be completed before production use:

1. **Trusted operation scope:** persist a normalized provider scope on the locally created attempt, sourced from deployment-owned integration configuration (not from the receipt). The scope must distinguish every provider namespace in which receipt IDs can collide, including environment and account/project where applicable.
2. **Typed verifier result:** replace the verifier's bare boolean success contract with a validated result that includes the canonical receipt identity and the verified provider scope. Only the trusted verifier may produce this result after checking authoritative provider state. Reject scope disagreement between the attempt, verifier result, and evidence.
3. **Atomic receipt claim:** persist the normalized identity in the same SQLite transaction that inserts the completion receipt and changes the execution to `SUCCEEDED`. Add a uniqueness constraint over the documented canonical identity tuple, conceptually `(provider_id, provider_scope, receipt_namespace, receipt_id)`. The exact columns and canonicalization must follow the selected provider's documented semantics; do not assume this illustrative tuple fits every provider.
4. **Safe retry semantics:** the same identity may be treated as an idempotent retry only when the existing execution, attempt, evidence digest, verifier ID/version, and canonical receipt identity all match. Reuse under a different execution or attempt must fail without state mutation.
5. **Fail closed on ambiguity:** missing scope, uncanonicalizable identifiers, unknown namespace semantics, or an identity collision must reject completion and leave execution/receipt state unchanged.

## Migration strategy

Do not retrofit a NOT NULL scope or uniqueness constraint in-place without a versioned migration. The current additive migration introduces nullable columns and a partial unique index; existing rows lack sufficient scope to backfill safely and remain unscoped.

- Introduce a schema version and an explicit migration path.
- Preserve all existing receipt rows and their original evidence digests; never infer account/environment from receipt text or merge records.
- Treat historical rows with unknown scope as legacy/unscoped. They must not silently reserve a fabricated global identity.
- Before enabling the new constraint, audit candidate identities for collisions and report them for evidence-based manual reconciliation. Do not auto-delete, overwrite, or merge conflicting rows.
- Perform table/index changes transactionally using SQLite's documented safe table-rebuild procedure where needed; take and verify a backup for deployed databases before migration.
- Keep production completion fail-closed until deployment configuration supplies a real reviewed verifier and trusted provider scope, and migration tests pass on both fresh and legacy database fixtures.

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

The registry now rejects duplicate canonical receipt identities across execution keys when their trusted provider scope and namespace match, while permitting the same receipt string in distinct scopes. The protection is only as sound as the deployment-owned scope and provider verifier; this repository still has no real provider integration. Legacy receipts remain unscoped and are not retroactively replay-protected. Do not claim production replay protection until the deployment configuration and legacy-database migration have been reviewed and exercised.
