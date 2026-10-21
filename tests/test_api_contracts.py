"""Gate 1 contract tests for the v1 API schemas (PLAT-001 / OPS-001)."""
import ast
import json
import tempfile
import unittest
from pathlib import Path

from master_brain.api_contracts import (
    API_VERSION, ERROR_TABLE, EXECUTION_STATUSES, ApprovalChallenge, ApprovalChallengeRequest,
    ApprovalStatus, ContractError, CreateMissionRequest, ErrorCode, SubmitApprovalRequest,
    audit_event_view, error_from_execution_result, error_response, mission_view_from_domain,
)
from master_brain.audit_store import AuditStore
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.mission_lifecycle import (
    MissionLifecycleView, MissionState, derive_mission_state, register_mission_contract,
)

GOLDEN = Path(__file__).parent / "golden" / "api_v1"
KEY = "idem-key-0001"
DIGEST = "a" * 64


def golden(name):
    return json.loads((GOLDEN / f"{name}.json").read_text(encoding="utf-8"))


class CreateMissionRequestTests(unittest.TestCase):
    def ok(self, **over):
        data = {"idempotency_key": KEY, "objective": "Summarize the report"}
        data.update(over)
        return CreateMissionRequest.from_dict(data)

    def bad(self, path_fragment, data):
        with self.assertRaises(ContractError) as ctx:
            CreateMissionRequest.from_dict(data)
        self.assertIn(path_fragment, str(ctx.exception))

    def test_minimal_request_gets_documented_defaults(self):
        req = self.ok()
        self.assertEqual((req.constraints, req.success_criteria, req.risk_tier, req.requires_approval),
                         ((), (), "medium", False))
        self.assertEqual(req.to_dict(), golden("create_mission_request_minimal"))

    def test_full_request_round_trips_and_accepts_persian_text(self):
        data = {"idempotency_key": KEY, "objective": "خلاصهٔ گزارش را بنویس\nبا ارجاع", "constraints": ["بدون راز"],
                "success_criteria": ["دو بند"], "risk_tier": "high", "requires_approval": True}
        req = CreateMissionRequest.from_dict(data)
        self.assertEqual(req.to_dict(), data)
        self.assertEqual(CreateMissionRequest.from_dict(req.to_dict()), req)
        self.assertEqual(req.to_dict(), golden("create_mission_request_full"))

    def test_unknown_fields_can_never_smuggle_identity_or_authorization(self):
        for field in ("user_id", "mission_id", "approval_granted", "approver_subject",
                      "contract_digest", "state", "role"):
            with self.subTest(field=field):
                self.bad("unknown field(s): " + field, {"idempotency_key": KEY, "objective": "o", field: "x"})

    def test_required_fields_and_object_shape(self):
        self.bad("missing field(s): idempotency_key", {"objective": "o"})
        self.bad("missing field(s): objective", {"idempotency_key": KEY})
        for not_obj in (None, [], "x", 5):
            with self.subTest(not_obj=not_obj):
                self.bad("must be an object", not_obj)

    def test_text_rules_and_boundaries(self):
        self.ok(objective="x" * 4000)
        self.bad("at most 4000", {"idempotency_key": KEY, "objective": "x" * 4001})
        for blank in ("", "   ", "\n\t"):
            self.bad("must not be blank", {"idempotency_key": KEY, "objective": blank})
        for non_str in (None, 5, ["a"]):
            self.bad("must be a string", {"idempotency_key": KEY, "objective": non_str})
        self.ok(objective="line1\nline2\ttabbed")
        for ch in ("\x00", "\x07", "\x1b", "\x7f"):
            with self.subTest(ch=repr(ch)):
                self.bad("control characters", {"idempotency_key": KEY, "objective": f"a{ch}b"})

    def test_list_rules_and_boundaries(self):
        self.ok(constraints=["c"] * 50)
        self.bad("at most 50 items", {"idempotency_key": KEY, "objective": "o", "constraints": ["c"] * 51})
        for wrong in ("text", ("a",), {"a": 1}, None):
            self.bad("must be an array", {"idempotency_key": KEY, "objective": "o", "success_criteria": wrong})
        self.bad("constraints[1]", {"idempotency_key": KEY, "objective": "o", "constraints": ["ok", " "]})
        self.bad("constraints[0]", {"idempotency_key": KEY, "objective": "o", "constraints": [3]})

    def test_risk_tier_and_boolean_strictness(self):
        for tier in ("low", "medium", "high", "critical"):
            self.assertEqual(self.ok(risk_tier=tier).risk_tier, tier)
        for bad_tier in ("High", "extreme", "", None, 1):
            self.bad("risk_tier", {"idempotency_key": KEY, "objective": "o", "risk_tier": bad_tier})
        for bad_bool in (1, 0, "true", None):
            self.bad("must be a boolean", {"idempotency_key": KEY, "objective": "o", "requires_approval": bad_bool})

    def test_idempotency_key_rules_and_boundaries(self):
        self.ok(idempotency_key="k" * 8)
        self.ok(idempotency_key="k" * 128)
        self.ok(idempotency_key="Aa0._:-" + "x")
        for bad_key in ("k" * 7, "k" * 129, "has space1", "slash/slash", "ключ-ключ-ключ", "", None, 12345678):
            with self.subTest(key=bad_key):
                self.bad("idempotency_key", {"idempotency_key": bad_key, "objective": "o"})


