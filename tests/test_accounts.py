"""Gate 2c-2: local accounts and server-side sessions."""
import io
import sqlite3
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from master_brain import accounts
from master_brain.accounts import (
    ABSOLUTE_LIFETIME, IDLE_TIMEOUT, MAX_SESSIONS_PER_SUBJECT, AccountError, AccountStore, SessionAuthenticator,
    check_password_policy,
)
from master_brain.identity import Identity

PW = "correct horse battery"


def query(path, sql):
    from contextlib import closing
    with closing(sqlite3.connect(path)) as db:
        return db.execute(sql).fetchall()


def hashlib_scrypt_unchecked(password, salt, n, r, p):
    """A digest for parameters the verifier must refuse, computed where they are legal for scrypt itself."""
    import hashlib
    try:
        return hashlib.scrypt(password.encode(), salt=salt, n=n, r=max(r, 1), p=max(p, 1), dklen=32,
                              maxmem=64 * 1024 * 1024).hex()
    except ValueError:
        return "00" * 32


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock = Clock()
        self.db = Path(self.tmp.name) / "id.sqlite"
        self.store = AccountStore(self.db, clock=self.clock)
        self.store.create_account("user:alice", PW)


class PasswordTests(Base):
    def test_correct_password_gives_the_stored_identity_wrong_ones_give_none(self):
        self.assertEqual(self.store.verify_password("user:alice", PW), Identity("user:alice"))
        for bad in ("wrong password!!", PW + " ", PW.upper(), ""):
            self.assertIsNone(self.store.verify_password("user:alice", bad), bad)

    def test_unknown_disabled_and_malformed_inputs_are_indistinguishable_from_a_wrong_password(self):
        self.store.set_disabled("user:alice", True)
        self.assertIsNone(self.store.verify_password("user:alice", PW))  # right password, disabled account
        for subject, password in (("user:nobody", PW), (None, PW), ("user:alice", None), (5, 5),
                                  ("x" * 500, PW), ("user:alice", "p" * 1000), ("user:alice", "a\x00bcdefghijklm")):
            self.assertIsNone(self.store.verify_password(subject, password), (subject, password))

    def test_every_failure_pays_for_exactly_one_hash(self):
        calls = []
        real = accounts._verify_record
        with mock.patch.object(accounts, "_verify_record", side_effect=lambda p, r: (calls.append(r), real(p, r))[1]):
            self.store.verify_password("user:alice", "wrong password!!")
            self.store.verify_password("user:nobody", "wrong password!!")
            self.store.verify_password(None, "x")
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1], calls[2])  # unknown subject and malformed input use the dummy record

    def test_record_format_uses_scrypt_random_salt_and_never_stores_the_password(self):
        other = AccountStore(Path(self.tmp.name) / "o.sqlite", clock=self.clock)
        other.create_account("user:alice", PW)
        rec = lambda s: query(s.path, "SELECT password_record FROM accounts")[0][0]
        a, b = rec(self.store), rec(other)
        self.assertTrue(a.startswith("scrypt$16384$8$1$"))
        self.assertNotEqual(a, b)  # same password, different salt
        self.assertNotIn(PW, a)
        self.assertEqual(len(a.split("$")[-1]), 64)

    def test_tampered_records_fail_closed(self):
        for record in ("", "scrypt$1$8$1$00$00", "md5$16384$8$1$00$00", "scrypt$x$8$1$00$00", "garbage",
                       "scrypt$16384$8$1$zz$00", "scrypt$99999999$8$1$00$00"):
            self.assertIs(accounts._verify_record(PW, record), False, record)

    def test_policy(self):
        for bad in ("short", "a" * 11, "x" * 257, "aaaaaaaaaaaaaaaa", "user:alice", "has\x00nul-chars-here", 5):
            with self.assertRaises(AccountError, msg=str(bad)):
                check_password_policy("user:alice", bad)
        check_password_policy("user:alice", "a" * 12 + "bcde")
        check_password_policy("s", "abcde" * 51 + "f")  # 256 chars is allowed
        with self.assertRaises(AccountError):
            check_password_policy("user:alice", "USER:ALICE")  # equals the subject, case-insensitively

    def test_salt_and_token_sizes_are_pinned(self):
        record = query(self.db, "SELECT password_record FROM accounts")[0][0]
        self.assertEqual(len(record.split("$")[4]), 32)  # 16-byte salt
        token, _ = self.store.create_session(Identity("user:alice"))
        self.assertEqual(len(token), 43)  # 256 bits, url-safe base64

    def test_policy_boundaries_are_exact(self):
        check_password_policy("s", "abcdefghijkl")             # 12 distinct chars: ok
        with self.assertRaises(AccountError):
            check_password_policy("s", "abcdefghijk")          # 11: too short
        check_password_policy("s", "abcde" * 51 + "f")        # 256: ok
        with self.assertRaises(AccountError):
            check_password_policy("s", "abcde" * 51 + "fg")   # 257: too long
        check_password_policy("s", "abcde" * 3)                # exactly 5 distinct characters: ok
        with self.assertRaises(AccountError):
            check_password_policy("s", "abcd" * 4)             # 4 distinct characters: too guessable

    def test_stored_record_parameter_bounds_are_enforced_exactly(self):
        def rec(n, r, p, mem_ok=True):
            salt = b"s" * 16
            return f"scrypt${n}${r}${p}${salt.hex()}${accounts._hash_password(PW, salt, n, r, p).hex()}"
        self.assertTrue(accounts._verify_record(PW, rec(1024, 1, 1)))
        self.assertTrue(accounts._verify_record(PW, rec(1024, 16, 1)))
        self.assertTrue(accounts._verify_record(PW, rec(1024, 1, 4)))
        for bad in ((512, 1, 1), (1024, 0, 1), (1024, 17, 1), (1024, 1, 0), (1024, 1, 5)):
            salt = b"s" * 16
            digest = hashlib_scrypt_unchecked(PW, salt, *bad)
            record = f"scrypt${bad[0]}${bad[1]}${bad[2]}${salt.hex()}${digest}"
            self.assertIs(accounts._verify_record(PW, record), False, bad)

    def test_nested_directories_are_created(self):
        nested = Path(self.tmp.name) / "a" / "b" / "c" / "id.sqlite"
        AccountStore(nested).create_account("user:x", PW)
        self.assertTrue(nested.exists())

    def test_account_management(self):
        with self.assertRaises(AccountError):
            self.store.create_account("user:alice", PW)  # duplicate
        with self.assertRaises(ValueError):
            self.store.create_account("bad subject!", PW)
        with self.assertRaises(ValueError):
            self.store.create_account("user:x", PW, ("admin",))  # unknown role
        for call in (lambda: self.store.set_password("user:none", PW), lambda: self.store.set_disabled("user:none", True),
                     lambda: self.store.set_roles("user:none", ())):
            with self.assertRaises(AccountError):
                call()
        with self.assertRaises(AccountError):
            self.store.set_roles("user:alice", ("root",))
        self.store.create_account("user:ops", PW, ("operator",))
        self.assertTrue(self.store.verify_password("user:ops", PW).is_operator)


