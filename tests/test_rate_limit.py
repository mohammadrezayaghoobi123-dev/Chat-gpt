"""Gate 2c: rate limiting - unit tests with a fake clock, then against a REAL running server."""
import json
import tempfile
import threading
import unittest
from pathlib import Path

from master_brain import http_api
from master_brain.rate_limit import (
    FailureThrottle, RateGate, RateLimits, TokenBucketLimiter, retry_after_header,
)
from tests.test_http_api import ALICE, BOB, KEY, Running


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class TokenBucketTests(unittest.TestCase):
    def test_burst_then_refusal_with_exact_wait_then_refill(self):
        c = Clock()
        b = TokenBucketLimiter(2.0, 3, clock=c)
        self.assertEqual([b.acquire("a") for _ in range(3)], [0.0, 0.0, 0.0])
        self.assertAlmostEqual(b.acquire("a"), 0.5)  # 1 token at 2/s
        c.advance(0.5)
        self.assertEqual(b.acquire("a"), 0.0)
        self.assertGreater(b.acquire("a"), 0.0)

    def test_refill_is_capped_at_burst(self):
        c = Clock()
        b = TokenBucketLimiter(1.0, 2, clock=c)
        b.acquire("a")
        c.advance(10_000)
        self.assertEqual([b.acquire("a"), b.acquire("a")], [0.0, 0.0])
        self.assertGreater(b.acquire("a"), 0.0)

    def test_keys_are_independent(self):
        b = TokenBucketLimiter(1.0, 1, clock=Clock())
        self.assertEqual(b.acquire("a"), 0.0)
        self.assertGreater(b.acquire("a"), 0.0)
        self.assertEqual(b.acquire("b"), 0.0)

    def test_memory_is_bounded_least_recently_used_evicted(self):
        b = TokenBucketLimiter(1.0, 1, clock=Clock(), max_keys=3)
        for k in "abcdef":
            b.acquire(k)
        self.assertEqual(b.tracked_keys(), 3)

    def test_clock_going_backwards_never_grants_extra_tokens(self):
        c = Clock()
        b = TokenBucketLimiter(1.0, 1, clock=c)
        b.acquire("a")
        c.advance(-500)
        self.assertGreater(b.acquire("a"), 0.0)

    def test_concurrent_acquires_never_exceed_the_burst(self):
        b = TokenBucketLimiter(1.0, 50, clock=Clock())
        results, lock = [], threading.Lock()

        def go():
            w = b.acquire("k")
            with lock:
                results.append(w)

        threads = [threading.Thread(target=go) for _ in range(300)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sum(1 for w in results if w == 0.0), 50)

    def test_invalid_configuration_is_rejected(self):
        for args in ((0, 1), (-1, 1), (float("inf"), 1), (True, 1), (1, 0), (1, True), (1, 1.5)):
            with self.assertRaises(ValueError, msg=str(args)):
                TokenBucketLimiter(*args)
        for bad in (0, -1, True, 1.5, "3"):
            with self.assertRaises(ValueError, msg=str(bad)):
                TokenBucketLimiter(1, 1, max_keys=bad)
        TokenBucketLimiter(2, 1, max_keys=1)  # whole-number rates are fine

    def test_eviction_drops_the_least_recently_used_key_not_the_newest(self):
        b = TokenBucketLimiter(0.001, 1, clock=Clock(), max_keys=2)
        b.acquire("a"); b.acquire("b"); b.acquire("a")  # a is now the most recent
        b.acquire("c")                                   # evicts b
        self.assertGreater(b.acquire("a"), 0.0)          # a kept its exhausted bucket
        self.assertEqual(b.acquire("b"), 0.0)            # b was forgotten: starts full


