import json
import os
import pathlib
import subprocess
import tempfile
import unittest


GITLEAKS_BIN = os.environ.get("GITLEAKS_BIN", "/tmp/gitleaks-8.30.1/gitleaks")


def run(command, *, cwd=None, expected=0):
    result = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != expected:
        raise AssertionError(
            f"command returned {result.returncode}, expected {expected}: {command!r}\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    return result


@unittest.skipUnless(pathlib.Path(GITLEAKS_BIN).is_file(), "pinned Gitleaks binary is unavailable")
class GitleaksMergeDiffIntegrationTests(unittest.TestCase):
    def test_first_parent_merge_diff_detects_resolution_only_content(self):
        with tempfile.TemporaryDirectory(prefix="gitleaks-merge-fixture-") as temporary:
            root = pathlib.Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            run(["git", "init", "-b", "main"], cwd=repo)
            run(["git", "config", "user.name", "Synthetic Test"], cwd=repo)
            run(["git", "config", "user.email", "synthetic@example.invalid"], cwd=repo)

            target = repo / "conflict.txt"
            target.write_text("setting=base\n", encoding="utf-8")
            run(["git", "add", "conflict.txt"], cwd=repo)
            run(["git", "commit", "-m", "base"], cwd=repo)

            run(["git", "checkout", "-b", "side"], cwd=repo)
            target.write_text("setting=side\n", encoding="utf-8")
            run(["git", "commit", "-am", "side change"], cwd=repo)
            side_parent = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

            run(["git", "checkout", "main"], cwd=repo)
            target.write_text("setting=main\n", encoding="utf-8")
            run(["git", "commit", "-am", "main change"], cwd=repo)
            main_parent = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

            merge = subprocess.run(
                ["git", "merge", "--no-commit", "side"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(merge.returncode, 0, "fixture must produce a real content conflict")
            marker = "SYNTHETIC_MERGE_ONLY_SENTINEL"
            target.write_text(f"setting=resolved\n{marker}\n", encoding="utf-8")
            run(["git", "add", "conflict.txt"], cwd=repo)
            run(["git", "commit", "-m", "resolve merge with synthetic marker"], cwd=repo)
            merge_commit = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

            self.assertNotIn(marker, run(["git", "show", f"{main_parent}:conflict.txt"], cwd=repo).stdout)
            self.assertNotIn(marker, run(["git", "show", f"{side_parent}:conflict.txt"], cwd=repo).stdout)
            self.assertIn(marker, run(["git", "show", f"{merge_commit}:conflict.txt"], cwd=repo).stdout)

            config = root / "gitleaks.toml"
            config.write_text(
                'title = "Synthetic merge coverage fixture"\n'
                '[extend]\nuseDefault = false\n'
                '[[rules]]\n'
                'id = "synthetic-merge-only"\n'
                'description = "Synthetic merge-only marker"\n'
                'regex = \'\'\'SYNTHETIC_MERGE_ONLY_SENTINEL\'\'\'\n',
                encoding="utf-8",
            )

            ordinary_report = root / "ordinary.json"
            ordinary = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(ordinary_report), "--log-opts=--all", str(repo),
                ],
                expected=0,
            )
            ordinary_findings = json.loads(ordinary_report.read_text(encoding="utf-8"))
            self.assertEqual(ordinary_findings, [], ordinary.stdout + ordinary.stderr)

            merge_report = root / "merge-aware.json"
            merge_aware = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(merge_report),
                    "--log-opts=--all --diff-merges=first-parent", str(repo),
                ],
                expected=2,
            )
            findings = json.loads(merge_report.read_text(encoding="utf-8"))
            self.assertEqual(len(findings), 1, merge_aware.stdout + merge_aware.stderr)
            self.assertEqual(findings[0]["RuleID"], "synthetic-merge-only")
            self.assertEqual(findings[0]["Commit"], merge_commit)
            self.assertEqual(findings[0]["File"], "conflict.txt")

            combined_report = root / "combined.json"
            combined = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(combined_report),
                    "--log-opts=--all --diff-merges=combined", str(repo),
                ],
                expected=0,
            )
            self.assertEqual(json.loads(combined_report.read_text(encoding="utf-8")), [])

            remerge_report = root / "remerge.json"
            remerge = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(remerge_report),
                    "--log-opts=--all --diff-merges=remerge --no-prefix", str(repo),
                ],
                expected=2,
            )
            remerge_findings = json.loads(remerge_report.read_text(encoding="utf-8"))
            self.assertEqual(len(remerge_findings), 1, remerge.stdout + remerge.stderr)
            self.assertEqual(remerge_findings[0]["RuleID"], "synthetic-merge-only")
            self.assertEqual(remerge_findings[0]["Commit"], merge_commit)
            self.assertEqual(remerge_findings[0]["File"], "conflict.txt")
