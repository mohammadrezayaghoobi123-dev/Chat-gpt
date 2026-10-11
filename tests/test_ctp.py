import unittest

from master_brain.ctp import (
    CTPCase,
    DiscriminatingTest,
    Falsifier,
    RivalHypothesis,
    TestStatus,
)


class CTPCaseTests(unittest.TestCase):
    def make_case(self):
        return CTPCase(
            case_id="ctp-001",
            question="Which supplier capacity claim is accurate?",
            claim_ids=("claim-a", "claim-b"),
            hypotheses=(
                RivalHypothesis("h-a", "Supplier can sustain 1 ton/day."),
                RivalHypothesis("h-b", "Supplier can sustain only 700 kg/day."),
            ),
            falsifiers=(
                Falsifier("h-a", "A controlled full-shift run repeatedly falls below 1 ton."),
                Falsifier("h-b", "A witnessed full-shift run consistently reaches 1 ton."),
            ),
            tests=(
                DiscriminatingTest(
                    "test-01",
                    "Measure sustained output",
                    "Witness and record a defined full-shift production run, including downtime and rejects.",
                    (("h-a", "Output sustains 1 ton/day"), ("h-b", "Output remains near 700 kg/day")),
                ),
            ),
        )

    def test_valid_case_starts_not_run(self):
        case = self.make_case()
        self.assertEqual(case.validate(), ())
        self.assertEqual(case.unresolved_test_ids, ("test-01",))
        self.assertFalse(case.has_executed_evidence)

    def test_not_run_cannot_claim_result_or_evidence(self):
        case = self.make_case()
        bad_test = DiscriminatingTest(
            "test-01", "Question", "Procedure",
            (("h-a", "prediction"),), TestStatus.NOT_RUN,
            observed_result="It passed", evidence_ids=("e-1",),
        )
        invalid = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (bad_test,),
        )
        self.assertTrue(any("NOT_RUN" in issue for issue in invalid.validate()))

    def test_pass_without_observed_result_is_invalid(self):
        case = self.make_case()
        bad_test = DiscriminatingTest(
            "test-01", "Question", "Procedure",
            (("h-a", "prediction"),), TestStatus.PASS,
        )
        invalid = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (bad_test,),
        )
        self.assertTrue(any("no observed result" in issue for issue in invalid.validate()))

    def test_unknown_hypothesis_reference_is_invalid(self):
        case = self.make_case()
        bad_falsifier = Falsifier("h-missing", "Something observable")
        invalid = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            (bad_falsifier,), case.tests,
        )
        self.assertTrue(any("unknown hypothesis" in issue for issue in invalid.validate()))


if __name__ == "__main__":
    unittest.main()
