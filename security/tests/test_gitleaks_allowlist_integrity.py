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
                marker = bytes.fromhex(key).decode("ascii")
                self.assertIsNotNone(pattern.fullmatch(marker))
                mutated = ("0" if marker[0] != "0" else "1") + marker[1:]
                self.assertIsNone(pattern.fullmatch(mutated))


    def test_report_diagnostics_explain_allowlist_predicates_without_secrets(self):
        description, (commit, path) = next(iter(EXPECTED_FIXTURES.items()))
        line = _source_fixture_line(ROOT, commit, path)
        fixture = re.fullmatch(r'const key = "([0-9a-f]{64})";', line)
        self.assertIsNotNone(fixture)
        marker = bytes.fromhex(fixture.group(1)).decode("ascii")
        finding_match = f'key = "{marker}"'
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
            "Secret": marker,
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
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn(
            "rule=True commit=True path=True regex=True allowed=True",
            result.stdout,
        )
        self.assertIn("secret_decoded=True match_decoded=True", result.stdout)
        self.assertIn(f"secret_length={len(marker)}", result.stdout)
        self.assertIn(f"match_length={len(finding_match)}", result.stdout)
        self.assertIn(f"line_length={len(line)}", result.stdout)
        self.assertNotIn(marker, result.stdout)



    def test_redacted_report_never_claims_regex_mismatch(self):
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
            "StartLine": start_line,
            "RuleID": "generic-api-key",
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
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
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



    def test_historical_false_positive_exceptions_are_atomic_and_line_exact(self):
        specs = [
            ("Historical Owner command idempotency fixture line 397 (167b6764).", "167b676479f855a92d63b2aca575b8798128c143", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 397),
            ("Historical Owner command idempotency fixture line 516 (a5f3a65d).", "a5f3a65dbe8e41d09c5d23131beca4eb73342fb2", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
            ("Historical Owner command idempotency fixture line 516 (93214555).", "93214555f5aa752a670c1c7c9a6d5f7b58f41cdf", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
            ("Historical Owner command idempotency fixture line 397 (5a750037).", "5a750037bc1bec098184b7890f66b407582b94d8", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 397),
            ("Historical Owner command idempotency fixture line 516 (5a750037).", "5a750037bc1bec098184b7890f66b407582b94d8", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
            ("Historical Owner command idempotency fixture line 516 (b12a3e06).", "b12a3e068c8cba44039cf478f174814fc1d8f6b5", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
            ("Historical Router rotation test fixture line 1805 (ab525a63).", "ab525a63948822e195cc74f63c3a6b4340f705db", "tools/9router-review/review.test.mjs", 1805),
            ("Public ICU signing metadata line 32 (3082b80f).", "3082b80fbaf71685827ba63de882c3d93083b96f", "docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md", 32),
            ("Public ICU signing metadata line 70 (3082b80f).", "3082b80fbaf71685827ba63de882c3d93083b96f", "docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md", 70),
            ("Historical Owner command idempotency fixture line 1904 (0222e99d).", "0222e99d941ded0910ae4252f66b9dfb1dd39025", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 1904),
            ("Historical Owner command idempotency fixture line 1260 (75ca4409).", "75ca4409487e887279b45b66563c346015ce2342", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 1260),
            ("Synthetic API_KEY placeholder comment line 1402 (04d76f8f).", "04d76f8fd734eaf4053c86461e1204caf18d9c9c", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 1402),
            ("Computed scheduler idempotency identifier line 277 (2729a325).", "2729a325991c989cbab182967135aa76f864ac29", "cloud-engineering-connector/worker.js", 277),
        ]
        entries = {entry.get("description"): entry for entry in self.config.get("allowlists", [])}
        self.assertEqual(len(self.config.get("allowlists", [])), 30)
        self.assertEqual(len(specs), len({description for description, *_ in specs}))
        for description, commit, path, line_number in specs:
            with self.subTest(description=description):
                entry = entries.get(description)
                self.assertIsNotNone(entry)
                self.assertEqual(entry.get("targetRules"), ["generic-api-key"])
                self.assertEqual(entry.get("condition"), "AND")
                self.assertEqual(entry.get("commits"), [commit])
                escaped_path = path.replace(".", r"\.")
                self.assertEqual(entry.get("paths"), [f"^{escaped_path}$"])
                self.assertEqual(entry.get("regexTarget"), "line")
                regexes = entry.get("regexes", [])
                self.assertEqual(len(regexes), 1)
                pattern = re.compile(regexes[0])
                source = subprocess.run(
                    ["git", "show", f"{commit}:{path}"],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout.splitlines()
                line = source[line_number - 1]
                self.assertTrue(pattern.fullmatch(line), description)
                self.assertTrue(pattern.fullmatch("\\n" + line), description)
                self.assertIsNone(pattern.fullmatch(line + "x"), description)


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
