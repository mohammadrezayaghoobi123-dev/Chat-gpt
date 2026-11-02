"""Gate 3d: read-only operator view of accounts/roles and recent security events (no way to change anything)."""
import json
import tempfile
import unittest
from pathlib import Path

from master_brain.accounts import AccountStore
from tests.test_http_api import OPS, Running

PW = "correct horse battery"


class AdminView(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.accounts = AccountStore(self.base / "id.sqlite")
        self.accounts.create_account("user:ops2", PW, roles=("operator",), actor="operator:test")
        self.accounts.create_account("user:boss", PW, roles=("approver",), actor="operator:test")
        self.accounts.create_account("user:dave", PW, actor="operator:test")
        self.accounts.create_account("user:gone", PW, roles=("approver",), actor="operator:test")
        self.accounts.set_disabled("user:gone", True, actor="operator:test")
        self.run_ = Running(self.base / "audit.jsonl", accounts=self.accounts)
        self.addCleanup(self.run_.close)

    def login(self, subject):
        status, headers, _body = self.run_.json("POST", "/v1/session", {"subject": subject, "password": PW}, token=None)
        self.assertEqual(status, 201)
        return headers["Set-Cookie"].split(";")[0]

    def get(self, path, cookie=None, token=None):
        headers = {"Cookie": cookie} if cookie else None
        return self.run_.json("GET", path, token=token, headers=headers)

    # ------------------------------------------------------------------ accounts
    def test_an_operator_sees_every_account_with_roles_and_state_but_no_secrets(self):
        status, _h, body = self.get("/v1/admin/accounts", cookie=self.login("user:ops2"))
        self.assertEqual(status, 200)
        rows = {r["subject"]: r for r in body["accounts"]}
        self.assertEqual(set(rows), {"user:ops2", "user:boss", "user:dave", "user:gone"})
        self.assertEqual(rows["user:boss"]["roles"], ["approver"])
        self.assertEqual(rows["user:dave"]["roles"], [])
        self.assertIs(rows["user:gone"]["disabled"], True)
        self.assertIs(rows["user:boss"]["disabled"], False)
        self.assertEqual(set(rows["user:boss"]), {"subject", "roles", "disabled", "created_at"})
        self.assertEqual([r["subject"] for r in body["accounts"]], sorted(rows))
        import re
        for r in rows.values():
            self.assertRegex(r["created_at"], r"^\d{4}-\d\d-\d\dT")
        text = json.dumps(body)
        for secret in ("password_record", "scrypt", PW, "token_hash"):
            self.assertNotIn(secret, text)

    def test_a_static_token_operator_may_read_too(self):
        status, _h, body = self.get("/v1/admin/accounts", token=OPS)
        self.assertEqual(status, 200)
        self.assertEqual(len(body["accounts"]), 4)

    def test_non_operators_are_forbidden_including_approvers(self):
        for who in ("user:boss", "user:dave"):
            status, _h, body = self.get("/v1/admin/accounts", cookie=self.login(who))
            self.assertEqual((status, body["error"]["code"]), (403, "forbidden"), who)
            status, _h, body = self.get("/v1/admin/security-events", cookie=self.login(who))
            self.assertEqual((status, body["error"]["code"]), (403, "forbidden"), who)

    def test_unauthenticated_gets_401(self):
        self.assertEqual(self.get("/v1/admin/accounts")[0], 401)
        self.assertEqual(self.get("/v1/admin/security-events")[0], 401)

    def test_a_disabled_operator_loses_the_view_at_once(self):
        cookie = self.login("user:ops2")
        self.accounts.set_disabled("user:ops2", True, actor="operator:test")
        self.assertEqual(self.get("/v1/admin/accounts", cookie=cookie)[0], 401)

    def test_a_role_revoked_operator_is_forbidden_at_once(self):
        cookie = self.login("user:ops2")
        self.accounts.set_roles("user:ops2", [], actor="operator:test")
        self.assertIn(self.get("/v1/admin/accounts", cookie=cookie)[0], (401, 403))

    def test_only_get_is_allowed_there_is_no_way_to_change_anything(self):
        cookie = self.login("user:ops2")
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            status, _h, _b = self.run_.json(method, "/v1/admin/accounts", {"subject": "user:x", "roles": ["approver"]},
                                            token=None, headers={"Cookie": cookie, "Origin": f"http://127.0.0.1:{self.run_.port}"})
            self.assertIn(status, (400, 404, 405), method)
        self.assertEqual(self.accounts.active_roles("user:dave"), frozenset())
        self.assertEqual(len(self.get("/v1/admin/accounts", cookie=cookie)[2]["accounts"]), 4)

    def test_the_view_is_capped(self):
        from master_brain.accounts import MAX_ADMIN_ACCOUNTS
        import sqlite3
        with sqlite3.connect(self.accounts.path) as db:  # direct rows: hashing 500 passwords would only slow the test
            db.executemany("INSERT INTO accounts (subject, password_record, roles, disabled, created_at) VALUES (?,?,?,?,?)",
                           [(f"user:bulk{i:04d}", "x", "", 0, "2026-01-01T00:00:00Z") for i in range(MAX_ADMIN_ACCOUNTS + 5)])
        body = self.get("/v1/admin/accounts", cookie=self.login("user:ops2"))[2]
        self.assertEqual(len(body["accounts"]), MAX_ADMIN_ACCOUNTS)
        self.assertIs(body["truncated"], True)

    # ------------------------------------------------------------------ security events
    def test_recent_security_events_are_newest_first_and_allow_listed(self):
        cookie = self.login("user:ops2")
        self.login("user:dave")
        self.run_.json("POST", "/v1/session", {"subject": "user:dave", "password": "wrong password!!"}, token=None)
        status, _h, body = self.get("/v1/admin/security-events", cookie=cookie)
        self.assertEqual(status, 200)
        events = body["events"]
        self.assertGreaterEqual(len(events), 4)
        types = [e["event_type"] for e in events]
        self.assertEqual(types[0], "security.login_failed")
        self.assertIn("security.account_changed", types)
        self.assertEqual(set(events[0]), {"event_type", "recorded_at", "actor", "subject_ref", "payload"})
        stamps = [e["recorded_at"] for e in events]
        self.assertEqual(stamps, sorted(stamps, reverse=True))
        self.assertNotIn("wrong password", json.dumps(body))

    def test_the_event_view_is_capped_and_says_so(self):
        from master_brain.accounts import MAX_ADMIN_EVENTS
        for _ in range(MAX_ADMIN_EVENTS + 5):
            self.accounts.security_log.critical("security.logout", actor="user:dave", subject_ref="user:dave",
                                                payload={"address": "127.0.0.1"})
        body = self.get("/v1/admin/security-events", cookie=self.login("user:ops2"))[2]
        self.assertEqual(len(body["events"]), MAX_ADMIN_EVENTS)
        self.assertIs(body["truncated"], True)

    def test_a_tampered_security_log_is_reported_not_shown(self):
        cookie = self.login("user:ops2")
        log = self.accounts.security_log.path
        log.write_text(log.read_text().replace("security.", "securitY.", 1))
        status, _h, body = self.get("/v1/admin/security-events", cookie=cookie)
        self.assertEqual((status, body["error"]["code"]), (503, "unavailable"))
        self.assertNotIn("securitY", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
