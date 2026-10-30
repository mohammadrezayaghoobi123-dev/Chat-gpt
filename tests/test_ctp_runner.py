"""CTP runner: real execution, real isolation, separate signed verification (red-first)."""
import os
import shutil
import signal
import sys
import tempfile
import textwrap
import time
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from unittest import mock

from master_brain import ctp_runner as R
from master_brain.audit_store import AuditStore
from master_brain.ctp import (CTPCase, DiscriminatingTest, Falsifier, RivalHypothesis, TestStatus)

try:
    from master_brain.approval_signing_ed25519 import Ed25519Signer, Ed25519TrustStore
    HAVE_ED25519 = True
except ImportError:
    HAVE_ED25519 = False

PY = os.path.realpath(sys.executable)
REQUIRE_SANDBOX = os.environ.get("MB_REQUIRE_SANDBOX_TESTS") == "1"
_STATUS = R.sandbox_status(refresh=True)
# Without a working sandbox these tests are skipped (never reported green); the environment
# that is supposed to have one (CI) sets MB_REQUIRE_SANDBOX_TESTS=1 and then a missing sandbox FAILS.
needs_sandbox = unittest.skipIf(not _STATUS["available"] and not REQUIRE_SANDBOX,
                                "no usable sandbox here: " + _STATUS["reason"])
needs_ed25519 = unittest.skipUnless(HAVE_ED25519, "optional 'signing' extra not installed")


class Availability(unittest.TestCase):
    def test_required_environment_really_has_the_sandbox_and_signing(self):
        if REQUIRE_SANDBOX:
            self.assertTrue(_STATUS["available"], _STATUS["reason"])
        if os.environ.get("MB_REQUIRE_SIGNING_TESTS") == "1":
            self.assertTrue(HAVE_ED25519, "install the 'signing' extra in this environment")


def spec(script: str, *, code=(), inputs=(), **kw) -> R.TestSpec:
    kw.setdefault("ro_paths", R.python_ro_paths())
    kw.setdefault("criterion", "test criterion")
    return R.TestSpec(argv=(PY, "-I", "-c", textwrap.dedent(script)), code=code, inputs=inputs, **kw)


def run(s, **kw):
    return R.run_test(s, case_id="c1", test_id="t1", runner_id="runner-a", **kw)


@needs_sandbox
class Execution(unittest.TestCase):
    def test_pass_fail_and_crash_are_distinguished(self):
        self.assertEqual(run(spec("import sys; sys.exit(0)")).outcome, "pass")
        self.assertEqual(run(spec("import sys; sys.exit(17)")).outcome, "fail")
        crash = run(spec("raise RuntimeError('boom')"))  # exit 1: a crash is NOT a negative finding
        self.assertEqual((crash.outcome, crash.exit_code), ("inconclusive", 1))
        self.assertIn("abnormal", crash.reason)

    def test_output_is_really_captured_and_fingerprinted(self):
        a = run(spec("print('hello')"))
        b = run(spec("print('hello')"))
        c = run(spec("print('other')"))
        self.assertEqual(a.stdout_sha256, b.stdout_sha256)
        self.assertNotEqual(a.stdout_sha256, c.stdout_sha256)
        self.assertEqual(a.stdout_bytes, 6)
        self.assertEqual(a.spec_digest, b.spec_digest)
        self.assertNotEqual(a.execution_id, b.execution_id)

    def test_spec_digest_changes_with_every_input(self):
        base = spec("pass")
        variants = [
            replace(base, criterion="other"), replace(base, timeout_s=11.0),
            replace(base, memory_bytes=1 << 30), replace(base, env=(("X", "1"),)),
            replace(base, inputs=(("a", b"1"),)), replace(base, code=(("c.py", b"1"),)),
            replace(base, max_output_bytes=1000), replace(base, isolation="none"),
            spec("print(1)"),
        ]
        digests = {v.digest() for v in variants} | {base.digest()}
        self.assertEqual(len(digests), len(variants) + 1)

    def test_code_and_inputs_are_delivered_and_bound(self):
        s = R.TestSpec(argv=(PY, "-I", "code/t.py"), criterion="c", ro_paths=R.python_ro_paths(),
                       code=(("t.py", b"import sys\nsys.exit(0 if open('inputs/x').read()=='7' else 17)\n"),),
                       inputs=(("x", b"7"),))
        self.assertEqual(run(s).outcome, "pass")
        self.assertEqual(run(replace(s, inputs=(("x", b"8"),))).outcome, "fail")
        self.assertNotEqual(s.digest(), replace(s, inputs=(("x", b"8"),)).digest())

    def test_timeout_kills_whole_process_group(self):
        s = spec("""
            import os, subprocess, sys, time
            subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(60)'])
            time.sleep(60)
        """, timeout_s=1.0)
        t0 = time.monotonic()
        rec = run(s)
        self.assertEqual((rec.outcome, rec.reason), ("inconclusive", "timeout"))
        self.assertLess(time.monotonic() - t0, 8)

    def test_output_cap_is_inconclusive_not_pass(self):
        rec = run(spec("import sys\nwhile True: sys.stdout.write('x'*1000); sys.stdout.flush()",
                       max_output_bytes=4096))
        self.assertEqual((rec.outcome, rec.reason), ("inconclusive", "output limit exceeded"))

    def test_memory_hog_does_not_pass(self):
        rec = run(spec("x = bytearray(1 << 30)", memory_bytes=128 << 20))
        self.assertNotEqual(rec.outcome, "pass")

    def test_killed_by_signal_is_inconclusive(self):
        # (in the sandbox the test is PID 1 of its namespace, where self-signals are ignored by design)
        rec = run(spec("import os, signal; os.kill(os.getpid(), signal.SIGKILL)", isolation="none"))
        self.assertEqual(rec.outcome, "inconclusive")
        self.assertEqual(rec.term_signal, 9)

    def test_spawn_failure_is_inconclusive(self):
        s = R.TestSpec(argv=("/nonexistent/exe",), criterion="c", isolation="none")
        with self.assertRaises(R.RunnerError):  # fingerprint of a missing executable is impossible
            run(s)

    def test_test_that_modifies_its_own_inputs_is_inconclusive(self):
        s = R.TestSpec(argv=(PY, "-I", "-c", "open('inputs/x','w').write('tampered')"), criterion="c",
                       ro_paths=R.python_ro_paths(), inputs=(("x", b"1"),))
        rec = run(s)
        self.assertEqual(rec.outcome, "inconclusive")
        self.assertFalse(rec.inputs_intact)

    def test_output_files_are_fingerprinted_and_links_refused(self):
        a = run(spec("open('out/r','w').write('1')"))
        b = run(spec("open('out/r','w').write('2')"))
        self.assertTrue(a.outputs_sha256)
        self.assertNotEqual(a.outputs_sha256, b.outputs_sha256)
        link = run(spec("import os; os.symlink('/etc/passwd', 'out/l')"))
        self.assertEqual(link.outcome, "inconclusive")

    def test_evidence_is_content_addressed_and_tamper_evident(self):
        with tempfile.TemporaryDirectory() as d:
            rec = run(spec("print('evidence')"), evidence_dir=Path(d))
            self.assertEqual(R.read_blob(Path(d), rec.stdout_sha256), b"evidence\n")
            self.assertEqual(oct((Path(d) / rec.stdout_sha256).stat().st_mode & 0o777), "0o600")
            (Path(d) / rec.stdout_sha256).write_bytes(b"forged")
            with self.assertRaises(R.RunnerError):
                R.read_blob(Path(d), rec.stdout_sha256)
            with self.assertRaises(R.RunnerError):
                R.read_blob(Path(d), "../../etc/passwd")


