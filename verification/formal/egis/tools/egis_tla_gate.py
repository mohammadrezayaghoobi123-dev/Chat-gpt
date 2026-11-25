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
    deadline = time.monotonic() + _PROCESS_CLEANUP_TIMEOUT
    try:
        process.kill()
    except ProcessLookupError:
        pass
    except OSError:
        # Reaping below determines whether the child is actually gone.
        pass

    remaining = max(0.0, deadline - time.monotonic())
    try:
        process.wait(timeout=remaining)
    except (subprocess.TimeoutExpired, OSError):
        return "UNKNOWN"
    return "REAPED"


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


def git_identity(root: Path) -> dict:
    commit = run_command(["git", "rev-parse", "HEAD"], root, 10)
    dirty = run_command(["git", "status", "--porcelain"], root, 10)
    if commit["status"] != "PASS" or dirty["status"] != "PASS":
        return {"status": "BLOCKED", "reason": "git_metadata_unavailable",
                "commit": None, "dirty": None}
    return {
        "status": "PASS" if not dirty["stdout"].strip() else "FAIL",
        "commit": commit["stdout"].strip(),
        "dirty": bool(dirty["stdout"].strip()),
    }


def run_gate(root: Path, jar: Path, expected_sha256: str,
             expected_commit: str, module: Path, config: Path,
             output: Path, timeout: int = 300) -> dict:
    root = root.resolve()
    jar = _rooted_path(root, jar)
    module = _rooted_path(root, module)
    config = _rooted_path(root, config)
    output = _rooted_path(root, output)
    evidence = {
        "schema_version": "1.2",
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
        },
        "checks": {},
        "overall": "NOT_RUN",
    }

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
        evidence["overall"] = evidence["checks"]["source_identity"]["status"]
        atomic_write_json(output, evidence)
        return evidence

    required = [module, config]
    if not all(path.is_file() for path in required):
        missing = [str(path) for path in required if not path.is_file()]
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "missing_input_files", "missing": missing
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    evidence["scope"]["module_sha256"] = sha256_file(module)
    evidence["scope"]["config_sha256"] = sha256_file(config)
    if not jar.is_file():
        evidence["checks"]["tool"] = {
            "status": "BLOCKED", "reason": "tool_jar_missing"
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    actual_sha = sha256_file(jar)
    evidence["scope"]["tool_sha256_actual"] = actual_sha
    if len(expected_sha256) != 64 or actual_sha.lower() != expected_sha256.lower():
        evidence["checks"]["tool_integrity"] = {
            "status": "FAIL", "reason": "sha256_pin_missing_or_mismatch"
        }
        evidence["overall"] = "FAIL"
        atomic_write_json(output, evidence)
        return evidence

    evidence["checks"]["tool_integrity"] = {"status": "PASS"}
    java = os.environ.get("JAVA", "java")
    sany_cmd = [java, "-cp", str(jar), "tla2sany.SANY", str(module)]
    sany = run_command(sany_cmd, root, timeout)
    evidence["checks"]["sany"] = sany

    if sany["status"] != "PASS":
        evidence["checks"]["tlc"] = {
            "status": "BLOCKED", "reason": "SANY_not_passed"
        }
        evidence["overall"] = sany["status"]
        atomic_write_json(output, evidence)
        return evidence

    tlc_cmd = [
        java, "-cp", str(jar), "tlc2.TLC",
        "-config", str(config), "-workers", "1", "-deadlock",
        str(module),
    ]
    tlc = run_command(tlc_cmd, root, timeout)
    evidence["checks"]["tlc"] = tlc
    expected_invariants = invariants_from_config(config.read_text(encoding="utf-8"))
    evidence["checks"]["tlc_output_validation"] = validate_tlc_output(
        tlc.get("stdout", "") + "\n" + tlc.get("stderr", ""),
        expected_invariants,
        tlc.get("exit_code"),
        timed_out=(tlc.get("exit_code") is None and tlc.get("status") == "FAIL"),
    )

    statuses = [evidence["checks"]["source_identity"]["status"],
                evidence["checks"]["tool_integrity"]["status"],
                evidence["checks"]["sany"]["status"],
                evidence["checks"]["tlc"]["status"],
                evidence["checks"]["tlc_output_validation"]["status"]]
    evidence["overall"] = "PASS" if all(s == "PASS" for s in statuses) else (
        "BLOCKED" if "BLOCKED" in statuses else "FAIL"
    )
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
