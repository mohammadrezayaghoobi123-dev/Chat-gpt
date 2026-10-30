"""CTP test runner: really executes a test, fingerprints it, and keeps *execution*
separate from *independent verification*.

Three separate acts, three separate audit events / identities:

1. ``execute_and_record``  - runs the test in a child process and appends
   ``ctp.test_executed`` (digests only, never the output text). Result is
   ``verification: "unverified"``; it can never become PASS/FAIL on its own.
2. ``verify_by_rerun``     - a *different* identity re-runs the same spec, compares the
   fingerprints, and signs (Ed25519) a message binding both executions' fingerprints.
   It appends ``ctp.test_verified``.
3. ``ctp_test_state`` / ``apply_to_case`` - recompute the state from the chain alone
   (distinct identities, signature valid for the key bound to ``verifier:<id>``,
   fingerprints really match, verdict re-derived). Only ``verified_reproduced``
   yields PASS/FAIL; everything else is INCONCLUSIVE or untouched NOT_RUN.

Isolation (honest limits)
-------------------------
``isolation="sandbox"`` (the default, required for untrusted code) uses unprivileged
Linux user/mount/pid/net/ipc/uts namespaces plus ``pivot_root`` into a tmpfs root that
contains read-only binds of system directories and the private work directory only,
``no_new_privs`` and an empty capability bounding set, and RLIMITs. Before the first use
the sandbox is *probed for real* (no network, host path invisible, read-only system
dirs, ...). If the probe fails the run is refused (fail-closed); there is NO silent
fallback to unsandboxed execution. ``isolation="none"`` exists for code the operator
wrote and reviewed; it only applies RLIMITs, a private temp dir and process-group kill,
and is recorded as such in the chain.

Not provided: cgroup CPU/memory/pids accounting (RLIMIT_AS/CPU/FSIZE only), seccomp
syscall filtering, protection from a kernel exploit, or protection from a host
administrator. A re-run on the same host by a different key is *identity* separation,
not environment independence; the chain says so. Output is assumed deterministic:
non-deterministic tests will legitimately end as ``not_reproduced``.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import resource
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping

from master_brain.audit_store import AuditStore, NOW
from master_brain.ctp import CTPCase, ExecutionProvenance, TestStatus, record_test_execution

VERIFICATION_DOMAIN = b"master-brain/ctp-verification/v1\n"
EXECUTED = "ctp.test_executed"
VERIFIED = "ctp.test_verified"
SIGNATURE_ALG = "ed25519"
NOT_MET_EXIT_CODE = 17  # "criterion not met"; exit 1 (crash/uncaught exception) is never a negative finding.

MAX_TIMEOUT_S = 300.0
MAX_OUTPUT_BYTES = 1 << 20
MIN_MEMORY, MAX_MEMORY = 64 << 20, 4 << 30
MAX_INPUT_BYTES = 1 << 20
MAX_SANDBOX_PROCESSES = 256     # watchdog cap on live processes of one run
MAX_WORK_BYTES = 64 << 20       # watchdog cap on bytes under ./work (code, inputs, out, scratch)
MAX_ARGV, MAX_ENV, MAX_RO, MAX_OUT_FILES = 64, 16, 8, 64
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_ENV_FORBIDDEN_PREFIX = ("LD_", "PYTHON", "BASH_", "SHELL", "IFS", "PATH", "HOME")
_SYSTEM_RO = ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc/alternatives")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_HEX = re.compile(r"^[0-9a-f]{64}$")


class RunnerError(ValueError):
    """The spec or request is malformed; nothing was executed."""


class SandboxUnavailable(RuntimeError):
    """Isolation was required but could not be established; nothing was executed."""


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canon(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------- spec


@dataclass(frozen=True)
class TestSpec:
    __test__ = False

    argv: tuple[str, ...]                        # argv[0] absolute path of the executable
    criterion: str                               # what PASS means, in words (recorded)
    code: tuple[tuple[str, bytes], ...] = ()     # (name, content): copied to ./code/<name>
    inputs: tuple[tuple[str, bytes], ...] = ()   # (name, content): copied to ./inputs/<name>
    env: tuple[tuple[str, str], ...] = ()
    ro_paths: tuple[str, ...] = ()               # extra read-only binds (sandbox) e.g. /usr/local
    timeout_s: float = 10.0
    memory_bytes: int = 512 << 20
    max_output_bytes: int = 64 << 10
    isolation: str = "sandbox"                   # "sandbox" | "none" (operator-trusted code only)

    def validate(self) -> None:
        def bad(msg: str) -> None:
            raise RunnerError(msg)

        if not isinstance(self.argv, tuple) or not 1 <= len(self.argv) <= MAX_ARGV:
            bad("argv must be a tuple of 1..64 strings")
        for a in self.argv:
            if not isinstance(a, str) or "\x00" in a or len(a) > 4096:
                bad("argv entries must be NUL-free strings up to 4096 chars")
        exe = self.argv[0]
        if not os.path.isabs(exe) or ".." in Path(exe).parts:
            bad("argv[0] must be an absolute path without '..'")
        if not isinstance(self.criterion, str) or not self.criterion.strip() or len(self.criterion) > 2000:
            bad("criterion must be a non-empty string up to 2000 chars")
        if self.isolation not in ("sandbox", "none"):
            bad("isolation must be 'sandbox' or 'none'")
        if not isinstance(self.timeout_s, (int, float)) or isinstance(self.timeout_s, bool) \
                or not 0 < self.timeout_s <= MAX_TIMEOUT_S:
            bad("timeout_s must be in (0, 300]")
        if not isinstance(self.memory_bytes, int) or isinstance(self.memory_bytes, bool) \
                or not MIN_MEMORY <= self.memory_bytes <= MAX_MEMORY:
            bad("memory_bytes must be between 64 MiB and 4 GiB")
        if not isinstance(self.max_output_bytes, int) or isinstance(self.max_output_bytes, bool) \
                or not 1 <= self.max_output_bytes <= MAX_OUTPUT_BYTES:
            bad("max_output_bytes must be in 1..1 MiB")
        for label, items in (("code", self.code), ("inputs", self.inputs)):
            if not isinstance(items, tuple):
                bad(f"{label} must be a tuple")
            if not all(isinstance(item, tuple) and len(item) == 2 for item in items):
                bad(f"{label} entries must be (name, bytes)")
            names = [item[0] for item in items]
            if len(set(map(repr, names))) != len(names):
                bad(f"{label} names must be unique")
            total = 0
            for name, data in items:
                if not isinstance(name, str) or not _NAME.match(name):
                    bad(f"{label} name is not a plain file name: {name!r}")
                if not isinstance(data, bytes):
                    bad(f"{label} content must be bytes")
                total += len(data)
            if total > MAX_INPUT_BYTES:
                bad(f"{label} exceeds 1 MiB")
        if not isinstance(self.env, tuple) or len(self.env) > MAX_ENV:
            bad("env must be a tuple of up to 16 (NAME, value) pairs")
        seen: set[str] = set()
        for pair in self.env:
            if not (isinstance(pair, tuple) and len(pair) == 2):
                bad("env entries must be (NAME, value)")
            key, value = pair
            if not isinstance(key, str) or not _ENV_NAME.match(key) \
                    or key.startswith(_ENV_FORBIDDEN_PREFIX) or key in seen:
                bad(f"env name not allowed: {key!r}")
            if not isinstance(value, str) or "\x00" in value or len(value) > 1024:
                bad("env values must be NUL-free strings up to 1024 chars")
            seen.add(key)
        if not isinstance(self.ro_paths, tuple) or len(self.ro_paths) > MAX_RO:
            bad("ro_paths must be a tuple of up to 8 paths")
        for p in self.ro_paths:
            if not isinstance(p, str) or not os.path.isabs(p) or ".." in Path(p).parts \
                    or "\x00" in p or p == "/" or any(c in p for c in "\n\r'\"\\$`;&|<>*?"):
                bad(f"ro_paths entry not allowed: {p!r}")
        if self.isolation == "sandbox" and not _visible_in_sandbox(exe, self.ro_paths):
            bad("executable is not under a read-only bind visible in the sandbox "
                "(add its directory to ro_paths)")

    # -- fingerprints -------------------------------------------------------------

    def input_digest(self) -> str:
        return _sha(_canon([[n, _sha(d)] for n, d in sorted(self.inputs)]))

    def code_digests(self) -> dict[str, str]:
        return {n: _sha(d) for n, d in sorted(self.code)}

    def executable_sha256(self) -> str:
        try:
            with open(os.path.realpath(self.argv[0]), "rb") as fh:
                h = hashlib.sha256()
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest()
        except OSError:
            raise RunnerError("executable cannot be read") from None

    def digest(self) -> str:
        return _sha(_canon({
            "argv": list(self.argv), "criterion": self.criterion,
            "code": self.code_digests(), "inputs": self.input_digest(),
            "env": [list(p) for p in sorted(self.env)], "ro_paths": sorted(self.ro_paths),
            "timeout_s": self.timeout_s, "memory_bytes": self.memory_bytes,
            "max_output_bytes": self.max_output_bytes, "isolation": self.isolation,
            "executable_sha256": self.executable_sha256(),
        }))


def _covered(path: str, roots: tuple[str, ...]) -> bool:
    return any(path == r or path.startswith(r.rstrip("/") + "/") for r in roots)


def _visible_in_sandbox(exe: str, extra: tuple[str, ...]) -> bool:
    roots = tuple(os.path.realpath(r) for r in _SYSTEM_RO) + _SYSTEM_RO + tuple(extra) \
        + tuple(os.path.realpath(e) for e in extra)
    return _covered(exe, roots) and _covered(os.path.realpath(exe), roots)


def python_ro_paths() -> tuple[str, ...]:
    """Read-only binds the current interpreter needs beyond the system directories."""
    out = []
    for p in {sys.prefix, sys.base_prefix, os.path.dirname(os.path.realpath(sys.executable))}:
        rp = os.path.realpath(p)
        if rp != "/" and not _covered(rp, tuple(os.path.realpath(r) for r in _SYSTEM_RO)):
            out.append(rp)
    # drop paths nested in another listed path
    out = sorted(set(out))
    return tuple(p for p in out if not any(q != p and _covered(p, (q,)) for q in out))


# ------------------------------------------------------------------------ results


@dataclass(frozen=True)
class ExecutionRecord:
    execution_id: str
    case_id: str
    test_id: str
    runner_id: str
    spec_digest: str
    argv_digest: str
    executable_sha256: str
    code_digests: dict
    input_digest: str
    started_at: str
    duration_ms: int
    exit_code: int | None
    term_signal: int | None
    outcome: str                      # pass | fail | inconclusive
    reason: str
    stdout_sha256: str
    stderr_sha256: str
    stdout_bytes: int
    stderr_bytes: int
    outputs_sha256: str               # manifest digest of files the test left in ./out
    inputs_intact: bool
    isolation: str
    sandbox: dict
    environment: dict


def store_blob(evidence_dir: Path, data: bytes) -> str:
    """Content-addressed, private (0600/0700) evidence file; returns its sha256."""
    digest = _sha(data)
    evidence_dir = Path(evidence_dir)
    evidence_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(evidence_dir, 0o700)
    target = evidence_dir / digest
    if not target.exists():
        fd, tmp = tempfile.mkstemp(dir=evidence_dir)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, target)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return digest


def read_blob(evidence_dir: Path, digest: str) -> bytes:
    if not isinstance(digest, str) or not _HEX.match(digest):
        raise RunnerError("evidence id must be a sha256 hex digest")
    data = (Path(evidence_dir) / digest).read_bytes()
    if _sha(data) != digest:
        raise RunnerError("evidence file does not match its digest (tampered)")
    return data


# ---------------------------------------------------------------------- sandbox


_PROBE_PY = r"""
import json, os, socket, sys
r = {}
try:
    names = [l.split(":")[0].strip() for l in open("/proc/net/dev").read().splitlines()[2:]]