@needs_sandbox
class Sandbox(unittest.TestCase):
    """Isolation is verified by what the test code can actually reach."""

    def assert_passes(self, script, **kw):
        rec = run(spec(script, **kw))
        self.assertEqual(rec.outcome, "pass", (rec.reason, rec.exit_code))
        return rec

    def test_probe_really_ran_and_all_properties_hold(self):
        st = R.sandbox_status(refresh=True)
        self.assertTrue(st["available"], st)
        self.assertTrue(st["properties"] and all(st["properties"].values()))

    def test_no_network(self):
        self.assert_passes("""
            import socket, sys
            try:
                s = socket.socket(); s.settimeout(1); s.connect(('127.0.0.1', 9)); sys.exit(1)
            except OSError: pass
            try:
                s = socket.socket(); s.settimeout(1); s.connect(('93.184.216.34', 80)); sys.exit(1)
            except OSError: pass
        """)

    def test_host_files_and_secrets_are_invisible(self):
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d, "host-secret"); marker.write_text("s")
            self.assert_passes(f"""
                import os, sys
                for p in ({str(marker)!r}, '/home/claude', '/root', '/root/.ssh', '/etc/shadow', '/mnt'):
                    if os.path.exists(p): sys.exit(1)
            """)

    def test_traversal_and_symlink_escapes_fail(self):
        with tempfile.TemporaryDirectory() as d:
            marker = Path(d, "host-secret"); marker.write_text("s")
            self.assert_passes(f"""
                import os, sys
                for p in ('../../../../../../{str(marker)[1:]}', '/proc/1/root/{str(marker)[1:]}',
                          '/proc/self/root/{str(marker)[1:]}', '/oldroot'):
                    if os.path.exists(p): sys.exit(1)
                try:
                    os.symlink({str(marker)!r}, 'l'); open('l').read(); sys.exit(1)
                except OSError: pass
                os.chdir('/'); 
                for _ in range(40): os.chdir('..')
                if os.path.exists({str(marker)!r}): sys.exit(1)
            """)

    def test_system_dirs_are_read_only_and_writes_do_not_leak(self):
        # A per-run unique marker: a fixed host path such as /tmp/x makes this test fail on any host (or any
        # concurrent process) that happens to own that path, which says nothing about sandbox isolation.
        marker = f"/tmp/ctp-leak-probe-{uuid.uuid4().hex}"
        self.assertFalse(os.path.lexists(marker))
        self.assert_passes(f"""
            import os, sys
            for p in ('/usr/x', '/bin/x', '/etc/x', '/x', '/lib/x'):
                try: open(p, 'w'); sys.exit(1)
                except OSError: pass
            open({marker!r}, 'w').write('1')  # private tmpfs is fine
        """)
        self.assertFalse(os.path.lexists(marker))

    def test_private_pid_space_cannot_signal_host(self):
        self.assert_passes(f"""
            import os, sys
            if os.getpid() > 20: sys.exit(1)
            try: os.kill({os.getpid()}, 0); sys.exit(1)
            except OSError: pass
        """)

    def test_no_privilege_regain(self):
        self.assert_passes("""
            import ctypes, os, sys
            libc = ctypes.CDLL(None, use_errno=True)
            # capabilities: effective/permitted must be empty
            st = dict(l.split(':\\t') for l in open('/proc/self/status') if ':\\t' in l)
            if int(st['CapEff'], 16) or int(st['CapBnd'], 16): sys.exit(1)
            if int(st['NoNewPrivs']): pass
            else: sys.exit(1)
            if libc.mount(b'x', b'/work', b'tmpfs', 0, None) == 0: sys.exit(1)
            if libc.unshare(0x10000000) == 0: sys.exit(1)  # CLONE_NEWUSER
        """)

    def test_environment_is_minimal_and_host_env_not_inherited(self):
        with mock.patch.dict(os.environ, {"MB_SECRET_TOKEN": "hunter2", "GITHUB_TOKEN": "x"}):
            self.assert_passes("""
                import os, sys
                if set(os.environ) - {'HOME', 'PATH', 'ALLOWED', 'LC_CTYPE'}: sys.exit(1)  # LC_CTYPE: set by python itself
                if os.environ.get('ALLOWED') != '1': sys.exit(1)
            """, env=(("ALLOWED", "1"),))

    def test_fail_closed_when_sandbox_unavailable_nothing_runs(self):
        marker = Path(tempfile.mkdtemp()) / "ran"
        s = spec(f"open({str(marker)!r}, 'w').write('x')")
        with mock.patch.object(R, "sandbox_status", return_value={"available": False, "properties": {}, "reason": "test"}):
            with self.assertRaises(R.SandboxUnavailable):
                run(s)
        self.assertFalse(marker.exists())

    def test_missing_tool_makes_probe_unavailable(self):
        with mock.patch.object(R.shutil, "which", return_value=None):
            st = R._probe()
        self.assertFalse(st["available"])
        self.assertIn("missing tool", st["reason"])

    def test_broken_isolation_property_is_detected_by_probe(self):
        with mock.patch.object(R, "_run_raw", return_value={
                "exit_code": 0, "stdout": b'{"no_external_network": false, "only_loopback": true}',
                "stderr": b"", "reason": ""}):
            st = R._probe()
        self.assertFalse(st["available"])
        self.assertIn("no_external_network", st["reason"])

    def test_unreadable_probe_output_means_unavailable(self):
        for garbage in (b"", b"not json", b"\xff\xfe"):
            with mock.patch.object(R, "_run_raw", return_value={
                    "exit_code": 0, "stdout": garbage, "stderr": b"", "reason": ""}):
                st = R._probe()
            self.assertFalse(st["available"], garbage)
            self.assertEqual(st["reason"], "probe output unreadable")

    def test_probe_itself_runs_the_interpreter_isolated(self):
        seen = []
        def fake(spec, *, probe=False):
            seen.append(spec.argv)
            return {"exit_code": 0, "stdout": b"{}", "stderr": b"", "reason": ""}
        with mock.patch.object(R, "_run_raw", side_effect=fake):
            R._probe()
        self.assertTrue(seen and "-I" in seen[0])

    def test_isolation_none_is_recorded_as_unisolated(self):
        rec = run(spec("pass", isolation="none"))
        self.assertEqual(rec.isolation, "none")
        self.assertEqual(rec.environment["network"], "not restricted")
        self.assertEqual(run(spec("pass")).environment["network"], "denied (net namespace)")

    def test_executable_outside_visible_roots_refused_before_running(self):
        with tempfile.TemporaryDirectory() as d:
            exe = Path(d, "tool"); exe.write_text("#!/bin/sh\nexit 0\n"); exe.chmod(0o755)
            with self.assertRaises(R.RunnerError):
                run(R.TestSpec(argv=(str(exe),), criterion="c"))


