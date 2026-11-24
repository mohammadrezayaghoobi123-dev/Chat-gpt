"""Executable reference tests for the EGIS operation-composition contract.

This is a deterministic in-memory oracle, not a distributed-store implementation
and not a substitute for SANY/TLC model checking or implementation refinement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import unittest


class Phase(str, Enum):
    PREPARED = "PREPARED"
    EVALUATED = "EVALUATED"
    AUTHORIZED = "AUTHORIZED"
    COMMIT_PENDING = "COMMIT_PENDING"
    RECOVERY_PENDING = "RECOVERY_PENDING"
    COMMITTED = "COMMITTED"
    ABORTED = "ABORTED"


class AttemptState(str, Enum):
    NEW = "NEW"
    PENDING = "PENDING"
    WON = "WON"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


@dataclass(frozen=True)
class Scope:
    tenant: str
    project: str
    change: str
    principal: str
    membership_revision: str
    capability: str


@dataclass(frozen=True)
class OperationKey:
    tenant: str
    project: str
    operation_id: str


@dataclass(frozen=True)
class Entry:
    fingerprint: str
    scope: Scope


@dataclass(frozen=True)
class CommitRecord:
    key: OperationKey
    fingerprint: str
    scope: Scope
    attempt: str
    policy: str
    trust_epoch: str


@dataclass
class Operation:
    entry: Entry
    phase: Phase = Phase.PREPARED
    attempts: dict[str, AttemptState] = field(default_factory=dict)
    reserved_attempt: str | None = None
    intent: str = "NONE"
    durable_outcome: str = "UNKNOWN"
    commit_record: CommitRecord | None = None
    observation: str = "UNKNOWN"
    lookup: str = "NOT_QUERIED"
    store_epoch: int = 0
    lookup_epoch: int = 0
    policy: str = "P1"
    trust_epoch: str = "T1"
    snapshot_policy: str = "P1"
    snapshot_trust_epoch: str = "T1"
    graph_complete: bool = True
    evidence_valid: bool = True
    oracle_pass: bool = True
    authorization_issued: bool = False
    authorization_consumed: bool = False
    authorization_expiry: int = 10
    current_time: int = 0


class OperationComposition:
    """Small deterministic reference model with per-OperationKey state."""

    def __init__(
        self,
        active_scopes: set[Scope],
        active_capabilities: set[tuple[str, str, str, str]],
        allowed_attempts: set[str] | None = None,
    ):
        self.active_scopes = set(active_scopes)
        self.active_memberships = {
            (scope.tenant, scope.project, scope.principal, scope.membership_revision)
            for scope in self.active_scopes
        }
        self.active_capabilities = set(active_capabilities)
        self.allowed_attempts = set(allowed_attempts or {"attempt-a", "attempt-b"})
        self.operations: dict[OperationKey, Operation] = {}

    def _membership_is_active(self, scope: Scope) -> bool:
        return (
            scope.tenant, scope.project, scope.principal, scope.membership_revision
        ) in self.active_memberships

    def revoke_membership(self, key: OperationKey) -> None:
        op = self.operations[key]
        scope = op.entry.scope
        self.active_memberships.discard(
            (scope.tenant, scope.project, scope.principal, scope.membership_revision)
        )

    def register(self, key: OperationKey, fingerprint: str, scope: Scope) -> str:
        existing = self.operations.get(key)
        if existing is not None:
            if existing.entry == Entry(fingerprint, scope):
                return "REPLAY"
            return "CONFLICT"
        valid_scope = (
            scope.tenant == key.tenant
            and scope.project == key.project
            and scope in self.active_scopes
            and (scope.tenant, scope.project, scope.principal, scope.capability)
            in self.active_capabilities
        )
        if not valid_scope:
            return "SCOPE_REJECTED"
        self.operations[key] = Operation(
            entry=Entry(fingerprint, scope),
            snapshot_policy="P1",
            snapshot_trust_epoch="T1",
        )
        return "ACCEPTED"

    def evaluate(self, key: OperationKey) -> str:
        op = self.operations[key]
        if op.phase != Phase.PREPARED:
            return "BLOCKED"
        if not op.graph_complete:
            op.phase = Phase.EVALUATED
            return "UNKNOWN"
        if not op.evidence_valid or not op.oracle_pass:
            op.phase = Phase.EVALUATED
            return "FAIL"
        op.phase = Phase.EVALUATED
        return "PASS"

    def authorize(self, key: OperationKey) -> bool:
        op = self.operations[key]
        if not (
            op.phase == Phase.EVALUATED
            and op.graph_complete
            and op.evidence_valid
            and op.oracle_pass
            and self._membership_is_active(op.entry.scope)
            and op.policy == op.snapshot_policy
            and op.trust_epoch == op.snapshot_trust_epoch
            and not op.authorization_issued
            and op.current_time < op.authorization_expiry
        ):
            return False
        op.authorization_issued = True
        op.phase = Phase.AUTHORIZED
        return True

    def start_attempt(self, key: OperationKey, attempt: str) -> bool:
        op = self.operations[key]
        if not (
            attempt in self.allowed_attempts
            and op.phase in {Phase.AUTHORIZED, Phase.COMMIT_PENDING}
            and op.authorization_issued
            and not op.authorization_consumed
            and op.intent == "NONE"
            and op.attempts.get(attempt, AttemptState.NEW) == AttemptState.NEW
        ):
            return False
        op.attempts[attempt] = AttemptState.PENDING
        op.phase = Phase.COMMIT_PENDING
        return True

    def reserve_intent(self, key: OperationKey, attempt: str) -> bool:
        op = self.operations[key]
        if not (
            op.phase == Phase.COMMIT_PENDING
            and op.intent == "NONE"
            and op.attempts.get(attempt) == AttemptState.PENDING
            and not op.authorization_consumed
        ):
            return False
        op.intent = "RESERVED"
        op.reserved_attempt = attempt
        return True

    def _commit_bindings_valid(self, op: Operation) -> bool:
        return (
            self._membership_is_active(op.entry.scope)
            and op.graph_complete
            and op.evidence_valid
            and op.oracle_pass
            and op.policy == op.snapshot_policy
            and op.trust_epoch == op.snapshot_trust_epoch
            and op.current_time < op.authorization_expiry
        )

    def commit_lost_ack(self, key: OperationKey) -> bool:
        op = self.operations[key]
        attempt = op.reserved_attempt
        if not (
            op.phase == Phase.COMMIT_PENDING
            and op.intent == "RESERVED"
            and attempt is not None
            and op.attempts.get(attempt) == AttemptState.PENDING
            and op.authorization_issued
            and not op.authorization_consumed
            and op.commit_record is None
            and self._commit_bindings_valid(op)
        ):
            return False
        op.authorization_consumed = True
        op.intent = "COMMITTED"
        op.durable_outcome = "COMMITTED"
        op.commit_record = CommitRecord(
            key, op.entry.fingerprint, op.entry.scope, attempt,
            op.snapshot_policy, op.snapshot_trust_epoch,
        )
        for candidate, state in tuple(op.attempts.items()):
            if candidate == attempt:
                op.attempts[candidate] = AttemptState.WON
            elif state == AttemptState.PENDING:
                op.attempts[candidate] = AttemptState.REJECTED
        op.store_epoch += 1
        op.lookup = "UNKNOWN"
        op.lookup_epoch = op.store_epoch - 1
        op.observation = "UNKNOWN"
        op.phase = Phase.RECOVERY_PENDING
        return True

    def abort_lost_ack(self, key: OperationKey) -> bool:
        op = self.operations[key]
        if not (
            op.phase == Phase.COMMIT_PENDING
            and op.intent == "RESERVED"
            and op.reserved_attempt is not None
            and op.attempts.get(op.reserved_attempt) == AttemptState.PENDING
            and op.commit_record is None
        ):
            return False
        op.authorization_consumed = True
        op.intent = "ABORTED"
        op.durable_outcome = "ABORTED"
        for candidate, state in tuple(op.attempts.items()):
            if state == AttemptState.PENDING:
                op.attempts[candidate] = AttemptState.CANCELLED
        op.store_epoch += 1
        op.lookup = "UNKNOWN"
        op.lookup_epoch = op.store_epoch - 1
        op.observation = "UNKNOWN"
        op.phase = Phase.RECOVERY_PENDING
        return True

    def stale_replica_lookup(self, key: OperationKey) -> bool:
        op = self.operations[key]
        if op.phase != Phase.RECOVERY_PENDING or op.lookup not in {"UNKNOWN", "NOT_QUERIED"}:
            return False
        op.lookup = "STALE_ABSENT"
        op.lookup_epoch = max(0, op.store_epoch - 1)
        return True

    def authoritative_lookup(self, key: OperationKey) -> str:
        op = self.operations[key]
        if op.phase != Phase.RECOVERY_PENDING or op.lookup not in {"UNKNOWN", "NOT_QUERIED", "STALE_ABSENT"}:
            return "BLOCKED"
        op.lookup_epoch = op.store_epoch
        if op.commit_record is not None:
            op.lookup = "FOUND_VALID"
        elif op.intent == "ABORTED":
            op.lookup = "ABSENT_AUTHORITATIVE"
        else:
            op.lookup = "UNKNOWN"
        return op.lookup

    def reconcile(self, key: OperationKey) -> str:
        op = self.operations[key]
        if op.phase != Phase.RECOVERY_PENDING or op.lookup_epoch != op.store_epoch:
            return "BLOCKED"
        if (
            op.lookup == "FOUND_VALID"
            and op.commit_record is not None
            and op.commit_record.key == key
            and op.commit_record.fingerprint == op.entry.fingerprint
            and op.commit_record.scope == op.entry.scope
            and op.commit_record.attempt == op.reserved_attempt
            and op.durable_outcome == "COMMITTED"
        ):
            op.phase = Phase.COMMITTED
            op.observation = "ACKNOWLEDGED_COMMITTED"
            return "COMMITTED"
        if (
            op.lookup == "ABSENT_AUTHORITATIVE"
            and op.commit_record is None
            and op.intent == "ABORTED"
            and op.durable_outcome == "ABORTED"
        ):
            op.phase = Phase.ABORTED
            op.observation = "ACKNOWLEDGED_ABORTED"
            return "ABORTED"
        return "UNKNOWN"


class OperationCompositionTests(unittest.TestCase):
    def setUp(self):
        self.scope_a = Scope("tenant-a", "project-a", "change-a", "principal-a", "membership-1", "write")
        self.scope_b = Scope("tenant-b", "project-b", "change-b", "principal-b", "membership-2", "write")
        self.key_a = OperationKey("tenant-a", "project-a", "operation-a")
        self.key_a2 = OperationKey("tenant-a", "project-a", "operation-b")
        self.key_b = OperationKey("tenant-b", "project-b", "operation-a")
        grants = {
            ("tenant-a", "project-a", "principal-a", "write"),
            ("tenant-b", "project-b", "principal-b", "write"),
        }
        self.model = OperationComposition({self.scope_a, self.scope_b}, grants)

    def prepare_authorized(self, key=None, scope=None, fingerprint="fp-a"):
        key = key or self.key_a
        scope = scope or self.scope_a
        self.assertEqual("ACCEPTED", self.model.register(key, fingerprint, scope))
        self.assertEqual("PASS", self.model.evaluate(key))
        self.assertTrue(self.model.authorize(key))
        return self.model.operations[key]

    def test_same_key_same_fingerprint_is_idempotent_replay(self):
        self.prepare_authorized()
        before = self.model.operations[self.key_a]
        self.assertEqual("REPLAY", self.model.register(self.key_a, "fp-a", self.scope_a))
        self.assertIs(before, self.model.operations[self.key_a])
        self.assertEqual(Phase.AUTHORIZED, before.phase)

    def test_same_key_different_fingerprint_is_conflict(self):
        self.prepare_authorized()
        entry = self.model.operations[self.key_a].entry
        self.assertEqual("CONFLICT", self.model.register(self.key_a, "fp-b", self.scope_a))
        self.assertEqual(entry, self.model.operations[self.key_a].entry)

    def test_same_key_same_fingerprint_different_scope_is_conflict(self):
        self.prepare_authorized()
        self.assertEqual("CONFLICT", self.model.register(self.key_a, "fp-a", self.scope_b))

    def test_distinct_operation_keys_progress_independently(self):
        self.prepare_authorized(self.key_a, self.scope_a, "fp-a")
        self.prepare_authorized(self.key_a2, self.scope_a, "fp-b")
        self.assertTrue(self.model.start_attempt(self.key_a, "attempt-a"))
        self.assertEqual(Phase.AUTHORIZED, self.model.operations[self.key_a2].phase)
        self.assertTrue(self.model.start_attempt(self.key_a2, "attempt-b"))

    def test_cross_tenant_scope_is_rejected(self):
        self.assertEqual("SCOPE_REJECTED", self.model.register(self.key_a, "fp-a", self.scope_b))

    def test_cross_project_scope_is_rejected(self):
        wrong = Scope("tenant-a", "project-b", "change-a", "principal-a", "membership-1", "write")
        self.assertEqual("SCOPE_REJECTED", self.model.register(self.key_a, "fp-a", wrong))

    def test_missing_membership_is_rejected(self):
        inactive = Scope("tenant-a", "project-a", "change-a", "principal-x", "membership-x", "write")
        self.assertEqual("SCOPE_REJECTED", self.model.register(self.key_a, "fp-a", inactive))

    def test_missing_capability_grant_is_rejected(self):
        no_write = Scope("tenant-a", "project-a", "change-a", "principal-a", "membership-1", "admin")
        self.assertEqual("SCOPE_REJECTED", self.model.register(self.key_a, "fp-a", no_write))

    def test_only_one_attempt_can_reserve_per_operation_key(self):
        self.prepare_authorized()
        self.assertTrue(self.model.start_attempt(self.key_a, "attempt-a"))
        self.assertTrue(self.model.start_attempt(self.key_a, "attempt-b"))
        self.assertFalse(self.model.start_attempt(self.key_a, "attempt-c"))
        self.assertTrue(self.model.reserve_intent(self.key_a, "attempt-a"))
        self.assertFalse(self.model.reserve_intent(self.key_a, "attempt-b"))
        self.assertFalse(self.model.start_attempt(self.key_a, "attempt-b"))

    def test_commit_lost_ack_stale_absence_cannot_finalize(self):
        self.prepare_authorized()
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        self.assertTrue(self.model.commit_lost_ack(self.key_a))
        self.assertTrue(self.model.stale_replica_lookup(self.key_a))
        self.assertEqual("BLOCKED", self.model.reconcile(self.key_a))
        self.assertEqual("FOUND_VALID", self.model.authoritative_lookup(self.key_a))
        self.assertEqual("COMMITTED", self.model.reconcile(self.key_a))

    def test_abort_lost_ack_requires_authoritative_absence(self):
        self.prepare_authorized()
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        self.assertTrue(self.model.abort_lost_ack(self.key_a))
        self.assertEqual("ABSENT_AUTHORITATIVE", self.model.authoritative_lookup(self.key_a))
        self.assertEqual("ABORTED", self.model.reconcile(self.key_a))

    def test_recovery_for_one_key_does_not_block_another_key(self):
        self.prepare_authorized(self.key_a, self.scope_a, "fp-a")
        self.prepare_authorized(self.key_b, self.scope_b, "fp-b")
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        self.assertTrue(self.model.commit_lost_ack(self.key_a))
        self.assertTrue(self.model.start_attempt(self.key_b, "attempt-b"))

    def test_policy_change_after_snapshot_blocks_commit(self):
        op = self.prepare_authorized()
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        op.policy = "P2"
        self.assertFalse(self.model.commit_lost_ack(self.key_a))

    def test_trust_change_after_snapshot_blocks_commit(self):
        op = self.prepare_authorized()
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        op.trust_epoch = "T2"
        self.assertFalse(self.model.commit_lost_ack(self.key_a))

    def test_membership_revocation_after_authorization_blocks_commit(self):
        op = self.prepare_authorized()
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        self.model.revoke_membership(self.key_a)
        self.assertFalse(self.model.commit_lost_ack(self.key_a))

    def test_membership_revocation_is_shared_across_operation_keys(self):
        self.prepare_authorized(self.key_a, self.scope_a, "fp-a")
        self.prepare_authorized(self.key_a2, self.scope_a, "fp-b")
        self.model.revoke_membership(self.key_a)
        self.assertFalse(self.model.authorize(self.key_a2))

    def test_evidence_or_graph_invalidation_blocks_commit(self):
        for field_name in ("evidence_valid", "graph_complete"):
            with self.subTest(field_name=field_name):
                model = OperationComposition({self.scope_a}, self.model.active_capabilities)
                key = self.key_a
                model.register(key, "fp-a", self.scope_a)
                model.evaluate(key)
                model.authorize(key)
                op = model.operations[key]
                op.attempts["attempt-a"] = AttemptState.PENDING
                op.phase = Phase.COMMIT_PENDING
                op.intent = "RESERVED"
                op.reserved_attempt = "attempt-a"
                setattr(op, field_name, False)
                self.assertFalse(model.commit_lost_ack(key))

    def test_replay_after_commit_does_not_create_second_commit(self):
        self.prepare_authorized()
        self.model.start_attempt(self.key_a, "attempt-a")
        self.model.reserve_intent(self.key_a, "attempt-a")
        self.assertTrue(self.model.commit_lost_ack(self.key_a))
        record = self.model.operations[self.key_a].commit_record
        self.assertEqual("REPLAY", self.model.register(self.key_a, "fp-a", self.scope_a))
        self.assertIs(record, self.model.operations[self.key_a].commit_record)
        self.assertEqual(1, sum(s == AttemptState.WON for s in self.model.operations[self.key_a].attempts.values()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
