"""Gate 2c-2: login / whoami / logout over a REAL server; cookie security, CSRF, Host and throttling."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from pathlib import Path

from master_brain.accounts import AccountStore
from master_brain.rate_limit import RateGate, RateLimits
from tests.test_http_api import ALICE, KEY, Running

PW = "correct horse battery"


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


class Mono:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class SessionBase(unittest.TestCase):
    limits = RateLimits()
    secure = False

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock = Clock()
        self.accounts = AccountStore(Path(self.tmp.name) / "id.sqlite", clock=self.clock)
        self.accounts.create_account("user:carol", PW)
        self.accounts.create_account("user:dave", PW)
        self.accounts.create_account("user:opsy", PW, ("operator",))
        self.mono = Mono()
        self.gate = RateGate(self.limits, clock=self.mono)
        self.app = Running(Path(self.tmp.name) / "a.jsonl", accounts=self.accounts, secure_cookies=self.secure,
                           rate_gate=self.gate)
        self.addCleanup(self.app.close)
        self.origin = f"{'https' if self.secure else 'http'}://127.0.0.1:{self.app.port}"

    def login(self, subject="user:carol", password=PW, headers=None):
        return self.app.call("POST", "/v1/session", {"subject": subject, "password": password}, token=None, headers=headers)

    def cookie_of(self, headers):
        jar = SimpleCookie()
        jar.load(headers["Set-Cookie"])
        return jar["mb_session"].value

    def session(self, subject="user:carol"):
        status, headers, _ = self.login(subject)
        self.assertEqual(status, 201)
        return f"mb_session={self.cookie_of(headers)}"

    def call(self, method, path, cookie, body=None, origin="same", extra=None):
        h = {"Cookie": cookie}
        if origin == "same":
            h["Origin"] = self.origin
        elif origin:
            h["Origin"] = origin
        h.update(extra or {})
        return self.app.call(method, path, body, token=None, headers=h)


class LoginTests(SessionBase):
    def test_success_sets_a_locked_down_cookie_and_returns_no_token_in_the_body(self):
        status, headers, body = self.login()
        self.assertEqual(status, 201)
        data = json.loads(body)
        self.assertEqual((data["subject"], data["roles"], data["idle_timeout_seconds"]), ("user:carol", [], 1800))
        self.assertTrue(data["expires_at"].endswith("Z"))
        token = self.cookie_of(headers)
        self.assertNotIn(token.encode(), body)
        cookie = headers["Set-Cookie"]
        for attr in ("HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=28800"):
            self.assertIn(attr, cookie)
        self.assertNotIn("Secure", cookie)  # plain-http loopback; see the secure_cookies test
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn(PW.encode(), body)

    def test_the_cookie_authenticates_the_api_and_whoami_reports_the_session(self):
        cookie = self.session()
        self.assertEqual(self.call("GET", "/v1/tasks", cookie, origin=None)[0], 200)
        status, _h, body = self.call("GET", "/v1/session", cookie, origin=None)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["subject"], "user:carol")

    def test_every_login_failure_looks_the_same(self):
        self.accounts.set_disabled("user:dave", True)
        shapes = set()
        for subject, password in (("user:carol", "wrong password!!"), ("user:nobody", PW), ("user:dave", PW)):
            status, headers, body = self.login(subject, password)
            self.assertEqual(status, 401)
            self.assertNotIn("Set-Cookie", headers)
            err = json.loads(body)["error"]
            shapes.add((err["code"], err["message"], err["retryable"]))
        self.assertEqual(len(shapes), 1)

    def test_strict_request_and_content_type(self):
        for body in ({"subject": "user:carol"}, {"subject": "user:carol", "password": PW, "x": 1},
                     {"subject": "bad subject", "password": PW}, {"subject": "user:carol", "password": 5}):
            self.assertEqual(self.app.call("POST", "/v1/session", body, token=None)[0], 400, body)
        status, _h, _b = self.app.call("POST", "/v1/session", token=None, raw=b"subject=a&password=b",
                                       headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 400)

    def test_a_failed_login_never_echoes_the_submitted_password(self):
        status, _h, body = self.login("user:carol", "super-secret-attempt-123")
        self.assertEqual(status, 401)
        self.assertNotIn(b"super-secret", body)

    def test_login_from_a_foreign_origin_is_refused_but_no_origin_or_same_origin_is_fine(self):
        self.assertEqual(self.login(headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.login(headers={"Origin": "null"})[0], 403)
        self.assertEqual(self.login(headers={"Origin": self.origin})[0], 201)
        self.assertEqual(self.login()[0], 201)

    def test_secure_flag_is_added_only_when_asked(self):
        self.app.close()
        self.secure = True
        self.setUp.__func__(self)  # restart with secure cookies
        status, headers, _b = self.login()
        self.assertEqual(status, 201)
        self.assertIn("; Secure", headers["Set-Cookie"])
        self.assertEqual(self.login(headers={"Origin": f"http://127.0.0.1:{self.app.port}"})[0], 403)  # wrong scheme


class CsrfAndCredentialTests(SessionBase):
    def test_cookie_authenticated_changes_need_a_same_origin_header(self):
        cookie = self.session()
        body = {"idempotency_key": KEY, "objective": "x", "success_criteria": ["y"]}
        for origin in (None, "http://evil.example", "null", f"http://127.0.0.1:{self.app.port + 1}"):
            status, _h, raw = self.call("POST", "/v1/missions", cookie, body, origin=origin)
            self.assertEqual((status, json.loads(raw)["error"]["code"]), (403, "forbidden"), origin)
        self.assertEqual(len(self.app.store.read_all()), 0)  # nothing happened
        self.assertEqual(self.call("POST", "/v1/missions", cookie, body)[0], 201)

    def test_reads_do_not_need_an_origin(self):
        cookie = self.session()
        self.assertEqual(self.call("GET", "/v1/tasks", cookie, origin=None)[0], 200)

    def test_bearer_tokens_are_not_ambient_so_they_need_no_origin(self):
        body = {"idempotency_key": KEY, "objective": "x", "success_criteria": ["y"]}
        self.assertEqual(self.app.call("POST", "/v1/missions", body, token=ALICE)[0], 201)

    def test_an_authorization_header_wins_over_a_valid_cookie(self):
        cookie = self.session()
        status, _h, _b = self.app.call("GET", "/v1/tasks", token="bad-token-" + "x" * 30, headers={"Cookie": cookie})
        self.assertEqual(status, 401)
        status, _h, _b = self.app.call("GET", "/v1/tasks", token=None, headers={"Cookie": cookie, "Authorization": "Basic abc"})
        self.assertEqual(status, 401)

    def test_only_the_bearer_scheme_is_accepted_even_if_a_valid_token_follows_a_seven_char_prefix(self):
        cookie = self.session()
        token = cookie.split("=", 1)[1]
        for header in (f"Basics {token}", f"Bearer{token}", f"bearer {token}", f"Bearer  {token}"):
            self.assertEqual(self.app.call("GET", "/v1/tasks", token=None, headers={"Authorization": header})[0], 401, header)
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=None, headers={"Authorization": f"Bearer {token}"})[0], 200)

    def test_every_refusal_that_leaves_the_body_unread_closes_the_connection(self):
        cookie = self.session()
        body = {"idempotency_key": KEY, "objective": "x", "success_criteria": ["y"]}
        _s, headers, _b = self.call("POST", "/v1/missions", cookie, body, origin=None)  # CSRF refusal
        self.assertEqual(headers.get("Connection"), "close")
        _s, headers, _b = self.login(headers={"Origin": "http://evil.example"})        # login CSRF refusal
        self.assertEqual(headers.get("Connection"), "close")
        _s, headers, _b = self.app.call("POST", "/v1/missions", body, token=None, headers={"Host": "evil.example"})
        self.assertEqual(headers.get("Connection"), "close")                           # Host refusal
        _s, headers, _b = self.app.call("POST", "/app/", token=None, raw=b"{}")        # static + wrong method
        self.assertEqual(headers.get("Connection"), "close")

    def test_junk_oversized_and_foreign_cookies_are_just_unauthenticated(self):
        cookie = self.session()
        token = cookie.split("=", 1)[1]
        for header in ("", "mb_session=", "mb_session", "\x00", "other=1", f"other={token}", "mb_session=" + "A" * 5000,
                       "mb_session=bad token with spaces", ";;;;", "=" + token):
            status, _h, _b = self.app.call("GET", "/v1/tasks", token=None, headers={"Cookie": header})
            self.assertEqual(status, 401, header[:30])
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=None, headers={"Cookie": f"a=1; mb_session={token}; b=2"})[0], 200)

    def test_logout_revokes_the_session_and_clears_the_cookie(self):
        cookie = self.session()
        self.assertEqual(self.call("DELETE", "/v1/session", cookie, origin=None)[0], 403)  # logout CSRF
        status, headers, body = self.call("DELETE", "/v1/session", cookie)
        self.assertEqual((status, json.loads(body)["signed_out"]), (200, True))
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertEqual(self.call("GET", "/v1/tasks", cookie, origin=None)[0], 401)

    def test_whoami_with_a_static_token_is_not_found_not_a_crash(self):
        self.assertEqual(self.app.call("GET", "/v1/session", token=ALICE)[0], 404)

    def test_idle_expiry_and_account_changes_apply_immediately(self):
        cookie = self.session()
        self.clock.advance(minutes=29)
        self.assertEqual(self.call("GET", "/v1/tasks", cookie, origin=None)[0], 200)
        self.clock.advance(minutes=31)
        self.assertEqual(self.call("GET", "/v1/tasks", cookie, origin=None)[0], 401)
        cookie = self.session("user:dave")
        self.accounts.set_disabled("user:dave", True)
        self.assertEqual(self.call("GET", "/v1/tasks", cookie, origin=None)[0], 401)

    def test_roles_come_from_the_account_not_from_the_request(self):
        carol, ops = self.session(), self.session("user:opsy")
        body = {"idempotency_key": KEY, "objective": "x", "success_criteria": ["y"]}
        mission = json.loads(self.call("POST", "/v1/missions", carol, body)[2])["mission_id"]
        self.assertEqual(self.call("GET", f"/v1/missions/{mission}/audit", ops, origin=None)[0], 200)  # operator may read
        dave = self.session("user:dave")
        self.assertEqual(self.call("GET", f"/v1/missions/{mission}/audit", dave, origin=None)[0], 404)
        self.accounts.set_roles("user:opsy", ())
        self.assertEqual(self.call("GET", f"/v1/missions/{mission}/audit", ops, origin=None)[0], 404)  # revoked at once

    def test_session_routes_do_not_exist_without_an_account_store(self):
        self.app.close()
        import tempfile as _t
        with _t.TemporaryDirectory() as d:
            app = Running(Path(d) / "a.jsonl")
            try:
                self.assertEqual(app.call("POST", "/v1/session", {"subject": "a", "password": "b"}, token=None)[0], 404)
                self.assertEqual(app.call("GET", "/v1/session", token=ALICE)[0], 404)
            finally:
                app.close()


class HostAndThrottleTests(SessionBase):
    def test_unexpected_host_headers_are_refused_everywhere(self):
        for host in ("evil.example", "evil.example:%d", "127.0.0.1", "localhost", "127.0.0.1:1", ""):
            host = host.replace("%d", str(self.app.port))
            for path in ("/app/", "/v1/tasks"):
                status, _h, _b = self.app.call("GET", path, token=ALICE, headers={"Host": host})
                self.assertEqual(status, 400, (host, path))
        for host in (f"127.0.0.1:{self.app.port}", f"LOCALHOST:{self.app.port}"):
            self.assertEqual(self.app.call("GET", "/v1/tasks", token=ALICE, headers={"Host": host})[0], 200, host)

    def test_login_attempts_feed_both_throttles_and_a_locked_account_cannot_log_in_even_with_the_right_password(self):
        self.app.close()
        self.limits = RateLimits(account_failure_limit=3, account_failure_window=600.0, auth_failure_limit=50)
        self.setUp.__func__(self)
        for _ in range(3):
            self.assertEqual(self.login("user:carol", "wrong password!!")[0], 401)
        status, headers, body = self.login("user:carol", PW)
        self.assertEqual((status, json.loads(body)["error"]["code"]), (429, "rate_limited"))
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(headers["Retry-After"], "600")
        self.assertEqual(self.login("user:dave", PW)[0], 201)  # other accounts are unaffected

    def test_sub_second_remainders_are_still_refusals(self):
        self.app.close()
        self.limits = RateLimits(auth_failure_limit=1, auth_failure_window=60.0, account_failure_limit=1,
                                 account_failure_window=100.0, per_identity_rate=1.0, per_identity_burst=1)
        self.setUp.__func__(self)
        self.assertEqual(self.login("user:carol", "wrong password!!")[0], 401)  # one failure: address AND account at the limit
        self.mono.advance(59.5)  # the address window has 0.5s left, the account window 40.5s
        status, headers, _b = self.login("user:dave", PW)
        self.assertEqual((status, headers["Retry-After"], headers.get("Connection")), (429, "1", "close"))
        self.mono.advance(1.0)   # address free again; the carol account is still locked
        status, headers, _b = self.login("user:carol", PW)
        self.assertEqual((status, headers["Retry-After"]), (429, "40"))
        self.assertEqual(self.app.call("GET", "/v1/tasks", token=ALICE)[0], 200)  # uses the only identity token
        self.mono.advance(0.5)
        status, headers, _b = self.app.call("GET", "/v1/tasks", token=ALICE)
        self.assertEqual((status, headers["Retry-After"], headers.get("Connection")), (429, "1", "close"))

    def test_login_failures_from_one_address_are_throttled_across_accounts(self):
        self.app.close()
        self.limits = RateLimits(auth_failure_limit=3, auth_failure_window=60.0)
        self.setUp.__func__(self)
        for subject in ("user:a1", "user:a2", "user:a3"):
            self.assertEqual(self.login(subject, "whatever-password")[0], 401)
        self.assertEqual(self.login("user:carol", PW)[0], 429)  # the guesser's address is blocked

    def test_unknown_subjects_are_throttled_too_without_unbounded_memory(self):
        self.app.close()
        self.limits = RateLimits(account_failure_limit=1, account_failure_window=600.0, auth_failure_limit=500, max_keys=5)
        self.setUp.__func__(self)
        for i in range(40):
            self.login(f"user:ghost{i}", "whatever-password")
        self.assertLessEqual(len(self.gate._accounts._failures), 5)  # bounded no matter how many names are tried
        self.assertLessEqual(len(self.gate._failures._failures), 5)


if __name__ == "__main__":
    unittest.main()
