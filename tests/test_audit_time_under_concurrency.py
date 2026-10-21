"""Root-cause tests: audit timestamps must be assigned under the store lock.

A timestamp taken before the lock can be older than an event another request appended in the
meantime; the store (correctly) refuses to backdate, so a perfectly valid write fails. For an
execution that is catastrophic: the adapter already ran, the 'finished' append is refused and the
mission is reported ``outcome_unknown`` although nothing was wrong."""
import tempfile
import unittest
from pathlib import Path

from master_brain.api_contracts import CreateMissionRequest, ExecuteMissionRequest
from master_brain.audit_store import AuditStore
from master_brain.execution_registry import SQLiteExecutionRegistry
from master_brain.identity import Identity
from master_brain.mission_service import ExecutionConfig, MissionService
from master_brain.task_catalog import TaskCatalog
from tests.test_http_approvals import FakeClock
from tests.test_task_catalog import make

ALICE, BOB = Identity("user:alice"), Identity("user:bob")


class Rendezvous:
    """Adapter that lets the rest of the system make progress while 'the work' runs."""

    def __init__(self, during):
        self.during, self.calls = during, 0

    def invoke(self, payload):
        self.calls += 1
        self.during()
        return {"done": True}


class AuditTimeUnderConcurrency(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.clock = FakeClock()
        self.store = AuditStore(Path(tmp.name) / "a.jsonl", clock=self.clock)
        self.registry = SQLiteExecutionRegistry(str(Path(tmp.name) / "r.sqlite"))
        self.adapter = Rendezvous(self.other_activity)
        config = ExecutionConfig(TaskCatalog([make("work", adapter=self.adapter)]), self.registry,
                                 dispatch_timeout_seconds=5.0)
        self.service = MissionService(self.store, None, config)

    def other_activity(self):
        self.clock.advance(seconds=2)  # time passes while the adapter runs...
        self.service.create_mission(BOB, CreateMissionRequest(
            idempotency_key="bob-key-0001", objective="bob", success_criteria=("x",)))  # ...others write

    def test_a_slow_execution_is_not_failed_by_unrelated_writes_during_dispatch(self):
        view = self.service.create_mission(ALICE, CreateMissionRequest(
            idempotency_key="alice-key-0001", objective="alice", success_criteria=("x",))).view
        result = self.service.execute_mission(ALICE, view.mission_id, ExecuteMissionRequest("exec-key-0001", "work"))
        self.assertEqual((result.state, result.attempts[0].dispatch_status), ("response_received", "succeeded"))
        self.assertEqual(self.adapter.calls, 1)
        types = [e.event_type for e in self.store.read_all() if e.subject_ref == f"mission:{view.mission_id}"]
        self.assertEqual(types, ["mission.contract_registered", "mission.dispatch_started",
                                 "mission.dispatch_finished", "mission.result_recorded"])


if __name__ == "__main__":
    unittest.main()


class NowSentinelTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def append(self, store, n, recorded_at):
        return store.append(event_id=f"e{n}", event_type="mission.contract_registered", recorded_at=recorded_at,
                            actor="x", subject_ref=f"mission:m{n}",
                            payload={"mission_id": f"m{n}", "contract_schema_version": "1",
                                     "contract_digest": "d" * 64, "contract": {}})

    def test_now_is_a_singleton_stamped_from_the_store_clock_under_the_lock(self):
        from master_brain.audit_store import NOW, _NowType
        self.assertIs(NOW, _NowType())
        self.assertEqual(repr(NOW), "NOW")
        clock = FakeClock()
        store = AuditStore(self.tmp / "a.jsonl", clock=clock)
        first = self.append(store, 1, NOW)
        self.assertEqual(first.recorded_at, clock.now.isoformat().replace("+00:00", "Z"))
        clock.advance(seconds=5)
        second = self.append(store, 2, NOW)
        self.assertEqual(second.recorded_at, clock.now.isoformat().replace("+00:00", "Z"))
        with self.assertRaises(Exception):  # an explicit stale timestamp is still refused (no backdating)
            self.append(store, 3, first.recorded_at)

    def test_many_concurrent_writers_never_fail_on_timestamp_order(self):
        import threading
        store = AuditStore(self.tmp / "b.jsonl")  # real clock
        errors = []

        def go(n):
            try:
                self.append(store, n, NOW)
            except Exception as exc:  # pragma: no cover - the failure being proven absent
                errors.append(repr(exc))
        from master_brain.audit_store import NOW
        threads = [threading.Thread(target=go, args=(n,)) for n in range(40)]
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        self.assertEqual(errors, [])
        stamps = [e.recorded_at for e in store.read_all()]
        self.assertEqual(len(stamps), 40)
        self.assertEqual(stamps, sorted(stamps))

    def test_a_clock_that_goes_backwards_still_fails_closed(self):
        from master_brain.audit_store import NOW
        clock = FakeClock()
        store = AuditStore(self.tmp / "c.jsonl", clock=clock)
        self.append(store, 1, NOW)
        clock.advance(seconds=-10)
        with self.assertRaises(Exception):
            self.append(store, 2, NOW)
        self.assertEqual(len(store.read_all()), 1)

    def test_executors_and_approvals_accept_now_but_still_reject_garbage(self):
        from master_brain.audit_store import NOW
        from master_brain.mission_approval import record_mission_approval
        from master_brain.mission_contract import MissionContract
        from tests.mission_registration_helper import register_contract
        store = AuditStore(self.tmp / "d.jsonl", clock=FakeClock())
        contract = MissionContract(mission_id="m-now", objective="o", requires_approval=True)
        register_contract(store, contract)
        for bad in ("", "  ", None, 5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                record_mission_approval(store, contract, event_id="ap-bad", recorded_at=bad,
                                        approver_subject="u", authentication_method="m")
        receipt = record_mission_approval(store, contract, event_id="ap-now", recorded_at=NOW,
                                          approver_subject="u", authentication_method="m")
        self.assertTrue(receipt.recorded_at.endswith("Z"))
        from tests.test_mission_execution import Adapter, descriptor
        from master_brain.mission_execution import execute_mission_idempotently, execute_mission_once
        from master_brain.integrations import IntegrationRequirement
        req = IntegrationRequirement(("text_reasoning",))
        registry = SQLiteExecutionRegistry(str(self.tmp / "r.sqlite"))
        for bad in ("", None, 5, "not-a-timestamp"):
            result = execute_mission_idempotently(
                contract, store, receipt, descriptor(), req, Adapter(), {}, registry,
                idempotency_key=f"k-{bad}", event_id_prefix="p", recorded_at=bad, actor="a")
            self.assertEqual((result.status, result.reason), ("rejected", "invalid_recorded_at"), bad)
        ok = execute_mission_idempotently(
            contract, store, receipt, descriptor(), req, Adapter(), {}, registry,
            idempotency_key="k-ok", event_id_prefix="p", recorded_at=NOW, actor="a")
        self.assertEqual(ok.status, "response_received")
        direct = execute_mission_once(contract, store, receipt, descriptor(), req, Adapter(), {},
                                      event_id_prefix="q", recorded_at=NOW, actor="a")
        self.assertIn(direct.status, ("response_received", "rejected"))
