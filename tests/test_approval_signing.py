"""SAFE-002: authenticated approver via signed, event-bound approvals (red-first)."""
import hashlib
import hmac
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from master_brain.audit_store import AuditStore
from master_brain.approval_signing import (
    SIGNATURE_DOMAIN, build_signing_message, verify_approval_event,
)
from master_brain.integrations import IntegrationRequirement, IntegrationKind
from master_brain.mission_approval import (
    action_digest, approval_signing_message, evaluate_approved_execution_gate,
    record_mission_approval,
)
from master_brain.mission_contract import MissionContract, MissionRiskTier
from master_brain.mission_execution import execute_mission_idempotently, execute_mission_once
from master_brain.execution_registry import SQLiteExecutionRegistry
from tests.approval_expiry_helper import soon
from tests.approval_signing_helper import TEST_ALGORITHM, HmacSeamSigner, HmacSeamVerifier
from tests.mission_registration_helper import register_contract
from tests.test_mission_execution import Adapter, descriptor

DIGEST = "d" * 64  # filler digest for unrelated log events

T = "2026-10-12T00:00:00Z"


class SigningBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = AuditStore(self.root / "audit.jsonl")
        self.contract = MissionContract(
            mission_id="m-sign", objective="Signed approval",
            risk_tier=MissionRiskTier.MEDIUM, requires_approval=True)
        register_contract(self.store, self.contract)
        self.signer = HmacSeamSigner("k1", b"s3cret-material")
        self.verifier = HmacSeamVerifier()
        self.verifier.add("k1", b"s3cret-material", "user:alice")
        self.payload = {"p": 1}

    def approve(self, signer="default", event_id="ap-1", subject="user:alice", **kw):
        signer = self.signer if signer == "default" else signer
        return record_mission_approval(
            self.store, self.contract, event_id=event_id, recorded_at=T,
            approver_subject=subject, authentication_method="signed",
            expires_at=soon(), signer=signer, **kw)

    def gate(self, receipt, verifier="default"):
        verifier = self.verifier if verifier == "default" else verifier
        return evaluate_approved_execution_gate(
            self.contract, self.store, receipt, verifier=verifier)

    def event(self, event_id="ap-1"):
        return next(e for e in self.store.read_all() if e.event_id == event_id)


