import json
import unittest
from pathlib import Path

from master_brain.api_contracts import ContractError, LoginRequest, SessionView

GOLDEN = Path(__file__).parent / "golden" / "api_v1"


class LoginRequestTests(unittest.TestCase):
    def test_valid(self):
        r = LoginRequest.from_dict({"subject": "user:alice@example.org", "password": "  spaces are kept  "})
        self.assertEqual((r.subject, r.password), ("user:alice@example.org", "  spaces are kept  "))

    def test_strict(self):
        bad = [None, [], {}, {"subject": "a"}, {"password": "p"}, {"subject": "a", "password": "p", "x": 1},
               {"subject": "", "password": "p"}, {"subject": "a b", "password": "p"}, {"subject": "a" * 129, "password": "p"},
               {"subject": 5, "password": "p"}, {"subject": "a", "password": ""}, {"subject": "a", "password": 5},
               {"subject": "a", "password": "p" * 257}, {"subject": "a", "password": "p\x00q"}, {"subject": None, "password": "p"}]
        for data in bad:
            with self.assertRaises(ContractError, msg=repr(data)):
                LoginRequest.from_dict(data)
        LoginRequest.from_dict({"subject": "a" * 128, "password": "p" * 256})

    def test_repr_never_contains_the_password(self):
        r = LoginRequest.from_dict({"subject": "user:a", "password": "hunter2-hunter2"})
        self.assertNotIn("hunter2", repr(r))
        self.assertNotIn("hunter2", str(r))


class SessionViewTests(unittest.TestCase):
    def test_matches_golden_and_has_no_token(self):
        data = SessionView("user:ops", ("operator",), "2026-10-22T20:00:00.000000Z", 1800).to_dict()
        self.assertEqual(data, json.loads((GOLDEN / "session_view.json").read_text(encoding="utf-8")))
        self.assertNotIn("token", json.dumps(data).lower())

    def test_roles_are_sorted(self):
        self.assertEqual(SessionView("s", ("b", "a"), "t", 1).to_dict()["roles"], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
