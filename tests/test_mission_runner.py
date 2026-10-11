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

    def test_empty_mission_id_rejected(self):
        with self.assertRaises(ValueError):
            run_mission(" ", {}, lambda _: {})


if __name__ == "__main__":
    unittest.main()
