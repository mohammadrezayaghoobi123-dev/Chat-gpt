import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
import sys
sys.path.insert(0, str(ROOT / "security"))

from git_observation_adapter import observe_repository


class GitObservationAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = pathlib.Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Adapter Test")
        self.git("config", "user.email", "adapter@example.invalid")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args, env=None, input_text=None):
        merged_env = os.environ.copy()
        merged_env.update({"GIT_AUTHOR_DATE": "2020-01-01T00:00:00Z",
                           "GIT_COMMITTER_DATE": "2020-01-01T00:00:00Z"})
        if env:
            merged_env.update(env)
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True, text=True, capture_output=True, env=merged_env,
            input=input_text,
        ).stdout.strip()

    def commit(self, filename, content):
        (self.repo / filename).write_text(content, encoding="utf-8")
        self.git("add", filename)
        return self.git("commit", "-m", filename) and self.git("rev-parse", "HEAD")

    def test_real_repository_inventory_includes_annotated_tag_and_merge_parents(self):
        root = self.commit("root.txt", "root")
        self.git("branch", "side")
        self.commit("main.txt", "main")
        self.git("checkout", "side")
        self.commit("side.txt", "side")
        self.git("checkout", "main")
        self.git("merge", "--no-ff", "side", "-m", "merge side")
        self.git("tag", "-a", "release", root, "-m", "release")
        
        observed = observe_repository(self.repo)

        self.assertEqual(observed["object_format"], "sha1")
        self.assertEqual(observed["inventory"]["snapshot_status"], "complete")
        self.assertIn("refs/heads/main", observed["refs_before"])
        self.assertIn("refs/tags/release", observed["refs_before"])
        self.assertEqual(observed["inventory"]["merge_count"], 1)
        self.assertEqual(observed["inventory"]["covered_count"], 0)
        self.assertEqual(observed["inventory"]["merges"][0]["status"], "eligible_unscanned")

    def test_shallow_repository_is_incomplete_not_a_false_root_commit(self):
        head = self.commit("root.txt", "root")
        shallow_file = self.repo / ".git" / "shallow"
        shallow_file.write_text(head + "\n", encoding="ascii")

        observed = observe_repository(self.repo)

        self.assertTrue(observed["shallow"])
        self.assertEqual(observed["inventory"]["snapshot_status"], "incomplete")
        self.assertIn("shallow_repository", observed["diagnostics"])
        self.assertEqual(observed["inventory"]["covered_count"], 0)

    def test_replace_refs_are_detected_and_never_applied_to_parent_observation(self):
        original = self.commit("original.txt", "original")
        replacement_tree = self.git("mktree", input_text="")
        replacement = self.git("commit-tree", replacement_tree, "-m", "replacement")
        self.git("replace", original, replacement)

        observed = observe_repository(self.repo)

        self.assertTrue(observed["replace_refs_present"])
        self.assertIn("replace_refs_present", observed["diagnostics"])
        self.assertEqual(observed["inventory"]["snapshot_status"], "incomplete")
        self.assertEqual(observed["inventory"]["covered_count"], 0)

    def test_sha256_repository_uses_native_object_format(self):
        self.git("init", "--object-format=sha256", "-b", "main")
        self.git("config", "user.name", "Adapter Test")
        self.git("config", "user.email", "adapter@example.invalid")
        self.commit("sha256.txt", "sha256")

        observed = observe_repository(self.repo)

        self.assertEqual(observed["object_format"], "sha256")
        self.assertEqual(observed["inventory"]["object_id_length"], 64)
        self.assertEqual(observed["inventory"]["snapshot_status"], "complete")

    def test_octopus_merge_is_preserved_as_unsupported_not_two_parent_coverage(self):
        root = self.commit("root.txt", "root")
        tree = self.git("rev-parse", "HEAD^{tree}")
        left = self.git("commit-tree", tree, "-p", root, "-m", "left")
        right = self.git("commit-tree", tree, "-p", root, "-m", "right")
        third = self.git("commit-tree", tree, "-p", root, "-m", "third")
        octopus = self.git(
            "commit-tree", tree, "-p", left, "-p", right, "-p", third,
            "-m", "octopus",
        )
        self.git("update-ref", "refs/heads/main", octopus)

        observed = observe_repository(self.repo)

        self.assertEqual(observed["inventory"]["snapshot_status"], "complete")
        self.assertEqual(observed["inventory"]["merge_count"], 1)
        self.assertEqual(observed["inventory"]["unsupported_merge_count"], 1)
        self.assertEqual(observed["inventory"]["merges"][0]["parent_count"], 3)
        self.assertEqual(observed["inventory"]["merges"][0]["status"], "unsupported_parent_count")
        self.assertEqual(observed["inventory"]["covered_count"], 0)


if __name__ == "__main__":
    unittest.main()
