import json
import tempfile
import unittest
from pathlib import Path

from master_brain.audit_store import AuditStore, AuditStoreError


class AuditStoreTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.path = Path(self.tempdir.name) / "audit" / "events.jsonl"
        # store-mechanics tests use ad hoc event types; production stores default to strict
        self.store = AuditStore(self.path, strict_event_types=False)

    def append(self, event_id, payload=None):
        return self.store.append(
            event_id=event_id,
            event_type="claim.reviewed",
            recorded_at="2026-10-11T12:00:00Z",
            actor="unit-test",
            subject_ref="claim:c-1",
            payload=payload or {"status": "contested"},
        )

    def test_append_and_reload_persist_chain(self):
        first = self.append("e-1")
        second = self.append("e-2", {"status": "provisionally_supported"})
        loaded = self.store.read_all()
        self.assertEqual([event.event_id for event in loaded], ["e-1", "e-2"])
        self.assertEqual(loaded[0].event_hash, first.event_hash)
        self.assertEqual(loaded[1].previous_hash, first.event_hash)
        self.assertEqual(loaded[1].event_hash, second.event_hash)

    def test_tail_truncation_is_detected(self):
        for i in range(3):
            self.append(f"e-{i}")
        lines = self.path.read_text(encoding="utf-8").splitlines(True)
        self.path.write_text("".join(lines[:1]), encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "truncated"):
            self.store.read_all()
        with self.assertRaises(AuditStoreError):
            self.append("e-new")

    def test_full_truncation_to_empty_is_detected(self):
        self.append("e-1")
        self.path.write_text("", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "truncated"):
            self.store.read_all()

    def test_replacing_tail_event_is_detected_by_anchor(self):
        self.append("e-1")
        self.append("e-2")
        other = AuditStore(Path(self.tempdir.name) / "other.jsonl", strict_event_types=False)
        other.append(event_id="e-1", event_type="claim.reviewed", recorded_at="2026-10-11T12:00:00Z",
                     actor="unit-test", subject_ref="claim:c-1", payload={"status": "contested"})
        other.append(event_id="e-2", event_type="claim.reviewed", recorded_at="2026-10-11T12:00:00Z",
                     actor="unit-test", subject_ref="claim:c-1", payload={"status": "other"})
        self.path.write_text(other.path.read_text(encoding="utf-8"), encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "anchor"):
            self.store.read_all()

    def test_corrupt_anchor_fails_closed(self):
        self.append("e-1")
        for bad in ("not json", '{"count": true, "head_hash": "x"}', '{"count": -1, "head_hash": "x"}'):
            with self.subTest(bad=bad):
                self.store.anchor_path.write_text(bad, encoding="utf-8")
                with self.assertRaisesRegex(AuditStoreError, "anchor"):
                    self.store.read_all()

    def test_anchor_one_behind_after_crash_is_accepted_and_healed(self):
        self.append("e-1")
        saved = self.store.anchor_path.read_text(encoding="utf-8")
        self.append("e-2")
        self.store.anchor_path.write_text(saved, encoding="utf-8")  # crash before anchor update
        self.assertEqual(len(self.store.read_all()), 2)
        self.append("e-3")
        self.assertEqual(len(self.store.read_all()), 3)

    def test_legacy_log_without_anchor_is_accepted_then_anchored(self):
        self.append("e-1")
        self.store.anchor_path.unlink()
        self.assertEqual(len(self.store.read_all()), 1)
        self.append("e-2")
        self.assertTrue(self.store.anchor_path.exists())

    def test_unterminated_final_record_fails_closed_and_blocks_append(self):
        """Finding AUD-03: a valid last row missing its newline made the next append
        report success while concatenating two rows into an unreadable line."""
        self.append("e-1")
        self.path.write_bytes(self.path.read_bytes().rstrip(b"\n"))
        self.store.anchor_path.unlink()  # isolate from the head anchor
        with self.assertRaisesRegex(AuditStoreError, "unterminated"):
            self.store.read_all()
        before = self.path.read_bytes()
        with self.assertRaises(AuditStoreError):
            self.append("e-2")
        self.assertEqual(self.path.read_bytes(), before)  # nothing written

    def test_partial_json_final_record_fails_closed(self):
        self.append("e-1")
        with self.path.open("ab") as handle:
            handle.write(b'{"event_id": "e-2", "event_ty')
        with self.assertRaises(AuditStoreError):
            self.store.read_all()
        with self.assertRaises(AuditStoreError):
            self.append("e-3")

    def test_backdated_event_is_rejected(self):
        """Finding C5: a 2020 timestamp was accepted after a 2026 one."""
        self.store.append(event_id="t-1", event_type="x", recorded_at="2026-10-12T00:00:05Z",
                          actor="a", subject_ref="s", payload={})
        for bad in ("2020-01-01T00:00:00Z", "2026-10-12T00:00:04Z", "2026-10-12T05:00:00+05:30"):
            with self.subTest(bad=bad), self.assertRaisesRegex(AuditStoreError, "precedes"):
                self.store.append(event_id=f"b-{bad}", event_type="x", recorded_at=bad,
                                  actor="a", subject_ref="s", payload={})
        self.assertEqual(len(self.store.read_all()), 1)

    def test_equal_and_later_and_offset_equivalent_timestamps_are_accepted(self):
        self.store.append(event_id="t-1", event_type="x", recorded_at="2026-10-12T00:00:05Z",
                          actor="a", subject_ref="s", payload={})
        for i, ok in enumerate(("2026-10-12T00:00:05Z", "2026-10-12T05:30:05+05:30", "2026-10-12T00:00:06Z")):
            self.store.append(event_id=f"ok-{i}", event_type="x", recorded_at=ok,
                              actor="a", subject_ref="s", payload={})
        self.assertEqual(len(self.store.read_all()), 4)

    def test_missing_store_is_empty(self):
        self.assertEqual(self.store.read_all(), ())

    def test_duplicate_event_id_is_rejected(self):
        self.append("e-1")
        with self.assertRaisesRegex(AuditStoreError, "duplicate event_id"):
            self.append("e-1")

    def test_payload_tampering_fails_closed(self):
        self.append("e-1")
        rows = self.path.read_text(encoding="utf-8").splitlines()
        raw = json.loads(rows[0])
        raw["payload"]["status"] = "rewritten"
        self.path.write_text(json.dumps(raw) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            self.store.read_all()
        with self.assertRaises(AuditStoreError):
            self.append("e-2")

    def test_malformed_trailing_record_is_not_silently_repaired(self):
        self.append("e-1")
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write("{broken\n")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_non_object_json_record_fails_closed(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text('["not", "an", "event"]\n', encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_record_with_wrong_field_types_fails_closed(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps({
                "event_id": 7,
                "event_type": "claim.reviewed",
                "recorded_at": "2026-10-11T12:00:00Z",
                "actor": "unit-test",
                "subject_ref": "claim:c-1",
                "payload": {"status": "contested"},
                "previous_hash": "0" * 64,
                "event_hash": "0" * 64,
            }) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record"):
            self.store.read_all()

    def test_blank_lines_are_rejected(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("\n", encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "blank audit record"):
            self.store.read_all()

    def _append_one(self, store, index):
        store.append(
            event_id=f"concurrent-{index}", event_type="unit_test",
            recorded_at="2026-10-14T00:00:00Z", actor="unit-test",
            subject_ref="claim:c-1", payload={"i": index},
        )

    def test_concurrent_threads_cannot_fork_the_hash_chain(self):
        # Regression for finding AUD (unserialized read-modify-append): before
        # the lock, 8 barrier-synchronized writers corrupted the chain 5/5 runs.
        import threading
        workers = 8
        barrier = threading.Barrier(workers)
        errors = []

        def run(index):
            barrier.wait()
            try:
                self._append_one(self.store, index)
            except Exception as exc:  # pragma: no cover - failure path
                errors.append(exc)

        threads = [threading.Thread(target=run, args=(i,)) for i in range(workers)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(self.store.read_all()), workers)  # also verifies chain

    def test_concurrent_processes_cannot_fork_the_hash_chain(self):
        import subprocess
        import sys
        code = (
            "import sys; from master_brain.audit_store import AuditStore; "
            "AuditStore(sys.argv[1], strict_event_types=False).append(event_id=sys.argv[2], event_type='unit_test', "
            "recorded_at='2026-10-14T00:00:00Z', actor='p', subject_ref='s', payload={})"
        )
        env = {**__import__("os").environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
        procs = [
            subprocess.Popen([sys.executable, "-c", code, str(self.path), f"proc-{i}"], env=env)
            for i in range(6)
        ]
        self.assertEqual([p.wait() for p in procs], [0] * 6)
        self.assertEqual(len(self.store.read_all()), 6)

    def test_precondition_rejection_appends_nothing_and_sees_verified_history(self):
        from master_brain.audit_store import AuditPreconditionError
        self._append_one(self.store, 0)
        seen = []
        with self.assertRaises(AuditPreconditionError):
            self.store.append(
                event_id="blocked", event_type="unit_test", recorded_at="2026-10-14T00:00:00Z",
                actor="a", subject_ref="s", payload={},
                precondition=lambda history: seen.append(len(history)) or "nope",
            )
        self.assertEqual(seen, [1])
        self.assertEqual(len(self.store.read_all()), 1)


class AuditStoreMutationHardeningTests(unittest.TestCase):
    """Pins behaviour found unguarded by mutation testing (C2, AUD-03, C5, lock, I/O errors)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "a" / "b" / "c" / "events.jsonl"  # nested: parents must be created
        self.store = AuditStore(self.path, strict_event_types=False)
        self.n = 0

    def append(self, at="2026-10-12T00:00:00Z", payload=None, **kw):
        self.n += 1
        args = dict(event_id=f"e-{self.n}", event_type="unit.test", recorded_at=at,
                    actor="a", subject_ref="s", payload=payload or {})
        args.update(kw)
        return self.store.append(**args)

    def raw_lines(self):
        return self.path.read_text(encoding="utf-8").splitlines(True)

    # --- decoding / line numbers -------------------------------------------------
    def test_decode_errors_report_the_failing_line_number(self):
        self.append()
        good = self.raw_lines()[0]
        cases = {
            "invalid audit record at line 2": good + "{not json\n",
            "blank audit record at line 2": good + "\n",
            "unterminated audit record at line 2": good + good.rstrip("\n"),
        }
        for message, content in cases.items():
            with self.subTest(message=message):
                self.path.write_text(content, encoding="utf-8")
                self.store.anchor_path.unlink(missing_ok=True)
                with self.assertRaisesRegex(AuditStoreError, message):
                    self.store.read_all()

    def test_structurally_bad_records_become_store_errors(self):
        import json as _json
        self.append()
        good = _json.loads(self.raw_lines()[0])
        missing = {k: v for k, v in good.items() if k != "event_id"}
        bad_time = {**good, "recorded_at": "garbage"}
        for label, content in (("missing key", missing), ("bad timestamp value", bad_time),
                               ("non-object", ["x"]), ("scalar", 5)):
            with self.subTest(label=label):
                self.path.write_text(_json.dumps(content) + "\n", encoding="utf-8")
                self.store.anchor_path.unlink(missing_ok=True)
                with self.assertRaisesRegex(AuditStoreError, "invalid audit record at line 1"):
                    self.store.read_all()

    def test_invalid_utf8_is_a_store_error(self):
        self.append()
        self.path.write_bytes(b"\xff\xfe\xfa\n")
        self.store.anchor_path.unlink(missing_ok=True)
        with self.assertRaisesRegex(AuditStoreError, "UTF-8"):
            self.store.read_all()

    # --- head anchor -------------------------------------------------------------
    def test_anchor_content_is_canonical_and_tracks_each_append(self):
        import json as _json
        first = self.append()
        self.assertEqual(self.store.anchor_path.read_text(encoding="utf-8"),
                         '{"count":1,"head_hash":"%s"}' % first.event_hash)
        second = self.append()
        self.assertEqual(_json.loads(self.store.anchor_path.read_text(encoding="utf-8")),
                         {"count": 2, "head_hash": second.event_hash})
        self.assertFalse(self.store.anchor_path.with_name(self.store.anchor_path.name + ".tmp").exists())

    def test_anchor_failure_modes_fail_closed(self):
        from master_brain.audit_ledger import GENESIS_HASH
        self.append()
        anchor = self.store.anchor_path
        anchor.write_text("{}", encoding="utf-8")  # KeyError path
        with self.assertRaisesRegex(AuditStoreError, "unreadable"):
            self.store.read_all()
        anchor.write_text('{"count": 0, "head_hash": "%s"}' % GENESIS_HASH, encoding="utf-8")
        self.assertEqual(len(self.store.read_all()), 1)  # count 0 is a valid (stale) anchor
        anchor.write_text('{"count": 1, "head_hash": 5}', encoding="utf-8")
        with self.assertRaisesRegex(AuditStoreError, "unreadable"):
            self.store.read_all()
        anchor.unlink()
        anchor.mkdir()  # OSError on read
        with self.assertRaisesRegex(AuditStoreError, "unreadable"):
            self.store.read_all()

    def test_anchor_write_failure_is_reported(self):
        from unittest import mock
        with mock.patch("master_brain.audit_store.os.replace", side_effect=OSError("boom")):
            with self.assertRaisesRegex(AuditStoreError, "head anchor"):
                self.append()

    # --- append I/O and lock failures -------------------------------------------
    def test_event_write_failures_are_reported_not_swallowed(self):
        from unittest import mock
        for exc in (OSError("disk"), ValueError("closed")):
            with self.subTest(exc=type(exc).__name__):
                with mock.patch("master_brain.audit_store.os.fsync", side_effect=exc):
                    with self.assertRaisesRegex(AuditStoreError, "failed to append"):
                        self.append()

    def test_lock_failures_are_store_errors(self):
        from unittest import mock
        self.append()
        lock = self.path.with_name(self.path.name + ".lock")
        lock.unlink()
        lock.mkdir()  # cannot be opened as a file
        with self.assertRaisesRegex(AuditStoreError, "lock"):
            self.append()
        lock.rmdir()
        with mock.patch("fcntl.flock", side_effect=OSError("nolock")):
            with self.assertRaisesRegex(AuditStoreError, "acquire audit store lock"):
                self.append()

    # --- serialisation -----------------------------------------------------------
    def test_rows_are_canonical_utf8_json(self):
        import json as _json
        self.append(payload={"name": "café ✓", "b": 1, "a": 2})
        line = self.raw_lines()[0]
        self.assertIn("café ✓", line)  # ensure_ascii=False
        record = _json.loads(line)
        self.assertEqual(line, _json.dumps(record, sort_keys=True, separators=(",", ":"),
                                           ensure_ascii=False) + "\n")

    def test_non_finite_numbers_never_reach_the_file(self):
        with self.assertRaises(ValueError):
            self.append(payload={"x": float("nan")})
        self.assertFalse(self.path.exists() and self.path.read_text(encoding="utf-8"))

    # --- backdating (C5) ---------------------------------------------------------
    def test_backdating_is_checked_against_the_last_event_not_the_first(self):
        self.append(at="2026-10-12T00:00:00Z")
        self.append(at="2026-10-12T00:10:00Z")
        with self.assertRaisesRegex(AuditStoreError, r"precedes the last event \(2026-10-12T00:10:00Z\)"):
            self.append(at="2026-10-12T00:05:00Z")  # after the first, before the last

    def test_malformed_timestamps_are_value_errors_not_ordering_errors(self):
        self.append()
        for bad in ("garbage", "2026-10-12T00:00:00", "", None, 5):
            with self.subTest(bad=bad):
                with self.assertRaises((ValueError, TypeError)) as ctx:
                    self.append(at=bad)
                self.assertNotIsInstance(ctx.exception, AuditStoreError)
        self.assertEqual(len(self.store.read_all()), 1)
        with self.assertRaisesRegex(ValueError, "ISO-8601"):
            self.append(at="garbage")


if __name__ == "__main__":
    unittest.main()
