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
import json
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Iterator

from master_brain.api_contracts import (
    ApprovalChallenge, ApprovalChallengeRequest, ApprovalStatus, AttemptView, AuditEventView,
    CreateMissionRequest, ErrorCode, ExecuteMissionRequest, MissionView, ResultView,
    SubmitApprovalRequest, TaskView, audit_event_view, error_from_execution_result,
    mission_view_from_domain, _EXECUTION_BY_STATE,
)
from master_brain.approval_signing import ApprovalVerifier
from master_brain.audit_store import AuditPayloadError, AuditStore, AuditStoreError
from master_brain.identity import Identity
from master_brain.execution_registry import SQLiteExecutionRegistry
from master_brain.mission_execution import execute_mission_idempotently, execution_event_id_prefix_for
from master_brain.task_catalog import TaskCatalog
from master_brain.mission_approval import (
    APPROVAL_EVENT_TYPE, MissionApprovalReceipt, approval_required, approval_signing_message,
    evaluate_approved_execution_gate, mission_contract_digest, record_mission_approval,
)
from master_brain.mission_contract import _build_contract
from master_brain.mission_lifecycle import (
    MissionContractConflict, MissionState, derive_mission_state, load_mission_contract,
    mission_events, mission_registration, register_mission_contract,
)

MISSION_ID_PATTERN = r"mission-[0-9a-f]{16}"
NO_SUCCESS_CRITERIA_QUESTION = "Define success criteria before dispatch."
CHALLENGE_EVENT_TYPE = "mission.approval_challenged"
RESULT_EVENT_TYPE = "mission.result_recorded"
MAX_RECORDED_OUTPUT_BYTES = 16 * 1024
API_AUTHENTICATION_METHOD = "signed_bearer_session"  # session identity + approver key signature
DEFAULT_APPROVAL_LIFETIME = timedelta(hours=1)


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


@dataclass(frozen=True)
class ExecutionConfig:
    """Operator-side execution wiring: what may run, and where execution state is persisted."""

    catalog: TaskCatalog
    registry: SQLiteExecutionRegistry
    dispatch_timeout_seconds: float = 30.0


