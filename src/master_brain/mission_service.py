"""Transport-independent mission service (Gate 2a).

Creates, reads and audits missions on behalf of an authenticated ``Identity``.
Every decision is delegated to the existing domain (contract, lifecycle, audit store);
this layer adds only: identity -> ownership, deterministic idempotent ids, intake
clarification rules and a fail-closed mapping of failures to the closed API error set.

Honest scope: creating a mission *plans* it (state ``planned``, execution
``not_started``). Nothing is dispatched; approval/execution via the API is Gate 2b.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from master_brain.api_contracts import (
    ApprovalStatus, AuditEventView, CreateMissionRequest, ErrorCode, MissionView,
    audit_event_view, mission_view_from_domain,
)
from master_brain.audit_store import AuditPayloadError, AuditStore, AuditStoreError
from master_brain.identity import Identity
from master_brain.mission_approval import approval_required, mission_contract_digest
from master_brain.mission_contract import _build_contract
from master_brain.mission_lifecycle import (
    MissionContractConflict, derive_mission_state, load_mission_contract,
    mission_events, mission_registration, register_mission_contract,
)

MISSION_ID_PATTERN = r"mission-[0-9a-f]{16}"
NO_SUCCESS_CRITERIA_QUESTION = "Define success criteria before dispatch."


class ServiceError(Exception):
    """Carries only an API error code; internal reasons never reach the client."""

    def __init__(self, code: ErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class CreateResult:
    view: MissionView
    created: bool


def mission_id_for(identity: Identity, idempotency_key: str) -> str:
    """Deterministic per (owner, key): the same user+key always names the same mission,
    and two users can never collide or probe each other's keys."""
    material = f"{identity.subject}\0{idempotency_key}".encode("utf-8")
    return "mission-" + hashlib.sha256(material).hexdigest()[:16]


class MissionService:
    def __init__(self, store: AuditStore) -> None:
        self._store = store

    # ------------------------------------------------------------------ commands
    def create_mission(self, identity: Identity, request: CreateMissionRequest) -> CreateResult:
        mission_id = mission_id_for(identity, request.idempotency_key)
        try:
            contract = self._intake(mission_id, request)
            digest = mission_contract_digest(contract)
            existing = mission_registration(self._store, mission_id)
            if existing is not None:
                if existing.actor != identity.subject:  # unreachable by construction; fail closed
                    raise ServiceError(ErrorCode.NOT_FOUND)
                if existing.payload.get("contract_digest") != digest:
                    raise ServiceError(ErrorCode.CONFLICT)
                return CreateResult(self._view(mission_id), created=False)
            recorded_at = self._store.now().isoformat().replace("+00:00", "Z")
            registered = register_mission_contract(
                self._store, contract, event_id=f"contract-registered:{mission_id}",
                recorded_at=recorded_at, actor=identity.subject)
            # Under a race the loser's registration is the idempotent replay: not "created".
            return CreateResult(self._view(mission_id), created=registered.created)
        except ServiceError:
            raise
        except MissionContractConflict:
            raise ServiceError(ErrorCode.CONFLICT) from None
        except AuditPayloadError:
            raise ServiceError(ErrorCode.INVALID_REQUEST) from None
        except ValueError:
            raise ServiceError(ErrorCode.INVALID_REQUEST) from None
        except Exception:  # audit/chain/IO/anything unexpected: fail closed
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # ------------------------------------------------------------------- queries
    def get_mission(self, identity: Identity, mission_id: str) -> MissionView:
        try:
            self._require_owner(identity, mission_id)
            return self._view(mission_id)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    def list_audit(self, identity: Identity, mission_id: str) -> tuple[AuditEventView, ...]:
        try:
            self._require_owner(identity, mission_id)
            return tuple(audit_event_view(e) for e in mission_events(self._store, mission_id))
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # ------------------------------------------------------------------ internals
    def _intake(self, mission_id: str, request: CreateMissionRequest):
        questions = () if request.success_criteria else (NO_SUCCESS_CRITERIA_QUESTION,)
        unknowns = () if request.success_criteria else ("No success criteria were provided.",)
        return _build_contract(
            objective=request.objective, mission_id=mission_id,
            constraints=request.constraints, success_criteria=request.success_criteria,
            risk_tier=request.risk_tier, requires_approval=request.requires_approval,
            unknowns=unknowns, clarification_questions=questions,
            traceability=("planner=mission_service.intake",),
        )

    def _require_owner(self, identity: Identity, mission_id: str) -> None:
        """Foreign and unknown missions are indistinguishable (NOT_FOUND): no existence oracle."""
        registration = mission_registration(self._store, mission_id)  # errors => UNAVAILABLE upstream
        if registration is None or registration.actor != identity.subject:
            raise ServiceError(ErrorCode.NOT_FOUND)

    def _view(self, mission_id: str) -> MissionView:
        contract = load_mission_contract(self._store, mission_id)
        lifecycle = derive_mission_state(self._store, mission_id)
        # Conservative: "granted" is only ever reported from the verified gate (Gate 2b).
        status = ApprovalStatus.REQUIRED if approval_required(contract) else ApprovalStatus.NOT_REQUIRED
        return mission_view_from_domain(contract, lifecycle, approval_status=status)


__all__ = ["CreateResult", "MISSION_ID_PATTERN", "MissionService", "NO_SUCCESS_CRITERIA_QUESTION",
           "ServiceError", "mission_id_for"]