class DataclassContractTests(unittest.TestCase):
    def test_direct_construction_uses_the_documented_defaults(self):
        req = CreateMissionRequest(idempotency_key=KEY, objective="o")
        self.assertEqual((req.constraints, req.success_criteria, req.risk_tier, req.requires_approval),
                         ((), (), "medium", False))

    def test_contract_objects_are_immutable(self):
        objects = [
            CreateMissionRequest(idempotency_key=KEY, objective="o"),
            ApprovalChallengeRequest(contract_digest=DIGEST, signing_key_id="k1", signature_alg="alg"),
            SubmitApprovalRequest(KEY, "a1", "k1", "alg", "ab"),
            error_response(ErrorCode.CONFLICT, "c1"),
            ApprovalChallenge("m", DIGEST, "a1", "t", None, "6d"),
            audit_event_view(type("E", (), dict(event_id="e", event_type="t", recorded_at="r",
                                                actor="a", event_hash="h"))()),
        ]
        for obj in objects:
            with self.subTest(type=type(obj).__name__), self.assertRaises(Exception):
                obj.__dict__  # exists
                setattr(obj, next(iter(vars(obj))), "changed")

    def test_timestamp_length_limit_is_exactly_64(self):
        for text, fragment in (("x" * 64, "ISO-8601"), ("x" * 65, "at most 64")):
            with self.subTest(length=len(text)), self.assertRaises(ContractError) as ctx:
                ApprovalChallengeRequest.from_dict({"contract_digest": DIGEST, "signing_key_id": "k1", "signature_alg": "a", "expires_at": text})
            self.assertIn(fragment, str(ctx.exception))


class ExecutionContractTests(unittest.TestCase):
    def test_execute_request_is_strict(self):
        from master_brain.api_contracts import ExecuteMissionRequest
        ok = ExecuteMissionRequest.from_dict({"idempotency_key": KEY, "task_id": "echo.v1-2_x"})
        self.assertEqual((ok.idempotency_key, ok.task_id), (KEY, "echo.v1-2_x"))
        for bad in ({}, {"idempotency_key": KEY}, {"task_id": "echo"},
                    {"idempotency_key": KEY, "task_id": "echo", "payload": {}},
                    {"idempotency_key": KEY, "task_id": "Echo"}, {"idempotency_key": KEY, "task_id": "-x"},
                    {"idempotency_key": KEY, "task_id": "x" * 65}, {"idempotency_key": "short", "task_id": "echo"},
                    {"idempotency_key": KEY, "task_id": ""}, {"idempotency_key": KEY, "task_id": 5}, []):
            with self.subTest(bad=bad), self.assertRaises(ContractError):
                ExecuteMissionRequest.from_dict(bad)
        ExecuteMissionRequest.from_dict({"idempotency_key": KEY, "task_id": "x" * 64})
        with self.assertRaises(Exception):
            ok.task_id = "other"

    def test_views_are_immutable_and_expose_only_closed_fields(self):
        from master_brain.api_contracts import RESULT_NOTES, AttemptView, ResultView, TaskView
        task = TaskView("echo", "d", DIGEST, 0, ("offline only",))
        attempt = AttemptView("a1", "i", "succeeded", False, {"k": 1}, DIGEST, None, ("l",))
        result = ResultView("m", "response_received", "started", (attempt,))
        for obj in (task, attempt, result):
            with self.subTest(type=type(obj).__name__), self.assertRaises(Exception):
                setattr(obj, next(iter(vars(obj))), "changed")
        self.assertEqual(set(task.to_dict()), {"task_id", "description", "action_digest", "risk_level", "limitations"})
        self.assertEqual(set(attempt.to_dict()), {"attempt_id", "integration_id", "dispatch_status",
                         "external_effect_confirmed", "output", "output_digest", "reconciliation", "limitations"})
        data = result.to_dict()
        self.assertEqual(data["result_verification"], "not_independently_verified")
        self.assertEqual(data["notes"], list(RESULT_NOTES))
        self.assertEqual(len(RESULT_NOTES), 2)
        self.assertTrue(all("verif" in n or "confirmed" in n for n in RESULT_NOTES))
        self.assertIsNone(AttemptView("a", "i", "unresolved", False, None, None, None, ()).to_dict()["output"])