class Validation(unittest.TestCase):
    def bad(self, **kw):
        base = dict(argv=(PY, "-I", "-c", "pass"), criterion="c", ro_paths=R.python_ro_paths())
        with self.assertRaises(R.RunnerError, msg=repr(kw)):
            run(R.TestSpec(**{**base, **kw}))

    def test_malformed_specs_are_refused_before_anything_runs(self):
        self.bad(argv=())
        self.bad(argv=("python3",))
        self.bad(argv=("/usr/../bin/python3",))
        self.bad(argv=(PY, "a\x00b"))
        self.bad(argv=[PY])
        self.bad(criterion="")
        self.bad(criterion="   ")
        self.bad(isolation="maybe")
        self.bad(timeout_s=0)
        self.bad(timeout_s=301)
        self.bad(timeout_s=True)
        self.bad(memory_bytes=1)
        self.bad(memory_bytes=(4 << 30) + 1)
        self.bad(max_output_bytes=0)
        self.bad(max_output_bytes=(1 << 20) + 1)
        for name in ("../x", "a/b", "", ".", "..", "-x", "a" * 65):
            self.bad(inputs=((name, b"x"),))
            self.bad(code=((name, b"x"),))
        self.bad(inputs=(("a", b"x"), ("a", b"y")))
        self.bad(inputs=(("a", "text"),))
        self.bad(inputs=(("a", b"x" * ((1 << 20) + 1)),))
        self.bad(env=(("LD_PRELOAD", "x"),))
        self.bad(env=(("PYTHONPATH", "x"),))
        self.bad(env=(("PATH", "x"),))
        self.bad(env=(("lower", "x"),))
        self.bad(env=(("A", "x"), ("A", "y")))
        self.bad(env=(("A", "x\x00"),))
        self.bad(env=tuple((f"A{i}", "x") for i in range(17)))
        self.bad(ro_paths=("/",))
        self.bad(ro_paths=("relative",))
        self.bad(ro_paths=("/a/../b",))
        self.bad(ro_paths=("/a; rm -rf /",))
        self.bad(ro_paths=("/a'b",))

    def test_boundaries_are_accepted(self):
        for kw in (dict(timeout_s=300.0), dict(timeout_s=0.1), dict(memory_bytes=64 << 20),
                   dict(memory_bytes=4 << 30), dict(max_output_bytes=1), dict(max_output_bytes=1 << 20)):
            replace(spec("pass"), **kw).validate()

    def test_identifiers_are_checked(self):
        for kw in (dict(case_id="a b"), dict(test_id=""), dict(runner_id="../x")):
            args = dict(case_id="c1", test_id="t1", runner_id="r1") | kw
            with self.assertRaises(R.RunnerError):
                R.run_test(spec("pass"), **args)


def make_case(case_id="c1", test_id="t1") -> CTPCase:
    return CTPCase(
        case_id=case_id, question="Does the criterion hold?", claim_ids=("claim-a",),
        hypotheses=(RivalHypothesis("h-a", "It holds."), RivalHypothesis("h-b", "It does not hold.")),
        falsifiers=(Falsifier("h-a", "The program exits 17."), Falsifier("h-b", "The program exits 0.")),
        tests=(DiscriminatingTest(test_id, "Run it", "Execute the program.",
                                  (("h-a", "exit 0"), ("h-b", "exit 17"))),))


class ChainBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = AuditStore(Path(self.tmp.name) / "audit.jsonl")
        self.trust = Ed25519TrustStore()
        self.signer = Ed25519Signer.generate("vk1")
        self.trust.add_key("vk1", "verifier:verifier-b", self.signer.public_key_bytes())
        self.spec = spec("print('ok')")

    def execute(self, s=None, runner="runner-a", case="c1", test="t1"):
        return R.execute_and_record(self.store, s or self.spec, case_id=case, test_id=test, runner_id=runner)

    def verify(self, rec, s=None, verifier="verifier-b", signer=None, case="c1", test="t1"):
        return R.verify_by_rerun(self.store, s or self.spec, case_id=case, test_id=test,
                                 original_execution_id=rec.execution_id, verifier_id=verifier,
                                 signer=signer or self.signer)

    def state(self, case="c1", test="t1"):
        return R.ctp_test_state(self.store, self.trust, case, test)


