"""Independent verifier for CTP runs: a SEPARATE process, with its own key, that re-runs the registered spec.

    python -m master_brain.ctp_verify --data-dir DATA --approval-keys keys.json \\
        --verifier-key verifier.key --request-id ctpreq-... [--passphrase-stdin]

Why a separate process: the web server (executor) never holds a verifier key. This process
1. re-validates the whole request -> approval -> claim -> execution chain from the audit log
   (signature against the trust store, matching digests, claim inside the approval window),
2. refuses unless the run is ``executed_unverified`` (or ``insufficient_runs``, to resume) and its key is bound to ``verifier:<id>``
   with an id different from the executor,
3. re-runs the same registered spec in the sandbox at least ``min_runs - 1`` times (default 4, so 5 agreeing
   executions in total) and signs what it observed each time (``ctp.test_verified``); one disagreement vetoes.

Limits (stated, not hidden): same host, so this is process- and key-isolation, not independent
hardware or an independent environment; several agreeing runs make nondeterminism unlikely, not impossible; whoever controls the
host controls both.
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

from master_brain.approval_keys import KeyToolError, load_signer
from master_brain.audit_store import AuditStore
from master_brain.ctp_operations import REQUEST_ID, audit_run_chain, derive_run_state
from master_brain.ctp_registry import builtin_registry
from master_brain.ctp_runner import RunnerError, SandboxUnavailable, verify_by_reruns
from master_brain.serve import StartupRefused, load_trust_store


class VerifyRefused(Exception):
    pass


def verify_request(data_dir: Path, approval_keys: Path, signer, request_id: str) -> dict:
    if not REQUEST_ID.match(request_id):
        raise VerifyRefused("request id is malformed")
    subject = getattr(signer, "subject", "")
    if not (isinstance(subject, str) and subject.startswith("verifier:") and len(subject) > len("verifier:")):
        raise VerifyRefused("the verifier key must be bound to a subject of the form verifier:<id>")
    verifier_id = subject[len("verifier:"):]
    trust = load_trust_store(approval_keys)
    store = AuditStore(Path(data_dir) / "audit.jsonl")
    problems = audit_run_chain(store, trust, request_id)
    if problems:
        raise VerifyRefused("the run's approval/claim/execution chain is not valid: " + "; ".join(problems))
    registry = builtin_registry()
    state = derive_run_state(store, trust, request_id, registry=registry)
    if state.status not in ("executed_unverified", "insufficient_runs") or state.test_state is None:
        raise VerifyRefused(f"nothing to verify: run status is {state.status}")
    ids = state.test_state.execution_ids
    req = next(e for e in store.read_all() if e.event_type == "ctp.run_requested"
               and e.subject_ref == f"ctp-run:{request_id}")
    test = registry.get(req.payload["test_id"])
    if test is None:
        raise VerifyRefused("the test is no longer registered")
    # The run's own original execution is the first one; its re-runs are the executions after it. A previous
    # verifier call that stopped early is resumed: only the missing agreeing re-runs are performed.
    original = ids[0]
    have = len({e.payload["rerun_execution_id"] for e in store.read_all()
                if e.event_type == "ctp.test_verified" and e.payload.get("original_execution_id") == original
                and e.payload.get("verdict") == "reproduced"})
    missing = max(1, test.min_runs - 1 - have)
    result = verify_by_reruns(
        store, test.spec, case_id=request_id, test_id=test.test_id, original_execution_id=original,
        verifier_id=verifier_id, signer=signer, runs=missing, evidence_dir=Path(data_dir) / "ctp-evidence")
    after = derive_run_state(store, trust, request_id, registry=registry)
    return {"request_id": request_id, "verdict": result.get("verdict"), "status": after.status,
            "final_ctp_status": after.final_ctp_status, "reason": after.reason}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m master_brain.ctp_verify", description=__doc__.split("\n")[0])
    ap.add_argument("--data-dir", required=True, type=Path)
    ap.add_argument("--approval-keys", required=True, type=Path)
    ap.add_argument("--verifier-key", required=True, type=Path)
    ap.add_argument("--request-id", required=True)
    ap.add_argument("--passphrase-stdin", action="store_true")
    args = ap.parse_args(argv)
    try:
        passphrase = sys.stdin.readline().rstrip("\n") if args.passphrase_stdin else getpass.getpass("Key passphrase: ")
        signer = load_signer(args.verifier_key, passphrase)
        out = verify_request(args.data_dir, args.approval_keys, signer, args.request_id)
    except (VerifyRefused, KeyToolError, StartupRefused, SandboxUnavailable, RunnerError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # never print internals, paths or key material
        print(f"failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    print(json.dumps(out))
    return 0 if out["verdict"] == "reproduced" else 3


if __name__ == "__main__":
    sys.exit(main())
