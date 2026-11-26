import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "security"))

from merge_coverage_inventory import build_merge_coverage_inventory


A = "a" * 40
B = "b" * 40
C = "c" * 40
D = "d" * 40
E = "e" * 40
F = "f" * 40


class MergeCoverageInventoryTests(unittest.TestCase):
    def complete_graph(self):
        return {
            A: [],
            B: [A],
            C: [A],
            D: [B, C],
            E: [B, C, F],
            F: [A],
        }

    def refs(self):
        return {
            "refs/heads/main": D,
            "refs/heads/side": C,
            "refs/heads/topic": E,
        }

    def build(self, **overrides):
        arguments = {
            "refs_before": self.refs(),
            "refs_after": self.refs(),
            "reachable_commits": self.complete_graph(),
            "enumeration_complete": True,
            "object_inventory_complete": True,
        }
        arguments.update(overrides)
        return build_merge_coverage_inventory(**arguments)

    def test_complete_snapshot_marks_two_parent_merge_eligible_but_never_covered(self):
        inventory = self.build()

        self.assertEqual(inventory["schema_version"], 1)
        self.assertEqual(inventory["snapshot_status"], "complete")
        self.assertEqual(inventory["reasons"], [])
        self.assertEqual(inventory["reachable_commit_count"], 6)
        self.assertEqual(inventory["merge_count"], 2)
        self.assertEqual(inventory["covered_count"], 0)
        self.assertEqual(
            inventory["merges"],
            [
                {
                    "sha": D,
                    "parents": [B, C],
                    "parent_count": 2,
                    "status": "eligible_unscanned",
                },
                {
                    "sha": E,
                    "parents": [B, C, F],
                    "parent_count": 3,
                    "status": "unsupported_parent_count",
                },
            ],
        )
        self.assertNotIn("covered", {entry["status"] for entry in inventory["merges"]})

    def test_inventory_is_deterministic_independent_of_input_mapping_order(self):
        refs = self.refs()
        commits = self.complete_graph()
        first = self.build(refs_before=refs, refs_after=refs, reachable_commits=commits)
        second = self.build(
            refs_before=dict(reversed(list(refs.items()))),
            refs_after=dict(reversed(list(refs.items()))),
            reachable_commits=dict(reversed(list(commits.items()))),
        )
        self.assertEqual(first, second)

    def test_ref_drift_makes_two_parent_merges_incomplete(self):
        changed = self.refs() | {"refs/heads/main": B}
        inventory = self.build(refs_after=changed)

        self.assertEqual(inventory["snapshot_status"], "incomplete")
        self.assertIn("ref_snapshot_changed", inventory["reasons"])
        self.assertEqual(
            next(item for item in inventory["merges"] if item["sha"] == D)["status"],
            "incomplete_snapshot",
        )
        self.assertEqual(
            next(item for item in inventory["merges"] if item["sha"] == E)["status"],
            "unsupported_parent_count",
        )
        self.assertEqual(inventory["covered_count"], 0)

    def test_incomplete_commit_enumeration_fails_closed(self):
        inventory = self.build(enumeration_complete=False)

        self.assertEqual(inventory["snapshot_status"], "incomplete")
        self.assertIn("commit_enumeration_incomplete", inventory["reasons"])
        self.assertTrue(
            all(item["status"] != "eligible_unscanned" for item in inventory["merges"])
        )

    def test_incomplete_object_inventory_fails_closed(self):
        inventory = self.build(object_inventory_complete=False)

        self.assertEqual(inventory["snapshot_status"], "incomplete")
        self.assertIn("object_inventory_incomplete", inventory["reasons"])

    def test_missing_parent_object_fails_closed(self):
        graph = self.complete_graph()
        graph[D] = [B, "9" * 40]
        inventory = self.build(reachable_commits=graph)

        self.assertEqual(inventory["snapshot_status"], "incomplete")
        self.assertIn("parent_object_missing", inventory["reasons"])
        self.assertEqual(
            next(item for item in inventory["merges"] if item["sha"] == D)["status"],
            "incomplete_snapshot",
        )

    def test_ref_tip_missing_from_reachable_inventory_fails_closed(self):
        graph = self.complete_graph()
        del graph[D]
        inventory = self.build(reachable_commits=graph)

        self.assertEqual(inventory["snapshot_status"], "incomplete")
        self.assertIn("ref_tip_missing", inventory["reasons"])

    def test_sha256_object_ids_are_supported_without_mixing_hash_formats(self):
        ids = {name: (char * 64) for name, char in {
            "root": "1", "left": "2", "right": "3", "merge": "4"
        }.items()}
        graph = {
            ids["root"]: [],
            ids["left"]: [ids["root"]],
            ids["right"]: [ids["root"]],
            ids["merge"]: [ids["left"], ids["right"]],
        }
        refs = {"refs/heads/main": ids["merge"]}
        inventory = build_merge_coverage_inventory(
            refs_before=refs,
            refs_after=refs,
            reachable_commits=graph,
            enumeration_complete=True,
            object_inventory_complete=True,
        )
        self.assertEqual(inventory["snapshot_status"], "complete")
        self.assertEqual(inventory["merges"][0]["sha"], ids["merge"])

    def test_empty_ref_snapshot_is_rejected_instead_of_vacuously_complete(self):
        with self.assertRaises(ValueError):
            self.build(refs_before={}, refs_after={})

    def test_mixed_object_id_lengths_are_rejected(self):
        graph = self.complete_graph()
        graph["1" * 64] = []
        with self.assertRaises(ValueError):
            self.build(reachable_commits=graph)

    def test_non_boolean_completeness_attestations_are_rejected(self):
        with self.assertRaises(ValueError):
            self.build(enumeration_complete=1)
        with self.assertRaises(ValueError):
            self.build(object_inventory_complete=None)


if __name__ == "__main__":
    unittest.main()
