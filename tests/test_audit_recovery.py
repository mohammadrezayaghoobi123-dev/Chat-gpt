"""Gate 2d-1: crash recovery of a torn audit tail — explicit, operator-only, evidence-preserving."""
import hashlib
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path

from master_brain.api_contracts import CreateMissionRequest, ErrorCode
from master_brain.audit_recovery import RecoveryRefused, recover_torn_tail
from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.identity import Identity
from master_brain.mission_service import MissionService, ServiceError

ALICE = Identity("user:alice")
FRAGMENT = b'{"actor":"user:alice","event_hash":"abc'


def mission(service, key):
    return service.create_mission(ALICE, CreateMissionRequest(
        idempotency_key=key, objective="x", success_criteria=("ok",), risk_tier="low")).view.mission_id


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "audit.jsonl"
        self.service = MissionService(AuditStore(self.path))
        self.m1, self.m2 = mission(self.service, "key-0000000001"), mission(self.service, "key-0000000002")
        self.good = self.path.read_bytes()

    def tear(self, fragment=FRAGMENT):
        with self.path.open("ab") as handle:
            handle.write(fragment)

    def recover(self, **kw):
        return recover_torn_tail(self.path, actor="operator:me", **kw)

    def fragments(self):
        return sorted(self.path.parent.glob(self.path.name + ".torn-*"))


class Recovery(Base):
    def test_a_torn_tail_stops_the_service_today_and_recovery_restores_it_without_losing_history(self):
        self.tear()
        with self.assertRaises(ServiceError) as ctx:
            self.service.get_mission(ALICE, self.m1)
        self.assertIs(ctx.exception.code, ErrorCode.UNAVAILABLE)
        report = self.recover(apply=True)
        self.assertEqual((report.status, report.complete_events, report.fragment_bytes),
                         ("recovered", 2, len(FRAGMENT)))
        self.assertEqual(self.service.get_mission(ALICE, self.m1).mission_id, self.m1)
        events = AuditStore(self.path).read_all()
        self.assertEqual([e.event_type for e in events],
                         ["mission.contract_registered"] * 2 + ["audit.tail_recovered"])
        self.assertTrue(self.path.read_bytes().startswith(self.good))  # history is byte-for-byte untouched
        self.assertEqual(mission(self.service, "key-0000000003")[:8], "mission-")  # and it can write again

    def test_the_discarded_bytes_are_preserved_and_described_in_the_chain(self):
        self.tear()
        report = self.recover(apply=True)
        (kept,) = self.fragments()
        self.assertEqual(kept.read_bytes(), FRAGMENT)
        self.assertEqual(report.fragment_file, kept)
        self.assertEqual(report.fragment_sha256, hashlib.sha256(FRAGMENT).hexdigest())
        event = AuditStore(self.path).read_all()[-1]
        self.assertEqual(event.event_id, "tail-recovered:" + hashlib.sha256(FRAGMENT).hexdigest()[:16])
        self.assertEqual(event.actor, "operator:me")
        self.assertEqual(dict(event.payload), {"discarded_bytes": len(FRAGMENT), "complete_events": 2,
                                               "fragment_sha256": hashlib.sha256(FRAGMENT).hexdigest()})

    def test_a_dry_run_changes_nothing(self):
        self.tear()
        before = self.path.read_bytes()
        report = self.recover()
        self.assertEqual((report.status, report.fragment_file), ("torn_tail_found", None))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.fragments(), [])

    def test_a_clean_log_has_nothing_to_recover_and_is_not_touched(self):
        report = self.recover(apply=True)
        self.assertEqual((report.status, report.complete_events), ("clean", 2))
        self.assertEqual(self.path.read_bytes(), self.good)

    def test_running_it_twice_recovers_only_once(self):
        self.tear()
        self.recover(apply=True)
        again = self.recover(apply=True)
        self.assertEqual(again.status, "clean")
        self.assertEqual(len(self.fragments()), 1)
        self.assertEqual(len(AuditStore(self.path).read_all()), 3)

    def test_a_complete_record_that_only_lacks_its_newline_is_still_treated_as_unacknowledged(self):
        import json
        last = self.good.splitlines()[-1]
        self.path.write_bytes(self.good[: -len(last) - 1] + last)  # crash before the newline reached the disk...
        events = [json.loads(line) for line in self.good.splitlines()]
        self.path.with_name(self.path.name + ".head").write_text(  # ...so the anchor (written after) still says 1
            json.dumps({"count": 1, "head_hash": events[0]["event_hash"]}, sort_keys=True, separators=(",", ":")))
        report = self.recover(apply=True)
        self.assertEqual((report.status, report.complete_events), ("recovered", 1))
        self.assertEqual(self.fragments()[0].read_bytes(), last)


