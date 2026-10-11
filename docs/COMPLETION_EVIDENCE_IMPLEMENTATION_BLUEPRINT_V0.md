# Completion Evidence Implementation Blueprint — V0

## Status and boundary

Design artifact for implementation review. This blueprint is not executable code and does not enable `SUCCEEDED`. The current generic `SQLiteExecutionRegistry.transition(..., target=State.SUCCEEDED)` guard must remain unchanged until a trusted verifier and atomic persistence path are implemented and independently tested.

Related documents:
- `COMPLETION_EVIDENCE_CONTRACT_V0.md`
- `COMPLETION_EVIDENCE_THREAT_MODEL_AND_ACCEPTANCE_V0.md`
- `EXECUTION_RECOVERY_RUNBOOK_V0.md`

## 1. Existing implementation facts

The current `executions` table stores the local idempotency key, mission ID, contract and payload digests, state, version and timestamps. It does not persist an attempt ID, integration/provider identity, verified evidence reference, verifier/policy version, or evidence-consumption record.

The idempotent execution path computes a canonical JSON payload digest and mission contract digest, reserves the key, transitions to RUNNING, invokes the adapter once, then conservatively records OUTCOME_UNKNOWN. It currently cannot prove a provider-side postcondition. Therefore a future verifier cannot safely infer all required bindings from the existing registry row alone.

## 2. Data model proposal

Do not migrate the production schema until migration and rollback tests exist. Proposed logical records:

### Execution attempt

One row per dispatch attempt, distinct from the stable idempotency reservation:
- `attempt_id` (opaque random identifier; unique)
- `execution_key` (foreign key to reservation)
- `attempt_number` (monotonic within execution)
- `integration_id`, `adapter_version`, `provider_id`
- `started_at` and source/trust metadata
- `dispatch_boundary_entered` boolean set before adapter invocation
- optional provider operation/receipt reference, redacted and non-secret
- attempt outcome classification, never inferred from worker disappearance

The attempt ID must be created and durably recorded before the external call. If the process can call a provider without persisting the attempt ID first, evidence cannot be unambiguously bound to that call.

### Completion evidence

Immutable record with:
- evidence record ID;
- execution key and attempt ID;
- mission ID, contract digest and payload digest copied from the reserved execution;
- integration ID, adapter version, provider ID and target-resource identity;
- evidence type/schema version;
- canonical evidence digest and algorithm/canonicalization identifiers;
- immutable evidence reference or bounded evidence bytes when policy permits;
- provider operation/receipt ID where available;
- observed-at value and explicit source/clock trust;
- verifier ID/version and policy version;
- verification outcome and machine-readable reason;
- created-at value from the local registry clock, clearly distinguished from provider-observed time.

Secret-bearing payloads, credentials, authorization headers and raw session tokens must not be stored. Evidence retention, encryption, deletion, and access control need a separate data policy.

### Evidence consumption / replay control

A unique constraint should prevent the same evidence identity from being consumed by different executions. Candidate uniqueness is provider-specific; a local evidence digest alone may be identical for legitimate repeated reads. Prefer a provider receipt/operation ID scoped by provider and operation when documented as unique, with a digest fallback for the exact evidence object.

## 3. API separation

Keep these responsibilities separate:

1. **Evidence acquisition:** obtains bytes/receipt/status through a documented provider-specific channel.
2. **Verifier resolution:** maps an approved verifier ID/version/policy version to a configured implementation. Caller input must not be able to register or replace a trusted verifier.
3. **Evidence verification:** checks authentication, source semantics, terminal postcondition, exact request binding, freshness, replay/revocation and target resource.
4. **Registry completion:** accepts the result only through an internal application composition boundary and atomically writes evidence metadata and state.
5. **Recovery:** inspects unresolved attempts and gathers new evidence; it never redispatches by default.

A verifier result should not be considered trusted merely because it is an instance of a public Python dataclass. The trust boundary is the controlled composition root, verifier registry, source authentication and verifier implementation. Do not expose a generic `mark_succeeded(verified=True)` API.

## 4. Atomic success operation

The registry API should be narrowly named, for example `complete_with_verified_evidence(...)`, and must not accept a caller-controlled boolean. The application layer first invokes the configured verifier outside the SQLite transaction. The registry operation then:

1. validates that the internal verification result carries all mandatory fields;
2. opens a write transaction (`BEGIN IMMEDIATE`);
3. loads the execution and attempt;
4. checks expected state and version (compare-and-swap);
5. checks mission/contract/payload/key/attempt/integration/provider/resource bindings;
6. checks verifier and policy versions are currently permitted by trusted configuration;
7. checks evidence identity has not been consumed by another execution;
8. inserts immutable evidence metadata;
9. updates the execution to SUCCEEDED and increments version with a version predicate;
10. commits all registry-side changes together.

Any validation or write error rolls back. A repeated identical completion request for the same execution should return an explicit idempotent duplicate result only if the persisted evidence digest and all bindings match exactly. A conflicting result must reject and preserve the existing record for reconciliation.

