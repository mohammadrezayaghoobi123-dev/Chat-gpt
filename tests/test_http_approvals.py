"""Gate 2b-1: approval challenge/response over a REAL running server (SAFE-002, PLAT-001)."""
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from master_brain.audit_store import AuditStore
from tests.approval_signing_helper import TEST_ALGORITHM, HmacSeamSigner, HmacSeamVerifier
from tests.test_http_api import ALICE, BOB, KEY, Running

ACTION = "a" * 64
SECRET_A, SECRET_B = b"alice-secret", b"bob-secret"


class FakeClock:
    def __init__(self):
        self.now = datetime.now(timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, **kw):
        self.now += timedelta(**kw)


class ApprovalBase(unittest.TestCase):
    verifier_configured = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "audit.jsonl"
        self.clock = FakeClock()
        self.verifier = HmacSeamVerifier()
        self.verifier.add("k-alice", SECRET_A, "user:alice")
        self.verifier.add("k-bob", SECRET_B, "user:bob")
        self.app = Running(self.path, self.verifier if self.verifier_configured else None, self.clock)
        self.addCleanup(self.app.close)
        self.alice_signer = HmacSeamSigner("k-alice", SECRET_A)

    def mission(self, risk="high", token=ALICE, key=KEY):
        status, _, view = self.app.json("POST", "/v1/missions", {
            "idempotency_key": key, "objective": "Pay supplier", "success_criteria": ["receipt"],
            "risk_tier": risk}, token=token)
        self.assertEqual(status, 201, view)
        return view

    def challenge(self, view, token=ALICE, **kw):
        body = {"contract_digest": view["contract_digest"], "signing_key_id": "k-alice",
                "signature_alg": TEST_ALGORITHM, "action_digest": ACTION, **kw}
        return self.app.json("POST", f"/v1/missions/{view['mission_id']}/approval-challenges", body, token=token)

    def submit(self, view, ch, signer=None, token=ALICE, **kw):
        signer = signer or self.alice_signer
        body = {"idempotency_key": "submit-" + ch["approval_event_id"][-12:], "approval_event_id": ch["approval_event_id"],
                "signing_key_id": signer.key_id, "signature_alg": TEST_ALGORITHM,
                "signature_hex": signer.sign(bytes.fromhex(ch["signing_message_hex"])).hex(), **kw}
        return self.app.json("POST", f"/v1/missions/{view['mission_id']}/approvals", body, token=token)

    def approve(self, view=None):
        view = view or self.mission()
        ch = self.challenge(view)[2]
        return view, ch, self.submit(view, ch)

    def events(self):
        return [(e.event_type, e.actor) for e in AuditStore(self.path).read_all()]

    def get(self, view, token=ALICE):
        return self.app.json("GET", f"/v1/missions/{view['mission_id']}", token=token)[2]