class FailureThrottleTests(unittest.TestCase):
    def test_blocks_at_the_limit_and_reports_remaining_window(self):
        c = Clock()
        f = FailureThrottle(3, 60.0, clock=c)
        for _ in range(2):
            f.record_failure("ip")
            self.assertEqual(f.blocked_for("ip"), 0.0)
        f.record_failure("ip")
        self.assertAlmostEqual(f.blocked_for("ip"), 60.0)
        c.advance(25)
        self.assertAlmostEqual(f.blocked_for("ip"), 35.0)
        c.advance(35)
        self.assertEqual(f.blocked_for("ip"), 0.0)

    def test_failures_slide_out_one_by_one(self):
        c = Clock()
        f = FailureThrottle(2, 10.0, clock=c)
        f.record_failure("ip"); c.advance(6); f.record_failure("ip")
        self.assertAlmostEqual(f.blocked_for("ip"), 4.0)  # until the OLDEST failure leaves
        c.advance(5)  # the first failure (11s old) left the window
        self.assertEqual(f.blocked_for("ip"), 0.0)
        f.record_failure("ip")  # now [t6, t11]: blocked until t6 leaves, i.e. 5 more seconds
        self.assertAlmostEqual(f.blocked_for("ip"), 5.0)

    def test_attempts_while_blocked_do_not_extend_the_block(self):
        c = Clock()
        f = FailureThrottle(2, 10.0, clock=c)
        f.record_failure("ip"); f.record_failure("ip")
        for _ in range(50):
            f.record_failure("ip")
        c.advance(10)
        self.assertEqual(f.blocked_for("ip"), 0.0)

    def test_addresses_are_independent_and_memory_is_bounded(self):
        f = FailureThrottle(1, 10.0, clock=Clock(), max_keys=2)
        f.record_failure("a")
        self.assertGreater(f.blocked_for("a"), 0.0)
        self.assertEqual(f.blocked_for("b"), 0.0)
        f.record_failure("b"); f.record_failure("c")
        self.assertEqual(len(f._failures), 2)

    def test_invalid_configuration_is_rejected(self):
        for args in ((0, 1.0), (True, 1.0), (1, 0), (1, float("inf"))):
            with self.assertRaises(ValueError, msg=str(args)):
                FailureThrottle(*args)
        for bad in (0, -1, True, 1.5):
            with self.assertRaises(ValueError, msg=str(bad)):
                FailureThrottle(1, 1.0, max_keys=bad)
        FailureThrottle(1, 5, max_keys=1)  # whole-number window is fine

    def test_eviction_drops_the_least_recently_used_address(self):
        f = FailureThrottle(1, 100.0, clock=Clock(), max_keys=2)
        f.record_failure("a"); f.record_failure("b")
        f.blocked_for("a")            # an address that keeps trying stays "recent" (flooding others cannot evict it)
        f.record_failure("c")         # evicts b, the least recently used
        self.assertEqual(f.blocked_for("b"), 0.0)
        self.assertGreater(f.blocked_for("a"), 0.0)
        self.assertGreater(f.blocked_for("c"), 0.0)


class HelperTests(unittest.TestCase):
    def test_retry_after_is_whole_seconds_rounded_up_and_at_least_one(self):
        self.assertEqual(retry_after_header(0.0), "1")
        self.assertEqual(retry_after_header(0.01), "1")
        self.assertEqual(retry_after_header(1.0), "1")
        self.assertEqual(retry_after_header(1.01), "2")
        self.assertEqual(retry_after_header(59.2), "60")

    def test_defaults_are_generous_for_a_person_and_bounded(self):
        d = RateLimits()
        self.assertEqual((d.per_identity_rate, d.per_identity_burst, d.auth_failure_limit,
                          d.auth_failure_window, d.account_failure_limit, d.account_failure_window, d.max_keys),
                         (20.0, 120, 20, 60.0, 20, 600.0, 10_000))
        with self.assertRaises(Exception):
            d.max_keys = 1  # immutable policy object
        RateGate(d, clock=Clock())  # constructs