class SessionTests(Base):
    def login(self, subject="user:alice"):
        return self.store.create_session(self.store.verify_password(subject, PW))

    def test_token_is_random_authenticates_and_only_its_digest_is_stored(self):
        t1, exp1 = self.login()
        t2, _ = self.login()
        self.assertNotEqual(t1, t2)
        self.assertGreaterEqual(len(t1), 40)
        self.assertEqual(self.store.authenticate_session(t1), Identity("user:alice"))
        self.assertEqual(exp1, self.clock.now + ABSOLUTE_LIFETIME)
        rows = query(self.db, "SELECT token_hash FROM sessions")
        self.assertEqual(len(rows), 2)
        for (h,) in rows:
            self.assertEqual(len(h), 64)
            self.assertNotIn(h, (t1, t2))
        self.assertNotIn(t1.encode(), self.db.read_bytes())

    def test_garbage_credentials_never_authenticate(self):
        for bad in (None, "", "short", "x" * 129, "é" * 30, "A" * 43, 5, b"bytes"):
            self.assertIsNone(self.store.authenticate_session(bad), bad)

    def test_idle_timeout_and_sliding_use(self):
        token, _ = self.login()
        self.clock.advance(minutes=29)
        self.assertIsNotNone(self.store.authenticate_session(token))  # use refreshes the idle timer
        self.clock.advance(minutes=29)
        self.assertIsNotNone(self.store.authenticate_session(token))
        self.clock.advance(minutes=31)
        self.assertIsNone(self.store.authenticate_session(token))
        self.assertIsNone(self.store.authenticate_session(token))  # and it is gone for good

    def test_absolute_lifetime_cannot_be_extended_by_activity(self):
        token, _ = self.login()
        for _ in range(16):  # 16 x 29 min of constant use = 7h44m
            self.clock.advance(minutes=29)
            self.assertIsNotNone(self.store.authenticate_session(token))
        self.clock.advance(minutes=29)  # now 8h13m after login
        self.assertIsNone(self.store.authenticate_session(token))

    def test_boundaries_are_inclusive_of_the_limit_and_exclusive_beyond(self):
        token, _ = self.login()
        self.clock.advance(minutes=30)
        self.assertIsNotNone(self.store.authenticate_session(token))  # exactly the idle limit is still valid
        self.clock.advance(minutes=30, seconds=1)
        self.assertIsNone(self.store.authenticate_session(token))

    def test_logout_password_change_and_disable_revoke_sessions(self):
        token, _ = self.login()
        self.assertTrue(self.store.revoke_session(token))
        self.assertIsNone(self.store.authenticate_session(token))
        self.assertIs(self.store.revoke_session(token), False)
        self.assertIs(self.store.revoke_session(None), False)
        self.assertIs(self.store.revoke_session(12345), False)
        t2, _ = self.login()
        self.store.set_password("user:alice", "another long password")
        self.assertIsNone(self.store.authenticate_session(t2))
        self.assertIsNone(self.store.verify_password("user:alice", PW))
        self.assertIsNotNone(self.store.verify_password("user:alice", "another long password"))
        t3 = self.store.create_session(Identity("user:alice"))[0]
        self.store.set_disabled("user:alice", True)
        self.assertIsNone(self.store.authenticate_session(t3))
        self.assertEqual(self.store.session_count("user:alice"), 0)

    def test_disabled_flag_and_role_changes_apply_immediately_to_a_live_session(self):
        token, _ = self.login()
        self.store.set_roles("user:alice", ("operator",))
        self.assertTrue(self.store.authenticate_session(token).is_operator)
        self.store.set_roles("user:alice", ())
        self.assertFalse(self.store.authenticate_session(token).is_operator)
        self.store.set_disabled("user:alice", True)
        self.assertIsNone(self.store.authenticate_session(token))
        self.store.set_disabled("user:alice", False)
        self.assertIsNone(self.store.authenticate_session(token))  # re-enabling does not resurrect it

    def test_the_cap_is_ten_and_last_seen_is_written_at_most_every_thirty_seconds(self):
        self.assertEqual(MAX_SESSIONS_PER_SUBJECT, 10)
        token, _ = self.login()
        seen = lambda: query(self.db, "SELECT last_seen FROM sessions")[0][0]
        first = seen()
        self.clock.advance(seconds=29)
        self.store.authenticate_session(token)
        self.assertEqual(seen(), first)  # inside the interval: no write
        self.clock.advance(seconds=1)
        self.store.authenticate_session(token)
        self.assertNotEqual(seen(), first)  # at 30s: refreshed

    def test_session_cap_drops_the_oldest(self):
        tokens = []
        for _ in range(MAX_SESSIONS_PER_SUBJECT + 3):
            tokens.append(self.login()[0])
            self.clock.advance(seconds=1)
        self.assertEqual(self.store.session_count("user:alice"), MAX_SESSIONS_PER_SUBJECT)
        self.assertIsNone(self.store.authenticate_session(tokens[0]))
        self.assertIsNotNone(self.store.authenticate_session(tokens[-1]))

    def test_cap_is_per_subject(self):
        self.store.create_account("user:bob", PW)
        for _ in range(MAX_SESSIONS_PER_SUBJECT):
            self.login("user:bob")
        t, _ = self.login("user:alice")
        self.assertIsNotNone(self.store.authenticate_session(t))
        self.assertEqual(self.store.session_count("user:bob"), MAX_SESSIONS_PER_SUBJECT)

    def test_expired_sessions_are_purged_on_the_next_login(self):
        self.login()
        self.clock.advance(hours=9)
        self.login()
        self.assertEqual(self.store.session_count("user:alice"), 1)

    def test_concurrent_logins_never_exceed_the_cap_or_crash(self):
        errors = []

        def go():
            try:
                self.login()
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=go) for _ in range(25)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        self.assertLessEqual(self.store.session_count("user:alice"), MAX_SESSIONS_PER_SUBJECT)

    def test_session_authenticator_is_the_seam(self):
        token, _ = self.login()
        auth = SessionAuthenticator(self.store)
        self.assertEqual(auth.authenticate(token), Identity("user:alice"))
        self.assertIsNone(auth.authenticate("nope"))
        self.assertIsNone(auth.authenticate(None))
        self.assertEqual(self.store.session_expiry(token), self.clock.now + ABSOLUTE_LIFETIME)
        self.assertIsNone(self.store.session_expiry("unknown-token-value-0000"))


