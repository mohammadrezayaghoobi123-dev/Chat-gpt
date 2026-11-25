# Attempt Boundary Receipt Contract

## Status

Design contract only. This document does not implement a production signer, verifier, reservation backend, or effect ledger. The in-memory reference adapter is a conformance oracle and must not be described as cryptographic or durable.

## Security objective

An effect-ledger `OUTCOME` must not be appendable merely because an `INTENT` exists. It is admissible only when the reservation authority has durably committed the corresponding single-use attempt boundary and the caller supplies a receipt that the ledger independently verifies against that committed boundary.

The receipt is a proof of a committed authorization transition, not proof that the external effect succeeded. External-effect evidence remains a separate required input to `appendOutcome`.

## Canonical receipt payload

The signed payload is a versioned, canonical, domain-separated structure containing:

- `receipt_schema_version`
- `protocol_version`
- `authority_id`
- `signing_key_id`
- `reservation_key_digest` (digest of the canonical immutable tuple: repository ID, PR number, head SHA, base SHA)
- `stage` (`MODEL` or `COMMENT`)
- `attempt_id`
- `request_digest` (model request digest or comment payload digest)
- `generation`
- `committed_record_version`
- `boundary_event_id` (unique, persisted with the transition)
- `issued_at` (reservation-authority time)
- `purpose` (fixed domain separator such as `9router-attempt-boundary-v1`)

The signature/MAC is computed over the canonical serialization of every payload field, including the domain separator. Unknown versions, fields with ambiguous canonicalization, duplicate fields, missing fields, and non-canonical encodings are rejected. The receipt must not expose secrets or signing material.

## Issuance and durable commit ordering

For each MODEL or COMMENT attempt:

1. The effect ledger durably appends the immutable INTENT and returns a verifiable acknowledgement.
2. The reservation authority validates current owner, nonce, generation, lease, expected record version, stage, attempt ID, request digest, and the exact INTENT acknowledgement.
3. The reservation authority constructs a unique boundary event ID and the receipt payload against the exact next record version. It signs/MACs the payload using authority-held key material that is unavailable to the caller.
4. In one linearizable/serializable reservation transaction, it consumes the one-time state transition and persists the attempt fields, boundary event ID, receipt payload, signature/MAC, and incremented record version. The transaction must fail atomically on a stale version, wrong owner, expired lease, duplicate attempt, or already-consumed state.
5. The authority returns the receipt only after the durable commit is acknowledged. No model/provider call or GitHub comment POST may occur before this acknowledgement.
6. If the response is lost after commit, a read-only recovery operation returns the exact persisted receipt for the exact key, stage, and attempt ID. It must not create a new boundary, increment generation/version, or issue another permit. A repeated begin call returns `ALREADY_CONSUMED`.
7. If commit outcome is ambiguous, the caller performs no external effect. It may read authoritative state and recover the already-committed receipt; absence or incomplete reads are not proof that the transaction did not commit.

The receipt must be persisted as part of the same atomic record transition. A design that commits the attempt first and later stores the receipt in a separate non-atomic write is not conformant: it creates a crash window in which the boundary is consumed but cannot be proven or recovered.

## Ledger verification

`appendOutcome` must require `attemptBoundaryReceipt` and reject missing, malformed, or unverifiable receipts before any append or sequence/watermark mutation.

Verification must independently:

1. Validate the canonical serialization and supported schema/protocol versions.
2. Verify the signature/MAC using a trusted authority key selected by `authority_id` and `signing_key_id`.
3. Resolve the INTENT by immutable attempt ID and compare its canonical reservation key digest, stage, attempt ID, and request digest to the receipt.
4. Verify the receipt's generation and committed record version against independently obtained authoritative reservation evidence, or validate an authority-signed receipt whose issuance policy guarantees those fields were committed. A caller-supplied object or caller-asserted record version is never authoritative.
5. Reject cross-key, cross-stage, cross-attempt, cross-request, cross-generation, cross-version, cross-authority, altered-event-ID, altered-schema, altered-purpose, and altered-signature replays.
6. Enforce one OUTCOME per attempt ID with immutable payload equality on idempotent replay.

