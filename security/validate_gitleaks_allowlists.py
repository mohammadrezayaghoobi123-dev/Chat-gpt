from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess
import sys
import tomllib

EXPECTED_FIXTURES = {
    "Synthetic ephemeral HMAC test-key fixture from one historical identity test commit; restricted to that exact commit, file, and generic-api-key rule.": (
        "d5ffafb6df54e26189d8494548f7693fdcfdf108",
        "cloud-engineering-connector/test/orchestrator-worker-identity.test.js",
    ),
    "Synthetic ephemeral HMAC test-key fixture from one historical outbox publisher test commit; restricted to that exact commit, file, and generic-api-key rule.": (
        "a5c36d1c2e7461e38578a688133c797f541b4b46",
        "cloud-engineering-connector/test/orchestrator-outbox-publisher.test.js",
    ),
}
FIXTURE_LINE = re.compile(r'const key = "([0-9a-f]{64})";')
EXPECTED_ALLOWLIST_COUNT = 17


def _invalid_regex(pattern: str) -> bool:
    try:
        re.compile(pattern)
    except re.error:
        return True
    return False


def _source_fixture_line(repo_root: pathlib.Path, commit: str, path: str) -> str | None:
    result = subprocess.run(
        ["git", "show", f"{commit}:{path}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    matches = [line for line in result.stdout.splitlines() if FIXTURE_LINE.fullmatch(line)]
    return matches[0] if len(matches) == 1 else None


def validate_config(config: dict, repo_root: pathlib.Path) -> list[str]:
    errors: list[str] = []
    allowlists = config.get("allowlists", [])
    if not isinstance(allowlists, list) or len(allowlists) != EXPECTED_ALLOWLIST_COUNT:
        errors.append("allowlist count changed; new exceptions require explicit review")
        return errors

    for index, entry in enumerate(allowlists, start=1):
        prefix = f"allowlist {index}"
        if not isinstance(entry.get("targetRules"), list) or not entry["targetRules"]:
            errors.append(f"{prefix}: targetRules must be non-empty")
        if entry.get("condition") != "AND":
            errors.append(f"{prefix}: condition must remain AND")
        commits = entry.get("commits")
        if not isinstance(commits, list) or not commits or any(
            not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None
            for commit in commits
        ):
            errors.append(f"{prefix}: commits must be pinned full Git SHAs")
        paths = entry.get("paths")
        if not isinstance(paths, list) or not paths or any(
            not isinstance(path, str) or not path.startswith("^") or not path.endswith("$")
            for path in paths
        ):
            errors.append(f"{prefix}: paths must be non-empty and anchored")
        elif any(_invalid_regex(path) for path in paths):
            errors.append(f"{prefix}: path regex is invalid")
        if entry.get("regexTarget") not in {"line", "secret"}:
            errors.append(f"{prefix}: regexTarget must be line or secret")
        regexes = entry.get("regexes")
        if not isinstance(regexes, list) or not regexes or any(
            not isinstance(pattern, str) or not pattern
            for pattern in regexes
        ):
            errors.append(f"{prefix}: regexes must be non-empty strings")

    matching_entries = [
        entry for entry in allowlists
        if entry.get("description") in EXPECTED_FIXTURES
    ]
    entries = {entry.get("description"): entry for entry in matching_entries}
    if len(matching_entries) != len(EXPECTED_FIXTURES) or set(entries) != set(EXPECTED_FIXTURES):
        return ["expected exactly two pinned synthetic HMAC fixture allowlists"]

    for description, (expected_commit, expected_path) in EXPECTED_FIXTURES.items():
        entry = entries[description]
        label = description
        if entry.get("targetRules") != ["generic-api-key"]:
            errors.append(f"{label}: targetRules must remain exactly generic-api-key")
        if entry.get("condition") != "AND":
            errors.append(f"{label}: condition must remain AND")
        if entry.get("commits") != [expected_commit]:
            errors.append(f"{label}: commit scope changed")
        escaped_path = expected_path.replace(".", r"\.")
        if entry.get("paths") != [f"^{escaped_path}$"]:
            errors.append(f"{label}: path scope changed or is not anchored")
        if entry.get("regexTarget") != "secret":
            errors.append(f"{label}: regexTarget must be secret")

        regexes = entry.get("regexes")
        if not isinstance(regexes, list) or len(regexes) != 1 or not isinstance(regexes[0], str):
            errors.append(f"{label}: exactly one literal-scoped regex is required")
            continue
        try:
            pattern = re.compile(regexes[0])
        except re.error:
            errors.append(f"{label}: regex is invalid")
            continue

        line = _source_fixture_line(repo_root, expected_commit, expected_path)
        if line is None:
            errors.append(f"{label}: pinned historical source fixture could not be verified")
            continue
        match = FIXTURE_LINE.fullmatch(line)
        assert match is not None
        try:
            marker = bytes.fromhex(match.group(1)).decode("ascii")
        except (ValueError, UnicodeDecodeError):
            marker = ""
        if marker != "0123456789abcdef" * 2:
            errors.append(f"{label}: historical fixture does not match the approved synthetic marker")
        key = match.group(1)
        expected_pattern = f'^key = "{key}"$'
        if regexes[0] != expected_pattern:
            errors.append(f"{label}: regex must match only the exact extracted historical fixture secret")
        finding_match = f'key = "{key}"'
        if not pattern.fullmatch(finding_match):
            errors.append(f"{label}: regex does not match the exact Gitleaks finding match")
        replacement = "1" if key[0] != "1" else "2"
        mutated_match = f'key = "{replacement + key[1:]}"'
        if pattern.fullmatch(mutated_match):
            errors.append(f"{label}: regex also matches a mutated fixture and is not literal-scoped")
    return errors



def diagnose_report(report: list[dict], config: dict) -> list[str]:
    diagnostics: list[str] = []
    entries = {
        entry.get("description"): entry
        for entry in config.get("allowlists", [])
        if entry.get("description") in EXPECTED_FIXTURES
    }
    for description, (expected_commit, expected_path) in EXPECTED_FIXTURES.items():
        entry = entries.get(description)
        label = description
        if entry is None:
            diagnostics.append(f"DIAGNOSTIC: {label}: allowlist=missing")
            continue
        source_text = subprocess.run(
            ["git", "show", f"{expected_commit}:{expected_path}"],
            cwd=pathlib.Path.cwd(),
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        source_lines = source_text.splitlines()
        source_locations = [
            index for index, source_line in enumerate(source_lines, start=1)
            if FIXTURE_LINE.fullmatch(source_line)
        ]
        if len(source_locations) != 1:
            diagnostics.append(f"DIAGNOSTIC: {label}: source_fixture=missing_or_ambiguous")
            continue
        expected_line = source_locations[0]
        candidates = [
            finding for finding in report
            if finding.get("Commit") == expected_commit
            and finding.get("File") == expected_path
            and finding.get("RuleID") == "generic-api-key"
            and finding.get("StartLine") == expected_line
        ]
        if not candidates:
            diagnostics.append(f"DIAGNOSTIC: {label}: finding=absent")
            continue
        for finding in candidates:
            rule_match = finding.get("RuleID") in entry.get("targetRules", [])
            commit_match = finding.get("Commit") in entry.get("commits", [])
            path_match = any(
                re.search(pattern, finding.get("File", "")) is not None
                for pattern in entry.get("paths", [])
            )
            target_field = {
                "line": "Line",
                "match": "Match",
            }.get(entry.get("regexTarget"), "Secret")
            target = finding.get(target_field) or ""
            source_line = _source_fixture_line(pathlib.Path.cwd(), expected_commit, expected_path) or ""
            source_match = FIXTURE_LINE.fullmatch(source_line)
            source_key = source_match.group(1) if source_match else ""
            first_half = source_key[: len(source_key) // 2]
            finding_secret = finding.get("Secret") or ""
            finding_match = finding.get("Match") or ""
            secret_matches_full = finding_secret == source_key
            secret_matches_first_half = finding_secret == first_half
            match_matches_full = finding_match == f'key = "{source_key}"'
            match_matches_first_half = finding_match == f'key = "{first_half}"'
            redacted = target == "REDACTED" or "REDACTED" in finding_match
            regex_match = None if redacted else any(
                re.search(pattern, target) is not None
                for pattern in entry.get("regexes", [])
            )
            if redacted:
                allowed = None
            elif entry.get("condition") == "AND":
                allowed = rule_match and commit_match and path_match and bool(regex_match)
            else:
                allowed = False
            regex_label = "redacted" if redacted else str(regex_match)
            allowed_label = "unverifiable" if allowed is None else str(allowed)
            diagnostics.append(
                f"DIAGNOSTIC: {label}: rule={rule_match} commit={commit_match} "
                f"path={path_match} regex={regex_label} allowed={allowed_label} "
                f"secret_length={len(finding_secret)} match_length={len(finding_match)} "
                f"line_length={len(finding.get('Line') or '')} "
                f"secret_full={secret_matches_full} secret_first_half={secret_matches_first_half} "
                f"match_full={match_matches_full} match_first_half={match_matches_first_half}"
            )
    return diagnostics



def main() -> int:
    parser = argparse.ArgumentParser(description="Validate pinned Gitleaks allowlist integrity.")
    parser.add_argument("--config", default=".gitleaks.toml")
    parser.add_argument("--report", default=None, help="Optional redacted Gitleaks JSON report for predicate diagnostics.")
    args = parser.parse_args()
    config_path = pathlib.Path(args.config).resolve()
    try:
        with config_path.open("rb") as handle:
            config = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print(f"Configuration load failed: {type(exc).__name__}")
        return 2
    errors = validate_config(config, pathlib.Path.cwd())
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: both synthetic HMAC allowlists are pinned to verified exact source lines.")
    if args.report:
        try:
            with pathlib.Path(args.report).open("r", encoding="utf-8") as handle:
                report = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Report load failed: {type(exc).__name__}")
            return 2
        for diagnostic in diagnose_report(report, config):
            print(diagnostic)
    return 0


if __name__ == "__main__":
    sys.exit(main())
