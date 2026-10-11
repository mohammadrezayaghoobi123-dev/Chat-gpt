"""Versioned allowlist for provider-specific completion verifiers.

This is a configuration boundary, not a sandbox. Production callers must build
this registry only from reviewed deployment configuration; mission/user input
must never supply descriptors or verifier callables.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Callable, Mapping

from master_brain.completion_evidence import CompletionEvidence


class VerifierRegistryError(ValueError):
    """Verifier configuration is invalid or no approved verifier matches."""


Verifier = Callable[[CompletionEvidence], bool]


@dataclass(frozen=True)
class VerifierDescriptor:
    verifier_id: str
    version: str
    provider_id: str
    evidence_type: str
    verify: Verifier
    enabled: bool = True


class ConfiguredVerifierRegistry:
    """Resolve an exact approved verifier tuple; never accept mission-selected code."""

    def __init__(self, descriptors: tuple[VerifierDescriptor, ...] | list[VerifierDescriptor]):
        entries: dict[tuple[str, str, str, str], VerifierDescriptor] = {}
        for item in descriptors:
            if not isinstance(item, VerifierDescriptor):
                raise VerifierRegistryError("descriptor has invalid type")
            for name, value in (
                ("verifier_id", item.verifier_id),
                ("version", item.version),
                ("provider_id", item.provider_id),
                ("evidence_type", item.evidence_type),
            ):
                if not isinstance(value, str) or not value.strip():
                    raise VerifierRegistryError(f"{name} must be non-empty")
            if not callable(item.verify):
                raise VerifierRegistryError("verifier implementation must be callable")
            if type(item.enabled) is not bool:
                raise VerifierRegistryError("enabled must be a boolean")
            key = (item.verifier_id, item.version, item.provider_id, item.evidence_type)
            if key in entries:
                raise VerifierRegistryError("duplicate verifier configuration")
            entries[key] = item
        self._entries: Mapping[tuple[str, str, str, str], VerifierDescriptor] = MappingProxyType(entries)

    def resolve(
        self, *, verifier_id: str, version: str, provider_id: str, evidence_type: str
    ) -> Verifier:
        values = {
            "verifier_id": verifier_id,
            "version": version,
            "provider_id": provider_id,
            "evidence_type": evidence_type,
        }
        for name, value in values.items():
            if not isinstance(value, str) or not value.strip():
                raise VerifierRegistryError(f"{name} must be non-empty")
        key = (verifier_id, version, provider_id, evidence_type)
        item = self._entries.get(key)
        if item is None or item.enabled is not True:
            raise VerifierRegistryError("no enabled verifier matches approved configuration")
        return item.verify


__all__ = ["ConfiguredVerifierRegistry", "VerifierDescriptor", "VerifierRegistryError"]