The ledger must not accept a receipt merely because the caller copied the expected values into a JSON object. The verification trust root and the authority identity binding must be configured out-of-band and must fail closed if unavailable.

## Key management and compromise assumptions

- Signing/MAC keys are held only by the reservation authority or a dedicated signing boundary; never by workflow callers or the effect-ledger caller.
- Prefer asymmetric signatures when the ledger verifier must validate receipts without possessing minting capability. If a MAC is used, explicitly document that every verifier holding the MAC key can also mint receipts.
- The verifier maintains a pinned authority identity and key set. Unknown keys and unknown authorities fail closed.
- Rotation retains old verification keys for at least the maximum receipt/audit retention period. Rotation changes the signing key ID but does not change the reservation key, attempt ID, or marker identity.
- Key revocation/compromise requires a defined quarantine and historical revalidation policy. A valid signature does not protect against a compromised signing authority or a compromised trusted root.
- Authority compromise, verifier compromise, signing-key compromise, or untrusted rollback of both reservation state and its independent evidence source are outside the guarantee and require `RECOVERY_LOCKED` plus independent investigation.

## Recovery API contract

`readAttemptBoundaryReceipt({ key, stage, attemptId })` is read-only and returns one of:

- `ACK` with the exact persisted receipt when the authoritative record proves the matching committed attempt.
- `NOT_FOUND` only when a complete authoritative read proves no matching committed boundary exists.
- `UNKNOWN` when the read is incomplete, unavailable, stale, or ambiguous.
- `INTEGRITY_CONFLICT` when record fields and persisted receipt disagree.
- `RECOVERY_LOCKED` while recovery quarantine is active.

It must never mint a new boundary or infer success from an absent result in an incomplete read. Repeated reads of an unchanged committed record return byte-for-byte equivalent receipt payload and signature.

## Failure semantics

| Failure point | Required disposition |
| --- | --- |
| INTENT append is not durably acknowledged | No reservation transition and no external effect |
| Reservation transaction definitely aborts | No receipt and no external effect |
| Reservation transaction outcome is ambiguous | No external effect; read authoritative state; unresolved state remains UNKNOWN |
| Reservation commit succeeds but response is lost | Recover the same persisted receipt; do not reissue permit |
| Receipt missing/invalid/forged/replayed | Reject OUTCOME without changing ledger sequence or watermark |
| Outcome append acknowledgement is lost | Reconcile the same immutable attempt/event; do not create a new attempt |
| External effect outcome is ambiguous | Preserve stage-specific UNKNOWN; do not infer success from a negative read |

## Reference-oracle limitations

The current `createReferenceSystem` is an in-memory, single-process model. Its JSON digest and Maps are not cryptographic integrity, linearizable distributed storage, a trusted timestamp, a crash-safe journal, or an independent trust domain. Tests against it can validate state-machine behavior and rejection paths only. Production qualification requires a concrete backend and independent fault-injection tests covering transaction commit/ack loss, process crashes, cross-process races, key rotation, authority compromise assumptions, storage rollback, and incomplete reads.

## Required conformance before implementation is considered GREEN

- T48: missing receipt rejected before ledger mutation.
- T49: exact receipt accepted; every field mutation and cross-binding replay rejected with unchanged ledger watermark.
- T50: lost boundary acknowledgement recovers the exact persisted receipt; repeated recovery is stable; second begin cannot issue a second permit.
- Additional required cases: COMMENT-stage receipt; receipt replay against a different INTENT; stale generation/version; unknown/revoked key; invalid signature; unsupported schema/protocol; receipt/record mismatch; incomplete recovery read; authority unavailable; rotation with old receipt verification; no receipt leakage in logs.
- Full T01–T50 suite and reviewer regression must be run after implementation. The preserved duplicate-publication concurrency test remains RED until a real atomic reservation backend prevents the tested two-runner interleaving. No test may be weakened to obtain GREEN.