class HttpRateLimitTests(unittest.TestCase):
    def start(self, limits, clock=None):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock = clock or Clock()
        self.app = Running(Path(self.tmp.name) / "a.jsonl", rate_gate=RateGate(limits, clock=self.clock))
        self.addCleanup(self.app.close)

    @staticmethod
    def code(body):
        return json.loads(body)["error"]["code"]

    def test_guessing_tokens_is_throttled_and_a_valid_token_earns_no_oracle(self):
        self.start(RateLimits(auth_failure_limit=3, auth_failure_window=60.0))
        for _ in range(3):
            status, _h, _b = self.app.call("GET", "/v1/tasks", token="x" * 40)
            self.assertEqual(status, 401)
        status, headers, body = self.app.call("GET", "/v1/tasks", token="y" * 40)
        self.assertEqual((status, self.code(body)), (429, "rate_limited"))
        self.assertEqual(headers["Retry-After"], "60")
        self.assertEqual(headers.get("Connection"), "close")  # the unread body must not poison a kept-alive socket
        self.clock.advance(59.5)  # even a sub-second remainder is still a refusal, never a free guess
        status, headers, _b = self.app.call("GET", "/v1/tasks", token="y" * 40)
        self.assertEqual((status, headers["Retry-After"]), (429, "1"))
        self.clock.advance(-59.5)
        status, _h, body = self.app.call("GET", "/v1/tasks", token=ALICE)  # correct token, still refused
        self.assertEqual((status, self.code(body)), (429, "rate_limited"))
        self.clock.advance(60)
        status, _h, _b = self.app.call("GET", "/v1/tasks", token=ALICE)
        self.assertEqual(status, 200)

    def test_a_valid_user_is_limited_per_subject_and_others_are_unaffected(self):
        self.start(RateLimits(per_identity_rate=1.0, per_identity_burst=3))
        for _ in range(3):
            self.assertEqual(self.app.call("GET", "/v1/tasks", token=ALICE)[0], 200)
        status, headers, body = self.app.call("GET", "/v1/tasks", token=ALICE)
        self.assertEqual((status, self.code(body)), (429, "rate_limited"))
        self.assertEqual(headers["Retry-After"], "1")
        self.assertEqual(headers.get("Connection"), "close")
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=BOB)[0], 200)
        self.clock.advance(1.0)
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=ALICE)[0], 200)

    def test_a_refused_request_does_nothing_and_says_so_in_the_closed_error_shape(self):
        self.start(RateLimits(per_identity_rate=1.0, per_identity_burst=1))
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=ALICE)[0], 200)
        before = len(self.app.store.read_all())
        status, _h, body = self.app.call("POST", "/v1/missions", {"idempotency_key": KEY, "objective": "x"})
        self.assertEqual(status, 429)
        err = json.loads(body)["error"]
        self.assertEqual(err["code"], "rate_limited")
        self.assertTrue(err["retryable"])
        self.assertIn("nothing was executed", err["message"])
        self.assertEqual(set(err), {"code", "message", "retryable", "correlation_id"})
        self.assertEqual(len(self.app.store.read_all()), before)  # not even a mission was recorded
        self.clock.advance(1.0)  # the same request, retried with the same key, succeeds exactly once
        self.assertEqual(self.app.call("POST", "/v1/missions", {"idempotency_key": KEY, "objective": "x"})[0], 201)
        self.clock.advance(1.0)
        self.assertEqual(self.app.call("POST", "/v1/missions", {"idempotency_key": KEY, "objective": "x"})[0], 200)

    def test_public_client_files_do_not_consume_an_identity_budget(self):
        self.start(RateLimits(per_identity_rate=1.0, per_identity_burst=1))
        for _ in range(20):
            self.assertEqual(self.app.call("GET", "/app/", token=None)[0], 200)
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=ALICE)[0], 200)

    def test_unauthenticated_requests_count_only_as_failures(self):
        self.start(RateLimits(auth_failure_limit=2, auth_failure_window=30.0))
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=None)[0], 401)
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=None)[0], 401)
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=None)[0], 429)

    def test_the_server_enables_limits_by_default(self):
        seen = []
        real = http_api.RateGate

        class Spy(real):
            def __init__(self, *a, **k):
                seen.append((a, k))
                super().__init__(*a, **k)

        http_api.RateGate = Spy
        try:
            tmp = tempfile.TemporaryDirectory()
            self.addCleanup(tmp.cleanup)
            app = Running(Path(tmp.name) / "a.jsonl")
            self.addCleanup(app.close)
        finally:
            http_api.RateGate = real
        self.assertEqual(len(seen), 1)
        self.assertEqual(app.call("GET", "/v1/tasks")[0], 200)


if __name__ == "__main__":
    unittest.main()
