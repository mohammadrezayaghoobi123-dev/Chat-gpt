import unittest

from master_brain.dispatch import DispatchStatus, dispatch_once
from master_brain.integrations import (
    IntegrationDescriptor, IntegrationHealth, IntegrationKind,
    IntegrationMaturity, IntegrationRequirement,
)


class CountingAdapter:
    def __init__(self):
        self.calls = 0

    def invoke(self, payload):
        self.calls += 1
        return {"ok": True}


def eligible_descriptor():
    return IntegrationDescriptor(
        integration_id="test-model",
        version="1",
        kind=IntegrationKind.MODEL,
        capabilities=("text_reasoning",),
        maturity=IntegrationMaturity.ENABLED,
        health=IntegrationHealth.AVAILABLE,
        risk_level=0,
        estimated_cost_per_call=0.0,
    )


class DispatchInvalidContractTypeTests(unittest.TestCase):
    def setUp(self):
        self.requirement = IntegrationRequirement(("text_reasoning",))
        self.payload = {"question": "test"}

    def test_invalid_descriptor_type_fails_closed_before_invocation(self):
        adapter = CountingAdapter()
        result = dispatch_once(None, self.requirement, adapter, self.payload)
        self.assertEqual(result.status, DispatchStatus.REJECTED)
        self.assertEqual(result.reason, "integration_descriptor_invalid")
        self.assertEqual(adapter.calls, 0)

    def test_invalid_requirement_type_fails_closed_before_invocation(self):
        adapter = CountingAdapter()
        result = dispatch_once(eligible_descriptor(), None, adapter, self.payload)
        self.assertEqual(result.status, DispatchStatus.REJECTED)
        self.assertEqual(result.reason, "integration_requirement_invalid")
        self.assertEqual(adapter.calls, 0)


if __name__ == "__main__":
    unittest.main()