class SignedApprovalGateTests(SigningBase):
    def test_signed_approval_authenticates_the_approver(self):
        result = self.gate(self.approve())
        self.assertTrue(result.allowed, result.reasons)
        self.assertTrue(result.approver_authenticated)

    def test_unsigned_approval_is_rejected_when_a_verifier_is_configured(self):
        result = self.gate(self.approve(signer=None))
        self.assertFalse(result.allowed)
        self.assertFalse(result.approver_authenticated)
        self.assertTrue(any("signature" in r for r in result.reasons))

    def test_without_a_verifier_legacy_behaviour_but_never_authenticated(self):
        for signer in (self.signer, None):
            with self.subTest(signed=signer is not None):
                self.setUp()
                result = self.gate(self.approve(signer=signer), verifier=None)
                self.assertTrue(result.allowed, result.reasons)
                self.assertFalse(result.approver_authenticated)

    def test_signature_fields_are_recorded_on_the_audited_event_only_when_signed(self):
        self.approve()
        payload = self.event().payload
        self.assertEqual(payload["signing_key_id"], "k1")
        self.assertEqual(payload["signature_alg"], TEST_ALGORITHM)
        bytes.fromhex(payload["signature"])  # hex: cannot trip the secret-value screens
        self.setUp(); self.approve(signer=None)
        for key in ("signature", "signing_key_id", "signature_alg"):
            self.assertNotIn(key, self.event().payload)

    def test_forged_or_altered_receipt_signature_is_rejected(self):
        receipt = self.approve()
        for field, value in (("signature", "00" * 32), ("signing_key_id", "k2"),
                             ("signature_alg", "other"), ("signature", None)):
            with self.subTest(field=field):
                result = self.gate(replace(receipt, **{field: value}))
                self.assertFalse(result.allowed)
                self.assertFalse(result.approver_authenticated)

    def test_signed_payload_replayed_under_a_new_event_id_is_rejected(self):
        original = self.approve()
        payload = dict(self.event().payload)
        self.store.append(
            event_id="ap-replayed", event_type="mission.approval_granted", recorded_at=T,
            actor="user:alice", subject_ref="mission:m-sign", payload=payload)
        replayed = replace(original, event_id="ap-replayed",
                           event_hash=self.event("ap-replayed").event_hash)
        result = self.gate(replayed)
        self.assertFalse(result.allowed)
        self.assertTrue(any("signature" in r for r in result.reasons))

    def test_unknown_wrong_subject_and_revoked_keys_are_rejected(self):
        r = self.approve(); self.verifier.keys.pop("k1")  # unknown key
        self.assertFalse(self.gate(r).allowed)
        self.setUp(); r = self.approve(subject="user:mallory")
        self.assertFalse(self.gate(r).allowed)
        self.setUp(); r = self.approve(); self.verifier.revoked.add("k1")
        res = self.gate(r)
        self.assertFalse(res.allowed)
        self.assertFalse(res.approver_authenticated)

    def test_verifier_failures_fail_closed(self):
        receipt = self.approve()

        class Boom:
            def verify(self, **kw):
                raise RuntimeError("hsm down")

        class Truthy:
            def verify(self, **kw):
                return True  # not None: must not be read as success

        class Falsy:
            def verify(self, **kw):
                return ""    # not None either

        for name, v in (("raises", Boom()), ("true", Truthy()), ("empty", Falsy())):
            with self.subTest(name=name):
                result = self.gate(receipt, verifier=v)
                self.assertFalse(result.allowed)
                self.assertFalse(result.approver_authenticated)

    def test_signing_message_binds_event_id_and_every_payload_field(self):
        base = {"a": 1, "b": "x"}
        ref = build_signing_message("e1", base)
        self.assertTrue(ref.startswith(SIGNATURE_DOMAIN))
        self.assertEqual(SIGNATURE_DOMAIN, b"master-brain/approval-signature/v2\n")
        variants = (
            build_signing_message("e2", base),
            build_signing_message("e1", {"a": 2, "b": "x"}),
            build_signing_message("e1", {"a": 1, "b": "y"}),
            build_signing_message("e1", {"a": 1, "b": "x", "c": 0}),
        )
        self.assertEqual(len({ref, *variants}), 5)
        self.assertEqual(ref, build_signing_message("e1", {"b": "x", "a": 1}))  # key order

    def test_signature_does_not_depend_on_recorded_at(self):
        """v2: recorded_at is not signed (a challenge/response flow cannot know it in advance)."""
        r1 = self.approve(event_id="ap-t1")
        self.store.append(event_id="other", event_type="mission.dispatch_started", recorded_at="2026-10-12T00:00:30Z",
                          actor="x", subject_ref="mission:other",
                          payload={"mission_id": "other", "contract_digest": DIGEST, "integration_id": "i",
                                   "attempt_id": "a"})
        r2 = record_mission_approval(
            self.store, self.contract, event_id="ap-t2", recorded_at="2026-10-12T00:01:00Z",
            approver_subject="user:alice", authentication_method="signed", expires_at=soon(), signer=self.signer)
        self.assertNotEqual(r1.recorded_at, r2.recorded_at)
        self.assertTrue(self.gate(r1).allowed)
        self.assertTrue(self.gate(r2).allowed)

    def test_verify_approval_event_rejects_malformed_signature_fields(self):
        self.approve()
        event = self.event()
        for key, value in (("signature", 5), ("signing_key_id", ""), ("signing_key_id", None),
                           ("signature_alg", None), ("signature_alg", " "),
                           ("approver_subject", ""), ("approver_subject", 7)):
            with self.subTest(key=key, value=value):
                forged = replace(event, payload={**event.payload, key: value})
                self.assertIn("missing or malformed", verify_approval_event(self.verifier, forged))
        for key in ("signature", "signing_key_id", "signature_alg", "approver_subject"):
            with self.subTest(missing=key):
                trimmed = {k: v for k, v in event.payload.items() if k != key}
                self.assertIn("missing or malformed",
                              verify_approval_event(self.verifier, replace(event, payload=trimmed)))
        bad_hex = replace(event, payload={**event.payload, "signature": "zz-not-hex"})
        self.assertIn("not valid hex", verify_approval_event(self.verifier, bad_hex))
        self.assertIsNone(verify_approval_event(self.verifier, event))

    def test_verifier_reasons_are_reported_exactly(self):
        self.approve()
        event = self.event()

        def verifier_returning(value):
            class V:
                def verify(self, **kw):
                    return value
            return V()

        for value, expected in (("because", "approval signature invalid: because"),
                                ("", "approval signature invalid: rejected"),
                                (True, "approval signature invalid: rejected")):
            with self.subTest(value=value):
                self.assertEqual(verify_approval_event(verifier_returning(value), event), expected)

    def test_signing_message_uses_raw_unicode_and_rejects_nan(self):
        message = build_signing_message("e", {"n": "سلام"})
        self.assertEqual(
            message, SIGNATURE_DOMAIN + '{"event_id":"e","payload":{"n":"سلام"}}'.encode("utf-8"))
        with self.assertRaises(ValueError):
            build_signing_message("e", {"n": float("nan")})


