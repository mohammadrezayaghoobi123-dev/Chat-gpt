"""Gate 3f: verified-prefix cache for the hash-chained log (opt-in; the library default is unchanged)."""
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from master_brain.audit_store import AuditStore, AuditStoreError
import master_brain.audit_store as audit_store_module


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class CacheCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "a.jsonl"
        self.clock = Clock()

    def store(self, interval=300.0, **kw):
        return AuditStore(self.path, strict_event_types=False, full_verify_interval_seconds=interval,
                          monotonic=self.clock, **kw)

    def add(self, store, n, start=0):
        for i in range(start, start + n):
            store.append(event_id=f"e{i}", event_type="x", recorded_at="2026-10-12T00:00:00Z",
                         actor="a", subject_ref="s", payload={"i": i})

    def lines(self):
        return self.path.read_bytes().split(b"\n")[:-1]

    def rewrite_line(self, index, mutate):
        rows = self.lines()
        row = json.loads(rows[index])
        mutate(row)
        rows[index] = json.dumps(row, sort_keys=True, separators=(",", ":")).encode()
        self.path.write_bytes(b"\n".join(rows) + b"\n")


class Equivalence(CacheCase):
    def test_cached_and_uncached_stores_agree_across_appends(self):
        cached, plain = self.store(), AuditStore(self.path, strict_event_types=False)
        for step in range(6):
            self.add(cached, 3, start=step * 3)
            self.assertEqual(cached.read_all(), plain.read_all())
        self.assertEqual(len(cached.read_all()), 18)

    def test_another_writer_appending_is_seen_without_a_full_verify(self):
        a, b = self.store(), self.store()
        self.add(a, 2)
        a.read_all()
        self.add(b, 2, start=2)  # a second store (as another process would) appends
        self.assertEqual([e.event_id for e in a.read_all()], ["e0", "e1", "e2", "e3"])

    def test_between_full_verifications_only_the_new_tail_is_hashed(self):
        s = self.store()
        self.add(s, 50)
        s.read_all()
        seen = []
        real = audit_store_module.verify_chain
        with mock.patch.object(audit_store_module, "verify_chain",
                               side_effect=lambda ev, **k: seen.append(len(list(ev))) or real(ev, **k)):
            self.add(s, 2, start=50)
            s.read_all()
        self.assertTrue(seen and max(seen) <= 2, seen)  # never the 50-event prefix again

    def test_the_default_still_verifies_everything_every_time(self):
        plain = AuditStore(self.path, strict_event_types=False)
        self.add(plain, 20)
        seen = []
        real = audit_store_module.verify_chain
        with mock.patch.object(audit_store_module, "verify_chain",
                               side_effect=lambda ev, **k: seen.append(len(list(ev))) or real(ev, **k)):
            plain.read_all()
        self.assertEqual(seen, [20])

    def test_interval_must_be_a_positive_finite_number(self):
        for bad in (0, -1, float("inf"), float("nan"), True, "300"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.store(bad)


class TamperDetection(CacheCase):
    def test_old_byte_tampering_is_caught_at_the_next_full_verification_not_before(self):
        s = self.store()
        self.add(s, 5)
        s.read_all()
        self.rewrite_line(1, lambda r: r["payload"].update(i=9))  # same length, inside the verified prefix
        self.clock.t += 299
        s.read_all()  # documented weakening: not seen inside the interval
        self.clock.t += 2
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            s.read_all()

    def test_a_new_process_always_verifies_everything(self):
        self.add(self.store(), 5)
        self.rewrite_line(1, lambda r: r["payload"].update(i=999))
        with self.assertRaises(AuditStoreError):
            self.store().read_all()

    def test_a_tampered_tail_is_caught_immediately(self):
        s = self.store()
        self.add(s, 3)
        s.read_all()
        with self.path.open("ab") as f:  # an outside writer appends a record with a broken link
            row = json.loads(self.lines()[-1])
            row.update(event_id="evil", previous_hash="0" * 64)
            f.write(json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n")
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            s.read_all()

    def test_a_forged_hash_in_the_tail_is_caught(self):
        s = self.store()
        self.add(s, 3)
        s.read_all()
        last = json.loads(self.lines()[-1])
        forged = dict(last, event_id="forged", previous_hash=last["event_hash"], payload={"i": 7})
        with self.path.open("ab") as f:  # right link, hash not recomputed
            f.write(json.dumps(forged, sort_keys=True, separators=(",", ":")).encode() + b"\n")
        with self.assertRaisesRegex(AuditStoreError, "event_hash_mismatch"):
            s.read_all()

    def test_a_duplicate_id_between_prefix_and_tail_is_caught(self):
        s = self.store()
        self.add(s, 3)
        s.read_all()
        # a second writer re-uses e0 through a store that is not allowed to (simulate by raw append)
        other = self.store(None)
        try:
            other.append(event_id="e0", event_type="x", recorded_at="2026-10-12T00:00:01Z",
                         actor="a", subject_ref="s", payload={})
        except AuditStoreError:
            pass
        else:
            self.fail("the writer itself must refuse a duplicate id")
        # craft it by hand with a correct link and hash
        from master_brain.audit_ledger import create_event
        from dataclasses import asdict
        last = s.read_all()[-1]
        ev = create_event(event_id="e0", event_type="x", recorded_at="2026-10-12T00:00:02Z", actor="a",
                          subject_ref="s", payload={}, previous_hash=last.event_hash)
        with self.path.open("ab") as f:
            f.write(json.dumps(asdict(ev), sort_keys=True, separators=(",", ":")).encode() + b"\n")
        with self.assertRaisesRegex(AuditStoreError, "duplicate_event_id"):
            s.read_all()

    def test_unterminated_and_blank_tails_are_refused(self):
        for tail, text in ((b'{"half":', "unterminated"), (b"\n", "blank")):
            with self.subTest(text=text):
                self.path.unlink(missing_ok=True)
                Path(str(self.path) + ".head").unlink(missing_ok=True)
                s = self.store()
                self.add(s, 2)
                s.read_all()
                with self.path.open("ab") as f:
                    f.write(tail)
                with self.assertRaisesRegex(AuditStoreError, text):
                    s.read_all()

    def test_truncation_is_caught_by_the_anchor_and_a_bad_tail_does_not_poison_the_cache(self):
        s = self.store()
        self.add(s, 4)
        s.read_all()
        size = self.path.stat().st_size
        with self.path.open("ab") as f:
            f.write(b"garbage-without-newline")
        with self.assertRaises(AuditStoreError):
            s.read_all()
        with self.path.open("r+b") as f:  # remove the garbage: the cache must work again
            f.truncate(size)
        self.assertEqual(len(s.read_all()), 4)
        with self.path.open("r+b") as f:  # now truncate real events
            f.truncate(len(b"\n".join(self.lines()[:2])) + 1)
        with self.assertRaisesRegex(AuditStoreError, "truncated"):
            s.read_all()

    def test_replacing_the_file_forces_a_full_verification(self):
        s = self.store()
        self.add(s, 3)
        s.read_all()
        data = self.path.read_bytes()
        row = json.loads(data.split(b"\n")[0])
        row["payload"]["i"] = 123  # tamper with the verified prefix ...
        rest = data.split(b"\n")[1:]
        replacement = Path(self.tmp.name) / "new.jsonl"
        replacement.write_bytes(json.dumps(row, sort_keys=True, separators=(",", ":")).encode()
                                + b"\n" + b"\n".join(rest))
        os.replace(replacement, self.path)  # ... by swapping the file (new inode)
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            s.read_all()  # inside the interval, yet caught: identity changed

    def test_the_head_anchor_is_checked_on_every_read_even_inside_the_interval(self):
        s = self.store()
        self.add(s, 3)
        s.read_all()
        anchor = Path(str(self.path) + ".head")
        anchor.write_text(json.dumps({"count": 3, "head_hash": "f" * 64}))
        with self.assertRaisesRegex(AuditStoreError, "head anchor"):
            s.read_all()

    def test_a_failed_anchor_check_does_not_commit_the_tail(self):
        s = self.store()
        self.add(s, 2)
        s.read_all()
        anchor = Path(str(self.path) + ".head")
        good = anchor.read_text()
        self.add(self.store(None), 1, start=2)  # a legitimate append by another writer
        anchor.write_text(json.dumps({"count": 3, "head_hash": "e" * 64}))
        with self.assertRaises(AuditStoreError):
            s.read_all()
        anchor.write_text(json.dumps({"count": 3, "head_hash": json.loads(self.lines()[-1])["event_hash"]}))
        self.assertEqual(len(s.read_all()), 3)

    def test_a_missing_file_resets_the_cache(self):
        s = self.store()
        self.add(s, 2)
        s.read_all()
        self.path.unlink()
        Path(str(self.path) + ".head").unlink()
        self.assertEqual(s.read_all(), ())
        self.add(s, 1)
        self.assertEqual(len(s.read_all()), 1)


class Edges(CacheCase):
    def test_small_and_integer_intervals_are_accepted(self):
        self.store(0.5)
        self.store(300)

    def test_a_clock_that_runs_backwards_forces_a_full_verification(self):
        s = self.store()
        self.add(s, 4)
        s.read_all()
        self.rewrite_line(1, lambda r: r["payload"].update(i=9))
        self.clock.t -= 0.5  # never trust a cache whose age cannot be established
        with self.assertRaisesRegex(AuditStoreError, "verification failed"):
            s.read_all()

    def test_error_messages_name_the_real_line_numbers(self):
        s = self.store()
        self.add(s, 3)
        s.read_all()
        with self.path.open("ab") as f:
            f.write(b"not json\n")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record at line 4"):
            s.read_all()
        with self.path.open("r+b") as f:
            f.truncate(len(b"\n".join(self.lines()[:3])) + 1)
        with self.path.open("ab") as f:
            f.write(b"\n")
        with self.assertRaisesRegex(AuditStoreError, "blank audit record at line 4"):
            s.read_all()
        with self.path.open("r+b") as f:
            f.truncate(len(b"\n".join(self.lines()[:3])) + 1)
        with self.path.open("ab") as f:
            f.write(b"x\n\npartial")
        with self.assertRaisesRegex(AuditStoreError, "unterminated audit record at line 6"):
            s.read_all()

    def test_a_full_verification_names_the_real_line_number(self):
        self.add(self.store(), 3)
        with self.path.open("ab") as f:
            f.write(b"not json\n")
        with self.assertRaisesRegex(AuditStoreError, "invalid audit record at line 4"):
            self.store().read_all()

    def test_io_failures_become_audit_store_errors(self):
        s = self.store()
        self.add(s, 2)
        s.read_all()
        with mock.patch.object(Path, "exists", return_value=True), \
                mock.patch.object(audit_store_module.os, "stat", side_effect=OSError("boom")):
            with self.assertRaisesRegex(AuditStoreError, "unreadable"):
                s.read_all()
        real_open = Path.open

        def failing(self_, mode="r", *a, **k):
            if "b" in mode and self_.name == "a.jsonl":
                raise OSError("boom")
            return real_open(self_, mode, *a, **k)
        with mock.patch.object(Path, "open", failing):
            with self.assertRaisesRegex(AuditStoreError, "unreadable"):
                s.read_all()  # tail read
            self.clock.t += 400
            with self.assertRaisesRegex(AuditStoreError, "unreadable"):
                s.read_all()  # full read

    def test_invalid_utf8_in_the_tail_is_refused(self):
        s = self.store()
        self.add(s, 2)
        s.read_all()
        with self.path.open("ab") as f:
            f.write(b"\xff\xfe\n")
        with self.assertRaisesRegex(AuditStoreError, "UTF-8"):
            s.read_all()


class TornRead(CacheCase):
    """A reader must never observe an append that is still being written (regression found by CI)."""

    def torn_append(self, store, release):
        """Hold the append lock the way a writer does, and leave half a record on disk until released."""
        from master_brain.audit_ledger import create_event
        from dataclasses import asdict
        last = store.read_all()[-1]
        ev = create_event(event_id="late", event_type="x", recorded_at="2026-10-12T00:00:01Z", actor="a",
                          subject_ref="s", payload={}, previous_hash=last.event_hash)
        row = json.dumps(asdict(ev), sort_keys=True, separators=(",", ":")).encode() + b"\n"
        started = threading.Event()

        def writer():
            with store._exclusive_lock():
                with self.path.open("ab") as handle:
                    handle.write(row[: len(row) // 2])
                    handle.flush()
                    started.set()
                    release.wait(5)
                    handle.write(row[len(row) // 2:])
                    handle.flush()
                store._write_anchor(4, ev.event_hash)
        thread = threading.Thread(target=writer)
        thread.start()
        self.assertTrue(started.wait(5))
        return thread

    def check(self, interval):
        s = self.store(interval)
        self.add(s, 3)
        s.read_all()
        release = threading.Event()
        writer = self.torn_append(s, release)
        out = {}

        def reader():
            try:
                out["events"] = [e.event_id for e in s.read_all()]
            except Exception as exc:  # noqa: BLE001
                out["error"] = exc
        t = threading.Thread(target=reader)
        t.start()
        t.join(0.4)
        self.assertTrue(t.is_alive(), f"the reader did not wait for the writer: {out}")
        release.set()
        writer.join(5)
        t.join(5)
        self.assertEqual(out.get("error"), None)
        self.assertEqual(out["events"], ["e0", "e1", "e2", "late"])

    def test_a_cached_reader_waits_for_an_append_in_progress(self):
        self.check(300.0)

    def test_an_uncached_reader_waits_for_an_append_in_progress(self):
        self.check(None)


class Locking(CacheCase):
    def run_with_deadline(self, fn, seconds=5):
        out = {}

        def target():
            try:
                out["value"] = fn()
            except Exception as exc:  # noqa: BLE001
                out["error"] = exc
        t = threading.Thread(target=target, daemon=True)
        t.start()
        t.join(seconds)
        self.assertFalse(t.is_alive(), "deadlock")
        if "error" in out:
            raise out["error"]
        return out.get("value")

    def test_reading_while_holding_the_exclusive_lock_does_not_deadlock(self):
        for interval in (None, 300.0):
            with self.subTest(interval=interval):
                s = self.store(interval)
                self.add(s, 2, start=0 if interval is None else 10)

                def inside():
                    with s._exclusive_lock():
                        return len(s.read_all())
                self.assertGreaterEqual(self.run_with_deadline(inside), 2)

    def test_the_exclusive_lock_is_reentrant_in_one_thread_and_released_after(self):
        s, other = self.store(), self.store()
        self.add(s, 1)

        def depth():
            return list(audit_store_module._HELD.paths.values())[0]

        def nested():
            with s._exclusive_lock():
                self.assertEqual(depth(), 1)
                with s._exclusive_lock():
                    self.assertEqual(depth(), 2)
                    with other._exclusive_lock():  # another instance on the same file, same thread
                        self.assertEqual(depth(), 3)
                    self.assertEqual(depth(), 2)
                self.assertEqual(depth(), 1)
                self.assertGreaterEqual(len(s.read_all()), 1)  # still ours after an inner exit: no self-deadlock
                # still held here: a second thread must not get in
                got = []
                t = threading.Thread(target=lambda: (other._exclusive_lock().__enter__(), got.append(1)))
                t.daemon = True
                t.start()
                t.join(0.3)
                assert not got, "the lock was released too early"
        self.run_with_deadline(nested)
        self.assertEqual(depth(), 0)
        self.run_with_deadline(lambda: other._exclusive_lock().__enter__().__class__)  # free again

    def test_a_writer_waits_for_readers_and_readers_do_not_block_each_other(self):
        s = self.store(None)
        self.add(s, 1)
        gate = threading.Event()
        inside = []

        def slow_reader():
            with s._shared_lock():
                inside.append(1)
                gate.wait(5)
        r1 = threading.Thread(target=slow_reader, daemon=True)
        r1.start()
        while not inside:
            pass
        self.assertEqual(len(self.run_with_deadline(s.read_all)), 1)  # a second reader is not blocked
        done = threading.Event()
        w = threading.Thread(target=lambda: (self.add(s, 1, start=1), done.set()), daemon=True)
        w.start()
        self.assertFalse(done.wait(0.3), "the writer must wait while a reader holds the shared lock")
        gate.set()
        self.assertTrue(done.wait(5))

    def test_a_lock_file_that_cannot_be_opened_falls_back_to_an_unlocked_read(self):
        from unittest import mock
        s = self.store(None)
        self.add(s, 2)
        real_open = Path.open

        def failing(self_, mode="r", *a, **k):
            if self_.name.endswith(".lock"):
                raise PermissionError("read-only directory")
            return real_open(self_, mode, *a, **k)
        with mock.patch.object(Path, "open", failing):
            self.assertEqual(len(s.read_all()), 2)
            with self.assertRaisesRegex(AuditStoreError, "lock"):
                self.add(s, 1, start=2)  # a WRITER still fails closed

    def test_a_failed_lock_acquisition_is_refused_not_ignored(self):
        from unittest import mock
        import fcntl
        s = self.store(None)
        self.add(s, 1)
        with mock.patch.object(fcntl, "flock", side_effect=OSError("no locks")):
            with self.assertRaisesRegex(AuditStoreError, "acquire"):
                s.read_all()

    def test_a_missing_directory_reads_as_empty_without_creating_anything(self):
        ghost = AuditStore(Path(self.tmp.name) / "nodir" / "a.jsonl", strict_event_types=False)
        self.assertEqual(ghost.read_all(), ())
        self.assertFalse((Path(self.tmp.name) / "nodir").exists())


class Threads(CacheCase):
    def test_concurrent_readers_and_a_writer_never_see_a_broken_cache(self):
        import threading
        s = self.store()
        self.add(s, 5)
        errors = []

        def reader():
            try:
                for _ in range(60):
                    ids = [e.event_id for e in s.read_all()]
                    assert ids == [f"e{i}" for i in range(len(ids))], ids
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        def writer():
            try:
                self.add(s, 40, start=5)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        ts = [threading.Thread(target=reader) for _ in range(4)] + [threading.Thread(target=writer)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errors, [])
        self.assertEqual(len(s.read_all()), 45)


if __name__ == "__main__":
    unittest.main()
