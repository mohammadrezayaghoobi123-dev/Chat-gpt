"""Operator/approver tool: make a passphrase-protected approval key and sign a challenge with it.

    python -m master_brain.approval_keys keygen --key-id k-boss --subject user:boss --out boss.key
    python -m master_brain.approval_keys sign --key boss.key --message-hex <signing_message_hex>
    python -m master_brain.approval_keys public --key boss.key

Why this exists: an approval must be signed by a key that lives OUTSIDE the browser and the server
(docs/MISSION_APPROVAL_TRUST_BOUNDARY_V0.md). This is the smallest tool that makes that possible.

Safety properties (each one is tested):
* The private key is stored only encrypted (PKCS#8, passphrase of >= 12 characters) in a file created
  with mode 0600 that refuses to overwrite an existing file. It is never printed.
* ``sign`` is not a generic signing oracle: it signs only a Master Brain approval message (domain tag),
  shows what it is about to sign (mission, contract, action, approver, expiry), refuses a message
  meant for another key or one that has expired, and needs an explicit "yes" on the terminal
  (``--yes`` only for scripts that already showed the summary to a human).
* A key file that other users can read is refused. Errors never contain the passphrase or key bytes.
* Passphrase-protection is only as strong as the passphrase; the file is not safe to share.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from master_brain.approval_signing import SIGNATURE_DOMAIN

MIN_PASSPHRASE_CHARS = 12
MAX_PASSPHRASE_CHARS = 255  # also <= 1020 UTF-8 bytes: the crypto backend refuses 1024+ bytes
MAX_MESSAGE_BYTES = 8192
FORMAT = "master-brain-approver-key/v1"
_KEY_ID = re.compile(r"[A-Za-z0-9._:-]{1,64}")
_SUBJECT = re.compile(r"[A-Za-z0-9._:@-]{1,128}")


class KeyToolError(Exception):
    """A refusal with a message that is safe to show (never secret material)."""


def _crypto():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise KeyToolError("needs the 'cryptography' package: pip install cryptography") from exc
    return serialization, Ed25519PrivateKey


def _check_passphrase(passphrase: str) -> str:
    if not isinstance(passphrase, str) or "\x00" in passphrase:
        raise KeyToolError("the passphrase must be text without NUL characters")
    try:
        passphrase.encode("utf-8")
    except UnicodeEncodeError:
        raise KeyToolError("the passphrase is not valid text") from None
    if not MIN_PASSPHRASE_CHARS <= len(passphrase) <= MAX_PASSPHRASE_CHARS:
        raise KeyToolError(f"the passphrase must be {MIN_PASSPHRASE_CHARS}-{MAX_PASSPHRASE_CHARS} characters")
    if len(set(passphrase)) < 6:
        raise KeyToolError("the passphrase is too guessable (fewer than 6 distinct characters)")
    return passphrase


def _read_passphrase(args: argparse.Namespace, *, confirm: bool) -> str:
    if args.passphrase_stdin:
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Key passphrase: ")
    if confirm and getpass.getpass("Repeat passphrase: ") != first:
        raise KeyToolError("the two passphrases differ")
    return first


def keygen(key_id: str, subject: str, out: Path, passphrase: str) -> dict[str, str]:
    if not _KEY_ID.fullmatch(key_id or ""):
        raise KeyToolError("key_id must be 1-64 characters from A-Z a-z 0-9 . _ : -")
    if not _SUBJECT.fullmatch(subject or ""):
        raise KeyToolError("subject must be 1-128 safe characters")
    _check_passphrase(passphrase)
    serialization, Ed25519PrivateKey = _crypto()
    key = Ed25519PrivateKey.generate()
    try:
        pem = key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
            serialization.BestAvailableEncryption(passphrase.encode("utf-8"))).decode("ascii")
    except ValueError:
        raise KeyToolError("the passphrase was refused by the encryption backend") from None
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    body = json.dumps({"format": FORMAT, "key_id": key_id, "subject": subject,
                       "public_key_hex": public, "private_key_pem": pem}, indent=1)
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)  # never overwrites an existing key
    except FileExistsError:
        raise KeyToolError("the output file already exists; choose a new path (a key is never overwritten)") from None
    except OSError as exc:
        raise KeyToolError(f"cannot create the key file: {exc.strerror}") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(body)
    except OSError as exc:
        raise KeyToolError(f"cannot write the key file: {exc.strerror}") from None
    return {"key_id": key_id, "subject": subject, "public_key_hex": public}


def _load(path: Path) -> dict[str, Any]:
    try:
        st = path.stat()
    except OSError:
        raise KeyToolError("the key file cannot be read") from None
    if os.name != "nt" and st.st_mode & 0o077:
        raise KeyToolError("the key file is readable by other users; run: chmod 600 " + str(path))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise KeyToolError("the key file is not valid") from None
    needed = {"format", "key_id", "subject", "public_key_hex", "private_key_pem"}
    if not (isinstance(data, dict) and set(data) == needed and data["format"] == FORMAT
            and all(isinstance(data[k], str) for k in needed)):
        raise KeyToolError("the key file is not a Master Brain approver key")
    return data


def public_entry(path: Path) -> dict[str, str]:
    data = _load(path)
    return {k: data[k] for k in ("key_id", "subject", "public_key_hex")}


def describe_message(message: bytes, *, key_id: str, now: datetime | None = None) -> dict[str, Any]:
    """Parse a challenge message and enforce the refusals; returns the fields shown to the human."""
    if len(message) > MAX_MESSAGE_BYTES:
        raise KeyToolError("the message is too large to be an approval challenge")
    if not message.startswith(SIGNATURE_DOMAIN):
        raise KeyToolError("this is not a Master Brain approval message; refusing to sign arbitrary bytes")
    try:
        body = json.loads(message[len(SIGNATURE_DOMAIN):].decode("utf-8"))
        payload = body["payload"]
        if payload.get("purpose") == "ctp_run_approval":
            shown = {
                "approval_event_id": body["event_id"], "kind": "RUN A REGISTERED CTP TEST (sandboxed, single use)",
                "request_id": payload["request_id"], "test_id": payload["test_id"],
                "spec_digest": payload["spec_digest"], "requester": payload["requester"],
                "approver": payload["approver_subject"], "expires_at": payload["expires_at"],
                "signing_key_id": payload["signing_key_id"],
            }
        else:
            shown = {
                "approval_event_id": body["event_id"], "mission_id": payload["mission_id"],
                "contract_digest": payload["contract_digest"], "approver": payload["approver_subject"],
                "action_digest": payload.get("action_digest", "(none)"),
                "expires_at": payload["expires_at"], "signing_key_id": payload["signing_key_id"],
            }
        if not all(isinstance(v, str) and v for v in shown.values()):
            raise ValueError
    except (ValueError, KeyError, TypeError, UnicodeDecodeError):
        raise KeyToolError("the approval message is malformed") from None
    if shown["signing_key_id"] != key_id:
        raise KeyToolError("this challenge names a different signing key; refusing to sign")
    try:
        expires = datetime.fromisoformat(shown["expires_at"].replace("Z", "+00:00"))
    except ValueError:
        raise KeyToolError("the approval message is malformed") from None
    if expires.tzinfo is None:
        raise KeyToolError("the approval message is malformed")
    if expires <= (now or datetime.now(timezone.utc)):
        raise KeyToolError("this challenge has expired; request a new one")
    return shown


def sign(path: Path, message_hex: str, passphrase: str, *, confirm, now: datetime | None = None,
         show=lambda text: None) -> str:
    data = _load(path)
    try:
        message = bytes.fromhex(message_hex.strip())
    except (ValueError, AttributeError):
        raise KeyToolError("the message is not valid hex") from None
    shown = describe_message(message, key_id=data["key_id"], now=now)
    if shown["approver"] != data["subject"]:
        raise KeyToolError("this challenge is for a different approver; refusing to sign")
    show("You are about to APPROVE:\n" + "\n".join(f"  {k}: {v}" for k, v in shown.items()))
    if not confirm():
        raise KeyToolError("not confirmed; nothing was signed")
    serialization, _ = _crypto()
    try:
        key = serialization.load_pem_private_key(data["private_key_pem"].encode("ascii"),
                                                 password=passphrase.encode("utf-8"))
    except (ValueError, TypeError):
        raise KeyToolError("wrong passphrase or damaged key file") from None
    return key.sign(message).hex()


def load_signer(path: Path, passphrase: str):
    """Signer for a SEPARATE verifier process (``ctp_verify``). Returns an object with key_id, subject,
    algorithm and ``sign``. Not used by the approval ``sign`` command, which refuses non-approval bytes."""
    data = _load(path)
    serialization, _ = _crypto()
    try:
        key = serialization.load_pem_private_key(data["private_key_pem"].encode("ascii"),
                                                 password=passphrase.encode("utf-8"))
    except (ValueError, TypeError):
        raise KeyToolError("wrong passphrase or damaged key file") from None

    class _Signer:
        key_id = data["key_id"]
        subject = data["subject"]
        algorithm = "ed25519"

        @staticmethod
        def sign(message: bytes) -> bytes:
            return key.sign(message)

    return _Signer()


def _tty_confirm() -> bool:
    try:
        with open("/dev/tty", "r+", encoding="utf-8") as tty:
            tty.write("Type 'yes' to sign: ")
            tty.flush()
            return tty.readline().strip().lower() == "yes"
    except OSError:
        raise KeyToolError("confirmation needs a terminal; use --yes only after reading the summary") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m master_brain.approval_keys", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    kg = sub.add_parser("keygen", help="make a new passphrase-protected key file")
    kg.add_argument("--key-id", required=True)
    kg.add_argument("--subject", required=True)
    kg.add_argument("--out", required=True, type=Path)
    sg = sub.add_parser("sign", help="sign one approval challenge")
    sg.add_argument("--key", required=True, type=Path)
    sg.add_argument("--message-hex", required=True)
    sg.add_argument("--yes", action="store_true", help="skip the terminal confirmation (scripts only)")
    pb = sub.add_parser("public", help="print the public entry for --approval-keys")
    pb.add_argument("--key", required=True, type=Path)
    for p in (kg, sg):
        p.add_argument("--passphrase-stdin", action="store_true", help="read the passphrase from stdin")
    args = parser.parse_args(argv)
    try:
        if args.command == "keygen":
            entry = keygen(args.key_id, args.subject, args.out, _read_passphrase(args, confirm=True))
            print(json.dumps(entry))
            print(f"private key saved (encrypted) to {args.out}; add the JSON above to --approval-keys and restart.",
                  file=sys.stderr)
        elif args.command == "public":
            print(json.dumps(public_entry(args.key)))
        else:
            sig = sign(args.key, args.message_hex, _read_passphrase(args, confirm=False),
                       confirm=(lambda: True) if args.yes else _tty_confirm,
                       show=lambda text: print(text, file=sys.stderr))
            print(sig)
    except KeyToolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
