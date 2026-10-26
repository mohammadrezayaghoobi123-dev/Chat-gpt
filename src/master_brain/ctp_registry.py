"""Registry of reviewed CTP test specifications (the ONLY things the operator path may run).

Trust boundary: a ``RegisteredTest`` is source code reviewed and committed to this repository (or to a
deployment-specific module reviewed the same way). Nothing here is, or can be, supplied by an HTTP
client: a request names a ``test_id`` and nothing else. Code, argv, inputs, environment and limits
all come from this registry. Every registered spec must run in the sandbox (``isolation="sandbox"``);
the unsandboxed development mode of ``ctp_runner`` is refused here by construction.

The specs below are small, deterministic *self-tests of the platform* (they demonstrate and exercise the
workflow). They are not scientific claims about the world; real knowledge-island tests are added the same
way: reviewed code in a registry, never a payload.

``spec_digest`` includes the SHA-256 of the interpreter binary, so it is host/interpreter specific: an
approval granted on one host does not carry to another, and a changed interpreter invalidates an open
approval (this is intended).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass

from master_brain.ctp_runner import RunnerError, TestSpec, python_ro_paths

REGISTRY_SCHEMA_VERSION = 1
MAX_REGISTERED_TIMEOUT_S = 60.0
MAX_REGISTERED_MEMORY = 1 << 30
MAX_REGISTERED_TESTS = 64
_TEST_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class RegistryError(ValueError):
    """The registry itself is malformed (refuses to build, fail closed)."""


@dataclass(frozen=True)
class RegisteredTest:
    test_id: str
    title: str
    description: str
    spec: TestSpec

    def spec_digest(self) -> str:
        return self.spec.digest()


class CtpRegistry:
    """An immutable, validated set of reviewed tests."""

    def __init__(self, tests: tuple[RegisteredTest, ...]) -> None:
        if not isinstance(tests, tuple) or not 1 <= len(tests) <= MAX_REGISTERED_TESTS:
            raise RegistryError(f"a registry holds 1..{MAX_REGISTERED_TESTS} tests")
        seen: set[str] = set()
        for t in tests:
            if not isinstance(t, RegisteredTest):
                raise RegistryError("registry entries must be RegisteredTest")
            if not (isinstance(t.test_id, str) and _TEST_ID.match(t.test_id)):
                raise RegistryError("test_id must match [a-z0-9][a-z0-9-]{0,63}")
            if t.test_id in seen:
                raise RegistryError(f"duplicate test_id {t.test_id!r}")
            seen.add(t.test_id)
            for label, text in (("title", t.title), ("description", t.description)):
                if not isinstance(text, str) or not text.strip() or len(text) > 1000:
                    raise RegistryError(f"{label} must be 1..1000 characters")
            if not isinstance(t.spec, TestSpec):
                raise RegistryError("spec must be a TestSpec")
            if t.spec.isolation != "sandbox":
                raise RegistryError("registered tests must run in the sandbox (isolation='sandbox')")
            if not 0 < t.spec.timeout_s <= MAX_REGISTERED_TIMEOUT_S:
                raise RegistryError("registered timeout must be in (0, 60] seconds")
            if t.spec.memory_bytes > MAX_REGISTERED_MEMORY:
                raise RegistryError("registered memory limit must be at most 1 GiB")
            try:
                t.spec.validate()
            except RunnerError as exc:
                raise RegistryError(f"{t.test_id}: {exc}") from None
        self._tests = {t.test_id: t for t in tests}
        self._order = tuple(t.test_id for t in tests)

    def get(self, test_id: object) -> RegisteredTest | None:
        """None for anything unregistered (including non-strings): there is no other lookup path."""
        return self._tests.get(test_id) if isinstance(test_id, str) else None

    def all(self) -> tuple[RegisteredTest, ...]:
        return tuple(self._tests[i] for i in self._order)

    def digest(self) -> str:
        """Identity of the whole registry (ids + spec digests), recorded with every request."""
        body = json.dumps([[t.test_id, t.spec_digest()] for t in self.all()], separators=(",", ":"))
        return hashlib.sha256(body.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------------- built-in self-tests
_ISOLATION_SELFCHECK = b'''\
import os, socket, sys
# 17 = the criterion is not met; any crash exits 1 (inconclusive, never a negative finding)
try:
    s = socket.socket()
    s.settimeout(2)
    s.connect(("192.0.2.1", 9))          # TEST-NET-1: must be unreachable from inside the sandbox
    sys.exit(17)
except OSError:
    pass
try:
    open("/etc/ctp-selfcheck-write", "w")
    sys.exit(17)                          # the root file system must be read-only
except OSError:
    pass
if os.getpid() > 50:
    sys.exit(17)                          # a private pid namespace starts small
print("isolation-selfcheck-ok")
'''

_SHA256_KAT = b'''\
import hashlib, sys
data = open("inputs/message.bin", "rb").read()
expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"  # FIPS 180 test vector "abc"
if hashlib.sha256(data).hexdigest() != expected:
    sys.exit(17)
print("sha256-known-answer-ok")
'''


def builtin_registry() -> CtpRegistry:
    py = os.path.realpath(sys.executable)
    ro = python_ro_paths()

    def spec(code_name: str, code: bytes, criterion: str, inputs: tuple = ()) -> TestSpec:
        return TestSpec(argv=(py, "-I", f"code/{code_name}"), criterion=criterion,
                        code=((code_name, code),), inputs=inputs, ro_paths=ro,
                        timeout_s=20.0, memory_bytes=256 << 20, max_output_bytes=4096)

    return CtpRegistry((
        RegisteredTest(
            "sandbox-isolation-selfcheck", "Sandbox isolation self-check",
            "From inside the sandbox: no external network, read-only root, private pid space. "
            "A platform self-test, not a scientific claim.",
            spec("t.py", _ISOLATION_SELFCHECK,
                 "exit 0 iff the test code observes network denial, a read-only root and a private pid space")),
        RegisteredTest(
            "sha256-known-answer", "SHA-256 known-answer test",
            "Hashes a fixed input and compares it with the published FIPS 180 test vector. "
            "Deterministic; exercises the execute/verify/reproduce path.",
            spec("t.py", _SHA256_KAT, "exit 0 iff SHA-256('abc') equals the published test vector",
                 inputs=(("message.bin", b"abc"),))),
    ))


__all__ = ["CtpRegistry", "RegisteredTest", "RegistryError", "builtin_registry",
           "REGISTRY_SCHEMA_VERSION"]
