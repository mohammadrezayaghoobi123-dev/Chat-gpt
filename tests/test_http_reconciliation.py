"""Gate 2b-3: operator role + reconciliation of unknown outcomes over a REAL server (MISSION-002, SAFE-002)."""
import json
import threading
import unittest

from master_brain.audit_store import AuditStore
from tests.test_http_api import ALICE, BOB, KEY, OPS
from tests.test_http_execution import ExecBase


class ReconBase(ExecBase):
    def unknown(self, token=ALICE, key=KEY):
        view = self.mission(token=token, key=key)
        self.assertEqual(self.code(self.execute(view, task="failing", token=token)), (500, "outcome_unknown"))
        attempt = self.result(view, token=token)[2]["attempts"][0]
        self.assertEqual(attempt["dispatch_status"], "adapter_error")
        return view, attempt["attempt_id"]

    def reconcile(self, view, attempt_id, token=OPS, resolution="effect_occurred", evidence="provider-receipt-77",
                  key="recon-key-0001", **kw):
        body = {"idempotency_key": key, "attempt_id": attempt_id, "resolution": resolution,
                "evidence_ref": evidence, **kw}
        return self.app.json("POST", f"/v1/missions/{view['mission_id']}/reconciliations", body, token=token)

    def events(self, view):
        return [(e["event_type"], e["actor"]) for e in
                self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit", token=OPS)[2]["events"]]


class OperatorReconciliation(ReconBase):
    def test_operator_resolves_an_unknown_outcome_and_the_mission_unblocks(self):
        view, attempt = self.unknown()
        self.assertEqual(self.code(self.execute(view, key="exec-key-0002")), (409, "reconciliation_required"))
        status, _, res = self.reconcile(view, attempt)
        self.assertEqual(status, 201)
        (shown,) = res["attempts"]
        self.assertEqual((res["state"], shown["reconciliation"], shown["external_effect_confirmed"]),
                         ("effect_reconciled", "effect_occurred", True))
        self.assertEqual(res["result_verification"], "not_independently_verified")  # a claim, never verification
        self.assertIn(("mission.dispatch_reconciled", "user:ops"), self.events(view))  # who claimed it is audited
        self.assertEqual(self.execute(view, key="exec-key-0003")[0], 201)
        self.assertEqual(self.result(view)[2]["attempts"][0]["reconciliation"], "effect_occurred")  # owner sees it too

    def test_no_effect_resolution_is_not_a_confirmation(self):
        view, attempt = self.unknown()
        res = self.reconcile(view, attempt, resolution="effect_did_not_occur")[2]
        self.assertEqual((res["attempts"][0]["reconciliation"], res["attempts"][0]["external_effect_confirmed"]),
                         ("effect_did_not_occur", False))

    def test_replay_is_idempotent_and_any_different_claim_conflicts(self):
        view, attempt = self.unknown()
        first = self.reconcile(view, attempt)
        again = self.reconcile(view, attempt)
        self.assertEqual((again[0], again[2]), (200, first[2]))
        for kw in ({"resolution": "effect_did_not_occur"}, {"evidence": "other-receipt"}):
            with self.subTest(kw=kw):
                self.assertEqual(self.code(self.reconcile(view, attempt, **kw)), (409, "conflict"))
        self.assertEqual(sum(t == "mission.dispatch_reconciled" for t, _ in self.events(view)), 1)

    def test_unknown_or_already_resolved_attempts_are_conflicts(self):
        view, attempt = self.unknown()
        self.assertEqual(self.code(self.reconcile(view, "nonexistent-attempt")), (409, "conflict"))
        self.reconcile(view, attempt)
        other = self.mission(key="other-key-0001")
        self.execute(other, task="echo", key="exec-key-0010")
        done = self.result(other)[2]["attempts"][0]["attempt_id"]  # succeeded, never unresolved
        self.assertEqual(self.code(self.reconcile(other, done, key="recon-key-0002")), (409, "conflict"))

    def test_concurrent_identical_claims_record_exactly_one_event(self):
        view, attempt = self.unknown()
        codes = []
        threads = [threading.Thread(target=lambda: codes.append(self.reconcile(view, attempt)[0])) for _ in range(6)]
        [t.start() for t in threads]
        [t.join(30) for t in threads]
        self.assertEqual(sorted(codes), [200] * 5 + [201])
        self.assertEqual(sum(t == "mission.dispatch_reconciled" for t, _ in self.events(view)), 1)


class SeparationOfDuties(ReconBase):
    def test_the_owner_cannot_reconcile_their_own_mission(self):
        view, attempt = self.unknown()
        self.assertEqual(self.code(self.reconcile(view, attempt, token=ALICE)), (403, "forbidden"))
        self.assertEqual(self.result(view)[2]["state"], "dispatch_unresolved")

    def test_an_operator_cannot_reconcile_a_mission_they_own(self):
        view, attempt = self.unknown(token=OPS, key="ops-key-00001")
        self.assertEqual(self.code(self.reconcile(view, attempt, token=OPS)), (403, "forbidden"))
        self.assertEqual(self.result(view, token=OPS)[2]["state"], "dispatch_unresolved")

    def test_other_users_learn_nothing(self):
        view, attempt = self.unknown()
        foreign = self.reconcile(view, attempt, token=BOB)
        missing = self.reconcile({"mission_id": "mission-" + "0" * 16}, attempt, token=BOB)
        self.assertEqual((foreign[0], foreign[2]["error"]["code"]), (404, "not_found"))
        self.assertEqual((missing[0], missing[2]["error"]["code"]), (404, "not_found"))
        self.assertEqual(self.reconcile(view, attempt, token=None)[0], 401)
        self.assertEqual(self.result(view)[2]["state"], "dispatch_unresolved")

    def test_operator_has_read_access_to_result_and_audit_only(self):
        view, _ = self.unknown()
        self.assertEqual(self.result(view, token=OPS)[0], 200)
        self.assertEqual(self.app.json("GET", f"/v1/missions/{view['mission_id']}/audit", token=OPS)[0], 200)
        mid = view["mission_id"]
        for method, path, body in (
            ("GET", f"/v1/missions/{mid}", None),
            ("POST", f"/v1/missions/{mid}/executions", {"idempotency_key": "exec-key-ops1", "task_id": "echo"}),
            ("POST", f"/v1/missions/{mid}/approval-challenges", {
                "contract_digest": view["contract_digest"], "signing_key_id": "k", "signature_alg": "a"}),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.app.json(method, path, body, token=OPS)[0], 404)
        unknown_mission = "/v1/missions/mission-" + "0" * 16
        self.assertEqual(self.app.json("GET", unknown_mission + "/result", token=OPS)[0], 404)
        self.assertEqual(self.app.json("GET", unknown_mission + "/audit", token=OPS)[0], 404)
        self.assertEqual(self.adapter.calls, 0)


class ReconciliationRequests(ReconBase):
    def test_invalid_requests_are_rejected_without_writing(self):
        view, attempt = self.unknown()
        before = len(self.events(view))
        url = f"/v1/missions/{view['mission_id']}/reconciliations"
        good = {"idempotency_key": "recon-key-0001", "attempt_id": attempt, "resolution": "effect_occurred",
                "evidence_ref": "r-1"}
        for body in ({**good, "resolution": "maybe"}, {**good, "evidence_ref": ""}, {**good, "evidence_ref": "x" * 501},
                     {**good, "actor": "user:ops"}, {k: v for k, v in good.items() if k != "attempt_id"}):
            with self.subTest(body=body):
                self.assertEqual(self.code(self.app.json("POST", url, body, token=OPS)), (400, "invalid_request"))
        for raw in (b"{bad", b"[]", b'{"a":1,"a":2}'):
            self.assertEqual(self.app.json("POST", url, raw=raw, token=OPS)[0], 400)
        self.assertEqual(self.app.json("GET", url, token=OPS)[0], 400)  # wrong method
        self.assertEqual(len(self.events(view)), before)

    def test_secret_like_evidence_is_refused_not_stored(self):
        view, attempt = self.unknown()
        status, _, err = self.reconcile(view, attempt, evidence="token sk-" + "a" * 40)
        self.assertEqual((status, err["error"]["code"]), (400, "invalid_request"))
        self.assertEqual(self.result(view)[2]["state"], "dispatch_unresolved")
        self.assertNotIn("sk-aaaa", self.path.read_text(encoding="utf-8"))

    def test_tampered_log_fails_closed(self):
        view, attempt = self.unknown()
        text = self.path.read_text(encoding="utf-8")
        self.path.write_text(text.replace("Run offline task", "Run attacker task"), encoding="utf-8")
        status, _, err = self.reconcile(view, attempt)
        self.assertEqual((status, err["error"]["code"]), (503, "unavailable"))


class ServiceEdges(ReconBase):
    def service(self):
        from master_brain.mission_service import MissionService
        return MissionService(AuditStore(self.path, clock=self.clock), self.verifier, self.config(self.adapter))

    def request(self, attempt, **kw):
        from master_brain.api_contracts import ReconcileRequest
        args = dict(idempotency_key="recon-key-0001", attempt_id=attempt, resolution="effect_occurred",
                    evidence_ref="provider-receipt-77")
        args.update(kw)
        return ReconcileRequest(**args)

    def ops(self):
        from master_brain.identity import Identity
        return Identity("user:ops", frozenset({"operator"}))

    def test_operator_on_an_unknown_mission_is_not_found_not_unavailable(self):
        from master_brain.mission_service import ServiceError
        with self.assertRaises(ServiceError) as ctx:
            self.service().reconcile_attempt(self.ops(), "mission-" + "0" * 16, self.request("a"))
        self.assertEqual(ctx.exception.code.value, "not_found")

    def test_lost_race_is_a_replay_only_when_the_winner_made_the_same_claim(self):
        import master_brain.mission_service as ms
        from master_brain.mission_lifecycle import ReconciliationRejected
        from master_brain.mission_service import ServiceError
        view, attempt = self.unknown()
        real = ms.record_dispatch_reconciliation

        def winner(resolution, evidence):
            def run(store, mission_id, attempt_id, _res, _ev, **kw):
                real(store, mission_id, attempt_id, resolution, evidence, **kw)
                raise ReconciliationRejected("attempt_not_unresolved")  # as if we lost the race
            return run
        self.addCleanup(setattr, ms, "record_dispatch_reconciliation", real)
        ms.record_dispatch_reconciliation = winner("effect_occurred", "provider-receipt-77")
        result = self.service().reconcile_attempt(self.ops(), view["mission_id"], self.request(attempt))
        self.assertFalse(result.created)
        self.assertEqual(result.view.state, "effect_reconciled")
        # a different claim already recorded => genuine conflict, never a silent replay
        view2, attempt2 = self.unknown(key="second-key-0001")
        ms.record_dispatch_reconciliation = winner("effect_did_not_occur", "someone-elses-evidence")
        with self.assertRaises(ServiceError) as ctx:
            self.service().reconcile_attempt(self.ops(), view2["mission_id"], self.request(attempt2))
        self.assertEqual(ctx.exception.code.value, "conflict")

    def test_rejection_without_any_prior_claim_is_a_conflict(self):
        import master_brain.mission_service as ms
        from master_brain.mission_lifecycle import ReconciliationRejected
        from master_brain.mission_service import ServiceError
        view, attempt = self.unknown()
        real = ms.record_dispatch_reconciliation

        def refuse(*a, **k):
            raise ReconciliationRejected("unknown_attempt")
        ms.record_dispatch_reconciliation = refuse
        self.addCleanup(setattr, ms, "record_dispatch_reconciliation", real)
        with self.assertRaises(ServiceError) as ctx:
            self.service().reconcile_attempt(self.ops(), view["mission_id"], self.request(attempt))
        self.assertEqual(ctx.exception.code.value, "conflict")

    def test_unreadable_store_is_unavailable(self):
        from master_brain.mission_service import ServiceError
        view, attempt = self.unknown()
        service = self.service()
        self.path.write_text("garbage\n", encoding="utf-8")
        with self.assertRaises(ServiceError) as ctx:
            service.reconcile_attempt(self.ops(), view["mission_id"], self.request(attempt))
        self.assertEqual(ctx.exception.code.value, "unavailable")


if __name__ == "__main__":
    unittest.main()
