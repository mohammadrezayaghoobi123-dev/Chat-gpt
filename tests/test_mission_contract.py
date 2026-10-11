import unittest

from master_brain.archipelago import plan_mission
from master_brain.core import RiskTier, Task
from master_brain.meta_intelligence import Mission, ReviewLevel, plan_coordination
from master_brain.mission_contract import (
    MissionContract,
    MissionReviewLevel,
    MissionRiskTier,
    from_archipelago_plan,
    from_coordination_plan,
    from_core_task,
    evaluate_execution_gate,
)


class MissionContractTests(unittest.TestCase):
    def test_same_request_has_stable_cross_planner_identity(self):
        objective = "Research the factory energy risk"
        core = from_core_task(Task(objective, risk=RiskTier.MEDIUM))
        archipelago = from_archipelago_plan(plan_mission(objective))
        meta = from_coordination_plan(plan_coordination(Mission(objective)))

        self.assertEqual(core.mission_id, archipelago.mission_id)
        self.assertEqual(core.mission_id, meta.mission_id)
        self.assertEqual(core.schema_version, "1.0")

    def test_core_mapping_preserves_constraints_risk_and_approval_gate(self):
        contract = from_core_task(Task(
            objective="Deploy a production change",
            constraints=("no downtime", "preserve audit history"),
            risk=RiskTier.CRITICAL,
            requires_external_action=True,
        ))
        self.assertEqual(contract.constraints, ("no downtime", "preserve audit history"))
        self.assertEqual(contract.risk_tier, MissionRiskTier.CRITICAL)
        self.assertTrue(contract.requires_approval)
        self.assertEqual(contract.review_level, MissionReviewLevel.HUMAN_GATED)
        self.assertIn("planner=core.route_task", contract.traceability)

    def test_archipelago_mapping_preserves_islands_gaps_and_foundations(self):
        legacy = plan_mission("Research factory manufacturing risks")
        contract = from_archipelago_plan(legacy)
        self.assertEqual(
            contract.selected_islands,
            tuple(item.island_id for item in legacy.assignments),
        )
        self.assertEqual(contract.dependencies, legacy.shared_foundations)
        self.assertEqual(contract.capability_gaps, legacy.capability_gaps)
        self.assertIn("planner=archipelago.plan_mission", contract.traceability)

    def test_meta_mapping_preserves_budget_deadline_and_review_level(self):
        legacy = plan_coordination(Mission(
            objective="Research the factory process",
            constraints=("keep records",),
            success_criteria=("verified output",),
            risk_tier="high",
            irreversible_action=False,
            budget_units=7,
            deadline_seconds=90,
        ))
        contract = from_coordination_plan(legacy, constraints=("keep records",),
                                          success_criteria=("verified output",),
                                          risk_tier=MissionRiskTier.HIGH)
        self.assertEqual(contract.budget_units, 7)
        self.assertEqual(contract.deadline_seconds, 90)
        self.assertEqual(contract.review_level, MissionReviewLevel.STRICT)
        self.assertTrue(contract.requires_approval)
        self.assertEqual(contract.success_criteria, ("verified output",))

    def test_contract_rejects_invalid_budget_and_duplicate_islands(self):
        with self.assertRaisesRegex(ValueError, "budget"):
            MissionContract(
                mission_id="mission-test", objective="x",
                budget_units=-1,
            )
        with self.assertRaisesRegex(ValueError, "selected island"):
            MissionContract(
                mission_id="mission-test", objective="x",
                selected_islands=("science_research", "science_research"),
            )

    def test_execution_gate_fails_closed_for_high_risk_without_approval(self):
        contract = from_core_task(Task(
            objective="Deploy production change",
            risk=RiskTier.HIGH,
        ))
        blocked = evaluate_execution_gate(contract)
        self.assertFalse(blocked.allowed)
        self.assertIn(
            "audited approval receipt is required; boolean approval assertions are not accepted",
            blocked.reasons,
        )
        # A caller-supplied boolean is not an auditable approval credential.
        still_blocked = evaluate_execution_gate(contract, approval_granted=True)
        self.assertFalse(still_blocked.allowed)
        self.assertIn(
            "audited approval receipt is required; boolean approval assertions are not accepted",
            still_blocked.reasons,
        )

    def test_execution_gate_blocks_unresolved_clarification_even_if_approved(self):
        contract = from_core_task(Task(objective=""))
        result = evaluate_execution_gate(contract, approval_granted=True)
        self.assertFalse(result.allowed)
        self.assertIn("mission requires clarification before dispatch", result.reasons)

    def test_execution_gate_is_policy_only_and_never_claims_dispatch(self):
        contract = from_core_task(Task(objective="Summarize a public report"))
        result = evaluate_execution_gate(contract)
        self.assertTrue(result.allowed)
        self.assertFalse(hasattr(result, "dispatch_performed"))

    def test_human_gated_review_level_requires_approval_in_contract(self):
        with self.assertRaisesRegex(ValueError, "human_gated review requires approval"):
            MissionContract(
                mission_id="mission-human-gated", objective="Review production change",
                risk_tier=MissionRiskTier.MEDIUM,
                review_level=MissionReviewLevel.HUMAN_GATED,
                requires_approval=False,
            )

    def test_direct_blank_contract_cannot_pass_legacy_policy_gate(self):
        contract = MissionContract(mission_id="mission-direct-empty", objective="")
        result = evaluate_execution_gate(contract)
        self.assertFalse(result.allowed)
        self.assertIn("mission objective is empty and requires clarification", result.reasons)

    def test_empty_objective_is_retained_and_requires_clarification(self):
        contract = from_core_task(Task(objective=""))
        self.assertEqual(contract.objective, "")
        self.assertTrue(contract.unknowns)
        self.assertTrue(contract.clarification_questions)


if __name__ == "__main__":
    unittest.main()