class ReconcileRequestTests(unittest.TestCase):
    base = {"idempotency_key": KEY, "attempt_id": "a1b2c3", "resolution": "effect_occurred",
            "evidence_ref": "provider receipt 123"}

    def test_valid_and_strict(self):
        from master_brain.api_contracts import MAX_EVIDENCE_REF_CHARS, ReconcileRequest
        ok = ReconcileRequest.from_dict(self.base)
        self.assertEqual((ok.attempt_id, ok.resolution, ok.evidence_ref), ("a1b2c3", "effect_occurred", "provider receipt 123"))
        self.assertEqual(MAX_EVIDENCE_REF_CHARS, 500)
        ReconcileRequest.from_dict({**self.base, "resolution": "effect_did_not_occur", "evidence_ref": "x" * 500})
        for bad in ({**self.base, "resolution": "done"}, {**self.base, "resolution": ""},
                    {**self.base, "evidence_ref": "x" * 501}, {**self.base, "evidence_ref": "  "},
                    {**self.base, "evidence_ref": "a\x00b"}, {**self.base, "attempt_id": "bad id"},
                    {**self.base, "attempt_id": ""}, {**self.base, "idempotency_key": "short"},
                    {**self.base, "actor": "x"}, {k: v for k, v in self.base.items() if k != "evidence_ref"},
                    {k: v for k, v in self.base.items() if k != "resolution"}, [], None):
            with self.subTest(bad=bad), self.assertRaises(ContractError):
                ReconcileRequest.from_dict(bad)
        with self.assertRaises(Exception):
            ok.resolution = "effect_did_not_occur"


class ApprovalRequestTests(unittest.TestCase):
    def test_challenge_request_requires_key_id_and_algorithm(self):
        for missing in ("signing_key_id", "signature_alg"):
            data = {"contract_digest": DIGEST, "signing_key_id": "k1", "signature_alg": "a"}
            del data[missing]
            with self.subTest(missing=missing), self.assertRaises(ContractError):
                ApprovalChallengeRequest.from_dict(data)
        for field in ("signing_key_id", "signature_alg"):
            for bad in ("", "has space", "x" * 129, 5):
                with self.subTest(field=field, bad=bad), self.assertRaises(ContractError):
                    self.challenge(**{field: bad})

    def challenge(self, **kw):
        return ApprovalChallengeRequest.from_dict({"contract_digest": DIGEST, "signing_key_id": "k1", "signature_alg": "a", **kw})

    def test_challenge_request_defaults_and_optionals(self):
        req = self.challenge()
        self.assertEqual((req.action_digest, req.expires_at), (None, None))
        full = self.challenge(action_digest="b" * 64, expires_at="2026-10-20T10:00:00Z")
        self.assertEqual((full.action_digest, full.expires_at), ("b" * 64, "2026-10-20T10:00:00Z"))
        self.assertEqual(self.challenge(expires_at="2026-10-20T10:00:00+03:30").expires_at,
                         "2026-10-20T10:00:00+03:30")

    def test_challenge_request_rejects_bad_digests_timestamps_and_identity_fields(self):
        for bad in ("A" * 64, "a" * 63, "a" * 65, "g" * 64, "", None, 5):
            with self.subTest(digest=bad), self.assertRaises(ContractError):
                ApprovalChallengeRequest.from_dict({"contract_digest": bad})
            with self.subTest(action=bad), self.assertRaises(ContractError):
                if bad is None:
                    raise ContractError("x", "skip")  # None is the legitimate "absent" value
                ApprovalChallengeRequest.from_dict({"contract_digest": DIGEST, "action_digest": bad})
        for bad_ts in ("2026-10-20T10:00:00", "tomorrow", "", "2026-13-40T00:00:00Z", 5):
            with self.subTest(ts=bad_ts), self.assertRaises(ContractError):
                self.challenge(expires_at=bad_ts)
        with self.assertRaises(ContractError):
            self.challenge(approver_subject="user:alice")  # identity comes from the session
        with self.assertRaises(ContractError):
            ApprovalChallengeRequest.from_dict({})

    def submit(self, **over):
        data = {"idempotency_key": KEY, "approval_event_id": "approval-1", "signing_key_id": "k1",
                "signature_alg": "ed25519", "signature_hex": "ab" * 64}
        data.update(over)
        return SubmitApprovalRequest.from_dict(data)

    def test_submit_request_accepts_valid_and_enforces_signature_shape(self):
        self.assertEqual(self.submit().signature_hex, "ab" * 64)
        self.assertEqual(len(self.submit(signature_hex="a" * 1024).signature_hex), 1024)
        self.assertEqual(self.submit(signature_hex="0a").signature_hex, "0a")
        for bad in ("", "a", "abc", "AB" * 4, "zz", "a" * 1026, "ab cd", None, 12, b"ab"):
            with self.subTest(sig=bad), self.assertRaises(ContractError):
                self.submit(signature_hex=bad)

    def test_submit_request_rejects_identity_and_bad_ids(self):
        for field in ("approver_subject", "user_id", "contract_digest", "approval_granted"):
            with self.subTest(field=field), self.assertRaises(ContractError):
                self.submit(**{field: "x"})
        for field in ("approval_event_id", "signing_key_id", "signature_alg"):
            for bad in ("", "has space", "x" * 129, None, 5):
                with self.subTest(field=field, bad=bad), self.assertRaises(ContractError):
                    self.submit(**{field: bad})
            self.submit(**{field: "x" * 128})


class ViewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = AuditStore(Path(self.tmp.name) / "a.jsonl")

    def contract(self, **kw):
        base = dict(mission_id="mission-api-1", objective="Draft the plan", risk_tier=MissionRiskTier.HIGH,
                    requires_approval=True, selected_islands=("island-a", "island-b"),
                    clarification_questions=("Which audience?",))
        base.update(kw)
        return MissionContract(**base)

    def lifecycle(self, contract):
        register_mission_contract(self.store, contract, event_id="reg-1",
                                  recorded_at="2026-10-19T00:00:00Z", actor="planner")
        return derive_mission_state(self.store, contract.mission_id)

    def test_planned_mission_view_matches_golden_and_says_planning_is_not_execution(self):
        c = self.contract()
        view = mission_view_from_domain(c, self.lifecycle(c), approval_status=ApprovalStatus.REQUIRED)
        data = view.to_dict()
        self.assertEqual(data, golden("mission_view_planned"))
        self.assertEqual(data["execution"], "not_started")
        self.assertEqual(data["result_verification"], "not_independently_verified")
        self.assertEqual(data["api_version"], API_VERSION)

    def test_view_without_approval_requirement(self):
        c = self.contract(mission_id="m-low", risk_tier=MissionRiskTier.LOW, requires_approval=False,
                          selected_islands=(), clarification_questions=())
        view = mission_view_from_domain(c, self.lifecycle(c), approval_status=ApprovalStatus.NOT_REQUIRED)
        self.assertEqual(view.to_dict(), golden("mission_view_not_required"))

    def test_approval_status_must_agree_with_the_contract(self):
        c = self.contract()
        life = self.lifecycle(c)
        with self.assertRaises(ValueError):
            mission_view_from_domain(c, life, approval_status=ApprovalStatus.NOT_REQUIRED)
        low = self.contract(mission_id="m-low2", risk_tier=MissionRiskTier.LOW, requires_approval=False)
        with self.assertRaises(ValueError):
            mission_view_from_domain(low, MissionLifecycleView("m-low2", MissionState.PLANNED, None),
                                     approval_status=ApprovalStatus.GRANTED)
        with self.assertRaises(ValueError):
            mission_view_from_domain(c, MissionLifecycleView("another", MissionState.PLANNED, None),
                                     approval_status=ApprovalStatus.REQUIRED)

    def test_every_state_has_an_execution_phase_and_inconsistent_is_unknown(self):
        c = self.contract()
        expect = {"unregistered": "not_started", "planned": "not_started", "approved": "not_started",
                  "dispatch_unresolved": "started", "response_received": "started",
                  "effect_reconciled": "started", "dispatch_failed_no_effect": "started",
                  "inconsistent": "unknown"}
        self.assertEqual({s.value for s in MissionState}, set(expect))
        for state in MissionState:
            with self.subTest(state=state):
                view = mission_view_from_domain(
                    c, MissionLifecycleView(c.mission_id, state, DIGEST, ("x",) if state is MissionState.INCONSISTENT else ()),
                    approval_status=ApprovalStatus.REQUIRED)
                self.assertEqual(view.execution, expect[state.value])
                self.assertEqual(view.state, state.value)

    def test_audit_event_view_never_exposes_the_payload(self):
        self.lifecycle(self.contract())
        event = self.store.read_all()[0]
        data = audit_event_view(event).to_dict()
        self.assertEqual(set(data), {"event_id", "event_type", "recorded_at", "actor", "event_hash"})
        self.assertEqual(data, {"event_id": "reg-1", "event_type": "mission.contract_registered",
                                "recorded_at": "2026-10-19T00:00:00Z", "actor": "planner",
                                "event_hash": event.event_hash})

    def test_approval_challenge_matches_golden(self):
        data = ApprovalChallenge("mission-api-1", DIGEST, "approval-1",
                                 "2026-10-19T01:00:00Z", None, "6d62").to_dict()
        self.assertEqual(data, golden("approval_challenge"))


