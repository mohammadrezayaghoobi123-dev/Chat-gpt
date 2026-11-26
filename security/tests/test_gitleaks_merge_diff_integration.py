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
    def test_merge_diff_modes_and_metadata_are_characterized(self):
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

            # A per-merge first-parent invocation may preserve the merge SHA
            # while limiting the scan to one merge commit. This is only a
            # feasibility characterization; production integration is separate.
            scoped_report = root / "scoped-first-parent.json"
            scoped = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(scoped_report),
                    f"--log-opts={merge_commit}^! --diff-merges=first-parent",
                    str(repo),
                ],
                expected=2,
            )
            scoped_findings = json.loads(scoped_report.read_text(encoding="utf-8"))
            self.assertEqual(len(scoped_findings), 1, scoped.stdout + scoped.stderr)
            self.assertEqual(scoped_findings[0]["RuleID"], "synthetic-merge-only")
            self.assertEqual(scoped_findings[0]["Commit"], merge_commit)
            self.assertEqual(scoped_findings[0]["File"], "conflict.txt")

            # Remerge mode should isolate only the resolution delta, but Gitleaks
            # currently omits commit identity; a future wrapper must bind this
            # single-merge invocation to the already verified merge SHA.
            scoped_remerge_report = root / "scoped-remerge.json"
            scoped_remerge = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(scoped_remerge_report),
                    f"--log-opts={merge_commit}^! --diff-merges=remerge --no-prefix",
                    str(repo),
                ],
                expected=2,
            )
            scoped_remerge_findings = json.loads(scoped_remerge_report.read_text(encoding="utf-8"))
            self.assertEqual(len(scoped_remerge_findings), 1, scoped_remerge.stdout + scoped_remerge.stderr)
            self.assertEqual(scoped_remerge_findings[0]["RuleID"], "synthetic-merge-only")
            self.assertEqual(scoped_remerge_findings[0]["Commit"], "")
            self.assertEqual(scoped_remerge_findings[0]["File"], "conflict.txt")

            # Verify that the preserved merge SHA makes commit-scoped allowlists
            # usable, and that a neighboring/wrong SHA does not suppress the finding.
            allowlist_config = root / "scoped-allowlist.toml"
            allowlist_config.write_text(
                'title = "Scoped merge allowlist fixture"\n'
                '[extend]\nuseDefault = false\n'
                '[[rules]]\n'
                'id = "synthetic-merge-only"\n'
                'description = "Synthetic merge-only marker"\n'
                'regex = \'\'\'SYNTHETIC_MERGE_ONLY_SENTINEL\'\'\'\n'
                '[[allowlists]]\n'
                'description = "Exact merge SHA and path only"\n'
                'targetRules = ["synthetic-merge-only"]\n'
                'condition = "AND"\n'
                f'commits = ["{merge_commit}"]\n'
                'paths = [\'\'\'^conflict\\.txt$\'\'\']\n'
                'regexTarget = "line"\n'
                'regexes = [\'\'\'SYNTHETIC_MERGE_ONLY_SENTINEL\'\'\']\n',
                encoding="utf-8",
            )
            # Remerge omits Commit, so an unmodified commit-scoped allowlist
            # cannot match even when this invocation scans exactly one known merge.
            remerge_scoped_report = root / "remerge-commit-scoped.json"
            remerge_scoped = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(allowlist_config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(remerge_scoped_report),
                    f"--log-opts={merge_commit}^! --diff-merges=remerge --no-prefix",
                    str(repo),
                ],
                expected=2,
            )
            remerge_scoped_findings = json.loads(remerge_scoped_report.read_text(encoding="utf-8"))
            self.assertEqual(len(remerge_scoped_findings), 1, remerge_scoped.stdout + remerge_scoped.stderr)
            self.assertEqual(remerge_scoped_findings[0]["Commit"], "")

            # For a single-merge invocation, a wrapper may remove only the matching
            # SHA predicate from a temporary config; all other allowlist predicates
            # remain exact. A wrong SHA must remain non-matching.
            adapted_config = root / "remerge-adapted-allowlist.toml"
            adapted_config.write_text(
                allowlist_config.read_text(encoding="utf-8").replace(
                    f'commits = ["{merge_commit}"]\n', ""
                ),
                encoding="utf-8",
            )
            adapted_report = root / "remerge-adapted.json"
            adapted = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(adapted_config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(adapted_report),
                    f"--log-opts={merge_commit}^! --diff-merges=remerge --no-prefix",
                    str(repo),
                ],
                expected=0,
            )
            self.assertEqual(json.loads(adapted_report.read_text(encoding="utf-8")), [], adapted.stdout + adapted.stderr)

            wrong_remerge_config = root / "remerge-wrong-sha.toml"
            wrong_remerge_config.write_text(
                allowlist_config.read_text(encoding="utf-8").replace(merge_commit, main_parent),
                encoding="utf-8",
            )
            wrong_remerge_report = root / "remerge-wrong-sha.json"
            wrong_remerge = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(wrong_remerge_config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(wrong_remerge_report),
                    f"--log-opts={merge_commit}^! --diff-merges=remerge --no-prefix",
                    str(repo),
                ],
                expected=2,
            )
            wrong_remerge_findings = json.loads(wrong_remerge_report.read_text(encoding="utf-8"))
            self.assertEqual(len(wrong_remerge_findings), 1, wrong_remerge.stdout + wrong_remerge.stderr)
            self.assertEqual(wrong_remerge_findings[0]["Commit"], "")

            allowed_report = root / "scoped-allowlisted.json"
            allowed = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(allowlist_config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(allowed_report),
                    f"--log-opts={merge_commit}^! --diff-merges=first-parent",
                    str(repo),
                ],
                expected=0,
            )
            self.assertEqual(json.loads(allowed_report.read_text(encoding="utf-8")), [], allowed.stdout + allowed.stderr)

            wrong_sha_config = root / "wrong-sha-allowlist.toml"
            wrong_sha_config.write_text(
                allowlist_config.read_text(encoding="utf-8").replace(merge_commit, main_parent),
                encoding="utf-8",
            )
            wrong_sha_report = root / "wrong-sha-allowlist.json"
            wrong_sha = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(wrong_sha_config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(wrong_sha_report),
                    f"--log-opts={merge_commit}^! --diff-merges=first-parent",
                    str(repo),
                ],
                expected=2,
            )
            wrong_sha_findings = json.loads(wrong_sha_report.read_text(encoding="utf-8"))
            self.assertEqual(len(wrong_sha_findings), 1, wrong_sha.stdout + wrong_sha.stderr)
            self.assertEqual(wrong_sha_findings[0]["Commit"], merge_commit)

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
                    "--log-opts=--all --diff-merges=remerge --no-prefix --format=fuller", str(repo),
                ],
                expected=2,
            )
            remerge_findings = json.loads(remerge_report.read_text(encoding="utf-8"))
            self.assertEqual(len(remerge_findings), 1, remerge.stdout + remerge.stderr)
            self.assertEqual(remerge_findings[0]["RuleID"], "synthetic-merge-only")
            self.assertEqual(remerge_findings[0]["Commit"], "")
            self.assertEqual(remerge_findings[0]["File"], "conflict.txt")

            medium_report = root / "remerge-medium.json"
            medium = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(medium_report),
                    "--log-opts=--all --diff-merges=remerge --no-prefix --format=medium",
                    str(repo),
                ],
                expected=2,
            )
            medium_findings = json.loads(medium_report.read_text(encoding="utf-8"))
            self.assertEqual(len(medium_findings), 1, medium.stdout + medium.stderr)
            self.assertEqual(medium_findings[0]["RuleID"], "synthetic-merge-only")
            self.assertEqual(medium_findings[0]["Commit"], "")
            self.assertEqual(medium_findings[0]["File"], "conflict.txt")


    def test_per_merge_first_parent_reattributes_second_parent_allowlisted_finding(self):
        """A per-merge first-parent scan can reattribute a cleanly merged finding."""
        with tempfile.TemporaryDirectory(prefix="gitleaks-merge-reattribution-") as temporary:
            root = pathlib.Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            run(["git", "init", "-b", "main"], cwd=repo)
            run(["git", "config", "user.name", "Synthetic Test"], cwd=repo)
            run(["git", "config", "user.email", "synthetic@example.invalid"], cwd=repo)

            (repo / "README.md").write_text("base\n", encoding="utf-8")
            run(["git", "add", "README.md"], cwd=repo)
            run(["git", "commit", "-m", "base"], cwd=repo)

            run(["git", "checkout", "-b", "side"], cwd=repo)
            marker = "SYNTHETIC_INHERITED_SENTINEL"
            (repo / "secret.txt").write_text(marker + "\n", encoding="utf-8")
            run(["git", "add", "secret.txt"], cwd=repo)
            run(["git", "commit", "-m", "introduce synthetic marker on side branch"], cwd=repo)
            introducing_commit = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

            run(["git", "checkout", "main"], cwd=repo)
            (repo / "main-only.txt").write_text("main change\n", encoding="utf-8")
            run(["git", "add", "main-only.txt"], cwd=repo)
            run(["git", "commit", "-m", "main-only change"], cwd=repo)

            run(["git", "merge", "--no-ff", "side", "-m", "merge side"], cwd=repo)
            merge_commit = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()

            config = root / "scoped-source-allowlist.toml"
            config.write_text(
                'title = "Inherited finding attribution fixture"\n'
                '[extend]\nuseDefault = false\n'
                '[[rules]]\n'
                'id = "synthetic-inherited"\n'
                'description = "Synthetic inherited marker"\n'
                f'regex = \'\'\'{marker}\'\'\'\n'
                '[[allowlists]]\n'
                'description = "Allow only the original introducing commit"\n'
                'targetRules = ["synthetic-inherited"]\n'
                'condition = "AND"\n'
                f'commits = ["{introducing_commit}"]\n'
                'paths = [\'\'\'^secret\\.txt$\'\'\']\n'
                'regexTarget = "line"\n'
                f'regexes = [\'\'\'{marker}\'\'\']\n',
                encoding="utf-8",
            )

            ordinary_report = root / "ordinary-allowlisted.json"
            ordinary = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(ordinary_report), "--log-opts=--all", str(repo),
                ],
                expected=0,
            )
            self.assertEqual(
                json.loads(ordinary_report.read_text(encoding="utf-8")),
                [],
                ordinary.stdout + ordinary.stderr,
            )

            scoped_report = root / "merge-reattributed.json"
            scoped = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(scoped_report),
                    f"--log-opts={merge_commit}^! --diff-merges=first-parent",
                    str(repo),
                ],
                expected=2,
            )
            findings = json.loads(scoped_report.read_text(encoding="utf-8"))
            self.assertEqual(len(findings), 1, scoped.stdout + scoped.stderr)
            self.assertEqual(findings[0]["RuleID"], "synthetic-inherited")
            self.assertEqual(findings[0]["Commit"], merge_commit)
            self.assertNotEqual(findings[0]["Commit"], introducing_commit)
            self.assertEqual(findings[0]["File"], "secret.txt")

            # Remerge diff should omit inherited side-branch content; only the
            # resolution-specific delta belongs to the merge commit.
            remerge_report = root / "inherited-remerge.json"
            remerge = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(remerge_report),
                    f"--log-opts={merge_commit}^! --diff-merges=remerge --no-prefix",
                    str(repo),
                ],
                expected=0,
            )
            self.assertEqual(
                json.loads(remerge_report.read_text(encoding="utf-8")),
                [],
                remerge.stdout + remerge.stderr,
            )


    def test_remerge_does_not_cover_octopus_merge_and_must_be_rejected(self):
        """Git remerge diff is two-parent-only; octopus coverage must fail closed."""
        with tempfile.TemporaryDirectory(prefix="gitleaks-octopus-") as temporary:
            root = pathlib.Path(temporary)
            repo = root / "repo"
            repo.mkdir()
            run(["git", "init", "-b", "main"], cwd=repo)
            run(["git", "config", "user.name", "Synthetic Test"], cwd=repo)
            run(["git", "config", "user.email", "synthetic@example.invalid"], cwd=repo)

            (repo / "README.md").write_text("base\n", encoding="utf-8")
            run(["git", "add", "README.md"], cwd=repo)
            run(["git", "commit", "-m", "base"], cwd=repo)

            marker = "SYNTHETIC_OCTOPUS_ONLY_SENTINEL"
            branch_names = ["side-a", "side-b", "side-c"]
            for index, branch_name in enumerate(branch_names):
                run(["git", "checkout", "-b", branch_name], cwd=repo)
                filename = f"{branch_name}.txt"
                (repo / filename).write_text(f"{marker}-{index}\n", encoding="utf-8")
                run(["git", "add", filename], cwd=repo)
                run(["git", "commit", "-m", f"add {filename}"], cwd=repo)
                if index < len(branch_names) - 1:
                    run(["git", "checkout", "main"], cwd=repo)

            run(["git", "checkout", "main"], cwd=repo)
            run(["git", "merge", "--no-ff", *branch_names, "-m", "octopus merge"], cwd=repo)
            resolution_marker = "SYNTHETIC_OCTOPUS_RESOLUTION_ONLY_SENTINEL"
            (repo / "octopus-resolution.txt").write_text(resolution_marker + "\n", encoding="utf-8")
            run(["git", "add", "octopus-resolution.txt"], cwd=repo)
            run(["git", "commit", "--amend", "--no-edit"], cwd=repo)

            merge_commit = run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()
            parents = run(["git", "rev-list", "--parents", "-n", "1", merge_commit], cwd=repo).stdout.split()
            self.assertEqual(len(parents), 5, "fixture must create a four-parent octopus merge")

            for parent_sha in parents[1:]:
                absent = subprocess.run(
                    ["git", "cat-file", "-e", f"{parent_sha}:octopus-resolution.txt"],
                    cwd=repo, text=True, capture_output=True, check=False,
                )
                self.assertNotEqual(absent.returncode, 0, "resolution-only marker must be absent from every parent")

            merged_tree = run(["git", "show", f"{merge_commit}:octopus-resolution.txt"], cwd=repo).stdout
            self.assertIn(resolution_marker, merged_tree)

            config = root / "octopus.toml"
            config.write_text(
                'title = "Synthetic octopus coverage fixture"\n'
                '[extend]\nuseDefault = false\n'
                '[[rules]]\n'
                'id = "synthetic-octopus-only"\n'
                'description = "Synthetic octopus marker"\n'
                f"regex = '''{resolution_marker}'''\n",
                encoding="utf-8",
            )

            report = root / "octopus-remerge.json"
            result = run(
                [
                    GITLEAKS_BIN, "git", "--config", str(config), "--redact",
                    "--exit-code", "2", "--report-format", "json",
                    "--report-path", str(report),
                    f"--log-opts={merge_commit}^! --diff-merges=remerge --no-prefix",
                    str(repo),
                ],
                expected=0,
            )
            findings = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(
                findings,
                [],
                result.stdout + result.stderr,
            )
            # The secret-like marker exists in the octopus result tree but is
            # invisible to remerge mode. A production wrapper must reject
            # parent-count != 2 rather than silently count this as scanned.
