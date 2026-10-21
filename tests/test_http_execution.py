"""Gate 2b-2: controlled offline execution over a REAL running server (PLAT-001, OPS-001, SAFE-001)."""
import hashlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from master_brain.audit_store import AuditStore
from master_brain.execution_registry import SQLiteExecutionRegistry
from master_brain.mission_service import ExecutionConfig
from master_brain.task_catalog import TaskCatalog
from tests.approval_signing_helper import TEST_ALGORITHM, HmacSeamSigner, HmacSeamVerifier
from tests.test_http_api import ALICE, BOB, KEY, Running
from tests.test_http_approvals import FakeClock
from tests.test_task_catalog import integration, make


class Counting:
    def __init__(self, output=None):
        self.calls, self.output = 0, output

    def invoke(self, payload):
        self.calls += 1
        return self.output if self.output is not None else {"answer": 42, "note": "سلام", "payload": dict(payload)}


class Failing:
    calls = 0

    def invoke(self, payload):
        type(self).calls += 1
        raise RuntimeError("secret-internal-detail")


class Slow:
    calls = 0

    def invoke(self, payload):
        type(self).calls += 1
        time.sleep(1.0)
        return {"late": True}


class ExecBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "audit.jsonl"
        self.db = str(Path(self.tmp.name) / "registry.sqlite")
        self.clock = FakeClock()
        self.verifier = HmacSeamVerifier()
        self.verifier.add("k-alice", b"alice-secret", "user:alice")
        self.signer = HmacSeamSigner("k-alice", b"alice-secret")
        self.adapter = Counting()
        Failing.calls = Slow.calls = 0
        self.start(self.adapter)

    def config(self, adapter, **kw):
        tasks = [make("echo", adapter=adapter), make("other", payload={"text": "different"}, adapter=adapter,
                                                       integration=integration("offline-other", ()))]
        tasks += [make("failing", payload={"t": 1}, adapter=Failing(), integration=integration("offline-failing")),
                  make("slow", payload={"t": 2}, adapter=Slow(), integration=integration("offline-slow"))]
        return ExecutionConfig(TaskCatalog(tasks), SQLiteExecutionRegistry(self.db), dispatch_timeout_seconds=0.3, **kw)

    def start(self, adapter):
        self.app = Running(self.path, self.verifier, self.clock, self.config(adapter))
        self.addCleanup(self.app.close)

    def mission(self, risk="low", criteria=("receipt",), token=ALICE, key=KEY):
        body = {"idempotency_key": key, "objective": "Run offline task", "risk_tier": risk}
        if criteria:
            body["success_criteria"] = list(criteria)
        status, _, view = self.app.json("POST", "/v1/missions", body, token=token)
        self.assertEqual(status, 201, view)
        return view

    def execute(self, view, task="echo", key="exec-key-0001", token=ALICE, **kw):
        return self.app.json("POST", f"/v1/missions/{view['mission_id']}/executions",
                             {"idempotency_key": key, "task_id": task, **kw}, token=token)

    def digest(self, task):
        tasks = self.app.json("GET", "/v1/tasks")[2]["tasks"]
        return next(t["action_digest"] for t in tasks if t["task_id"] == task)

    def approve(self, view, digest):
        _, _, ch = self.app.json("POST", f"/v1/missions/{view['mission_id']}/approval-challenges", {
            "contract_digest": view["contract_digest"], "signing_key_id": "k-alice",
            "signature_alg": TEST_ALGORITHM, "action_digest": digest})
        sig = self.signer.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
        status, _, done = self.app.json("POST", f"/v1/missions/{view['mission_id']}/approvals", {
            "idempotency_key": "approve-" + ch["approval_event_id"][-10:], "approval_event_id": ch["approval_event_id"],
            "signing_key_id": "k-alice", "signature_alg": TEST_ALGORITHM, "signature_hex": sig})
        self.assertEqual((status, done["approval_status"]), (201, "granted"))

    def result(self, view, token=ALICE):
        return self.app.json("GET", f"/v1/missions/{view['mission_id']}/result", token=token)

    def code(self, response):
        return response[0], response[2].get("error", {}).get("code")


