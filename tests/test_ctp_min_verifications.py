"""Stage 6 (L-S6-1): a scientific test needs several independent reproductions, not one agreeing re-run."""
from __future__ import annotations

import unittest
from dataclasses import replace

from master_brain import ctp_runner as R
from master_brain.ctp import TestStatus
from master_brain.ctp_registry import (CtpRegistry, MIN_SCIENTIFIC_VERIFICATIONS, RegisteredTest,
                                       RegistryError, builtin_registry)
from tests.test_ctp_runner import ChainBase, make_case, needs_sandbox, spec


class RegistryRule(unittest.TestCase):
    def setUp(self):
        self.base = builtin_registry().get("sha256-known-answer")

    def make(self, **kw):
        return CtpRegistry((RegisteredTest("x", "t", "d", self.base.spec, **kw),))

    def test_new_tests_are_scientific_with_five_verifications_by_default(self):
        t = RegisteredTest("x", "t", "d", self.base.spec)
        self.assertEqual((t.claim_class, t.required_verifications), ("scientific", MIN_SCIENTIFIC_VERIFICATIONS))
        self.assertEqual(MIN_SCIENTIFIC_VERIFICATIONS, 5)
        self.make()

    def test_scientific_test_below_five_is_refused(self):
        for n in (1, 2, 4):
            with self.assertRaises(RegistryError):
                self.make(claim_class="scientific", required_verifications=n)

    def test_bad_values_are_refused(self):
        for kw in (dict(claim_class="other"), dict(required_verifications=0), dict(required_verifications=31),
                   dict(required_verifications=True), dict(required_verifications=5.0)):
            with self.assertRaises(RegistryError):
                self.make(**kw)

    def test_platform_selftests_may_use_one_and_the_builtins_are_exactly_those(self):
        self.make(claim_class="platform-selftest", required_verifications=1)
        for t in builtin_registry().all():
            self.assertEqual((t.claim_class, t.required_verifications), ("platform-selftest", 1))

    def test_registry_digest_reflects_the_requirement(self):
        a = self.make(claim_class="scientific", required_verifications=5).digest()
        b = self.make(claim_class="scientific", required_verifications=6).digest()
        self.assertNotEqual(a, b)


@needs_sandbox
class StateRule(ChainBase):
    def reproductions(self, n):
        rec = self.execute()
        for _ in range(n):
            self.verify(rec)
        return rec

    def st(self, k):
        return R.ctp_test_state(self.store, self.trust, "c1", "t1", min_verifications=k)

    def test_one_reproduction_is_not_enough_for_five(self):
        self.reproductions(1)
        s = self.st(5)
        self.assertEqual(s.state, "executed_unverified")
        self.assertIsNone(s.outcome)
        self.assertTrue(any("1 of 5" in p for p in s.problems))

    def test_four_is_not_enough_five_is(self):
        self.reproductions(4)
        self.assertEqual(self.st(5).state, "executed_unverified")
        self.verify(self.store_original())
        s = self.st(5)
        self.assertEqual((s.state, s.outcome), ("verified_reproduced", "pass"))

    def store_original(self):
        e = next(e for e in self.store.read_all() if e.event_type == R.EXECUTED)
        return type("O", (), {"execution_id": e.payload["execution_id"]})()

    def test_default_keeps_the_old_single_run_behaviour(self):
        self.reproductions(1)
        self.assertEqual(R.ctp_test_state(self.store, self.trust, "c1", "t1").state, "verified_reproduced")

    def test_a_valid_disagreement_is_never_outvoted(self):
        flaky = spec("import os; print(os.urandom(8).hex())")
        rec = self.execute(flaky)
        self.verify(rec, flaky)
        for k in (1, 5):
            s = self.st(k)
            self.assertEqual((s.state, s.outcome), ("not_reproduced", None))

    def test_invalid_min_is_refused(self):
        self.reproductions(1)
        for bad in (0, -1, True, 2.0, "5"):
            with self.assertRaises(R.RunnerError):
                self.st(bad)

    def test_apply_to_case_does_not_grant_pass_below_the_requirement(self):
        self.reproductions(2)
        t = R.apply_to_case(make_case(), self.store, self.trust, "t1", min_verifications=5).tests[0]
        self.assertEqual(t.status, TestStatus.INCONCLUSIVE)
        t = R.apply_to_case(make_case(), self.store, self.trust, "t1", min_verifications=2).tests[0]
        self.assertEqual(t.status, TestStatus.PASS)

    def test_repeated_identical_verification_event_cannot_count_twice(self):
        rec = self.reproductions(1)
        ev = next(e for e in self.store.read_all() if e.event_type == R.VERIFIED)
        with self.assertRaises(Exception):
            self.store.append(event_id=ev.event_id, event_type=R.VERIFIED, recorded_at=R.NOW, actor=ev.actor,
                              subject_ref=ev.subject_ref, payload=dict(ev.payload))
        self.assertEqual(self.st(2).state, "executed_unverified")


if __name__ == "__main__":
    unittest.main()