except Exception as e:
    names = ["?"]
r["only_loopback"] = names == ["lo"]
try:
    s = socket.socket(); s.settimeout(1.0); s.connect(("93.184.216.34", 80)); r["no_external_network"] = False
except OSError:
    r["no_external_network"] = True
r["host_path_hidden"] = not os.path.exists(sys.argv[1])
try:
    open("/usr/.probe", "w"); r["system_read_only"] = False
except OSError:
    r["system_read_only"] = True
r["private_pid_space"] = os.getpid() < 50
try:
    open("/etc/.probe", "w"); r["root_read_only"] = False
except OSError:
    r["root_read_only"] = True
import ctypes
_libc = ctypes.CDLL(None, use_errno=True)
r["no_nested_userns"] = _libc.unshare(0x10000000) != 0
r["no_mount"] = _libc.mount(b"x", b"/work", b"tmpfs", 0, None) != 0
r["only_work_and_system_visible"] = set(os.listdir("/")) <= {
    "usr","bin","sbin","lib","lib32","lib64","etc","work","proc","tmp","dev","opt","home","srv","var","root","run","mnt","media","sys","boot"} \
    and not os.path.exists("/home/claude") and not os.path.exists("/root/.ssh")
print(json.dumps(r, sort_keys=True))
"""

_probe_lock = threading.Lock()
_probe_cache: dict[str, Any] = {}


def _unshare_supports(flag: str) -> bool:
    try:
        out = subprocess.run(["unshare", "--help"], capture_output=True, timeout=5, text=True).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return flag in out


def _script_for(root: str, workdir: str, ro: list[str], argv: tuple[str, ...],
                env: tuple[tuple[str, str], ...]) -> str:
    q = shlex.quote
    lines = ["set -eu", "PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH", f"R={q(root)}",
             'mount -t tmpfs -o size=8m tmpfs "$R"']
    for d in ro:
        lines.append(
            f'if [ -L {q(d)} ]; then mkdir -p "$R$(dirname {q(d)})"; ln -s "$(readlink {q(d)})" "$R"{q(d)}; '
            f'elif [ -d {q(d)} ]; then mkdir -p "$R"{q(d)}; mount --bind {q(d)} "$R"{q(d)}; '
            f'mount -o remount,bind,ro {q(d)} "$R"{q(d)} 2>/dev/null || mount -o remount,bind,ro "$R"{q(d)}; fi')
    lines += [
        'mkdir -p "$R/work" "$R/proc" "$R/tmp" "$R/dev" "$R/oldroot"',
        f'mount --bind {q(workdir)} "$R/work"',
        'mount -t proc proc "$R/proc"',
        # no nested user namespaces for the test (shrinks kernel attack surface); fail-closed if it cannot be set
        'echo 0 > "$R/proc/sys/user/max_user_namespaces"',
        'mount -t tmpfs -o size=8m tmpfs "$R/tmp"',
        'for n in null zero urandom random; do : > "$R/dev/$n"; mount --bind "/dev/$n" "$R/dev/$n"; done',
        'cd "$R"', "pivot_root . oldroot", "umount -l /oldroot", "rmdir /oldroot",
        "mount -o remount,bind,ro /", "cd /work",
    ]
    envs = " ".join(q(f"{k}={v}") for k, v in (("HOME", "/work"), ("PATH", "/usr/bin:/bin"), *env))
    lines.append(
        "exec setpriv --no-new-privs --bounding-set=-all --inh-caps=-all -- "
        f"env -i {envs} {' '.join(q(a) for a in argv)}")
    return "\n".join(lines) + "\n"


def _limits_preexec(spec: TestSpec) -> Callable[[], None]:
    cpu = int(spec.timeout_s) + 2

    def apply() -> None:
        os.setsid()
        # The test must not inherit the parent's signal state: a runner started under nohup / a
        # supervisor would otherwise hand SIG_IGN (SIGHUP, ...) and a blocked mask to the code
        # under test, so a signal death would be reported as a clean exit.
        signal.pthread_sigmask(signal.SIG_SETMASK, [])
        for sig in signal.valid_signals():
            if sig in (signal.SIGKILL, signal.SIGSTOP):
                continue
            try:
                signal.signal(sig, signal.SIG_DFL)
            except (OSError, ValueError, RuntimeError):
                pass
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_AS, (spec.memory_bytes, spec.memory_bytes))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES * 4, MAX_OUTPUT_BYTES * 4))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        os.umask(0o077)

    return apply


def sandbox_status(*, refresh: bool = False) -> dict:
    """Really probe the sandbox. ``{"available": bool, "properties": {...}, "reason": str}``."""
    with _probe_lock:
        if _probe_cache and not refresh:
            return dict(_probe_cache)
        result = _probe()
        _probe_cache.clear()
        _probe_cache.update(result)
        return dict(result)


def _probe() -> dict:
    if not sys.platform.startswith("linux"):
        return {"available": False, "properties": {}, "reason": "not Linux"}
    for tool in ("unshare", "setpriv", "pivot_root", "mount", "umount"):
        if shutil.which(tool) is None:
            return {"available": False, "properties": {}, "reason": f"missing tool: {tool}"}
    with tempfile.TemporaryDirectory(prefix="ctp-probe-") as host_dir:
        sentinel = os.path.join(host_dir, "host-sentinel")
        Path(sentinel).write_text("x")
        spec = TestSpec(
            argv=(os.path.realpath(sys.executable), "-I", "-c", _PROBE_PY, sentinel),
            criterion="sandbox probe", ro_paths=python_ro_paths(), timeout_s=20.0,
        )
        try:
            rec_out = _run_raw(spec, probe=True)
        except (RunnerError, SandboxUnavailable) as exc:
            return {"available": False, "properties": {}, "reason": f"probe could not run: {exc}"}
    if rec_out["exit_code"] != 0:
        tail = rec_out["stderr"][-300:].decode("utf-8", "replace").strip()
        return {"available": False, "properties": {}, "reason": f"probe failed: {tail or rec_out['reason']}"}
    try:
        props = json.loads(rec_out["stdout"].decode())
    except ValueError:
        return {"available": False, "properties": {}, "reason": "probe output unreadable"}
    ok = bool(props) and all(v is True for v in props.values())
    return {"available": ok, "properties": props,
            "reason": "" if ok else "probe properties failed: " + ", ".join(k for k, v in props.items() if v is not True)}


# ------------------------------------------------------------------------ running


def _read_limited(path: str, cap: int) -> tuple[bytes, bool]:
    with open(path, "rb") as fh:
        data = fh.read(cap + 1)
    return data[:cap], len(data) > cap


def _file_sha(path: str) -> str:
    with open(path, "rb") as fh:
        return _sha(fh.read())


def _outputs_manifest(out_dir: str) -> tuple[str, str]:
    """(manifest digest, problem). Symlinks and special files are a problem, not followed."""
    entries = []
    for root, dirs, files in os.walk(out_dir, followlinks=False):
        for name in sorted(dirs + files):
            full = os.path.join(root, name)
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                return "", f"output {name!r} is a link or special file"
            if stat.S_ISREG(st.st_mode):
                if st.st_size > MAX_OUTPUT_BYTES or len(entries) >= MAX_OUT_FILES:
                    return "", "output files exceed limits"
                entries.append([os.path.relpath(full, out_dir), _file_sha(full)])
    return _sha(_canon(sorted(entries))), ""


def _run_raw(spec: TestSpec, *, probe: bool = False) -> dict:
    spec.validate()
    if spec.isolation == "sandbox" and not probe:
        status = sandbox_status()
        if not status["available"]:
            raise SandboxUnavailable("sandbox unavailable: " + status["reason"]
                                     + " (refusing to run untrusted code unisolated)")
    base = tempfile.mkdtemp(prefix="ctp-run-")
    os.chmod(base, 0o700)
    work = os.path.join(base, "work")
    root = os.path.join(base, "root")
    try:
        for d in (work, root, os.path.join(work, "code"), os.path.join(work, "inputs"),
                  os.path.join(work, "out")):
            os.mkdir(d, 0o700)
        for sub, items in (("code", spec.code), ("inputs", spec.inputs)):
            for name, data in items:
                with open(os.path.join(work, sub, name), "wb") as fh:
                    fh.write(data)
        before_inputs = _tree_digest(work, ("code", "inputs"))
        out_path, err_path = os.path.join(base, "stdout"), os.path.join(base, "stderr")
        if spec.isolation == "sandbox":
            ro = [d for d in _SYSTEM_RO if os.path.exists(d)] + list(spec.ro_paths)
            ro = sorted(set(ro))
            script = os.path.join(base, "launch.sh")
            Path(script).write_text(_script_for(root, work, ro, spec.argv, spec.env))
            flags = ["--user", "--map-root-user", "--net", "--mount", "--pid", "--ipc", "--uts", "--fork"]
            if _unshare_supports("--kill-child"):
                flags.append("--kill-child")
            cmd = ["unshare", *flags, "sh", script]
            cwd = base
            env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
        else:
            cmd = list(spec.argv)
            cwd = work
            env = {"HOME": work, "PATH": "/usr/bin:/bin", **dict(spec.env)}
        started = _now_iso()
        t0 = time.monotonic()
        reason = ""
        with open(out_path, "wb") as so, open(err_path, "wb") as se:
            try:
                proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=so,
                                        stderr=se, preexec_fn=_limits_preexec(spec), close_fds=True)
            except OSError as exc:
                return _result(spec, started, 0, None, None, "inconclusive",
                               f"spawn failed: {exc.__class__.__name__}", b"", b"", "", True)
            timed_out = capped = False
            violation = ""
            deadline = t0 + spec.timeout_s
            tick = 0
            over_memory = 0
            while proc.poll() is None:
                if time.monotonic() >= deadline:
                    timed_out = True
                    break
                if os.path.getsize(out_path) > spec.max_output_bytes or os.path.getsize(err_path) > spec.max_output_bytes:
                    capped = True
                    break
                tick += 1
                if tick % 5 == 0 and spec.isolation == "sandbox":   # about every 50 ms
                    violation = _watchdog_violation(proc.pid, work, spec.memory_bytes, tick % 20 == 0)
                    # Accounting of pages shared by freshly forked processes is transiently wrong
                    # (measured: spikes to several times the real size); a real flood persists.
                    over_memory = over_memory + 1 if violation == "memory?" else 0
                    if violation == "memory?":
                        violation = "memory" if over_memory >= 3 else ""
                    if violation:
                        break
                time.sleep(0.01)
            if timed_out or capped or violation:
                _killpg(proc)
            proc.wait()
        # a grandchild may outlive the leader; always clean the group
        _killpg(proc)
        duration_ms = int((time.monotonic() - t0) * 1000)
        stdout, c1 = _read_limited(out_path, spec.max_output_bytes)
        stderr, c2 = _read_limited(err_path, spec.max_output_bytes)
        capped = capped or c1 or c2
        rc = proc.returncode
        exit_code, sig = (None, -rc) if rc is not None and rc < 0 else (rc, None)
        manifest, problem = _outputs_manifest(os.path.join(work, "out"))
        intact = _tree_digest(work, ("code", "inputs")) == before_inputs
        if violation:
            outcome, reason = "inconclusive", f"resource limit exceeded: {violation}"
        elif timed_out:
            outcome, reason = "inconclusive", "timeout"
        elif capped:
            outcome, reason = "inconclusive", "output limit exceeded"
        elif sig is not None:
            outcome, reason = "inconclusive", f"terminated by signal {sig}"
        elif not intact:
            outcome, reason = "inconclusive", "test modified its own code or inputs"
        elif problem:
            outcome, reason = "inconclusive", problem
        elif exit_code == 0:
            outcome, reason = "pass", "criterion met (exit 0)"
        elif exit_code == NOT_MET_EXIT_CODE:
            outcome, reason = "fail", f"criterion not met (exit {NOT_MET_EXIT_CODE})"
        else:
            outcome, reason = "inconclusive", f"abnormal exit code {exit_code}"
        return _result(spec, started, duration_ms, exit_code, sig, outcome, reason, stdout, stderr, manifest, intact)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def _pss_bytes(pid: str, page: int) -> int:
    """Proportional set size: pages shared by forked children are counted once, not once per process."""
    try:
        with open(f"/proc/{pid}/smaps_rollup", "rb") as fh:
            for line in fh:
                if line.startswith(b"Pss:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    with open(f"/proc/{pid}/statm", "rb") as fh:     # fallback (over-counts shared pages: errs on the strict side)
        return int(fh.read().split()[1]) * page


def _group_usage(pgrp: int) -> tuple[int, int]:
    """(live processes, resident bytes) of every process in the run's process group (best effort)."""
    count = rss = 0
    page = os.sysconf("SC_PAGE_SIZE")
    try:
        names = os.listdir("/proc")
    except OSError:
        return 0, 0
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat", "rb") as fh:
                fields = fh.read().rsplit(b")", 1)[1].split()
            if int(fields[2]) != pgrp:      # fields[2] is pgrp (after state, ppid)
                continue
            count += 1
            rss += _pss_bytes(name, page)
        except (OSError, ValueError, IndexError):
            continue
    return count, rss


