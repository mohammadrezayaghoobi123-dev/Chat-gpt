# Mission Approval Trust Boundary — V0

**Status:** design constraint for the current prototype; not a production security guarantee.

## Purpose

Define exactly what the current approval code proves, what it does not prove, and the minimum boundary required before approval can authorize any real side effect.

## What the current code verifies

Given a readable audit file, the current implementation checks that:

- the approval event is present exactly once in the verified hash chain;
- the event type, subject, actor, timestamp, payload, and event hash match the receipt;
- the receipt is bound to the canonical digest and schema version of the current mission contract;
- missing, malformed, or changed audit history causes a fail-closed result.

These checks establish internal consistency relative to the audit file currently being read. They do not establish who originally created the event.

## Explicit non-guarantees

The following are **not** proved by `MissionApprovalReceipt`, a matching string subject, an authentication-method label, or a valid hash chain:

- that the named human actually authenticated;
- that the human intended to approve this exact contract;
- that the caller is authorized to approve this risk tier;
- that the audit file was not wholly rewritten by a party with write access;
- that the timestamp came from a trusted clock;
- that a successful policy result is permission to execute without a separate dispatch control.

The current `record_mission_approval` API accepts identity metadata as strings. Its docstring places authentication responsibility on the caller. A caller that bypasses that upstream boundary can record arbitrary metadata. This is a known trust-boundary gap, not a cryptographic identity proof.

## Required production design before side effects

1. **Authenticate outside the policy module.** Use a real identity provider/session verifier; never treat a caller-supplied subject string as proof.
2. **Authorize separately from authentication.** Check role, mission scope, risk tier, and any separation-of-duties rule.
3. **Bind consent to immutable content.** Present the canonical contract digest and meaningful human-readable summary to the approver; bind the authenticated decision to that exact digest, mission ID, policy version, and expiry/nonce.
4. **Create a verifiable approval assertion.** The trust adapter should produce a server-side verified principal/decision result from a validated identity-provider response. The caller must not be able to manufacture this result merely by constructing a local dataclass.
5. **Protect replay and revocation.** Use unique decision IDs/nonces, expiry, revocation checks, and idempotent consumption at the execution boundary.
6. **Anchor audit history independently.** Store signed or otherwise independently protected checkpoints outside the writable JSONL ledger. A hash chain alone cannot detect a complete rewrite.
7. **Recheck at dispatch.** The execution service—not just the planner—must verify approval, policy, contract digest, expiry, and one-time use immediately before any side effect.
8. **Fail closed on uncertainty.** Identity-provider outage, invalid signatures, stale/revoked sessions, unavailable checkpoints, policy ambiguity, or mismatched digests must deny dispatch.

## Required adversarial tests

- arbitrary subject and authentication-method strings do not qualify as authenticated approval;
- an unauthenticated or unauthorized caller cannot mint an accepted approval assertion;
- contract mutation, cross-mission replay, expired approval, revoked approval, duplicate consumption, and policy-version mismatch are denied;
- tampering with any event or breaking the chain is denied;
- replacing the entire ledger is detected when compared with an independently retained checkpoint;
- approval cannot trigger execution directly, and the dispatcher repeats verification at the side-effect boundary.

## Current disposition

The current module is suitable only as a deterministic approval-record consistency prototype. Until a real identity/authorization adapter, independently protected checkpoint, and dispatch-time enforcement exist, an `allowed=True` result must not be represented as proof of human identity or used alone to authorize production side effects.

## Addendum 2026-10-17 — approval expiry (SAFE-001)

Implemented (additive, tested, mutation-checked on the changed lines):

- `record_mission_approval(..., expires_at=...)` records a timezone-aware ISO-8601 expiry in the approval payload. It must be in the future and at most `MAX_APPROVAL_LIFETIME_SECONDS` (7 days, a policy value, not a derived fact) ahead, both judged by the store clock (`AuditStore.now()`, the single injectable time seam).
- `expires_at` is mandatory for HIGH/CRITICAL contracts (record and gate); lower tiers may omit it (legacy scope, no expiry).
- `evaluate_approved_execution_gate` rejects an approval at or after its expiry (the boundary is exclusive), a malformed expiry, a receipt whose expiry differs from the audited event, and fails closed when the store has no usable clock.

Known limits (not closed by this change):

- Expiry is checked at the gate, not again at the instant of dispatch; item 7 above (dispatch-time recheck) remains open.
- The expiry is only as trustworthy as the store clock; a trusted external time source remains open.
- Revocation, policy-version binding and approver authentication remain open.

## Signed approvals (SAFE-002, optional, additive)
- `record_mission_approval(..., signer=...)` signs the audited approval payload together with the audit `event_id` (signature domain v2; `recorded_at` is deliberately NOT signed so a challenge/response flow can sign before the append; `approval_signing_message(...)` returns the exact bytes and `record_mission_approval(..., signature=, signing_key_id=, signature_alg=)` attaches an external signature) (`approval_signing.py`). Replay is bounded by the unique event id and the signed `expires_at`. `evaluate_approved_execution_gate(..., verifier=...)` and both executors (`approval_verifier=`) then require a valid signature from a key bound to the approver subject; `approver_authenticated` is True only in that case.
- **HIGH/CRITICAL missions require a configured verifier**: without one the gate refuses (`high/critical-risk missions require a configured approval verifier`). LOW/MEDIUM without a verifier keep the legacy behaviour (approver is an unauthenticated assertion).
- Not provided: private-key custody, key provisioning/rotation, the trust registry's own integrity, trusted time. Ed25519 lives in `approval_signing_ed25519.py` behind the optional `signing` extra; the core stays dependency-free.
