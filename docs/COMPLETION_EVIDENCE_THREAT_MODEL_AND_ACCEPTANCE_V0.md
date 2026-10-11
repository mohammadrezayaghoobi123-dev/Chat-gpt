# Completion Evidence Threat Model and Acceptance Criteria — V0

## Status

**DESIGN / REVIEW GATE ONLY.** This document does not implement a verifier, enable `SUCCEEDED`, authorize dispatch, or claim production readiness. The generic registry transition to `SUCCEEDED` MUST remain blocked until the implementation and tests satisfy the acceptance criteria below.

Scope: provider-neutral evidence boundary for the existing Master Brain execution registry and mission-execution pipeline. Provider-specific authentication and postcondition semantics remain separate integration work.

## 1. Security objective and explicit non-objectives

### Objective

Allow an execution to enter `SUCCEEDED` only when a controlled verifier has validated evidence that satisfies the exact completion predicate for the exact reserved execution, and the registry has atomically persisted the evidence reference/digest with a version-checked state transition.

### Non-objectives for V0

This design alone does not provide:
- proof that a provider's statement is truthful;
- trusted time, identity, signature verification, or secure key custody;
- exactly-once external effects or a distributed transaction;
- tamper-proof local storage or protection against a host administrator rewriting the database;
- a universal definition of completion for every provider;
- production readiness or permission to enable a success path.

A digest establishes correspondence to bytes under a specified canonicalization and hash algorithm; it does not establish source authenticity or truth.

## 2. Trust boundaries

1. **Mission caller / model / adapter response — untrusted for completion.** Any of these may supply claims or references, but cannot mint verified evidence.
2. **Evidence acquisition — provider-specific.** Obtains raw evidence through a documented authenticated channel or validates a provider-signed receipt. A transport status such as HTTP 2xx is not automatically terminal completion.
3. **Trusted verifier — controlled implementation.** A registry of explicitly enabled verifier implementations resolves `verifier_id` and version; verifies the evidence source, schema, freshness/replay rules, request binding, and provider-specific completion predicate. Unknown or disabled versions fail closed.
4. **Registry persistence — local atomicity boundary.** A SQLite transaction validates current state/version and request binding, records an immutable evidence reference/digest and verifier/policy metadata, and transitions state. It does not independently authenticate the provider.
5. **Audit log — diagnostic evidence, not the source of truth for provider completion.** An audit event cannot substitute for verifier output or registry transaction.
6. **Operator / recovery workflow — no direct success override.** Human review may trigger a documented reconciliation procedure, but a free-form operator assertion cannot call the generic state transition to `SUCCEEDED`.

## 3. Proposed provider-neutral interfaces

Treat the following as conceptual contracts, not implemented Python APIs.

### Raw evidence

Raw evidence is data from an authenticated provider query, signed receipt, or other documented source. It must have a bounded size, explicit schema/version, source identity, and a non-secret immutable reference or canonical bytes. Credentials, access tokens, and secret headers must never be persisted in evidence records or audit events.

### Verifier registry

A controlled registry maps an approved `(verifier_id, verifier_version, policy_version)` tuple to a verifier implementation and its trust configuration. Callers may request a verifier by identifier but cannot pass an arbitrary verifier object into a public success API unless the application has explicitly designated that injection point as a trusted composition boundary. Production composition must not derive trust from caller-controlled metadata.

The verifier returns either:
- a **verification rejection** with a bounded machine-readable reason; or
- an internally issued verification result containing the exact execution binding, evidence digest/reference, verifier identity/version, policy version, and verification timestamp/source.

A Python dataclass, enum, boolean, or opaque-looking token is not cryptographic proof. The trust comes from controlling who can invoke the verifier and from the verifier's actual validation. Avoid a public constructor or caller-controlled `verified=True` field as an authorization mechanism.

### Atomic registry operation

