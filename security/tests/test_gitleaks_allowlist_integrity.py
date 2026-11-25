import copy
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "security"))
from validate_gitleaks_allowlists import EXPECTED_FIXTURES, _source_fixture_line, validate_config


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
            "regex target": lambda entry: entry.update(regexTarget="invalid"),
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
        changed["allowlists"][0]["regexTarget"] = "invalid"
        self.assertTrue(validate_config(changed, ROOT))

        changed = copy.deepcopy(self.config)
        changed["allowlists"].append(copy.deepcopy(changed["allowlists"][0]))
        self.assertTrue(validate_config(changed, ROOT))

    def test_global_policy_rejects_invalid_path_regex(self):
        changed = copy.deepcopy(self.config)
        changed["allowlists"][0]["paths"] = ["^[$"]
        self.assertTrue(validate_config(changed, ROOT))



    def test_secret_target_allowlists_match_only_exact_extracted_fixture(self):
        entries = {
            entry.get("description"): entry
            for entry in self.config["allowlists"]
            if entry.get("description") in EXPECTED_FIXTURES
        }
        for description, (commit, path) in EXPECTED_FIXTURES.items():
            with self.subTest(description=description):
                line = _source_fixture_line(ROOT, commit, path)
                self.assertIsNotNone(line)
                fixture = re.fullmatch(r'const key = "([0-9a-f]{64})";', line)
                self.assertIsNotNone(fixture)
                self.assertEqual(entries[description]["regexTarget"], "secret")
                pattern = re.compile(entries[description]["regexes"][0])
                key = fixture.group(1)
                finding_match = f'key = "{key}"'
                self.assertIsNotNone(pattern.fullmatch(finding_match))
                mutated = ("0" if key[0] != "0" else "1") + key[1:]
                self.assertIsNone(pattern.fullmatch(f'key = "{mutated}"'))


    def test_report_diagnostics_explain_allowlist_predicates_without_secrets(self):
        description, (commit, path) = next(iter(EXPECTED_FIXTURES.items()))
        line = _source_fixture_line(ROOT, commit, path)
        fixture = re.fullmatch(r'const key = "([0-9a-f]{64})";', line)
        self.assertIsNotNone(fixture)
        finding_match = f'key = "{fixture.group(1)}"'
        source = subprocess.run(
            ["git", "show", f"{commit}:{path}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        start_line = source.index(line) + 1
        report = [{
            "Commit": commit,
            "File": path,
            "StartLine": start_line,
            "RuleID": "generic-api-key",
            "Secret": finding_match,
            "Match": finding_match,
            "Line": line,
        }]
        with tempfile.TemporaryDirectory() as directory:
            report_path = pathlib.Path(directory) / "gitleaks-report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "security" / "validate_gitleaks_allowlists.py"),
                    "--config",
                    str(ROOT / ".gitleaks.toml"),
                    "--report",
                    str(report_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn(
            "rule=True commit=True path=True regex=True allowed=True",
            result.stdout,
        )
        self.assertIn(f"secret_length={len(finding_match)}", result.stdout)
        self.assertIn(f"match_length={len(finding_match)}", result.stdout)
        self.assertIn(f"line_length={len(line)}", result.stdout)
        self.assertNotIn(finding_match, result.stdout)



    def test_redacted_report_never_claims_regex_mismatch(self):
        description, (commit, path) = next(iter(EXPECTED_FIXTURES.items()))
        report = [{
            "Commit": commit,
            "File": path,
        source = subprocess.run(
            ["git", "show", f"{commit}:{path}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        start_line = source.index(line) + 1,
            "RuleID": "generic-api-key",
            "StartLine": start_line,
            "Secret": "REDACTED",
            "Match": "key = REDACTED",
            "Line": "",
        }]
        with tempfile.TemporaryDirectory() as directory:
            report_path = pathlib.Path(directory) / "redacted-report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "security" / "validate_gitleaks_allowlists.py"),
                    "--config",
                    str(ROOT / ".gitleaks.toml"),
                    "--report",
                    str(report_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn("regex=redacted allowed=unverifiable", result.stdout)
        self.assertNotIn("REDACTED", result.stdout)



    def test_report_diagnostics_ignore_other_lines_in_same_file_commit(self):
        description, (commit, path) = next(iter(EXPECTED_FIXTURES.items()))
        line = _source_fixture_line(ROOT, commit, path)
        source = subprocess.run(
            ["git", "show", f"{commit}:{path}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        start_line = source.index(line) + 1
        report = [{
            "Commit": commit,
            "File": path,
            "StartLine": start_line + 1,
            "RuleID": "generic-api-key",
            "Secret": "unrelated",
            "Match": "unrelated",
            "Line": "",
        }]
        with tempfile.TemporaryDirectory() as directory:
            report_path = pathlib.Path(directory) / "other-line-report.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "security" / "validate_gitleaks_allowlists.py"),
                    "--config",
                    str(ROOT / ".gitleaks.toml"),
                    "--report",
                    str(report_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn(f"DIAGNOSTIC: {description}: finding=absent", result.stdout)


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
