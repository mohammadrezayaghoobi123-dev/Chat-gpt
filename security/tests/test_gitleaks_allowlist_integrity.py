import copy
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "security"))
from validate_gitleaks_allowlists import EXPECTED_FIXTURES, EXPECTED_LINE_EXCEPTIONS, _source_fixture_line, validate_config


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



    def test_legacy_main_allowlists_cannot_be_widened(self):
        changed = copy.deepcopy(self.config)
        legacy_entry = next(
            entry for entry in changed["allowlists"]
            if entry.get("description") not in EXPECTED_FIXTURES
            and entry.get("description") not in EXPECTED_LINE_EXCEPTIONS
        )
        legacy_entry["regexes"] = [".*"]
        self.assertTrue(validate_config(changed, ROOT))

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
            ("Synthetic Router previous-marker key in historical rotation test line 1805 (ab525a63).", "ab525a63948822e195cc74f63c3a6b4340f705db", "tools/9router-review/review.test.mjs", 1805),
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
                self.assertTrue(pattern.fullmatch("\n" + line), description)
                self.assertIsNone(pattern.fullmatch(line + "x"), description)


    def test_validator_rejects_non_literal_line_pattern(self):
        changed = copy.deepcopy(self.config)
        target = next(
            entry for entry in changed["allowlists"]
            if entry.get("description") in EXPECTED_FIXTURES
        )
        target["regexes"] = [r'const key = ".*";']
        self.assertTrue(validate_config(changed, ROOT))



    def test_necessity_config_removes_only_thirteen_new_line_exceptions(self):
        from validate_gitleaks_allowlists import build_necessity_config
        reduced = build_necessity_config(self.config)
        self.assertEqual(len(reduced["allowlists"]), 17)
        remaining_descriptions = {entry.get("description") for entry in reduced["allowlists"]}
        self.assertEqual(remaining_descriptions & set(EXPECTED_LINE_EXCEPTIONS), set())
        self.assertEqual(remaining_descriptions & set(EXPECTED_FIXTURES), set(EXPECTED_FIXTURES))
        legacy = [
            entry for entry in reduced["allowlists"]
            if entry.get("description") not in EXPECTED_FIXTURES
        ]
        self.assertEqual(len(legacy), 15)

    def test_necessity_report_matches_exact_expected_finding_tuples(self):
        from validate_gitleaks_allowlists import verify_necessity_report
        report = [
            {"Commit": commit, "File": path, "StartLine": line, "RuleID": "generic-api-key"}
            for commit, path, line in EXPECTED_LINE_EXCEPTIONS.values()
        ]
        self.assertEqual(verify_necessity_report(report), [])

    def test_necessity_report_rejects_missing_duplicate_extra_and_mismatched_findings(self):
        from validate_gitleaks_allowlists import verify_necessity_report
        expected = [
            {"Commit": commit, "File": path, "StartLine": line, "RuleID": "generic-api-key"}
            for commit, path, line in EXPECTED_LINE_EXCEPTIONS.values()
        ]
        cases = {
            "missing": expected[:-1],
            "duplicate": expected + [expected[0]],
            "extra": expected + [{"Commit": "f" * 40, "File": "unexpected.txt", "StartLine": 1, "RuleID": "generic-api-key"}],
            "mismatch": [{**expected[0], "StartLine": expected[0]["StartLine"] + 1}] + expected[1:],
        }
        for label, report in cases.items():
            with self.subTest(case=label):
                self.assertTrue(verify_necessity_report(report))


    def test_necessity_config_serializes_to_valid_toml_and_keeps_baseline(self):
        from validate_gitleaks_allowlists import build_necessity_config, write_toml_config
        reduced = build_necessity_config(self.config)
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "diagnostic.toml"
            write_toml_config(reduced, destination)
            with destination.open("rb") as handle:
                parsed = tomllib.load(handle)
        self.assertEqual(parsed, reduced)
        self.assertEqual(len(parsed["allowlists"]), 17)

    def test_necessity_report_rejects_malformed_tuple_types(self):
        from validate_gitleaks_allowlists import verify_necessity_report
        malformed = [{"Commit": [], "File": {}, "StartLine": True, "RuleID": "generic-api-key"}]
        errors = verify_necessity_report(malformed)
        self.assertTrue(errors)
        self.assertTrue(any("malformed" in error for error in errors))


    def test_validator_rejects_non_table_allowlist_members_without_exception(self):
        for malformed in ("invalid", None, [], 123, {}):
            with self.subTest(member_type=type(malformed).__name__):
                changed = copy.deepcopy(self.config)
                changed["allowlists"][0] = malformed
                try:
                    errors = validate_config(changed, ROOT)
                except Exception as exc:
                    self.fail(f"validator raised {type(exc).__name__} for malformed allowlist member")
                self.assertTrue(errors)

    def test_validator_rejects_non_table_baseline_members_without_exception(self):
        malformed_baseline = 'allowlists = ["not-a-table"]\n'
        completed = subprocess.CompletedProcess(
            args=["git", "show", "origin/main:.gitleaks.toml"],
            returncode=0,
            stdout=malformed_baseline,
            stderr="",
        )
        with patch("validate_gitleaks_allowlists.subprocess.run", return_value=completed):
            try:
                errors = validate_config(copy.deepcopy(self.config), ROOT)
            except Exception as exc:
                self.fail(f"validator raised {type(exc).__name__} for malformed baseline member")
        self.assertIn("baseline allowlists entries must be TOML tables", errors)

    def test_necessity_config_rejects_non_table_members_with_value_error(self):
        changed = copy.deepcopy(self.config)
        changed["allowlists"][0] = "invalid"
        from validate_gitleaks_allowlists import build_necessity_config
        try:
            build_necessity_config(changed)
        except ValueError as exc:
            self.assertIn("allowlists entries must be TOML tables", str(exc))
        except Exception as exc:
            self.fail(f"necessity builder raised uncontrolled {type(exc).__name__}")
        else:
            self.fail("necessity builder accepted a malformed allowlist member")

    def test_validator_rejects_non_table_configuration_without_exception(self):
        for malformed in (None, [], "invalid"):
            with self.subTest(config_type=type(malformed).__name__):
                try:
                    errors = validate_config(malformed, ROOT)
                except Exception as exc:
                    self.fail(f"validator raised {type(exc).__name__} for malformed config")
                self.assertTrue(errors)

    def test_full_history_workflow_uses_fail_fast_and_explicit_gitleaks_exit_handling(self):
        workflow_path = ROOT / ".github" / "workflows" / "secret-history-scan.yml"
        workflow = workflow_path.read_text(encoding="utf-8")
        lines = [line.strip() for line in workflow.splitlines()]
        self.assertIn("set -euo pipefail", lines)
        self.assertNotIn("set +e", lines)

        full_scan = next(i for i, line in enumerate(lines) if line.startswith("if /tmp/gitleaks-8.30.1/gitleaks git --config .gitleaks.toml"))
        self.assertEqual(lines[full_scan + 1:full_scan + 5], [
            "scan_status=0", "else", "scan_status=$?", "fi"
        ])

        necessity_scan = next(i for i, line in enumerate(lines) if line.startswith('if /tmp/gitleaks-8.30.1/gitleaks git --config "$necessity_config"'))
        self.assertEqual(lines[necessity_scan + 1:necessity_scan + 5], [
            "necessity_scan_status=0", "else", "necessity_scan_status=$?", "fi"
        ])


    def test_allowlist_integrity_workflow_covers_all_branches_for_security_paths(self):
        workflow_path = ROOT / ".github" / "workflows" / "gitleaks-allowlist-integrity.yml"
        lines = workflow_path.read_text(encoding="utf-8").splitlines()
        expected_paths = {
            ".gitleaks.toml",
            "security/**",
            ".github/workflows/gitleaks-allowlist-integrity.yml",
            ".github/workflows/secret-history-scan.yml",
        }

        for event in ("pull_request", "push"):
            with self.subTest(event=event):
                event_line = f"  {event}:"
                self.assertIn(event_line, lines)
                start_index = lines.index(event_line) + 1
                end_index = next(
                    (
                        index for index in range(start_index, len(lines))
                        if (
                            (
                                lines[index].startswith("  ")
                                and not lines[index].startswith("    ")
                            )
                            or not lines[index].startswith(" ")
                        )
                        and lines[index].endswith(":")
                    ),
                    len(lines),
                )
                event_lines = lines[start_index:end_index]
                self.assertFalse(
                    any(line.strip().startswith("branches:") for line in event_lines),
                    f"{event} must cover every target branch",
                )
                actual_paths = set()
                for line in event_lines:
                    item = line.strip()
                    if item.startswith('- "') and item.endswith('"'):
                        actual_paths.add(item[3:-1])
                self.assertEqual(actual_paths, expected_paths)


    def test_validate_config_rejects_malformed_current_descriptions_without_raising(self):
        cases = [
            ("array", []),
            ("inline_table", {"malformed": True}),
            ("missing", "__MISSING__"),
            ("empty", ""),
            ("whitespace", "   "),
            ("integer", 7),
            ("boolean", True),
            ("null", None),
        ]
        for label, value in cases:
            with self.subTest(description_type=label):
                changed = copy.deepcopy(self.config)
                if value == "__MISSING__":
                    changed["allowlists"][0].pop("description", None)
                else:
                    changed["allowlists"][0]["description"] = value
                errors = validate_config(changed, ROOT)
                self.assertTrue(errors, "malformed description must be rejected")
                self.assertTrue(
                    any("description" in error.lower() for error in errors),
                    msg=f"expected a controlled description error, got {errors!r}",
                )

    def test_validate_config_rejects_malformed_baseline_descriptions_before_filtering(self):
        malformed_baselines = {
            "array": "allowlists = [{ description = [] }]" + chr(10),
            "inline_table": "allowlists = [{ description = { malformed = true } }]" + chr(10),
            "missing": "allowlists = [{}]" + chr(10),
            "empty": 'allowlists = [{ description = "" }]' + chr(10),
            "whitespace": 'allowlists = [{ description = "   " }]' + chr(10),
            "integer": "allowlists = [{ description = 7 }]" + chr(10),
            "boolean": "allowlists = [{ description = true }]" + chr(10),
        }
        for label, baseline_text in malformed_baselines.items():
            with self.subTest(description_type=label):
                completed = subprocess.CompletedProcess(
                    args=["git", "show", "origin/main:.gitleaks.toml"],
                    returncode=0,
                    stdout=baseline_text,
                    stderr="",
                )
                with patch(
                    "validate_gitleaks_allowlists.subprocess.run",
                    return_value=completed,
                ):
                    errors = validate_config(copy.deepcopy(self.config), ROOT)
                self.assertTrue(errors, "malformed baseline description must be rejected")
                self.assertTrue(
                    any("description" in error.lower() for error in errors),
                    msg=f"expected a controlled baseline description error, got {errors!r}",
                )

    def test_build_necessity_config_rejects_malformed_descriptions_with_value_error(self):
        from validate_gitleaks_allowlists import build_necessity_config

        cases = [
            ("array", []),
            ("inline_table", {"malformed": True}),
            ("missing", "__MISSING__"),
            ("empty", ""),
            ("whitespace", "   "),
            ("integer", 7),
            ("boolean", True),
            ("null", None),
        ]
        for label, value in cases:
            with self.subTest(description_type=label):
                changed = copy.deepcopy(self.config)
                if value == "__MISSING__":
                    changed["allowlists"][0].pop("description", None)
                else:
                    changed["allowlists"][0]["description"] = value
                with self.assertRaisesRegex(ValueError, "description"):
                    build_necessity_config(changed)



if __name__ == "__main__":
    unittest.main()
