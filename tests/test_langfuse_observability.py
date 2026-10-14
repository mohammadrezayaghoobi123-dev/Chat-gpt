import os
import sys
import types
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from master_brain.integrated_runtime import IslandResult, execute_mission
from master_brain.meta_intelligence import Mission


class FakeObservation:
    def __init__(self):
        self.updates = []

    def update(self, **kwargs):
        self.updates.append(kwargs)


class FakeClient:
    def __init__(self):
        self.observations = []

    @contextmanager
    def start_as_current_observation(self, **kwargs):
        observation = FakeObservation()
        self.observations.append((kwargs, observation))
        yield observation


class LangfuseTracingTests(unittest.TestCase):
    def test_mission_runs_normally_when_tracing_is_not_configured(self):
        with patch.dict(os.environ, {}, clear=True):
            run = execute_mission(
                Mission("Research scientific evidence carefully", risk_tier="low"),
                {"science_research": lambda _mission: IslandResult("science_research", "done")},
            )

        self.assertEqual(run.status, "completed_with_recorded_results")
        self.assertEqual([item.island_id for item in run.results], ["science_research"])

    def test_trace_uses_agent_observation_and_excludes_raw_mission_text(self):
        client = FakeClient()
        fake_module = types.SimpleNamespace(get_client=lambda: client)
        env = {
            "LANGFUSE_PUBLIC_KEY": "pk-test",
            "LANGFUSE_SECRET_KEY": "sk-test",
        }
        with patch.dict(os.environ, env, clear=True), patch.dict(sys.modules, {"langfuse": fake_module}):
            run = execute_mission(
                Mission("CONFIDENTIAL: research scientific evidence", risk_tier="low"),
                {"science_research": lambda _mission: IslandResult("science_research", "private result")},
            )

        self.assertEqual(run.status, "completed_with_recorded_results")
        self.assertGreaterEqual(len(client.observations), 2)
        root_kwargs, root_observation = client.observations[0]
        self.assertEqual(root_kwargs["as_type"], "agent")
        self.assertEqual(root_kwargs["name"], "master-brain-mission")
        root_updates = root_observation.updates
        self.assertTrue(root_updates)
        serialized = repr(root_updates)
        self.assertNotIn("CONFIDENTIAL", serialized)
        self.assertNotIn("private result", serialized)

    def test_tracing_initialization_failure_does_not_break_mission(self):
        fake_module = types.SimpleNamespace(get_client=lambda: (_ for _ in ()).throw(RuntimeError("offline")))
        env = {
            "LANGFUSE_PUBLIC_KEY": "pk-test",
            "LANGFUSE_SECRET_KEY": "sk-test",
        }
        with patch.dict(os.environ, env, clear=True), patch.dict(sys.modules, {"langfuse": fake_module}):
            run = execute_mission(
                Mission("Research scientific evidence carefully", risk_tier="low"),
                {"science_research": lambda _mission: IslandResult("science_research", "done")},
            )

        self.assertEqual(run.status, "completed_with_recorded_results")


if __name__ == "__main__":
    unittest.main()
