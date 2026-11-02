"""budget_units is enforced on the real path: each attempt is charged estimated_cost_per_call (exactly, in the audit
log, atomically with the dispatch-started event); an unknown cost is refused (owner decision)."""
import unittest
from dataclasses import replace

from master_brain.integrations import (IntegrationDescriptor, IntegrationHealth, IntegrationKind,
                                       IntegrationMaturity, IntegrationRequirement)
from master_brain.mission_approval import mission_contract_digest
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.mission_execution import execute_mission_once
from tests.mission_registration_helper import register_contract
from tests.test_mission_execution import Adapter, PipelineFixture


def priced(cost):
    return IntegrationDescriptor(
        integration_id="priced", version="1", kind=IntegrationKind.MODEL, capabilities=("text_reasoning",),
        maturity=IntegrationMaturity.ENABLED, health=IntegrationHealth.AVAILABLE, risk_level=0,
        estimated_cost_per_call=cost)


class Budget(PipelineFixture):
    __test__ = True

    def setUp(self):
        super().setUp()
        self.n = 0

    def contract_with(self, budget):
        self.contract = MissionContract(
            mission_id="mission-44", objective="Execute controlled test", risk_tier=MissionRiskTier.MEDIUM,
            requires_approval=True, budget_units=budget)
        register_contract(self.store, self.contract)
        self.payload = {"mission_id": "mission-44", "prompt": "test"}
        from master_brain.mission_approval import record_mission_approval
        from tests.approval_expiry_helper import soon
        self.receipt = record_mission_approval(
            self.store, self.contract, event_id="approval-44", recorded_at="2026-10-12T00:00:00Z",
            approver_subject="user:reviewer", authentication_method="upstream-session", expires_at=soon())

    def run_it(self, adapter, cost):
        self.n += 1
        return execute_mission_once(
            self.contract, self.store, self.receipt, priced(cost), self.requirement, adapter, self.payload,
            event_id_prefix=f"run-44-{self.n}", recorded_at=f"2026-10-12T00:01:{self.n:02d}Z", actor="system:test")

    def started(self):
        return [e for e in self.store.read_all() if e.event_type == "mission.dispatch_started"]

    def test_an_unknown_cost_is_refused_before_anything_happens(self):
        self.contract_with(10)
        adapter = Adapter()
        result = self.run_it(adapter, None)
        self.assertEqual((result.status, result.reason), ("rejected", "cost_unknown_budget_enforced"))
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(self.started(), [])

    def test_each_attempt_is_charged_and_the_next_one_that_does_not_fit_is_refused(self):
        self.contract_with(3)
        adapter = Adapter()
        self.assertEqual(self.run_it(adapter, 2.0).status, "response_received")
        self.assertEqual([e.payload["estimated_cost"] for e in self.started()], ["2.0"])
        second = self.run_it(adapter, 2.0)
        self.assertEqual((second.status, second.reason), ("rejected", "budget_exceeded"))
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(len(self.started()), 1)

    def test_spending_exactly_the_budget_is_allowed_and_one_more_is_not(self):
        self.contract_with(4)
        adapter = Adapter()
        self.assertEqual(self.run_it(adapter, 2.0).status, "response_received")
        self.assertEqual(self.run_it(adapter, 2.0).status, "response_received")
        self.assertEqual(self.run_it(adapter, 2.0).reason, "budget_exceeded")
        self.assertEqual(adapter.calls, 2)

    def test_free_calls_fit_a_zero_budget_but_a_paid_call_does_not(self):
        self.contract_with(0)
        adapter = Adapter()
        self.assertEqual(self.run_it(adapter, 0.0).status, "response_received")
        self.assertEqual(self.run_it(adapter, 0.5).reason, "budget_exceeded")
        self.assertEqual(adapter.calls, 1)

    def test_sums_are_exact_not_floating_point(self):
        self.contract_with(11)  # ten calls of 1.1 are exactly 11; float addition gives 11.000000000000002
        adapter = Adapter()
        for _ in range(10):
            self.assertEqual(self.run_it(adapter, 1.1).status, "response_received")
        self.assertEqual(self.run_it(adapter, 1.1).reason, "budget_exceeded")
        self.assertEqual(adapter.calls, 10)

    def test_a_refused_attempt_costs_nothing(self):
        self.contract_with(2)
        adapter = Adapter()
        no_approval = execute_mission_once(
            self.contract, self.store, None, priced(2.0), self.requirement, adapter, self.payload,
            event_id_prefix="noappr", recorded_at="2026-10-12T00:01:00Z", actor="system:test")
        self.assertEqual(no_approval.status, "rejected")
        self.assertEqual(self.started(), [])
        self.assertEqual(self.run_it(adapter, 2.0).status, "response_received")  # the whole budget is still there

    def test_a_failed_attempt_is_still_charged(self):
        self.contract_with(2)

        class Boom:
            def invoke(self, payload):
                raise RuntimeError("after an unknown effect")
        self.assertEqual(self.run_it(Boom(), 2.0).status, "outcome_unknown")
        self.assertEqual([e.payload["estimated_cost"] for e in self.started()], ["2.0"])

    def test_a_cost_the_ledger_cannot_read_stops_execution(self):
        self.contract_with(10)
        adapter = Adapter()
        self.assertEqual(self.run_it(adapter, 1.0).status, "response_received")
        self.store._cache = None  # (no cache here) tamper through the legal API instead: forge a bad prior charge
        self.store.append(event_id="forged-start", event_type="mission.dispatch_started",
                          recorded_at="2026-10-12T00:05:00Z", actor="system:test",
                          subject_ref=f"mission:{self.contract.mission_id}",
                          payload={"mission_id": self.contract.mission_id, "contract_digest": mission_contract_digest(self.contract),
                                   "integration_id": "x", "attempt_id": "forged", "estimated_cost": "abc"})
        self.store.append(event_id="forged-fin", event_type="mission.dispatch_finished",
                          recorded_at="2026-10-12T00:05:01Z", actor="system:test",
                          subject_ref=f"mission:{self.contract.mission_id}",
                          payload={"mission_id": self.contract.mission_id, "integration_id": "x",
                                   "attempt_id": "forged", "dispatch_status": "succeeded", "reason": "",
                                   "external_effect_confirmed": False})
        result = self.run_it(adapter, 1.0)
        self.assertEqual((result.status, result.reason), ("rejected", "budget_ledger_unreadable"))
        self.assertEqual(adapter.calls, 1)

    def test_attempts_recorded_before_costs_existed_count_as_free(self):
        self.contract_with(2)
        adapter = Adapter()
        self.store.append(event_id="legacy-start", event_type="mission.dispatch_started",
                          recorded_at="2026-10-12T00:00:30Z", actor="system:test",
                          subject_ref=f"mission:{self.contract.mission_id}",
                          payload={"mission_id": self.contract.mission_id, "contract_digest": mission_contract_digest(self.contract),
                                   "integration_id": "x", "attempt_id": "legacy"})
        self.store.append(event_id="legacy-fin", event_type="mission.dispatch_finished",
                          recorded_at="2026-10-12T00:00:31Z", actor="system:test",
                          subject_ref=f"mission:{self.contract.mission_id}",
                          payload={"mission_id": self.contract.mission_id, "integration_id": "x",
                                   "attempt_id": "legacy", "dispatch_status": "succeeded", "reason": "",
                                   "external_effect_confirmed": False})
        self.assertEqual(self.run_it(adapter, 2.0).status, "response_received")

    def test_other_missions_charges_do_not_count(self):
        self.contract_with(2)
        adapter = Adapter()
        self.store.append(event_id="other-start", event_type="mission.dispatch_started",
                          recorded_at="2026-10-12T00:00:30Z", actor="system:test", subject_ref="mission:other",
                          payload={"mission_id": "other", "contract_digest": mission_contract_digest(self.contract), "integration_id": "x",
                                   "attempt_id": "o1", "estimated_cost": "99"})
        self.assertEqual(self.run_it(adapter, 2.0).status, "response_received")


