"""End-to-end tests against a REAL running local HTTP server (Gate 2a, OPS-001 first slice)."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from master_brain.api_contracts import ERROR_TABLE, ErrorCode
from master_brain.audit_store import AuditStore
from master_brain.http_api import MAX_BODY_BYTES, make_server, serve_in_thread
from master_brain.identity import Identity, StaticTokenAuthenticator
from master_brain.mission_service import MissionService, mission_id_for

ALICE = "alice-token-" + "a" * 32
BOB = "bob-token---" + "b" * 32
KEY = "key-0001-abcdef"


class Running:
    def __init__(self, path, verifier=None, clock=None):
        self.store = AuditStore(path, clock=clock)
        self.server = make_server(MissionService(self.store, verifier),
                                  StaticTokenAuthenticator({ALICE: "user:alice", BOB: "user:bob"}))
        self.thread = serve_in_thread(self.server)
        self.port = self.server.server_address[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def call(self, method, path, body=None, token=ALICE, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            h = dict(headers or {})
            if token is not None:
                h.setdefault("Authorization", f"Bearer {token}")
            data = raw
            if body is not None:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            if data is not None:
                h.setdefault("Content-Type", "application/json")
            conn.request(method, path, body=data, headers=h)
            resp = conn.getresponse()
            payload = resp.read()
            return resp.status, dict(resp.getheaders()), payload
        finally:
            conn.close()

    def json(self, *a, **kw):
        status, headers, payload = self.call(*a, **kw)
        return status, headers, json.loads(payload.decode("utf-8"))


class HttpBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "audit.jsonl"
        self.app = Running(self.path)
        self.addCleanup(self.app.close)

    def create(self, **kw):
        body = {"idempotency_key": KEY, "objective": "Evaluate supplier risk", **kw}
        return self.app.json("POST", "/v1/missions", body)


class MissionLifecycleOverHttp(HttpBase):
    def test_create_get_reload_replay_conflict(self):
        status, headers, view = self.create(success_criteria=["report with 3 sources"])
        self.assertEqual(status, 201)
        mid = view["mission_id"]
        self.assertEqual(mid, mission_id_for(Identity("user:alice"), KEY))
        self.assertEqual((view["state"], view["execution"]), ("planned", "not_started"))
        self.assertEqual(view["clarification_questions"], [])
        self.assertNotIn("completed", json.dumps(view))
        got = self.app.json("GET", f"/v1/missions/{mid}")
        self.assertEqual((got[0], got[2]), (200, view))

        replay = self.create(success_criteria=["report with 3 sources"])
        self.assertEqual((replay[0], replay[2]), (200, view))  # idempotent: same view, not created again

        status, _, err = self.create(success_criteria=["different"])
        self.assertEqual((status, err["error"]["code"]), (409, "conflict"))

        # "restart": a brand-new server over the same persisted log serves the same mission
        self.app.close()
        self.app = Running(self.path)
        self.addCleanup(self.app.close)
        self.assertEqual(self.app.json("GET", f"/v1/missions/{mid}")[2], view)
        self.assertEqual(sum(e.event_type == "mission.contract_registered"
                             for e in AuditStore(self.path).read_all()), 1)

    def test_missing_success_criteria_surfaces_clarification(self):
        _, _, view = self.create()
        self.assertEqual(view["clarification_questions"], ["Define success criteria before dispatch."])

    def test_high_risk_requires_approval_and_is_never_granted_here(self):
        _, _, view = self.create(risk_tier="high", success_criteria=["x"])
        self.assertEqual((view["approval_required"], view["approval_status"]), (True, "required"))

    def test_persian_round_trip(self):
        objective = "ارزیابی ریسک تأمین‌کننده ⟂ ✓"
        _, headers, view = self.app.json("POST", "/v1/missions", {
            "idempotency_key": KEY, "objective": objective, "success_criteria": ["گزارش سه‌منبعی"]})
        self.assertEqual(view["objective"], objective)
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}")[2]["objective"], objective)
        self.assertTrue(headers["Content-Type"].startswith("application/json; charset=utf-8"))

    def test_audit_endpoint_has_no_payload_and_is_ordered(self):
        _, _, view = self.create(success_criteria=["x"])
        status, _, body = self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit")
        self.assertEqual(status, 200)
        self.assertEqual([e["event_type"] for e in body["events"]], ["mission.contract_registered"])
        self.assertEqual(set(body["events"][0]), {"event_id", "event_type", "recorded_at", "actor", "event_hash"})
        self.assertEqual(body["events"][0]["actor"], "user:alice")

    def test_concurrent_identical_creates_register_exactly_once(self):
        results = []

        def go():
            results.append(self.create(success_criteria=["x"])[0])
        threads = [threading.Thread(target=go) for _ in range(8)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(sorted(results), [200] * 7 + [201])
        self.assertEqual(sum(e.event_type == "mission.contract_registered"
                             for e in AuditStore(self.path).read_all()), 1)


class OwnershipAndAuth(HttpBase):
    def test_other_user_cannot_see_or_probe(self):
        _, _, view = self.create(success_criteria=["x"])
        mid = view["mission_id"]
        unknown = "mission-" + "0" * 16
        for suffix in ("", "/audit"):
            foreign = self.app.json("GET", f"/v1/missions/{mid}{suffix}", token=BOB)
            missing = self.app.json("GET", f"/v1/missions/{unknown}{suffix}", token=BOB)
            self.assertEqual(foreign[0], 404)
            self.assertEqual(foreign[0], missing[0])
            self.assertEqual({**foreign[2]["error"], "correlation_id": ""},
                             {**missing[2]["error"], "correlation_id": ""})
        # same key by bob is a different mission, not a collision with alice's
        bob = self.app.json("POST", "/v1/missions", {"idempotency_key": KEY, "objective": "Evaluate supplier risk",
                                                      "success_criteria": ["x"]}, token=BOB)
        self.assertEqual(bob[0], 201)
        self.assertNotEqual(bob[2]["mission_id"], mid)

    def test_unauthenticated_requests_are_rejected_before_the_body_is_read(self):
        for token, headers in ((None, None), ("wrong" * 10, None), (None, {"Authorization": "Basic abc"}),
                               (None, {"Authorization": "Bearer "})):
            with self.subTest(token=token, headers=headers):
                status, h, body = self.app.json("POST", "/v1/missions", raw=b"{not json", token=token, headers=headers)
                self.assertEqual((status, body["error"]["code"]), (401, "unauthenticated"))
                self.assertEqual(h["WWW-Authenticate"], "Bearer")
        self.assertEqual(self.app.json("GET", "/v1/missions/mission-" + "0" * 16, token=None)[0], 401)

    def test_identity_is_never_taken_from_the_body_or_headers(self):
        for extra in ({"user_id": "user:bob"}, {"mission_id": "mission-" + "1" * 16}, {"approval_granted": True},
                      {"actor": "user:bob"}):
            status, _, body = self.create(success_criteria=["x"], **extra)
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"), extra)
        status, _, view = self.app.json("POST", "/v1/missions", {"idempotency_key": KEY, "objective": "o2",
                                                                   "success_criteria": ["x"]},
                                         headers={"X-User": "user:bob", "X-Forwarded-User": "user:bob"})
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}", token=BOB)[0], 404)


class StrictTransport(HttpBase):
    def assert_invalid(self, **kw):
        status, _, body = self.app.json("POST", "/v1/missions", **kw)
        self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"), kw)

    def test_malformed_bodies_are_rejected(self):
        good = {"idempotency_key": KEY, "objective": "o", "success_criteria": ["x"]}
        for raw in (b"{not json", b"[]", b"null", b'"s"', b"", b"\xff\xfe", b'{"a":1,"a":2}',
                    b'{"idempotency_key":"key-0001-abcdef","objective":"o","x":NaN}',
                    b'{"idempotency_key":"key-0001-abcdef","objective":Infinity}',
                    b"[" * 100000):
            with self.subTest(raw=raw[:30]):
                self.assert_invalid(raw=raw)
        for body in ({**good, "idempotency_key": "short"}, {**good, "objective": ""},
                     {**good, "risk_tier": "extreme"}, {**good, "requires_approval": "yes"},
                     {**good, "constraints": "not-a-list"}, {"objective": "o"}):
            with self.subTest(body=body):
                self.assert_invalid(body=body)

    def test_content_type_length_and_size_rules(self):
        raw = json.dumps({"idempotency_key": KEY, "objective": "o"}).encode()
        self.assert_invalid(raw=raw, headers={"Content-Type": "text/plain"})
        status, _, _ = self.app.call("POST", "/v1/missions", raw=raw, headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(status, 201)
        # no Content-Length / chunked
        conn = http.client.HTTPConnection("127.0.0.1", self.app.port, timeout=10)
        conn.putrequest("POST", "/v1/missions")
        conn.putheader("Authorization", f"Bearer {ALICE}")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders()
        conn.send(b"5\r\n{\"a\":\r\n0\r\n\r\n")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 400)
        conn.close()
        big = b'{"idempotency_key":"key-0001-abcdef","objective":"' + b"x" * MAX_BODY_BYTES + b'"}'
        status, _, body = self.app.json("POST", "/v1/missions", raw=big)
        self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"))
        self.assertEqual(self.app.json("GET", "/v1/missions/mission-" + "0" * 16)[0], 404)  # server still healthy

    def test_routing_rules(self):
        mid = "mission-" + "0" * 16
        for method, path, status, code in (
            ("GET", "/", 404, "not_found"), ("GET", "/v1/other", 404, "not_found"),
            ("GET", "/v1/missions/not-an-id", 404, "not_found"), ("GET", f"/v1/missions/{mid}/audit/x", 404, "not_found"),
            ("GET", "/v1/missions", 400, "invalid_request"), ("DELETE", f"/v1/missions/{mid}", 400, "invalid_request"),
            ("PUT", "/v1/missions", 400, "invalid_request"), ("POST", f"/v1/missions/{mid}", 400, "invalid_request"),
            ("GET", f"/v1/missions/{mid}?x=1", 400, "invalid_request"),
        ):
            with self.subTest(method=method, path=path):
                got = self.app.json(method, path)
                self.assertEqual((got[0], got[2]["error"]["code"]), (status, code))

    def test_every_response_has_hardening_headers_and_unique_correlation_ids(self):
        seen = set()
        for call in (lambda: self.create(success_criteria=["x"]), lambda: self.app.json("GET", "/nope"),
                     lambda: self.app.json("GET", "/v1/missions/mission-" + "0" * 16, token=None)):
            _, headers, body = call()
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertNotIn("Python", headers.get("Server", ""))
            seen.add(headers["X-Correlation-Id"])
            if "error" in body:
                self.assertEqual(body["error"]["correlation_id"], headers["X-Correlation-Id"])
                code = ErrorCode(body["error"]["code"])
                self.assertEqual(body["error"]["message"], ERROR_TABLE[code][1])
        self.assertEqual(len(seen), 3)

    def test_tokens_never_appear_in_any_response(self):
        outputs = [self.create(success_criteria=["x"])[2], self.app.json("GET", "/x")[2],
                   self.app.json("GET", "/v1/missions/mission-" + "0" * 16, token="nope" * 12)[2]]
        text = json.dumps(outputs)
        for token in (ALICE, BOB, "nope" * 12):
            self.assertNotIn(token, text)


class TransportDetails(HttpBase):
    def test_body_size_boundary_is_exactly_64_kib(self):
        base = json.dumps({"idempotency_key": KEY, "objective": "o", "success_criteria": ["x"]}).encode()
        self.assertEqual(MAX_BODY_BYTES, 65536)
        ok = base + b" " * (65536 - len(base))
        self.assertEqual(len(ok), 65536)
        self.assertEqual(self.app.call("POST", "/v1/missions", raw=ok)[0], 201)
        too_big = base + b" " * (65537 - len(base))
        self.assertEqual(self.app.call("POST", "/v1/missions", raw=too_big)[0], 400)

    def test_json_parser_rejects_every_hostile_shape_with_valueerror(self):
        from master_brain.http_api import parse_json_body
        for raw in (b"\xff", b"{bad", b'{"a":1,"a":2}', b"NaN", b"-Infinity", b"[" * 200000):
            with self.subTest(raw=raw[:12]), self.assertRaises(ValueError):
                parse_json_body(raw)
        self.assertEqual(parse_json_body('{"k":"سلام"}'.encode("utf-8")), {"k": "سلام"})

    def test_default_port_is_ephemeral(self):
        import inspect
        from master_brain.http_api import make_server as ms
        self.assertEqual(inspect.signature(ms).parameters["port"].default, 0)

    def test_keep_alive_works_for_successful_requests(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.app.port, timeout=10)
        try:
            body = json.dumps({"idempotency_key": KEY, "objective": "o", "success_criteria": ["x"]})
            hdr = {"Authorization": f"Bearer {ALICE}", "Content-Type": "application/json"}
            conn.request("POST", "/v1/missions", body=body, headers=hdr)
            r1 = conn.getresponse(); r1.read()
            self.assertNotEqual((r1.getheader("Connection") or "").lower(), "close")
            conn.request("POST", "/v1/missions", body=body, headers=hdr)  # same socket
            r2 = conn.getresponse(); r2.read()
            self.assertEqual((r1.status, r2.status), (201, 200))
            # a handled validation error whose body was fully read keeps the connection usable too
            conn.request("POST", "/v1/missions", body=b"{bad", headers=hdr)
            r3 = conn.getresponse(); r3.read()
            self.assertEqual(r3.status, 400)
            self.assertNotEqual((r3.getheader("Connection") or "").lower(), "close")
        finally:
            conn.close()

    def test_errors_with_unread_bodies_close_the_connection(self):
        mid = "mission-" + "0" * 16
        cases = (("GET", "/nope", ALICE), ("DELETE", f"/v1/missions/{mid}", ALICE),
                 ("GET", f"/v1/missions/{mid}?x=1", ALICE), ("POST", "/v1/missions", None),
                 ("POST", "/v1/missions", "wrong" * 10))
        for method, path, token in cases:
            with self.subTest(method=method, path=path, token=token):
                _, headers, _ = self.app.call(method, path, raw=b"{}", token=token)
                self.assertEqual(headers.get("Connection", "").lower(), "close")
        _, headers, _ = self.app.call("POST", "/v1/missions", raw=b"{}", headers={"Content-Type": "text/plain"})
        self.assertEqual(headers.get("Connection", "").lower(), "close")

    def test_audit_response_names_the_requested_mission(self):
        _, _, view = self.create(success_criteria=["x"])
        body = self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit")[2]
        self.assertEqual(body["mission_id"], view["mission_id"])
        self.assertEqual(body["api_version"], "1")


class RawProtocol(HttpBase):
    def raw_exchange(self, head: bytes, body: bytes = b"") -> bytes:
        import socket
        with socket.create_connection(("127.0.0.1", self.app.port), timeout=10) as sock:
            sock.sendall(head + body)
            chunks = []
            while True:
                try:
                    data = sock.recv(65536)
                except socket.timeout:
                    break
                if not data:
                    break
                chunks.append(data)
                if b"\r\n\r\n" in b"".join(chunks) and b"Content-Length" in b"".join(chunks):
                    break
            return b"".join(chunks)

    def post_head(self, length: str) -> bytes:
        return (f"POST /v1/missions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {ALICE}\r\n"
                f"Content-Type: application/json\r\nContent-Length: {length}\r\n\r\n").encode()

    def test_content_length_must_be_plain_ascii_digits_of_at_most_nine(self):
        body = json.dumps({"idempotency_key": KEY, "objective": "o", "success_criteria": ["x"]}).encode()
        n = len(body)
        for bad in (f"+{n}", f"-{n}", f"{n} x", "", "٥", "1e2", "0x10", "1" * 10, f"{'0' * 9}{n}"):
            with self.subTest(length=bad):
                self.assertIn(b" 400 ", self.raw_exchange(self.post_head(bad), body).split(b"\r\n")[0] + b" ")
        ok = self.raw_exchange(self.post_head("0" * (9 - len(str(n))) + str(n)), body)  # exactly nine digits
        self.assertIn(b" 201 ", ok.split(b"\r\n")[0] + b" ")

    def test_connection_is_really_closed_after_an_unread_body_error(self):
        import socket
        with socket.create_connection(("127.0.0.1", self.app.port), timeout=10) as sock:
            sock.sendall(b"POST /v1/missions HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}")
            first = b""
            while b"\r\n\r\n" not in first:
                first += sock.recv(4096)
            self.assertIn(b" 401 ", first.split(b"\r\n")[0] + b" ")
            sock.settimeout(5)
            rest = b"x"
            while rest:
                rest = sock.recv(4096)  # must reach EOF (server closed), not time out
            self.assertEqual(rest, b"")

    def test_wire_format_is_utf8_and_key_sorted(self):
        _, _, raw = self.app.call("POST", "/v1/missions", body={
            "idempotency_key": KEY, "objective": "سلام", "success_criteria": ["x"]})
        self.assertIn("سلام".encode("utf-8"), raw)
        self.assertNotIn(b"\\u", raw)
        keys = list(json.loads(raw).keys())
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(list(json.loads(raw, object_pairs_hook=lambda p: [k for k, _ in p])), sorted(keys))

    def test_unavailable_closes_connection_but_not_found_does_not(self):
        _, _, view = self.create(success_criteria=["x"])
        _, headers, _ = self.app.call("GET", "/v1/missions/mission-" + "0" * 16)
        self.assertNotEqual(headers.get("Connection", "").lower(), "close")
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(text.replace("planner=mission_service.intake", "tampered"), encoding="utf-8")
        _, headers, _ = self.app.call("GET", f"/v1/missions/{view['mission_id']}")
        self.assertEqual(headers.get("Connection", "").lower(), "close")

    def test_unexpected_exceptions_become_503_and_close(self):
        def boom(*_a, **_k):
            raise RuntimeError("secret internal detail")
        self.app.server.RequestHandlerClass  # server is live
        import master_brain.http_api as api
        orig = MissionService.get_mission
        MissionService.get_mission = boom
        self.addCleanup(setattr, MissionService, "get_mission", orig)
        status, headers, raw = self.app.call("GET", "/v1/missions/mission-" + "0" * 16)
        self.assertEqual(status, 503)
        self.assertEqual(headers.get("Connection", "").lower(), "close")
        self.assertNotIn(b"secret internal detail", raw)


class FailClosed(HttpBase):
    def test_corrupt_audit_log_yields_503_without_leaking_internals(self):
        _, _, view = self.create(success_criteria=["x"])
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(text.replace("planner=mission_service.intake", "tampered"), encoding="utf-8")
        for method, path, body in (("GET", f"/v1/missions/{view['mission_id']}", None),
                                   ("GET", f"/v1/missions/{view['mission_id']}/audit", None),
                                   ("POST", "/v1/missions", {"idempotency_key": "key-0002-abcdef", "objective": "o"})):
            with self.subTest(path=path):
                status, headers, raw = self.app.call(method, path, body=body)
                self.assertEqual(status, 503)
                parsed = json.loads(raw)
                self.assertEqual(parsed["error"]["code"], "unavailable")
                self.assertTrue(parsed["error"]["retryable"])
                for secret in (str(self.path), "Traceback", "hash", "tampered"):
                    self.assertNotIn(secret, raw.decode())

    def test_secret_like_content_is_rejected_by_audit_policy_as_invalid(self):
        status, _, body = self.app.json("POST", "/v1/missions", {
            "idempotency_key": KEY, "objective": "use api_key=sk-" + "a" * 40, "success_criteria": ["x"]})
        self.assertIn(status, (400,))
        self.assertEqual(body["error"]["code"], "invalid_request")
        self.assertEqual(AuditStore(self.path).read_all(), ())


class ServerConstruction(unittest.TestCase):
    def test_non_loopback_bind_is_refused_by_default(self):
        service = MissionService(AuditStore(Path(tempfile.gettempdir()) / "unused-audit.jsonl"))
        auth = StaticTokenAuthenticator({ALICE: "user:alice"})
        for host in ("0.0.0.0", "192.168.1.5", "", "::1", "::"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                make_server(service, auth, host)
        for host in ("127.0.0.1", "localhost"):
            with self.subTest(host=host):
                make_server(service, auth, host).server_close()
        server = make_server(service, auth, "0.0.0.0", allow_non_loopback=True)
        server.server_close()


if __name__ == "__main__":
    unittest.main()
