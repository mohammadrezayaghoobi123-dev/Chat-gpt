"""Local accounts and server-side sessions (Gate 2c-2, SAFE-002, PLAT-001). Standard library only.

* Passwords: ``hashlib.scrypt`` (N=2**14, r=8, p=1) with a per-account random salt; the stored record
  carries its own parameters so the cost can be raised later. Verification is constant-time, and an
  unknown or disabled subject still pays for one hash, so neither response body nor timing says which
  subjects exist. There is NO self-registration: accounts are created by the operator (``python -m
  master_brain.accounts``) and roles are never taken from a request.
* Sessions: 256-bit random opaque tokens; only their SHA-256 digest is stored, so a database leak does not
  leak live sessions. Idle timeout, absolute lifetime, revocation (logout, password change, disable) and a
  per-subject session cap. Roles/disabled state are re-read on EVERY authentication, so revoking a role
  or disabling an account takes effect immediately, not at session expiry.
* Time comes from an injectable UTC clock.

Open limits (documented, not hidden): no password-breach list, no MFA, no password reset flow (operator
resets), no audit-chain events for logins (a separate security-event log is a later item).
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import secrets
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

from master_brain.identity import KNOWN_ROLES, Identity

SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN, SALT_BYTES = 2 ** 14, 8, 1, 32, 16
_SCRYPT_MAXMEM = 64 * 1024 * 1024
MIN_PASSWORD_CHARS, MAX_PASSWORD_CHARS = 12, 256
IDLE_TIMEOUT = timedelta(minutes=30)
ABSOLUTE_LIFETIME = timedelta(hours=8)
MAX_SESSIONS_PER_SUBJECT = 10
_TOUCH_INTERVAL = timedelta(seconds=30)  # do not write on every request


class AccountError(ValueError):
    """Operator-facing problem (bad password policy, duplicate or unknown subject)."""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def _hash_password(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=SCRYPT_DKLEN,
                          maxmem=_SCRYPT_MAXMEM)


def _encode_record(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = _hash_password(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def _verify_record(password: str, record: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = record.split("$")
        if scheme != "scrypt":
            return False
        n, r, p = int(n), int(r), int(p)
        if not (2 ** 10 <= n <= 2 ** 20 and 1 <= r <= 16 and 1 <= p <= 4):
            return False
        expected = bytes.fromhex(digest_hex)
        actual = _hash_password(password, bytes.fromhex(salt_hex), n, r, p)
    except (ValueError, TypeError, OverflowError):
        return False
    return hmac.compare_digest(expected, actual)


def check_password_policy(subject: str, password: str) -> None:
    if not isinstance(password, str) or "\x00" in password:
        raise AccountError("password must be text without NUL characters")
    if not MIN_PASSWORD_CHARS <= len(password) <= MAX_PASSWORD_CHARS:
        raise AccountError(f"password must be {MIN_PASSWORD_CHARS}-{MAX_PASSWORD_CHARS} characters")
    if password.lower() == subject.lower() or len(set(password)) < 5:
        raise AccountError("password is too guessable (equals the subject or has fewer than 5 distinct characters)")


class AccountStore:
    def __init__(self, path: str | Path, *, clock: Callable[[], datetime] | None = None) -> None:
        self.path = Path(path)
        self._clock = clock or _utc_now
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.executescript(
                "CREATE TABLE IF NOT EXISTS accounts (subject TEXT PRIMARY KEY, password_record TEXT NOT NULL,"
                " roles TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);"
                "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL,"
                " created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL);"
                "CREATE INDEX IF NOT EXISTS sessions_by_subject ON sessions(subject);")
        self._dummy_record = _encode_record("dummy-password-for-timing-only")

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def now(self) -> datetime:
        return self._clock()

    # ------------------------------------------------------------------ operator actions
    def create_account(self, subject: str, password: str, roles: Iterable[str] = ()) -> None:
        identity = Identity(subject, frozenset(roles))  # validates subject and roles
        check_password_policy(subject, password)
        record = _encode_record(password)
        try:
            with closing(self._connect()) as db:
                db.execute("INSERT INTO accounts(subject,password_record,roles,disabled,created_at) VALUES(?,?,?,0,?)",
                           (identity.subject, record, ",".join(sorted(identity.roles)), _iso(self.now())))
        except sqlite3.IntegrityError as exc:
            raise AccountError("subject already exists") from exc

    def set_password(self, subject: str, password: str) -> None:
        check_password_policy(subject, password)
        with closing(self._connect()) as db:
            changed = db.execute("UPDATE accounts SET password_record=? WHERE subject=?",
                                 (_encode_record(password), subject)).rowcount
            if not changed:
                raise AccountError("unknown subject")
            db.execute("DELETE FROM sessions WHERE subject=?", (subject,))  # old password => old sessions die

    def set_disabled(self, subject: str, disabled: bool) -> None:
        with closing(self._connect()) as db:
            if not db.execute("UPDATE accounts SET disabled=? WHERE subject=?", (1 if disabled else 0, subject)).rowcount:
                raise AccountError("unknown subject")
            if disabled:
                db.execute("DELETE FROM sessions WHERE subject=?", (subject,))

    def set_roles(self, subject: str, roles: Iterable[str]) -> None:
        roles = frozenset(roles)
        if not roles <= KNOWN_ROLES:
            raise AccountError("unknown role")
        with closing(self._connect()) as db:
            if not db.execute("UPDATE accounts SET roles=? WHERE subject=?", (",".join(sorted(roles)), subject)).rowcount:
                raise AccountError("unknown subject")

    # ------------------------------------------------------------------ login
    def verify_password(self, subject: object, password: object) -> Identity | None:
        """Identity on success; None for every failure (unknown, disabled, wrong password) at the same cost."""
        if not isinstance(subject, str) or not isinstance(password, str) or len(password) > MAX_PASSWORD_CHARS \
                or len(subject) > 128 or "\x00" in password:
            _verify_record("x", self._dummy_record)
            return None
        with closing(self._connect()) as db:
            row = db.execute("SELECT password_record, roles, disabled FROM accounts WHERE subject=?", (subject,)).fetchone()
        record = row[0] if row else self._dummy_record
        ok = _verify_record(password, record)
        if not ok or row is None or row[2]:
            return None
        return Identity(subject, frozenset(filter(None, row[1].split(","))))

    # ------------------------------------------------------------------ sessions
    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def create_session(self, identity: Identity) -> tuple[str, datetime]:
        """Return (opaque token, absolute expiry). The token is shown once; only its digest is kept."""
        now = self.now()
        token = secrets.token_urlsafe(32)
        expires = now + ABSOLUTE_LIFETIME
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?",
                       (_iso(now), _iso(now - IDLE_TIMEOUT)))
            db.execute("INSERT INTO sessions(token_hash,subject,created_at,last_seen,expires_at) VALUES(?,?,?,?,?)",
                       (self._digest(token), identity.subject, _iso(now), _iso(now), _iso(expires)))
            db.execute("DELETE FROM sessions WHERE subject=? AND token_hash NOT IN ("
                       " SELECT token_hash FROM sessions WHERE subject=? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
                       (identity.subject, identity.subject, MAX_SESSIONS_PER_SUBJECT))
            db.execute("COMMIT")
        return token, expires

    def authenticate_session(self, token: object) -> Identity | None:
        if not isinstance(token, str) or not 20 <= len(token) <= 128 or not token.isascii():
            return None
        digest, now = self._digest(token), self.now()
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT s.last_seen, s.expires_at, a.roles, a.disabled, s.subject FROM sessions s "
                "JOIN accounts a ON a.subject = s.subject WHERE s.token_hash=?", (digest,)).fetchone()
            if row is None:
                return None
            last_seen, expires_at = _parse(row[0]), _parse(row[1])
            if row[3] or now > expires_at or now - last_seen > IDLE_TIMEOUT:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (digest,))
                return None
            if now - last_seen >= _TOUCH_INTERVAL:
                db.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (_iso(now), digest))
            return Identity(row[4], frozenset(filter(None, row[2].split(","))))

    def session_expiry(self, token: str) -> datetime | None:
        with closing(self._connect()) as db:
            row = db.execute("SELECT expires_at FROM sessions WHERE token_hash=?", (self._digest(token),)).fetchone()
        return _parse(row[0]) if row else None

    def revoke_session(self, token: object) -> bool:
        if not isinstance(token, str):
            return False
        with closing(self._connect()) as db:
            return db.execute("DELETE FROM sessions WHERE token_hash=?", (self._digest(token),)).rowcount > 0

    def session_count(self, subject: str) -> int:
        with closing(self._connect()) as db:
            return db.execute("SELECT COUNT(*) FROM sessions WHERE subject=?", (subject,)).fetchone()[0]


class SessionAuthenticator:
    """The ``Authenticator`` seam backed by server-side sessions (token = the session cookie value)."""

    def __init__(self, accounts: AccountStore) -> None:
        self._accounts = accounts

    def authenticate(self, credential: str | None) -> Identity | None:
        return self._accounts.authenticate_session(credential)


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m master_brain.accounts",
                                     description="Operator tool: manage local Master Brain accounts.")
    parser.add_argument("--db", required=True, help="path of the accounts SQLite file")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("add", "passwd"):
        p = sub.add_parser(name)
        p.add_argument("--subject", required=True)
        p.add_argument("--password-stdin", action="store_true", help="read the password from stdin (no echo prompt)")
        if name == "add":
            p.add_argument("--operator", action="store_true", help="grant the operator role")
    for name in ("disable", "enable"):
        sub.add_parser(name).add_argument("--subject", required=True)
    args = parser.parse_args(argv)
    store = AccountStore(args.db)
    try:
        if args.command in ("add", "passwd"):
            password = sys.stdin.readline().rstrip("\n") if args.password_stdin else getpass.getpass("Password: ")
            if args.command == "add":
                store.create_account(args.subject, password, ("operator",) if args.operator else ())
            else:
                store.set_password(args.subject, password)
        else:
            store.set_disabled(args.subject, args.command == "disable")
    except (AccountError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(_main())

__all__ = ["ABSOLUTE_LIFETIME", "AccountError", "AccountStore", "IDLE_TIMEOUT", "MAX_SESSIONS_PER_SUBJECT",
           "SessionAuthenticator", "check_password_policy"]