class ErrorModelTests(unittest.TestCase):
    def test_table_is_complete_pinned_and_hides_internals(self):
        self.assertEqual(set(ERROR_TABLE), set(ErrorCode))
        self.assertEqual({c.value: ERROR_TABLE[c][0] for c in ErrorCode}, {
            "invalid_request": 400, "unauthenticated": 401, "forbidden": 403, "not_found": 404,
            "conflict": 409, "stale_contract": 409, "approval_required": 403, "approval_invalid": 403,
            "clarification_required": 422, "reconciliation_required": 409, "duplicate_request": 409,
            "dispatch_failed": 502, "unavailable": 503, "outcome_unknown": 500,
            "rate_limited": 429})
        for code in ErrorCode:
            message = ERROR_TABLE[code][1]
            self.assertTrue(message.endswith("."), message)
            self.assertNotIn("_", message)  # no internal reason identifiers

    def test_http_status_and_message_come_from_the_table(self):
        for code in ErrorCode:
            err = error_response(code, "c1")
            self.assertEqual((err.http_status, err.message), ERROR_TABLE[code])
        self.assertEqual(error_response(ErrorCode.NOT_FOUND, "c").http_status, 404)
        self.assertEqual(error_response(ErrorCode.UNAVAILABLE, "c").http_status, 503)

    def test_only_unavailable_and_rate_limited_are_retryable(self):
        # both are refusals made BEFORE anything was executed, so a retry cannot duplicate an effect
        for code in ErrorCode:
            self.assertEqual(error_response(code, "c1").retryable,
                             code in (ErrorCode.UNAVAILABLE, ErrorCode.RATE_LIMITED))

    def test_error_body_matches_golden_and_requires_a_correlation_id(self):
        self.assertEqual(error_response(ErrorCode.APPROVAL_INVALID, "corr-123").to_dict(), golden("error_response"))
        for bad in ("", "  ", None, 5):
            with self.assertRaises(ValueError):
                error_response(ErrorCode.CONFLICT, bad)


class Result:
    def __init__(self, status, reason=""):
        self.status, self.reason = status, reason