The future success operation must accept a verification result only across a controlled internal boundary and, in one SQLite transaction:
1. begin an immediate write transaction;
2. load and validate the execution record;
3. compare expected state and version;
4. compare mission ID, contract digest, payload digest, idempotency key, attempt ID, integration/adapter identity, and provider identity to the reserved execution;
5. validate the evidence digest/reference and verifier/policy versions against the controlled verification result;
6. enforce evidence replay/consumption uniqueness;
7. persist evidence metadata;
8. update state to `SUCCEEDED` with compare-and-swap semantics;
9. commit, or roll back every registry-side change.

Do not call remote providers while holding the SQLite write transaction. Verify first, then perform a short transaction that rechecks all mutable bindings and expected version. If evidence is stored outside SQLite, use a durable reconciliation/outbox protocol and do not claim success until evidence persistence and registry state are reconciled.

## 4. Evidence binding requirements

A verified result must bind to all applicable values:
- schema version;
- mission ID;
- immutable contract digest;
- canonical payload digest;
- idempotency key;
- unique dispatch attempt ID;
- integration ID and adapter version;
- provider ID and target resource identity;
- provider operation/receipt ID where available;
- evidence type and immutable evidence digest/reference;
- observed-at time plus stated clock/source trust;
- verifier ID/version and verification-policy version;
- exact completion predicate / postcondition version.

Every digest must specify canonical serialization and algorithm. Never use ordinary string concatenation with ambiguous boundaries as a digest encoding. Secret material must not be included in canonical evidence payloads or hashes unless a separately reviewed design explicitly requires it.

## 5. State-machine constraints

- `PENDING -> RUNNING`: dispatch has been claimed; it does not mean the provider was reached.
- `RUNNING -> OUTCOME_UNKNOWN`: a response, timeout, crash, or persistence failure leaves external outcome uncertain.
- `OUTCOME_UNKNOWN -> RECONCILIATION_REQUIRED`: evidence checks could not safely resolve the result.
- `RUNNING/RECONCILIATION_REQUIRED -> SUCCEEDED`: only through the future evidence-aware atomic operation.
- `FAILED` after the dispatch boundary requires evidence that the operation is terminally failed and the contract's side-effect semantics are satisfied. Generic transitions must not infer failure from exceptions, timeouts, missing receipts, or elapsed time.
- Generic `transition(..., target=SUCCEEDED)` remains prohibited.
- Duplicate submission of the same evidence for the same execution is idempotent; conflicting evidence or a different binding must reject and may require reconciliation.
- Local idempotency is not remote exactly-once delivery. No automatic redispatch of an uncertain operation without provider-documented idempotency or verified safe reconciliation.

## 6. Threat and failure analysis

| Threat / fault | Required behavior | Minimum test |
|---|---|---|
| Caller sets `verified=True` or constructs a claimed verified record | No success transition | Public API rejects caller-asserted trust |
| Evidence for another mission or contract | Reject; preserve current state | Mismatch matrix for mission/contract |
| Payload or idempotency key mismatch | Reject; preserve current state | Wrong digest/key tests |
| Stale or different attempt | Reject or reconcile; never accept as current completion | Attempt-binding test |
| Wrong provider, integration, adapter or target resource | Reject | Identity/resource mismatch tests |
| HTTP accepted/queued but not terminal | Do not mark success unless contract explicitly defines that state as completion | Nonterminal-provider-status test |
| Forged/unauthenticated receipt | Reject | Invalid signature or unauthenticated source test for a concrete verifier |
| Unknown/disabled verifier or policy version | Fail closed | Registry-resolution test |
| Stale, expired, revoked or replayed evidence | Reject or reconcile | Freshness/replay/revocation tests |
| Two concurrent verifications use the same version | At most one versioned state transition succeeds | Concurrent CAS test |
| Same evidence submitted twice | Idempotent for same execution; no second state mutation | Duplicate-evidence test |
| Conflicting evidence for same execution | Reject and preserve evidence history; require reconciliation | Conflicting-evidence test |
| Registry write fails | No reported success; transaction rolls back | Fault injection at each write/commit boundary |
| Evidence store is external and unavailable | No success until durable reconciliation | Store outage / partial commit test |
| Process crashes after remote effect but before local commit | Outcome remains unknown; no blind retry | Crash-window recovery test |
| Verifier returns malformed/incomplete data | Reject; preserve state | Schema and required-field tests |
| Caller timestamp is offset-aware but false | Do not treat formatting as trusted time | Document trust limitation; provider timestamp policy test |
| Local database is rewritten by privileged host actor | No claim of tamper-proof audit | Threat-model documentation and external-anchor requirement |

