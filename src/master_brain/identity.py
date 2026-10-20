"""Authenticated identity seam for the API (Gate 2a, SAFE-002/PLAT-001).

The auth *provider* is an open decision (docs/MASTER_BRAIN_PRODUCT_PLATFORM_ARCHITECTURE.md §9).
This module fixes the seam, not the provider: the server only ever sees an
``Authenticator`` that turns a bearer credential into an ``Identity`` or ``None``.
``StaticTokenAuthenticator`` is a deliberately small, free, local implementation
(tokens supplied by the operator at start-up); it is NOT a user-management system.
Identity never comes from a request body.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Mapping, Protocol

MIN_TOKEN_CHARS = 32
_SUBJECT = re.compile(r"[A-Za-z0-9._:@-]{1,128}")


@dataclass(frozen=True)
class Identity:
    subject: str

    def __post_init__(self) -> None:
        if not isinstance(self.subject, str) or not _SUBJECT.fullmatch(self.subject):
            raise ValueError("identity subject must be 1-128 characters of [A-Za-z0-9._:@-]")


class Authenticator(Protocol):
    def authenticate(self, credential: str | None) -> Identity | None:
        """Return the identity for a valid credential, else None. Must not raise for bad input."""
        ...


class StaticTokenAuthenticator:
    """Maps operator-supplied bearer tokens to subjects.

    Tokens are stored only as SHA-256 digests and compared in constant time over the
    whole table (no early exit), so neither a heap dump nor timing reveals a token.
    """

    def __init__(self, tokens: Mapping[str, str]) -> None:
        if not tokens:
            raise ValueError("at least one token is required")
        digests: list[tuple[bytes, Identity]] = []
        for token, subject in tokens.items():
            if not isinstance(token, str) or len(token) < MIN_TOKEN_CHARS or token != token.strip():
                raise ValueError(f"tokens must be at least {MIN_TOKEN_CHARS} characters without surrounding spaces")
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            digests.append((digest, Identity(subject)))
        self._table = tuple(digests)

    def authenticate(self, credential: str | None) -> Identity | None:
        if not isinstance(credential, str) or not credential or len(credential) > 512:
            return None
        probe = hashlib.sha256(credential.encode("utf-8")).digest() \
            if _encodable(credential) else None
        if probe is None:
            return None
        found: Identity | None = None
        for digest, identity in self._table:  # no early exit
            if hmac.compare_digest(digest, probe):
                found = identity
        return found


def _encodable(text: str) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


__all__ = ["Authenticator", "Identity", "MIN_TOKEN_CHARS", "StaticTokenAuthenticator"]