class ApprovalFlow(ApprovalBase):
    def test_full_flow_grants_only_after_a_verified_signature(self):
        view = self.mission()
        self.assertEqual((view["approval_required"], view["approval_status"], view["state"]),
                         (True, "required", "planned"))
        status, _, ch = self.challenge(view)
        self.assertEqual(status, 201)
        self.assertEqual(set(ch), {"api_version", "mission_id", "contract_digest", "approval_event_id",
                                   "expires_at", "action_digest", "signing_message_hex"})
        self.assertEqual(self.get(view)["approval_status"], "required")  # a challenge alone grants nothing
        status, _, done = self.submit(view, ch)
        self.assertEqual((status, done["approval_status"], done["state"]), (201, "granted", "approved"))
        self.assertEqual(self.get(view), done)
        self.assertEqual([t for t, _ in self.events()],
                         ["mission.contract_registered", "mission.approval_challenged", "mission.approval_granted"])
        audit = self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit")[2]["events"]
        self.assertEqual(len(audit), 3)
        self.assertNotIn("signature", json.dumps(audit))

    def test_replay_is_idempotent_and_a_different_signature_conflicts(self):
        view, ch, first = self.approve()
        again = self.submit(view, ch)
        self.assertEqual((again[0], again[2]), (200, first[2]))
        self.assertEqual(sum(t == "mission.approval_granted" for t, _ in self.events()), 1)
        other = HmacSeamSigner("k-alice", SECRET_A)
        status, _, err = self.submit(view, ch, signer=other, signature_hex="ab" * 32)
        self.assertEqual((status, err["error"]["code"]), (409, "conflict"))

    def test_bad_signature_is_rejected_leaves_no_trace_and_the_challenge_stays_usable(self):
        view = self.mission()
        ch = self.challenge(view)[2]
        forged = HmacSeamSigner("k-alice", b"wrong-secret")
        status, _, err = self.submit(view, ch, signer=forged)
        self.assertEqual((status, err["error"]["code"]), (403, "approval_invalid"))
        self.assertEqual(self.get(view)["approval_status"], "required")
        self.assertNotIn("mission.approval_granted", [t for t, _ in self.events()])
        self.assertEqual(self.submit(view, ch)[0], 201)

    def test_verifier_exceptions_and_garbage_fail_closed(self):
        view = self.mission()
        ch = self.challenge(view)[2]
        self.verifier.verify = lambda **_k: (_ for _ in ()).throw(RuntimeError("boom"))
        status, _, err = self.submit(view, ch)
        self.assertEqual((status, err["error"]["code"]), (403, "approval_invalid"))
        self.assertNotIn("boom", json.dumps(err))

    def test_key_bound_to_another_subject_cannot_approve(self):
        view = self.mission()
        ch = self.challenge(view, signing_key_id="k-bob")[2]  # alice asks for a challenge on bob's key id
        status, _, err = self.submit(view, ch, signer=HmacSeamSigner("k-bob", SECRET_B))
        self.assertEqual((status, err["error"]["code"]), (403, "approval_invalid"))
        self.assertEqual(self.get(view)["approval_status"], "required")

    def test_other_users_cannot_challenge_submit_or_use_a_foreign_challenge(self):
        view = self.mission()
        ch = self.challenge(view)[2]
        self.assertEqual(self.challenge(view, token=BOB, signing_key_id="k-bob")[0], 404)
        status, _, err = self.submit(view, ch, token=BOB, signer=HmacSeamSigner("k-bob", SECRET_B))
        self.assertEqual((status, err["error"]["code"]), (404, "not_found"))
        # on his OWN mission bob is the owner but not a designated approver (only alice is)
        bobs = self.mission(token=BOB, key="bob-key-0001")
        status, _, err = self.submit(bobs, ch, token=BOB, signer=HmacSeamSigner("k-bob", SECRET_B))
        self.assertEqual((status, err["error"]["code"]), (403, "forbidden"))

    def test_stale_contract_digest_is_refused(self):
        view = self.mission()
        status, _, err = self.challenge(view, contract_digest="0" * 64)
        self.assertEqual((status, err["error"]["code"]), (409, "stale_contract"))
        self.assertNotIn("mission.approval_challenged", [t for t, _ in self.events()])

    def test_mission_that_needs_no_approval_has_nothing_to_approve(self):
        view = self.mission(risk="low")
        self.assertEqual(view["approval_status"], "not_required")
        status, _, err = self.challenge(view)
        self.assertEqual((status, err["error"]["code"]), (409, "conflict"))

    def test_challenge_key_and_algorithm_must_match_the_submission(self):
        view = self.mission()
        ch = self.challenge(view)[2]
        for kw in ({"signing_key_id": "k-other"}, {"signature_alg": "other-alg"}):
            with self.subTest(kw=kw):
                status, _, err = self.submit(view, ch, **kw)
                self.assertEqual((status, err["error"]["code"]), (403, "approval_invalid"))
        self.assertEqual(self.get(view)["approval_status"], "required")

    def test_unknown_challenge_is_not_found(self):
        view = self.mission()
        ch = {"approval_event_id": "approval-" + "0" * 32, "signing_message_hex": "00"}
        self.assertEqual(self.submit(view, ch)[0], 404)

    def test_approval_without_an_action_binding_never_reports_granted_for_high_risk(self):
        view = self.mission()
        ch = self.challenge(view, action_digest=None)
        self.assertIn(ch[0], (201, 400))
        if ch[0] == 201:
            self.assertEqual(self.submit(view, ch[2])[2]["approval_status"], "required")