class CrashWindows(Base):
    def test_a_crash_between_the_record_and_its_anchor_needs_no_recovery(self):
        import json
        events = [json.loads(line) for line in self.good.splitlines()]
        self.path.with_name(self.path.name + ".head").write_text(
            json.dumps({"count": 1, "head_hash": events[0]["event_hash"]}, sort_keys=True, separators=(",", ":")))
        self.assertEqual(len(AuditStore(self.path).read_all()), 2)  # the longer log is accepted
        self.assertEqual(self.recover(apply=True).status, "clean")
        mission(self.service, "key-0000000003")                      # and the next append re-anchors it
        self.assertEqual(len(AuditStore(self.path).read_all()), 3)

    def test_recovery_waits_for_the_writer_lock(self):
        import threading
        import time
        self.tear()
        store, order = AuditStore(self.path), []
        holding, release = threading.Event(), threading.Event()

        def hold():
            with store._exclusive_lock():
                holding.set()
                release.wait(5)
                order.append("released")

        holder = threading.Thread(target=hold)
        holder.start()
        holding.wait(5)
        worker = threading.Thread(target=lambda: (self.recover(apply=True), order.append("recovered")))
        worker.start()
        time.sleep(0.3)
        self.assertEqual(order, [])  # still blocked behind the other writer
        release.set()
        holder.join(5)
        worker.join(5)
        self.assertEqual(order, ["released", "recovered"])