class TwoPhaseApprovalTests(SigningBase):
    """Challenge/response: the message is fixed first, the event is appended later (SAFE-002)."""

    def challenge(self, **kw):
        args = dict(event_id="ap-2p", approver_subject="user:alice", authentication_method="signed",
                    signing_key_id="k1", signature_alg=TEST_ALGORITHM, expires_at=soon())
        args.update(kw)
        return args, approval_signing_message(self.store, self.contract, **args)

    def test_sign_first_append_later_after_other_events_authenticates(self):
        args, message = self.challenge()
        self.store.append(  # the log moves on between challenge and submit
            event_id="other", event_type="mission.dispatch_started", recorded_at="2026-10-12T00:00:30Z",
            actor="x", subject_ref="mission:other",
            payload={"mission_id": "other", "contract_digest": DIGEST, "integration_id": "i", "attempt_id": "a"})
        receipt = record_mission_approval(
            self.store, self.contract, event_id=args["event_id"], recorded_at="2026-10-12T00:01:00Z",
            approver_subject=args["approver_subject"], authentication_method=args["authentication_method"],
            expires_at=args["expires_at"], signature=self.signer.sign(message),
            signing_key_id="k1", signature_alg=TEST_ALGORITHM)
        result = self.gate(receipt)
        self.assertTrue(result.allowed, result.reasons)
        self.assertTrue(result.approver_authenticated)

    def test_externally_signed_equals_signer_signed(self):
        args, message = self.challenge()
        via_signer = record_mission_approval(
            self.store, self.contract, event_id=args["event_id"], recorded_at=T,
            approver_subject="user:alice", authentication_method="signed",
            expires_at=args["expires_at"], signer=self.signer)
        self.assertEqual(via_signer.signature, self.signer.sign(message).hex())

    def test_any_difference_from_the_challenged_message_fails_verification(self):
        args, message = self.challenge()
        signature = self.signer.sign(message)
        for field, value in (("event_id", "ap-other"), ("approver_subject", "user:alice2"),
                             ("authentication_method", "other"), ("signing_key_id", "k2"),
                             ("expires_at", soon(2.0))):
            with self.subTest(field=field):
                self.setUp()
                recorded = {**args, **{field: value}}
                receipt = record_mission_approval(
                    self.store, self.contract, event_id=recorded["event_id"], recorded_at=T,
                    approver_subject=recorded["approver_subject"],
                    authentication_method=recorded["authentication_method"],
                    expires_at=recorded["expires_at"], signature=signature,
                    signing_key_id=recorded["signing_key_id"], signature_alg=TEST_ALGORITHM)
                self.assertFalse(self.gate(receipt).allowed)

    def test_challenge_message_applies_the_same_validation_as_recording(self):
        for bad in ({"event_id": " "}, {"approver_subject": ""}, {"authentication_method": None},
                    {"signing_key_id": ""}, {"signature_alg": " "}, {"expires_at": "2020-01-01T00:00:00Z"},
                    {"expires_at": "soon"}, {"action_digest": " "}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.challenge(**bad)
        high = MissionContract(mission_id="m-high-ch", objective="o", risk_tier=MissionRiskTier.HIGH,
                               requires_approval=True)
        with self.assertRaises(ValueError):  # HIGH needs an expiry
            approval_signing_message(self.store, high, event_id="e", approver_subject="u",
                                     authentication_method="m", signing_key_id="k", signature_alg="a")
        low = MissionContract(mission_id="m-low-ch", objective="o")
        with self.assertRaises(ValueError):  # nothing to approve
            approval_signing_message(self.store, low, event_id="e", approver_subject="u",
                                     authentication_method="m", signing_key_id="k", signature_alg="a")

    def test_external_signature_arguments_are_validated_and_exclusive(self):
        base = dict(event_id="ap-x", recorded_at=T, approver_subject="user:alice",
                    authentication_method="signed", expires_at=soon())
        before = len(self.store.read_all())
        with self.assertRaises(ValueError):
            record_mission_approval(self.store, self.contract, signer=self.signer, signature=b"s",
                                    signing_key_id="k1", signature_alg="a", **base)
        for sig, key, alg, exc in ((b"s", None, "a", ValueError), (b"s", "k1", " ", ValueError),
                                   (b"", "k1", "a", ValueError), ("str", "k1", "a", TypeError),
                                   (5, "k1", "a", TypeError)):
            with self.subTest(sig=sig, key=key, alg=alg), self.assertRaises(exc):
                record_mission_approval(self.store, self.contract, signature=sig, signing_key_id=key,
                                        signature_alg=alg, **base)
        with self.assertRaises(ValueError):
            record_mission_approval(self.store, self.contract, **{**base, "recorded_at": " "})
        self.assertEqual(len(self.store.read_all()), before)
        receipt = record_mission_approval(self.store, self.contract, signature=bytearray(b"\x01\x02"),
                                          signing_key_id="k1", signature_alg="a", **base)
        self.assertEqual(receipt.signature, "0102")


class SignerContractTests(SigningBase):
    def test_bad_signers_never_write_an_event(self):
        class NoKey:
            key_id, algorithm = "", "x"
            def sign(self, m): return b"x"

        class BadReturn:
            key_id, algorithm = "k", "x"
            def sign(self, m): return "not-bytes"

        class NoAlgorithm:
            key_id, algorithm = "k", " "
            def sign(self, m): return b"x"

        class NoneKey:
            key_id, algorithm = None, "x"
            def sign(self, m): return b"x"

        class EmptySig:
            key_id, algorithm = "k", "x"
            def sign(self, m): return b""

        class Raises:
            key_id, algorithm = "k", "x"
            def sign(self, m): raise RuntimeError("hsm down")

        before = len(self.store.read_all())
        for signer, exc in ((NoKey(), ValueError), (NoAlgorithm(), ValueError),
                            (NoneKey(), ValueError), (BadReturn(), TypeError),
                            (EmptySig(), ValueError), (Raises(), RuntimeError)):
            with self.subTest(signer=type(signer).__name__):
                with self.assertRaises(exc):
                    self.approve(signer=signer)
        self.assertEqual(len(self.store.read_all()), before)

    def test_bad_return_type_message_and_bytearray_accepted(self):
        class BadReturn:
            key_id, algorithm = "k", "x"
            def sign(self, m): return "not-bytes"

        class Bytearr:
            key_id, algorithm = "k", "x"
            def sign(self, m): return bytearray(b"\x01\x02")

        with self.assertRaises(TypeError) as ctx:
            self.approve(signer=BadReturn())
        self.assertIn("must return bytes", str(ctx.exception))
        receipt = self.approve(signer=Bytearr(), event_id="ap-ba")
        self.assertEqual(receipt.signature, "0102")


class SignedExecutionTests(SigningBase):
    def run_executor(self, receipt, verifier, idempotent):
        adapter = Adapter()
        requirement = IntegrationRequirement(("text_reasoning",), required_kind=IntegrationKind.MODEL)
        kwargs = dict(event_id_prefix="p", recorded_at="2026-10-12T00:01:00Z", actor="system:test",
                      approval_verifier=verifier)
        if idempotent:
            registry = SQLiteExecutionRegistry(str(self.root / "e.sqlite3"), timeout=0.25)
            res = execute_mission_idempotently(
                self.contract, self.store, receipt, descriptor(), requirement, adapter,
                self.payload, registry, idempotency_key="k", **kwargs)
        else:
            res = execute_mission_once(
                self.contract, self.store, receipt, descriptor(), requirement, adapter,
                self.payload, **kwargs)
        return res, adapter

    def test_signed_approval_executes_and_unsigned_does_not(self):
        for idempotent in (False, True):
            with self.subTest(idempotent=idempotent, signed=True):
                self.setUp()
                res, adapter = self.run_executor(self.approve(), self.verifier, idempotent)
                self.assertEqual(adapter.calls, 1)
                self.assertNotEqual(res.status, "rejected")
            with self.subTest(idempotent=idempotent, signed=False):
                self.setUp()
                res, adapter = self.run_executor(self.approve(signer=None), self.verifier, idempotent)
                self.assertEqual(res.status, "rejected")
                self.assertEqual(adapter.calls, 0)
                self.assertIn("signature", res.reason)

    def test_executors_without_a_verifier_keep_legacy_behaviour(self):
        res, adapter = self.run_executor(self.approve(signer=None), None, False)
        self.assertEqual(adapter.calls, 1)


try:
    from master_brain.approval_signing_ed25519 import Ed25519Signer, Ed25519TrustStore
    HAVE_ED25519 = True
except ImportError:
    HAVE_ED25519 = False


class Ed25519AvailabilityTests(unittest.TestCase):
    def test_extra_is_installed_when_the_environment_requires_it(self):
        if os.environ.get("MB_REQUIRE_SIGNING_TESTS") == "1":
            self.assertTrue(HAVE_ED25519, "install the 'signing' extra in this environment")


@unittest.skipUnless(HAVE_ED25519, "optional 'signing' extra not installed")
class Ed25519AdapterTests(SigningBase):
    def setUp(self):
        super().setUp()
        self.signer = Ed25519Signer.generate("ed-1")
        self.trust = Ed25519TrustStore()
        self.trust.add_key("ed-1", "user:alice", self.signer.public_key_bytes())

    def test_real_signature_roundtrip_authenticates(self):
        result = self.gate(self.approve(), verifier=self.trust)
        self.assertTrue(result.allowed, result.reasons)
        self.assertTrue(result.approver_authenticated)

    def test_any_bit_flip_in_the_signature_is_rejected(self):
        receipt = self.approve()
        sig = bytearray.fromhex(receipt.signature)
        for i in (0, 31, 63):
            with self.subTest(byte=i):
                flipped = bytearray(sig); flipped[i] ^= 0x01
                self.assertFalse(self.gate(replace(receipt, signature=flipped.hex()),
                                           verifier=self.trust).allowed)

    def test_key_bound_to_another_subject_revoked_or_unknown_is_rejected(self):
        self.assertFalse(self.gate(self.approve(subject="user:mallory"), verifier=self.trust).allowed)
        self.setUp(); receipt = self.approve(); self.trust.revoke("ed-1")
        self.assertFalse(self.gate(receipt, verifier=self.trust).allowed)
        self.setUp(); receipt = self.approve()
        self.assertFalse(self.gate(receipt, verifier=Ed25519TrustStore()).allowed)

    def test_trust_store_verifies_the_cryptography_directly(self):
        self.approve()
        event = self.event()
        key_id = event.payload["signing_key_id"]
        message = build_signing_message(
            event.event_id, {k: v for k, v in event.payload.items() if k != "signature"})
        signature = bytes.fromhex(event.payload["signature"])
        kw = dict(key_id=key_id, algorithm="ed25519", subject="user:alice")
        self.assertIsNone(self.trust.verify(message=message, signature=signature, **kw))
        flipped = bytearray(signature); flipped[5] ^= 1
        self.assertEqual(self.trust.verify(message=message, signature=bytes(flipped), **kw),
                         "signature does not verify")
        self.assertEqual(self.trust.verify(message=message + b"x", signature=signature, **kw),
                         "signature does not verify")
        self.assertEqual(self.trust.verify(message=message, signature=signature,
                                           key_id="nope", algorithm="ed25519", subject="user:alice"),
                         "unknown signing key")
        self.assertEqual(self.trust.verify(message=message, signature=signature,
                                           key_id=key_id, algorithm="ed25519", subject="user:bob"),
                         "signing key is not bound to this approver")

    def test_wrong_algorithm_label_is_rejected(self):
        reason = self.trust.verify(key_id="ed-1", algorithm="rsa", subject="user:alice",
                                   message=b"m", signature=b"s" * 64)
        self.assertIsNotNone(reason)

    def test_trust_store_input_validation(self):
        pub = self.signer.public_key_bytes()
        with self.assertRaises(ValueError):
            self.trust.add_key("ed-1", "user:alice", pub)          # duplicate key id
        for bad in ((" ", "user:a", pub), (None, "user:a", pub), ("k2", "", pub), ("k2", None, pub),
                    ("k2", "user:a", b"short"), ("k2", "user:a", b"x" * 33),
                    ("k2", "user:a", b"x" * 31), ("k2", "user:a", "x" * 32)):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    self.trust.add_key(*bad)
        with self.assertRaises(KeyError):
            self.trust.revoke("nope")
        self.trust.add_key("ed-ba", "user:b", bytearray(self.signer.public_key_bytes()))  # accepted
        for bad_id in ("", None, 5):
            with self.subTest(signer_key_id=bad_id):
                with self.assertRaises(ValueError):
                    Ed25519Signer(bad_id, object())

    def test_different_signers_produce_different_signatures_and_keys(self):
        other = Ed25519Signer.generate("ed-2")
        self.assertNotEqual(other.public_key_bytes(), self.signer.public_key_bytes())
        self.assertEqual(len(self.signer.public_key_bytes()), 32)
        self.assertEqual(len(self.signer.sign(b"m")), 64)


if __name__ == "__main__":
    unittest.main()
