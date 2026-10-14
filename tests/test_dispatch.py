import unittest

from master_brain.dispatch import DispatchStatus, dispatch_once
from master_brain.integrations import (
    IntegrationDescriptor, IntegrationHealth, IntegrationKind,
    IntegrationMaturity, IntegrationRequirement,
)


def descriptor(**overrides):
    data = dict(
        integration_id="fake-model", version="1",
        kind=IntegrationKind.MODEL, capabilities=("text_reasoning",),
        maturity=IntegrationMaturity.ENABLED, health=IntegrationHealth.AVAILABLE,
        permission_scopes=(), risk_level=0, estimated_cost_per_call=0.0,
    )
    data.update(overrides)
    return IntegrationDescriptor(**data)


class FakeAdapter:
    def __init__(self, output=None, error=None):
        self.output = {"answer": "ok"} if output is None else output
        self.error = error
        self.calls = 0

    def invoke(self, payload):
        self.calls += 1
        if self.error:
            raise self.error
        return self.output


class DispatchContractTests(unittest.TestCase):
    def setUp(self):
        self.requirement = IntegrationRequirement(("text_reasoning",))
        self.payload = {"mission_id": "m-1", "question": "test"}

    def test_eligible_adapter_runs_once_and_returns_structured_success(self):
        adapter = FakeAdapter()
        result = dispatch_once(descriptor(), self.requirement, adapter, self.payload)
        self.assertEqual(result.status, DispatchStatus.SUCCEEDED)
        self.assertEqual(result.output, {"answer": "ok"})
        self.assertEqual(adapter.calls, 1)

    def test_ineligible_integration_is_never_invoked(self):
        adapter = FakeAdapter()
        result = dispatch_once(descriptor(health=IntegrationHealth.UNKNOWN),
                               self.requirement, adapter, self.payload)
        self.assertEqual(result.status, DispatchStatus.REJECTED)
        self.assertEqual(adapter.calls, 0)

    def test_missing_adapter_is_not_reported_as_execution(self):
        result = dispatch_once(descriptor(), self.requirement, None, self.payload)
        self.assertEqual(result.status, DispatchStatus.ADAPTER_MISSING)
        self.assertFalse(result.successful)

    def test_adapter_exception_is_reported_without_exception_details(self):
        adapter = FakeAdapter(error=RuntimeError("secret=do-not-leak"))
        result = dispatch_once(descriptor(), self.requirement, adapter, self.payload)
        self.assertEqual(result.status, DispatchStatus.ADAPTER_ERROR)
        self.assertNotIn("do-not-leak", result.reason)
        self.assertEqual(adapter.calls, 1)

    def test_non_json_output_is_rejected(self):
        adapter = FakeAdapter(output={"bad": float("nan")})
        result = dispatch_once(descriptor(), self.requirement, adapter, self.payload)
        self.assertEqual(result.status, DispatchStatus.INVALID_OUTPUT)

    def test_invalid_input_is_not_invoked(self):
        adapter = FakeAdapter()
        result = dispatch_once(descriptor(), self.requirement, adapter, {"bad": object()})
        self.assertEqual(result.status, DispatchStatus.INVALID_OUTPUT)
        self.assertEqual(adapter.calls, 0)

    def test_required_kind_mismatch_never_invokes_adapter(self):
        adapter = FakeAdapter()
        requirement = IntegrationRequirement(
            ("text_reasoning",),
            required_kind=IntegrationKind.MODEL,
        )
        result = dispatch_once(
            descriptor(kind=IntegrationKind.ACTION_TOOL),
            requirement,
            adapter,
            self.payload,
        )
        self.assertEqual(result.status, DispatchStatus.REJECTED)
        self.assertIn("required kind model", result.reason)
        self.assertEqual(adapter.calls, 0)

    def test_adapter_without_callable_invoke_is_not_executed(self):
        result = dispatch_once(descriptor(), self.requirement, object(), self.payload)
        self.assertEqual(result.status, DispatchStatus.ADAPTER_MISSING)
        self.assertFalse(result.successful)

    def test_ineligible_route_reason_is_preserved(self):
        result = dispatch_once(descriptor(maturity=IntegrationMaturity.REVIEWED),
                                self.requirement, FakeAdapter(), self.payload)
        self.assertEqual(result.status, DispatchStatus.REJECTED)
        self.assertIn("not enabled", result.reason)


class DispatchTimeoutTests(unittest.TestCase):
    """Finding EXE (no timeout): a hung adapter blocked the caller forever."""

    def setUp(self):
        self.requirement = IntegrationRequirement(("text_reasoning",))
        self.payload = {"mission_id": "m-1"}

    def test_hung_adapter_returns_timeout_unknown_outcome_and_late_result_is_discarded(self):
        import threading
        import time
        release = threading.Event()
        finished = threading.Event()

        class Slow:
            calls = 0

            def invoke(self, payload):
                Slow.calls += 1
                release.wait(5)
                finished.set()
                return {"late": True}

        started = time.monotonic()
        result = dispatch_once(descriptor(), self.requirement, Slow(), self.payload, timeout_seconds=0.1)
        elapsed = time.monotonic() - started
        self.assertEqual(result.status, DispatchStatus.TIMEOUT)
        self.assertIsNone(result.output)
        self.assertEqual(result.reason, "adapter_timeout_outcome_unknown")
        self.assertLess(elapsed, 1.0)
        self.assertEqual(Slow.calls, 1)  # never invoked twice
        release.set()
        self.assertTrue(finished.wait(2))  # adapter really kept running; result unused

    def test_fast_adapter_succeeds_within_timeout(self):
        adapter = FakeAdapter()
        result = dispatch_once(descriptor(), self.requirement, adapter, self.payload, timeout_seconds=2)
        self.assertEqual(result.status, DispatchStatus.SUCCEEDED)
        self.assertEqual(adapter.calls, 1)

    def test_adapter_exception_inside_timeout_mode_is_still_adapter_error(self):
        result = dispatch_once(
            descriptor(), self.requirement, FakeAdapter(error=RuntimeError("secret")),
            self.payload, timeout_seconds=2,
        )
        self.assertEqual(result.status, DispatchStatus.ADAPTER_ERROR)
        self.assertEqual(result.reason, "RuntimeError")

    def test_invalid_timeout_values_are_rejected_without_invoking_adapter(self):
        for bad in (0, -1, float("nan"), float("inf"), True, "1"):
            with self.subTest(timeout=bad):
                adapter = FakeAdapter()
                result = dispatch_once(descriptor(), self.requirement, adapter, self.payload, timeout_seconds=bad)
                self.assertEqual(result.status, DispatchStatus.REJECTED)
                self.assertEqual(adapter.calls, 0)

    def test_default_without_timeout_keeps_legacy_blocking_behavior(self):
        adapter = FakeAdapter()
        self.assertTrue(dispatch_once(descriptor(), self.requirement, adapter, self.payload).successful)


if __name__ == "__main__":
    unittest.main()
