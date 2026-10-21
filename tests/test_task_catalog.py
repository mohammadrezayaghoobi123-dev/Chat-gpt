import json
import unittest

from master_brain.integrations import (
    IntegrationDescriptor, IntegrationHealth, IntegrationKind, IntegrationMaturity, IntegrationRequirement,
)
from master_brain.mission_approval import action_digest
from master_brain.task_catalog import MAX_PAYLOAD_BYTES, TaskCatalog, TaskDefinition


class Echo:
    def invoke(self, payload):
        return {"echo": dict(payload)}


def integration(integration_id="offline-echo", limitations=("offline only",)):
    return IntegrationDescriptor(
        integration_id=integration_id, version="1", kind=IntegrationKind.MODEL,
        capabilities=("text_reasoning",), maturity=IntegrationMaturity.ENABLED,
        health=IntegrationHealth.AVAILABLE, risk_level=0, estimated_cost_per_call=0.0,
        limitations=limitations)


def make(task_id="echo", payload=None, **kw):
    args = dict(task_id=task_id, description="Echo a fixed payload offline", integration=integration(),
                requirement=IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.MODEL),
                adapter=Echo(), payload={"text": "سلام"} if payload is None else payload)
    args.update(kw)
    return TaskDefinition.create(**args)


class TaskDefinitionTests(unittest.TestCase):
    def test_digest_matches_the_approval_module_and_is_stable(self):
        task = make()
        self.assertEqual(task.action_digest, action_digest("offline-echo", {"text": "سلام"}))
        self.assertEqual(task.action_digest, make().action_digest)
        self.assertNotEqual(task.action_digest, make(payload={"text": "x"}).action_digest)
        self.assertNotEqual(task.action_digest, make(integration=integration("other")).action_digest)

    def test_payload_is_snapshotted_and_copies_are_independent(self):
        source = {"nested": {"a": [1, 2]}}
        task = make(payload=source)
        source["nested"]["a"].append(3)
        self.assertEqual(task.payload(), {"nested": {"a": [1, 2]}})
        copy = task.payload()
        copy["nested"]["a"].append(99)
        self.assertEqual(task.payload(), {"nested": {"a": [1, 2]}})
        self.assertEqual(task.action_digest, make(payload={"nested": {"a": [1, 2]}}).action_digest)

    def test_validation(self):
        for bad in ("", "Echo", "-x", "a b", "x" * 65, None, 5):
            with self.subTest(task_id=bad), self.assertRaises(ValueError):
                make(task_id=bad)
        for bad in ("", "  ", "x" * 501, None):
            with self.subTest(description=bad), self.assertRaises(ValueError):
                make(description=bad)
        make(task_id="x" * 64)
        make(description="x" * 500)
        with self.assertRaises(TypeError):
            make(adapter=object())
        with self.assertRaises(TypeError):
            make(integration="nope")
        with self.assertRaises(TypeError):
            make(payload=[1])
        for bad in ({"x": float("nan")}, {"x": object()}, {"x": float("inf")}):
            with self.subTest(payload=bad), self.assertRaises((ValueError, TypeError)):
                make(payload=bad)
        big = {"t": "x" * (MAX_PAYLOAD_BYTES - 8)}
        self.assertLessEqual(len(json.dumps(big, separators=(",", ":"))), MAX_PAYLOAD_BYTES)
        make(payload=big)
        with self.assertRaises(ValueError):
            make(payload={"t": "x" * MAX_PAYLOAD_BYTES})

    def test_definition_is_immutable(self):
        task = make()
        with self.assertRaises(Exception):
            task.task_id = "other"


class TaskDefinitionBoundaryTests(unittest.TestCase):
    def test_payload_size_limit_is_exactly_16_kib_of_canonical_json(self):
        self.assertEqual(MAX_PAYLOAD_BYTES, 16384)
        overhead = len(json.dumps({"t": ""}, separators=(",", ":")).encode())
        make(payload={"t": "x" * (16384 - overhead)})  # exactly at the limit
        with self.assertRaises(ValueError):
            make(payload={"t": "x" * (16384 - overhead + 1)})
        # multi-byte characters count as bytes, not characters
        make(payload={"t": "س" * 8180})  # 16360 bytes + overhead: fits
        with self.assertRaises(ValueError):
            make(payload={"t": "س" * 8200})  # only 8200 characters but 16400 bytes

    def test_digest_is_independent_of_key_order_and_payload_is_not_in_repr(self):
        a = make(payload={"a": 1, "b": "سلام"})
        b = make(payload={"b": "سلام", "a": 1})
        self.assertEqual(a.action_digest, b.action_digest)
        self.assertEqual(a.payload(), b.payload())
        self.assertNotIn("سلام", repr(a))
        self.assertNotIn("_payload_json", repr(a))
        self.assertEqual(b._payload_json, '{"a":1,"b":"سلام"}')  # canonical (sorted) raw UTF-8, from out-of-order input

    def test_non_finite_payload_numbers_are_rejected(self):
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                make(payload={"x": bad})


class CatalogTests(unittest.TestCase):
    def test_lookup_listing_and_duplicates(self):
        a, b = make("b-task"), make("a-task", integration=integration("int-2", ("l",)))
        catalog = TaskCatalog([a, b])
        self.assertEqual([t.task_id for t in catalog.list()], ["a-task", "b-task"])
        self.assertIs(catalog.get("a-task"), b)
        for bad in ("missing", None, 5, ""):
            self.assertIsNone(catalog.get(bad))
        self.assertEqual(catalog.integration("int-2").limitations, ("l",))
        self.assertIsNone(catalog.integration("nope"))
        with self.assertRaises(ValueError):
            TaskCatalog([a, make("b-task")])
        with self.assertRaises(TypeError):
            TaskCatalog([object()])
        self.assertEqual(TaskCatalog([]).list(), ())


if __name__ == "__main__":
    unittest.main()
