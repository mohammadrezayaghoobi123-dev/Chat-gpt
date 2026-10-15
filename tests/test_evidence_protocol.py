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
        self.assertEqual(result.status, ReviewStatus.INSUFFICIENT_EVIDENCE)

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
