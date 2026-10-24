"""Start-up diagnostics: an approver who cannot actually approve must not be a silent failure."""
import os
import tempfile
import unittest
from pathlib import Path

from master_brain.accounts import AccountStore
from master_brain.serve import ServeConfig, build
from tests.test_serve import PW, good_key, keyfile


class Readiness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.data.mkdir(mode=0o700)
        os.chmod(self.data, 0o700)
        self.accounts = AccountStore(self.data / "accounts.sqlite")

    def account(self, subject, *roles, disabled=False):
        self.accounts.create_account(subject, PW, roles=roles, actor="operator:test")
        if disabled:
            self.accounts.set_disabled(subject, True)

    def warnings(self, keys=None):
        path = keyfile(Path(self.tmp.name) / "keys.json", keys) if keys is not None else None
        built = build(ServeConfig(self.data, port=0, approval_keys=path))
        self.addCleanup(built.close)
        return built.warnings

    def has(self, warnings, text):
        return any(text in w for w in warnings)

    def test_an_approver_without_any_key_is_called_out(self):
        self.account("user:boss", "approver")
        w = self.warnings([good_key("k-x", "user:someone-else")])
        self.assertTrue(self.has(w, "no approver has a signing key"), w)

    def test_a_single_ready_approver_is_flagged_as_a_single_point_of_failure(self):
        self.account("user:boss", "approver")
        w = self.warnings([good_key("k-boss", "user:boss")])
        self.assertTrue(self.has(w, "only one approver can approve"), w)
        self.assertFalse(self.has(w, "no approver has a signing key"), w)

    def test_two_ready_approvers_raise_no_readiness_warning(self):
        self.account("user:boss", "approver")
        self.account("user:deputy", "approver")
        w = self.warnings([good_key("k-boss", "user:boss"), good_key("k-dep", "user:deputy", "cd" * 32)])
        self.assertFalse(self.has(w, "only one approver"), w)
        self.assertFalse(self.has(w, "no approver has"), w)

    def test_an_approver_account_missing_a_key_is_named_even_when_another_is_ready(self):
        self.account("user:boss", "approver")
        self.account("user:deputy", "approver")
        w = self.warnings([good_key("k-boss", "user:boss")])
        self.assertTrue(self.has(w, "user:deputy"), w)
        self.assertTrue(self.has(w, "only one approver can approve"), w)

    def test_disabled_and_non_approver_accounts_do_not_count(self):
        self.account("user:boss", "approver")
        self.account("user:gone", "approver", disabled=True)
        self.account("user:plain")
        w = self.warnings([good_key("k-boss", "user:boss"), good_key("k-gone", "user:gone", "cd" * 32),
                           good_key("k-plain", "user:plain", "ef" * 32)])
        self.assertTrue(self.has(w, "only one approver can approve"), w)
        self.assertFalse(self.has(w, "user:gone"), w)
        self.assertFalse(self.has(w, "user:plain"), w)

    def test_no_key_file_keeps_the_existing_warning_only(self):
        self.account("user:boss", "approver")
        w = self.warnings(None)
        self.assertTrue(self.has(w, "no --approval-keys"), w)
        self.assertFalse(self.has(w, "only one approver"), w)

    def test_warnings_never_contain_key_material_and_long_lists_are_capped(self):
        for i in range(12):
            self.account(f"user:a{i:02d}", "approver")
        w = self.warnings([good_key("k-other", "user:other", "ab" * 32)])
        text = " ".join(w)
        self.assertNotIn("ab" * 32, text)
        self.assertTrue(self.has(w, "no approver has a signing key"), w)
        self.assertLess(text.count("user:a"), 8, text)  # named subjects are capped


class Runbook(unittest.TestCase):
    def test_the_runbook_named_in_the_warning_exists_and_uses_real_commands(self):
        root = Path(__file__).resolve().parent.parent
        text = (root / "docs" / "APPROVER_RECOVERY_RUNBOOK.md").read_text(encoding="utf-8")
        from master_brain.serve import approver_readiness_warnings
        import inspect
        self.assertIn("docs/APPROVER_RECOVERY_RUNBOOK.md", inspect.getsource(approver_readiness_warnings))
        for sub in ("passwd", "disable", "enable", "add"):  # subcommands the CLI really has
            self.assertIn(f" {sub} --subject", text)
        help_text = __import__("subprocess").run(
            [__import__("sys").executable, "-m", "master_brain.accounts", "--db", "x", "-h"],
            capture_output=True, text=True, env={**os.environ, "PYTHONPATH": "src:."}, cwd=root).stdout
        for sub in ("passwd", "disable", "enable", "add"):
            self.assertIn(sub, help_text)


if __name__ == "__main__":
    unittest.main()
