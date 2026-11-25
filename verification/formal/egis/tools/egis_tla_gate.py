#!/usr/bin/env python3
"""Fail-closed EGIS formal verification gate.

The gate requires a clean Git checkout at an expected commit and a SHA-256-pinned
TLA+ tools jar. It never downloads tools. It records source/tool/input digests
and atomically writes JSON evidence. It verifies formal-model artifacts only;
it does not establish implementation conformance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import stat
import tempfile
import time
from datetime import datetime, timezone
from typing import Sequence

from egis_tlc_output_validator import invariants_from_config, validate_tlc_output


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stat_identity(value) -> dict:
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    identity = {name.removeprefix("st_"): getattr(value, name, None) for name in fields}
    if any(not isinstance(identity[key], int) or isinstance(identity[key], bool)
           for key in identity):
        raise ValueError("input_identity_unavailable")
    if identity["device"] < 0 or identity["inode"] <= 0 or identity["size"] < 0:
        raise ValueError("input_identity_unavailable")
    return identity


def _same_identity(left: dict, right: dict) -> bool:
    return left == right


def _snapshot_file(path: Path, role: str, canonical_path: str) -> dict:
    """Hash one descriptor and reject persistent metadata/path changes during read."""
    try:
        pre = path.stat()
    except FileNotFoundError:
        return {"status": "BLOCKED", "reason": "input_missing", "role": role}
    except OSError as exc:
        return {"status": "BLOCKED", "reason": "input_io_unavailable", "role": role,
                "error_type": type(exc).__name__, "errno": exc.errno}

    if not stat.S_ISREG(pre.st_mode):
        return {"status": "BLOCKED", "reason": "input_not_regular", "role": role}

    try:
        pre_identity = _stat_identity(pre)
    except ValueError:
        return {"status": "BLOCKED", "reason": "input_identity_unavailable", "role": role}

    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            descriptor_before = _stat_identity(os.fstat(stream.fileno()))
            if not _same_identity(pre_identity, descriptor_before):
                return {"status": "FAIL", "reason": "input_changed_during_read", "role": role}
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            descriptor_after = _stat_identity(os.fstat(stream.fileno()))
    except FileNotFoundError:
        return {"status": "BLOCKED", "reason": "input_missing", "role": role}
    except (OSError, ValueError) as exc:
        return {"status": "BLOCKED",
                "reason": "input_identity_unavailable" if isinstance(exc, ValueError)
                          else "input_io_unavailable",
                "role": role, "error_type": type(exc).__name__,
                "errno": getattr(exc, "errno", None)}

    try:
        post = _stat_identity(path.stat())
    except FileNotFoundError:
        return {"status": "FAIL", "reason": "input_changed_during_read", "role": role}
    except OSError as exc:
        return {"status": "BLOCKED", "reason": "input_io_unavailable", "role": role,
                "error_type": type(exc).__name__, "errno": exc.errno}
    if not (_same_identity(pre_identity, descriptor_after)
            and _same_identity(pre_identity, post)):
        return {"status": "FAIL", "reason": "input_changed_during_read", "role": role}

    return {
        "status": "PASS",
        "snapshot": {
            "canonical_path": canonical_path,
            "sha256": digest.hexdigest(),
            "identity": descriptor_after,
        },
    }


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                   delete=False) as tmp:
        json.dump(payload, tmp, indent=2, sort_keys=True)
        tmp.write("\n")
        temp_path = Path(tmp.name)
    temp_path.replace(path)


def _decode_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _rooted_path(root: Path, value: Path) -> Path:
    candidate = value if value.is_absolute() else root / value
    return candidate.resolve()


_PROCESS_CLEANUP_TIMEOUT = 5.0


def _safe_process_diagnostic(reason: str, error: OSError | subprocess.TimeoutExpired | None,
                             process_cleanup: str) -> str:
    error_type = type(error).__name__ if error is not None else "none"
    error_errno = getattr(error, "errno", None) if error is not None else None
    if not isinstance(error_errno, int) or isinstance(error_errno, bool):
        error_errno = "none"
    return (
        f"{reason} error_type={error_type} errno={error_errno} "
        f"process_cleanup={process_cleanup}"
    )[:256]


def _kill_and_reap(process: subprocess.Popen[bytes]) -> str:
    """Kill/reap the child and close parent-owned output pipes within one deadline."""
    deadline = time.monotonic() + _PROCESS_CLEANUP_TIMEOUT
    try:
        process.kill()
    except ProcessLookupError:
        pass
    except OSError:
        # Reaping below determines whether the child is actually gone.
        pass

    reaped = False
    remaining = max(0.0, deadline - time.monotonic())
    try:
        process.wait(timeout=remaining)
        reaped = True
    except (subprocess.TimeoutExpired, OSError):
        pass

    pipes_closed = True
    for stream in (process.stdout, process.stderr):
        if stream is None:
            continue
        try:
            stream.close()
        except OSError:
            pipes_closed = False
            continue
        if getattr(stream, "closed", True) is False:
            pipes_closed = False

    return "REAPED" if reaped and pipes_closed else "UNKNOWN"


def _command_result(command: Sequence[str], *, status: str, exit_code: int | None,
                    stdout: str, stderr: str, reason: str | None,
                    phase: str | None, error: BaseException | None,
                    process_started: bool, process_outcome: str,
                    process_cleanup: str) -> dict:
    error_type = type(error).__name__ if error is not None else None
    error_errno = getattr(error, "errno", None) if error is not None else None
    if not isinstance(error_errno, int) or isinstance(error_errno, bool):
        error_errno = None
    return {
        "status": status,
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "command": list(command),
        "reason": reason,
        "phase": phase,
        "error_type": error_type,
        "errno": error_errno,
        "process_started": process_started,
        "process_outcome": process_outcome,
        "process_cleanup": process_cleanup,
    }


def run_command(command: Sequence[str], cwd: Path, timeout: int) -> dict:
    try:
        process = subprocess.Popen(
            list(command),
            cwd=cwd,
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        cleanup = "NOT_STARTED"
        return _command_result(
            command, status="BLOCKED", exit_code=None, stdout="",
            stderr=_safe_process_diagnostic("process_executable_missing", exc, cleanup),
            reason="process_executable_missing", phase="spawn", error=exc,
            process_started=False, process_outcome="NOT_STARTED",
            process_cleanup=cleanup,
        )
    except OSError as exc:
        cleanup = "NOT_STARTED"
        return _command_result(
            command, status="BLOCKED", exit_code=None, stdout="",
            stderr=_safe_process_diagnostic("process_start_unavailable", exc, cleanup),
            reason="process_start_unavailable", phase="spawn", error=exc,
            process_started=False, process_outcome="NOT_STARTED",
            process_cleanup=cleanup,
        )

    try:
        stdout_bytes, stderr_bytes = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        cleanup = _kill_and_reap(process)
        stdout = _decode_output(exc.stdout)
        stderr = _decode_output(exc.stderr) or _safe_process_diagnostic(
            "process_timed_out", exc, cleanup
        )
        return _command_result(
            command, status="FAIL", exit_code=None, stdout=stdout,
            stderr=stderr, reason="process_timed_out", phase="communicate",
            error=exc, process_started=True, process_outcome="TIMED_OUT",
            process_cleanup=cleanup,
        )
    except OSError as exc:
        cleanup = _kill_and_reap(process)
        return _command_result(
            command, status="BLOCKED", exit_code=None, stdout="",
            stderr=_safe_process_diagnostic("process_result_unavailable", exc, cleanup),
            reason="process_result_unavailable", phase="communicate", error=exc,
            process_started=True, process_outcome="UNKNOWN",
            process_cleanup=cleanup,
        )

    exit_code = process.returncode
    stdout = _decode_output(stdout_bytes)
    stderr = _decode_output(stderr_bytes)
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        cleanup = _kill_and_reap(process)
        return _command_result(
            command, status="BLOCKED", exit_code=None, stdout=stdout,
            stderr=_safe_process_diagnostic(
                "process_result_unavailable", None, cleanup
            ), reason="process_result_unavailable", phase="communicate",
            error=None, process_started=True, process_outcome="UNKNOWN",
            process_cleanup=cleanup,
        )

    if exit_code == 0:
        return _command_result(
            command, status="PASS", exit_code=exit_code, stdout=stdout,
            stderr=stderr, reason=None, phase=None, error=None,
            process_started=True, process_outcome="EXIT_ZERO",
            process_cleanup="REAPED",
        )
    return _command_result(
        command, status="FAIL", exit_code=exit_code, stdout=stdout,
        stderr=stderr, reason="process_nonzero_exit", phase=None, error=None,
        process_started=True, process_outcome="EXIT_NONZERO",
        process_cleanup="REAPED",
    )


def _command_evidence(command_result: dict) -> dict:
    """Retain lifecycle/status metadata without copying command output."""
    fields = (
        "status", "exit_code", "reason", "phase", "error_type", "errno",
        "process_started", "process_outcome", "process_cleanup", "command",
    )
    return {field: command_result.get(field) for field in fields}


def _command_completed_successfully(command_result: dict) -> bool:
    return (
        command_result.get("status") == "PASS"
        and command_result.get("exit_code") == 0
        and command_result.get("process_started") is True
        and command_result.get("process_outcome") == "EXIT_ZERO"
        and command_result.get("process_cleanup") == "REAPED"
    )


def _not_started_command_result(command: Sequence[str], reason: str) -> dict:
    return _command_result(
        command, status="BLOCKED", exit_code=None, stdout="", stderr="",
        reason=reason, phase=None, error=None, process_started=False,
        process_outcome="NOT_STARTED", process_cleanup="NOT_STARTED",
    )


def git_identity(root: Path) -> dict:
    rev_parse_command = ["git", "rev-parse", "HEAD"]
    status_command = ["git", "status", "--porcelain"]
    commit = run_command(rev_parse_command, root, 10)
    commands = {"rev_parse": _command_evidence(commit)}

    if not _command_completed_successfully(commit):
        commands["status"] = {
            "status": "NOT_RUN",
            "exit_code": None,
            "reason": "rev_parse_not_passed",
            "phase": None,
            "error_type": None,
            "errno": None,
            "process_started": False,
            "process_outcome": "NOT_STARTED",
            "process_cleanup": "NOT_STARTED",
            "command": status_command,
        }
        return {
            "status": "BLOCKED",
            "reason": "git_metadata_unavailable",
            "commit": None,
            "dirty": None,
            "commands": commands,
        }

    dirty = run_command(status_command, root, 10)
    commands["status"] = _command_evidence(dirty)
    if not _command_completed_successfully(dirty):
        return {
            "status": "BLOCKED",
            "reason": "git_metadata_unavailable",
            "commit": commit["stdout"].strip(),
            "dirty": None,
            "commands": commands,
        }

    is_dirty = bool(dirty["stdout"].strip())
    return {
        "status": "FAIL" if is_dirty else "PASS",
        "reason": "dirty_checkout" if is_dirty else None,
        "commit": commit["stdout"].strip(),
        "dirty": is_dirty,
        "commands": commands,
    }


def run_gate(root: Path, jar: Path, expected_sha256: str,
             expected_commit: str, module: Path, config: Path,
             output: Path, timeout: int = 300) -> dict:
    evidence = {
        "schema_version": "1.3",
        "gate": "EGIS-TLA-VERIFICATION-GATE",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "scope": {
            "expected_commit": expected_commit,
            "module": str(module),
            "module_sha256": None,
            "config": str(config),
            "config_sha256": None,
            "tool_jar": str(jar),
            "tool_sha256_expected": expected_sha256.lower(),
            "tool_sha256_actual": None,
            "input_snapshots": {},
        },
        "checks": {},
        "overall": "NOT_RUN",
    }

    try:
        root = Path(root).resolve(strict=True)
        root_stat = root.stat()
        if not stat.S_ISDIR(root_stat.st_mode):
            raise NotADirectoryError("repository_root_not_directory")
    except FileNotFoundError as exc:
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "repository_root_missing",
            "error_type": type(exc).__name__, "errno": exc.errno,
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence
    except OSError as exc:
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "repository_root_unavailable",
            "error_type": type(exc).__name__, "errno": exc.errno,
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    output = _rooted_path(root, output)
    try:
        module_canonical = module.resolve(strict=True)
        config_canonical = config.resolve(strict=True)
        jar_canonical = jar.resolve(strict=True)
    except FileNotFoundError as exc:
        missing_role = ("module" if not module.exists() else
                       "config" if not config.exists() else "tool_jar")
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "input_missing", "role": missing_role,
            "error_type": type(exc).__name__, "errno": exc.errno,
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence
    except OSError as exc:
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "input_io_unavailable",
            "error_type": type(exc).__name__, "errno": exc.errno,
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    try:
        module_canonical.relative_to(root)
        config_canonical.relative_to(root)
    except ValueError:
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "repository_input_path_escape",
            "role": "module" if not module_canonical.is_relative_to(root) else "config",
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    role_paths = {
        "module": (module, str(module_canonical)),
        "config": (config, str(config_canonical)),
        "tool_jar": (jar, str(jar_canonical)),
    }
    snapshots = {}
    for role, (path, canonical) in role_paths.items():
        result = _snapshot_file(path, role, canonical)
        if result["status"] != "PASS":
            evidence["checks"]["inputs"] = {
                key: value for key, value in result.items() if key != "snapshot"
            }
            evidence["overall"] = result["status"]
            atomic_write_json(output, evidence)
            return evidence
        snapshots[role] = result["snapshot"]

    evidence["scope"]["input_snapshots"] = snapshots
    evidence["scope"]["module_sha256"] = snapshots["module"]["sha256"]
    evidence["scope"]["config_sha256"] = snapshots["config"]["sha256"]
    evidence["scope"]["tool_sha256_actual"] = snapshots["tool_jar"]["sha256"]
    evidence["checks"]["inputs"] = {"status": "PASS", "reason": None}

    actual_sha = snapshots["tool_jar"]["sha256"]
    if len(expected_sha256) != 64 or actual_sha.lower() != expected_sha256.lower():
        evidence["checks"]["tool_integrity"] = {
            "status": "FAIL", "reason": "sha256_pin_missing_or_mismatch"
        }
        evidence["overall"] = "FAIL"
        atomic_write_json(output, evidence)
        return evidence

    identity = git_identity(root)
    evidence["checks"]["source_identity"] = identity
    if identity["status"] != "PASS" or identity["commit"] != expected_commit:
        if identity["status"] == "FAIL":
            source_status = "FAIL"
            source_reason = "dirty_checkout"
        elif identity["status"] != "PASS":
            source_status = "BLOCKED"
            source_reason = "git_metadata_unavailable"
        else:
            source_status = "FAIL"
            source_reason = "expected_commit_mismatch"
        evidence["checks"]["source_identity"]["status"] = source_status
        evidence["checks"]["source_identity"]["reason"] = source_reason
        evidence["overall"] = source_status
        atomic_write_json(output, evidence)
        return evidence

    evidence["checks"]["tool_integrity"] = {"status": "PASS"}
    java = os.environ.get("JAVA", "java")
    sany_cmd = [java, "-cp", str(jar_canonical), "tla2sany.SANY", str(module_canonical)]
    tlc_cmd = [
        java, "-cp", str(jar_canonical), "tlc2.TLC",
        "-config", str(config_canonical), "-workers", "1", "-deadlock",
        str(module_canonical),
    ]

    sany = run_command(sany_cmd, root, timeout)
    evidence["checks"]["sany"] = sany
    if not _command_completed_successfully(sany):
        evidence["checks"]["tlc"] = _not_started_command_result(
            tlc_cmd, "SANY_not_passed"
        )
        evidence["overall"] = "FAIL" if sany.get("status") == "FAIL" else "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    tlc = run_command(tlc_cmd, root, timeout)
    evidence["checks"]["tlc"] = tlc
    if not _command_completed_successfully(tlc):
        if tlc.get("status") == "FAIL":
            evidence["checks"]["tlc_output_validation"] = {
                "status": "NOT_RUN", "reason": "tlc_execution_failed"
            }
            evidence["overall"] = "FAIL"
        elif (tlc.get("status") == "BLOCKED"
              and tlc.get("process_outcome") == "NOT_STARTED"):
            evidence["checks"]["tlc_output_validation"] = {
                "status": "BLOCKED", "reason": "tlc_not_started"
            }
            evidence["overall"] = "BLOCKED"
        else:
            evidence["checks"]["tlc_output_validation"] = {
                "status": "NOT_RUN", "reason": "tlc_result_unavailable"
            }
            evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    expected_invariants = invariants_from_config(config_canonical.read_text(encoding="utf-8"))
    evidence["checks"]["tlc_output_validation"] = validate_tlc_output(
        tlc.get("stdout", "") + "\n" + tlc.get("stderr", ""),
        expected_invariants,
        tlc.get("exit_code"),
        timed_out=False,
    )

    validation_status = evidence["checks"]["tlc_output_validation"]["status"]
    if validation_status == "PASS":
        evidence["overall"] = "PASS"
    elif validation_status == "FAIL":
        evidence["overall"] = "FAIL"
    else:
        evidence["overall"] = "BLOCKED"

    atomic_write_json(output, evidence)
    return evidence


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--jar", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args(argv)
    result = run_gate(args.root, args.jar, args.sha256, args.expected_commit,
                      args.module, args.config, args.output, args.timeout)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["overall"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