@needs_sandbox
@needs_ed25519
class Chain(ChainBase):

    def test_not_run_leaves_the_case_untouched(self):
        case = make_case()
        self.assertEqual(self.state().state, "not_run")
        self.assertIs(R.apply_to_case(case, self.store, self.trust, "t1"), case)

    def test_execution_logs_digests_only_and_is_unverified(self):
        rec = self.execute(spec("print('SECRET-OUTPUT-TEXT')"))
        text = (Path(self.tmp.name) / "audit.jsonl").read_text()
        self.assertNotIn("SECRET-OUTPUT-TEXT", text)
        self.assertIn(rec.stdout_sha256, text)
        ev = self.store.read_all()[-1]
        self.assertEqual(ev.event_type, R.EXECUTED)
        self.assertEqual(ev.payload["verification"], "unverified")
        self.assertEqual(self.state().state, "executed_unverified")

    def test_unverified_execution_never_becomes_pass_or_fail(self):
        self.execute(spec("import sys; sys.exit(0)"))
        out = R.apply_to_case(make_case(), self.store, self.trust, "t1")
        t = out.tests[0]
        self.assertEqual(t.status, TestStatus.INCONCLUSIVE)
        self.assertIn("none", t.execution_provenance.independence_basis)
        self.assertFalse(t.evidence_ids)

    def test_independent_reproduction_gives_real_pass_and_fail(self):
        for script, want in (("import sys; sys.exit(0)", TestStatus.PASS), ("import sys; sys.exit(17)", TestStatus.FAIL)):
            with self.subTest(script=script):
                s = spec(script)
                case_id = "c-" + str(want.value)
                rec = self.execute(s, case=case_id)
                res = self.verify(rec, s, case=case_id)
                self.assertEqual(res["verdict"], "reproduced")
                self.assertEqual(self.state(case_id).state, "verified_reproduced")
                t = R.apply_to_case(make_case(case_id), self.store, self.trust, "t1").tests[0]
                self.assertEqual(t.status, want)
                self.assertEqual(len(t.evidence_ids), 3)
                self.assertEqual(t.execution_provenance.independent_group, "verifier:verifier-b")

    def test_nondeterministic_test_is_not_reproduced(self):
        s = spec("import os; print(os.urandom(8).hex())")
        rec = self.execute(s)
        self.assertEqual(self.verify(rec, s)["verdict"], "not_reproduced")
        t = R.apply_to_case(make_case(), self.store, self.trust, "t1").tests[0]
        self.assertEqual(t.status, TestStatus.INCONCLUSIVE)

    def test_inconclusive_run_is_not_confirmable(self):
        s = spec("raise SystemExit(5)")
        rec = self.execute(s)
        self.assertEqual(self.verify(rec, s)["verdict"], "not_confirmable")
        self.assertEqual(self.state().state, "not_confirmable")

    def test_verifier_must_be_a_different_identity_and_same_spec(self):
        rec = self.execute()
        with self.assertRaises(R.RunnerError):
            self.verify(rec, verifier="runner-a")
        with self.assertRaises(R.RunnerError):
            self.verify(rec, s=spec("print('different')"))
        with self.assertRaises(R.RunnerError):
            R.verify_by_rerun(self.store, self.spec, case_id="c1", test_id="t1", original_execution_id="nope",
                              verifier_id="verifier-b", signer=self.signer)
        self.assertEqual(self.state().state, "executed_unverified")

    def test_verifier_id_must_be_a_plain_identifier(self):
        rec = self.execute()
        for bad in ("", "a b", "x/y", "v;b", "../v", 5, None, "a" * 200):
            with self.assertRaises(R.RunnerError, msg=repr(bad)):
                R.verify_by_rerun(self.store, self.spec, case_id="c1", test_id="t1",
                                  original_execution_id=rec.execution_id, verifier_id=bad, signer=self.signer)
        self.assertEqual(self.state().state, "executed_unverified")

    def test_untrusted_wrong_bound_or_forged_signatures_are_inconsistent(self):
        rec = self.execute()
        stranger = Ed25519Signer.generate("evil")
        self.verify(rec, signer=stranger)  # key unknown to the trust store
        self.assertEqual(self.state().state, "inconsistent")
        self.assertIn("unknown signing key", " ".join(self.state().problems))

    def test_key_bound_to_another_subject_is_rejected(self):
        trust = Ed25519TrustStore()
        trust.add_key("vk1", "verifier:someone-else", self.signer.public_key_bytes())
        self.trust = trust
        rec = self.execute()
        self.verify(rec)
        self.assertEqual(self.state().state, "inconsistent")

    def test_revoked_key_no_longer_verifies(self):
        rec = self.execute()
        self.verify(rec)
        self.assertEqual(self.state().state, "verified_reproduced")
        self.trust.revoke("vk1")
        self.assertEqual(self.state().state, "inconsistent")

    def test_self_verification_by_same_identity_is_rejected_even_if_recorded_by_hand(self):
        rec = self.execute()
        rerun = self.execute(runner="runner-a")
        orig = R.store_event_payload(self.store, rec.execution_id)
        rer = R.store_event_payload(self.store, rerun.execution_id)
        msg = R.verification_message(original=orig, rerun=rer, verdict="reproduced",
                                     verifier_id="runner-a", key_id="vk1")
        self.trust.add_key("vk2", "verifier:runner-a", self.signer.public_key_bytes())
        self.store.append(event_id="ctp-verify-hand", event_type=R.VERIFIED, recorded_at=R.NOW, actor="runner-a",
                          subject_ref="ctp:c1:t1", payload={
                              "original_execution_id": rec.execution_id, "rerun_execution_id": rerun.execution_id,
                              "verdict": "reproduced", "verifier_id": "runner-a", "signing_key_id": "vk2",
                              "signature_alg": "ed25519", "signature_hex": self.signer.sign(msg).hex(),
                              "basis": "x", "independence": "x", "limitations": []})
        self.assertEqual(self.state().state, "inconsistent")

    def test_false_reproduced_claim_is_caught_by_the_fingerprints(self):
        s = spec("import os; print(os.urandom(8).hex())")
        rec = self.execute(s)
        res = self.verify(rec, s)
        self.assertEqual(res["verdict"], "not_reproduced")
        ev = next(e for e in self.store.read_all() if e.event_id == res["verification_event_id"])
        orig = R.store_event_payload(self.store, rec.execution_id)
        rer = R.store_event_payload(self.store, res["rerun_execution_id"])
        msg = R.verification_message(original=orig, rerun=rer, verdict="reproduced",
                                     verifier_id="verifier-b", key_id="vk1")
        self.store.append(event_id="ctp-verify-lie", event_type=R.VERIFIED, recorded_at=R.NOW, actor="verifier-b",
                          subject_ref="ctp:c1:t1", payload={**ev.payload, "verdict": "reproduced",
                                                            "signature_hex": self.signer.sign(msg).hex()})
        st = self.state()
        self.assertNotEqual(st.state, "verified_reproduced")
        self.assertIn("does not follow", " ".join(st.problems))

    def test_verification_replay_is_refused_and_unknown_executions_flagged(self):
        s = self.spec
        rec = self.execute(s)
        res = self.verify(rec)
        ev = next(e for e in self.store.read_all() if e.event_id == res["verification_event_id"])
        with self.assertRaises(Exception):
            self.store.append(event_id="ctp-verify-replay", event_type=R.VERIFIED, recorded_at=R.NOW,
                              actor="verifier-b", subject_ref="ctp:c1:t1", payload=ev.payload,
                              precondition=lambda h: "dup" if any(
                                  e.event_type == R.VERIFIED and e.payload.get("rerun_execution_id") ==
                                  ev.payload["rerun_execution_id"] for e in h) else None)
        self.store.append(event_id="ctp-verify-ghost", event_type=R.VERIFIED, recorded_at=R.NOW,
                          actor="verifier-b", subject_ref="ctp:c1:t1",
                          payload={**ev.payload, "original_execution_id": "0" * 32})
        self.assertIn("unknown execution", " ".join(self.state().problems))

    def test_verification_of_another_test_does_not_leak(self):
        rec = self.execute(test="t1")
        self.verify(rec, test="t1")
        self.assertEqual(self.state(test="t2").state, "not_run")
        self.execute(test="t2")
        self.assertEqual(self.state(test="t2").state, "executed_unverified")
        self.assertEqual(self.state(test="t1").state, "verified_reproduced")

    def test_tampered_log_stops_evaluation(self):
        rec = self.execute()
        self.verify(rec)
        path = Path(self.tmp.name) / "audit.jsonl"
        path.write_text(path.read_text().replace('"outcome":"pass"', '"outcome":"fail"', 1))
        with self.assertRaises(Exception):
            self.state()

    def test_chain_records_what_it_does_not_prove(self):
        rec = self.execute()
        res = self.verify(rec)
        ev = next(e for e in self.store.read_all() if e.event_id == res["verification_event_id"])
        self.assertIn("not an independent environment", ev.payload["independence"])
        self.assertTrue(ev.payload["limitations"])

    def test_sandbox_unavailable_means_no_execution_event_at_all(self):
        before = len(self.store.read_all())
        with mock.patch.object(R, "sandbox_status", return_value={"available": False, "properties": {}, "reason": "x"}):
            with self.assertRaises(R.SandboxUnavailable):
                self.execute()
        self.assertEqual(len(self.store.read_all()), before)


if __name__ == "__main__":
    unittest.main()


# ----------------------------------------------------------------------------------------
# Second wave: boundaries, sandbox plumbing, probe failure modes, chain forgeries
# (added after mutation testing showed these behaviours were not pinned down)
# ----------------------------------------------------------------------------------------