class VerticalSlice(ExecBase):
    def test_run_store_reload_and_never_claim_verification(self):
        tasks = self.app.json("GET", "/v1/tasks")[2]["tasks"]
        self.assertEqual([t["task_id"] for t in tasks], ["echo", "failing", "other", "slow"])
        echo = tasks[0]
        self.assertEqual(set(echo), {"task_id", "description", "action_digest", "risk_level", "limitations"})
        self.assertEqual(echo["limitations"], ["offline only"])

        view = self.mission()
        self.assertEqual(self.result(view)[2]["attempts"], [])
        status, _, res = self.execute(view)
        self.assertEqual(status, 201)
        self.assertEqual((res["state"], res["execution"], res["result_verification"]),
                         ("response_received", "started", "not_independently_verified"))
        (attempt,) = res["attempts"]
        self.assertEqual(attempt["dispatch_status"], "succeeded")
        self.assertEqual(attempt["output"]["answer"], 42)
        self.assertEqual(attempt["output"]["note"], "سلام")
        self.assertFalse(attempt["external_effect_confirmed"])
        self.assertIsNone(attempt["reconciliation"])
        self.assertEqual(attempt["limitations"], ["offline only"])
        canonical = json.dumps(attempt["output"], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.assertEqual(attempt["output_digest"], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertTrue(any("not independent verification" in n for n in res["notes"]))
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}")[2]["state"], "response_received")

        # reload: brand-new server, same audit log + registry file => identical stored result
        self.app.close()
        self.start(Counting())
        self.assertEqual(self.result(view)[2], res)
        types = [e["event_type"] for e in self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit")[2]["events"]]
        self.assertEqual(types, ["mission.contract_registered", "mission.dispatch_started",
                                 "mission.dispatch_finished", "mission.result_recorded"])

    def test_duplicates_never_run_the_task_twice(self):
        view = self.mission()
        self.assertEqual(self.execute(view)[0], 201)
        same_key = self.execute(view)
        self.assertEqual(self.code(same_key), (409, "duplicate_request"))
        new_key = self.execute(view, key="exec-key-0002")
        self.assertEqual(new_key[0], 409)
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(len(self.result(view)[2]["attempts"]), 1)

    def test_concurrent_identical_executions_run_once(self):
        view = self.mission()
        codes = []
        threads = [threading.Thread(target=lambda: codes.append(self.execute(view)[0])) for _ in range(6)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(sorted(codes), [201] + [409] * 5)
        self.assertEqual(self.adapter.calls, 1)

    def test_clarification_blocks_execution(self):
        view = self.mission(criteria=())
        self.assertEqual(self.code(self.execute(view)), (422, "clarification_required"))
        self.assertEqual(self.adapter.calls, 0)

    def test_request_rules(self):
        view = self.mission()
        self.assertEqual(self.code(self.execute(view, task="nope")), (400, "invalid_request"))
        for extra in ({"payload": {"x": 1}}, {"adapter": "x"}, {"user_id": "user:bob"}, {"integration_id": "i"}):
            self.assertEqual(self.code(self.execute(view, **extra)), (400, "invalid_request"), extra)
        self.assertEqual(self.code(self.execute(view, task="Bad Task!")), (400, "invalid_request"))
        self.assertEqual(self.code(self.execute(view, key="short")), (400, "invalid_request"))
        self.assertEqual(self.execute(view, token=None)[0], 401)
        self.assertEqual(self.code(self.execute(view, token=BOB)), (404, "not_found"))
        self.assertEqual(self.result(view, token=BOB)[0], 404)
        self.assertEqual(self.result(view, token=None)[0], 401)
        self.assertEqual(self.app.json("GET", "/v1/tasks", token=None)[0], 401)
        self.assertEqual(self.app.json("POST", "/v1/tasks", {})[0], 400)
        self.assertEqual(self.adapter.calls, 0)

    def test_unconfigured_execution_is_unavailable_and_lists_no_tasks(self):
        self.app.close()
        self.app = Running(self.path, self.verifier, self.clock, None)
        self.addCleanup(self.app.close)
        view = self.app.json("GET", "/v1/missions/" + "mission-" + "0" * 16)  # unknown mission is just 404
        self.assertEqual(view[0], 404)
        mission = self.mission(key="other-key-0001")
        self.assertEqual(self.app.json("GET", "/v1/tasks")[2]["tasks"], [])
        self.assertEqual(self.code(self.execute(mission)), (503, "unavailable"))


class ApprovedExecution(ExecBase):
    def test_high_risk_runs_only_the_exact_approved_action_once(self):
        view = self.mission(risk="high")
        self.assertEqual(self.code(self.execute(view)), (403, "approval_required"))  # no approval at all
        self.approve(view, self.digest("other"))                                      # approval for ANOTHER action
        self.assertEqual(self.code(self.execute(view)), (403, "approval_required"))
        self.assertEqual(self.adapter.calls, 0)
        self.approve(view, self.digest("echo"))
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}")[2]["approval_status"], "granted")
        status, _, res = self.execute(view)
        self.assertEqual((status, res["state"]), (201, "response_received"))
        self.assertEqual(self.adapter.calls, 1)
        # the approval was consumed: a second run needs a fresh approval
        self.assertEqual(self.code(self.execute(view, key="exec-key-0002")), (403, "approval_required"))
        self.assertEqual(self.adapter.calls, 1)
        # documented semantics: "granted" = at least one valid, unconsumed approval exists (each is bound
        # to its own action); the unconsumed approval for "other" is still valid here.
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}")[2]["approval_status"], "granted")

    def test_status_returns_to_required_once_the_only_approval_is_consumed(self):
        view = self.mission(risk="high")
        self.approve(view, self.digest("echo"))
        self.assertEqual(self.execute(view)[0], 201)
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}")[2]["approval_status"], "required")

    def test_expired_approval_cannot_execute(self):
        view = self.mission(risk="high")
        self.approve(view, self.digest("echo"))
        self.clock.advance(hours=2)
        self.assertEqual(self.code(self.execute(view)), (403, "approval_required"))
        self.assertEqual(self.adapter.calls, 0)

    def test_revoked_key_cannot_execute(self):
        view = self.mission(risk="high")
        self.approve(view, self.digest("echo"))
        self.verifier.revoked.add("k-alice")
        self.assertEqual(self.code(self.execute(view)), (403, "approval_required"))
        self.assertEqual(self.adapter.calls, 0)

    def test_medium_mission_requiring_approval_also_needs_a_signed_one(self):
        status, _, view = self.app.json("POST", "/v1/missions", {
            "idempotency_key": KEY, "objective": "o", "success_criteria": ["x"], "requires_approval": True})
        self.assertEqual(self.code(self.execute(view)), (403, "approval_required"))
        self.approve(view, self.digest("echo"))
        self.assertEqual(self.execute(view)[0], 201)


