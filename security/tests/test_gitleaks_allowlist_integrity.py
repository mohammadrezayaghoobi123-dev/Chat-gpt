import copy
import pathlib
import sys
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "security"))
from validate_gitleaks_allowlists import EXPECTED_FIXTURES, validate_config


class GitleaksAllowlistIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / ".gitleaks.toml").open("rb") as handle:
            cls.config = tomllib.load(handle)

    def test_repository_allowlists_pass_integrity_validation(self):
        self.assertEqual(validate_config(self.config, ROOT), [])

    def test_each_pinned_exception_is_required(self):
        for description in EXPECTED_FIXTURES:
            with self.subTest(description=description):
                mutated = copy.deepcopy(self.config)
                mutated["allowlists"] = [
                    entry for entry in mutated["allowlists"]
                    if entry.get("description") != description
                ]
                self.assertTrue(validate_config(mutated, ROOT))

    def test_adversarial_scope_mutations_are_rejected(self):
        mutations = {
            "target rule": lambda entry: entry.update(targetRules=["*"]),
            "commit": lambda entry: entry.update(commits=["0" * 40]),
            "path": lambda entry: entry.update(paths=[".*"]),
            "condition": lambda entry: entry.update(condition="OR"),
            "regex target": lambda entry: entry.update(regexTarget="secret"),
            "missing regex": lambda entry: entry.pop("regexes", None),
            "broad regex": lambda entry: entry.update(regexes=[".*"]),
        }
        for label, mutate in mutations.items():
            for description in EXPECTED_FIXTURES:
                with self.subTest(mutation=label, description=description):
                    changed = copy.deepcopy(self.config)
                    target = next(
                        entry for entry in changed["allowlists"]
                        if entry.get("description") == description
                    )
                    mutate(target)
                    self.assertTrue(validate_config(changed, ROOT), label)


    def test_global_allowlist_policy_rejects_new_or_unscoped_exceptions(self):
        changed = copy.deepcopy(self.config)
        changed["allowlists"][0]["regexTarget"] = "secret"
        self.assertTrue(validate_config(changed, ROOT))

        changed = copy.deepcopy(self.config)
        changed["allowlists"].append(copy.deepcopy(changed["allowlists"][0]))
        self.assertTrue(validate_config(changed, ROOT))

    def test_global_policy_rejects_invalid_path_regex(self):
        changed = copy.deepcopy(self.config)
        changed["allowlists"][0]["paths"] = ["^[$"]
        self.assertTrue(validate_config(changed, ROOT))


    def test_validator_rejects_non_literal_line_pattern(self):
        changed = copy.deepcopy(self.config)
        target = next(
            entry for entry in changed["allowlists"]
            if entry.get("description") in EXPECTED_FIXTURES
        )
        target["regexes"] = [r'const key = ".*";']
        self.assertTrue(validate_config(changed, ROOT))


if __name__ == "__main__":
    unittest.main()
