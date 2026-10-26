"""The runnable server: ``python -m master_brain.serve --data-dir DIR`` (Gate 2d-2, OPS-001, PLAT-001).

Everything the process needs lives under one data directory (created private, mode 0700):

    audit.jsonl                 mission audit (hash-chained)         accounts.sqlite  local accounts + sessions
    accounts.security.jsonl     security log (hash-chained)          registry.sqlite  execution idempotency registry

Start-up is FAIL CLOSED: a data directory other users can reach, an unreadable/tampered log, or a malformed
approval-key file stops the process with exit code 2 and a reason. A torn final record (crash artifact) is
refused too, with a pointer to the explicit recovery tool — the server never repairs history by itself.

Authentication is local accounts + sessions only (no static tokens exist in a served instance). Who may approve
is the ``approver`` role of an account (``python -m master_brain.accounts … --approver``). Approval signatures
are verified against the PUBLIC keys in ``--approval-keys`` (JSON, loaded once at start; changing it needs a
restart). Without that file no approval can be recorded. Nothing can be executed unless ``--demo-echo-task``
is given (a single offline task); real integrations are a separate, reviewed step.

TLS is not terminated here: bind to loopback, or put a TLS proxy in front and pass ``--secure-cookies``.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
from dataclasses import dataclass, field
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from master_brain.accounts import AccountStore, SessionAuthenticator
from master_brain.approvers import AccountApprovers
from master_brain.audit_store import AuditStore, AuditStoreError
from master_brain.execution_registry import SQLiteExecutionRegistry
from master_brain.http_api import make_server
from master_brain.identity import Identity
from master_brain.integrations import (
    IntegrationDescriptor, IntegrationHealth, IntegrationKind, IntegrationMaturity, IntegrationRequirement,
)
from master_brain.mission_service import ExecutionConfig, MissionService
from master_brain.pubmed import PubMedError, pubmed_abstracts_task, pubmed_search_task
from master_brain.task_catalog import TaskCatalog, TaskDefinition

MAX_TRUSTED_KEYS = 100
_KEY_ID = re.compile(r"[A-Za-z0-9._:-]{1,64}")
_HEX_KEY = re.compile(r"[0-9a-fA-F]{64}")
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


class StartupRefused(RuntimeError):
    """The server must not start; the message says why (never contains a secret)."""


# The server verifies the whole audit/security log at its first read and then every 5 minutes;
# reads in between verify only the bytes appended since (see AuditStore).
FULL_VERIFY_SECONDS = 300.0


@dataclass(frozen=True)
class ServeConfig:
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8765
    allow_non_loopback: bool = False
    allowed_hosts: tuple[str, ...] = ()
    secure_cookies: bool = False
    approval_keys: Path | None = None
    demo_echo_task: bool = False
    pubmed_searches: tuple[str, ...] = ()
    pubmed_abstracts: tuple[str, ...] = ()
    ctp_builtin_tests: bool = False


@dataclass
class Built:
    server: ThreadingHTTPServer
    service: MissionService
    warnings: list[str] = field(default_factory=list)
    _started: bool = False
    _stopping: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def run(self) -> None:
        with self._lock:
            if self._stopping:  # a stop that arrived before the loop began is honoured, not lost
                return
            self._started = True
        self.server.serve_forever()

    def stop(self) -> None:
        with self._lock:
            self._stopping = True
            started = self._started
        if started:
            self.server.shutdown()

    def close(self) -> None:
        self.stop()
        self.server.server_close()


# ----------------------------------------------------------------------------- approval keys
def _owner_only_writable(path: Path, what: str) -> None:
    if os.name != "nt" and path.stat().st_mode & 0o022:
        raise StartupRefused(f"{what} is writable by group/others; fix its permissions (chmod go-w)")


def load_trust_store(path: str | os.PathLike[str]):
    """Strict loader for ``{"keys": [{"key_id", "subject", "public_key_hex"}, ...]}`` (PUBLIC keys only)."""
    path = Path(path)
    if not path.is_file():
        raise StartupRefused("the approval-keys file does not exist")
    _owner_only_writable(path, "the approval-keys file")
    try:
        from master_brain.approval_signing_ed25519 import Ed25519TrustStore
    except ImportError as exc:
        raise StartupRefused("approval keys need the optional 'signing' extra (pip install master-brain-core[signing])") from exc
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StartupRefused("the approval-keys file is not valid JSON") from exc
    if not (isinstance(data, dict) and set(data) == {"keys"} and isinstance(data["keys"], list)):
        raise StartupRefused('the approval-keys file must be {"keys": [...]}')
    if len(data["keys"]) > MAX_TRUSTED_KEYS:
        raise StartupRefused("too many approval keys")
    store = Ed25519TrustStore()
    for entry in data["keys"]:
        if not (isinstance(entry, dict) and set(entry) == {"key_id", "subject", "public_key_hex"}):
            raise StartupRefused("each approval key needs exactly key_id, subject and public_key_hex")
        key_id, subject, public = entry["key_id"], entry["subject"], entry["public_key_hex"]
        if not (isinstance(key_id, str) and _KEY_ID.fullmatch(key_id)):
            raise StartupRefused("an approval key has an invalid key_id")
        try:
            Identity(subject)
        except (ValueError, TypeError):
            raise StartupRefused("an approval key has an invalid subject") from None
        if not (isinstance(public, str) and _HEX_KEY.fullmatch(public)):
            raise StartupRefused("an approval key's public_key_hex must be 64 hex characters")
        try:
            store.add_key(key_id, subject, bytes.fromhex(public))
        except ValueError as exc:
            raise StartupRefused(f"approval key rejected: {exc}") from None
    return store


# ----------------------------------------------------------------------------- start-up checks
def _verify_log(path: Path, name: str) -> None:
    try:
        count = len(AuditStore(path).read_all())
    except AuditStoreError as exc:
        hint = (f"; if this is a crash artifact, inspect it with: python -m master_brain.audit_recovery --path {path}"
                if "unterminated" in str(exc) else "; refusing to start (the log is damaged — do not repair it blindly)")
        raise StartupRefused(f"the {name} did not verify ({exc}){hint}") from exc
    del count


def preflight(data_dir: str | os.PathLike[str]) -> list[str]:
    """Create/check the data directory and verify every log; returns non-fatal warnings."""
    data = Path(data_dir)
    if not data.exists():
        data.mkdir(parents=True, mode=0o700)
        if os.name != "nt":
            os.chmod(data, 0o700)
    if not data.is_dir():
        raise StartupRefused("the data path is not a directory")
    if os.name != "nt" and data.stat().st_mode & 0o077:
        raise StartupRefused("the data directory has permissions that let other users in; run: chmod 700 " + str(data))
    _verify_log(data / "audit.jsonl", "mission audit log")
    accounts = AccountStore(data / "accounts.sqlite", full_verify_interval_seconds=FULL_VERIFY_SECONDS)
    _verify_log(accounts.security_log.path, "security log")
    totals = accounts.counts()
    warnings: list[str] = []
    if totals["accounts"] == 0:
        warnings.append("no accounts exist; create one: python -m master_brain.accounts --db "
                        f"{data / 'accounts.sqlite'} add --subject user:you --approver --password-stdin")
    elif totals["approvers"] == 0:
        warnings.append("no account has the approver role; no consequential mission can be approved")
    return warnings


def approver_readiness_warnings(accounts: AccountStore, verifier: Any) -> list[str]:
    """Who can ACTUALLY approve = an enabled approver account that also holds a trusted signing key.

    Pure diagnostics: nothing about who may approve changes. Subjects are not secrets; key material is never named.
    """
    if verifier is None or not hasattr(verifier, "active_subjects"):
        return []
    approvers = accounts.approver_subjects()
    if not approvers:
        return []  # already reported by preflight
    keyed = verifier.active_subjects()
    ready = [s for s in approvers if s in keyed]
    unready = [s for s in approvers if s not in keyed]
    out: list[str] = []
    if not ready:
        out.append("no approver has a signing key in --approval-keys: nobody can approve a consequential mission")
    elif len(ready) == 1:
        out.append("only one approver can approve (single point of failure): add a second approver account "
                   "and signing key, and keep the recovery steps from docs/APPROVER_RECOVERY_RUNBOOK.md at hand")
    if unready:
        shown = ", ".join(unready[:5]) + (f" and {len(unready) - 5} more" if len(unready) > 5 else "")
        out.append(f"approver accounts without a signing key in --approval-keys: {shown}")
    return out


# ----------------------------------------------------------------------------- demo task (offline)
class OfflineEcho:
    def invoke(self, payload):
        return {"echo": dict(payload)}


def _demo_task() -> TaskDefinition:
    descriptor = IntegrationDescriptor(
        integration_id="offline-echo", version="1", kind=IntegrationKind.MODEL, capabilities=("text_reasoning",),
        maturity=IntegrationMaturity.ENABLED, health=IntegrationHealth.AVAILABLE, risk_level=0,
        estimated_cost_per_call=0.0, limitations=("offline only",))
    return TaskDefinition.create(
        task_id="echo", description="Echo a fixed payload (offline demo)", integration=descriptor,
        requirement=IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.MODEL),
        adapter=OfflineEcho(), payload={"text": "hello"})


# ----------------------------------------------------------------------------- assembly
PUBMED_DEFAULT_MAX = 10


def parse_pubmed_spec(spec: str, fetcher: Any = None, *, abstracts: bool = False) -> TaskDefinition:
    """``TASK_ID=QUERY`` -> an operator-defined, approval-gated PubMed task (search, or search + abstracts)."""
    flag = "--pubmed-abstracts" if abstracts else "--pubmed-search"
    task_id, sep, query = spec.partition("=")
    if not sep:
        raise StartupRefused(f"{flag} must look like TASK_ID=QUERY")
    make = pubmed_abstracts_task if abstracts else pubmed_search_task
    try:
        return make(task_id.strip(), query.strip(), PUBMED_DEFAULT_MAX, fetcher=fetcher)
    except (PubMedError, ValueError) as exc:
        raise StartupRefused(f"{flag} {task_id.strip()!r}: {exc}") from exc


def build(config: ServeConfig, *, pubmed_fetcher: Any = None) -> Built:
    warnings = preflight(config.data_dir)
    data = Path(config.data_dir)
    verifier = None
    if config.approval_keys is not None:
        verifier = load_trust_store(config.approval_keys)
    else:
        warnings.append("no --approval-keys: no approval can be recorded")
    accounts = AccountStore(data / "accounts.sqlite", full_verify_interval_seconds=FULL_VERIFY_SECONDS)
    warnings.extend(approver_readiness_warnings(accounts, verifier))
    execution = None
    tasks: list[TaskDefinition] = []
    if config.demo_echo_task:
        tasks.append(_demo_task())
        warnings.append("--demo-echo-task is on: one offline task can run (not a real integration)")
    tasks.extend(parse_pubmed_spec(spec, pubmed_fetcher) for spec in config.pubmed_searches)
    tasks.extend(parse_pubmed_spec(spec, pubmed_fetcher, abstracts=True) for spec in config.pubmed_abstracts)
    if config.pubmed_searches or config.pubmed_abstracts:
        warnings.append("--pubmed-search: approved tasks will contact eutils.ncbi.nlm.nih.gov (read-only, free)")
    if tasks:
        try:
            catalog = TaskCatalog(tasks)
        except ValueError as exc:
            raise StartupRefused(str(exc)) from exc
        execution = ExecutionConfig(catalog, SQLiteExecutionRegistry(str(data / "registry.sqlite")),
                                    dispatch_timeout_seconds=30.0)
    ctp = None
    audit_store = AuditStore(data / "audit.jsonl", full_verify_interval_seconds=FULL_VERIFY_SECONDS)
    if config.ctp_builtin_tests:
        from master_brain.ctp_operations import CtpOperations
        from master_brain.ctp_registry import builtin_registry
        from master_brain.ctp_runner import sandbox_status
        status = sandbox_status()
        if not status["available"]:  # fail closed at start-up: no unsandboxed fallback exists
            raise StartupRefused("--ctp-builtin-tests needs a working sandbox: " + status["reason"])
        if verifier is None:
            raise StartupRefused("--ctp-builtin-tests needs --approval-keys (a run cannot be approved otherwise)")
        evidence = data / "ctp-evidence"
        evidence.mkdir(mode=0o700, exist_ok=True)
        os.chmod(evidence, 0o700)
        ctp = CtpOperations(audit_store, builtin_registry(), AccountApprovers(accounts), verifier, evidence)
        warnings.append("CTP runs enabled: approved REGISTERED tests execute in the sandbox on this host; "
                        "independent verification needs the separate `python -m master_brain.ctp_verify` process")
    service = MissionService(audit_store, verifier, execution, AccountApprovers(accounts))
    try:
        server = make_server(service, SessionAuthenticator(accounts), config.host, config.port,
                             allow_non_loopback=config.allow_non_loopback,
                             allowed_hosts=config.allowed_hosts or None, secure_cookies=config.secure_cookies,
                             accounts=accounts, ctp=ctp)
    except ValueError as exc:
        raise StartupRefused(str(exc)) from exc
    if config.host not in _LOOPBACK:
        warnings.append("non-loopback bind: terminate TLS in front of this process and pass --secure-cookies")
    return Built(server, service, warnings)


def _parse(argv: list[str] | None) -> ServeConfig:
    parser = argparse.ArgumentParser(prog="python -m master_brain.serve", description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-non-loopback", action="store_true")
    parser.add_argument("--allowed-host", action="append", default=[], help="repeatable; e.g. brain.example.org")
    parser.add_argument("--secure-cookies", action="store_true", help="only behind TLS")
    parser.add_argument("--approval-keys", type=Path, help="JSON file of PUBLIC approval keys")
    parser.add_argument("--ctp-builtin-tests", action="store_true",
                        help="enable operator-approved runs of the reviewed built-in CTP tests (needs sandbox + --approval-keys)")
    parser.add_argument("--demo-echo-task", action="store_true", help="register one offline demo task")
    parser.add_argument("--pubmed-search", action="append", default=[], metavar="TASK_ID=QUERY",
                        help="repeatable; register a read-only PubMed search task")
    parser.add_argument("--pubmed-abstracts", action="append", default=[], metavar="TASK_ID=QUERY",
                        help="repeatable; like --pubmed-search but also returns abstracts")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be 0-65535")
    return ServeConfig(args.data_dir, args.host, args.port, args.allow_non_loopback, tuple(args.allowed_host),
                       args.secure_cookies, args.approval_keys, args.demo_echo_task,
                       tuple(args.pubmed_search), tuple(args.pubmed_abstracts), args.ctp_builtin_tests)


def _main(argv: list[str] | None = None) -> int:
    config = _parse(argv)
    try:
        built = build(config)
    except StartupRefused as exc:
        print(f"refused to start: {exc}", file=sys.stderr)
        return 2
    for warning in built.warnings:
        print(f"warning: {warning}", file=sys.stderr, flush=True)
    host, port = built.server.server_address[:2]
    stop: Callable[[], Any] = lambda *_a: threading.Thread(target=built.stop, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f"listening on http://{host}:{port}/app/", flush=True)
    try:
        built.run()
    finally:
        built.server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(_main())

__all__ = ["Built", "ServeConfig", "StartupRefused", "build", "load_trust_store", "preflight"]
