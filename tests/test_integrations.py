import unittest

from master_brain.integrations import (
    CandidateAssessment,
    IntegrationDescriptor,
    IntegrationHealth,
    IntegrationKind,
    IntegrationMaturity,
    IntegrationRequirement,
    assess_candidates,
    assess_integration,
)


def enabled_model(**overrides):
    values = dict(
        integration_id="model-a",
        version="1",
        kind=IntegrationKind.MODEL,
        capabilities=("text_reasoning", "structured_output"),
        maturity=IntegrationMaturity.ENABLED,
        health=IntegrationHealth.AVAILABLE,
        permission_scopes=("inference",),
        risk_level=0,
        estimated_cost_per_call=0.02,
        data_regions=("eu",),
    )
    values.update(overrides)
    return IntegrationDescriptor(**values)


class IntegrationRegistryContractTests(unittest.TestCase):
    def test_matching_enabled_healthy_candidate_is_eligible(self):
        result = assess_integration(enabled_model(), IntegrationRequirement(
            capabilities=("text_reasoning",),
            required_permission_scopes=("inference",),
            allowed_data_regions=("eu",),
            max_risk_level=1,
            max_cost_per_call=0.05,
        ))
        self.assertEqual(result, CandidateAssessment("model-a", True, ()))

    def test_discovered_candidate_is_not_eligible_even_if_capable(self):
        result = assess_integration(enabled_model(maturity=IntegrationMaturity.DISCOVERED),
                                    IntegrationRequirement(("text_reasoning",)))
        self.assertFalse(result.eligible)
        self.assertIn("integration is not enabled", result.reasons)

    def test_unknown_health_is_not_treated_as_available(self):
        result = assess_integration(enabled_model(health=IntegrationHealth.UNKNOWN),
                                    IntegrationRequirement(("text_reasoning",)))
        self.assertFalse(result.eligible)
        self.assertTrue(any("health is unknown" in reason for reason in result.reasons))

    def test_missing_capability_and_scope_are_explained(self):
        result = assess_integration(enabled_model(), IntegrationRequirement(
            ("vision",), required_permission_scopes=("vision",)))
        self.assertFalse(result.eligible)
        self.assertTrue(any("missing capabilities" in reason for reason in result.reasons))
        self.assertTrue(any("missing permission scopes" in reason for reason in result.reasons))

    def test_unknown_cost_fails_closed_when_budget_is_bounded(self):
        result = assess_integration(enabled_model(estimated_cost_per_call=None),
                                    IntegrationRequirement(("text_reasoning",), max_cost_per_call=0.1))
        self.assertFalse(result.eligible)
        self.assertIn("cost is unknown under a bounded-cost requirement", result.reasons)

    def test_region_mismatch_and_risk_limit_exclude_candidate(self):
        result = assess_integration(enabled_model(data_regions=("us",), risk_level=3),
                                    IntegrationRequirement(("text_reasoning",),
                                                           allowed_data_regions=("eu",),
                                                           max_risk_level=1))
        self.assertFalse(result.eligible)
        self.assertIn("no allowed data-region match", result.reasons)
        self.assertIn("integration risk level exceeds mission limit", result.reasons)

    def test_required_kind_rejects_wrong_kind_even_when_capabilities_match(self):
        action_tool = enabled_model(kind=IntegrationKind.ACTION_TOOL)
        result = assess_integration(
            action_tool,
            IntegrationRequirement(
                capabilities=("text_reasoning",),
                required_kind=IntegrationKind.MODEL,
            ),
        )
        self.assertFalse(result.eligible)
        self.assertIn(
            "integration kind is action_tool, not required kind model",
            result.reasons,
        )

    def test_required_kind_accepts_matching_kind(self):
        result = assess_integration(
            enabled_model(),
            IntegrationRequirement(
                capabilities=("text_reasoning",),
                required_kind=IntegrationKind.MODEL,
            ),
        )
        self.assertTrue(result.eligible)
        self.assertEqual(result.reasons, ())

    def test_required_kind_rejects_wrong_runtime_type(self):
        with self.assertRaises(TypeError):
            IntegrationRequirement(
                capabilities=("text_reasoning",),
                required_kind="model",
            )

    def test_legacy_positional_requirement_arguments_remain_compatible(self):
        requirement = IntegrationRequirement(
            ("text_reasoning",),
            ("read:public",),
            ("eu",),
            2,
            0.25,
        )
        self.assertEqual(requirement.required_permission_scopes, ("read:public",))
        self.assertEqual(requirement.allowed_data_regions, ("eu",))
        self.assertEqual(requirement.max_risk_level, 2)
        self.assertEqual(requirement.max_cost_per_call, 0.25)
        self.assertIsNone(requirement.required_kind)

    def test_candidate_assessment_does_not_claim_execution(self):
        results = assess_candidates(
            (enabled_model(), enabled_model(integration_id="model-b",
                                            maturity=IntegrationMaturity.REVIEWED)),
            IntegrationRequirement(("text_reasoning",)))
        self.assertEqual([item.eligible for item in results], [True, False])
        self.assertFalse(hasattr(results[0], "executed"))

    def test_invalid_risk_level_is_rejected(self):
        with self.assertRaises(ValueError):
            enabled_model(risk_level=True)


if __name__ == "__main__":
    unittest.main()