class CliTests(unittest.TestCase):
    def run_cli(self, *argv, stdin=""):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), mock.patch("sys.stdin", io.StringIO(stdin)):
            code = accounts._main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_add_passwd_disable_enable_round_trip_without_a_password_on_the_command_line(self):
        with tempfile.TemporaryDirectory() as d:
            db = str(Path(d) / "id.sqlite")
            self.assertEqual(self.run_cli("--db", db, "add", "--subject", "user:ops", "--operator", "--password-stdin",
                                          stdin=PW + "\n")[0], 0)
            store = AccountStore(db)
            self.assertTrue(store.verify_password("user:ops", PW).is_operator)
            self.assertEqual(self.run_cli("--db", db, "passwd", "--subject", "user:ops", "--password-stdin",
                                          stdin="a brand new password\n")[0], 0)
            self.assertIsNone(store.verify_password("user:ops", PW))
            self.assertEqual(self.run_cli("--db", db, "disable", "--subject", "user:ops")[0], 0)
            self.assertIsNone(store.verify_password("user:ops", "a brand new password"))
            self.assertEqual(self.run_cli("--db", db, "enable", "--subject", "user:ops")[0], 0)
            self.assertIsNotNone(store.verify_password("user:ops", "a brand new password"))

    def test_required_arguments_are_enforced(self):
        for argv in ([], ["add", "--subject", "x"], ["--db", "x"], ["--db", "x", "add"], ["--db", "x", "disable"],
                     ["--db", "x", "passwd"]):
            with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as ctx:
                accounts._main(argv)
            self.assertEqual(ctx.exception.code, 2, argv)

    def test_an_invalid_subject_is_a_clean_error_not_a_traceback(self):
        with tempfile.TemporaryDirectory() as d:
            code, _out, err = self.run_cli("--db", str(Path(d) / "i.sqlite"), "add", "--subject", "bad subject!",
                                           "--password-stdin", stdin=PW + "\n")
            self.assertEqual(code, 1)
            self.assertIn("error:", err)

    def test_errors_exit_nonzero_with_a_message_and_do_not_echo_the_password(self):
        with tempfile.TemporaryDirectory() as d:
            db = str(Path(d) / "id.sqlite")
            code, out, err = self.run_cli("--db", db, "add", "--subject", "user:x", "--password-stdin", stdin="short\n")
            self.assertEqual(code, 1)
            self.assertIn("error:", err)
            self.assertNotIn("short", err + out)
            self.assertEqual(self.run_cli("--db", db, "disable", "--subject", "user:none")[0], 1)


if __name__ == "__main__":
    unittest.main()
