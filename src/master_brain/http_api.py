"""Local stdlib HTTP transport for API v1 (Gate 2a). No third-party dependency.

Security posture (each item has a test):
- binds to loopback only unless ``allow_non_loopback=True`` is passed explicitly;
- authenticates BEFORE reading the body; identity comes only from the bearer token;
- strict JSON (UTF-8, object only, duplicate keys and NaN/Infinity rejected), body limit,
  required Content-Length (no chunked bodies), socket timeout;
- every response carries a server-generated correlation id, ``Cache-Control: no-store``,
  ``X-Content-Type-Options: nosniff``; error bodies use the fixed closed message set;
- unexpected failures become ``unavailable`` (503) without leaking internals.

The closed error set has no 405/413/411: wrong method/route => ``not_found``/``invalid_request``.
Rate limiting (``rate_limit.py``): failed authentications are throttled per client address and
authenticated requests per subject; refusals are ``rate_limited`` (429 + ``Retry-After``) and happen BEFORE the
request body is read or any work is done. The web client is served read-only from ``/app/`` (strict CSP). TLS and a real auth provider are
NOT here (open decisions, Gate 2c).
"""
from __future__ import annotations

import json
import re
import sys
import threading
import uuid
from importlib import resources
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterable

from master_brain.accounts import ABSOLUTE_LIFETIME, IDLE_TIMEOUT, AccountStore
from master_brain.api_contracts import (
    API_VERSION, ApprovalChallengeRequest, CreateMissionRequest, ContractError, ErrorCode,
    ExecuteMissionRequest, LoginRequest, ReconcileRequest, SessionView, SubmitApprovalRequest, error_response,
)
from master_brain.identity import Authenticator
from master_brain.mission_service import MISSION_ID_PATTERN, MissionService, ServiceError
from master_brain.rate_limit import RateGate, retry_after_header

MAX_BODY_BYTES = 64 * 1024
SOCKET_TIMEOUT_SECONDS = 10.0
_MISSIONS = re.compile(r"/v1/missions")
_MISSION = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})")
_AUDIT = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/audit")
_CHALLENGES = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/approval-challenges")
_APPROVALS = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/approvals")
_EXECUTIONS = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/executions")
_RECONCILIATIONS = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/reconciliations")
_RESULT = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/result")
_TASKS = re.compile(r"/v1/tasks")
_SESSION = re.compile(r"/v1/session")
COOKIE_NAME = "mb_session"
_MAX_COOKIE_HEADER = 4096
_LOOPBACK = {"127.0.0.1", "localhost"}  # IPv4 only: the server socket is AF_INET

# Web client (Gate 3): static, public, no mission data; only GET. The page can only talk to this origin.
_STATIC_FILES = {
    "/app/": ("index.html", "text/html; charset=utf-8"),
    "/app/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app/strings.json": ("strings.json", "application/json; charset=utf-8"),
}
WEB_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
           "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


def _load_static() -> dict[str, tuple[bytes, str]]:
    web = resources.files("master_brain").joinpath("web")
    return {path: (web.joinpath(name).read_bytes(), ctype) for path, (name, ctype) in _STATIC_FILES.items()}


class _BadJson(ValueError):
    pass


def _reject_constant(name: str) -> Any:
    raise _BadJson("non-finite number")


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise _BadJson("duplicate key")
        out[key] = value
    return out


def parse_json_body(raw: bytes) -> Any:
    try:
        text = raw.decode("utf-8")
        return json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise _BadJson("invalid json") from None


