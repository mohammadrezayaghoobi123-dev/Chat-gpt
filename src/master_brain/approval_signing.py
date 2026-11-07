"""Algorithm-agnostic seam for authenticated (signed) mission approvals (SAFE-002).

A signature binds the approver's key to exactly what the audit log records: the
approval payload (mission, contract digest, action digest, expiry, approver, scope,
key id, algorithm) **and** the audit ``event_id``. Binding the event id means a signed
payload cannot be copied into a new event by someone who can merely append to the
log (that would otherwise mint a fresh single-use approval).

``recorded_at`` is deliberately NOT signed (v2): in a challenge/response flow the
message is fixed before the event is appended, and the audit store forbids
back-dated appends, so a signed timestamp makes the flow impossible. The replay
window is bounded instead by the event id (unique, store-enforced) and the signed
``expires_at`` (at most ``MAX_APPROVAL_LIFETIME_SECONDS``).

Trust model, stated plainly: authentication is only as strong as the trust registry
the verifier holds (which key belongs to which approver subject, and which are
revoked) and as the custody of the private key. Neither is provided here. The core
imports no crypto library; concrete schemes live in separate modules
(``approval_signing_ed25519`` needs the optional ``signing`` extra).
"""
from __future__ import annotations

import json
from typing import Any, Mapping, Protocol, runtime_checkable

SIGNATURE_DOMAIN = b"master-brain/approval-signature/v2\n"
SIGNATURE_FIELDS = ("signature", "signing_key_id", "signature_alg")


@runtime_checkable
class ApprovalSigner(Protocol):
    key_id: str
    algorithm: str

    def sign(self, message: bytes) -> bytes: ...


@runtime_checkable
class ApprovalVerifier(Protocol):
    def verify(
        self, *, key_id: str, algorithm: str, subject: str, message: bytes, signature: bytes
    ) -> str | None:
        """Return None only if the signature is valid, the key is trusted, unrevoked and
        bound to ``subject``; otherwise a non-empty reason string."""


def build_signing_message(event_id: str, unsigned_payload: Mapping[str, Any]) -> bytes:
    """Canonical bytes that are signed: domain tag + event id + payload."""
    body = json.dumps(
        {"event_id": event_id, "payload": dict(unsigned_payload)},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    )
    return SIGNATURE_DOMAIN + body.encode("utf-8")


def sign_approval_payload(
    signer: ApprovalSigner, event_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Return ``payload`` plus signature fields. Raises (writing nothing) on a bad signer."""
    key_id = getattr(signer, "key_id", None)
    algorithm = getattr(signer, "algorithm", None)
    for name, value in (("key_id", key_id), ("algorithm", algorithm)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"signer {name} must be a non-empty string")
    unsigned = {**payload, "signing_key_id": key_id, "signature_alg": algorithm}
    signature = signer.sign(build_signing_message(event_id, unsigned))
    if not isinstance(signature, (bytes, bytearray)):
        raise TypeError("signer must return bytes")
    if not signature:
        raise ValueError("signer returned an empty signature")
    return {**unsigned, "signature": bytes(signature).hex()}


def attach_external_signature(
    payload: dict[str, Any], signing_key_id: str, signature_alg: str, signature: bytes
) -> dict[str, Any]:
    """Return ``payload`` plus signature fields for a signature produced elsewhere
    (for example by an approver's device over ``build_signing_message`` output)."""
    for name, value in (("signing_key_id", signing_key_id), ("signature_alg", signature_alg)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string")
    if not isinstance(signature, (bytes, bytearray)):
        raise TypeError("signature must be bytes")
    if not signature:
        raise ValueError("signature must not be empty")
    return {**payload, "signing_key_id": signing_key_id, "signature_alg": signature_alg,
            "signature": bytes(signature).hex()}


def verify_approval_event(verifier: ApprovalVerifier, event: Any) -> str | None:
    """None if the audited approval event carries a valid signature, else a reason.

    Fails closed on any malformed field, verifier exception or non-None result."""
    payload = event.payload
    key_id = payload.get("signing_key_id")
    algorithm = payload.get("signature_alg")
    sig_hex = payload.get("signature")
    subject = payload.get("approver_subject")
    for value in (key_id, algorithm, sig_hex, subject):
        if not isinstance(value, str) or not value.strip():
            return "approval signature missing or malformed"
    try:
        signature = bytes.fromhex(sig_hex)
    except ValueError:
        return "approval signature is not valid hex"
    unsigned = {k: v for k, v in payload.items() if k != "signature"}
    message = build_signing_message(event.event_id, unsigned)
    try:
        result = verifier.verify(
            key_id=key_id, algorithm=algorithm, subject=subject,
            message=message, signature=signature,
        )
    except Exception:
        return "approval signature verification failed (verifier error)"
    if result is not None:
        return f"approval signature invalid: {result if isinstance(result, str) and result else 'rejected'}"
    return None


__all__ = [
    "ApprovalSigner", "ApprovalVerifier", "SIGNATURE_DOMAIN", "SIGNATURE_FIELDS",
    "attach_external_signature", "build_signing_message", "sign_approval_payload",
    "verify_approval_event",
]
