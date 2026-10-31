"""Stage 5 residual R5-1: a non-empty log whose head anchor is missing must not be accepted silently
(suffix truncation + deleted ``.head``, or a backup that forgot the ``.head`` file)."""
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from master_brain import audit_recovery as AR
from master_brain.audit_store import AuditStore, AuditStoreError, NOW


def fill(store, n, start=0):
    for i in range(start, start + n):
        store.append(event_id=f"e{i}", event_type="test.event", recorded_at=NOW, actor="w",
                     subject_ref="s", payload={"i": i})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "audit.jsonl"
        self.head = Path(str(self.path) + ".head")

    def store(self, **kw):
        return AuditStore(self.path, strict_event_types=False, **kw)


class RequireAnchor(Base):
    def test_default_store_keeps_accepting_a_legacy_log_without_anchor(self):
        fill(self.store(), 3)
        self.head.unlink()
        self.assertEqual(len(self.store().read_all()), 3)

    def test_strict_store_refuses_a_non_empty_log_without_anchor(self):
        fill(self.store(), 3)
        self.head.unlink()
        with self.assertRaisesRegex(AuditStoreError, "anchor is missing"):
            self.store(require_anchor=True).read_all()

    def test_truncated_suffix_with_deleted_anchor_is_refused_when_strict(self):
        fill(self.store(), 6)
        lines = self.path.read_bytes().splitlines(keepends=True)
        self.path.write_bytes(b"".join(lines[:3]))
        self.head.unlink()
        self.assertEqual(len(self.store().read_all()), 3)            # the old behaviour: silent
        with self.assertRaisesRegex(AuditStoreError, "anchor is missing"):
            self.store(require_anchor=True).read_all()

    def test_strict_store_refuses_to_append_without_anchor(self):
        fill(self.store(), 2)
        self.head.unlink()
        with self.assertRaisesRegex(AuditStoreError, "anchor is missing"):
            fill(self.store(require_anchor=True), 1, start=10)
        self.assertEqual(len(self.store().read_all()), 2)            # nothing was appended

    def test_strict_store_accepts_empty_and_anchored_logs(self):
        s = self.store(require_anchor=True)
        self.assertEqual(s.read_all(), ())
        fill(s, 2)
        self.assertEqual(len(self.store(require_anchor=True).read_all()), 2)

    def test_prefix_cache_mode_enforces_it_too(self):
        fill(self.store(), 3)
        self.head.unlink()
        with self.assertRaisesRegex(AuditStoreError, "anchor is missing"):
            self.store(require_anchor=True, full_verify_interval_seconds=60).read_all()


class AdoptAnchor(Base):
    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = AR._main(["--path", str(self.path), *args])
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_reports_and_changes_nothing(self):
        fill(self.store(), 3)
        self.head.unlink()
        before = self.path.read_bytes()
        report = AR.adopt_anchor(self.path, actor="operator:me")
        self.assertEqual((report.status, report.complete_events), ("anchor_missing", 3))
        self.assertFalse(self.head.exists())
        self.assertEqual(self.path.read_bytes(), before)

    def test_apply_writes_the_anchor_and_records_the_adoption_in_the_chain(self):
        fill(self.store(), 3)
        self.head.unlink()
        report = AR.adopt_anchor(self.path, actor="operator:me", apply=True)
        self.assertEqual(report.status, "adopted")
        events = self.store(require_anchor=True).read_all()      # now accepted by the strict store
        self.assertEqual([e.event_type for e in events][-1], "audit.anchor_adopted")
        self.assertEqual(len(events), 4)
        self.assertEqual(events[-1].payload["complete_events"], 3)

    def test_refuses_when_an_anchor_already_exists(self):
        fill(self.store(), 3)
        with self.assertRaises(AR.RecoveryRefused):
            AR.adopt_anchor(self.path, actor="operator:me", apply=True)

    def test_refuses_a_log_whose_chain_is_broken(self):
        fill(self.store(), 4)
        self.head.unlink()
        data = bytearray(self.path.read_bytes())
        data[150] ^= 1
        self.path.write_bytes(bytes(data))
        before = self.path.read_bytes()
        with self.assertRaises(AR.RecoveryRefused):
            AR.adopt_anchor(self.path, actor="operator:me", apply=True)
        self.assertEqual(self.path.read_bytes(), before)

    def test_cli_flag(self):
        fill(self.store(), 2)
        self.head.unlink()
        code, out, _ = self.run_cli("--adopt-anchor")
        self.assertEqual(code, 0)
        self.assertIn("run again with --apply", out)
        code, out, _ = self.run_cli("--adopt-anchor", "--apply")
        self.assertEqual(code, 0)
        self.assertIn("adopted", out)


class ServiceStartup(Base):
    def test_start_up_check_refuses_a_missing_anchor_for_the_mission_audit_log(self):
        from master_brain import serve
        fill(self.store(), 2)
        self.head.unlink()
        with self.assertRaises(serve.StartupRefused) as ctx:
            serve._verify_log(self.path, "mission audit log", require_anchor=True)
        self.assertIn("--adopt-anchor", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
