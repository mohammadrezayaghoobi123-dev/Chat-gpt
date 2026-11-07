"""Operator-defined catalogue of the only actions the API may execute (Gate 2b-2).

Clients choose a ``task_id``; they never supply an adapter, integration or payload.
This is what lets a client learn the exact ``action_digest`` it is asked to approve
(``GET /v1/tasks``) and what makes "approve this action" meaningful: the server
executes precisely the (integration, payload) pair whose digest was approved.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from master_brain.dispatch import IntegrationAdapter
from master_brain.integrations import IntegrationDescriptor, IntegrationRequirement
from master_brain.mission_approval import action_digest

_TASK_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MAX_PAYLOAD_BYTES = 16 * 1024


@dataclass(frozen=True)
class TaskDefinition:
    task_id: str
    description: str
    integration: IntegrationDescriptor
    requirement: IntegrationRequirement
    adapter: IntegrationAdapter
    _payload_json: str = field(repr=False)

    @classmethod
    def create(cls, *, task_id: str, description: str, integration: IntegrationDescriptor,
               requirement: IntegrationRequirement, adapter: IntegrationAdapter,
               payload: Mapping[str, Any]) -> "TaskDefinition":
        if not isinstance(task_id, str) or not _TASK_ID.fullmatch(task_id):
            raise ValueError("task_id must match [a-z0-9][a-z0-9._-]{0,63}")
        if not isinstance(description, str) or not description.strip() or len(description) > 500:
            raise ValueError("description must be 1-500 characters")
        if not isinstance(integration, IntegrationDescriptor) or not isinstance(requirement, IntegrationRequirement):
            raise TypeError("integration and requirement must be IntegrationDescriptor/IntegrationRequirement")
        if not callable(getattr(adapter, "invoke", None)):
            raise TypeError("adapter must provide invoke(payload)")
        if not isinstance(payload, Mapping):
            raise TypeError("payload must be a mapping")
        # Canonical JSON snapshot: later mutation of the caller's dict cannot change the approved action.
        text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        if len(text.encode("utf-8")) > MAX_PAYLOAD_BYTES:
            raise ValueError(f"payload must be at most {MAX_PAYLOAD_BYTES} bytes")
        return cls(task_id, description, integration, requirement, adapter, text)

    def payload(self) -> dict[str, Any]:
        """A fresh copy each call: adapters can never mutate the stored, approved payload."""
        return json.loads(self._payload_json)

    @property
    def action_digest(self) -> str:
        return action_digest(self.integration.integration_id, self.payload())


class TaskCatalog:
    def __init__(self, tasks: Iterable[TaskDefinition]) -> None:
        by_id: dict[str, TaskDefinition] = {}
        for task in tasks:
            if not isinstance(task, TaskDefinition):
                raise TypeError("catalogue entries must be TaskDefinition")
            if task.task_id in by_id:
                raise ValueError(f"duplicate task_id: {task.task_id}")
            by_id[task.task_id] = task
        self._by_id = by_id

    def get(self, task_id: str) -> TaskDefinition | None:
        return self._by_id.get(task_id) if isinstance(task_id, str) else None

    def list(self) -> tuple[TaskDefinition, ...]:
        return tuple(self._by_id[k] for k in sorted(self._by_id))

    def integration(self, integration_id: str) -> IntegrationDescriptor | None:
        for task in self._by_id.values():
            if task.integration.integration_id == integration_id:
                return task.integration
        return None


__all__ = ["MAX_PAYLOAD_BYTES", "TaskCatalog", "TaskDefinition"]
