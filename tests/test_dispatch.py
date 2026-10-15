import unittest
from collections.abc import Mapping

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


class AdapterExceptionClassificationTests(unittest.TestCase):
    """Finding EXE-03/C6: exceptions raised INSIDE invoke() were reported as
    'invalid input' (clean failure) for 5 of 6 classes, hiding a possible effect."""

    def setUp(self):
        self.requirement = IntegrationRequirement(("text_reasoning",))

    def test_every_exception_class_raised_by_adapter_is_adapter_error(self):
        import json
        classes = (
            ValueError("x"), TypeError("x"), OverflowError("x"),
            json.JSONDecodeError("m", "d", 0), UnicodeDecodeError("utf-8", b"", 0, 1, "r"),
            RuntimeError("x"), KeyError("x"), TimeoutError("x"), OSError("x"),
        )
        for error in classes:
            for timeout in (None, 2):
                with self.subTest(error=type(error).__name__, timeout=timeout):
                    adapter = FakeAdapter(error=error)
                    result = dispatch_once(
                        descriptor(), self.requirement, adapter, {"a": 1}, timeout_seconds=timeout,
                    )
                    self.assertEqual(adapter.calls, 1)
                    self.assertEqual(result.status, DispatchStatus.ADAPTER_ERROR)
                    self.assertEqual(result.reason, type(error).__name__)

    def test_bad_input_is_still_rejected_before_the_adapter_runs(self):
        adapter = FakeAdapter()
        result = dispatch_once(descriptor(), self.requirement, adapter, {"bad": object()})
        self.assertEqual(result.status, DispatchStatus.INVALID_OUTPUT)
        self.assertEqual(result.reason, "input_not_json_compatible_object")
        self.assertEqual(adapter.calls, 0)


class _FlakyMapping(Mapping):
    """Converts cleanly on its first dict() call, then misbehaves (mutable/lying mapping)."""

    def __init__(self, later):
        self.later, self.conversions = later, 0

    def __iter__(self):
        self.conversions += 1
        if self.conversions == 1:
            return iter(("a",))
        if isinstance(self.later, BaseException):
            raise self.later
        return iter(self.later)

    def __getitem__(self, key):
        if self.conversions == 1:
            return 1
        return self.later[key]

    def __len__(self):
        return 1