class UncertainOutcomes(ExecBase):
    def check_unknown(self, task, expected_status):
        view = self.mission()
        response = self.execute(view, task=task)
        self.assertEqual(self.code(response), (500, "outcome_unknown"))
        self.assertNotIn("secret-internal-detail", json.dumps(response[2]))
        res = self.result(view)[2]
        self.assertEqual((res["state"], res["attempts"][0]["dispatch_status"], res["attempts"][0]["output"]),
                         ("dispatch_unresolved", expected_status, None))
        self.assertFalse(res["attempts"][0]["external_effect_confirmed"])
        # an unresolved attempt blocks any further dispatch (no blind retry), whatever the task
        again = self.execute(view, task="echo", key="exec-key-0002")
        self.assertEqual(self.code(again), (409, "reconciliation_required"))
        self.assertEqual(self.adapter.calls, 0)
        self.assertNotIn("secret-internal-detail", json.dumps(self.result(view)[2]))

    def test_adapter_exception_is_unknown_not_failure_nor_success(self):
        self.check_unknown("failing", "adapter_error")
        self.assertEqual(Failing.calls, 1)

    def test_timeout_is_unknown(self):
        self.check_unknown("slow", "timeout")
        self.assertEqual(Slow.calls, 1)

    def test_output_that_must_not_be_stored_is_withheld_but_the_outcome_stays_honest(self):
        for output in ({"token": "sk-" + "a" * 40}, {"blob": "x" * 20000}):
            with self.subTest(output=list(output)):
                self.setUp()
                self.adapter.output = output
                view = self.mission()
                status, _, res = self.execute(view)
                self.assertEqual(status, 201)
                self.assertEqual((res["attempts"][0]["dispatch_status"], res["attempts"][0]["output"],
                                  res["attempts"][0]["output_digest"]), ("succeeded", None, None))
                self.assertNotIn("sk-", json.dumps(self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit")[2]))
                self.assertNotIn("sk-aaaa", self.path.read_text(encoding="utf-8").split("dispatch_finished")[-1])


class ReconciliationVisibility(ExecBase):
    def test_a_reconciled_attempt_shows_confirmation_and_unblocks_the_mission(self):
        from master_brain.mission_lifecycle import record_dispatch_reconciliation
        view = self.mission()
        self.assertEqual(self.code(self.execute(view, task="failing")), (500, "outcome_unknown"))
        attempt = self.result(view)[2]["attempts"][0]
        store = AuditStore(self.path, clock=self.clock)
        record_dispatch_reconciliation(
            store, view["mission_id"], attempt["attempt_id"], "effect_occurred", "provider-receipt-1",
            event_id="reconcile-1", recorded_at=self.clock.now.isoformat().replace("+00:00", "Z"), actor="operator:ops")
        res = self.result(view)[2]
        (shown,) = res["attempts"]
        self.assertEqual((res["state"], shown["reconciliation"], shown["external_effect_confirmed"]),
                         ("effect_reconciled", "effect_occurred", True))
        self.assertEqual(shown["dispatch_status"], "adapter_error")
        self.assertEqual(res["result_verification"], "not_independently_verified")
        self.assertEqual(self.execute(view, task="echo", key="exec-key-0002")[0], 201)  # unblocked
        self.assertEqual(len(self.result(view)[2]["attempts"]), 2)

    def test_reconciled_as_no_effect_is_not_confirmation(self):
        from master_brain.mission_lifecycle import record_dispatch_reconciliation
        view = self.mission()
        self.execute(view, task="failing")
        attempt = self.result(view)[2]["attempts"][0]
        record_dispatch_reconciliation(
            AuditStore(self.path, clock=self.clock), view["mission_id"], attempt["attempt_id"],
            "effect_did_not_occur", "provider-receipt-2", event_id="reconcile-2",
            recorded_at=self.clock.now.isoformat().replace("+00:00", "Z"), actor="operator:ops")
        (shown,) = self.result(view)[2]["attempts"]
        self.assertEqual((shown["reconciliation"], shown["external_effect_confirmed"]), ("effect_did_not_occur", False))


class ResultDetails(ExecBase):
    def test_output_digest_is_over_sorted_canonical_json_and_statuses_are_200(self):
        self.adapter.output = {"b": "سلام", "a": [3, 1], "c": {"z": 1, "y": 2}}
        view = self.mission()
        self.execute(view)
        status, _, res = self.result(view)
        self.assertEqual(status, 200)
        canonical = '{"a":[3,1],"b":"سلام","c":{"y":2,"z":1}}'
        self.assertEqual(res["attempts"][0]["output_digest"], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertEqual(self.app.json("GET", "/v1/tasks")[0], 200)
        audit = [e for e in self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit")[2]["events"]]
        self.assertEqual(len(audit), 4)
        raw = self.path.read_text(encoding="utf-8")
        self.assertIn(canonical, json.dumps(json.loads(raw.splitlines()[-1])["payload"]["output"], sort_keys=True,
                                            separators=(",", ":"), ensure_ascii=False))

    def test_attempt_order_and_other_missions_events_are_not_mixed(self):
        a, b = self.mission(key="mission-key-aaaa"), self.mission(key="mission-key-bbbb")
        self.execute(a, key="exec-key-aaaa")
        self.assertEqual(len(self.result(a)[2]["attempts"]), 1)
        self.assertEqual(self.result(b)[2]["attempts"], [])

    def test_unavailable_store_fails_closed_for_service_calls(self):
        from master_brain.identity import Identity
        from master_brain.api_contracts import ExecuteMissionRequest
        from master_brain.mission_service import MissionService, ServiceError
        view = self.mission()
        service = MissionService(AuditStore(self.path), self.verifier, self.config(self.adapter))
        self.path.write_text("garbage\n", encoding="utf-8")
        for call in (lambda: service.get_result(Identity("user:alice"), view["mission_id"]),
                     lambda: service.execute_mission(Identity("user:alice"), view["mission_id"],
                                                     ExecuteMissionRequest("exec-key-0009", "echo"))):
            with self.assertRaises(ServiceError) as ctx:
                call()
            self.assertEqual(ctx.exception.code.value, "unavailable")
        self.assertEqual(self.adapter.calls, 0)


class AuditIntegrity(ExecBase):
    def test_tampered_log_fails_closed_for_execution_endpoints(self):
        view = self.mission()
        self.execute(view)
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(text.replace("Run offline task", "Run attacker task"), encoding="utf-8")
        self.assertEqual(self.result(view)[0], 503)
        self.assertEqual(self.execute(view, key="exec-key-0003")[0], 503)
        self.assertEqual(self.adapter.calls, 1)


if __name__ == "__main__":
    unittest.main()