class Boundaries(unittest.TestCase):
    def ok(self, **kw):
        replace(spec("pass"), **kw).validate()

    def refuse(self, **kw):
        with self.assertRaises(R.RunnerError, msg=repr(kw)):
            replace(spec("pass"), **kw).validate()

    def test_numeric_limits_are_exact(self):
        self.ok(argv=(PY,)); self.ok(argv=(PY,) + ("a",) * 63); self.refuse(argv=(PY,) + ("a",) * 64)
        self.ok(argv=(PY, "a" * 4096)); self.refuse(argv=(PY, "a" * 4097))
        self.ok(criterion="c" * 2000); self.refuse(criterion="c" * 2001)
        self.ok(memory_bytes=64 << 20); self.refuse(memory_bytes=(64 << 20) - 1)
        self.ok(memory_bytes=4 << 30); self.refuse(memory_bytes=(4 << 30) + 1)
        self.ok(timeout_s=5); self.ok(timeout_s=0.5); self.refuse(timeout_s="5"); self.refuse(timeout_s=None)
        self.ok(inputs=(("a", b"x" * (1 << 20)),)); self.refuse(inputs=(("a", b"x" * ((1 << 20) + 1)),))
        self.ok(code=(("a", b"x" * (1 << 20)),)); self.refuse(code=(("a", b"x" * ((1 << 20) + 1)),))
        self.ok(inputs=(("a", b"x" * (1 << 19)), ("b", b"x" * (1 << 19))))
        self.refuse(inputs=(("a", b"x" * (1 << 19)), ("b", b"x" * ((1 << 19) + 1))))
        self.ok(env=tuple((f"A{i}", "x") for i in range(16)))
        self.ok(env=(("A", "x" * 1024),)); self.refuse(env=(("A", "x" * 1025),))
        ro = tuple(f"/opt/ro{i}" for i in range(8))
        self.ok(ro_paths=R.python_ro_paths() + ro[: 8 - len(R.python_ro_paths())])
        self.refuse(ro_paths=R.python_ro_paths() + ro + ("/opt/ro-extra",))
        self.assertEqual((R.MAX_ARGV, R.MAX_ENV, R.MAX_RO, R.MAX_OUT_FILES), (64, 16, 8, 64))
        self.assertEqual((R.MIN_MEMORY, R.MAX_MEMORY, R.MAX_INPUT_BYTES), (64 << 20, 4 << 30, 1 << 20))

    def test_defaults_are_conservative(self):
        d = R.TestSpec(argv=(PY,), criterion="c")
        self.assertEqual((d.timeout_s, d.memory_bytes, d.max_output_bytes, d.isolation),
                         (10.0, 512 << 20, 64 << 10, "sandbox"))

    def test_malformed_entries_not_just_malformed_values(self):
        self.refuse(inputs=("not-a-pair",)); self.refuse(inputs=((1, b"x"),)); self.refuse(inputs=[("a", b"x")])
        self.refuse(code=("a",)); self.refuse(code=(("a", "str"),))
        self.refuse(env=("A",)); self.refuse(env=((1, "x"),)); self.refuse(env=(("A", 1),)); self.refuse(env=[("A", "x")])
        self.refuse(ro_paths=["/opt"]); self.refuse(ro_paths=(5,)); self.refuse(argv=[PY]); self.refuse(argv=(PY, 5))
        # right length but not a tuple, and a tuple of the wrong length (each half of the shape check)
        self.refuse(inputs=(["a", b"x"],)); self.refuse(inputs=(("a",),)); self.refuse(inputs=(("a", b"x", b"y"),))
        self.refuse(code=(["a", b"x"],)); self.refuse(code=(("a",),))
        self.refuse(env=(["A", "x"],)); self.refuse(env=(("A",),)); self.refuse(env=(("A", "x", "y"),))

    def test_every_forbidden_env_prefix_and_ro_char(self):
        for name in ("LD_X", "PYTHONX", "BASH_ENV", "SHELL", "SHELLOPTS", "IFS", "PATH", "PATHX", "HOME", "HOMEX"):
            self.refuse(env=((name, "x"),))
        for ch in "\n\r'\"\\$`;&|<>*?\x00":
            self.refuse(ro_paths=(f"/opt/a{ch}b",))
        self.refuse(ro_paths=("/opt/a/..",)); self.refuse(ro_paths=("/opt/../b",))

    def test_canonical_json_is_strict_and_unicode_stable(self):
        self.assertEqual(R._canon({"b": 1, "a": "é"}), b'{"a":"\xc3\xa9","b":1}')
        with self.assertRaises(ValueError):
            R._canon({"a": float("nan")})

    def test_executable_hash_covers_large_files(self):
        import hashlib
        with tempfile.TemporaryDirectory() as d:
            exe = Path(d, "big"); data = os.urandom(3 << 20) + b"tail"; exe.write_bytes(data); exe.chmod(0o755)
            s = R.TestSpec(argv=(str(exe),), criterion="c", isolation="none")
            self.assertEqual(s.executable_sha256(), hashlib.sha256(data).hexdigest())
            exe.write_bytes(data[:-1] + b"X")
            self.assertNotEqual(s.executable_sha256(), hashlib.sha256(data).hexdigest())

    def test_visibility_requires_both_the_path_and_its_real_target(self):
        with tempfile.TemporaryDirectory() as d:
            link = Path(d, "py"); link.symlink_to(PY)
            self.assertFalse(R._visible_in_sandbox(str(link), ()))              # path itself is not bound
            self.assertTrue(R._visible_in_sandbox(str(link), (d,) + R.python_ro_paths()))
            inside = Path(d, "x"); inside.symlink_to("/root")                    # bound path, target not bound
            self.assertFalse(R._visible_in_sandbox(str(inside), (d,)))
            self.assertTrue(R._visible_in_sandbox(PY, R.python_ro_paths()))

    def test_python_ro_paths_dedupes_and_skips_system_dirs(self):
        with mock.patch.object(R.sys, "prefix", "/zz/a/b"), mock.patch.object(R.sys, "base_prefix", "/zz/a"), \
                mock.patch.object(R.sys, "executable", "/zz/a/b/bin/py"):
            self.assertEqual(R.python_ro_paths(), ("/zz/a",))
        with mock.patch.object(R.sys, "prefix", "/usr/lib/py"), mock.patch.object(R.sys, "base_prefix", "/usr"), \
                mock.patch.object(R.sys, "executable", "/usr/bin/py"):
            self.assertEqual(R.python_ro_paths(), ())
        with mock.patch.object(R.sys, "prefix", "/zz/a"), mock.patch.object(R.sys, "base_prefix", "/yy/b"), \
                mock.patch.object(R.sys, "executable", "/zz/a/bin/py"):
            self.assertEqual(R.python_ro_paths(), ("/yy/b", "/zz/a"))