## 7. Acceptance gates

### Gate A — design review

- [ ] Exact completion predicate is defined per provider operation.
- [ ] Trust owner and configuration source for each verifier are documented.
- [ ] Canonical serialization, digest algorithm, evidence retention and secret-redaction policy are specified.
- [ ] State transitions and retry/reconciliation semantics are reviewed.
- [ ] No generic or caller-controlled success override exists.

### Gate B — implementation review

- [ ] Public API cannot accept caller-supplied booleans or arbitrary evidence objects as proof.
- [ ] Verifier resolution is controlled and fails closed for unknown/disabled versions.
- [ ] Evidence is bound to the exact request and attempt.
- [ ] Evidence metadata and `SUCCEEDED` are persisted atomically within the registry boundary.
- [ ] Compare-and-swap and replay controls are enforced under concurrent access.
- [ ] Errors do not leak credentials, raw provider bodies, or secrets.
- [ ] Generic `transition(..., target=SUCCEEDED)` remains blocked.

### Gate C — verification

- [ ] Negative tests cover every mismatch and failure row above that applies to the implementation.
- [ ] Concurrency tests establish one winning state transition for a version.
- [ ] Fault-injection tests cover pre-verification, post-verification/pre-commit, commit failure, and lost response windows.
- [ ] Full test suite and static checks are run in CI; commit-specific results are inspected rather than inferred from an empty status list.
- [ ] At least one concrete provider verifier is tested against documented provider semantics before claiming real external completion.
- [ ] Independent review confirms that the tests exercise actual trust boundaries rather than only happy-path dataclass construction.

### Gate D — production readiness

- [ ] Authentication, authorization, secret management, trusted time, rate limits, timeouts and provider API semantics are implemented.
- [ ] Recovery and reconciliation are operationally documented and exercised.
- [ ] Monitoring, evidence retention/deletion, privacy, audit integrity, and incident handling are reviewed.
- [ ] Any external evidence store has a durable consistency/reconciliation protocol.
- [ ] Rollback/disable path exists for verifier and policy versions.

Passing a gate requires observable evidence. A checklist or document alone does not satisfy a gate.

## 8. Implementation sequence

1. Review this threat model and resolve open decisions.
2. Add tests for the future evidence-aware registry API before enabling any success path. Record an observed failing test only when the test runner actually executes it.
3. Implement evidence persistence schema and atomic compare-and-swap operation while keeping the generic success transition blocked.
4. Implement controlled verifier registration/resolution and immutable verification results.
5. Add concurrency and crash/fault-injection tests.
6. Connect one provider-specific verifier only after its authentication and terminal completion semantics are documented.
7. Inspect CI results and review the final diff before changing maturity status.

## 9. Open decisions before implementation

- Evidence bytes live inside SQLite or in a separate immutable store with reconciliation?
- Which provider operation is the first concrete verifier target, and what authoritative postcondition can it read?
- What are the verifier trust root, secret-storage mechanism, trusted-time source, and version revocation mechanism?
- Is provider operation ID guaranteed unique, and what retention window applies to replay detection?
- What is the privacy/retention policy for evidence that may contain customer or business data?

Until those decisions are resolved or explicitly scoped out, keep the design at prototype maturity and keep `SUCCEEDED` disabled.
