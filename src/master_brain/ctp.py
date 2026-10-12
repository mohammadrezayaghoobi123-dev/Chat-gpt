"""Contradiction-to-Proof (CTP) planning contracts.

This module records what would discriminate between rival explanations.
It does not run experiments or turn an unexecuted test into evidence.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json

from .core import Claim, Contradiction


class TestStatus(str, Enum):
    __test__ = False  # Prevent pytest from treating this imported enum as a test class.

    NOT_RUN = "not_run"
    PASS = "pass"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"


@dataclass(frozen=True)
class RivalHypothesis:
    hypothesis_id: str
    statement: str
    predictions: tuple[str, ...] = ()


@dataclass(frozen=True)
class Falsifier:
    hypothesis_id: str
    observation_that_would_weaken_it: str


@dataclass(frozen=True)
class DiscriminatingTest:
    test_id: str
    question: str
    procedure: str
    expected_if: tuple[tuple[str, str], ...]
    status: TestStatus = TestStatus.NOT_RUN
    observed_result: str = ""
    evidence_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CTPCase:
    case_id: str
    question: str
    claim_ids: tuple[str, ...]
    hypotheses: tuple[RivalHypothesis, ...]
    falsifiers: tuple[Falsifier, ...]
    tests: tuple[DiscriminatingTest, ...]
    notes: tuple[str, ...] = ()

    def validate(self) -> tuple[str, ...]:
        """Return structural issues without deciding which hypothesis is true."""
        issues: list[str] = []
        if not self.case_id.strip():
            issues.append("case_id must not be empty")
        if not self.question.strip():
            issues.append("question must not be empty")
        if len(self.hypotheses) < 2:
            issues.append("at least two rival hypotheses are required")
        hypothesis_ids = [item.hypothesis_id for item in self.hypotheses]
        if len(set(hypothesis_ids)) != len(hypothesis_ids):
            issues.append("hypothesis IDs must be unique")
        known = set(hypothesis_ids)
        for item in self.falsifiers:
            if item.hypothesis_id not in known:
                issues.append(f"falsifier references unknown hypothesis: {item.hypothesis_id}")
            if not item.observation_that_would_weaken_it.strip():
                issues.append(f"falsifier for {item.hypothesis_id} has no observation")
        test_ids = [item.test_id for item in self.tests]
        if len(set(test_ids)) != len(test_ids):
            issues.append("test IDs must be unique")
        for test in self.tests:
            for hypothesis_id, _prediction in test.expected_if:
                if hypothesis_id not in known:
                    issues.append(f"test {test.test_id} references unknown hypothesis: {hypothesis_id}")
            if test.status == TestStatus.NOT_RUN and (test.observed_result or test.evidence_ids):
                issues.append(f"test {test.test_id} is NOT_RUN but has result/evidence; reconcile status")
            if test.status in (TestStatus.PASS, TestStatus.FAIL) and not test.observed_result.strip():
                issues.append(f"test {test.test_id} is {test.status.value} but has no observed result")
        if not self.tests:
            issues.append("at least one discriminating test should be proposed")
        return tuple(issues)

    @property
    def unresolved_test_ids(self) -> tuple[str, ...]:
        """Tests still requiring execution or interpretation."""
        return tuple(
            item.test_id for item in self.tests
            if item.status in (TestStatus.NOT_RUN, TestStatus.INCONCLUSIVE)
        )

    @property
    def has_executed_evidence(self) -> bool:
        """True only when a test record contains an outcome and evidence reference."""
        return any(
            item.status in (TestStatus.PASS, TestStatus.FAIL)
            and item.observed_result.strip()
            and item.evidence_ids
            for item in self.tests
        )


def plan_contradiction_case(
    claim_a: Claim,
    claim_b: Claim,
    contradiction: Contradiction,
) -> CTPCase:
    """Build a test plan for a detected conflict; never execute the proposed test."""
    identity = json.dumps(
        [contradiction.claim_a, contradiction.claim_b],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    hypothesis_a = f"h-{digest}-a"
    hypothesis_b = f"h-{digest}-b"
    scope = {
        "subject": claim_a.subject,
        "predicate": claim_a.predicate,
        "context": claim_a.context,
        "time_scope": claim_a.time_scope,
        "definition": claim_a.definition,
    }
    question = "Which reported value is supported by independent evidence under the same scope?"
    test_question = "Which value is reproducible after scope and units are normalized?"
    procedure = (
        "Normalize units, definitions, context, and time scope; inspect source provenance and "
        "independence; then obtain or review an independent measurement using the same operational "
        "definition. Record the actual observation and evidence references before assigning a result."
    )
    prediction_a = f"An independent matched-scope observation is consistent with {claim_a.value!r}."
    prediction_b = f"An independent matched-scope observation is consistent with {claim_b.value!r}."
    return CTPCase(
        case_id=f"ctp-{digest}",
        question=question,
        claim_ids=(claim_a.claim_id, claim_b.claim_id),
        hypotheses=(
            RivalHypothesis(
                hypothesis_a,
                f"Claim {claim_a.claim_id} is accurate for scope {scope!r}, with value {claim_a.value!r}.",
                (prediction_a,),
            ),
            RivalHypothesis(
                hypothesis_b,
                f"Claim {claim_b.claim_id} is accurate for the same scope, with value {claim_b.value!r}.",
                (prediction_b,),
            ),
        ),
        falsifiers=(
            Falsifier(
                hypothesis_a,
                f"A matched-scope independent measurement is inconsistent with {claim_a.value!r} after normalization.",
            ),
            Falsifier(
                hypothesis_b,
                f"A matched-scope independent measurement is inconsistent with {claim_b.value!r} after normalization.",
            ),
        ),
        tests=(
            DiscriminatingTest(
                test_id=f"test-{digest}",
                question=test_question,
                procedure=procedure,
                expected_if=((hypothesis_a, prediction_a), (hypothesis_b, prediction_b)),
                status=TestStatus.NOT_RUN,
            ),
        ),
        notes=(
            "Generated from a potential conflict; the proposed test has not been executed and no external verification has been run.",
            "Predefine measurement tolerance and acceptance criteria before interpreting an observed result.",
        ),
    )
