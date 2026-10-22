"""Gate 2c-4: the tamper-evident security log (sign-ins, refusals, account changes)."""
import json
import os
import tempfile
import unittest
from pathlib import Path

from master_brain.accounts import AccountError, AccountStore
from master_brain.audit_store import AuditStoreError
from master_brain.security_log import (
    SecurityLog, SecurityLogError, attempted_subject_ref, clean_address,
)
from tests.test_http_api import KEY, Running
from master_brain.rate_limit import RateLimits
from tests.test_http_sessions import Clock, Mono, PW, SessionBase


class Units(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "s.jsonl"

    def log(self, **kw):
        self.mono = Mono()
        return SecurityLog(self.path, monotonic=self.mono, **kw)

    def test_helpers_never_keep_attacker_text(self):
        self.assertEqual(attempted_subject_ref("user:carol"), "account:user:carol")
        for bad in ("<script>", "a b", "", "x" * 129, None, 5):
            self.assertEqual(attempted_subject_ref(bad), "account:invalid")
        self.assertEqual(clean_address("127.0.0.1"), "127.0.0.1")
        self.assertEqual(clean_address("::1"), "::1")
        for bad in ("a b", "", "x" * 65, None, "1.2.3.4\nforged"):
            self.assertEqual(clean_address(bad), "unknown")

    def test_critical_events_are_chained_and_verified_on_read(self):
        log = self.log()
        log.critical("security.logout", actor="user:a", subject_ref="account:user:a", payload={"address": "1.1.1.1"})
        log.critical("security.logout", actor="user:b", subject_ref="account:user:b", payload={"address": "1.1.1.2"})
        events = log.read_all()
        self.assertEqual([e.actor for e in events], ["user:a", "user:b"])
        self.assertEqual(events[1].previous_hash, events[0].event_hash)

    def test_tampering_with_the_file_is_detected(self):
        log = self.log()
        log.critical("security.logout", actor="user:a", subject_ref="account:user:a", payload={"address": "1.1.1.1"})
        log.critical("security.logout", actor="user:b", subject_ref="account:user:b", payload={"address": "1.1.1.2"})
        self.path.write_text(self.path.read_text().replace("user:a", "user:z", 1))
        with self.assertRaises(AuditStoreError):
            log.read_all()

    def test_a_secret_can_never_be_written(self):
        log = self.log()
        with self.assertRaises(SecurityLogError):
            log.critical("security.logout", actor="u", subject_ref="account:u", payload={"address": "x", "password": "p"})
        with self.assertRaises(SecurityLogError):
            log.critical("security.logout", actor="u", subject_ref="account:u", payload={"address": "x", "extra": 1})
        self.assertFalse(self.path.exists() and self.path.read_text())

    def test_best_effort_is_capped_per_window_and_summarised(self):
        log = self.log(window_seconds=60, max_best_effort_per_window=3)
        kw = dict(actor="anonymous", subject_ref="account:invalid", payload={"address": "9.9.9.9", "reason": "bad_credentials"})
        written = [log.best_effort("security.login_failed", **kw) for _ in range(10)]
        self.assertEqual(written, [True] * 3 + [False] * 7)
        self.assertEqual(len(log.read_all()), 3)
        log.critical("security.logout", actor="u", subject_ref="account:u", payload={"address": "x"})  # never capped
        self.mono.advance(61)
        self.assertTrue(log.best_effort("security.login_failed", **kw))
        types = [(e.event_type, e.payload) for e in log.read_all()]
        self.assertIn(("security.events_suppressed", {"count": 7, "window_seconds": 60}), types)
        self.assertEqual(types[-1][0], "security.login_failed")
        self.assertEqual(sum(t == "security.events_suppressed" for t, _ in types), 1)

    def test_a_clock_that_goes_backwards_cannot_widen_the_cap(self):
        log = self.log(window_seconds=60, max_best_effort_per_window=1)
        kw = dict(actor="anonymous", subject_ref="account:invalid", payload={"address": "9.9.9.9", "reason": "bad_credentials"})
        self.assertTrue(log.best_effort("security.login_failed", **kw))
        self.assertFalse(log.best_effort("security.login_failed", **kw))
        self.mono.advance(-5)
        self.assertTrue(log.best_effort("security.login_failed", **kw))  # window restarts, still capped at 1
        self.assertFalse(log.best_effort("security.login_failed", **kw))

    def test_best_effort_never_raises_when_the_log_is_unwritable(self):
        log = self.log()
        self.path.mkdir()  # a directory where the file should be
        self.assertIs(log.best_effort("security.logout", actor="u", subject_ref="account:u", payload={"address": "x"}), False)
        with self.assertRaises(SecurityLogError):
            log.critical("security.logout", actor="u", subject_ref="account:u", payload={"address": "x"})

    def test_invalid_configuration_is_refused(self):
        for kw in ({"window_seconds": 0}, {"max_best_effort_per_window": 0}):
            with self.assertRaises(ValueError):
                SecurityLog(self.path, **kw)


class AccountChanges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "id.sqlite"
        self.accounts = AccountStore(self.db)

    def changes(self):
        return [(e.actor, e.subject_ref, e.payload) for e in self.accounts.security_log.read_all()]

    def test_every_account_change_is_recorded_by_the_operator_without_secrets(self):
        a = self.accounts
        a.create_account("user:boss", PW, ("approver",), actor="operator:me")
        a.set_roles("user:boss", ("operator",), actor="operator:me")
        a.set_password("user:boss", PW + "-new", actor="operator:me")
        a.set_disabled("user:boss", True, actor="operator:me")
        a.set_disabled("user:boss", False, actor="operator:me")
        self.assertEqual(self.changes(), [
            ("operator:me", "account:user:boss", {"change": "created", "roles": ["approver"]}),
            ("operator:me", "account:user:boss", {"change": "roles_set", "roles": ["operator"]}),
            ("operator:me", "account:user:boss", {"change": "password_changed"}),
            ("operator:me", "account:user:boss", {"change": "disabled"}),
            ("operator:me", "account:user:boss", {"change": "enabled"}),
        ])
        text = a.security_log.path.read_text()
        self.assertNotIn(PW, text)

    def test_default_actor_is_the_os_user_and_the_log_sits_beside_the_database(self):
        self.accounts.create_account("user:x", PW)
        self.assertTrue(self.accounts.security_log.path.name == "id.security.jsonl")
        (actor, _, _), = self.changes()
        self.assertTrue(actor.startswith("operator:") and len(actor) > len("operator:"))

    def test_a_refused_change_leaves_no_event(self):
        self.accounts.create_account("user:x", PW)
        before = len(self.changes())
        for call in (lambda: self.accounts.create_account("user:x", PW),            # duplicate
                     lambda: self.accounts.set_roles("user:ghost", ("operator",)),   # unknown
                     lambda: self.accounts.set_roles("user:x", ("root",)),           # unknown role
                     lambda: self.accounts.set_password("user:ghost", PW),
                     lambda: self.accounts.set_disabled("user:ghost", True),
                     lambda: self.accounts.set_password("user:x", "short")):         # policy
            with self.assertRaises((AccountError, ValueError)):
                call()
        self.assertEqual(len(self.changes()), before)

    def test_without_a_writable_log_the_change_is_refused_and_not_applied(self):
        self.accounts.create_account("user:x", PW)
        path = self.accounts.security_log.path
        os.replace(path, str(path) + ".bak")
        path.mkdir()  # the log can no longer be written
        for call in (lambda: self.accounts.create_account("user:y", PW),
                     lambda: self.accounts.set_roles("user:x", ("operator",)),
                     lambda: self.accounts.set_disabled("user:x", True),
                     lambda: self.accounts.set_password("user:x", PW + "-new")):
            with self.assertRaises(AccountError):
                call()
        self.assertEqual(self.accounts.active_roles("user:x"), frozenset())
        self.assertIsNone(self.accounts.verify_password("user:y", PW))
        self.assertIsNotNone(self.accounts.verify_password("user:x", PW))


class HttpEvents(SessionBase):
    # the address limit is high so that the ACCOUNT lock (not the address block) is what triggers here
    limits = RateLimits(auth_failure_limit=1000, account_failure_limit=5)

    def events(self):
        return [(e.event_type, e.actor, e.subject_ref, dict(e.payload)) for e in self.accounts.security_log.read_all()
                if e.event_type != "security.account_changed"]

    def test_sign_in_and_sign_out_are_recorded_without_the_token(self):
        status, headers, _ = self.login()
        self.assertEqual(status, 201)
        cookie = self.cookie_of(headers)
        self.app.call("DELETE", "/v1/session", token=None, headers={"Cookie": f"mb_session={cookie}", "Origin": self.origin})
        self.assertEqual(self.events(), [
            ("security.login_succeeded", "user:carol", "account:user:carol", {"address": "127.0.0.1"}),
            ("security.logout", "user:carol", "account:user:carol", {"address": "127.0.0.1"}),
        ])
        raw = self.accounts.security_log.path.read_text()
        self.assertNotIn(cookie, raw)
        self.assertNotIn(PW, raw)

    def test_failures_record_the_attempt_not_the_attacker_text(self):
        self.assertEqual(self.login(password="wrong password!!")[0], 401)
        self.assertEqual(self.login(subject="user:nobody")[0], 401)
        self.assertEqual(self.login(subject="<img src=x onerror=1>")[0], 400)  # rejected at parsing: no event at all
        self.assertEqual(self.events(), [
            ("security.login_failed", "anonymous", "account:user:carol", {"address": "127.0.0.1", "reason": "bad_credentials"}),
            ("security.login_failed", "anonymous", "account:user:nobody", {"address": "127.0.0.1", "reason": "bad_credentials"}),
        ])
        raw = self.accounts.security_log.path.read_text()
        self.assertNotIn("wrong password", raw)
        self.assertNotIn("<img", raw)

    def test_a_locked_account_and_a_blocked_address_are_recorded_as_throttled(self):
        for _ in range(self.limits.account_failure_limit):
            self.login(password="wrong password!!")
        status, _, _ = self.login()  # correct password but the account is locked
        self.assertEqual(status, 429)
        throttled = [e for e in self.events() if e[0] == "security.login_throttled"]
        self.assertEqual(len(throttled), 1, self.events())
        self.assertEqual(throttled[0][1:], ("anonymous", "account:user:carol", {"address": "127.0.0.1", "scope": "account"}))

    def test_no_session_is_issued_when_the_security_log_cannot_be_written(self):
        path = self.accounts.security_log.path
        os.replace(path, str(path) + ".bak")
        path.mkdir()
        status, headers, body = self.login()
        self.assertEqual(status, 503, body)
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.accounts.session_count("user:carol"), 0)

    def test_sign_out_still_works_when_the_log_is_unwritable(self):
        status, headers, _ = self.login()
        cookie = self.cookie_of(headers)
        path = self.accounts.security_log.path
        os.replace(path, str(path) + ".bak")
        path.mkdir()
        out = self.app.call("DELETE", "/v1/session", token=None, headers={"Cookie": f"mb_session={cookie}", "Origin": self.origin})
        self.assertEqual(out[0], 200)
        self.assertEqual(self.accounts.session_count("user:carol"), 0)

    def test_a_flood_of_failures_cannot_grow_the_log_without_bound(self):
        cap = 60
        for i in range(cap + 15):
            self.login(subject=f"user:flood{i}", password="wrong password!!")
        failed = [e for e in self.events() if e[0] == "security.login_failed"]
        self.assertLessEqual(len(failed), cap)

    def test_a_failed_login_response_is_unchanged_by_logging(self):
        status, _, payload = self.login(password="wrong password!!")
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(payload)["error"]["code"], "unauthenticated")


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "s.jsonl"
        log = SecurityLog(self.path)
        for who in ("user:a", "user:b", "user:c"):
            log.critical("security.logout", actor=who, subject_ref="account:" + who, payload={"address": "1.1.1.1"})

    def run_cli(self, *argv):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from master_brain import security_log
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = security_log._main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_verify_reports_the_event_count_and_head_of_an_intact_log(self):
        code, out, _ = self.run_cli("--path", str(self.path), "verify")
        self.assertEqual(code, 0)
        head = SecurityLog(self.path).read_all()[-1].event_hash
        self.assertEqual(out.strip(), f"ok: 3 events, head {head}")

    def test_verify_fails_on_tampering_truncation_and_a_missing_log(self):
        self.path.write_text(self.path.read_text().replace("user:b", "user:z", 1))
        code, out, err = self.run_cli("--path", str(self.path), "verify")
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(err.startswith("error:"))
        code, _, err = self.run_cli("--path", str(Path(self.tmp.name) / "none.jsonl"), "verify")
        self.assertEqual(code, 1)
        self.assertIn("no such log", err)

    def test_verify_detects_tail_truncation_through_the_anchor(self):
        lines = self.path.read_text().splitlines(keepends=True)
        self.path.write_text("".join(lines[:-1]))
        self.assertEqual(self.run_cli("--path", str(self.path), "verify")[0], 1)

    def test_tail_prints_the_newest_events_and_refuses_a_broken_log(self):
        code, out, _ = self.run_cli("--path", str(self.path), "tail", "--count", "2")
        self.assertEqual(code, 0)
        rows = out.strip().splitlines()
        self.assertEqual(len(rows), 2)
        self.assertIn("user:b", rows[0])
        self.assertIn("user:c", rows[1])
        self.assertIn("security.logout", rows[1])
        self.path.write_text(self.path.read_text().replace("user:b", "user:z", 1))
        code, out, _ = self.run_cli("--path", str(self.path), "tail")
        self.assertEqual((code, out), (1, ""))  # never print events from a log that fails verification

    def test_tail_count_must_be_positive(self):
        with self.assertRaises(SystemExit):
            self.run_cli("--path", str(self.path), "tail", "--count", "0")


