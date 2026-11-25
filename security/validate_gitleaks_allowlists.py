from __future__ import annotations

import argparse
from collections.abc import Mapping
import copy
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
EXPECTED_LINE_EXCEPTIONS = {
    "Historical Owner command idempotency fixture line 397 (167b6764).": ("167b676479f855a92d63b2aca575b8798128c143", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 397),
    "Historical Owner command idempotency fixture line 516 (a5f3a65d).": ("a5f3a65dbe8e41d09c5d23131beca4eb73342fb2", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
    "Historical Owner command idempotency fixture line 516 (93214555).": ("93214555f5aa752a670c1c7c9a6d5f7b58f41cdf", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
    "Historical Owner command idempotency fixture line 397 (5a750037).": ("5a750037bc1bec098184b7890f66b407582b94d8", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 397),
    "Historical Owner command idempotency fixture line 516 (5a750037).": ("5a750037bc1bec098184b7890f66b407582b94d8", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
    "Historical Owner command idempotency fixture line 516 (b12a3e06).": ("b12a3e068c8cba44039cf478f174814fc1d8f6b5", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 516),
    "Synthetic Router previous-marker key in historical rotation test line 1805 (ab525a63).": ("ab525a63948822e195cc74f63c3a6b4340f705db", "tools/9router-review/review.test.mjs", 1805),
    "Public ICU signing metadata line 32 (3082b80f).": ("3082b80fbaf71685827ba63de882c3d93083b96f", "docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md", 32),
    "Public ICU signing metadata line 70 (3082b80f).": ("3082b80fbaf71685827ba63de882c3d93083b96f", "docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md", 70),
    "Historical Owner command idempotency fixture line 1904 (0222e99d).": ("0222e99d941ded0910ae4252f66b9dfb1dd39025", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 1904),
    "Historical Owner command idempotency fixture line 1260 (75ca4409).": ("75ca4409487e887279b45b66563c346015ce2342", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 1260),
    "Synthetic API_KEY placeholder comment line 1402 (04d76f8f).": ("04d76f8fd734eaf4053c86461e1204caf18d9c9c", "cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js", 1402),
    "Computed scheduler idempotency identifier line 277 (2729a325).": ("2729a325991c989cbab182967135aa76f864ac29", "cloud-engineering-connector/worker.js", 277),
}
EXPECTED_ALLOWLIST_COUNT = 30


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



def _source_line_at(repo_root: pathlib.Path, commit: str, path: str, line_number: int) -> str | None:
    result = subprocess.run(
        ["git", "show", f"{commit}:{path}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    lines = result.stdout.splitlines()
    if line_number < 1 or line_number > len(lines):
        return None
    return lines[line_number - 1]


def _escape_re2_literal(value: str) -> str:
    meta = set(r"\.^$|?*+()[]{}")
    return "".join("\\" + char if char in meta else char for char in value)
def validate_config(config: dict, repo_root: pathlib.Path) -> list[str]:
    errors: list[str] = []
    if not isinstance(config, Mapping):
        return ["configuration must be a TOML table"]
    allowlists = config.get("allowlists", [])
    if not isinstance(allowlists, list) or len(allowlists) != EXPECTED_ALLOWLIST_COUNT:
        errors.append("allowlist count changed; new exceptions require explicit review")
        return errors
    if any(not isinstance(entry, Mapping) for entry in allowlists):
        return ["allowlists entries must be TOML tables"]

    baseline_result = subprocess.run(
        ["git", "show", "origin/main:.gitleaks.toml"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if baseline_result.returncode != 0:
        errors.append("trusted origin/main Gitleaks baseline is unavailable")
        return errors
    try:
        baseline_config = tomllib.loads(baseline_result.stdout)
    except tomllib.TOMLDecodeError:
        errors.append("trusted origin/main Gitleaks baseline is invalid TOML")
        return errors
    if not isinstance(baseline_config, Mapping):
        errors.append("trusted origin/main Gitleaks baseline must be a TOML table")
        return errors
    baseline_allowlists = baseline_config.get("allowlists", [])
    if not isinstance(baseline_allowlists, list):
        errors.append("trusted origin/main allowlists must be an array")
        return errors
    if any(not isinstance(entry, Mapping) for entry in baseline_allowlists):
        errors.append("baseline allowlists entries must be TOML tables")
        return errors
    baseline_legacy = [
        entry for entry in baseline_allowlists
        if entry.get("description") not in EXPECTED_FIXTURES
    ]
    current_legacy = [
        entry for entry in allowlists
        if entry.get("description") not in EXPECTED_FIXTURES
        and entry.get("description") not in EXPECTED_LINE_EXCEPTIONS
    ]
    if len(baseline_legacy) != 15 or current_legacy != baseline_legacy:
        errors.append("legacy main allowlists changed; baseline exceptions are immutable in this change")
        return errors

    descriptions = [entry.get("description") for entry in allowlists]
    if len(set(descriptions)) != len(descriptions):
        errors.append("allowlist descriptions must be unique")
        return errors

    for index, entry in enumerate(allowlists, start=1):
        prefix = f"allowlist {index}"
        if not isinstance(entry.get("targetRules"), list) or not entry["targetRules"] or any(not isinstance(rule, str) or not rule for rule in entry["targetRules"]):
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
        elif any(_invalid_regex(pattern) for pattern in regexes):
            errors.append(f"{prefix}: regex pattern is invalid")

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
        expected_pattern = f"^{marker}$"
        if regexes[0] != expected_pattern:
            errors.append(f"{label}: regex must match only the exact decoded historical fixture secret")
        if not pattern.fullmatch(marker):
            errors.append(f"{label}: regex does not match the exact decoded Gitleaks fixture secret")
        replacement = "0" if marker[0] != "0" else "1"
        mutated_marker = replacement + marker[1:]
        if pattern.fullmatch(mutated_marker):
            errors.append(f"{label}: regex also matches a mutated decoded fixture and is not literal-scoped")
    line_entries = [
        entry for entry in allowlists
        if entry.get("description") in EXPECTED_LINE_EXCEPTIONS
    ]
    line_by_description = {entry.get("description"): entry for entry in line_entries}
    if len(line_entries) != len(EXPECTED_LINE_EXCEPTIONS) or set(line_by_description) != set(EXPECTED_LINE_EXCEPTIONS):
        errors.append("expected exactly 13 atomic historical line exceptions")
        return errors

    for description, (expected_commit, expected_path, line_number) in EXPECTED_LINE_EXCEPTIONS.items():
        entry = line_by_description[description]
        if entry.get("targetRules") != ["generic-api-key"]:
            errors.append(f"{description}: targetRules must remain exactly generic-api-key")
        if entry.get("condition") != "AND":
            errors.append(f"{description}: condition must remain AND")
        if entry.get("commits") != [expected_commit]:
            errors.append(f"{description}: exactly one pinned commit is required")
        escaped_path = expected_path.replace(".", r"\.")
        if entry.get("paths") != [f"^{escaped_path}$"]:
            errors.append(f"{description}: exact anchored path scope changed")
        if entry.get("regexTarget") != "line":
            errors.append(f"{description}: regexTarget must be line")
        regexes = entry.get("regexes")
        if not isinstance(regexes, list) or len(regexes) != 1 or not isinstance(regexes[0], str):
            errors.append(f"{description}: exactly one line regex is required")
            continue
        source_line = _source_line_at(repo_root, expected_commit, expected_path, line_number)
        if source_line is None:
            errors.append(f"{description}: pinned historical source line could not be verified")
            continue
        expected_pattern = r"^\s*" + _escape_re2_literal(source_line.lstrip()) + "$"
        if regexes[0] != expected_pattern:
            errors.append(f"{description}: regex must equal the exact pinned source line")
        try:
            pattern = re.compile(regexes[0])
        except re.error:
            errors.append(f"{description}: regex is invalid")
            continue
        if not pattern.fullmatch(source_line) or not pattern.fullmatch("\n" + source_line):
            errors.append(f"{description}: regex does not match the pinned source line")
        if pattern.fullmatch(source_line + "x"):
            errors.append(f"{description}: regex accepts a mutated source line")

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
            finding_secret = finding.get("Secret") or ""
            finding_match = finding.get("Match") or ""
            try:
                decoded_marker = bytes.fromhex(source_key).decode("ascii")
            except (ValueError, UnicodeDecodeError):
                decoded_marker = ""
            secret_matches_decoded = finding_secret == decoded_marker
            match_matches_decoded = finding_match == f'key = "{decoded_marker}"'
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
                f"secret_decoded={secret_matches_decoded} match_decoded={match_matches_decoded}"
            )
    return diagnostics




def build_necessity_config(config: dict) -> dict:
    """Remove only the 13 newly-added line exceptions for necessity testing."""
    if not isinstance(config, Mapping):
        raise ValueError("necessity config must be a TOML table")
    allowlists = config.get("allowlists", [])
    if not isinstance(allowlists, list):
        raise ValueError("necessity config allowlists must be an array")
    if any(not isinstance(entry, Mapping) for entry in allowlists):
        raise ValueError("allowlists entries must be TOML tables")
    reduced = copy.deepcopy(config)
    reduced_allowlists = reduced.get("allowlists", [])
    reduced["allowlists"] = [
        entry for entry in reduced_allowlists
        if entry.get("description") not in EXPECTED_LINE_EXCEPTIONS
    ]
    if len(reduced_allowlists) - len(reduced["allowlists"]) != 13:
        raise ValueError("necessity config must remove exactly 13 pinned line exceptions")
    if len(reduced["allowlists"]) != 17:
        raise ValueError("necessity config must retain 15 baseline entries and 2 synthetic fixtures")
    return reduced


def verify_necessity_report(report: list[dict]) -> list[str]:
    """Verify the redacted report contains exactly the 13 expected finding tuples."""
    from collections import Counter

    expected = Counter(
        (commit, path, line_number, "generic-api-key")
        for commit, path, line_number in EXPECTED_LINE_EXCEPTIONS.values()
    )
    observed = Counter()
    malformed = 0
    if not isinstance(report, list):
        return ["necessity report must be a JSON array"]
    for finding in report:
        if not isinstance(finding, dict):
            malformed += 1
            continue
        commit = finding.get("Commit")
        path = finding.get("File")
        line_number = finding.get("StartLine")
        rule = finding.get("RuleID")
        if (
            not isinstance(commit, str)
            or re.fullmatch(r"[0-9a-f]{40}", commit) is None
            or not isinstance(path, str)
            or not path
            or not isinstance(line_number, int)
            or isinstance(line_number, bool)
            or line_number < 1
            or not isinstance(rule, str)
            or not rule
        ):
            malformed += 1
            continue
        observed[(commit, path, line_number, rule)] += 1
    errors = []
    if malformed:
        errors.append(f"necessity report contains malformed finding records: {malformed}")
    missing = sum((expected - observed).values())
    extra = sum((observed - expected).values())
    duplicate = sum(count - 1 for count in observed.values() if count > 1)
    if duplicate:
        errors.append(f"necessity report contains duplicate finding tuples: {duplicate}")
    if missing:
        errors.append(f"necessity report is missing expected finding tuples: {missing}")
    if extra:
        errors.append(f"necessity report contains unexpected finding tuples: {extra}")
    if sum(observed.values()) + malformed != 13:
        errors.append(f"necessity report must contain exactly 13 records, observed {sum(observed.values()) + malformed}")
    return errors


def write_toml_config(config: dict, destination: pathlib.Path) -> None:
    """Serialize the restricted Gitleaks config using TOML-compatible JSON strings."""
    import json
    lines = []
    for key in ("title", "minVersion"):
        if key in config:
            lines.append(f"{key} = {json.dumps(config[key])}")
    extend = config.get("extend")
    if isinstance(extend, dict):
        lines.append("")
        lines.append("[extend]")
        for key, value in extend.items():
            lines.append(f"{key} = {json.dumps(value)}")
    for entry in config.get("allowlists", []):
        lines.append("")
        lines.append("[[allowlists]]")
        for key, value in entry.items():
            lines.append(f"{key} = {json.dumps(value)}")
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")




def main() -> int:
    parser = argparse.ArgumentParser(description="Validate pinned Gitleaks allowlist integrity.")
    parser.add_argument("--config", default=".gitleaks.toml")
    parser.add_argument("--report", default=None, help="Optional redacted Gitleaks JSON report for predicate diagnostics.")
    parser.add_argument("--necessity-config", default=None, help="Write a diagnostic config with exactly 13 new line exceptions removed.")
    parser.add_argument("--necessity-report", default=None, help="Verify the redacted report against the exact 13 expected findings.")
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
    print("PASS: synthetic fixture allowlists are pinned to verified exact source lines.")
    if args.necessity_config:
        try:
            reduced = build_necessity_config(config)
            write_toml_config(reduced, pathlib.Path(args.necessity_config))
        except (OSError, ValueError) as exc:
            print(f"Necessity config generation failed: {type(exc).__name__}")
            return 2
        print("PASS: diagnostic config preserves 15 baseline entries and 2 fixtures; removes exactly 13 new exceptions.")
    if args.necessity_report:
        try:
            with pathlib.Path(args.necessity_report).open("r", encoding="utf-8") as handle:
                necessity_report = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Necessity report load failed: {type(exc).__name__}")
            return 2
        necessity_errors = verify_necessity_report(necessity_report)
        if necessity_errors:
            for error in necessity_errors:
                print(f"FAIL: {error}")
            return 1
        print("PASS: redacted necessity report contains exactly the 13 expected finding tuples.")
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
