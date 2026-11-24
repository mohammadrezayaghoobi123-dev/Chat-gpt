from __future__ import annotations

import argparse
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
    entries = {
        entry.get("description"): entry
        for entry in config.get("allowlists", [])
        if entry.get("description") in EXPECTED_FIXTURES
    }
    if set(entries) != set(EXPECTED_FIXTURES):
        return ["expected exactly two pinned synthetic HMAC fixture allowlists"]

    for description, (expected_commit, expected_path) in EXPECTED_FIXTURES.items():
        entry = entries[description]
        label = description.split(" from ", 1)[0]
        if entry.get("targetRules") != ["generic-api-key"]:
            errors.append(f"{label}: targetRules must remain exactly generic-api-key")
        if entry.get("condition") != "AND":
            errors.append(f"{label}: condition must remain AND")
        if entry.get("commits") != [expected_commit]:
            errors.append(f"{label}: commit scope changed")
        if entry.get("paths") != [f"^{re.escape(expected_path)}$"]:
            errors.append(f"{label}: path scope changed or is not anchored")
        if entry.get("regexTarget") != "line":
            errors.append(f"{label}: regexTarget must be line")

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
        if not pattern.fullmatch(line):
            errors.append(f"{label}: regex does not match the exact historical fixture line")
        key = match.group(1)
        replacement = "1" if key[0] != "1" else "2"
        mutated_line = replacement + line[line.index(key) + 1:]
        if pattern.fullmatch(mutated_line):
            errors.append(f"{label}: regex also matches a mutated fixture and is not literal-scoped")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate pinned Gitleaks allowlist integrity.")
    parser.add_argument("--config", default=".gitleaks.toml")
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