class AddressThrottleEvents(SessionBase):
    limits = RateLimits(auth_failure_limit=3, account_failure_limit=1000)

    def test_a_blocked_address_is_recorded_without_naming_any_account(self):
        for i in range(self.limits.auth_failure_limit):
            self.login(subject=f"user:guess{i}", password="wrong password!!")
        self.assertEqual(self.login()[0], 429)  # even the right password is refused while blocked
        events = [(e.event_type, e.actor, e.subject_ref, dict(e.payload)) for e in self.accounts.security_log.read_all()
                  if e.event_type == "security.login_throttled"]
        self.assertEqual(events, [("security.login_throttled", "anonymous", "account:unknown",
                                   {"address": "127.0.0.1", "scope": "address"})])


class ClosedVocabulary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = SecurityLog(Path(self.tmp.name) / "s.jsonl")

    def refuse(self, event_type, payload):
        with self.assertRaises(SecurityLogError):
            self.log.critical(event_type, actor="anonymous", subject_ref="account:invalid", payload=payload)
        self.assertEqual(self.log.read_all(), ())

    def test_values_outside_the_closed_sets_are_refused_and_nothing_is_written(self):
        self.refuse("security.account_changed", {"change": "made_admin"})
        self.refuse("security.account_changed", {"change": "created", "roles": ["root"]})
        self.refuse("security.account_changed", {"change": "created", "roles": "operator"})
        self.refuse("security.login_throttled", {"address": "1.1.1.1", "scope": "global"})
        self.refuse("security.login_failed", {"address": "1.1.1.1", "reason": "user typed: hunter2"})
        self.refuse("security.logout", {"address": "<script>"})

    def test_every_documented_value_is_accepted(self):
        for change in ("created", "roles_set", "disabled", "enabled", "password_changed"):
            self.log.critical("security.account_changed", actor="operator:me", subject_ref="account:user:x",
                              payload={"change": change})
        for scope in ("address", "account"):
            self.log.critical("security.login_throttled", actor="anonymous", subject_ref="account:unknown",
                              payload={"address": "::1", "scope": scope})
        self.log.critical("security.account_changed", actor="operator:me", subject_ref="account:user:x",
                          payload={"change": "roles_set", "roles": ["approver", "operator"]})
        self.log.critical("security.login_failed", actor="anonymous", subject_ref="account:user:x",
                          payload={"address": "127.0.0.1", "reason": "bad_credentials"})
        self.assertEqual(len(self.log.read_all()), 9)


