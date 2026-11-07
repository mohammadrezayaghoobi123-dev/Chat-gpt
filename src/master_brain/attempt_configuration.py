"""Deployment-owned attempt scope configuration.

The low-level SQLite registry is a persistence primitive, not an authorization
boundary. Production entry points should use this module so callers select only
an approved integration tuple; scope and receipt namespace come from reviewed,
application-owned deployment configuration.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from master_brain.execution_registry import ExecutionAttempt, SQLiteExecutionRegistry


class AttemptConfigurationError(ValueError):
    """Attempt scope configuration is absent, malformed, or not approved."""


@dataclass(frozen=True)
class AttemptScopeDescriptor:
    integration_id: str
    adapter_version: str
    provider_id: str
    provider_scope: str
    receipt_namespace: str
    enabled: bool = True


class ConfiguredAttemptScopeRegistry:
    """Resolve exact integration tuples to deployment-owned receipt identity."""

    def __init__(self, descriptors: tuple[AttemptScopeDescriptor, ...] | list[AttemptScopeDescriptor]):
        entries: dict[tuple[str, str, str], AttemptScopeDescriptor] = {}
        for item in descriptors:
            if not isinstance(item, AttemptScopeDescriptor):
                raise AttemptConfigurationError("attempt scope descriptor has invalid type")
            for name, value in (
                ("integration_id", item.integration_id),
                ("adapter_version", item.adapter_version),
                ("provider_id", item.provider_id),
                ("provider_scope", item.provider_scope),
                ("receipt_namespace", item.receipt_namespace),
            ):
                if not isinstance(value, str) or not value.strip():
                    raise AttemptConfigurationError(f"{name} must be a non-empty string")
                if value != value.strip():
                    raise AttemptConfigurationError(f"{name} must not have leading or trailing whitespace")
            if type(item.enabled) is not bool:
                raise AttemptConfigurationError("enabled must be a boolean")
            key = (item.integration_id, item.adapter_version, item.provider_id)
            if key in entries:
                raise AttemptConfigurationError("duplicate attempt scope configuration")
            entries[key] = item
        self._entries: Mapping[tuple[str, str, str], AttemptScopeDescriptor] = MappingProxyType(entries)

    def resolve(self, *, integration_id: str, adapter_version: str, provider_id: str) -> AttemptScopeDescriptor:
        for name, value in (
            ("integration_id", integration_id),
            ("adapter_version", adapter_version),
            ("provider_id", provider_id),
        ):
            if not isinstance(value, str) or not value.strip():
                raise AttemptConfigurationError(f"{name} must be a non-empty string")
            if value != value.strip():
                raise AttemptConfigurationError(f"{name} must not have leading or trailing whitespace")
        item = self._entries.get((integration_id, adapter_version, provider_id))
        if item is None or item.enabled is not True:
            raise AttemptConfigurationError("no enabled attempt scope matches approved configuration")
        return item


def load_deployment_attempt_scope_registry() -> ConfiguredAttemptScopeRegistry:
    """Load a fixed, application-owned module; never accept a caller-selected path.

    Importing Python configuration executes module code. This boundary is not a
    sandbox: the module and its dependencies must be reviewed and deployment-owned.
    """
    from importlib import import_module

    module_name = "master_brain.deployment_attempt_config"
    try:
        module = import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            raise AttemptConfigurationError(
                "deployment attempt scope configuration is unavailable"
            ) from exc
        raise AttemptConfigurationError(
            "deployment attempt scope configuration could not be loaded"
        ) from exc
    except Exception as exc:
        raise AttemptConfigurationError(
            "deployment attempt scope configuration could not be loaded"
        ) from exc

    descriptors = getattr(module, "ATTEMPT_SCOPE_DESCRIPTORS", None)
    if not isinstance(descriptors, (tuple, list)) or not descriptors:
        raise AttemptConfigurationError(
            "deployment attempt scope configuration must provide at least one descriptor"
        )
    return ConfiguredAttemptScopeRegistry(descriptors)


def reserve_configured_attempt(
    registry: SQLiteExecutionRegistry,
    *,
    key: str,
    expected_version: int,
    integration_id: str,
    adapter_version: str,
    provider_id: str,
    recorded_at: str,
) -> ExecutionAttempt:
    """Reserve an attempt using trusted deployment config, never caller scope values."""
    approved = load_deployment_attempt_scope_registry().resolve(
        integration_id=integration_id,
        adapter_version=adapter_version,
        provider_id=provider_id,
    )
    return registry.reserve_attempt(
        key=key,
        expected_version=expected_version,
        integration_id=approved.integration_id,
        adapter_version=approved.adapter_version,
        provider_id=approved.provider_id,
        provider_scope=approved.provider_scope,
        receipt_namespace=approved.receipt_namespace,
        recorded_at=recorded_at,
    )


__all__ = [
    "AttemptConfigurationError",
    "AttemptScopeDescriptor",
    "ConfiguredAttemptScopeRegistry",
    "load_deployment_attempt_scope_registry",
    "reserve_configured_attempt",
]