def _dir_bytes(path: str) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def _watchdog_violation(pgrp: int, work: str, memory_bytes: int, check_disk: bool) -> str:
    """Name of the aggregate resource cap that is exceeded, or ''. Per-process rlimits do not bound a set of processes."""
    count, rss = _group_usage(pgrp)
    if count > MAX_SANDBOX_PROCESSES:
        return "processes"
    if rss > memory_bytes:
        return "memory?"      # memory must stay over the budget for several samples (see _run_raw)
    if check_disk and _dir_bytes(work) > MAX_WORK_BYTES:
        return "disk"
    return ""


def _tree_digest(work: str, subdirs: tuple[str, ...]) -> str:
    entries = []
    for sub in subdirs:
        for root, _, files in os.walk(os.path.join(work, sub)):
            for name in sorted(files):
                full = os.path.join(root, name)
                try:
                    entries.append([os.path.relpath(full, work), _file_sha(full)])
                except OSError:
                    entries.append([os.path.relpath(full, work), "unreadable"])
    return _sha(_canon(sorted(entries)))


def _killpg(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _result(spec, started, duration_ms, exit_code, sig, outcome, reason, stdout, stderr, manifest, intact) -> dict:
    return {"started_at": started, "duration_ms": duration_ms, "exit_code": exit_code, "term_signal": sig,
            "outcome": outcome, "reason": reason, "stdout": stdout, "stderr": stderr,
            "outputs_sha256": manifest, "inputs_intact": intact}


def _environment(spec: TestSpec) -> dict:
    return {"platform": sys.platform, "python": ".".join(map(str, sys.version_info[:3])),
            "isolation": spec.isolation, "timeout_s": spec.timeout_s, "memory_bytes": spec.memory_bytes,
            "max_output_bytes": spec.max_output_bytes, "env_names": sorted(k for k, _ in spec.env),
            "network": "denied (net namespace)" if spec.isolation == "sandbox" else "not restricted"}


def run_test(spec: TestSpec, *, case_id: str, test_id: str, runner_id: str,
             evidence_dir: Path | None = None) -> ExecutionRecord:
    """Execute ``spec`` for real and return fingerprints. Nothing is written to the chain here."""
    for label, v in (("case_id", case_id), ("test_id", test_id), ("runner_id", runner_id)):
        if not isinstance(v, str) or not _ID.match(v):
            raise RunnerError(f"{label} must match {_ID.pattern}")
    raw = _run_raw(spec)
    if evidence_dir is not None:
        store_blob(evidence_dir, raw["stdout"])
        store_blob(evidence_dir, raw["stderr"])
    sb = sandbox_status() if spec.isolation == "sandbox" else {"available": False, "properties": {}}
    return ExecutionRecord(
        execution_id=uuid.uuid4().hex, case_id=case_id, test_id=test_id, runner_id=runner_id,
        spec_digest=spec.digest(), argv_digest=_sha(_canon(list(spec.argv))),
        executable_sha256=spec.executable_sha256(), code_digests=spec.code_digests(),
        input_digest=spec.input_digest(), started_at=raw["started_at"], duration_ms=raw["duration_ms"],
        exit_code=raw["exit_code"], term_signal=raw["term_signal"], outcome=raw["outcome"],
        reason=raw["reason"], stdout_sha256=_sha(raw["stdout"]), stderr_sha256=_sha(raw["stderr"]),
        stdout_bytes=len(raw["stdout"]), stderr_bytes=len(raw["stderr"]),
        outputs_sha256=raw["outputs_sha256"], inputs_intact=raw["inputs_intact"], isolation=spec.isolation,
        sandbox=sb.get("properties", {}), environment=_environment(spec))


# -------------------------------------------------------------------------- chain

_LIMITATIONS = (
    "Executed on the same host as the recorder; not an attested environment.",
    "Isolation is namespaces + rlimits only (no cgroups, no seccomp) when isolation=sandbox; none otherwise.",
    "Result is provisional until independently re-run and signed by a different identity.",
)


def _subject(case_id: str, test_id: str) -> str:
    return f"ctp:{case_id}:{test_id}"


def execution_payload(rec: ExecutionRecord) -> dict:
    return {
        "execution_id": rec.execution_id, "case_id": rec.case_id, "test_id": rec.test_id,
        "runner_id": rec.runner_id, "spec_digest": rec.spec_digest, "argv_digest": rec.argv_digest,
        "executable_sha256": rec.executable_sha256, "code_digests": rec.code_digests,
        "input_digest": rec.input_digest, "started_at": rec.started_at, "duration_ms": rec.duration_ms,
        "exit_code": rec.exit_code, "term_signal": rec.term_signal, "outcome": rec.outcome,
        "provisional_status": rec.outcome, "stdout_sha256": rec.stdout_sha256,
        "stderr_sha256": rec.stderr_sha256, "stdout_bytes": rec.stdout_bytes,
        "stderr_bytes": rec.stderr_bytes,
        "environment": {**rec.environment, "outputs_sha256": rec.outputs_sha256,
                        "inputs_intact": rec.inputs_intact, "sandbox_properties": rec.sandbox,
                        "reason": rec.reason},
        "criterion": "see spec_digest", "verification": "unverified", "limitations": list(_LIMITATIONS),
    }


def execute_and_record(store: AuditStore, spec: TestSpec, *, case_id: str, test_id: str,
                       runner_id: str, evidence_dir: Path | None = None) -> ExecutionRecord:
    """Run for real, then append ``ctp.test_executed`` (digests only)."""
    rec = run_test(spec, case_id=case_id, test_id=test_id, runner_id=runner_id, evidence_dir=evidence_dir)
    store.append(event_id=f"ctp-exec-{rec.execution_id}", event_type=EXECUTED, recorded_at=NOW,
                 actor=runner_id, subject_ref=_subject(case_id, test_id), payload=execution_payload(rec))
    return rec


_COMPARED = ("spec_digest", "outcome", "stdout_sha256", "stdout_bytes")


def _reproduction_verdict(orig: Mapping, rerun: Mapping) -> str:
    if orig["outcome"] == "inconclusive" or rerun["outcome"] == "inconclusive":
        return "not_confirmable"
    same = all(orig.get(k) == rerun.get(k) for k in _COMPARED) and \
        orig["environment"].get("outputs_sha256") == rerun["environment"].get("outputs_sha256") and \
        orig["environment"].get("inputs_intact") is True and rerun["environment"].get("inputs_intact") is True
    return "reproduced" if same else "not_reproduced"


def verification_message(*, original: Mapping, rerun: Mapping, verdict: str, verifier_id: str,
                         key_id: str) -> bytes:
    def fp(p: Mapping) -> dict:
        return {k: p[k] for k in ("execution_id", "case_id", "test_id", "runner_id", "spec_digest",
                                  "argv_digest", "executable_sha256", "code_digests", "input_digest",
                                  "outcome", "exit_code", "stdout_sha256", "stderr_sha256")} | \
            {"outputs_sha256": p["environment"].get("outputs_sha256")}
    return VERIFICATION_DOMAIN + _canon({"original": fp(original), "rerun": fp(rerun), "verdict": verdict,
                                         "verifier_id": verifier_id, "signing_key_id": key_id})


def _executed_events(store: AuditStore, case_id: str, test_id: str) -> dict[str, Any]:
    return {e.payload["execution_id"]: e for e in store.read_all()
            if e.event_type == EXECUTED and e.subject_ref == _subject(case_id, test_id)}


def verify_by_rerun(store: AuditStore, spec: TestSpec, *, case_id: str, test_id: str,
                    original_execution_id: str, verifier_id: str, signer: Any,
                    evidence_dir: Path | None = None) -> dict:
    """A different identity re-runs ``spec`` and signs what it observed (never a self-attestation)."""
    if not isinstance(verifier_id, str) or not _ID.match(verifier_id):
        raise RunnerError("verifier_id must be a plain identifier")
    originals = _executed_events(store, case_id, test_id)
    original = originals.get(original_execution_id)
    if original is None:
        raise RunnerError("unknown original execution")
    if original.actor == verifier_id:
        raise RunnerError("the verifier must be a different identity than the executor")
    if original.payload["spec_digest"] != spec.digest():
        raise RunnerError("spec differs from the executed spec")
    rerun = execute_and_record(store, spec, case_id=case_id, test_id=test_id, runner_id=verifier_id,
                               evidence_dir=evidence_dir)
    rerun_payload = store_event_payload(store, rerun.execution_id)
    verdict = _reproduction_verdict(original.payload, rerun_payload)
    message = verification_message(original=original.payload, rerun=rerun_payload, verdict=verdict,
                                   verifier_id=verifier_id, key_id=signer.key_id)
    signature = signer.sign(message)
    key = f"{original_execution_id}:{rerun.execution_id}"
    payload = {
        "original_execution_id": original_execution_id, "rerun_execution_id": rerun.execution_id,
        "verdict": verdict, "verifier_id": verifier_id, "signing_key_id": signer.key_id,
        "signature_alg": SIGNATURE_ALG, "signature_hex": signature.hex(),
        "basis": "independent re-run of the identical spec; fingerprints compared",
        "independence": "different identity and signing key; same host and same recorder - "
                        "not an independent environment",
        "limitations": list(_LIMITATIONS),
    }

    # The event id binds both execution ids, so the store's own unique-id rule refuses a replay.
    event = store.append(event_id=f"ctp-verify-{key}", event_type=VERIFIED, recorded_at=NOW,
                         actor=verifier_id, subject_ref=_subject(case_id, test_id), payload=payload)
    return {"verdict": verdict, "verification_event_id": event.event_id,
            "rerun_execution_id": rerun.execution_id}


def store_event_payload(store: AuditStore, execution_id: str) -> dict:
    for e in store.read_all():
        if e.event_type == EXECUTED and e.payload.get("execution_id") == execution_id:
            return e.payload
    raise RunnerError("execution not found")


@dataclass(frozen=True)
class TestState:
    __test__ = False
    state: str                  # not_run | executed_unverified | verified_reproduced | not_reproduced | not_confirmable | inconsistent
    outcome: str | None = None  # pass/fail/inconclusive when verified_reproduced
    execution_ids: tuple[str, ...] = ()
    verification_event_id: str | None = None
    problems: tuple[str, ...] = ()


def ctp_test_state(store: AuditStore, trust_store: Any, case_id: str, test_id: str) -> TestState:
    """Recompute the state from the chain alone; nothing here trusts a recorded verdict."""
    events = store.read_all()  # raises on a tampered chain: evaluation stops
    subject = _subject(case_id, test_id)
    execs = {e.payload["execution_id"]: e for e in events if e.event_type == EXECUTED and e.subject_ref == subject}
    if not execs:
        return TestState("not_run")
    problems: list[str] = []
    verdicts: list[tuple[str, str, str]] = []  # (verdict, event_id, original id)
    for ev in (e for e in events if e.event_type == VERIFIED and e.subject_ref == subject):
        p = ev.payload
        orig, rerun = execs.get(p.get("original_execution_id")), execs.get(p.get("rerun_execution_id"))
        why = None
        if orig is None or rerun is None:
            why = "verification references an unknown execution"
        elif p["verifier_id"] == orig.actor or ev.actor != p["verifier_id"] or rerun.actor != p["verifier_id"]:
            why = "verifier is not a distinct identity that performed the re-run"
        elif orig.payload["spec_digest"] != rerun.payload["spec_digest"]:
            why = "re-run used a different spec"
        elif _reproduction_verdict(orig.payload, rerun.payload) != p["verdict"]:
            why = "recorded verdict does not follow from the fingerprints"
        else:
            try:
                sig = bytes.fromhex(p["signature_hex"])
            except (ValueError, TypeError):
                sig = b""
            msg = verification_message(original=orig.payload, rerun=rerun.payload, verdict=p["verdict"],
                                       verifier_id=p["verifier_id"], key_id=p["signing_key_id"])
            err = trust_store.verify(key_id=p["signing_key_id"], algorithm=p["signature_alg"],
                                     subject=f"verifier:{p['verifier_id']}", message=msg, signature=sig)
            if err:
                why = f"signature rejected: {err}"
        if why:
            problems.append(f"{ev.event_id}: {why}")
        else:
            verdicts.append((p["verdict"], ev.event_id, p["original_execution_id"]))
    ids = tuple(execs)
    if verdicts:
        # A valid signed "not reproduced" vetoes everything else; an inconclusive re-run is not a contradiction.
        for wanted in ("not_reproduced", "reproduced", "not_confirmable"):
            hit = next((v for v in verdicts if v[0] == wanted), None)
            if hit:
                orig_out = execs[hit[2]].payload["outcome"]
                if wanted == "reproduced":
                    return TestState("verified_reproduced", orig_out, ids, hit[1], tuple(problems))
                return TestState(wanted, None, ids, hit[1], tuple(problems))
    if problems:
        return TestState("inconsistent", None, ids, None, tuple(problems))
    return TestState("executed_unverified", None, ids)


def apply_to_case(case: CTPCase, store: AuditStore, trust_store: Any, test_id: str) -> CTPCase:
    """Update a CTP case from the chain. PASS/FAIL only after verified reproduction."""
    st = ctp_test_state(store, trust_store, case.case_id, test_id)
    if st.state == "not_run":
        return case
    latest_id = st.execution_ids[-1]
    provenance_for = lambda group, basis: ExecutionProvenance(  # noqa: E731
        execution_id=latest_id, executed_at=_now_iso(), source="ctp_runner",
        method="real subprocess execution with SHA-256 fingerprints", independent_group=group,
        independence_basis=basis, limitations=_LIMITATIONS)
    if st.state == "verified_reproduced" and st.outcome in ("pass", "fail"):
        ver = next(e for e in store.read_all() if e.event_id == st.verification_event_id)
        return record_test_execution(
            case, test_id, TestStatus.PASS if st.outcome == "pass" else TestStatus.FAIL,
            f"re-run reproduced identical fingerprints; outcome={st.outcome}",
            tuple(f"ctp-exec-{i}" for i in (ver.payload["original_execution_id"], ver.payload["rerun_execution_id"]))
            + (st.verification_event_id,),
            provenance_for(f"verifier:{ver.payload['verifier_id']}",
                           "different identity and signing key re-ran the spec; same host"))
    notes = {
        "executed_unverified": "executed but not independently verified",
        "not_reproduced": "independent re-run did not reproduce the result",
        "not_confirmable": "an execution was inconclusive; result cannot be confirmed",
        "inconsistent": "verification records are invalid: " + "; ".join(st.problems),
        "verified_reproduced": "reproduced run was inconclusive",
    }
    return record_test_execution(
        case, test_id, TestStatus.INCONCLUSIVE, notes[st.state], (), provenance_for(
            "none", "none: " + notes[st.state]))