class Defaults(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "s.jsonl"

    def write(self, log, n):
        return [log.best_effort("security.logout", actor="user:a", subject_ref="account:user:a",
                                payload={"address": "1.1.1.1"}) for _ in range(n)]

    def test_the_default_cap_is_sixty_per_window(self):
        log = SecurityLog(self.path, monotonic=lambda: 0.0)
        results = self.write(log, 61)
        self.assertEqual((results.count(True), results[-1]), (60, False))

    def test_a_sub_second_window_and_a_cap_of_one_are_valid(self):
        SecurityLog(self.path, window_seconds=0.5, max_best_effort_per_window=1)

    def test_a_suppressed_count_is_reported_once_and_not_carried_into_later_windows(self):
        now = [0.0]
        log = SecurityLog(self.path, monotonic=lambda: now[0], window_seconds=10, max_best_effort_per_window=1)
        self.write(log, 3)          # 1 written, 2 suppressed
        now[0] = 10.0
        self.write(log, 1)          # new window: the summary (2) is written, then the event
        now[0] = 20.0
        self.write(log, 1)          # nothing was suppressed in the last window: no summary
        summaries = [e.payload for e in log.read_all() if e.event_type == "security.events_suppressed"]
        self.assertEqual(summaries, [{"count": 2, "window_seconds": 10}])


class CliArguments(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "s.jsonl"
        log = SecurityLog(self.path)
        for i in range(25):
            log.critical("security.logout", actor="user:a", subject_ref="account:user:a",
                         payload={"address": "1.1.1.1"})

    def run_cli(self, *argv):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from master_brain import security_log
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            try:
                code = security_log._main(list(argv))
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue()

    def test_required_arguments_are_enforced(self):
        self.assertEqual(self.run_cli("verify")[0], 2)                     # --path missing
        self.assertEqual(self.run_cli("--path", str(self.path))[0], 2)     # sub-command missing

    def test_tail_defaults_to_twenty_and_accepts_one(self):
        self.assertEqual(len(self.run_cli("--path", str(self.path), "tail")[1].splitlines()), 20)
        self.assertEqual(len(self.run_cli("--path", str(self.path), "tail", "--count", "1")[1].splitlines()), 1)


class AccountEdges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "id.sqlite"
        self.accounts = AccountStore(self.db)
        self.accounts.create_account("user:x", PW, actor="operator:me")

    def test_the_operator_name_is_cleaned_and_capped(self):
        from unittest import mock
        from master_brain.accounts import operator_actor
        with mock.patch("getpass.getuser", return_value="a b/c" + "z" * 200):
            name = operator_actor()
        self.assertTrue(name.startswith("operator:a_b_c"))
        self.assertEqual(len(name), len("operator:") + 100)
        for empty in ("",):
            with mock.patch("getpass.getuser", return_value=empty):
                self.assertEqual(operator_actor(), "operator:unknown")
        with mock.patch("getpass.getuser", side_effect=OSError):
            self.assertEqual(operator_actor(), "operator:unknown")

    def test_a_lost_race_after_the_existence_check_is_still_a_clean_refusal(self):
        from unittest import mock
        with mock.patch.object(self.accounts, "_exists", return_value=False):
            with self.assertRaises(AccountError):
                self.accounts.create_account("user:x", PW + "-2", actor="operator:me")
        with mock.patch.object(self.accounts, "_exists", return_value=True):
            with self.assertRaises(AccountError):
                self.accounts.set_password("user:ghost", PW, actor="operator:me")
            with self.assertRaises(AccountError):
                self.accounts.set_disabled("user:ghost", True, actor="operator:me")
            with self.assertRaises(AccountError):
                self.accounts.set_roles("user:ghost", (), actor="operator:me")

    def test_a_change_to_an_unknown_account_leaves_no_event(self):
        before = len(self.accounts.security_log.read_all())
        with self.assertRaises(AccountError):
            self.accounts.set_roles("user:ghost", ("approver",), actor="operator:me")
        with self.assertRaises(AccountError):
            self.accounts.set_disabled("user:ghost", True, actor="operator:me")
        with self.assertRaises(AccountError):
            self.accounts.set_password("user:ghost", PW, actor="operator:me")
        with self.assertRaisesRegex(AccountError, "unknown role"):
            self.accounts.set_roles("user:x", ("root",), actor="operator:me")
        self.assertEqual(len(self.accounts.security_log.read_all()), before)

    def test_disabled_is_stored_as_exactly_one_or_zero(self):
        import sqlite3
        from contextlib import closing
        self.accounts.set_disabled("user:x", True, actor="operator:me")
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT disabled FROM accounts").fetchall(), [(1,)])


class SubSecondAccountLock(SessionBase):
    limits = RateLimits(auth_failure_limit=1, auth_failure_window=60.0, account_failure_limit=1,
                        account_failure_window=100.0)

    def test_a_sub_second_remainder_of_an_account_lock_is_still_refused_and_recorded(self):
        self.assertEqual(self.login("user:carol", "wrong password!!")[0], 401)
        self.mono.advance(99.5)  # the address window is long over; the account lock has 0.5 s left
        status, headers, _b = self.login("user:carol", PW)
        self.assertEqual((status, headers["Retry-After"]), (429, "1"))
        self.assertNotEqual(headers.get("Connection"), "close")  # the body was read: the connection stays usable
        last = list(self.accounts.security_log.read_all())[-1]
        self.assertEqual((last.event_type, last.payload["scope"]), ("security.login_throttled", "account"))


if __name__ == "__main__":
    unittest.main()