Do not hold a SQLite write transaction while calling the provider or performing signature/network verification. Verification can take time and fail independently; the final short transaction must recheck the state/version and bindings because the execution may have changed during verification.

## 5. Schema migration strategy

- Add an explicit schema version table or equivalent migration ledger.
- Make migrations transactional where SQLite supports it.
- Preserve existing execution rows and their state/version values.
- Never backfill old rows to SUCCEEDED based on adapter response or audit events.
- Add foreign keys and indexes intentionally; verify SQLite foreign-key enforcement on every connection if relied upon.
- Add uniqueness constraints for attempt IDs and evidence replay identity.
- Test opening a new database, upgrading a database with existing rows, interrupted migration, duplicate evidence insertion, rollback, and old-version compatibility.
- Back up before migration; document downgrade behavior. If safe downgrade cannot preserve new evidence records, prefer forward recovery rather than destructive rollback.

## 6. Attempt identity and dispatch ordering

A stable idempotency key identifies the logical execution request, not a specific provider attempt. Every permitted attempt needs a unique attempt ID. The attempt ID must be durably reserved before entering the external dispatch boundary. If a process crashes after that reservation, the attempt is uncertain even if no response was recorded.

Automatic retry must remain disabled while the result is uncertain unless provider-side idempotency semantics or a read-only reconciliation procedure are documented and verified. Local SQLite uniqueness cannot guarantee exactly-once effects in a remote system.

## 7. Test-first implementation sequence

1. Add isolated tests for attempt reservation, attempt ID uniqueness, and unchanged behavior of existing rows.
2. Add evidence schema validation tests: required fields, canonical digest, secret redaction, unsupported versions and malformed source metadata.
3. Add tests proving caller-created data and `verified=True` cannot mark success.
4. Add controlled verifier-registry tests: unknown/disabled verifier and policy versions fail closed.
5. Add atomic registry tests for state/version mismatch, request binding mismatch, evidence replay, duplicate identical evidence, conflicting evidence and rollback on insert/update/commit failure.
6. Add concurrency tests in which two completions race on the same expected version; at most one may commit a state transition.
7. Add crash/fault-injection tests around attempt reservation, provider effect, evidence verification and registry commit.
8. Add one provider-specific verifier only after its authentication and completion semantics are documented.
9. Run the full CI workflow and inspect commit-specific results. An empty status list is not a pass. Do not claim a red-green-refactor cycle unless the failing test was observed in an actual test run.

## 7A. Current validator limitations found during code review

The current `validate_completion_evidence` function is a useful structural gate, but it is not yet a trusted completion boundary:

- It accepts a caller-supplied verifier callable and verifier ID. Production composition must resolve these from a controlled, versioned allowlist; user or mission payloads must not select arbitrary callables.
- The evidence envelope does not yet bind integration ID, adapter version, provider ID, target resource, verifier version, or policy version. These must be compared against persisted attempt metadata and trusted configuration before completion.
- The verifier sees a receipt-shaped envelope, but authenticity and operation semantics remain the verifier's responsibility. A generic callback returning `True` is only suitable for a unit-test fixture, never production wiring.
- The timestamp check verifies ISO-8601 syntax and timezone awareness only. It does not establish clock trust, freshness, monotonic ordering, or resistance to replay.
- Evidence is hashed but not persisted or consumed. The same receipt can therefore be re-presented unless the future registry operation adds provider-scoped replay identity and uniqueness.
- A `VerifiedEvidence` dataclass is not itself a security token. Python callers can construct one directly; the registry must not trust an instance merely because its type matches.

These limitations are acceptance blockers, not reasons to remove the existing fail-closed guard on `SUCCEEDED`.

## 7B. Required negative tests before registry integration

Before implementing the atomic completion method, tests should prove that:

1. malformed or timezone-naive timestamps are rejected before the verifier is invoked;
2. blank or unapproved verifier IDs fail before evidence verification;
3. a different mission, contract, payload, attempt, provider, integration, adapter version, or target resource is rejected;
4. a verifier result other than the literal boolean `True` is rejected;
5. a valid-looking receipt cannot be accepted twice for conflicting execution keys;
6. concurrent completion attempts with the same expected version cannot both commit;
7. a database failure between evidence insertion and state update rolls back both changes;
8. stale verification results cannot complete an execution after its state/version changes.

The existing generic `transition(..., target=State.SUCCEEDED)` must remain blocked until these tests run successfully in observed CI.

## 8. Acceptance conditions before enabling success

- The provider-specific completion predicate is explicit and terminal.
- Evidence is authenticated and bound to the exact attempt and immutable request.
- Verifier configuration is controlled, versioned, and revocable.
- Evidence metadata and SUCCEEDED transition are atomic within the registry boundary.
- Stale versions and replay are rejected.
- Generic state transition still rejects SUCCEEDED.
- All applicable negative, concurrency, migration and fault-injection tests pass in observed CI.
- Independent review confirms the verifier does not merely trust adapter/model claims.

Until all conditions are evidenced, keep the feature at prototype maturity and leave SUCCEEDED disabled.
