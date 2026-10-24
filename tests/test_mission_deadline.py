"""The mission contract's deadline_seconds is a real runtime limit on the external call (it used to be metadata only)."""
import time
import unittest

from master_brain.dispatch import DispatchStatus
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.mission_execution import effective_dispatch_timeout, execute_mission_once
from tests.mission_registration_helper import register_contract
from tests.test_mission_execution import PipelineFixture, descriptor


class Sleeps:
    def __init__(self, seconds):
        self.seconds, self.calls = seconds, 0

    def invoke(self, payload):
        self.calls += 1
        time.sleep(self.seconds)
        return {"fine": True}


class Helper(unittest.TestCase):
    def test_the_smaller_of_server_cap_and_mission_deadline_wins(self):
        self.assertEqual(effective_dispatch_timeout(30.0, 5), 5.0)
        self.assertEqual(effective_dispatch_timeout(2.5, 120), 2.5)
        self.assertEqual(effective_dispatch_timeout(7, 7), 7.0)

    def test_without_a_server_cap_the_mission_deadline_applies(self):
        self.assertEqual(effective_dispatch_timeout(None, 120), 120.0)

    def test_an_invalid_server_value_is_passed_through_so_dispatch_still_rejects_it(self):
        for bad in (True, "5", -1, float("nan"), float("inf"), 0):
            self.assertIs(effective_dispatch_timeout(bad, 5), bad)

    def test_the_result_is_always_a_float(self):
        self.assertIsInstance(effective_dispatch_timeout(30, 5), float)
        self.assertIsInstance(effective_dispatch_timeout(None, 5), float)


class Pipeline(PipelineFixture):
    __test__ = True

    def setUp(self):
        super().setUp()
        self.contract = MissionContract(
            mission_id="mission-43", objective="Execute controlled test",
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True, deadline_seconds=1)
        register_contract(self.store, self.contract)
        self.payload = {"mission_id": "mission-43", "prompt": "test"}

    def run_it(self, adapter, server_timeout):
        receipt = self.approve_for(self.contract)
        started = time.monotonic()
        result = execute_mission_once(
            self.contract, self.store, receipt, descriptor(), self.requirement, adapter, self.payload,
            event_id_prefix="run-43", recorded_at="2026-10-12T00:01:00Z", actor="system:test",
            dispatch_timeout_seconds=server_timeout)
        return result, time.monotonic() - started

    def approve_for(self, contract):
        from master_brain.mission_approval import record_mission_approval
        from tests.approval_expiry_helper import soon
        return record_mission_approval(
            self.store, contract, event_id="approval-43", recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer", authentication_method="upstream-session", expires_at=soon())

    def test_a_call_longer_than_the_mission_deadline_is_cut_off_even_with_a_generous_server_cap(self):
        adapter = Sleeps(3.0)
        result, elapsed = self.run_it(adapter, 30.0)
        self.assertIs(result.dispatch_result.status, DispatchStatus.TIMEOUT)
        self.assertEqual(result.status, "outcome_unknown")  # a timeout never claims "no effect"
        self.assertLess(elapsed, 2.5)
        self.assertEqual(adapter.calls, 1)

    def test_without_any_server_cap_the_deadline_still_bounds_the_call(self):
        result, elapsed = self.run_it(Sleeps(3.0), None)
        self.assertIs(result.dispatch_result.status, DispatchStatus.TIMEOUT)
        self.assertLess(elapsed, 2.5)

    def test_a_tighter_server_cap_still_wins(self):
        result, elapsed = self.run_it(Sleeps(3.0), 0.2)
        self.assertIs(result.dispatch_result.status, DispatchStatus.TIMEOUT)
        self.assertLess(elapsed, 0.9)

    def test_a_call_inside_the_deadline_is_not_affected(self):
        result, _ = self.run_it(Sleeps(0.05), 30.0)
        self.assertEqual(result.status, "response_received")


if __name__ == "__main__":
    unittest.main()
