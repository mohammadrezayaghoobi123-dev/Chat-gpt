# Provider Completion-Verifier Contract

Status: **design contract only — no production provider integration is implemented**.

This document defines the evidence a provider-specific verifier must establish before Master Brain may persist a completion receipt or move an execution to `SUCCEEDED`. It is not proof that any provider currently satisfies these requirements.

## Trust boundary

- The verifier implementation and its configuration are application/deployment-owned. Mission input, provider response bodies, URLs, and user-controlled fields must never select Python modules or executable verifier code.
- `ConfiguredVerifierRegistry` is an allowlist, not a sandbox. Importing a verifier executes Python with the process's privileges. Deployment must control package provenance, filesystem permissions, dependency versions, startup environment, and secret access.
- The current fixed import path `master_brain.deployment_verifiers` intentionally fails closed when absent. Do not add a permissive default verifier or treat a receipt-shaped JSON object as proof.
- The current local SQLite registry is a single-host coordination primitive, not exactly-once external execution and not a substitute for provider-side idempotency.
- Verification runs before the SQLite writer lock to avoid holding a database write lock across provider I/O. Concurrent callers can therefore invoke the verifier more than once for the same evidence. Verifiers must be read-only with respect to the external operation: they may query authoritative state, but must not trigger, retry, or mutate the provider operation. The provider's idempotency mechanism—not this verifier callback—must protect any operation submission path.

## Required verifier decisions

A verifier used only for validation may return literal Python `True` after independently establishing all applicable items below. A verifier authorizing durable completion must instead return a validated `ProviderVerificationResult` containing `verified=True` and the canonical provider ID, trusted scope, receipt namespace, and canonical receipt ID. A bare boolean cannot authorize durable completion because it carries no scoped identity. Any missing, ambiguous, malformed, or untrusted input must reject or raise an exception (which the caller treats as failure).

1. **Authenticity:** establish that the evidence originated from the claimed provider using its documented authenticated API, cryptographic signature, or another provider-documented mechanism. Never trust an unverified callback body, caller-supplied URL, or display text.
2. **Provider and environment binding:** verify the expected provider, tenant/account, project, environment, and resource scope. Do not accept a receipt from a test tenant as evidence for production.
3. **Operation semantics:** query or verify authoritative provider state and confirm the exact operation actually completed with the expected result. A generic HTTP success, accepted/queued response, or receipt identifier alone is insufficient.
4. **Request binding:** bind evidence to the exact execution attempt, idempotency key (where supported), operation/resource identifier, and immutable request/contract/payload digests. Compare values to trusted locally persisted values, not values copied from the evidence itself.
5. **Freshness and replay:** validate provider timestamps and documented nonce/sequence semantics where available. A local timestamp supplied by the caller is not proof of provider time. Persist receipt identity/digest atomically; reject evidence reused for another attempt or execution. Exact retries may be idempotent only when the previously committed evidence and verifier identity/version match exactly.

   **Current implementation boundary:** the core SQLite registry persists `(provider_id, provider_scope, receipt_namespace, provider_receipt_id)` and enforces uniqueness for complete scoped identities across execution keys. The trusted scope must already be present on the locally reserved attempt and must agree with the typed verifier result; evidence cannot choose its own scope. Legacy receipts remain unscoped and are not retroactively replay-protected. This core constraint is not production provider-backed replay protection until a real deployment-owned verifier and trusted scope configuration are implemented, reviewed, and tested. Do not add a global uniqueness constraint on bare receipt IDs: identifiers may only be unique within a provider account, project, or environment.
6. **Transport and secrets:** use authenticated TLS with normal certificate verification; never disable TLS validation. Keep credentials out of logs, exception messages, evidence records, and repository history. Apply least privilege and bounded network timeouts.
7. **Failure behavior:** network errors, timeouts, rate limits, malformed responses, signature errors, unknown provider states, and verifier exceptions must never imply success. If the external outcome is ambiguous, retain an uncertain/reconciliation state and require authoritative reconciliation.

## Required adversarial test matrix

Before enabling any real integration, tests must exercise the actual provider-specific verifier against documented fixtures and, where safe, a provider sandbox:

- valid authenticated evidence for the exact operation;
- altered signature/body, wrong tenant/environment, wrong provider, wrong resource, wrong operation, and mismatched request digest;
- missing, expired, future-dated, malformed, or timezone-naive provider timestamps;
- duplicate/replayed receipt, receipt from a different attempt, and exact idempotent retry;
- pending/accepted/failed/cancelled states that must not count as completed;
- provider timeout, connection failure, rate limiting, invalid JSON/schema, and verifier exception;
- concurrent completion attempts and a state change while verification is in flight;
- assertion that every rejection leaves execution state and completion receipts unchanged;
- secrets absent from logs and surfaced errors.

Tests must distinguish provider behavior from mocks. A mock can test caller fail-closed behavior, but cannot establish provider authenticity or semantics.

## Enablement gate

Do not enable external actions until all of the following are reviewed and evidenced:

- a named provider and exact API/receipt contract are selected;
- documented authenticity and operation-semantics checks are implemented;
- credentials and deployment configuration are provisioned securely outside the repository;
- provider-specific positive and negative tests are added;
- focused and full CI pass on the exact commit;
- a security review confirms the deployment module and dependencies are trusted;
- operational rollback, timeout, reconciliation, audit, and secret-rotation procedures exist.

Until then, keep `deployment_verifiers` absent and the production completion path fail-closed. Passing local unit tests alone does not establish a real external integration.