class DispatchMutationHardeningTests(unittest.TestCase):
    """Pins validation order, layered input/output checks and process-exit behaviour."""

    def setUp(self):
        self.requirement = IntegrationRequirement(("text_reasoning",))
        self.payload = {"mission_id": "m-1"}

    def test_input_validation_precedes_eligibility_adapter_and_timeout_checks(self):
        bad = {"x": float("nan")}
        cases = (
            dict(integration=descriptor(health=IntegrationHealth.UNKNOWN), adapter=FakeAdapter()),
            dict(integration=descriptor(), adapter=None),
            dict(integration=descriptor(), adapter=FakeAdapter(), timeout_seconds=-1),
        )
        for case in cases:
            with self.subTest(case=sorted(case)):
                adapter = case["adapter"]
                result = dispatch_once(case["integration"], self.requirement, adapter, bad,
                                       **({"timeout_seconds": case["timeout_seconds"]}
                                          if "timeout_seconds" in case else {}))
                self.assertEqual((result.status, result.reason),
                                 (DispatchStatus.INVALID_OUTPUT, "input_not_json_compatible_object"))
                if adapter:
                    self.assertEqual(adapter.calls, 0)

    def test_non_mapping_and_unserialisable_payloads_are_invalid_input(self):
        for bad in ([1, 2], "text", None, {"x": {1, 2}}, {"x": object()}, {"x": float("inf")}):
            with self.subTest(bad=repr(bad)[:20]):
                adapter = FakeAdapter()
                result = dispatch_once(descriptor(), self.requirement, adapter, bad)
                self.assertEqual(result.status, DispatchStatus.INVALID_OUTPUT)
                self.assertEqual(adapter.calls, 0)

    def test_payload_that_breaks_between_check_and_copy_never_reaches_adapter(self):
        for later in (TypeError("t"), ValueError("v"), OverflowError("o"), {"a": float("nan")}):
            with self.subTest(later=repr(later)[:25]):
                adapter = FakeAdapter()
                result = dispatch_once(descriptor(), self.requirement, adapter, _FlakyMapping(later))
                self.assertEqual((result.status, result.reason),
                                 (DispatchStatus.INVALID_OUTPUT, "input_not_json_compatible_object"))
                self.assertEqual(adapter.calls, 0)

    def test_output_that_breaks_between_check_and_copy_is_invalid_output(self):
        for later in (TypeError("t"), ValueError("v"), OverflowError("o"), {"a": float("nan")}):
            with self.subTest(later=repr(later)[:25]):
                result = dispatch_once(descriptor(), self.requirement,
                                       FakeAdapter(output=_FlakyMapping(later)), self.payload)
                self.assertEqual((result.status, result.reason),
                                 (DispatchStatus.INVALID_OUTPUT, "output_not_json_compatible_object"))
                self.assertIsNone(result.output)

    def test_non_mapping_or_unserialisable_adapter_output_is_invalid(self):
        for bad in ([1], "text", {"x": float("nan")}, {"x": object()}):
            with self.subTest(bad=repr(bad)[:20]):
                result = dispatch_once(descriptor(), self.requirement,
                                       FakeAdapter(output=bad), self.payload)
                self.assertEqual((result.status, result.reason),
                                 (DispatchStatus.INVALID_OUTPUT, "output_not_json_compatible_object"))

    def test_pre_check_covers_non_mappings_and_every_conversion_error_before_other_checks(self):
        class Boom(Mapping):
            def __init__(self, exc):
                self.exc = exc

            def __iter__(self):
                raise self.exc

            def __getitem__(self, key):
                raise self.exc

            def __len__(self):
                return 1

        for bad in ([1, 2], "text", Boom(TypeError("t")), Boom(ValueError("v")), Boom(OverflowError("o"))):
            with self.subTest(bad=type(bad).__name__):
                result = dispatch_once(descriptor(), self.requirement, None, bad)  # no adapter
                self.assertEqual((result.status, result.reason),
                                 (DispatchStatus.INVALID_OUTPUT, "input_not_json_compatible_object"))

    def test_dispatch_result_is_immutable(self):
        from dataclasses import FrozenInstanceError
        result = dispatch_once(descriptor(), self.requirement, FakeAdapter(), self.payload)
        with self.assertRaises(FrozenInstanceError):
            result.status = DispatchStatus.REJECTED

    def test_timed_out_adapter_does_not_keep_the_process_alive(self):
        """The worker must be a daemon thread: a hung adapter cannot block interpreter exit."""
        import subprocess, sys, time as _time
        from pathlib import Path
        code = (
            "import time\n"
            "from tests.test_dispatch import descriptor\n"
            "from master_brain.dispatch import dispatch_once\n"
            "from master_brain.integrations import IntegrationRequirement\n"
            "class Hang:\n"
            "    def invoke(self, payload):\n"
            "        time.sleep(12)\n"
            "        return {}\n"
            "r = dispatch_once(descriptor(), IntegrationRequirement(('text_reasoning',)), Hang(), {}, timeout_seconds=0.1)\n"
            "print(r.status.value, flush=True)\n"
        )
        root = Path(__file__).resolve().parents[1]
        env = {**__import__("os").environ, "PYTHONPATH": f"{root / 'src'}:{root}"}
        started = _time.monotonic()
        proc = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True,
                              text=True, timeout=60)
        self.assertEqual(proc.stdout.strip(), "timeout")
        self.assertLess(_time.monotonic() - started, 8)


if __name__ == "__main__":
    unittest.main()