if __name__ == "__main__":
    unittest.main()


class Direct(unittest.TestCase):
    """The two helpers, exercised on every malformed shape (the pipeline cannot reach most of them)."""

    def test_attempt_cost_accepts_only_finite_non_negative_numbers(self):
        from types import SimpleNamespace as NS
        from decimal import Decimal
        from master_brain.mission_execution import _attempt_cost
        ok = {0: "0", 0.0: "0.0", 3: "3", 2.5: "2.5", 1e-3: "0.001"}
        for raw, text in ok.items():
            with self.subTest(raw=raw):
                self.assertEqual(_attempt_cost(NS(estimated_cost_per_call=raw)), (Decimal(text), None))
        self.assertEqual(_attempt_cost(NS()), (None, "cost_unknown_budget_enforced"))
        self.assertEqual(_attempt_cost(NS(estimated_cost_per_call=None)), (None, "cost_unknown_budget_enforced"))
        for bad in (True, False, "1", b"1", [1], -1, -0.5, float("inf"), float("-inf"), float("nan")):
            with self.subTest(bad=bad):
                self.assertEqual(_attempt_cost(NS(estimated_cost_per_call=bad)), (None, "cost_invalid"))

    def test_the_ledger_sum_is_exact_and_every_unreadable_charge_stops_execution(self):
        from decimal import Decimal
        from types import SimpleNamespace as NS
        from master_brain.mission_execution import _budget_reason

        def ev(charge, mission="m", kind="mission.dispatch_started", present=True):
            payload = {"mission_id": mission}
            if present:
                payload["estimated_cost"] = charge
            return NS(event_type=kind, payload=payload)
        # exact decimal arithmetic: 0.1 + 0.2 spent, 0.7 more fits a budget of 1 exactly; 0.71 does not
        history = [ev("0.1"), ev("0.2")]
        self.assertIsNone(_budget_reason(history, "m", 1, Decimal("0.7")))
        self.assertEqual(_budget_reason(history, "m", 1, Decimal("0.71")), "budget_exceeded")
        self.assertIsNone(_budget_reason([], "m", 0, Decimal(0)))      # free call on a zero budget
        self.assertEqual(_budget_reason([], "m", 0, Decimal("0.01")), "budget_exceeded")
        # other missions, other event kinds and legacy events without a charge do not count
        noise = [ev("9", mission="other"), ev("9", kind="mission.dispatch_finished"), ev(None, present=False)]
        self.assertIsNone(_budget_reason(noise, "m", 1, Decimal(1)))
        for bad in ("abc", "-0.5", "NaN", "Infinity", "-Infinity", "", [1], {"a": 1}, 1.5.__class__):
            with self.subTest(bad=bad):
                self.assertEqual(_budget_reason([ev(bad)], "m", 100, Decimal(1)), "budget_ledger_unreadable")
        self.assertIsNone(_budget_reason([ev("0")], "m", 1, Decimal(1)))  # a recorded zero charge is fine
