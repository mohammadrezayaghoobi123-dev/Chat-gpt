"""R5-1 follow-up: the account security log gets the same missing-anchor protection as the mission audit log
(suffix truncation + deleted ``.head`` or a backup that forgot the ``.head`` file must not be accepted silently
by the service). Library/CLI default stays lenient so an operator can still inspect and adopt a legacy log."""
import tempfile
import unittest
from pathlib import Path

from master_brain import audit_recovery as AR
from master_brain import serve
from master_brain.accounts import AccountStore
from master_brain.audit_store import AuditStoreError
from master_brain.security_log import SecurityLog

PW = "correct horse battery staple 1"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.db = self.dir / "accounts.sqlite"
        self.log = self.dir / "accounts.security.jsonl"
        self.head = Path(str(self.log) + ".head")

    def seed(self, n=2):
        store = AccountStore(self.db)
        for i in range(n):
            store.create_account(f"user:u{i}", PW, ("operator",), actor="operator:me")
        self.assertTrue(self.head.exists())
        return store


class SecurityLogAnchor(Base):
    def test_default_accepts_a_legacy_log_without_anchor(self):
        self.seed()
        self.head.unlink()
        self.assertGreaterEqual(len(SecurityLog(self.log).read_all()), 2)

    def test_strict_refuses_a_non_empty_log_without_anchor(self):
        self.seed()
        self.head.unlink()
        with self.assertRaisesRegex(AuditStoreError, "anchor is missing"):
            SecurityLog(self.log, require_anchor=True).read_all()

    def test_truncated_suffix_with_deleted_anchor_is_refused_when_strict(self):
        self.seed(4)
        lines = self.log.read_bytes().splitlines(keepends=True)
        self.log.write_bytes(b"".join(lines[:2]))
        self.head.unlink()
        self.assertEqual(len(SecurityLog(self.log).read_all()), 2)             # old behaviour: silent
        with self.assertRaisesRegex(AuditStoreError, "anchor is missing"):
            SecurityLog(self.log, require_anchor=True).read_all()

    def test_strict_security_log_does_not_append_without_anchor(self):
        self.seed()
        self.head.unlink()
        before = self.log.read_bytes()
        with self.assertRaises(Exception):
            AccountStore(self.db, require_anchor=True).create_account("user:x", PW, ("operator",), actor="operator:me")
        self.assertEqual(self.log.read_bytes(), before)

    def test_strict_accepts_empty_and_anchored_logs(self):
        AccountStore(self.db, require_anchor=True)                              # fresh: no log yet
        self.seed()
        self.assertGreaterEqual(len(SecurityLog(self.log, require_anchor=True).read_all()), 2)


class AdoptAndStartup(Base):
    def test_start_up_check_refuses_a_missing_anchor_and_names_the_remedy(self):
        self.seed()
        self.head.unlink()
        with self.assertRaises(serve.StartupRefused) as ctx:
            serve._verify_log(self.log, "security log", require_anchor=True)
        self.assertIn("--adopt-anchor", str(ctx.exception))

    def test_preflight_refuses_the_whole_service_then_adoption_unblocks_it(self):
        self.seed()
        self.head.unlink()
        with self.assertRaises(serve.StartupRefused):
            serve.preflight(self.dir)
        rep = AR.adopt_anchor(self.log, actor="operator:me", apply=True)
        self.assertEqual(rep.status, "adopted")
        self.assertTrue(self.head.exists())
        self.assertIn(AR.ADOPTED_EVENT_TYPE, [e.event_type for e in SecurityLog(self.log, require_anchor=True).read_all()])
        serve.preflight(self.dir)                                               # now starts

    def test_a_fresh_data_directory_still_starts(self):
        fresh = self.dir / "fresh"
        serve.preflight(fresh)


if __name__ == "__main__":
    unittest.main()
