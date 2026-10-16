import unittest

from master_brain.evidence_protocol import (
    ClaimRecord,
    EvidencePolarity,
    EvidenceRecord,
    ProtocolPolicy,
    ReviewStatus,
    SourceKind,
    assess_claim,
)


class EvidenceProtocolTests(unittest.TestCase):
    def setUp(self):
        self.claim = ClaimRecord("c-1", "Supplier can deliver 1,000 kg per day")
        self.policy = ProtocolPolicy(
            minimum_effective_weight=0.6,
            minimum_independent_groups=2,
            current_time="2026-10-11T12:00:00Z",
        )

    def evidence(self, evidence_id, group, polarity=EvidencePolarity.SUPPORTS,
                 kind=SourceKind.PRIMARY, reliability=1.0, relevance=1.0,
                 **kwargs):
        return EvidenceRecord(
            evidence_id=evidence_id,
            claim_id=self.claim.claim_id,
            source_uri_or_reference=f"ref:{evidence_id}",
            source_group=group,
            source_kind=kind,
            polarity=polarity,
            reliability=reliability,
            relevance=relevance,
            is_directly_verified=True,
            **kwargs,
        )

    def test_zero_weight_evidence_does_not_change_status(self):
        """Finding B2: a zero-relevance/zero-reliability counter flipped supported -> contested."""
        base = [self.evidence("s1", "a"), self.evidence("s2", "b")]
        self.assertEqual(assess_claim(self.claim, base, self.policy).status,
                         ReviewStatus.PROVISIONALLY_SUPPORTED)
        for kwargs in ({"relevance": 0.0}, {"reliability": 0.0}):
            with self.subTest(**kwargs):
                noise = self.evidence("n", "z", EvidencePolarity.COUNTERS, **kwargs)
                result = assess_claim(self.claim, base + [noise], self.policy)
                self.assertEqual(result.status, ReviewStatus.PROVISIONALLY_SUPPORTED)
                self.assertEqual(result.counterevidence_ids, ())
                self.assertIn("zero_effective_weight",
                              [c.excluded_reason for c in result.contributions])
                self.assertTrue(any("zero effective weight" in r for r in result.reasons))
        clean = assess_claim(self.claim, base, self.policy)
        self.assertFalse(any("zero effective weight" in r for r in clean.reasons))

    def test_zero_weight_only_evidence_is_insufficient_not_contested(self):
        noise = self.evidence("n", "z", EvidencePolarity.COUNTERS, relevance=0.0)
        result = assess_claim(self.claim, [self.evidence("s1", "a"), noise], self.policy)
        self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)

    def test_positive_weight_counterevidence_still_contests(self):
        base = [self.evidence("s1", "a"), self.evidence("s2", "b")]
        weak = self.evidence("n", "z", EvidencePolarity.COUNTERS, relevance=0.01)
        self.assertEqual(assess_claim(self.claim, base + [weak], self.policy).status,
                         ReviewStatus.CONTESTED)

    def test_empty_evidence_is_unverified_not_false(self):
        result = assess_claim(self.claim, [], self.policy)
        self.assertEqual(result.status, ReviewStatus.UNVERIFIED)
        self.assertFalse(result.truth_established)

    def test_independent_sources_can_cross_review_gate(self):
        result = assess_claim(self.claim, [
            self.evidence("e1", "supplier-document"),
            self.evidence("e2", "independent-inspection"),
        ], self.policy)
        self.assertEqual(result.status, ReviewStatus.PROVISIONALLY_SUPPORTED)
        self.assertEqual(len(result.independent_support_groups), 2)
        self.assertFalse(result.truth_established)

    def test_same_source_group_does_not_count_as_independent(self):
        result = assess_claim(self.claim, [
            self.evidence("e1", "same-report"),
            self.evidence("e2", "same-report"),
            self.evidence("e3", "same-report"),
        ], self.policy)
        self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)
        self.assertEqual(len(result.independent_support_groups), 1)
        discounted = [c for c in result.contributions if c.excluded_reason]
        self.assertEqual(len(discounted), 2)

    def test_support_and_counterevidence_remain_contested(self):
        result = assess_claim(self.claim, [
            self.evidence("e1", "supplier", EvidencePolarity.SUPPORTS),
            self.evidence("e2", "site-audit", EvidencePolarity.COUNTERS),
        ], self.policy)
        self.assertEqual(result.status, ReviewStatus.CONTESTED)
        self.assertEqual(result.supporting_evidence_ids, ("e1",))
        self.assertEqual(result.counterevidence_ids, ("e2",))

    def test_model_agreement_alone_does_not_pass_gate(self):
        result = assess_claim(self.claim, [
            self.evidence("m1", "model-a", kind=SourceKind.MODEL_OUTPUT),
            self.evidence("m2", "model-b", kind=SourceKind.MODEL_OUTPUT),
        ], self.policy)
        # Both are model outputs: one pooled origin, so the stricter independence shortfall applies.
        self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)

    def test_self_labelled_groups_cannot_make_ungrounded_kinds_independent(self):
        """Finding B1: 3 model outputs / 4 user assertions / 8 unknown sources, each with its own
        self-chosen source_group, reached provisionally_supported."""
        for kind, count in ((SourceKind.MODEL_OUTPUT, 3), (SourceKind.USER_ASSERTION, 4),
                            (SourceKind.UNKNOWN, 8)):
            with self.subTest(kind=kind):
                items = [self.evidence(f"x{i}", f"label-{i}", kind=kind) for i in range(count)]
                result = assess_claim(self.claim, items, self.policy)
                self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)
                self.assertEqual(result.independent_support_groups, (f"<pooled:{kind.value}>",))
                self.assertEqual(sum(c.excluded_reason == "correlated_source_group_cap"
                                     for c in result.contributions), count - 1)

    def test_pooled_kind_plus_one_grounded_source_counts_as_two_groups(self):
        result = assess_claim(self.claim, [
            self.evidence("m1", "model-a", kind=SourceKind.MODEL_OUTPUT),
            self.evidence("m2", "model-b", kind=SourceKind.MODEL_OUTPUT),
            self.evidence("p1", "lab-measurement", kind=SourceKind.PRIMARY),
        ], self.policy)
        self.assertEqual(result.independent_support_groups,
                         ("<pooled:model_output>", "lab-measurement"))
        self.assertEqual(result.status, ReviewStatus.PROVISIONALLY_SUPPORTED)

    def test_grounded_kinds_keep_their_own_group_labels(self):
        result = assess_claim(self.claim, [
            self.evidence("a", "lab-a", kind=SourceKind.PRIMARY),
            self.evidence("b", "lab-b", kind=SourceKind.PEER_REVIEWED),
            self.evidence("c", "lab-c", kind=SourceKind.OFFICIAL),
            self.evidence("d", "lab-d", kind=SourceKind.SECONDARY),
        ], self.policy)
        self.assertEqual(result.independent_support_groups, ("lab-a", "lab-b", "lab-c", "lab-d"))

    def test_pooled_kinds_apply_to_counterevidence_too(self):
        items = [self.evidence(f"c{i}", f"label-{i}", EvidencePolarity.COUNTERS,
                               kind=SourceKind.MODEL_OUTPUT) for i in range(3)]
        result = assess_claim(self.claim, items, self.policy)
        self.assertEqual(result.independent_counter_groups, ("<pooled:model_output>",))
        self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)

    def test_registered_source_groups_exclude_unregistered_grounded_evidence(self):
        policy = ProtocolPolicy(minimum_effective_weight=0.6, minimum_independent_groups=2,
                                current_time="2026-10-11T12:00:00Z",
                                registered_source_groups=frozenset({"lab-a", "lab-b"}))
        items = [self.evidence("a", "lab-a"), self.evidence("b", "lab-b"),
                 self.evidence("z", "invented-group")]
        result = assess_claim(self.claim, items, policy)
        reasons = {c.evidence_id: c.excluded_reason for c in result.contributions}
        self.assertEqual(reasons["z"], "unregistered_source_group")
        self.assertEqual(reasons["a"], "")
        self.assertEqual(result.independent_support_groups, ("lab-a", "lab-b"))
        self.assertEqual(result.status, ReviewStatus.PROVISIONALLY_SUPPORTED)
        self.assertTrue(any("unregistered source group" in r for r in result.reasons))
        only_fake = assess_claim(self.claim, [self.evidence("f1", "fake-1"),
                                              self.evidence("f2", "fake-2")], policy)
        self.assertEqual(only_fake.status, ReviewStatus.INSUFFICIENT_EVIDENCE)

    def test_registry_does_not_apply_to_pooled_kinds_and_default_is_unrestricted(self):
        policy = ProtocolPolicy(current_time="2026-10-11T12:00:00Z",
                                registered_source_groups=frozenset({"lab-a"}))
        result = assess_claim(self.claim, [self.evidence("m", "anything", kind=SourceKind.MODEL_OUTPUT)], policy)
        self.assertEqual(dict((c.evidence_id, c.excluded_reason) for c in result.contributions)["m"], "")
        self.assertIsNone(ProtocolPolicy().registered_source_groups)
        open_result = assess_claim(self.claim, [self.evidence("a", "whatever-1"),
                                                self.evidence("b", "whatever-2")], self.policy)
        self.assertEqual(open_result.status, ReviewStatus.PROVISIONALLY_SUPPORTED)

    def test_same_group_supporting_and_counter_evidence_both_count(self):
        """Polarity is part of the group slot: one lab reporting both sides contests the claim."""
        result = assess_claim(self.claim, [
            self.evidence("s", "lab-a"),
            self.evidence("c", "lab-a", EvidencePolarity.COUNTERS),
        ], self.policy)
        self.assertEqual(result.status, ReviewStatus.CONTESTED)
        self.assertEqual(result.supporting_evidence_ids, ("s",))
        self.assertEqual(result.counterevidence_ids, ("c",))

    def test_unregistered_reason_is_reported_only_when_something_was_excluded(self):
        policy = ProtocolPolicy(current_time="2026-10-11T12:00:00Z",
                                registered_source_groups=frozenset({"lab-a", "lab-b"}))
        clean = assess_claim(self.claim, [self.evidence("a", "lab-a"), self.evidence("b", "lab-b")], policy)
        self.assertFalse(any("unregistered" in r for r in clean.reasons))

    def test_invalid_protocol_policy_thresholds_are_rejected(self):
        for bad in (float("nan"), float("inf"), -0.1, 1.1):
            with self.subTest(minimum_effective_weight=bad), self.assertRaises(ValueError):
                ProtocolPolicy(minimum_effective_weight=bad)
        for ok in (0.0, 1.0):
            ProtocolPolicy(minimum_effective_weight=ok)
        with self.assertRaises(ValueError):
            ProtocolPolicy(minimum_independent_groups=0)
        ProtocolPolicy(minimum_independent_groups=1)

    def test_registered_source_groups_must_be_a_frozenset_of_non_empty_strings(self):
        for bad in ({"lab-a"}, ["lab-a"], frozenset({""}), frozenset({"  "}), frozenset({1})):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                ProtocolPolicy(registered_source_groups=bad)
        ProtocolPolicy(registered_source_groups=frozenset())

    def test_expired_evidence_is_excluded(self):
        result = assess_claim(self.claim, [
            self.evidence(
                "old", "old-source",
                valid_until="2026-10-10T00:00:00Z",
            ),
            self.evidence("fresh", "fresh-source"),
        ], self.policy)
        self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_INDEPENDENCE)
        self.assertTrue(any(c.excluded_reason == "stale_or_expired" for c in result.contributions))

    def test_duplicate_ids_are_rejected(self):
        one = self.evidence("same", "source-a")
        with self.assertRaises(ValueError):
            assess_claim(self.claim, [one, one], self.policy)

    def test_cross_claim_evidence_is_rejected(self):
        wrong = EvidenceRecord(
            evidence_id="e1", claim_id="different",
            source_uri_or_reference="ref", source_group="g",
            source_kind=SourceKind.PRIMARY,
            polarity=EvidencePolarity.SUPPORTS,
        )
        with self.assertRaises(ValueError):
            assess_claim(self.claim, [wrong], self.policy)

    def test_naive_timestamps_are_rejected(self):
        with self.assertRaises(ValueError):
            self.evidence("bad-time", "source", observed_at="2026-10-11T12:00:00")

    def test_input_scores_are_bounded(self):
        with self.assertRaises(ValueError):
            self.evidence("bad-score", "source", reliability=1.5)


if __name__ == "__main__":
    unittest.main()
