import pathlib
import re
import subprocess
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CONFIG = ROOT / ".gitleaks.toml"
EXPECTED = {
    "Synthetic ephemeral HMAC test-key fixture from one historical identity test commit; restricted to that exact commit, file, and generic-api-key rule.": (
        "d5ffafb6df54e26189d8494548f7693fdcfdf108",
        "cloud-engineering-connector/test/orchestrator-worker-identity.test.js",
    ),
    "Synthetic ephemeral HMAC test-key fixture from one historical outbox publisher test commit; restricted to that exact commit, file, and generic-api-key rule.": (
        "a5c36d1c2e7461e38578a688133c797f541b4b46",
        "cloud-engineering-connector/test/orchestrator-outbox-publisher.test.js",
    ),
}


class GitleaksAllowlistIntegrityTests(unittest.TestCase):
    def test_synthetic_hmac_exceptions_are_exact_line_scoped(self):
        with CONFIG.open("rb") as handle:
            config = tomllib.load(handle)
        entries = {
            entry.get("description"): entry
            for entry in config.get("allowlists", [])
            if entry.get("description") in EXPECTED
        }
        self.assertEqual(set(entries), set(EXPECTED))

        for description, (commit, path) in EXPECTED.items():
            with self.subTest(description=description):
                entry = entries[description]
                self.assertEqual(entry.get("targetRules"), ["generic-api-key"])
                self.assertEqual(entry.get("condition"), "AND")
                self.assertEqual(entry.get("commits"), [commit])
                self.assertEqual(entry.get("paths"), [f"^{re.escape(path)}$"])
                self.assertEqual(entry.get("regexTarget"), "line")
                regexes = entry.get("regexes", [])
                self.assertEqual(len(regexes), 1)

                source = subprocess.run(
                    ["git", "show", f"{commit}:{path}"],
                    cwd=ROOT,
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
                key_lines = [
                    line for line in source.splitlines()
                    if re.fullmatch(r'const key = "[0-9a-f]{64}";', line)
                ]
                self.assertEqual(len(key_lines), 1)
                line = key_lines[0]
                key = re.search(r'"([0-9a-f]{64})"', line).group(1)
                self.assertEqual(bytes.fromhex(key).decode("ascii"), "0123456789abcdef" * 2)

                compiled = [re.compile(pattern) for pattern in regexes]
                self.assertEqual(sum(bool(pattern.fullmatch(line)) for pattern in compiled), 1)
                changed = ("1" if key[0] != "1" else "2") + line[line.index(key) + 1:]
                self.assertFalse(any(pattern.fullmatch(changed) for pattern in compiled))


if __name__ == "__main__":
    unittest.main()
