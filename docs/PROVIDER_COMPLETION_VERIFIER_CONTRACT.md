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

## Trusted attempt-scope boundary

The SQLite `reserve_attempt` method is a low-level persistence primitive. Its
`provider_scope` and `receipt_namespace` arguments are not independently
authenticated merely because they are non-empty strings; production callers
must not pass values derived from mission, request, or provider evidence input.

Use `master_brain.attempt_configuration.reserve_configured_attempt` at the
deployment boundary. It accepts only the approved integration/version/provider
tuple, loads scope and namespace from the fixed application-owned module
`master_brain.deployment_attempt_config`, and fails closed if that module is
missing, malformed, ambiguous, or unavailable. The module must define a
non-empty `ATTEMPT_SCOPE_DESCRIPTORS` tuple/list of validated
`AttemptScopeDescriptor` entries. The module is intentionally not checked into
the repository: no real provider, account, environment, or namespace has been
selected yet.

The lower-level `reserve_attempt` remains available as a core persistence seam
for focused unit tests and internal primitives, not as a production
authorization boundary. Python module imports execute configuration code, so
the deployment module and dependencies must be reviewed and controlled as
trusted application code; this loader is not a sandbox. The configuration
boundary supplements but does not replace provider-specific authentication,
receipt verification, scope binding, or the existing fail-closed completion
verifier gate.

## Runtime adoption status (important limitation)

The configured reservation helper is a guarded API boundary, not proof that all
runtime paths already use it. In this repository revision, the current
application orchestration modules reviewed (`integrated_runtime.py`,
`core.py`, and `demo.py`) do not call either reservation method. The
provider-dispatch path is therefore not yet wired to this helper. When that
path is implemented, it MUST call `reserve_configured_attempt` before any
external dispatch and MUST NOT expose caller-controlled `provider_scope` or
`receipt_namespace`. Add an integration test at that call site before
enabling any provider-backed operation. Until then, the helper's unit tests
verify the boundary in isolation only; they do not establish runtime
enforcement.

## Injected executor boundary

The current `integrated_runtime.execute_mission` accepts an in-process mapping
of Python callables for specialist islands. That mapping is an injection point,
not a sandbox, permission system, or proof that a callback is analysis-only.
Python callbacks execute with the process's privileges and can have side
effects; the runtime cannot infer or enforce purity from the callable's type.

Until a separately reviewed action broker exists, register only trusted,
reviewed analysis-only executors in this mapping. Do not register payment,
purchasing, messaging, deployment, filesystem mutation, or other external-action
adapters here—even for low- or medium-risk missions. The high/critical mission
gate is a policy check, not a containment boundary against a malicious or
misconfigured callback.

Any future provider-backed action path must be explicit and separate: authorize
the requested capability, apply any authenticated/digest-bound approval policy,
reserve the attempt through the trusted deployment-owned scope configuration,
persist the dispatch boundary conservatively, use provider-side idempotency,
and verify the resulting provider state through the fixed fail-closed verifier
registry before recording durable completion. Add tests at that actual call site;
unit tests for the reservation helper alone do not prove these controls are wired.
