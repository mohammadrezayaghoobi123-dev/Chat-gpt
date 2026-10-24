"""Ed25519 adapter for signed approvals. Requires the optional ``signing`` extra
(``pip install master-brain-core[signing]``); the core never imports this module.

Private-key custody is deliberately out of scope: ``Ed25519Signer`` keeps the key in
memory only. Persisting it (file permissions, OS keychain, HSM) is a deployment
decision that must be made and reviewed separately.
"""
from __future__ import annotations

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey, Ed25519PublicKey,
    )
except ImportError as exc:  # pragma: no cover - exercised only without the extra
    raise ImportError(
        "Ed25519 approvals need the optional 'signing' extra: "
        "pip install master-brain-core[signing]"
    ) from exc

ALGORITHM = "ed25519"
_RAW = dict(encoding=serialization.Encoding.Raw)


class Ed25519Signer:
    algorithm = ALGORITHM

    def __init__(self, key_id: str, private_key: Ed25519PrivateKey) -> None:
        if not isinstance(key_id, str) or not key_id.strip():
            raise ValueError("key_id must be a non-empty string")
        self.key_id = key_id
        self._private_key = private_key

    @classmethod
    def generate(cls, key_id: str) -> "Ed25519Signer":
        return cls(key_id, Ed25519PrivateKey.generate())

    def public_key_bytes(self) -> bytes:
        return self._private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)

    def sign(self, message: bytes) -> bytes:
        return self._private_key.sign(message)


class Ed25519TrustStore:
    """Registry of trusted public keys, each bound to ONE approver subject."""

    def __init__(self) -> None:
        self._keys: dict[str, tuple[Ed25519PublicKey, str]] = {}
        self._revoked: set[str] = set()

    def add_key(self, key_id: str, subject: str, public_key_bytes: bytes) -> None:
        for name, value in (("key_id", key_id), ("subject", subject)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be a non-empty string")
        if key_id in self._keys:
            raise ValueError(f"key_id already registered: {key_id}")
        if not isinstance(public_key_bytes, (bytes, bytearray)) or len(public_key_bytes) != 32:
            raise ValueError("an Ed25519 public key is exactly 32 bytes")
        self._keys[key_id] = (Ed25519PublicKey.from_public_bytes(bytes(public_key_bytes)), subject)

    def active_subjects(self) -> frozenset[str]:
        """Subjects that hold at least one non-revoked trusted key (start-up diagnostics)."""
        return frozenset(subject for key_id, (_, subject) in self._keys.items() if key_id not in self._revoked)

    def revoke(self, key_id: str) -> None:
        if key_id not in self._keys:
            raise KeyError(key_id)
        self._revoked.add(key_id)

    def verify(
        self, *, key_id: str, algorithm: str, subject: str, message: bytes, signature: bytes
    ) -> str | None:
        if algorithm != ALGORITHM:
            return "unsupported signature algorithm"
        entry = self._keys.get(key_id)
        if entry is None:
            return "unknown signing key"
        if key_id in self._revoked:
            return "signing key revoked"
        public_key, bound_subject = entry
        if bound_subject != subject:
            return "signing key is not bound to this approver"
        try:
            public_key.verify(signature, message)
        except InvalidSignature:
            return "signature does not verify"
        return None


__all__ = ["ALGORITHM", "Ed25519Signer", "Ed25519TrustStore"]
