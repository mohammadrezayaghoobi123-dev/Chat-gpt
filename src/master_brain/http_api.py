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
TLS, rate limiting and a real auth provider are NOT here (open decisions, Gate 2c).
"""
from __future__ import annotations

import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from master_brain.api_contracts import (
    API_VERSION, CreateMissionRequest, ContractError, ErrorCode, error_response,
)
from master_brain.identity import Authenticator
from master_brain.mission_service import MISSION_ID_PATTERN, MissionService, ServiceError

MAX_BODY_BYTES = 64 * 1024
SOCKET_TIMEOUT_SECONDS = 10.0
_MISSIONS = re.compile(r"/v1/missions")
_MISSION = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})")
_AUDIT = re.compile(rf"/v1/missions/({MISSION_ID_PATTERN})/audit")
_LOOPBACK = {"127.0.0.1", "localhost"}  # IPv4 only: the server socket is AF_INET


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
                port: int = 0, *, allow_non_loopback: bool = False) -> ThreadingHTTPServer:
    if host not in _LOOPBACK and not allow_non_loopback:
        raise ValueError("refusing to bind a non-loopback address without allow_non_loopback=True "
                         "(no TLS/rate-limit in this transport)")

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

        def _error(self, code: ErrorCode, correlation_id: str, *, close: bool = False) -> None:
            resp = error_response(code, correlation_id)
            extra = {"WWW-Authenticate": "Bearer"} if code is ErrorCode.UNAUTHENTICATED else {}
            if close:
                extra["Connection"] = "close"
                self.close_connection = True
            self._send(resp.http_status, resp.to_dict(), correlation_id, extra)

        def _identity(self):
            header = self.headers.get("Authorization")
            if not header or not header.startswith("Bearer "):
                return None
            return authenticator.authenticate(header[len("Bearer "):])

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
                routes = (
                    ("POST", _MISSIONS, self._create), ("GET", _MISSION, self._get),
                    ("GET", _AUDIT, self._audit),
                )
                matched = [(m, rx.fullmatch(path), fn) for m, rx, fn in routes if rx.fullmatch(path)]
                if not matched:
                    return self._error(ErrorCode.NOT_FOUND, correlation_id, close=True)
                allowed = [x for x in matched if x[0] == method]
                if not allowed:
                    return self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
                identity = self._identity()
                if identity is None:
                    return self._error(ErrorCode.UNAUTHENTICATED, correlation_id, close=True)
                _, match, handler = allowed[0]
                handler(identity, match, correlation_id)
            except ServiceError as exc:
                self._error(exc.code, correlation_id, close=exc.code is ErrorCode.UNAVAILABLE)
            except Exception:
                self._error(ErrorCode.UNAVAILABLE, correlation_id, close=True)

        # ---------------------------------------------------------------- routes
        def _create(self, identity, _match, correlation_id: str) -> None:
            raw = self._read_body()
            if raw is None:
                return self._error(ErrorCode.INVALID_REQUEST, correlation_id, close=True)
            try:
                request = CreateMissionRequest.from_dict(parse_json_body(raw))
            except (_BadJson, ContractError):
                return self._error(ErrorCode.INVALID_REQUEST, correlation_id)
            result = service.create_mission(identity, request)
            self._send(201 if result.created else 200, result.view.to_dict(), correlation_id)

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

    return Server((host, port), Handler)


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return thread


__all__ = ["MAX_BODY_BYTES", "make_server", "parse_json_body", "serve_in_thread"]
