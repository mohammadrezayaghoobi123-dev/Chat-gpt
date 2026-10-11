"""Contradiction-to-Proof (CTP) planning contracts.

This module records what would discriminate between rival explanations.
It does not run experiments or turn an unexecuted test into evidence.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class TestStatus(str, Enum):
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
