"""Operator workflow for running a REGISTERED CTP test: request -> signed approval -> sandboxed run -> status.

What this module is: the policy layer between the HTTP API and ``ctp_runner``. It owns no execution logic.
What it never does: run anything the client describes. A request names a ``test_id``; the code, argv,
inputs, environment and limits come from the reviewed registry (``ctp_registry``).

Lifecycle, every step an event in the hash-chained audit log (subject ``ctp-run:<request_id>``)::

    ctp.run_requested       requester, test_id, spec_digest computed by the SERVER from the registry
    ctp.run_challenge_issued  exact bytes the approver must sign (bound to request, spec digest, expiry, key)
    ctp.run_approved        Ed25519 signature by a key bound to the designated approver (verified BEFORE write)
    ctp.run_claimed         single-use claim (fixed event id): written BEFORE anything executes
    ctp.test_executed       written by ctp_runner (digests only; raw output stays in private evidence storage)
    ctp.test_verified       written by a SEPARATE process/key (``python -m master_brain.ctp_verify``)

A crash between claim and result leaves a claim with no result: the state is "outcome_unknown" and the
request is never re-run automatically (submit a new request). The final PASS/FAIL is recomputed from the
chain every time (``ctp_runner.ctp_test_state`` plus ``audit_run_chain``); nothing stored is trusted.

Honest limits (also in docs/CTP_OPERATOR_GUIDE.md): the approver authorises *this registered spec digest on
this host's interpreter* once; the signature proves a key held by the approver signed those bytes, not that
the test is scientifically meaningful. Verification is a re-run by a different identity and key, on the
same host: process- and key-isolated, not environment-independent.
"""
from __future__ import annotations

import re
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from master_brain.api_contracts import (
    API_VERSION, ContractError, ErrorCode, _KEY_ID, _aware_timestamp, _object, _pattern,
)
from master_brain.approval_signing import ApprovalVerifier, build_signing_message, verify_approval_event
from master_brain.approvers import ApproverPolicy
from master_brain.audit_store import NOW, AuditStore, AuditStoreError
from master_brain.ctp_registry import REGISTRY_SCHEMA_VERSION, CtpRegistry, RegisteredTest
from master_brain.ctp_runner import (
    EXECUTED, RunnerError, SandboxUnavailable, TestState, ctp_test_state, execute_and_record,
    sandbox_status,
)
from master_brain.identity import Identity
from master_brain.mission_service import ServiceError

REQUESTED = "ctp.run_requested"
CHALLENGED = "ctp.run_challenge_issued"
APPROVED = "ctp.run_approved"
CLAIMED = "ctp.run_claimed"
ABORTED = "ctp.run_aborted"
PURPOSE = "ctp_run_approval"
APPROVAL_SCHEMA_VERSION = 1
EXECUTOR_ID = "ctp-runner"
API_AUTHENTICATION_METHOD = "api-session"
DEFAULT_APPROVAL_LIFETIME = timedelta(minutes=15)
MAX_APPROVAL_LIFETIME = timedelta(hours=1)
MAX_OPEN_REQUESTS_PER_REQUESTER = 10
OPEN_REQUEST_WINDOW = timedelta(hours=24)
REQUEST_ID = re.compile(r"^ctpreq-[0-9a-f]{32}$")
_TEST_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def run_subject(request_id: str) -> str:
    return f"ctp-run:{request_id}"


# --------------------------------------------------------------------------------------- contracts
@dataclass(frozen=True)
class RunRequest:
    test_id: str

    @classmethod
    def from_dict(cls, data: Any) -> "RunRequest":
        d = _object(data, "request", {"test_id"}, set())
        return cls(_pattern(d["test_id"], "request.test_id", _TEST_ID, "a registered test id"))


