import unittest

from master_brain.ctp import (
    CTPCase,
    DiscriminatingTest,
    Falsifier,
    RivalHypothesis,
    TestStatus,
    ExecutionProvenance,
    record_test_execution,
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

    def test_case_validation_rejects_untyped_test_status(self):
        case = self.make_case()
        malformed_test = DiscriminatingTest(
            "test-01", "Question", "Procedure",
            (("h-a", "prediction"),), "PASS",
            observed_result="Observed result",
            evidence_ids=("evidence-001",),
            execution_provenance=ExecutionProvenance(
                "run-typed-status", "2026-10-12T10:00:00Z", "sensor",
                "measurement", "group-a", "separate operator",
            ),
        )
        malformed = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (malformed_test,),
        )
        self.assertTrue(any("status must be a TestStatus" in issue for issue in malformed.validate()))

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

    def test_case_requires_valid_claim_references(self):
        case = self.make_case()
        malformed = CTPCase(
            case.case_id, case.question, (), case.hypotheses,
            case.falsifiers, case.tests,
        )
        self.assertTrue(any("claim_ids must contain non-empty strings" in issue
                            for issue in malformed.validate()))

    def test_validation_reports_malformed_nested_contract_objects_without_crashing(self):
        case = self.make_case()
        malformed = CTPCase(
            case.case_id, case.question, case.claim_ids,
            (case.hypotheses[0], None), case.falsifiers, (case.tests[0], None),
        )
        issues = malformed.validate()
        self.assertTrue(any("invalid hypothesis" in issue.lower() for issue in issues))
        self.assertTrue(any("invalid test" in issue.lower() for issue in issues))

    def test_validation_reports_unhashable_hypothesis_and_test_ids(self):
        case = self.make_case()
        bad_hypothesis = RivalHypothesis(["not", "hashable"], "Malformed ID")
        bad_test = DiscriminatingTest(
            ["not", "hashable"], "Question", "Procedure",
            (("h-a", "prediction a"), ("h-b", "prediction b")),
        )
        malformed = CTPCase(
            case.case_id, case.question, case.claim_ids,
            (case.hypotheses[0], bad_hypothesis), case.falsifiers, (bad_test,),
        )
        issues = malformed.validate()
        self.assertTrue(any("hypothesis id must be a non-empty string" in issue.lower()
                            for issue in issues))
        self.assertTrue(any("test id must be a non-empty string" in issue.lower()
                            for issue in issues))

    def test_case_requires_a_falsifier_for_each_rival_hypothesis(self):
        case = self.make_case()
        incomplete = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers[:1], case.tests,
        )
        self.assertTrue(any("missing falsifier" in issue.lower()
                            for issue in incomplete.validate()))

    def test_discriminating_test_requires_prediction_for_each_hypothesis(self):
        case = self.make_case()
        incomplete_test = DiscriminatingTest(
            "test-01", "Question", "Procedure",
            (("h-a", "prediction for a"),),
        )
        incomplete = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (incomplete_test,),
        )
        self.assertTrue(any("missing expected prediction" in issue.lower()
                            for issue in incomplete.validate()))

    def test_discriminating_test_rejects_duplicate_predictions_for_same_hypothesis(self):
        case = self.make_case()
        ambiguous_test = DiscriminatingTest(
            "test-01", "Measure output", "Witness the run",
            (
                ("h-a", "Output reaches 1 ton/day"),
                ("h-a", "Output remains near 700 kg/day"),
                ("h-b", "Output remains near 700 kg/day"),
            ),
        )
        invalid = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (ambiguous_test,),
        )
        self.assertTrue(any("duplicate expected prediction" in issue.lower()
                            for issue in invalid.validate()))

    def test_unknown_hypothesis_reference_is_invalid(self):
        case = self.make_case()
        bad_falsifier = Falsifier("h-missing", "Something observable")
        invalid = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            (bad_falsifier,), case.tests,
        )
        self.assertTrue(any("unknown hypothesis" in issue for issue in invalid.validate()))

    def test_pass_with_result_and_evidence_but_no_execution_provenance_is_invalid(self):
        case = self.make_case()
        completed_test = DiscriminatingTest(
            "test-01", "Question", "Procedure",
            (("h-a", "prediction"),), TestStatus.PASS,
            observed_result="Observed value matches the predeclared criterion",
            evidence_ids=("evidence-001",),
        )
        completed_case = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (completed_test,),
        )
        self.assertTrue(any("execution provenance" in issue.lower() for issue in completed_case.validate()))


    def test_recorded_execution_requires_and_preserves_provenance(self):
        case = self.make_case()
        provenance = ExecutionProvenance(
            execution_id="run-001",
            executed_at="2026-10-12T10:00:00Z",
            source="calibrated production sensor",
            method="witnessed full-shift measurement",
            independent_group="independent-inspector-1",
            independence_basis="inspector is not employed by the equipment supplier",
            limitations=("single production shift",),
        )
        completed = record_test_execution(
            case, "test-01", TestStatus.PASS,
            "Output met the predeclared criterion",
            ("artifact-sha256:abc123",), provenance,
        )
        recorded = completed.tests[0]
        self.assertEqual(recorded.status, TestStatus.PASS)
        self.assertEqual(recorded.execution_provenance, provenance)
        self.assertTrue(completed.has_executed_evidence)
        self.assertEqual(completed.validate(), ())
        self.assertEqual(case.tests[0].status, TestStatus.NOT_RUN)

    def test_has_executed_evidence_rejects_malformed_evidence_references(self):
        case = self.make_case()
        provenance = ExecutionProvenance(
            "run-malformed-ref", "2026-10-12T10:00:00Z", "sensor",
            "measurement", "group-a", "separate operator",
        )
        malformed_test = DiscriminatingTest(
            "test-01", "Measure output", "Witness the run",
            (("h-a", "prediction a"), ("h-b", "prediction b")),
            TestStatus.PASS, observed_result="Observed", evidence_ids=(None,),
            execution_provenance=provenance,
        )
        malformed_case = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (malformed_test,),
        )
        self.assertFalse(malformed_case.has_executed_evidence)
        self.assertTrue(any("evidence references must be non-empty strings" in issue
                            for issue in malformed_case.validate()))

    def test_record_execution_rejects_malformed_case_without_internal_exception(self):
        case = self.make_case()
        malformed = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, None,
        )
        provenance = ExecutionProvenance(
            "run-invalid-case", "2026-10-12T10:00:00Z", "sensor",
            "measurement", "group-a", "separate operator",
        )
        with self.assertRaisesRegex(ValueError, "case must be valid before recording execution"):
            record_test_execution(
                malformed, "test-01", TestStatus.PASS, "Observed",
                ("evidence-001",), provenance,
            )

    def test_record_execution_rejects_missing_provenance_object(self):
        case = self.make_case()
        with self.assertRaisesRegex(ValueError, "provenance must be an ExecutionProvenance"):
            record_test_execution(
                case, "test-01", TestStatus.PASS, "Passed", ("evidence-001",), None,
            )

    def test_status_properties_ignore_malformed_test_entries(self):
        case = self.make_case()
        malformed = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (None, case.tests[0]),
        )
        self.assertEqual(malformed.unresolved_test_ids, ("test-01",))
        self.assertFalse(malformed.has_executed_evidence)

    def test_has_executed_evidence_is_safe_for_malformed_observed_result(self):
        case = self.make_case()
        malformed_test = DiscriminatingTest(
            "test-01", "Question", "Procedure",
            (("h-a", "prediction"),), TestStatus.PASS,
            observed_result=None, evidence_ids=("evidence-001",),
            execution_provenance=ExecutionProvenance(
                "run-malformed-result", "2026-10-12T10:00:00Z", "sensor",
                "measurement", "group-a", "separate operator",
            ),
        )
        malformed = CTPCase(
            case.case_id, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, (malformed_test,),
        )
        self.assertFalse(malformed.has_executed_evidence)
        self.assertTrue(any("no observed result" in issue for issue in malformed.validate()))

    def test_case_validation_reports_non_text_case_id(self):
        case = self.make_case()
        malformed = CTPCase(
            None, case.question, case.claim_ids, case.hypotheses,
            case.falsifiers, case.tests,
        )
        self.assertTrue(any("case_id must be a non-empty string" in issue
                            for issue in malformed.validate()))

    def test_record_execution_rejects_untyped_status(self):
        case = self.make_case()
        provenance = ExecutionProvenance(
            "run-invalid-status", "2026-10-12T10:00:00Z", "sensor",
            "measurement", "group-a", "separate operator",
        )
        with self.assertRaisesRegex(ValueError, "status must be a TestStatus"):
            record_test_execution(
                case, "test-01", "PASS", "Passed", ("evidence-001",), provenance,
            )

    def test_pass_without_evidence_reference_is_rejected(self):
        case = self.make_case()
        provenance = ExecutionProvenance(
            "run-002", "2026-10-12T10:00:00Z", "sensor",
            "measurement", "group-a", "separate operator",
        )
        with self.assertRaisesRegex(ValueError, "evidence reference"):
            record_test_execution(
                case, "test-01", TestStatus.PASS, "Passed", (), provenance,
            )

    def test_record_execution_rejects_string_instead_of_evidence_id_sequence(self):
        case = self.make_case()
        provenance = ExecutionProvenance(
            "run-string-evidence", "2026-10-12T10:00:00Z", "sensor",
            "measurement", "group-a", "separate operator",
        )
        with self.assertRaisesRegex(ValueError, "evidence_ids must be a tuple or list"):
            record_test_execution(
                case, "test-01", TestStatus.PASS, "Passed", "evidence-001", provenance,
            )

    def test_provenance_rejects_string_instead_of_limitations_sequence(self):
        invalid = ExecutionProvenance(
            "run-string-limitations", "2026-10-12T10:00:00Z", "sensor",
            "measurement", "group-a", "separate operator",
            limitations="not-a-sequence",
        )
        self.assertTrue(any("limitations must be a tuple or list" in issue
                            for issue in invalid.validate()))

    def test_execution_provenance_requires_timezone_and_independence_basis(self):
        invalid = ExecutionProvenance(
            "run-003", "2026-10-12T10:00:00", "sensor",
            "measurement", "group-a", "",
        )
        issues = invalid.validate()
        self.assertTrue(any("timezone" in issue for issue in issues))
        self.assertTrue(any("independence_basis" in issue for issue in issues))


if __name__ == "__main__":
    unittest.main()