class Plumbing(unittest.TestCase):
    def test_evidence_store_permissions_and_idempotence(self):
        with tempfile.TemporaryDirectory() as d:
            ev = Path(d, "ev"); ev.mkdir(mode=0o755)
            digest = R.store_blob(ev, b"x")
            self.assertEqual(digest, R._sha(b"x"))
            self.assertEqual(ev.stat().st_mode & 0o777, 0o700)       # loose pre-existing dir is tightened
            self.assertEqual(R.store_blob(ev, b"x"), digest)          # second store into an existing dir is fine
            self.assertEqual([p.name for p in ev.iterdir()], [digest])

    def test_failed_store_leaves_no_temp_file_and_reraises(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(R.os, "replace", side_effect=OSError("disk")):
                with self.assertRaises(OSError):
                    R.store_blob(Path(d), b"x")
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_read_blob_rejects_bad_ids_with_a_clear_error(self):
        with tempfile.TemporaryDirectory() as d:
            for bad in ("../../../../nonexistent", "a" * 63, "A" * 64, 5, None):
                with self.assertRaisesRegex(R.RunnerError, "sha256 hex"):
                    R.read_blob(Path(d), bad)

    def test_unshare_flag_detection(self):
        ok = mock.Mock(stdout="  --kill-child  x")
        with mock.patch.object(R.subprocess, "run", return_value=ok):
            self.assertTrue(R._unshare_supports("--kill-child"))
            self.assertFalse(R._unshare_supports("--nope"))
        with mock.patch.object(R.subprocess, "run", side_effect=OSError):
            self.assertFalse(R._unshare_supports("--kill-child"))
        with mock.patch.object(R.subprocess, "run", side_effect=R.subprocess.TimeoutExpired("u", 5)):
            self.assertFalse(R._unshare_supports("--kill-child"))

    def test_read_limited_boundary(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d, "f")
            f.write_bytes(b"x" * 10); self.assertEqual(R._read_limited(str(f), 10), (b"x" * 10, False))
            f.write_bytes(b"x" * 11); self.assertEqual(R._read_limited(str(f), 10), (b"x" * 10, True))

    def test_killpg_tolerates_dead_and_foreign_groups(self):
        proc = mock.Mock(pid=2 ** 22 + 12345)
        R._killpg(proc)
        for exc in (ProcessLookupError, PermissionError):
            with mock.patch.object(R.os, "killpg", side_effect=exc):
                R._killpg(proc)
        with mock.patch.object(R.os, "killpg", side_effect=OSError("other")):
            with self.assertRaises(OSError):
                R._killpg(proc)


@needs_sandbox
class AggregateResourceLimits(unittest.TestCase):
    """Per-process rlimits do not bound a *set* of processes. The runner also watches the whole sandbox.

    Stage 3 measured (pre-registered, two environments): 4 x 400 MB against a 512 MB budget, 1500 child
    processes and 100 MB of files were all accepted. The watchdog stops these floods; sampling is
    best-effort (about 50 ms), so the caps are bounds on abuse, not hard kernel guarantees.
    """

    def run_raw(self, script, **kw):
        return R._run_raw(spec(script, timeout_s=kw.pop("timeout_s", 20), **kw))

    def test_process_flood_is_stopped(self):
        started = time.monotonic()
        raw = self.run_raw("""
            import os, time
            kids = []
            for i in range(1500):
                pid = os.fork()
                if pid == 0:
                    time.sleep(30); os._exit(0)
                kids.append(pid)
            time.sleep(30)
        """)
        self.assertEqual(raw["outcome"], "inconclusive")
        self.assertEqual(raw["reason"], "resource limit exceeded: processes")
        self.assertLess(time.monotonic() - started, 10)

    def test_aggregate_memory_flood_is_stopped(self):
        raw = self.run_raw("""
            import os, time
            for i in range(4):
                if os.fork() == 0:
                    b = bytearray(80 * 1024 * 1024)
                    for j in range(0, len(b), 4096): b[j] = 1
                    time.sleep(20); os._exit(0)
            time.sleep(20)
        """, memory_bytes=256 << 20)   # each child fits its own RLIMIT_AS; 4 x 80 MB exceeds the group budget
        self.assertEqual(raw["outcome"], "inconclusive")
        self.assertEqual(raw["reason"], "resource limit exceeded: memory")

    def test_disk_flood_in_work_is_stopped(self):
        with mock.patch.object(R, "MAX_WORK_BYTES", 4 << 20):
            raw = self.run_raw("""
                import time
                chunk = b'x' * 65536
                for i in range(2000):
                    open(f'/work/f{i}', 'wb').write(chunk)
                time.sleep(20)
            """)
        self.assertEqual(raw["outcome"], "inconclusive")
        self.assertEqual(raw["reason"], "resource limit exceeded: disk")

    def test_forked_workers_sharing_pages_are_not_counted_as_a_memory_flood(self):
        raw = self.run_raw("""
            import os, time
            big = bytearray(60 * 1024 * 1024)
            for j in range(0, len(big), 4096): big[j] = 1
            kids = []
            for i in range(20):
                pid = os.fork()
                if pid == 0:
                    time.sleep(1.0); os._exit(0)      # read-only sharers: no private copy of `big`
                kids.append(pid)
            for pid in kids: os.waitpid(pid, 0)
        """, memory_bytes=256 << 20)
        self.assertEqual((raw["outcome"], raw["reason"]), ("pass", "criterion met (exit 0)"))

    def test_ordinary_multi_process_work_is_not_affected(self):
        raw = self.run_raw("""
            import os, subprocess, sys
            outs = [subprocess.run([sys.executable, '-I', '-c', 'print(1)'], capture_output=True).stdout for _ in range(5)]
            open('out/result.txt', 'wb').write(b'y' * (1 << 20))
            assert len(outs) == 5
        """)
        self.assertEqual((raw["outcome"], raw["reason"]), ("pass", "criterion met (exit 0)"))


@needs_sandbox
class Limits(unittest.TestCase):
    """The limits the runner claims to apply are really in force inside the test process."""

    SCRIPT = """
        import json, os, resource, stat
        r = lambda n: list(resource.getrlimit(n))
        os.mkdir('out/d'); open('out/f', 'w').close()
        print(json.dumps({'core': r(resource.RLIMIT_CORE), 'as': r(resource.RLIMIT_AS), 'cpu': r(resource.RLIMIT_CPU),
                          'fsize': r(resource.RLIMIT_FSIZE), 'nofile': r(resource.RLIMIT_NOFILE),
                          'umask_file': stat.S_IMODE(os.stat('out/f').st_mode),
                          'umask_dir': stat.S_IMODE(os.stat('out/d').st_mode),
                          'home': os.environ.get('HOME'), 'path': os.environ.get('PATH'),
                          'sid_is_pid': os.getsid(0) == os.getpid() or os.getpid() == 1}))
    """

    def check(self, isolation):
        import json
        s = spec(self.SCRIPT, timeout_s=1.0, memory_bytes=200 << 20, isolation=isolation)
        raw = R._run_raw(s)
        self.assertEqual(raw["outcome"], "pass", raw["reason"])
        got = json.loads(raw["stdout"])
        self.assertEqual(got["core"], [0, 0])
        self.assertEqual(got["as"], [200 << 20] * 2)
        self.assertEqual(got["cpu"], [3, 3])                                   # int(timeout) + 2
        self.assertEqual(got["fsize"], [R.MAX_OUTPUT_BYTES * 4] * 2)
        self.assertEqual(got["nofile"], [256, 256])
        self.assertEqual((got["umask_file"], got["umask_dir"]), (0o600, 0o700))
        self.assertTrue(got["sid_is_pid"])
        return got

    def test_limits_in_sandbox(self):
        got = self.check("sandbox")
        self.assertEqual((got["home"], got["path"]), ("/work", "/usr/bin:/bin"))

    def test_limits_without_sandbox(self):
        self.check("none")

    def test_private_work_dir_mode_and_cleanup(self):
        private_tmp = tempfile.mkdtemp()                       # own TMPDIR: other processes cannot interfere
        self.addCleanup(shutil.rmtree, private_tmp, True)
        with mock.patch.object(tempfile, "tempdir", private_tmp):
            rec = run(spec("import os, stat, sys; sys.exit(0 if stat.S_IMODE(os.stat('.').st_mode) == 0o700 else 17)",
                           isolation="none"))
            self.assertEqual(rec.outcome, "pass")
            self.assertEqual(os.listdir(private_tmp), [])      # nothing left behind

    def test_sandbox_dirs_visible_and_read_only(self):
        host = [d for d in R._SYSTEM_RO if os.path.exists(d)]                  # as the host sees them (links included)
        real_dirs = [d for d in host if os.path.isdir(d) and not os.path.islink(d)]
        script = f"""
            import os, sys
            for d in {host!r}:
                if not os.path.exists(d): sys.exit(1)
            for d in {real_dirs!r}:
                try: open(d + '/.w', 'w'); sys.exit(1)
                except OSError: pass
        """
        self.assertEqual(run(spec(script)).outcome, "pass")

    def test_hup_is_a_signal_not_an_exit_code(self):
        rec = run(spec("import os, signal; os.kill(os.getpid(), signal.SIGHUP)", isolation="none"))
        self.assertEqual((rec.term_signal, rec.exit_code, rec.outcome), (1, None, "inconclusive"))

    def test_parent_ignored_or_blocked_signals_are_not_inherited(self):
        # a runner started under nohup/a supervisor has SIGHUP ignored and maybe signals blocked
        code = "import os, signal; os.kill(os.getpid(), signal.SIGHUP)"
        old = signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGUSR1})
        try:
            rec = run(spec(code, isolation="none"))
            probe = run(spec("import signal, sys; sys.exit(17 if signal.SIGUSR1 in signal.pthread_sigmask("
                             "signal.SIG_BLOCK, []) else 0)", isolation="none"))
        finally:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGUSR1})
            signal.signal(signal.SIGHUP, old)
        self.assertEqual((rec.term_signal, rec.exit_code, rec.outcome), (1, None, "inconclusive"))
        self.assertEqual(probe.outcome, "pass")                 # mask not inherited

    def test_stderr_flood_is_capped_too(self):
        rec = run(spec("import sys\nwhile True: sys.stderr.write('x'*1000); sys.stderr.flush()",
                       max_output_bytes=4096))
        self.assertEqual((rec.outcome, rec.reason), ("inconclusive", "output limit exceeded"))

    def test_output_file_limits(self):
        many = lambda n: spec(f"[open(f'out/f{{i}}', 'w').close() for i in range({n})]")
        self.assertEqual(run(many(64)).outcome, "pass")
        over = run(many(65))
        self.assertEqual((over.outcome, over.reason), ("inconclusive", "output files exceed limits"))
        big = lambda n: spec(f"open('out/b', 'wb').write(b'x' * {n})")
        self.assertEqual(run(big(1 << 20)).outcome, "pass")
        self.assertEqual(run(big((1 << 20) + 1)).outcome, "inconclusive")

    def test_special_files_and_linked_directories_in_out_are_refused(self):
        fifo = run(spec("import os; os.mkfifo('out/f')"))
        self.assertEqual(fifo.outcome, "inconclusive")
        self.assertIn("link or special", fifo.reason)
        link = run(spec("import os; os.symlink('/usr', 'out/d')"))
        self.assertEqual(link.outcome, "inconclusive")
        nested = run(spec("import os; os.mkdir('out/s'); open('out/s/f', 'w').write('1')"))
        self.assertEqual(nested.outcome, "pass")

    def test_real_spawn_failure_is_recorded_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            exe = Path(d, "noexec"); exe.write_text("x"); exe.chmod(0o644)
            rec = run(R.TestSpec(argv=(str(exe),), criterion="c", isolation="none"))
        self.assertEqual((rec.outcome, rec.exit_code, rec.term_signal, rec.duration_ms), ("inconclusive", None, None, 0))
        self.assertTrue(rec.reason.startswith("spawn failed"))
        self.assertTrue(rec.inputs_intact)

    def test_record_describes_the_environment_truthfully(self):
        a = run(spec("pass"))
        self.assertEqual(a.environment["python"], "%d.%d.%d" % sys.version_info[:3])
        self.assertTrue(a.sandbox and all(v is True for v in a.sandbox.values()))
        self.assertEqual(run(spec("pass", isolation="none")).sandbox, {})


