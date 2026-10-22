"""Crash recovery for a torn audit tail (Gate 2d-1, OPS-001, SAFE-002).

A process killed in the middle of ``AuditStore.append`` can leave a final line without its newline.
The store (correctly) refuses such a log, so the whole service stays unavailable. That is a crash
artifact, not tampering — but telling the two apart must never be left to the store itself, which
"never auto-repairs history". This tool is the explicit, operator-only way out:

* it acts ONLY when every complete record before the tail verifies (chain, and the head anchor — so a
  log that was truncated or edited is refused, never "repaired");
* the discarded bytes are never deleted: they are saved next to the log (``<log>.torn-<utc>-<sha>.bin``,
  created exclusively, so existing evidence is never overwritten);
* the recovery itself is recorded in the chain as ``audit.tail_recovered`` (who, how many bytes, digest);
* default is a dry run; ``--apply`` is required to change anything; it holds the writer lock throughout.

Why discarding the fragment is safe: ``append`` writes ``record + "\\n"`` and only then updates the anchor
and returns, so a record without its newline was never acknowledged to any caller.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from master_brain.audit_store import NOW, AuditStore, AuditStoreError

MAX_FRAGMENT_BYTES = 1024 * 1024  # one record is far smaller; more than this is not a torn append
RECOVERED_EVENT_TYPE = "audit.tail_recovered"


class RecoveryRefused(RuntimeError):
    """The log is not a plain torn-tail case; nothing was changed."""


@dataclass(frozen=True)
class RecoveryReport:
    status: str  # clean | torn_tail_found (dry run) | recovered
    complete_events: int
    fragment_bytes: int = 0
    fragment_sha256: str | None = None
    fragment_file: Path | None = None


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return  # not supported on every platform
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _verified_prefix_events(store: AuditStore, complete: bytes) -> int:
    """Number of events if ``complete`` (all lines terminated) verifies with the REAL rules, else refuse."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / store.path.name
        copy.write_bytes(complete)
        if store.anchor_path.exists():
            shutil.copyfile(store.anchor_path, copy.with_name(copy.name + ".head"))
        try:
            return len(AuditStore(copy, strict_event_types=store.strict_event_types).read_all())
        except AuditStoreError as exc:
            raise RecoveryRefused(f"the log is damaged before its tail; refusing to repair it ({exc})") from exc


def recover_torn_tail(path: str | os.PathLike[str], *, actor: str, apply: bool = False,
                      clock: Callable[[], datetime] | None = None) -> RecoveryReport:
    store = AuditStore(path, clock=clock)
    if not store.path.is_file():
        raise RecoveryRefused("no such log")
    with store._exclusive_lock():
        data = store.path.read_bytes()
        if not data or data.endswith(b"\n"):
            try:
                count = len(store.read_all())
            except AuditStoreError as exc:
                raise RecoveryRefused(f"the log is damaged but has no torn tail ({exc})") from exc
            return RecoveryReport("clean", count)
        cut = data.rfind(b"\n") + 1  # 0 when there is no complete record at all
        complete, fragment = data[:cut], data[cut:]
        if len(fragment) > MAX_FRAGMENT_BYTES:
            raise RecoveryRefused("the unterminated tail is too large to be one torn record")
        count = _verified_prefix_events(store, complete)
        digest = hashlib.sha256(fragment).hexdigest()
        if not apply:
            return RecoveryReport("torn_tail_found", count, len(fragment), digest)
        moment = store.now().astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        evidence = store.path.with_name(f"{store.path.name}.torn-{moment}-{digest[:12]}.bin")
        try:
            with evidence.open("xb") as handle:  # exclusive: never overwrite existing evidence
                handle.write(fragment)
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError as exc:
            raise RecoveryRefused("an evidence file with this name already exists; nothing was changed") from exc
        except OSError as exc:
            evidence.unlink(missing_ok=True)  # our own partial file: leaving it would block every retry
            raise RecoveryRefused(f"could not preserve the discarded bytes; nothing was changed ({exc})") from exc
        _fsync_dir(evidence.parent)
        with store.path.open("r+b") as handle:
            handle.truncate(len(complete))
            handle.flush()
            os.fsync(handle.fileno())
        store._append_locked(
            event_id=f"tail-recovered:{digest[:16]}", event_type=RECOVERED_EVENT_TYPE, recorded_at=NOW,
            actor=actor, subject_ref="log:audit",
            payload={"discarded_bytes": len(fragment), "complete_events": count, "fragment_sha256": digest})
        return RecoveryReport("recovered", count, len(fragment), digest, evidence)


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m master_brain.audit_recovery",
        description="Recover an audit/security log whose last record was torn by a crash (dry run by default).")
    parser.add_argument("--path", required=True, help="the JSONL log (mission audit or security log)")
    parser.add_argument("--apply", action="store_true", help="actually recover (otherwise only report)")
    args = parser.parse_args(argv)
    from master_brain.accounts import operator_actor
    try:
        report = recover_torn_tail(args.path, actor=operator_actor(), apply=args.apply)
    except RecoveryRefused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    if report.status == "clean":
        print(f"clean: {report.complete_events} events, no torn tail")
    elif report.status == "torn_tail_found":
        print(f"torn tail: {report.fragment_bytes} unterminated bytes after {report.complete_events} verified events "
              f"(sha256 {report.fragment_sha256}); run again with --apply to preserve them and recover")
    else:
        print(f"recovered: {report.complete_events} events kept; {report.fragment_bytes} bytes preserved in "
              f"{report.fragment_file}")
    return 0


if __name__ == "__main__":
    sys.exit(_main())

__all__ = ["MAX_FRAGMENT_BYTES", "RECOVERED_EVENT_TYPE", "RecoveryRefused", "RecoveryReport", "recover_torn_tail"]
