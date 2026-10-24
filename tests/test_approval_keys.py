import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

from master_brain import approval_keys as ak
from master_brain.approval_signing import SIGNATURE_DOMAIN, build_signing_message
from master_brain.approval_signing_ed25519 import Ed25519TrustStore

PASS = "a long passphrase 42"
NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)


def challenge(*, key_id="k-boss", approver="user:boss", expires=None, extra=None):
    payload = {"mission_id": "m-1", "contract_digest": "c" * 64, "approver_subject": approver,
               "scope": "exact_contract_digest_and_action", "action_digest": "a" * 64,
               "expires_at": expires or (NOW + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
               "signing_key_id": key_id, "signature_alg": "ed25519"}
    payload.update(extra or {})
    return build_signing_message("approval-1", payload)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "boss.key"
        self.entry = ak.keygen("k-boss", "user:boss", self.path, PASS)

    def sign(self, message, passphrase=PASS, confirm=lambda: True, **kw):
        return ak.sign(self.path, message.hex(), passphrase, confirm=confirm, now=NOW, **kw)


class Keygen(Base):
    def test_the_file_is_private_encrypted_and_never_overwritten(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        text = self.path.read_text()
        self.assertIn("ENCRYPTED PRIVATE KEY", text)
        self.assertNotIn(PASS, text)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ak.KeyToolError, "already exists"):
            ak.keygen("k-boss", "user:boss", self.path, PASS)
        self.assertEqual(self.path.read_bytes(), before)

    def test_the_public_entry_is_what_serve_accepts_and_has_no_secret(self):
        from master_brain.serve import load_trust_store
        keys = Path(self.tmp.name) / "keys.json"
        keys.write_text(json.dumps({"keys": [self.entry]}))
        os.chmod(keys, 0o600)
        self.assertIsNotNone(load_trust_store(keys))
        self.assertEqual(set(self.entry), {"key_id", "subject", "public_key_hex"})
        self.assertEqual(ak.public_entry(self.path), self.entry)

    def test_bad_inputs_are_refused_and_create_no_file(self):
        bad = [("bad id!", "user:boss", PASS), ("k", "bad subject!", PASS), ("k", "user:a", "short"),
               ("k", "user:a", "aaaaaaaaaaaaaaaa"), ("k", "user:a", "x" * 2000), ("k", "user:a", "has\x00nul-chars!!"),
               ("", "user:a", PASS), ("k", "", PASS)]
        for key_id, subject, passphrase in bad:
            out = Path(self.tmp.name) / "new.key"
            with self.subTest(key_id=key_id, subject=subject), self.assertRaises(ak.KeyToolError):
                ak.keygen(key_id, subject, out, passphrase)
            self.assertFalse(out.exists())

    def test_an_unwritable_destination_is_a_clean_error(self):
        with self.assertRaisesRegex(ak.KeyToolError, "cannot create"):
            ak.keygen("k", "user:a", Path(self.tmp.name) / "nope" / "x.key", PASS)


class Boundaries(Base):
    def fresh(self, passphrase=PASS):
        out = Path(self.tmp.name) / f"b{len(list(Path(self.tmp.name).iterdir()))}.key"
        return ak.keygen("k", "user:a", out, passphrase)

    def test_passphrase_length_and_variety_limits_are_exact(self):
        self.fresh("abcdefghijkl")                       # 12 characters, 12 distinct: accepted
        with self.assertRaises(ak.KeyToolError):
            self.fresh("abcdefghijk")                    # 11
        with self.assertRaises(ak.KeyToolError):
            self.fresh("abcde" * 4)                      # 20 characters but only 5 distinct
        self.fresh("abcdef" * 3)                         # 6 distinct: accepted
        top = "abcdefghij" * 25 + "klmno"                # exactly 255 characters
        self.assertEqual(len(top), 255)
        self.fresh(top)
        with self.assertRaises(ak.KeyToolError):
            self.fresh(top + "p")                        # 256
        wide = ("\U0001F600\U0001F601\U0001F602\U0001F603\U0001F604\U0001F605" * 43)[:255]                        # 255 four-byte characters = 1020 bytes: still accepted
        self.assertEqual(len(wide.encode()), 1020)
        self.fresh(wide)
        with self.assertRaisesRegex(ak.KeyToolError, "not valid text"):
            self.fresh("abcdefghijkl\ud800")

    def test_the_message_size_limit_is_exact(self):
        def pad(n):
            return SIGNATURE_DOMAIN + b" " * (n - len(SIGNATURE_DOMAIN))
        with self.assertRaisesRegex(ak.KeyToolError, "malformed"):  # at the limit: parsed, then found malformed
            self.sign(pad(8192))
        with self.assertRaisesRegex(ak.KeyToolError, "too large"):
            self.sign(pad(8193))

    def test_any_group_or_other_permission_bit_makes_the_key_file_unusable(self):
        for mode in (0o601, 0o602, 0o604, 0o610, 0o620, 0o640, 0o660, 0o666):
            os.chmod(self.path, mode)
            with self.subTest(mode=oct(mode)), self.assertRaisesRegex(ak.KeyToolError, "readable by other users"):
                ak.public_entry(self.path)
        os.chmod(self.path, 0o400)
        ak.public_entry(self.path)

    def test_a_directory_or_an_unencrypted_key_inside_the_file_is_a_clean_refusal(self):
        folder = Path(self.tmp.name) / "dir"
        folder.mkdir(mode=0o700)
        with self.assertRaisesRegex(ak.KeyToolError, "not valid"):
            ak.public_entry(folder)
        serialization, Ed = ak._crypto()
        plain = Ed.generate().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                            serialization.NoEncryption()).decode()
        data = json.loads(self.path.read_text())
        data["private_key_pem"] = plain  # a tampered file: not protected by a passphrase
        self.path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ak.KeyToolError, "wrong passphrase or damaged"):
            self.sign(challenge())

    def test_a_backend_refusal_of_the_passphrase_is_a_clean_error(self):
        from unittest import mock
        serialization, Ed = ak._crypto()
        with mock.patch.object(serialization, "BestAvailableEncryption", side_effect=ValueError("no")):
            with self.assertRaisesRegex(ak.KeyToolError, "refused by the encryption backend"):
                ak.keygen("k", "user:a", Path(self.tmp.name) / "r.key", PASS)

    def test_write_failures_are_clean_errors(self):
        from unittest import mock
        out = Path(self.tmp.name) / "w.key"
        with mock.patch.object(ak.os, "fdopen", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(ak.KeyToolError, "cannot write"):
                ak.keygen("k", "user:a", out, PASS)


class Prompts(Base):
    def test_interactive_passphrases_must_match_and_the_terminal_answer_decides(self):
        from unittest import mock
        args = type("A", (), {"passphrase_stdin": False})()
        with mock.patch.object(ak.getpass, "getpass", side_effect=["same-passphrase-1", "same-passphrase-1"]):
            self.assertEqual(ak._read_passphrase(args, confirm=True), "same-passphrase-1")
        with mock.patch.object(ak.getpass, "getpass", side_effect=["same-passphrase-1", "other-passphrase"]):
            with self.assertRaisesRegex(ak.KeyToolError, "differ"):
                ak._read_passphrase(args, confirm=True)
        with mock.patch.object(ak.getpass, "getpass", side_effect=["only-once-1234"]) as g:
            self.assertEqual(ak._read_passphrase(args, confirm=False), "only-once-1234")
            self.assertEqual(g.call_count, 1)
        for answer, expected in (("yes\n", True), ("YES\n", True), ("y\n", False), ("no\n", False), ("\n", False)):
            fake = mock.MagicMock()
            fake.__enter__.return_value = fake
            fake.readline.return_value = answer
            with self.subTest(answer=answer), mock.patch("builtins.open", return_value=fake):
                self.assertIs(ak._tty_confirm(), expected)


class Signing(Base):
    def test_a_real_message_is_signed_and_the_trust_store_accepts_it(self):
        message = challenge()
        signature = bytes.fromhex(self.sign(message))
        store = Ed25519TrustStore()
        store.add_key("k-boss", "user:boss", bytes.fromhex(self.entry["public_key_hex"]))
        self.assertIsNone(store.verify(key_id="k-boss", algorithm="ed25519", subject="user:boss",
                                       message=message, signature=signature))
        self.assertIsNotNone(store.verify(key_id="k-boss", algorithm="ed25519", subject="user:boss",
                                          message=message + b" ", signature=signature))

    def test_the_human_sees_what_is_signed_before_the_prompt(self):
        shown = []
        self.sign(challenge(), show=shown.append)
        for text in ("m-1", "c" * 64, "a" * 64, "user:boss", "approval-1", "k-boss"):
            self.assertIn(text, shown[0])

    def test_refusing_the_prompt_signs_nothing_and_never_asks_for_the_key(self):
        with self.assertRaisesRegex(ak.KeyToolError, "nothing was signed"):
            self.sign(challenge(), passphrase="wrong passphrase!!", confirm=lambda: False)  # refused before decrypt

    def test_it_is_not_a_generic_signing_oracle(self):
        for raw in (b"hello", b"", b"x" * 100, SIGNATURE_DOMAIN[:-1], b"master-brain/approval-signature/v1\n{}"):
            with self.subTest(raw=raw[:20]), self.assertRaisesRegex(ak.KeyToolError, "not a Master Brain approval"):
                self.sign(raw)

    def test_malformed_or_oversized_challenges_are_refused(self):
        cases = [SIGNATURE_DOMAIN + b"not json", SIGNATURE_DOMAIN + b"[]", SIGNATURE_DOMAIN + b'{"event_id":"e"}',
                 SIGNATURE_DOMAIN + b'{"event_id":"e","payload":{}}', SIGNATURE_DOMAIN + b"\xff\xfe",
                 challenge(extra={"mission_id": 5}), challenge(expires="not-a-date"),
                 challenge(expires="2026-10-24T13:00:00")]
        for raw in cases:
            with self.subTest(raw=raw[:40]), self.assertRaisesRegex(ak.KeyToolError, "malformed"):
                self.sign(raw)
        with self.assertRaisesRegex(ak.KeyToolError, "too large"):
            self.sign(SIGNATURE_DOMAIN + b" " * ak.MAX_MESSAGE_BYTES)

    def test_a_challenge_for_another_key_or_approver_or_an_expired_one_is_refused(self):
        with self.assertRaisesRegex(ak.KeyToolError, "different signing key"):
            self.sign(challenge(key_id="k-other"))
        with self.assertRaisesRegex(ak.KeyToolError, "different approver"):
            self.sign(challenge(approver="user:mallory"))
        past = (NOW - timedelta(seconds=1)).isoformat().replace("+00:00", "Z")
        for expires in (past, NOW.isoformat().replace("+00:00", "Z")):
            with self.subTest(expires=expires), self.assertRaisesRegex(ak.KeyToolError, "expired"):
                self.sign(challenge(expires=expires))

    def test_wrong_passphrase_and_bad_hex_are_clean_errors_without_secrets(self):
        with self.assertRaisesRegex(ak.KeyToolError, "wrong passphrase") as ctx:
            self.sign(challenge(), passphrase="another long passphrase")
        self.assertNotIn(PASS, str(ctx.exception))
        for bad in ("zz", "abc", None):
            with self.subTest(bad=bad), self.assertRaisesRegex(ak.KeyToolError, "valid hex"):
                ak.sign(self.path, bad, PASS, confirm=lambda: True, now=NOW)

    def test_a_key_file_other_users_can_read_or_a_foreign_file_is_refused(self):
        os.chmod(self.path, 0o640)
        with self.assertRaisesRegex(ak.KeyToolError, "readable by other users"):
            self.sign(challenge())
        os.chmod(self.path, 0o600)
        for body in ("{", "[]", json.dumps({"format": "x"}),
                     json.dumps({**json.loads(self.path.read_text()), "extra": "1"}),
                     json.dumps({**json.loads(self.path.read_text()), "format": "other"})):
            self.path.write_text(body)
            with self.subTest(body=body[:30]), self.assertRaisesRegex(ak.KeyToolError, "not valid|not a Master Brain"):
                self.sign(challenge())
        with self.assertRaisesRegex(ak.KeyToolError, "cannot be read"):
            ak.public_entry(Path(self.tmp.name) / "missing.key")


class Cli(Base):
    def run_cli(self, *args, stdin=""):
        return subprocess.run([sys.executable, "-m", "master_brain.approval_keys", *args], input=stdin,
                              capture_output=True, text=True, env={**os.environ, "PYTHONPATH": "src:."},
                              cwd=Path(__file__).resolve().parent.parent)

    def test_keygen_prints_only_the_public_entry_and_sign_prints_only_the_signature(self):
        out = Path(self.tmp.name) / "cli.key"
        done = self.run_cli("keygen", "--key-id", "k-c", "--subject", "user:c", "--out", str(out),
                            "--passphrase-stdin", stdin=PASS + "\n")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["key_id"], "k-c")
        self.assertNotIn(PASS, done.stdout + done.stderr)
        self.assertNotIn("PRIVATE", done.stdout + done.stderr)
        far = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        message = challenge(key_id="k-c", approver="user:c", expires=far).hex()
        signed = self.run_cli("sign", "--key", str(out), "--message-hex", message, "--yes",
                              "--passphrase-stdin", stdin=PASS + "\n")
        self.assertEqual(signed.returncode, 0, signed.stderr)
        self.assertEqual(len(bytes.fromhex(signed.stdout.strip())), 64)
        self.assertIn("mission_id: m-1", signed.stderr)
        self.assertNotIn(PASS, signed.stdout + signed.stderr)
        public = self.run_cli("public", "--key", str(out))
        self.assertEqual(json.loads(public.stdout)["public_key_hex"], json.loads(done.stdout)["public_key_hex"])

    def test_without_a_terminal_and_without_yes_nothing_is_signed(self):
        far = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        message = challenge(expires=far).hex()
        try:
            open("/dev/tty").close()
            self.skipTest("a controlling terminal exists here")
        except OSError:
            pass
        done = self.run_cli("sign", "--key", str(self.path), "--message-hex", message,
                            "--passphrase-stdin", stdin=PASS + "\n")
        self.assertEqual(done.returncode, 1)
        self.assertIn("needs a terminal", done.stderr)
        self.assertEqual(done.stdout.strip(), "")

    def test_errors_exit_nonzero_with_a_one_line_message(self):
        done = self.run_cli("keygen", "--key-id", "k", "--subject", "user:a", "--out", str(self.path),
                            "--passphrase-stdin", stdin=PASS + "\n")
        self.assertEqual(done.returncode, 1)
        self.assertTrue(done.stderr.startswith("error: "))
        self.assertNotIn("Traceback", done.stderr)


if __name__ == "__main__":
    unittest.main()
