#!/usr/bin/env python3
"""Fail-closed EGIS formal verification gate.

This gate reports tool execution status, not implementation conformance.
It never downloads tools and requires a caller-supplied SHA-256 pin for the TLA+
tool jar. Results are written atomically as JSON evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from typing import Sequence

STATUS = {"PASS", "FAIL", "NOT_RUN", "BLOCKED"}


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


def run_command(command: Sequence[str], cwd: Path, timeout: int) -> dict:
    try:
        completed = subprocess.run(
            list(command), cwd=cwd, text=True, capture_output=True,
            timeout=timeout, check=False, env=os.environ.copy(),
        )
    except FileNotFoundError as exc:
        return {"status": "BLOCKED", "exit_code": None,
                "stdout": "", "stderr": str(exc), "command": list(command)}
    except subprocess.TimeoutExpired as exc:
        return {"status": "FAIL", "exit_code": None,
                "stdout": exc.stdout or "", "stderr": exc.stderr or "timeout",
                "command": list(command)}
    return {
        "status": "PASS" if completed.returncode == 0 else "FAIL",
        "exit_code": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "command": list(command),
    }


def run_gate(root: Path, jar: Path, expected_sha256: str,
             module: Path, config: Path, output: Path,
             timeout: int = 300) -> dict:
    root = root.resolve()
    jar = jar.resolve()
    module = module.resolve()
    config = config.resolve()
    evidence = {
        "schema_version": "1.0",
        "gate": "EGIS-TLA-VERIFICATION-GATE",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "scope": {
            "module": str(module),
            "config": str(config),
            "tool_jar": str(jar),
            "tool_sha256_expected": expected_sha256.lower(),
        },
        "checks": {},
        "overall": "NOT_RUN",
    }

    required = [module, config]
    if not all(path.is_file() for path in required):
        missing = [str(path) for path in required if not path.is_file()]
        evidence["checks"]["inputs"] = {
            "status": "BLOCKED", "reason": "missing_input_files", "missing": missing
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    if not jar.is_file():
        evidence["checks"]["tool"] = {
            "status": "BLOCKED", "reason": "tool_jar_missing"
        }
        evidence["overall"] = "BLOCKED"
        atomic_write_json(output, evidence)
        return evidence

    actual_sha = sha256_file(jar)
    evidence["scope"]["tool_sha256_actual"] = actual_sha
    if not expected_sha256 or actual_sha.lower() != expected_sha256.lower():
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

    statuses = [evidence["checks"]["tool_integrity"]["status"],
                evidence["checks"]["sany"]["status"],
                evidence["checks"]["tlc"]["status"]]
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
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args(argv)
    result = run_gate(args.root, args.jar, args.sha256, args.module,
                      args.config, args.output, args.timeout)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["overall"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