def make_server(service: MissionService, authenticator: Authenticator, host: str = "127.0.0.1",
                port: int = 0, *, allow_non_loopback: bool = False,
                rate_gate: RateGate | None = None, accounts: AccountStore | None = None,
                allowed_hosts: Iterable[str] | None = None, secure_cookies: bool = False) -> ThreadingHTTPServer:
    """``rate_gate`` defaults to ``RateGate()`` (limits ON); pass your own to tune or to inject a clock.

    ``accounts`` enables ``/v1/session`` (login/whoami/logout with an HttpOnly SameSite=Strict cookie); the
    ``authenticator`` must then also accept sessions (see ``SessionAuthenticator``/``ChainAuthenticator``).
    Every request's ``Host`` must be in ``allowed_hosts`` (default: ``127.0.0.1:<port>`` and
    ``localhost:<port>``) - this defeats DNS rebinding; binding a non-loopback address REQUIRES an explicit
    list. Set ``secure_cookies=True`` only behind TLS (adds ``Secure`` and expects ``https`` origins)."""
    gate = rate_gate if rate_gate is not None else RateGate()
    if host not in _LOOPBACK and not allow_non_loopback:
        raise ValueError("refusing to bind a non-loopback address without allow_non_loopback=True "
                         "(no TLS/rate-limit in this transport)")
    if host not in _LOOPBACK and allowed_hosts is None:
        raise ValueError("a non-loopback bind requires an explicit allowed_hosts list (DNS-rebinding defence)")
    host_allow: set[str] = {h.lower() for h in (allowed_hosts or ())}
    scheme = "https" if secure_cookies else "http"

    static = _load_static()  # fail fast at start-up if the client files are missing

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = SOCKET_TIMEOUT_SECONDS
        server_version = "MasterBrain"
        sys_version = ""

        def log_message(self, *_args: Any) -> None:  # no request logging: URLs/headers may be sensitive
            return

        # -------------------------------------------------------------- plumbing
        def _send(self, status: int, body: dict[str, Any], correlation_id: str,
                  extra: dict[str, str] | None = None) -> None:
            data = json.dumps(body, ensure_ascii=False, sort_keys=True).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Correlation-Id", correlation_id)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _error(self, code: ErrorCode, correlation_id: str, *, close: bool = False,
                   retry_after: float | None = None) -> None:
            resp = error_response(code, correlation_id)
            extra = {"WWW-Authenticate": "Bearer"} if code is ErrorCode.UNAUTHENTICATED else {}
            if retry_after is not None:
                extra["Retry-After"] = retry_after_header(retry_after)
            if close:
                extra["Connection"] = "close"
                self.close_connection = True
            self._send(resp.http_status, resp.to_dict(), correlation_id, extra)

        def _send_static(self, path: str, correlation_id: str) -> None:
            data, ctype = static[path]
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Correlation-Id", correlation_id)
            self.send_header("Content-Security-Policy", WEB_CSP)
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(data)

        def _credential(self) -> tuple[str | None, str | None]:
            """(credential, source). An Authorization header, even a malformed one, wins over any cookie."""
            header = self.headers.get("Authorization")
            if header is not None:
                return (header[len("Bearer "):], "bearer") if header.startswith("Bearer ") and header[7:] else (None, None)
            raw = self.headers.get("Cookie")
            if raw and len(raw) <= _MAX_COOKIE_HEADER:
                try:
                    jar: SimpleCookie = SimpleCookie()
                    jar.load(raw)
                    morsel = jar.get(COOKIE_NAME)
                except CookieError:
                    morsel = None
                if morsel is not None and morsel.value:
                    return morsel.value, "cookie"
            return None, None

        def _same_origin(self) -> bool:
            return (self.headers.get("Origin") or "").lower() == f"{scheme}://{(self.headers.get('Host') or '').lower()}"

        def _cookie(self, value: str, max_age: int) -> str:
            return (f"{COOKIE_NAME}={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Strict"
                    + ("; Secure" if secure_cookies else ""))

        def _read_body(self) -> bytes | None:
            """None => request rejected as invalid (caller responds and closes)."""
            if self.headers.get("Transfer-Encoding") is not None:
                return None
            length = self.headers.get("Content-Length")
            if length is None or not length.isascii() or not length.isdigit() or len(length) > 9:
                return None
            if int(length) > MAX_BODY_BYTES:
                return None
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                return None
            return self.rfile.read(int(length))

        def _dispatch(self, method: str) -> None:
            correlation_id = uuid.uuid4().hex
            try:
                path = self.path
                if "?" in path:  # no query parameters in API v1
                    return self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
                if (self.headers.get("Host") or "").lower() not in host_allow:  # DNS rebinding defence
                    return self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
                if path in static:
                    if method != "GET":
                        return self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
                    return self._send_static(path, correlation_id)
                if accounts is not None and path == "/v1/session" and method == "POST":
                    return self._login(correlation_id)
                routes = (
                    ("POST", _MISSIONS, self._create), ("GET", _MISSION, self._get),
                    ("GET", _AUDIT, self._audit),
                    ("POST", _CHALLENGES, self._challenge), ("POST", _APPROVALS, self._approve),
                    ("POST", _RECONCILIATIONS, self._reconcile), ("POST", _EXECUTIONS, self._execute), ("GET", _RESULT, self._result),
                    ("GET", _TASKS, self._tasks),
                ) + ((("GET", _SESSION, self._session_info), ("DELETE", _SESSION, self._logout))
                     if accounts is not None else ())
                matched = [(m, rx.fullmatch(path), fn) for m, rx, fn in routes if rx.fullmatch(path)]
                if not matched:
                    return self._error(ErrorCode.NOT_FOUND, correlation_id, close=True)
                allowed = [x for x in matched if x[0] == method]
                if not allowed:
                    return self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
                address = self.client_address[0]
                blocked = gate.address_blocked_for(address)  # before authenticating: no oracle while blocked
                if blocked > 0:
                    return self._error(ErrorCode.RATE_LIMITED, correlation_id, close=True, retry_after=blocked)
                credential, source = self._credential()
                identity = authenticator.authenticate(credential) if credential else None
                if identity is None:
                    gate.record_auth_failure(address)
                    return self._error(ErrorCode.UNAUTHENTICATED, correlation_id, close=True)
                self._credential_value = credential
                if source == "cookie" and method != "GET" and not self._same_origin():
                    # ambient (cookie) credentials need a same-origin proof on every state change (CSRF)
                    return self._error(ErrorCode.FORBIDDEN, correlation_id, close=True)
                wait = gate.identity_wait(identity.subject)
                if wait > 0:
                    return self._error(ErrorCode.RATE_LIMITED, correlation_id, close=True, retry_after=wait)
                _, match, handler = allowed[0]
                handler(identity, match, correlation_id)
            except ServiceError as exc:
                self._error(exc.code, correlation_id, close=exc.code is ErrorCode.UNAVAILABLE)
            except Exception:
                self._error(ErrorCode.UNAVAILABLE, correlation_id, close=True)

        # ---------------------------------------------------------------- routes
        def _login(self, correlation_id: str) -> None:
            address = self.client_address[0]
            blocked = gate.address_blocked_for(address)
            if blocked > 0:
                return self._error(ErrorCode.RATE_LIMITED, correlation_id, close=True, retry_after=blocked)
            if self.headers.get("Origin") is not None and not self._same_origin():  # login CSRF
                return self._error(ErrorCode.FORBIDDEN, correlation_id, close=True)
            request = self._json_request(LoginRequest, correlation_id)
            if request is None:
                return
            locked = gate.account_blocked_for(request.subject)
            if locked > 0:
                return self._error(ErrorCode.RATE_LIMITED, correlation_id, close=False, retry_after=locked)
            identity = accounts.verify_password(request.subject, request.password)
            if identity is None:
                gate.record_auth_failure(address)
                gate.record_account_failure(request.subject)
                return self._error(ErrorCode.UNAUTHENTICATED, correlation_id)
            token, expires = accounts.create_session(identity)
            max_age = int(ABSOLUTE_LIFETIME.total_seconds())
            view = SessionView(identity.subject, tuple(identity.roles), expires.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                               int(IDLE_TIMEOUT.total_seconds()))
            self._send(201, view.to_dict(), correlation_id, {"Set-Cookie": self._cookie(token, max_age)})

        def _session_info(self, identity, _match, correlation_id: str) -> None:
            expires = accounts.session_expiry(self._credential_value)
            if expires is None:  # authenticated by a static token: there is no session to describe
                raise ServiceError(ErrorCode.NOT_FOUND)
            view = SessionView(identity.subject, tuple(identity.roles), expires.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                               int(IDLE_TIMEOUT.total_seconds()))
            self._send(200, view.to_dict(), correlation_id)

        def _logout(self, identity, _match, correlation_id: str) -> None:
            accounts.revoke_session(self._credential_value)
            self._send(200, {"api_version": API_VERSION, "signed_out": True}, correlation_id,
                       {"Set-Cookie": self._cookie("", 0)})

        def _create(self, identity, _match, correlation_id: str) -> None:
            request = self._json_request(CreateMissionRequest, correlation_id)
            if request is not None:
                result = service.create_mission(identity, request)
                self._send(201 if result.created else 200, result.view.to_dict(), correlation_id)

        def _json_request(self, cls, correlation_id: str):
            """Parsed request object, or None after an invalid_request response was sent."""
            raw = self._read_body()
            if raw is None:
                self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
                return None
            try:
                return cls.from_dict(parse_json_body(raw))
            except (_BadJson, ContractError):
                self._error(ErrorCode.INVALID_REQUEST, correlation_id)
                return None

        def _challenge(self, identity, match, correlation_id: str) -> None:
            request = self._json_request(ApprovalChallengeRequest, correlation_id)
            if request is not None:
                challenge = service.request_approval_challenge(identity, match.group(1), request)
                self._send(201, challenge.to_dict(), correlation_id)

        def _approve(self, identity, match, correlation_id: str) -> None:
            request = self._json_request(SubmitApprovalRequest, correlation_id)
            if request is not None:
                result = service.submit_approval(identity, match.group(1), request)
                self._send(201 if result.created else 200, result.view.to_dict(), correlation_id)

        def _execute(self, identity, match, correlation_id: str) -> None:
            request = self._json_request(ExecuteMissionRequest, correlation_id)
            if request is not None:
                result = service.execute_mission(identity, match.group(1), request)
                self._send(201, result.to_dict(), correlation_id)

        def _reconcile(self, identity, match, correlation_id: str) -> None:
            request = self._json_request(ReconcileRequest, correlation_id)
            if request is not None:
                result = service.reconcile_attempt(identity, match.group(1), request)
                self._send(201 if result.created else 200, result.view.to_dict(), correlation_id)

        def _result(self, identity, match, correlation_id: str) -> None:
            self._send(200, service.get_result(identity, match.group(1)).to_dict(), correlation_id)

        def _tasks(self, identity, _match, correlation_id: str) -> None:
            self._send(200, {"api_version": API_VERSION,
                             "tasks": [t.to_dict() for t in service.list_tasks(identity)]}, correlation_id)

        def _get(self, identity, match, correlation_id: str) -> None:
            self._send(200, service.get_mission(identity, match.group(1)).to_dict(), correlation_id)

        def _audit(self, identity, match, correlation_id: str) -> None:
            events = service.list_audit(identity, match.group(1))
            self._send(200, {"api_version": API_VERSION, "mission_id": match.group(1),
                             "events": [e.to_dict() for e in events]}, correlation_id)

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def do_PUT(self) -> None:
            self._dispatch("PUT")

        def do_DELETE(self) -> None:
            self._dispatch("DELETE")

        def do_PATCH(self) -> None:
            self._dispatch("PATCH")

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def handle_error(self, request, client_address) -> None:
            """A client that vanishes mid-request is not a server fault (no traceback noise);
            anything else is reported by exception type only, never with request data."""
            exc = sys.exc_info()[1]
            if isinstance(exc, (ConnectionError, TimeoutError)):
                return
            sys.stderr.write(f"unexpected server error: {type(exc).__name__}\n")

    server = Server((host, port), Handler)
    if allowed_hosts is None:  # loopback bind: the port is only known now
        bound = server.server_address[1]
        host_allow.update({f"127.0.0.1:{bound}", f"localhost:{bound}"})
    return server


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


__all__ = ["COOKIE_NAME", "MAX_BODY_BYTES", "WEB_CSP", "make_server", "parse_json_body", "serve_in_thread"]
