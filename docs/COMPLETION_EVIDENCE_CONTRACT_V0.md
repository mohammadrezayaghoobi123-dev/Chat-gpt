# Completion Evidence Contract — V0

## Status and scope

Status: **DESIGN CONTRACT ONLY**. This document defines the minimum safety boundary for a future evidence-aware transition to `SUCCEEDED`. It does not implement a verifier, change registry behavior, or authorize external execution.

The generic `transition(..., target=SUCCEEDED)` MUST remain blocked until a trusted, provider-specific verifier and evidence persistence path are implemented and tested.

## Core rule

A model response, adapter return value, HTTP 2xx response, local audit event, operator assertion, or caller-supplied `verified=true` flag is not by itself proof that the intended external effect completed.

`SUCCEEDED` means only that a trusted verifier established the contract's explicitly defined completion predicate for the exact execution request. If the predicate cannot be checked, evidence is absent, stale, ambiguous, mismatched, unverifiable, or unavailable, the outcome MUST remain uncertain or require reconciliation.

## Required binding

A completion evidence envelope must bind, at minimum:

- `schema_version`: versioned evidence format.
- `mission_id`: exact mission identifier.
- `contract_digest`: digest of the immutable approved mission contract.
- `payload_digest`: digest of the canonical dispatched payload.
- `idempotency_key`: the local execution key.
- `attempt_id`: unique local dispatch attempt identifier.
- `integration_id` and `adapter_version`: identity of the selected integration implementation.
- `provider_id`: expected external system/provider.
- `provider_operation_id` or receipt reference: provider-issued correlation identifier, when the provider supports one.
- `evidence_type`: provider-specific evidence class; never free-form text alone.
- `observed_at`: timestamp from a documented source, with clock trust/uncertainty stated.
- `verifier_id` and `verifier_version`: the component that performed validation.
- `verification_policy_version`: the exact predicate/policy applied.
- `evidence_digest`: digest of the immutable evidence bytes or canonical evidence object.
- `result_reference`: non-secret pointer to the evidence record; never embed credentials or access tokens.

All digests must specify a canonical serialization and algorithm. A digest proves byte-level correspondence, not truth, source authenticity, or external completion.

## Trusted verification requirements

A provider-specific verifier must independently check the evidence against the provider's documented semantics. Depending on the integration, checks may include authenticated provider API reads, signed receipts, operation status, target resource identity, expected postcondition, and consistency with the original request.

The verifier must reject or quarantine evidence when:

1. the mission, contract, payload, attempt, provider, or operation binding does not match;
2. the source cannot be authenticated or its semantics are not documented;
3. the evidence is expired, replayed, revoked, or outside the allowed observation window;
4. the evidence reports only acceptance/queuing rather than the required terminal postcondition;
5. the target resource or resulting state does not match the mission contract;
6. the verifier or policy version is unknown or disabled;
7. required fields are missing, malformed, contradictory, or ambiguously interpreted.

A typed data structure is not a trust boundary by itself. Only a controlled verifier implementation with explicit trust configuration may mint a verified-evidence record. Callers must not be able to construct a record that bypasses verification merely by setting a status field.

## State interpretation

- `PENDING`: reserved, dispatch not yet claimed.
- `RUNNING`: dispatch claim exists; external effect may or may not have occurred.
- `OUTCOME_UNKNOWN`: the system cannot establish the outcome safely.
- `RECONCILIATION_REQUIRED`: automated evidence checks did not resolve the outcome or a human/provider-side review is required.
- `SUCCEEDED`: only after the trusted verifier validates evidence against the exact completion predicate and an atomic, version-checked registry operation persists the evidence reference and state transition.
- `FAILED`: only when the contract/provider semantics establish a terminal failure and rule out a successful side effect, or the failure is otherwise explicitly defined as terminal without side effect. A timeout or adapter exception alone is not sufficient.

No elapsed-time heuristic, process death, missing receipt, or retry budget may convert `RUNNING` or `OUTCOME_UNKNOWN` into success or safe-to-retry.

## Atomicity and replay controls

The future success API must atomically:
1. load and validate the current record;
2. compare expected state/version and request digests;
3. validate the verifier-issued evidence record and its binding;
4. reject evidence already consumed for a conflicting execution;
5. persist an immutable evidence reference/digest and verifier/policy versions;
6. transition to `SUCCEEDED` using compare-and-swap semantics.

If evidence storage and registry state cannot be committed in one transaction, use a durable reconciliation protocol; do not report success before both sides can be reconciled. Repeated submission of identical evidence for the same execution should be idempotent. Evidence bound to another attempt, payload, or mission must fail closed.

## Retry and external effects

Local idempotency prevents duplicate local reservations only. It does not guarantee exactly-once effects at a remote provider. Automatic redispatch of uncertain operations remains disabled unless the provider documents and the adapter verifies a provider-side idempotency mechanism or a safe reconciliation procedure. A provider timeout can occur after the provider has committed the effect.

## Required tests before implementation can enable SUCCEEDED

- evidence is bound to the exact mission, contract digest, payload digest, idempotency key, attempt, and provider;
- wrong or missing binding fields are rejected;
- untrusted caller-supplied `verified=true` cannot mark success;
- invalid signatures/authentication and unknown verifier/policy versions fail closed;
- stale, expired, replayed, or revoked evidence is rejected;
- accepted/queued status cannot satisfy a terminal-completion predicate unless the contract explicitly defines that as completion;
- evidence for the wrong resource or wrong postcondition is rejected;
- concurrent completion attempts with stale versions cannot overwrite each other;
- duplicate identical evidence is idempotent; conflicting evidence triggers reconciliation;
- registry/evidence-store failure never yields a false `SUCCEEDED`;
- ambiguous timeout or adapter exception never triggers blind redispatch;
- fault injection covers crashes before verification, after verification but before commit, and after persistence with lost response.

## Non-claims

This contract does not provide cryptographic authenticity, trusted time, provider integration, distributed transactions, tamper-proof storage, or production readiness by itself. Those properties require concrete implementation, threat modelling, and independently verified tests.