class Refusals(Base):
    def test_a_damaged_log_without_a_torn_tail_is_refused_not_called_clean(self):
        self.path.write_bytes(self.good.replace(b"user:alice", b"user:mallory", 1))
        with self.assertRaisesRegex(RecoveryRefused, "no torn tail"):
            self.recover(apply=True)

    def test_an_evidence_file_that_cannot_even_be_created_is_a_clean_refusal(self):
        from unittest import mock
        self.tear()
        before = self.path.read_bytes()
        original = Path.open

        def deny(path, *args, **kwargs):
            if ".torn-" in path.name:
                raise PermissionError("denied")
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, "open", deny):
            with self.assertRaisesRegex(RecoveryRefused, "nothing was changed"):
                self.recover(apply=True)
        self.assertEqual(self.path.read_bytes(), before)

    def test_a_failure_to_preserve_the_bytes_changes_nothing_and_can_be_retried(self):
        from unittest import mock
        self.tear()
        before = self.path.read_bytes()
        with mock.patch("master_brain.audit_recovery.os.fsync", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(RecoveryRefused, "nothing was changed"):
                self.recover(apply=True)
        self.assertEqual((self.path.read_bytes(), self.fragments()), (before, []))
        self.assertEqual(self.recover(apply=True).status, "recovered")

    def assertRefused(self, **kw):
        before = self.path.read_bytes()
        anchor = self.path.with_name(self.path.name + ".head")
        anchor_before = anchor.read_bytes() if anchor.exists() else None
        with self.assertRaises(RecoveryRefused):
            self.recover(apply=True, **kw)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.fragments(), [])
        self.assertEqual(anchor.read_bytes() if anchor.exists() else None, anchor_before)

    def test_damage_before_the_tail_is_never_repaired(self):
        self.tear()
        self.path.write_bytes(self.path.read_bytes().replace(b"key-", b"kex-", 1).replace(b"user:alice", b"user:mallory", 1))
        self.assertRefused()

    def test_a_log_shorter_than_its_anchor_is_tampering_not_a_crash(self):
        first = self.good.splitlines(keepends=True)[0]
        self.path.write_bytes(first + FRAGMENT)  # one event was removed and a fragment appended
        self.assertRefused()

    def test_a_missing_newline_on_a_record_the_anchor_already_counts_is_not_a_crash(self):
        last = self.good.splitlines()[-1]
        self.path.write_bytes(self.good[: -len(last) - 1] + last)  # anchor still says 2: the newline was removed
        self.assertRefused()

    def test_an_oversized_tail_is_not_a_torn_record(self):
        self.tear(b"x" * (1024 * 1024 + 1))
        self.assertRefused()

    def test_an_existing_evidence_file_is_never_overwritten(self):
        self.tear()
        moment = datetime(2026, 10, 23, 1, 2, 3, tzinfo=timezone.utc)
        name = self.path.name + ".torn-20261023T010203Z-" + hashlib.sha256(FRAGMENT).hexdigest()[:12] + ".bin"
        (self.path.parent / name).write_bytes(b"precious")
        self.assertRefusedWith(clock=lambda: moment)
        self.assertEqual((self.path.parent / name).read_bytes(), b"precious")

    def assertRefusedWith(self, **kw):
        before = self.path.read_bytes()
        with self.assertRaises(RecoveryRefused):
            self.recover(apply=True, **kw)
        self.assertEqual(self.path.read_bytes(), before)

    def test_a_missing_log_is_refused(self):
        with self.assertRaises(RecoveryRefused):
            recover_torn_tail(self.path.with_name("none.jsonl"), actor="operator:me")


class OtherLogs(unittest.TestCase):
    def test_the_security_log_recovers_the_same_way(self):
        from master_brain.security_log import SecurityLog
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            log = SecurityLog(path)
            log.critical("security.logout", actor="user:a", subject_ref="account:user:a", payload={"address": "1.1.1.1"})
            with path.open("ab") as handle:
                handle.write(b'{"torn":')
            with self.assertRaises(AuditStoreError):
                SecurityLog(path).read_all()
            self.assertEqual(recover_torn_tail(path, actor="operator:me", apply=True).status, "recovered")
            self.assertEqual([e.event_type for e in SecurityLog(path).read_all()],
                             ["security.logout", "audit.tail_recovered"])


class Cli(Base):
    def run_cli(self, *argv):
        from master_brain import audit_recovery
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = audit_recovery._main(list(argv))
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_then_apply(self):
        self.tear()
        code, out, _ = self.run_cli("--path", str(self.path))
        self.assertEqual(code, 0)
        self.assertIn("torn tail", out)
        self.assertIn("--apply", out)
        self.assertEqual(self.fragments(), [])
        code, out, _ = self.run_cli("--path", str(self.path), "--apply")
        self.assertEqual(code, 0)
        self.assertIn("recovered", out)
        self.assertEqual(len(self.fragments()), 1)

    def test_clean_log_reports_nothing_to_do(self):
        code, out, _ = self.run_cli("--path", str(self.path))
        self.assertEqual((code, out.strip()), (0, "clean: 2 events, no torn tail"))

    def test_refusals_exit_nonzero_with_a_message(self):
        code, out, err = self.run_cli("--path", str(self.path.with_name("none.jsonl")))
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(err.startswith("refused:"))
        self.assertEqual(self.run_cli()[0], 2)  # --path is required


if __name__ == "__main__":
    unittest.main()