class ExecutionMappingTests(unittest.TestCase):
    def code(self, status, reason=""):
        err = error_from_execution_result(Result(status, reason), "c1")
        return None if err is None else err.code

    def test_status_mapping_is_pinned(self):
        pinned = {
            "response_received": None, "audit_unavailable": ErrorCode.UNAVAILABLE,
            "registry_unavailable": ErrorCode.UNAVAILABLE,
            "execution_registry_incomplete": ErrorCode.OUTCOME_UNKNOWN,
            "executed_audit_incomplete": ErrorCode.OUTCOME_UNKNOWN,
            "outcome_unknown": ErrorCode.OUTCOME_UNKNOWN, "dispatch_failed": ErrorCode.DISPATCH_FAILED,
            "idempotency_conflict": ErrorCode.CONFLICT,
            "duplicate_existing_execution": ErrorCode.DUPLICATE_REQUEST,
            "duplicate_intent": ErrorCode.DUPLICATE_REQUEST, "rejected": ErrorCode.FORBIDDEN}
        self.assertEqual(set(pinned), set(EXECUTION_STATUSES))
        for status, code in pinned.items():
            with self.subTest(status=status):
                self.assertIs(self.code(status), code)

    def test_unknown_or_malformed_results_fail_closed_never_as_success(self):
        for result in (Result("completed"), Result(None), Result(5), object(), None):
            err = error_from_execution_result(result, "c1")
            self.assertIsNotNone(err)
            self.assertIs(err.code, ErrorCode.OUTCOME_UNKNOWN)

    def test_rejected_reasons_map_to_specific_codes(self):
        cases = {
            "contract_not_registered": ErrorCode.NOT_FOUND,
            "registered_contract_mismatch": ErrorCode.STALE_CONTRACT,
            "mission contract changed after approval": ErrorCode.STALE_CONTRACT,
            "mission_dispatch_unresolved_requires_reconciliation": ErrorCode.RECONCILIATION_REQUIRED,
            "mission_lifecycle_unavailable": ErrorCode.UNAVAILABLE,
            "verified audit history is unavailable or invalid": ErrorCode.UNAVAILABLE,
            "mission_lifecycle_inconsistent": ErrorCode.CONFLICT,
            "mission requires clarification before dispatch": ErrorCode.CLARIFICATION_REQUIRED,
            "mission objective is empty and requires clarification": ErrorCode.CLARIFICATION_REQUIRED,
            "high/critical-risk missions require a configured approval verifier (authenticated approver)":
                ErrorCode.FORBIDDEN,
            "required human approval receipt is missing": ErrorCode.APPROVAL_REQUIRED,
            "high/critical-risk missions require an approval bound to the exact action":
                ErrorCode.APPROVAL_REQUIRED,
            "high/critical-risk missions require an approval with an expiry": ErrorCode.APPROVAL_REQUIRED,
            "approval receipt belongs to a different mission": ErrorCode.APPROVAL_INVALID,
            "approval_already_consumed": ErrorCode.APPROVAL_INVALID,
            "approval has expired": ErrorCode.APPROVAL_INVALID,
            "approval signature invalid: bad": ErrorCode.APPROVAL_INVALID,
            "action (integration or payload) differs from the approved action": ErrorCode.APPROVAL_INVALID,
            "requirement_exceeds_contract_risk_ceiling": ErrorCode.FORBIDDEN,
            "something nobody anticipated": ErrorCode.FORBIDDEN,
            "": ErrorCode.FORBIDDEN,
        }
        for reason, expected in cases.items():
            with self.subTest(reason=reason):
                self.assertIs(self.code("rejected", reason), expected)

    def test_statuses_match_the_ones_the_domain_can_actually_return(self):
        """Drift guard: a new status string in mission_execution.py must be mapped here."""
        source = (Path(__file__).parents[1] / "src" / "master_brain" / "mission_execution.py").read_text("utf-8")
        found = set()
        for node in ast.walk(ast.parse(source)):
            if (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "MissionExecutionResult"
                    and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant)):
                found.add(node.args[1].value)
        self.assertEqual(found, set(EXECUTION_STATUSES))

    def test_real_domain_outcomes_map_end_to_end(self):
        from master_brain.integrations import IntegrationKind, IntegrationRequirement
        from master_brain.mission_approval import record_mission_approval
        from master_brain.mission_execution import execute_mission_once
        from tests.approval_expiry_helper import soon
        from tests.mission_registration_helper import register_contract
        from tests.test_mission_execution import Adapter, descriptor
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = AuditStore(Path(tmp.name) / "a.jsonl")
        c = MissionContract(mission_id="m-e2e", objective="o", risk_tier=MissionRiskTier.MEDIUM,
                            requires_approval=True)
        req = IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.MODEL)
        kw = dict(event_id_prefix="p", recorded_at="2026-10-19T00:01:00Z", actor="s")

        def run(receipt, contract=c):
            return execute_mission_once(contract, store, receipt, descriptor(), req, Adapter(), {"p": 1}, **kw)

        receipt = record_mission_approval(store, c, event_id="ap", recorded_at="2026-10-19T00:00:00Z",
                                          approver_subject="u", authentication_method="m", expires_at=soon())
        self.assertIs(error_from_execution_result(run(receipt), "c").code, ErrorCode.NOT_FOUND)
        register_contract(store, c, recorded_at="2026-10-19T00:00:00Z")
        self.assertIs(error_from_execution_result(run(None), "c").code, ErrorCode.APPROVAL_REQUIRED)
        from dataclasses import replace
        changed = replace(c, objective="o2")
        self.assertIs(error_from_execution_result(run(receipt, changed), "c").code, ErrorCode.STALE_CONTRACT)
        self.assertIsNone(error_from_execution_result(run(receipt), "c"))


if __name__ == "__main__":
    unittest.main()