class ProbeFailures(unittest.TestCase):
    def probe(self, **kw):
        with mock.patch.object(R, "_run_raw", **kw):
            return R._probe()

    def test_each_required_tool_is_checked(self):
        for tool in ("unshare", "setpriv", "pivot_root", "mount", "umount"):
            with mock.patch.object(R.shutil, "which", side_effect=lambda t, _t=tool: None if t == _t else "/bin/" + t):
                st = R._probe()
            self.assertFalse(st["available"]); self.assertEqual(st["reason"], f"missing tool: {tool}")

    def test_not_linux(self):
        with mock.patch.object(R.sys, "platform", "win32"):
            st = R._probe()
        self.assertEqual((st["available"], st["reason"]), (False, "not Linux"))

    def test_probe_that_cannot_run_or_fails_or_lies_is_unavailable(self):
        st = self.probe(side_effect=R.SandboxUnavailable("boom"))
        self.assertFalse(st["available"]); self.assertIn("probe could not run: boom", st["reason"])
        st = self.probe(side_effect=R.RunnerError("bad"))
        self.assertIn("probe could not run: bad", st["reason"])
        st = self.probe(return_value={"exit_code": 3, "stdout": b"", "stderr": b"no userns\n", "reason": "x"})
        self.assertEqual((st["available"], st["reason"]), (False, "probe failed: no userns"))
        st = self.probe(return_value={"exit_code": 3, "stdout": b"", "stderr": b"", "reason": "abnormal"})
        self.assertEqual(st["reason"], "probe failed: abnormal")
        st = self.probe(return_value={"exit_code": 0, "stdout": b"not json", "stderr": b"", "reason": ""})
        self.assertEqual(st["reason"], "probe output unreadable")
        st = self.probe(return_value={"exit_code": 0, "stdout": b"{}", "stderr": b"", "reason": ""})
        self.assertFalse(st["available"])                                      # empty properties never count as OK
        st = self.probe(return_value={"exit_code": 0, "stdout": b'{"a": true, "b": "yes"}', "stderr": b"", "reason": ""})
        self.assertFalse(st["available"]); self.assertIn("b", st["reason"])    # only literal True counts

    def test_status_is_cached_until_refreshed(self):
        good = {"available": True, "properties": {"a": True}, "reason": ""}
        with mock.patch.object(R, "_probe", return_value=good) as p, mock.patch.dict(R._probe_cache, clear=True):
            R.sandbox_status(refresh=True); R.sandbox_status(); R.sandbox_status()
            self.assertEqual(p.call_count, 1)
            R.sandbox_status(refresh=True)
            self.assertEqual(p.call_count, 2)
        R.sandbox_status(refresh=True)                                          # restore the real probe result