class MissionService:
    def __init__(self, store: AuditStore, approval_verifier: ApprovalVerifier | None = None,
                 execution: ExecutionConfig | None = None) -> None:
        self._store = store
        self._execution = execution
        # Without a verifier the API accepts NO approvals (fail closed): over the API an
        # approval is only ever a signed one by a key bound to the authenticated session subject.
        self._verifier = approval_verifier

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

    # --------------------------------------------------------------- approvals
    def request_approval_challenge(
        self, identity: Identity, mission_id: str, request: ApprovalChallengeRequest,
    ) -> ApprovalChallenge:
        """Fix the exact bytes the approver must sign. Persists the challenge (audit)."""
        try:
            self._require_owner(identity, mission_id)
            if self._verifier is None:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            contract = load_mission_contract(self._store, mission_id)
            if request.contract_digest != mission_contract_digest(contract):
                raise ServiceError(ErrorCode.STALE_CONTRACT)
            if not approval_required(contract):
                raise ServiceError(ErrorCode.CONFLICT)
            if derive_mission_state(self._store, mission_id).state is MissionState.INCONSISTENT:
                raise ServiceError(ErrorCode.CONFLICT)
            now = self._store.now()
            expires_at = request.expires_at or (now + DEFAULT_APPROVAL_LIFETIME).isoformat().replace("+00:00", "Z")
            event_id = "approval-" + uuid.uuid4().hex
            try:
                message = approval_signing_message(
                    self._store, contract, event_id=event_id, approver_subject=identity.subject,
                    authentication_method=API_AUTHENTICATION_METHOD, signing_key_id=request.signing_key_id,
                    signature_alg=request.signature_alg, action_digest=request.action_digest,
                    expires_at=expires_at)
            except ValueError:
                raise ServiceError(ErrorCode.INVALID_REQUEST) from None
            payload = {
                "mission_id": mission_id, "contract_digest": request.contract_digest,
                "approval_event_id": event_id, "signing_key_id": request.signing_key_id,
                "signature_alg": request.signature_alg, "expires_at": expires_at,
            }
            if request.action_digest is not None:
                payload["action_digest"] = request.action_digest
            self._store.append(
                event_id=f"challenge:{event_id}", event_type=CHALLENGE_EVENT_TYPE,
                recorded_at=now.isoformat().replace("+00:00", "Z"), actor=identity.subject,
                subject_ref=f"mission:{mission_id}", payload=payload)
            return ApprovalChallenge(
                mission_id=mission_id, contract_digest=request.contract_digest,
                approval_event_id=event_id, expires_at=expires_at,
                action_digest=request.action_digest, signing_message_hex=message.hex())
        except ServiceError:
            raise
        except AuditPayloadError:
            raise ServiceError(ErrorCode.INVALID_REQUEST) from None
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    def submit_approval(
        self, identity: Identity, mission_id: str, request: SubmitApprovalRequest,
    ) -> CreateResult:
        """Record a signed approval for a previously issued challenge (idempotent per challenge)."""
        try:
            self._require_owner(identity, mission_id)
            if self._verifier is None:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            events = mission_events(self._store, mission_id)
            challenge = next((e for e in events if e.event_type == CHALLENGE_EVENT_TYPE
                              and e.payload.get("approval_event_id") == request.approval_event_id), None)
            if challenge is None or challenge.actor != identity.subject:
                raise ServiceError(ErrorCode.NOT_FOUND)
            c = challenge.payload
            if (request.signing_key_id, request.signature_alg) != (c["signing_key_id"], c["signature_alg"]):
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            existing = next((e for e in events if e.event_type == APPROVAL_EVENT_TYPE
                             and e.event_id == request.approval_event_id), None)
            if existing is not None:
                if existing.payload.get("signature") != request.signature_hex:
                    raise ServiceError(ErrorCode.CONFLICT)
                return CreateResult(self._view(mission_id), created=False)
            contract = load_mission_contract(self._store, mission_id)
            if c["contract_digest"] != mission_contract_digest(contract):
                raise ServiceError(ErrorCode.STALE_CONTRACT)
            try:
                message = approval_signing_message(
                    self._store, contract, event_id=request.approval_event_id,
                    approver_subject=identity.subject, authentication_method=API_AUTHENTICATION_METHOD,
                    signing_key_id=c["signing_key_id"], signature_alg=c["signature_alg"],
                    action_digest=c.get("action_digest"), expires_at=c["expires_at"])
            except ValueError:  # e.g. the approval window passed or exceeds the maximum lifetime
                raise ServiceError(ErrorCode.APPROVAL_INVALID) from None
            signature = bytes.fromhex(request.signature_hex)
            try:  # verify BEFORE writing: a bad signature leaves no trace in the log
                rejected = self._verifier.verify(
                    key_id=c["signing_key_id"], algorithm=c["signature_alg"], subject=identity.subject,
                    message=message, signature=signature)
            except Exception:
                rejected = "verifier error"
            if rejected is not None:
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            try:
                record_mission_approval(
                    self._store, contract, event_id=request.approval_event_id,
                    recorded_at=self._store.now().isoformat().replace("+00:00", "Z"),
                    approver_subject=identity.subject, authentication_method=API_AUTHENTICATION_METHOD,
                    action_digest=c.get("action_digest"), expires_at=c["expires_at"], signature=signature,
                    signing_key_id=c["signing_key_id"], signature_alg=c["signature_alg"])
            except ValueError:
                raise ServiceError(ErrorCode.APPROVAL_INVALID) from None
            except AuditStoreError:
                # a concurrent identical submission may have won the race
                again = next((e for e in mission_events(self._store, mission_id)
                              if e.event_type == APPROVAL_EVENT_TYPE
                              and e.event_id == request.approval_event_id), None)
                if again is not None and again.payload.get("signature") == request.signature_hex:
                    return CreateResult(self._view(mission_id), created=False)
                raise
            return CreateResult(self._view(mission_id), created=True)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # ---------------------------------------------------------------- execution
    def list_tasks(self, identity: Identity) -> tuple[TaskView, ...]:
        if self._execution is None:
            return ()
        return tuple(TaskView(t.task_id, t.description, t.action_digest, t.integration.risk_level,
                              t.integration.limitations) for t in self._execution.catalog.list())

    def execute_mission(self, identity: Identity, mission_id: str,
                        request: ExecuteMissionRequest) -> ResultView:
        """Run one catalogue task for the mission. Synchronous; never reports success it cannot back."""
        try:
            self._require_owner(identity, mission_id)
            if self._execution is None:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            task = self._execution.catalog.get(request.task_id)
            if task is None:
                raise ServiceError(ErrorCode.INVALID_REQUEST)
            contract = load_mission_contract(self._store, mission_id)
            digest = task.action_digest
            receipt = None
            if approval_required(contract):
                receipt = next(self._valid_receipts(contract, digest), None)
                if receipt is None:
                    raise ServiceError(ErrorCode.APPROVAL_REQUIRED)
            key = f"{mission_id}:{request.idempotency_key}"
            prefix = f"exec:{mission_id}"
            result = execute_mission_idempotently(
                contract, self._store, receipt, task.integration, task.requirement, task.adapter,
                task.payload(), self._execution.registry, idempotency_key=key, event_id_prefix=prefix,
                recorded_at=self._store.now().isoformat().replace("+00:00", "Z"),
                actor=identity.subject,
                dispatch_timeout_seconds=self._execution.dispatch_timeout_seconds,
                approval_verifier=self._verifier)
            self._record_output(result, mission_id, execution_event_id_prefix_for(prefix, key))
            failure = error_from_execution_result(result, "internal")
            if failure is not None:
                raise ServiceError(failure.code)
            return self._result(mission_id)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    def get_result(self, identity: Identity, mission_id: str) -> ResultView:
        try:
            self._require_owner(identity, mission_id)
            return self._result(mission_id)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    def _valid_receipts(self, contract, action_digest: str | None) -> Iterator[MissionApprovalReceipt]:
        """Recorded approvals that pass the real gate for this contract (and the given action;
        ``None`` = judge each approval against the action it is itself bound to)."""
        digest = mission_contract_digest(contract)
        events = mission_events(self._store, contract.mission_id)
        consumed = {e.payload.get("approval_event_id") for e in events
                    if e.event_type == "mission.dispatch_started"}
        for e in events:
            p = e.payload
            if e.event_type != APPROVAL_EVENT_TYPE or p.get("contract_digest") != digest:
                continue
            if p.get("action_digest") is not None and e.event_id in consumed:
                continue
            try:
                receipt = MissionApprovalReceipt(
                    event_id=e.event_id, mission_id=contract.mission_id, contract_digest=digest,
                    contract_schema_version=contract.schema_version, approver_subject=e.actor,
                    authentication_method=p["authentication_method"], recorded_at=e.recorded_at,
                    event_hash=e.event_hash, action_digest=p.get("action_digest"),
                    expires_at=p.get("expires_at"), signature=p.get("signature"),
                    signing_key_id=p.get("signing_key_id"), signature_alg=p.get("signature_alg"))
            except KeyError:
                continue
            judged = action_digest if action_digest is not None else receipt.action_digest
            gate = evaluate_approved_execution_gate(
                contract, self._store, receipt, judged, verifier=self._verifier)
            if gate.allowed and gate.approver_authenticated:
                yield receipt

    def _record_output(self, result, mission_id: str, execution_prefix: str) -> None:
        """Persist the adapter output of a successful dispatch (best effort, never changes the outcome)."""
        dispatch = getattr(result, "dispatch_result", None)
        if getattr(result, "status", None) != "response_received" or dispatch is None or dispatch.output is None:
            return
        try:
            output = json.loads(json.dumps(dict(dispatch.output), allow_nan=False))
            canonical = json.dumps(output, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            if len(canonical.encode("utf-8")) > MAX_RECORDED_OUTPUT_BYTES:
                return
            finished = next(e for e in mission_events(self._store, mission_id)
                            if e.event_id == f"{execution_prefix}:dispatch-finished")
            self._store.append(
                event_id=f"{execution_prefix}:result-recorded", event_type=RESULT_EVENT_TYPE,
                recorded_at=self._store.now().isoformat().replace("+00:00", "Z"),
                actor=finished.actor, subject_ref=f"mission:{mission_id}",
                payload={"mission_id": mission_id, "attempt_id": finished.payload["attempt_id"],
                         "integration_id": finished.payload["integration_id"],
                         "output_digest": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
                         "output": output})
        except Exception:
            return  # the dispatch outcome is already audited; a missing output is shown as null

    def _result(self, mission_id: str) -> ResultView:
        lifecycle = derive_mission_state(self._store, mission_id)
        attempts: dict[str, dict] = {}
        order: list[str] = []
        for e in mission_events(self._store, mission_id):
            p, t = e.payload, e.event_type
            aid = p.get("attempt_id")
            if not isinstance(aid, str):
                continue
            if t == "mission.dispatch_started":
                attempts.setdefault(aid, {"integration_id": p.get("integration_id", "unknown")})
                if aid not in order:
                    order.append(aid)
            elif aid in attempts and t == "mission.dispatch_finished":
                attempts[aid]["status"] = p.get("dispatch_status")
            elif aid in attempts and t == RESULT_EVENT_TYPE:
                attempts[aid].update(output=p.get("output"), digest=p.get("output_digest"))
            elif aid in attempts and t == "mission.dispatch_reconciled":
                attempts[aid]["reconciliation"] = p.get("resolution")
        views = []
        for aid in order:
            a = attempts[aid]
            reconciliation = a.get("reconciliation")
            descriptor = self._execution.catalog.integration(a["integration_id"]) if self._execution else None
            views.append(AttemptView(
                attempt_id=aid, integration_id=a["integration_id"],
                dispatch_status=a.get("status") or "unresolved",
                external_effect_confirmed=reconciliation == "effect_occurred",
                output=a.get("output"), output_digest=a.get("digest"),
                reconciliation=reconciliation,
                limitations=descriptor.limitations if descriptor else ()))
        return ResultView(mission_id=mission_id, state=lifecycle.state.value,
                          execution=_EXECUTION_BY_STATE[lifecycle.state].value, attempts=tuple(views))

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
        return mission_view_from_domain(
            contract, lifecycle, approval_status=self._approval_status(contract))

    def _approval_status(self, contract) -> ApprovalStatus:
        """``granted`` only if a signed approval passes the real gate with the configured
        verifier (authenticated, unexpired, bound to this contract) and is not yet consumed.
        Anything else about an approval-requiring mission is ``required``."""
        if not approval_required(contract):
            return ApprovalStatus.NOT_REQUIRED
        if self._verifier is None:
            return ApprovalStatus.REQUIRED
        if next(self._valid_receipts(contract, None), None) is not None:
            return ApprovalStatus.GRANTED
        return ApprovalStatus.REQUIRED


__all__ = ["API_AUTHENTICATION_METHOD", "CHALLENGE_EVENT_TYPE", "CreateResult", "ExecutionConfig",
           "RESULT_EVENT_TYPE", "MISSION_ID_PATTERN", "MissionService", "NO_SUCCESS_CRITERIA_QUESTION",
           "ServiceError", "mission_id_for"]
