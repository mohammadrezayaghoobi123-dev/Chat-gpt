import unittest

from master_brain.mission_runner import MissionStatus, run_mission


class MissionRunnerTests(unittest.TestCase):
    def test_success_has_mission_id_and_result(self):
        result = run_mission("m-1", {"task": "demo"}, lambda payload: {"ok": True})
        self.assertEqual(result.mission_id, "m-1")
        self.assertEqual(result.status, MissionStatus.SUCCEEDED)
        self.assertEqual(result.result, {"ok": True})

    def test_handler_called_exactly_once(self):
        calls = []
        def handler(payload):
            calls.append(payload)
            return {"count": len(calls)}
        result = run_mission("m-2", {"x": 1}, handler)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result.result, {"count": 1})

    def test_exception_is_failure_without_message_leak(self):
        result = run_mission("m-3", {}, lambda _: (_ for _ in ()).throw(RuntimeError("token=secret")))
        self.assertEqual(result.status, MissionStatus.FAILED)
        self.assertEqual(result.error_code, "RuntimeError")
        self.assertNotIn("secret", str(result))

    def test_non_mapping_result_is_invalid(self):
        result = run_mission("m-4", {}, lambda _: "not structured")
        self.assertEqual(result.status, MissionStatus.INVALID_RESULT)

    def test_non_json_result_is_invalid(self):
        result = run_mission("m-5", {}, lambda _: {"bad": float("nan")})
        self.assertEqual(result.status, MissionStatus.INVALID_RESULT)

    def test_handler_cannot_mutate_callers_nested_payload(self):
        payload = {"nested": {"items": [1]}}
        def handler(received):
            received["nested"]["items"].append(2)
            return {"ok": True}
        run_mission("m-6", payload, handler)
        self.assertEqual(payload, {"nested": {"items": [1]}})

    def test_result_is_detached_from_handler_owned_nested_data(self):
        owned = {"nested": {"items": [1]}}
        result = run_mission("m-7", {}, lambda _: owned)
        owned["nested"]["items"].append(2)
        self.assertEqual(result.result, {"nested": {"items": [1]}})

    def test_non_json_payload_does_not_call_handler(self):
        calls = []
        result = run_mission("m-8", {"bad": float("nan")}, lambda _: calls.append(True) or {})
        self.assertEqual(result.status, MissionStatus.INVALID_RESULT)
        self.assertEqual(result.error_code, "payload_not_json_compatible")
        self.assertEqual(calls, [])

    def test_empty_mission_id_rejected(self):
        with self.assertRaises(ValueError):
            run_mission(" ", {}, lambda _: {})


if __name__ == "__main__":
    unittest.main()