class ExpiryAndConsumption(ApprovalBase):
    def test_challenge_expires_and_a_late_signature_is_refused(self):
        view = self.mission()
        expires = (self.clock.now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        ch = self.challenge(view, expires_at=expires)[2]
        self.clock.advance(minutes=6)
        status, _, err = self.submit(view, ch)
        self.assertEqual((status, err["error"]["code"]), (403, "approval_invalid"))
        self.assertNotIn("mission.approval_granted", [t for t, _ in self.events()])

    def test_granted_status_lapses_when_the_approval_expires(self):
        view, ch, done = self.approve()
        self.assertEqual(done[2]["approval_status"], "granted")
        self.clock.advance(hours=2)
        self.assertEqual(self.get(view)["approval_status"], "required")

    def test_default_expiry_is_server_chosen_and_bounded(self):
        view = self.mission()
        ch = self.challenge(view)[2]
        expires = datetime.fromisoformat(ch["expires_at"].replace("Z", "+00:00"))
        self.assertEqual(expires - self.clock.now, timedelta(hours=1))
        too_far = (self.clock.now + timedelta(days=30)).isoformat().replace("+00:00", "Z")
        status, _, err = self.challenge(view, expires_at=too_far)
        self.assertEqual((status, err["error"]["code"]), (400, "invalid_request"))
        past = (self.clock.now - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        self.assertEqual(self.challenge(view, expires_at=past)[0], 400)

    def test_an_action_bound_approval_is_no_longer_granted_once_consumed(self):
        view, ch, _ = self.approve()
        store = AuditStore(self.path, clock=self.clock)
        store.append(event_id="dispatch-1", event_type="mission.dispatch_started",
                     recorded_at=self.clock.now.isoformat().replace("+00:00", "Z"), actor="user:alice",
                     subject_ref=f"mission:{view['mission_id']}",
                     payload={"mission_id": view["mission_id"], "contract_digest": view["contract_digest"],
                              "integration_id": "i", "attempt_id": "a1",
                              "approval_event_id": ch["approval_event_id"]})
        self.assertEqual(self.get(view)["approval_status"], "required")


class Misconfiguration(ApprovalBase):
    verifier_configured = False

    def test_without_a_verifier_no_approval_can_be_issued_or_accepted(self):
        view = self.mission()
        status, _, err = self.challenge(view)
        self.assertEqual((status, err["error"]["code"]), (503, "unavailable"))
        ch = {"approval_event_id": "approval-" + "0" * 32, "signing_message_hex": "00"}
        self.assertEqual(self.submit(view, ch)[0], 503)
        self.assertEqual(self.get(view)["approval_status"], "required")
        self.assertEqual([t for t, _ in self.events()], ["mission.contract_registered"])


class TransportRules(ApprovalBase):
    def test_strict_requests_and_authentication(self):
        view = self.mission()
        base = {"contract_digest": view["contract_digest"], "signing_key_id": "k-alice",
                "signature_alg": TEST_ALGORITHM}
        url = f"/v1/missions/{view['mission_id']}/approval-challenges"
        for body in ({**base, "user_id": "user:bob"}, {**base, "approver_subject": "user:bob"},
                     {k: v for k, v in base.items() if k != "signing_key_id"}, {**base, "contract_digest": "xyz"}):
            with self.subTest(body=body):
                self.assertEqual(self.app.json("POST", url, body)[0], 400)
        self.assertEqual(self.app.json("POST", url, base, token=None)[0], 401)
        self.assertEqual(self.app.json("GET", url)[0], 400)  # wrong method
        sub = f"/v1/missions/{view['mission_id']}/approvals"
        for body in ({"approval_event_id": "x"}, {"idempotency_key": "kkkkkkkk", "approval_event_id": "x",
                     "signing_key_id": "k", "signature_alg": "a", "signature_hex": "zz"}):
            self.assertEqual(self.app.json("POST", sub, body)[0], 400)
        self.assertEqual(self.app.json("POST", sub, {}, token=None)[0], 401)

    def test_malformed_bodies_on_approval_endpoints_are_400_not_500(self):
        view = self.mission()
        for suffix in ("approval-challenges", "approvals"):
            url = f"/v1/missions/{view['mission_id']}/{suffix}"
            for raw, headers in ((b"{bad", None), (b'{"a":1,"a":2}', None), (b"[]", None), (b"x" * 70000, None),
                                 (b"{}", {"Content-Type": "text/plain"})):
                with self.subTest(suffix=suffix, raw=raw[:8], headers=headers):
                    status, _, body = self.app.json("POST", url, raw=raw, headers=headers)
                    self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"))

    def test_concurrent_identical_submissions_record_one_approval(self):
        view = self.mission()
        ch = self.challenge(view)[2]
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.submit(view, ch)[0])) for _ in range(6)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(sorted(results), [200] * 5 + [201])
        self.assertEqual(sum(t == "mission.approval_granted" for t, _ in self.events()), 1)

    def test_tampered_log_fails_closed_for_approval_endpoints(self):
        view, ch, _ = self.approve()
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(text.replace("Pay supplier", "Pay attacker"), encoding="utf-8")
        self.assertEqual(self.challenge(view)[0], 503)
        self.assertEqual(self.submit(view, ch)[0], 503)


try:
    from master_brain.approval_signing_ed25519 import Ed25519Signer, Ed25519TrustStore
    HAVE_ED25519 = True
except Exception:  # optional extra
    HAVE_ED25519 = False


@unittest.skipUnless(HAVE_ED25519, "install the 'signing' extra")
class RealCryptographyEndToEnd(unittest.TestCase):
    def test_ed25519_approval_over_http(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            signer = Ed25519Signer.generate("k-alice-ed")
            trust = Ed25519TrustStore()
            trust.add_key("k-alice-ed", "user:alice", signer.public_key_bytes())
            app = Running(path, trust)
            try:
                _, _, view = app.json("POST", "/v1/missions", {
                    "idempotency_key": KEY, "objective": "o", "success_criteria": ["x"], "risk_tier": "critical"})
                url = f"/v1/missions/{view['mission_id']}"
                _, _, ch = app.json("POST", url + "/approval-challenges", {
                    "contract_digest": view["contract_digest"], "signing_key_id": "k-alice-ed",
                    "signature_alg": signer.algorithm, "action_digest": ACTION})
                sig = signer.sign(bytes.fromhex(ch["signing_message_hex"])).hex()
                body = {"idempotency_key": "submit-ed-0001", "approval_event_id": ch["approval_event_id"],
                        "signing_key_id": "k-alice-ed", "signature_alg": signer.algorithm, "signature_hex": sig}
                status, _, done = app.json("POST", url + "/approvals", body)
                self.assertEqual((status, done["approval_status"]), (201, "granted"))
                trust.revoke("k-alice-ed")
                self.assertEqual(app.json("GET", url)[2]["approval_status"], "required")  # revoked => no longer granted
            finally:
                app.close()


if __name__ == "__main__":
    unittest.main()
