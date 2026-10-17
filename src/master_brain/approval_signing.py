"""Algorithm-agnostic seam for authenticated (signed) mission approvals (SAFE-002).

A signature binds the approver's key to exactly what the audit log records: the
approval payload (mission, contract digest, action digest, expiry, approver, scope,
key id, algorithm) **and** the audit ``event_id`` and ``recorded_at``. Binding the
event id means a signed payload cannot be copied into a new event by someone who can
merely append to the log (that would otherwise mint a fresh single-use approval).

Trust model, stated plainly: authentication is only as strong as the trust registry
the verifier holds (which key belongs to which approver subject, and which are
revoked) and as the custody of the private key. Neither is provided here. The core
imports no crypto library; concrete schemes live in separate modules
(``approval_signing_ed25519`` needs the optional ``signing`` extra).
"""
from __future__ import annotations

import json
from typing import Any, Mapping, Protocol, runtime_checkable

SIGNATURE_DOMAIN = b"master-brain/approval-signature/v1\n"
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


def build_signing_message(event_id: str, recorded_at: str, unsigned_payload: Mapping[str, Any]) -> bytes:
    """Canonical bytes that are signed: domain tag + event id + time + payload."""
    body = json.dumps(
        {"event_id": event_id, "recorded_at": recorded_at, "payload": dict(unsigned_payload)},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
    )
    return SIGNATURE_DOMAIN + body.encode("utf-8")


def sign_approval_payload(
    signer: ApprovalSigner, event_id: str, recorded_at: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Return ``payload`` plus signature fields. Raises (writing nothing) on a bad signer."""
    key_id = getattr(signer, "key_id", None)
    algorithm = getattr(signer, "algorithm", None)
    for name, value in (("key_id", key_id), ("algorithm", algorithm)):
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"signer {name} must be a non-empty string")
    unsigned = {**payload, "signing_key_id": key_id, "signature_alg": algorithm}
    signature = signer.sign(build_signing_message(event_id, recorded_at, unsigned))
    if not isinstance(signature, (bytes, bytearray)):
        raise TypeError("signer must return bytes")
    if not signature:
        raise ValueError("signer returned an empty signature")
    return {**unsigned, "signature": bytes(signature).hex()}


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
    message = build_signing_message(event.event_id, event.recorded_at, unsigned)
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
    "build_signing_message", "sign_approval_payload", "verify_approval_event",
]
