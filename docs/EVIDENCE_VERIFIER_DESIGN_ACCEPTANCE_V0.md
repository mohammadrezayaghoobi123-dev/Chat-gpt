# Evidence Verifier Design and Acceptance Plan — V0

## Status

Design-only companion to `COMPLETION_EVIDENCE_CONTRACT_V0.md`. This document does not implement verification, change registry transitions, or authorize external execution. Generic transitions to `SUCCEEDED` remain blocked.

## Architectural boundary

Separate four objects that must not be conflated:

1. **Raw evidence**: untrusted bytes or provider response plus acquisition metadata.
2. **Verification result**: output produced only by a configured verifier implementation after checking provider semantics and request binding.
3. **Verified evidence reference**: immutable, server-minted reference to the raw evidence digest, verification result, verifier build/version, and policy version.
4. **Terminal registry decision**: compare-and-swap state transition that consumes the verified reference and records it alongside the terminal state.

A caller, model, adapter, or deserialized JSON field must not be able to manufacture the verified-evidence reference by setting a Boolean or status string. In-process type checks alone are not a security boundary if untrusted code can import constructors or mutate storage.

## Trust model and assumptions

The future verifier must explicitly document:

- which provider identity and API endpoint are trusted;
- how credentials are obtained, scoped, rotated, and excluded from logs;
- which provider response fields prove the contract's completion predicate;
- whether evidence is signed, authenticated through a trusted read-only API, or otherwise authenticated;
- what provider-side consistency delay or eventual consistency means for a negative lookup;
- how revocation, deletion, permission changes, and provider outages are handled;
- how verifier code and policy versions are approved and disabled;
- which clock is trusted and what freshness window means;
- what storage and operator privileges can alter evidence or registry records.

If an assumption cannot be established, verification must fail closed or return an explicitly unresolved result.

## Minimum evidence envelope

The canonical envelope must bind:

- schema version;
- mission ID;
- immutable contract digest;
- canonical payload digest and canonicalization version;
- stable idempotency key digest or protected key reference;
- unique attempt ID;
- integration ID, adapter version, provider ID;
- provider operation/receipt ID, when supported;
- evidence type and provider-specific completion predicate ID;
- raw evidence digest and immutable evidence reference;
- observed-at value, source, timezone/clock trust and uncertainty;
- verifier identity, build/version, policy version;
- decision, decision reason code, and verification timestamp.

Canonicalization must be deterministic and versioned. Use a cryptographic digest such as SHA-256 for integrity correlation, but never claim a digest alone authenticates the provider or proves the effect occurred. Avoid persisting credentials, bearer tokens, or secret provider response fields in the envelope.

## Verification outcomes

Use a closed enumeration rather than free-form statuses:

- `VERIFIED_COMPLETE`: authenticated evidence establishes the exact terminal predicate.
- `VERIFIED_TERMINAL_FAILURE`: provider semantics establish a terminal failure and rule out a successful side effect, if the contract requires that distinction.
- `PENDING_PROVIDER`: provider confirms acceptance/queueing but not completion.
- `NOT_FOUND_INCONCLUSIVE`: absence may be caused by eventual consistency, permissions, wrong query, or delayed visibility.
- `MISMATCH`: request, target resource, provider operation, or postcondition does not match.
- `UNAUTHENTICATED`: source authenticity could not be established.
- `STALE_OR_REPLAYED`: evidence is outside the allowed window or was already consumed inconsistently.
- `VERIFIER_UNAVAILABLE`: dependency or verifier could not complete safely.
- `MALFORMED`: required fields are missing, invalid, or contradictory.

Only `VERIFIED_COMPLETE` may be considered for `SUCCEEDED`, and only through the evidence-aware atomic API. All other outcomes remain non-success terminally or unresolved according to explicit policy; none authorizes a blind retry by itself.

## Atomic commit protocol

Preferred single-SQLite-database path:

1. Acquire a transaction with write serialization.
2. Load the execution record and compare the expected key, mission, contract digest, payload digest, attempt ID, state, and version.
3. Validate that the verifier result was minted by the configured verifier path and that its evidence binding exactly matches this record.
4. Insert an immutable evidence row with a uniqueness constraint on evidence identity/consumption scope.
5. Update the execution row using compare-and-swap conditions on key, prior state, version, and digests.
6. Commit both changes in the same transaction.
7. If any validation, insert, update, or commit fails, do not report success. On uncertain commit outcome, read back by stable operation/evidence identity and reconcile; do not redispatch.

A verified-evidence token should be unforgeable outside the trust boundary or, preferably, replaced by a database lookup of a server-created verification record. Do not rely on a publicly constructible dataclass as authorization.

If evidence is stored externally, use a durable outbox/reconciliation protocol and define recoverable intermediate states. Do not claim a distributed atomic transaction unless the storage systems actually provide one.

## Replay, concurrency, and idempotency

- Identical evidence for the same execution may be idempotently acknowledged only if the existing committed binding matches exactly.
- Evidence bound to another mission, payload, attempt, provider, or contract must be rejected.
- Conflicting evidence for an already consumed execution must trigger reconciliation, not overwrite the first record.
- A stale registry version must fail without mutating either evidence consumption or state.
- The local idempotency key prevents duplicate local claims only. Remote exactly-once behavior requires documented provider-side idempotency or safe reconciliation.
- A new local key must not bypass an unresolved prior attempt for the same intended external effect.

## Required test matrix

### Positive cases
- authenticated evidence matches the exact contract and payload;
- correct evidence can be committed once;
- identical retry of an already committed completion returns the same result without duplicate mutation.

### Negative and adversarial cases
- caller-supplied `verified=true` or a forged result object;
- wrong mission, contract digest, payload digest, key, attempt, provider, resource, or operation ID;
- malformed canonical data and digest mismatch;
- invalid signature or untrusted API endpoint;
- unknown/disabled verifier or policy version;
- expired, revoked, replayed, or conflicting evidence;
- provider accepted/queued but postcondition is not complete;
- eventual-consistency `not found` incorrectly treated as failure;
- stale expected version and concurrent completion attempts;
- evidence insert succeeds but state update fails;
- state update fails or commit outcome is ambiguous;
- process crash before commit and after commit but before response;
- evidence store unavailable and registry unavailable;
- secrets present in provider responses do not leak into logs or evidence envelope.

### Properties to assert
- No path reaches `SUCCEEDED` without the evidence-aware API.
- Invalid evidence causes no terminal state mutation.
- State and evidence reference commit together or are recoverably reconciled.
- No ambiguous result triggers automatic redispatch.
- Audit records identify actor, decision, evidence digest, verifier build, policy version, and prior/new record versions without logging secrets.

## Definition of done

The feature is not done until:

1. the contract and threat model are reviewed;
2. a concrete verifier trust root is configured;
3. the evidence-aware API is the only path to `SUCCEEDED`;
4. evidence persistence and state transition are atomic or covered by a tested durable recovery protocol;
5. the complete test matrix runs in CI and results are inspected;
6. fault-injection tests cover commit ambiguity and process crashes;
7. operator recovery instructions and limitations are documented;
8. external execution remains disabled for consequential operations until provider-specific verification is proven.

## Explicit non-claims

This design document alone does not provide a trusted clock, provider authenticity, cryptographic signatures, tamper-proof audit storage, multi-host coordination, distributed exactly-once effects, or production readiness. Those must be implemented and independently verified.