@needs_sandbox
@needs_ed25519
class ChainForgeries(ChainBase):
    """Hand-built verification events: every individual check must stand on its own."""

    def forge(self, rec, rerun, *, event_actor="verifier-b", verifier_id="verifier-b", sig_hex=None, key="vk1",
              verdict="reproduced", event_id="ctp-verify-forged", signer=None):
        orig = R.store_event_payload(self.store, rec.execution_id)
        rer = R.store_event_payload(self.store, rerun.execution_id)
        msg = R.verification_message(original=orig, rerun=rer, verdict=verdict, verifier_id=verifier_id, key_id=key)
        sig = (signer or self.signer).sign(msg).hex() if sig_hex is None else sig_hex
        self.store.append(event_id=event_id, event_type=R.VERIFIED, recorded_at=R.NOW, actor=event_actor,
                          subject_ref="ctp:c1:t1", payload={
                              "original_execution_id": rec.execution_id, "rerun_execution_id": rerun.execution_id,
                              "verdict": verdict, "verifier_id": verifier_id, "signing_key_id": key,
                              "signature_alg": "ed25519", "signature_hex": sig, "basis": "x", "independence": "x",
                              "limitations": []})

    def pair(self, rerun_by="verifier-b", rerun_spec=None):
        rec = self.execute()
        rerun = self.execute(rerun_spec or self.spec, runner=rerun_by)
        return rec, rerun

    def test_baseline_forgery_helper_is_valid_when_everything_is_right(self):
        rec, rerun = self.pair()
        self.forge(rec, rerun)
        self.assertEqual(self.state().state, "verified_reproduced")

    def test_each_identity_rule_alone_is_enough_to_reject(self):
        for label, kw in (("event actor differs", dict(event_actor="someone-else")),):
            rec, rerun = self.pair()
            self.forge(rec, rerun, event_id=f"f-{label[:4]}", **kw)
            self.assertEqual(self.state().state, "inconsistent", label)
            self.assertIn("distinct identity", " ".join(self.state().problems))
        # re-run performed by a different identity than the claimed verifier
        rec2, rerun2 = self.pair(rerun_by="mallory")
        self.forge(rec2, rerun2, event_id="f-rerun-actor")
        self.assertIn("distinct identity", " ".join(self.state().problems))
        # verifier equals the original executor
        self.trust.add_key("vk9", "verifier:runner-a", self.signer.public_key_bytes())
        rec3, rerun3 = self.pair(rerun_by="runner-a")
        self.forge(rec3, rerun3, event_actor="runner-a", verifier_id="runner-a", key="vk9", event_id="f-same")
        self.assertIn("distinct identity", " ".join(self.state().problems))

    def test_a_re_run_with_a_different_spec_is_rejected(self):
        rec, rerun = self.pair(rerun_spec=spec("print('ok')", timeout_s=11.0))
        self.forge(rec, rerun)
        self.assertEqual(self.state().state, "inconsistent")
        self.assertIn("different spec", " ".join(self.state().problems))

    def test_malformed_signature_fields_do_not_crash_evaluation(self):
        rec, rerun = self.pair()
        self.forge(rec, rerun, sig_hex="zz-not-hex", event_id="f1")
        self.forge(rec, rerun, sig_hex="", event_id="f2")
        st = self.state()
        self.assertEqual(st.state, "inconsistent")
        self.assertEqual(sum("signature rejected" in p for p in st.problems), 2)
        ev = [e for e in self.store.read_all() if e.event_id == "f1"][0]
        self.store.append(event_id="f3", event_type=R.VERIFIED, recorded_at=R.NOW, actor="verifier-b",
                          subject_ref="ctp:c1:t1", payload={**ev.payload, "signature_hex": 12345})
        self.assertEqual(self.state().state, "inconsistent")

    def test_state_names_and_event_ids_are_reported(self):
        s = spec("import os; print(os.urandom(8).hex())")
        rec = self.execute(s)
        res = self.verify(rec, s)
        st = self.state()
        self.assertEqual((st.state, st.verification_event_id), ("not_reproduced", res["verification_event_id"]))
        rec2 = self.execute(spec("raise SystemExit(5)"), case="c2")
        res2 = self.verify(rec2, spec("raise SystemExit(5)"), case="c2")
        st2 = self.state("c2")
        self.assertEqual((st2.state, st2.verification_event_id), ("not_confirmable", res2["verification_event_id"]))

    def test_provenance_points_at_the_latest_execution(self):
        self.execute(); latest = self.execute()
        t = R.apply_to_case(make_case(), self.store, self.trust, "t1").tests[0]
        self.assertEqual(t.execution_provenance.execution_id, latest.execution_id)

    def test_a_valid_not_reproduced_vetoes_a_valid_reproduced(self):
        marker = Path(self.tmp.name, "marker"); marker.write_text("A")
        s = spec(f"print(open({str(marker)!r}).read())", isolation="none")
        rec = self.execute(s)
        self.assertEqual(self.verify(rec, s)["verdict"], "reproduced")
        self.assertEqual(self.state().state, "verified_reproduced")
        marker.write_text("B")                                                  # the world changed: a second verifier disagrees
        other = Ed25519Signer.generate("vk2")
        self.trust.add_key("vk2", "verifier:verifier-c", other.public_key_bytes())
        self.assertEqual(self.verify(rec, s, verifier="verifier-c", signer=other)["verdict"], "not_reproduced")
        self.assertEqual(self.state().state, "not_reproduced")
        t = R.apply_to_case(make_case(), self.store, self.trust, "t1").tests[0]
        self.assertEqual(t.status, TestStatus.INCONCLUSIVE)

    def test_two_verifications_of_the_same_test_both_evaluate(self):
        rec = self.execute()
        self.verify(rec)
        other = Ed25519Signer.generate("vk2")
        self.trust.add_key("vk2", "verifier:verifier-c", other.public_key_bytes())
        self.verify(rec, verifier="verifier-c", signer=other)                   # reads a log that already holds a verification
        self.assertEqual(self.state().state, "verified_reproduced")

    def test_invalid_verifier_id_is_refused_before_any_execution(self):
        rec = self.execute()
        before = len(self.store.read_all())
        for bad in ("a b", "", "../x", None, 5):
            with self.assertRaises(R.RunnerError):
                self.verify(rec, verifier=bad)
        self.assertEqual(len(self.store.read_all()), before)

    def test_unknown_execution_lookup_and_replayed_event_id(self):
        with self.assertRaises(R.RunnerError):
            R.store_event_payload(self.store, "0" * 32)
        rec = self.execute()
        res = self.verify(rec)
        ev = next(e for e in self.store.read_all() if e.event_id == res["verification_event_id"])
        with self.assertRaises(Exception):                                     # the store refuses a duplicate event id
            self.store.append(event_id=ev.event_id, event_type=R.VERIFIED, recorded_at=R.NOW, actor="verifier-b",
                              subject_ref="ctp:c1:t1", payload=ev.payload)

    def test_reproduction_verdict_looks_at_every_compared_field(self):
        base = {"spec_digest": "s", "outcome": "pass", "stdout_sha256": "o", "stdout_bytes": 3,
                "environment": {"outputs_sha256": "x", "inputs_intact": True}}
        self.assertEqual(R._reproduction_verdict(base, base), "reproduced")
        for key, other in (("spec_digest", "t"), ("outcome", "fail"), ("stdout_sha256", "p"), ("stdout_bytes", 4)):
            self.assertEqual(R._reproduction_verdict(base, {**base, key: other}), "not_reproduced", key)
        for env in ({"outputs_sha256": "y", "inputs_intact": True}, {"outputs_sha256": "x", "inputs_intact": False}):
            self.assertEqual(R._reproduction_verdict(base, {**base, "environment": env}), "not_reproduced")
            self.assertEqual(R._reproduction_verdict({**base, "environment": env}, base), "not_reproduced")
        for side in (0, 1):
            pair = [base, base]; pair[side] = {**base, "outcome": "inconclusive"}
            self.assertEqual(R._reproduction_verdict(*pair), "not_confirmable")

    def test_signed_message_binds_every_fingerprint(self):
        fields = ("execution_id", "case_id", "test_id", "runner_id", "spec_digest", "argv_digest", "executable_sha256",
                  "code_digests", "input_digest", "outcome", "exit_code", "stdout_sha256", "stderr_sha256")
        mk = lambda tag: {**{f: f"{f}-{tag}" for f in fields}, "environment": {"outputs_sha256": f"o-{tag}"}}
        base = R.verification_message(original=mk("a"), rerun=mk("b"), verdict="reproduced", verifier_id="v", key_id="k")
        seen = {base}
        for side in ("original", "rerun"):
            for f in fields + ("outputs_sha256",):
                o, r = mk("a"), mk("b")
                target = o if side == "original" else r
                if f == "outputs_sha256":
                    target["environment"] = {"outputs_sha256": "changed"}
                else:
                    target[f] = "changed"
                m = R.verification_message(original=o, rerun=r, verdict="reproduced", verifier_id="v", key_id="k")
                self.assertNotIn(m, seen, (side, f)); seen.add(m)
        for kw in (dict(verdict="not_reproduced"), dict(verifier_id="w"), dict(key_id="j")):
            args = dict(original=mk("a"), rerun=mk("b"), verdict="reproduced", verifier_id="v", key_id="k") | kw
            self.assertNotIn(R.verification_message(**args), seen)
        self.assertTrue(base.startswith(R.VERIFICATION_DOMAIN))

    def test_payload_states_its_limits(self):
        rec = self.execute()
        p = R.store_event_payload(self.store, rec.execution_id)
        text = " ".join(p["limitations"])
        for needle in ("same host", "namespaces", "provisional"):
            self.assertIn(needle, text)
        self.assertEqual(len(p["limitations"]), 3)
        self.assertEqual(p["verification"], "unverified")