@dataclass(frozen=True)
class RunChallengeRequest:
    signing_key_id: str
    signature_alg: str
    expires_at: str | None = None

    @classmethod
    def from_dict(cls, data: Any) -> "RunChallengeRequest":
        d = _object(data, "request", {"signing_key_id", "signature_alg"}, {"expires_at"})
        return cls(
            _pattern(d["signing_key_id"], "request.signing_key_id", _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            _pattern(d["signature_alg"], "request.signature_alg", _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            _aware_timestamp(d["expires_at"], "request.expires_at") if d.get("expires_at") is not None else None)


@dataclass(frozen=True)
class RunApprovalRequest:
    approval_event_id: str
    signing_key_id: str
    signature_alg: str
    signature_hex: str

    @classmethod
    def from_dict(cls, data: Any) -> "RunApprovalRequest":
        d = _object(data, "request", {"approval_event_id", "signing_key_id", "signature_alg", "signature_hex"}, set())
        sig = d["signature_hex"]
        if (not isinstance(sig, str) or not 2 <= len(sig) <= 1024 or len(sig) % 2
                or not re.fullmatch(r"[0-9a-f]+", sig)):
            raise ContractError("request.signature_hex", "must be lowercase hex of even length (<= 1024)")
        return cls(
            _pattern(d["approval_event_id"], "request.approval_event_id", _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            _pattern(d["signing_key_id"], "request.signing_key_id", _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            _pattern(d["signature_alg"], "request.signature_alg", _KEY_ID, "1-128 characters of [A-Za-z0-9._:-]"),
            sig)


@dataclass(frozen=True)
class RunExecuteRequest:
    @classmethod
    def from_dict(cls, data: Any) -> "RunExecuteRequest":
        _object(data, "request", set(), set())
        return cls()


# ---------------------------------------------------------------------------------------- helpers
def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return at if at.tzinfo is not None else None


def _iso(at: datetime) -> str:
    return at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def approval_payload(*, request_id: str, test_id: str, spec_digest: str, requester: str, approver: str,
                     expires_at: str, key_id: str, alg: str) -> dict[str, Any]:
    """The unsigned approval payload: single source of truth for what the approver signs and what is stored."""
    return {
        "approval_schema_version": APPROVAL_SCHEMA_VERSION, "purpose": PURPOSE, "decision": "approved",
        "request_id": request_id, "test_id": test_id, "spec_digest": spec_digest, "requester": requester,
        "approver_subject": approver, "authentication_method": API_AUTHENTICATION_METHOD,
        "scope": "exact_spec_digest_single_use", "expires_at": expires_at,
        "identity_verified_by_this_module": False, "signing_key_id": key_id, "signature_alg": alg,
    }


def _events_for(store: AuditStore, request_id: str):
    subject = run_subject(request_id)
    return [e for e in store.read_all() if e.subject_ref == subject]


def audit_run_chain(store: AuditStore, verifier: ApprovalVerifier | None, request_id: str, *,
                    events: list | None = None) -> list[str]:
    """Independent re-validation of the request -> approval -> claim -> execution chain.

    Returns problems (empty = consistent). It re-checks the signature with the trust store, that every link
    names the same request/test/spec digest, that the claim happened inside the approval window, and that
    only the declared executor ran it. Used by the status view AND by the separate verifier process."""
    ev = events if events is not None else _events_for(store, request_id)
    problems: list[str] = []
    req = next((e for e in ev if e.event_type == REQUESTED), None)
    if req is None:
        return ["no request event"]
    p = req.payload
    approvals = [e for e in ev if e.event_type == APPROVED]
    claims = [e for e in ev if e.event_type == CLAIMED]
    if len(approvals) > 1:
        problems.append("more than one approval recorded for the request")
    if len(claims) > 1:
        problems.append("more than one execution claim recorded for the request")
    if claims and not approvals:
        problems.append("execution claimed without an approval")
    for ap in approvals[:1]:
        q = ap.payload
        if verifier is None:
            problems.append("no trust store configured: approval signature cannot be verified")
        else:
            why = verify_approval_event(verifier, ap)
            if why is not None:
                problems.append(f"approval signature invalid: {why}")
        for k_req, k_ap in (("request_id", "request_id"), ("test_id", "test_id"), ("spec_digest", "spec_digest"),
                            ("requester", "requester")):
            if p.get(k_req) != q.get(k_ap):
                problems.append(f"approval {k_ap} differs from the request")
        if q.get("purpose") != PURPOSE or q.get("decision") != "approved":
            problems.append("approval is not a CTP run approval")
        if ap.actor != q.get("approver_subject"):
            problems.append("approval actor differs from the approver subject")
        for cl in claims[:1]:
            at, exp = _parse_time(cl.recorded_at), _parse_time(q.get("expires_at"))
            if at is None or exp is None or at > exp:
                problems.append("execution was claimed after the approval expired")
            if cl.payload.get("spec_digest") != q.get("spec_digest") or cl.payload.get("approval_event_id") != ap.event_id:
                problems.append("claim does not match the approval")
            if cl.payload.get("executor") != EXECUTOR_ID or cl.actor != EXECUTOR_ID:
                problems.append("claim was not made by the declared executor")
    ex_subject = f"ctp:{request_id}:{p.get('test_id')}"
    for e in store.read_all():
        if e.subject_ref == ex_subject and e.event_type == EXECUTED:
            if not claims:
                problems.append("an execution was recorded without a claim")
            if e.payload.get("spec_digest") != p.get("spec_digest") and e.actor == EXECUTOR_ID:
                problems.append("an execution used a different spec digest than the approved one")
    return problems


@dataclass(frozen=True)
class RunState:
    status: str
    final_ctp_status: str          # not_run | inconclusive | pass | fail
    reason: str
    problems: tuple[str, ...]
    test_state: TestState | None


def derive_run_state(store: AuditStore, verifier: ApprovalVerifier | None, request_id: str, *,
                     now: datetime | None = None) -> RunState:
    ev = _events_for(store, request_id)
    req = next((e for e in ev if e.event_type == REQUESTED), None)
    if req is None:
        return RunState("unknown", "not_run", "no such request", (), None)
    test_id = req.payload["test_id"]
    now = now or store.now()
    approved = next((e for e in ev if e.event_type == APPROVED), None)
    claimed = next((e for e in ev if e.event_type == CLAIMED), None)
    aborted = next((e for e in ev if e.event_type == ABORTED), None)
    chain = audit_run_chain(store, verifier, request_id, events=ev)
    if claimed is None:
        if aborted is not None:
            return RunState("aborted", "not_run", f"aborted before execution: {aborted.payload.get('reason')}", tuple(chain), None)
        if approved is None:
            challenged = any(e.event_type == CHALLENGED for e in ev)
            return RunState("approval_challenged" if challenged else "awaiting_approval", "not_run",
                            "waiting for a signed approval", tuple(chain), None)
        exp = _parse_time(approved.payload.get("expires_at"))
        if chain:
            return RunState("inconsistent", "inconclusive", "the approval chain failed validation", tuple(chain), None)
        if exp is None or exp <= now:
            return RunState("approval_expired", "not_run", "the approval expired before execution", (), None)
        return RunState("approved", "not_run", "approved; not yet executed", (), None)
    st = ctp_test_state(store, verifier, request_id, test_id)
    if chain or st.state == "inconsistent":
        return RunState("inconsistent", "inconclusive", "evidence or approval chain failed validation",
                        tuple(chain) + tuple(st.problems), st)
    if st.state == "not_run" and aborted is not None:
        return RunState("aborted", "not_run", f"aborted after claim, nothing ran: {aborted.payload.get('reason')}", (), st)
    if st.state == "not_run":
        return RunState("outcome_unknown", "inconclusive",
                        "execution was claimed but no result was recorded; it is never re-run automatically", (), st)
    if st.state == "executed_unverified":
        return RunState("executed_unverified", "inconclusive",
                        "executed but not independently verified; the provisional outcome is not a result", (), st)
    if st.state == "verified_reproduced" and st.outcome in ("pass", "fail"):
        return RunState(f"verified_{st.outcome}", st.outcome,
                        "independently re-run by another identity with identical fingerprints", (), st)
    return RunState(st.state, "inconclusive", {
        "not_reproduced": "the independent re-run did not reproduce the result",
        "not_confirmable": "an execution was inconclusive; the result cannot be confirmed",
        "verified_reproduced": "the reproduced run was inconclusive",
    }.get(st.state, st.state), (), st)


# ------------------------------------------------------------------------------------------- views
def _execution_view(payload: dict[str, Any]) -> dict[str, Any]:
    env = payload.get("environment") or {}
    return {
        "execution_id": payload.get("execution_id"), "executor": payload.get("runner_id"),
        "started_at": payload.get("started_at"), "duration_ms": payload.get("duration_ms"),
        "provisional_outcome": payload.get("outcome"), "reason": env.get("reason"),
        "exit_code": payload.get("exit_code"), "term_signal": payload.get("term_signal"),
        "spec_digest": payload.get("spec_digest"), "executable_sha256": payload.get("executable_sha256"),
        "code_digests": payload.get("code_digests"), "input_digest": payload.get("input_digest"),
        "stdout_sha256": payload.get("stdout_sha256"), "stderr_sha256": payload.get("stderr_sha256"),
        "stdout_bytes": payload.get("stdout_bytes"), "stderr_bytes": payload.get("stderr_bytes"),
        "outputs_sha256": env.get("outputs_sha256"), "inputs_intact": env.get("inputs_intact"),
        "isolation": env.get("isolation"), "sandbox_properties": env.get("sandbox_properties"),
        "verification": payload.get("verification"),
    }


# ---------------------------------------------------------------------------------------- service
class CtpOperations:
    def __init__(self, store: AuditStore, registry: CtpRegistry, approvers: ApproverPolicy,
                 verifier: ApprovalVerifier | None, evidence_dir: Path, *, max_concurrent: int = 1) -> None:
        if not isinstance(registry, CtpRegistry):
            raise TypeError("registry must be a CtpRegistry")
        if max_concurrent < 1:
            raise ValueError("max_concurrent must be >= 1")
        self._store, self._registry, self._approvers = store, registry, approvers
        self._verifier, self._evidence = verifier, Path(evidence_dir)
        self._slots = threading.BoundedSemaphore(max_concurrent)

    # ------------------------------------------------------------------------------- reading
    def list_tests(self, identity: Identity) -> list[dict[str, Any]]:
        out = []
        for t in self._registry.all():
            s = t.spec
            out.append({"test_id": t.test_id, "title": t.title, "description": t.description,
                        "spec_digest": t.spec_digest(), "criterion": s.criterion, "isolation": s.isolation,
                        "limits": {"timeout_s": s.timeout_s, "memory_bytes": s.memory_bytes,
                                   "max_output_bytes": s.max_output_bytes}})
        return out

    def get_run(self, identity: Identity, request_id: str) -> dict[str, Any]:
        try:
            ev = self._require_reader(identity, request_id)
            return self._view(request_id, ev)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # ------------------------------------------------------------------------------- request
    def request_run(self, identity: Identity, request: RunRequest) -> dict[str, Any]:
        try:
            if not (identity.is_operator or self._approvers.is_approver(identity.subject)):
                raise ServiceError(ErrorCode.FORBIDDEN)
            test = self._registry.get(request.test_id)
            if test is None:
                raise ServiceError(ErrorCode.NOT_FOUND)
            if not sandbox_status()["available"]:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            now = self._store.now()
            open_count = 0
            history = self._store.read_all()
            claimed = {e.subject_ref for e in history if e.event_type == CLAIMED}
            for e in history:
                if e.event_type == REQUESTED and e.payload.get("requester") == identity.subject \
                        and e.subject_ref not in claimed:
                    at = _parse_time(e.recorded_at)
                    if at is not None and now - at <= OPEN_REQUEST_WINDOW:
                        open_count += 1
            if open_count >= MAX_OPEN_REQUESTS_PER_REQUESTER:
                raise ServiceError(ErrorCode.RATE_LIMITED)
            request_id = "ctpreq-" + uuid.uuid4().hex
            self._store.append(
                event_id=f"ctp-request:{request_id}", event_type=REQUESTED, recorded_at=NOW, actor=identity.subject,
                subject_ref=run_subject(request_id),
                payload={"schema_version": REGISTRY_SCHEMA_VERSION, "request_id": request_id,
                         "test_id": test.test_id, "spec_digest": test.spec_digest(),
                         "requester": identity.subject, "registry_digest": self._registry.digest()})
            return self._view(request_id)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # ------------------------------------------------------------------------------ approval
    def request_approval_challenge(self, identity: Identity, request_id: str, req: RunChallengeRequest) -> dict[str, Any]:
        try:
            events = self._require_approver_view(identity, request_id)
            if self._verifier is None:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            request_event, test = self._request_and_test(events)
            self._require_open(events)
            now = self._store.now()
            expires = _parse_time(req.expires_at) if req.expires_at else now + DEFAULT_APPROVAL_LIFETIME
            if expires is None or expires <= now or expires - now > MAX_APPROVAL_LIFETIME:
                raise ServiceError(ErrorCode.INVALID_REQUEST)
            expires_at = _iso(expires)
            approval_event_id = "ctp-approval-" + uuid.uuid4().hex
            payload = approval_payload(
                request_id=request_id, test_id=test.test_id, spec_digest=request_event.payload["spec_digest"],
                requester=request_event.payload["requester"], approver=identity.subject, expires_at=expires_at,
                key_id=req.signing_key_id, alg=req.signature_alg)
            message = build_signing_message(approval_event_id, payload)
            self._store.append(
                event_id=f"challenge:{approval_event_id}", event_type=CHALLENGED, recorded_at=NOW,
                actor=identity.subject, subject_ref=run_subject(request_id),
                payload={"request_id": request_id, "approval_event_id": approval_event_id,
                         "approver": identity.subject, "signing_key_id": req.signing_key_id,
                         "signature_alg": req.signature_alg, "expires_at": expires_at,
                         "spec_digest": request_event.payload["spec_digest"]})
            return {"api_version": API_VERSION, "request_id": request_id, "test_id": test.test_id,
                    "spec_digest": request_event.payload["spec_digest"], "approval_event_id": approval_event_id,
                    "expires_at": expires_at, "signing_message_hex": message.hex()}
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    def submit_approval(self, identity: Identity, request_id: str, req: RunApprovalRequest) -> tuple[dict[str, Any], bool]:
        """(view, created). Verifies the signature BEFORE anything is written."""
        try:
            events = self._require_approver_view(identity, request_id)
            if self._verifier is None:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            request_event, test = self._request_and_test(events)
            challenge = next((e for e in events if e.event_type == CHALLENGED
                              and e.payload.get("approval_event_id") == req.approval_event_id), None)
            if challenge is None or challenge.actor != identity.subject:
                raise ServiceError(ErrorCode.NOT_FOUND)
            c = challenge.payload
            if (req.signing_key_id, req.signature_alg) != (c["signing_key_id"], c["signature_alg"]):
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            existing = [e for e in events if e.event_type == APPROVED]
            same = next((e for e in existing if e.event_id == req.approval_event_id), None)
            if same is not None:
                if same.payload.get("signature") != req.signature_hex:
                    raise ServiceError(ErrorCode.CONFLICT)
                return self._view(request_id), False
            if existing:
                raise ServiceError(ErrorCode.CONFLICT)
            self._require_open(events)
            if request_event.payload["spec_digest"] != test.spec_digest():
                raise ServiceError(ErrorCode.STALE_CONTRACT)
            if c["spec_digest"] != test.spec_digest():
                raise ServiceError(ErrorCode.STALE_CONTRACT)
            expires = _parse_time(c["expires_at"])
            if expires is None or expires <= self._store.now():
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            payload = approval_payload(
                request_id=request_id, test_id=test.test_id, spec_digest=c["spec_digest"],
                requester=request_event.payload["requester"], approver=identity.subject,
                expires_at=c["expires_at"], key_id=c["signing_key_id"], alg=c["signature_alg"])
            message = build_signing_message(req.approval_event_id, payload)
            try:
                rejected = self._verifier.verify(
                    key_id=c["signing_key_id"], algorithm=c["signature_alg"], subject=identity.subject,
                    message=message, signature=bytes.fromhex(req.signature_hex))
            except Exception:
                rejected = "verifier error"
            if rejected is not None:
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            try:
                self._store.append(
                    event_id=req.approval_event_id, event_type=APPROVED, recorded_at=NOW, actor=identity.subject,
                    subject_ref=run_subject(request_id), payload={**payload, "signature": req.signature_hex})
            except AuditStoreError:
                again = next((e for e in _events_for(self._store, request_id)
                              if e.event_type == APPROVED and e.event_id == req.approval_event_id), None)
                if again is not None and again.payload.get("signature") == req.signature_hex:
                    return self._view(request_id), False
                raise
            return self._view(request_id), True
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # ------------------------------------------------------------------------------ execution
    def execute(self, identity: Identity, request_id: str, _req: RunExecuteRequest) -> dict[str, Any]:
        try:
            events = self._require_reader(identity, request_id)
            if self._verifier is None:
                raise ServiceError(ErrorCode.UNAVAILABLE)
            request_event, test = self._request_and_test(events)
            if any(e.event_type == CLAIMED for e in events):
                raise ServiceError(ErrorCode.DUPLICATE_REQUEST)
            approval = next((e for e in events if e.event_type == APPROVED), None)
            if approval is None:
                raise ServiceError(ErrorCode.APPROVAL_REQUIRED)
            q = approval.payload
            expires = _parse_time(q.get("expires_at"))
            if verify_approval_event(self._verifier, approval) is not None:
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            if (q.get("purpose"), q.get("decision"), q.get("request_id"), q.get("test_id"),
                    q.get("requester")) != (PURPOSE, "approved", request_id, test.test_id,
                                            request_event.payload["requester"]):
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            if approval.actor != q.get("approver_subject") or not self._approvers.is_approver(approval.actor):
                raise ServiceError(ErrorCode.APPROVAL_INVALID)  # designation is re-checked at execution
            if expires is None or expires <= self._store.now():
                raise ServiceError(ErrorCode.APPROVAL_INVALID)
            current = test.spec_digest()  # recomputed now: a changed spec/interpreter voids the approval
            if not (q["spec_digest"] == request_event.payload["spec_digest"] == current):
                raise ServiceError(ErrorCode.STALE_CONTRACT)
            if not sandbox_status()["available"]:
                raise ServiceError(ErrorCode.UNAVAILABLE)  # fail closed: no unsandboxed fallback exists
            if not self._slots.acquire(blocking=False):
                raise ServiceError(ErrorCode.UNAVAILABLE)
            try:
                try:  # the claim is durable BEFORE the code runs; a duplicate id means somebody else claimed it
                    self._store.append(
                        event_id=f"ctp-claim:{request_id}", event_type=CLAIMED, recorded_at=NOW, actor=EXECUTOR_ID,
                        subject_ref=run_subject(request_id),
                        payload={"request_id": request_id, "test_id": test.test_id,
                                 "approval_event_id": approval.event_id, "spec_digest": current,
                                 "executor": EXECUTOR_ID})
                except AuditStoreError:
                    if any(e.event_type == CLAIMED for e in _events_for(self._store, request_id)):
                        raise ServiceError(ErrorCode.DUPLICATE_REQUEST) from None
                    raise
                try:
                    execute_and_record(self._store, test.spec, case_id=request_id, test_id=test.test_id,
                                       runner_id=EXECUTOR_ID, evidence_dir=self._evidence)
                except (SandboxUnavailable, RunnerError):
                    self._abort(request_id, "the runner refused to execute; nothing ran")
                    raise ServiceError(ErrorCode.UNAVAILABLE) from None
                except Exception:
                    # the code may have run but its record may be missing: never retry, never report success
                    raise ServiceError(ErrorCode.OUTCOME_UNKNOWN) from None
            finally:
                self._slots.release()
            return self._view(request_id)
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(ErrorCode.UNAVAILABLE) from None

    # -------------------------------------------------------------------------------- internals
    def _abort(self, request_id: str, reason: str) -> None:
        try:
            self._store.append(event_id=f"ctp-abort:{request_id}", event_type=ABORTED, recorded_at=NOW,
                               actor=EXECUTOR_ID, subject_ref=run_subject(request_id),
                               payload={"request_id": request_id, "reason": reason})
        except Exception:
            pass  # the claim without a result already reads as outcome_unknown

    def _require_reader(self, identity: Identity, request_id: str) -> list:
        """Requester, a designated approver, or an operator. Everyone else: not found (no existence oracle)."""
        if not REQUEST_ID.match(request_id):
            raise ServiceError(ErrorCode.NOT_FOUND)
        events = _events_for(self._store, request_id)
        req = next((e for e in events if e.event_type == REQUESTED), None)
        if req is None:
            raise ServiceError(ErrorCode.NOT_FOUND)
        if not (req.payload.get("requester") == identity.subject or identity.is_operator
                or self._approvers.is_approver(identity.subject)):
            raise ServiceError(ErrorCode.NOT_FOUND)
        return events

    def _require_approver_view(self, identity: Identity, request_id: str) -> list:
        events = self._require_reader(identity, request_id)
        if not self._approvers.is_approver(identity.subject):
            raise ServiceError(ErrorCode.FORBIDDEN)
        return events

    def _request_and_test(self, events: list) -> tuple[Any, RegisteredTest]:
        req = next(e for e in events if e.event_type == REQUESTED)
        test = self._registry.get(req.payload.get("test_id"))
        if test is None:  # registered when requested, no longer registered: refuse
            raise ServiceError(ErrorCode.STALE_CONTRACT)
        return req, test

    @staticmethod
    def _require_open(events: list) -> None:
        if any(e.event_type in (CLAIMED, ABORTED) for e in events):
            raise ServiceError(ErrorCode.CONFLICT)

    def _view(self, request_id: str, events: list | None = None) -> dict[str, Any]:
        ev = events if events is not None else _events_for(self._store, request_id)
        req = next(e for e in ev if e.event_type == REQUESTED)
        state = derive_run_state(self._store, self._verifier, request_id)
        view: dict[str, Any] = {
            "api_version": API_VERSION, "request_id": request_id, "test_id": req.payload["test_id"],
            "requester": req.payload["requester"], "requested_at": req.recorded_at,
            "spec_digest": req.payload["spec_digest"], "status": state.status,
            "final_ctp_status": state.final_ctp_status, "reason": state.reason,
            "problems": list(state.problems),
            "scientific_note": "A PASS/FAIL is a software-execution result for this registered test only; "
                               "it is not evidence that any real-world claim is true.",
        }
        ap = next((e for e in ev if e.event_type == APPROVED), None)
        if ap is not None:
            q = ap.payload
            view["approval"] = {
                "approval_event_id": ap.event_id, "approver": q.get("approver_subject"),
                "expires_at": q.get("expires_at"), "signing_key_id": q.get("signing_key_id"),
                "signature_alg": q.get("signature_alg"), "spec_digest": q.get("spec_digest"),
                "signature_valid": self._verifier is not None and verify_approval_event(self._verifier, ap) is None,
                "approver_currently_designated": self._approvers.is_approver(ap.actor)}
        cl = next((e for e in ev if e.event_type == CLAIMED), None)
        if cl is not None:
            view["claim"] = {"claimed_at": cl.recorded_at, "executor": cl.payload.get("executor")}
        ts = state.test_state
        if ts is not None and ts.execution_ids:
            executed = {e.payload["execution_id"]: e for e in self._store.read_all()
                        if e.event_type == EXECUTED and e.subject_ref == f"ctp:{request_id}:{req.payload['test_id']}"}
            view["executions"] = [_execution_view(executed[i].payload) for i in ts.execution_ids if i in executed]
            if ts.verification_event_id:
                vv = next((e for e in self._store.read_all() if e.event_id == ts.verification_event_id), None)
                if vv is not None:
                    v = vv.payload
                    view["verification"] = {
                        "verdict": v.get("verdict"), "verifier_id": v.get("verifier_id"),
                        "signing_key_id": v.get("signing_key_id"), "original_execution_id": v.get("original_execution_id"),
                        "rerun_execution_id": v.get("rerun_execution_id"), "basis": v.get("basis"),
                        "independence": v.get("independence"), "limitations": v.get("limitations")}
        return view


__all__ = ["CtpOperations", "RunRequest", "RunChallengeRequest", "RunApprovalRequest", "RunExecuteRequest",
           "audit_run_chain", "derive_run_state", "approval_payload", "run_subject", "REQUEST_ID", "EXECUTOR_ID"]
