"""Contradiction-to-Proof (CTP) planning contracts.

This module records what would discriminate between rival explanations.
It does not run experiments or turn an unexecuted test into evidence.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
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
class ExecutionProvenance:
    """Minimal traceability metadata for an actually executed test."""

    execution_id: str
    executed_at: str
    source: str
    method: str
    independent_group: str
    independence_basis: str
    limitations: tuple[str, ...] = ()

    def validate(self) -> tuple[str, ...]:
        issues: list[str] = []
        for name in (
            "execution_id", "executed_at", "source", "method",
            "independent_group", "independence_basis",
        ):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                issues.append(f"execution provenance {name} must be non-empty")
        if not isinstance(self.executed_at, str):
            return tuple(issues)
        if self.executed_at.strip():
            from datetime import datetime
            try:
                parsed = datetime.fromisoformat(
                    self.executed_at[:-1] + "+00:00"
                    if self.executed_at.endswith("Z") else self.executed_at
                )
                if parsed.tzinfo is None or parsed.utcoffset() is None:
                    issues.append("execution provenance executed_at must include a timezone")
            except ValueError:
                issues.append("execution provenance executed_at must be ISO-8601 with timezone")
        if any(not isinstance(item, str) or not item.strip() for item in self.limitations):
            issues.append("execution provenance limitations must be non-empty strings")
        return tuple(issues)


@dataclass(frozen=True)
class DiscriminatingTest:
    test_id: str
    question: str
    procedure: str
    expected_if: tuple[tuple[str, str], ...]
    status: TestStatus = TestStatus.NOT_RUN
    observed_result: str = ""
    evidence_ids: tuple[str, ...] = ()
    execution_provenance: ExecutionProvenance | None = None


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
            if test.status == TestStatus.NOT_RUN and (
                test.observed_result or test.evidence_ids or test.execution_provenance is not None
            ):
                issues.append(f"test {test.test_id} is NOT_RUN but has result/evidence/provenance; reconcile status")
            if test.status != TestStatus.NOT_RUN:
                if not test.observed_result.strip():
                    issues.append(f"test {test.test_id} is {test.status.value} but has no observed result")
                if test.execution_provenance is None:
                    issues.append(f"test {test.test_id} is {test.status.value} but has no execution provenance")
                else:
                    issues.extend(test.execution_provenance.validate())
                if test.status in (TestStatus.PASS, TestStatus.FAIL) and not test.evidence_ids:
                    issues.append(f"test {test.test_id} is {test.status.value} but has no evidence references")
            if any(not isinstance(ref, str) or not ref.strip() for ref in test.evidence_ids):
                issues.append(f"test {test.test_id} evidence references must be non-empty strings")
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
            and item.execution_provenance is not None
            and not item.execution_provenance.validate()
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

def plan_important_claim_case(claim: Claim) -> CTPCase:
    """Plan a falsification check for one explicitly high-importance claim.

    This proposes a test only. It does not assume the claim is true or false,
    execute a measurement, or create evidence.
    """
    identity = json.dumps(
        ["important-claim", claim.claim_id],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    accurate = f"h-{digest}-accurate"
    inaccurate = f"h-{digest}-inaccurate"
    tolerance = (
        "A tolerance and acceptance criterion defined before observing results, "
        "appropriate to the measurement method and decision risk"
    )
    prediction_accurate = (
        f"An independent, matched-scope replication is consistent with {claim.value!r} "
        "within the predeclared tolerance."
    )
    prediction_inaccurate = (
        f"An independent, matched-scope replication differs materially from {claim.value!r} "
        "or reveals a scope, definition, or provenance error."
    )
    procedure = (
        "Before collecting results, define the operational definition, units, time/context scope, "
        "measurement method, acceptance tolerance, and stop criteria. Obtain an independent "
        "measurement or replication; preserve source provenance and raw observations; normalize "
        "units; then compare against the predeclared criterion. Record evidence references and "
        "the observed result before assigning PASS, FAIL, or INCONCLUSIVE."
    )
    return CTPCase(
        case_id=f"ctp-{digest}",
        question=f"What independent observation could falsify or corroborate claim {claim.claim_id}?",
        claim_ids=(claim.claim_id,),
        hypotheses=(
            RivalHypothesis(
                accurate,
                f"Claim {claim.claim_id} is accurate for the declared scope and value {claim.value!r}.",
                (prediction_accurate,),
            ),
            RivalHypothesis(
                inaccurate,
                f"Claim {claim.claim_id} is materially inaccurate, incomplete, or scoped incorrectly.",
                (prediction_inaccurate,),
            ),
        ),
        falsifiers=(
            Falsifier(
                accurate,
                f"An independent matched-scope result falls outside {tolerance.lower()} for the claim.",
            ),
            Falsifier(
                inaccurate,
                "Independent replication supports the claim within the predeclared tolerance and no scope/provenance defect is found.",
            ),
        ),
        tests=(
            DiscriminatingTest(
                test_id=f"test-{digest}",
                question="Does an independent matched-scope check support the claim within predeclared criteria?",
                procedure=procedure,
                expected_if=((accurate, prediction_accurate), (inaccurate, prediction_inaccurate)),
                status=TestStatus.NOT_RUN,
            ),
        ),
        notes=(
            "High-importance claim selected for falsification planning; the proposed test has not been executed.",
            "A plan is not evidence. Record actual observations and provenance before changing the test status.",
        ),
    )



def record_test_execution(
    case: CTPCase,
    test_id: str,
    status: TestStatus,
    observed_result: str,
    evidence_ids: tuple[str, ...],
    provenance: ExecutionProvenance,
) -> CTPCase:
    """Return a new case with a recorded outcome; never execute the test itself."""
    if not isinstance(status, TestStatus):
        raise ValueError("status must be a TestStatus")
    if status == TestStatus.NOT_RUN:
        raise ValueError("an execution record cannot set status to NOT_RUN")
    if not isinstance(observed_result, str) or not observed_result.strip():
        raise ValueError("observed_result must be non-empty for an executed test")
    provenance_issues = provenance.validate()
    if provenance_issues:
        raise ValueError("; ".join(provenance_issues))
    if status in (TestStatus.PASS, TestStatus.FAIL) and not evidence_ids:
        raise ValueError("PASS/FAIL outcomes require at least one evidence reference")
    if any(not isinstance(ref, str) or not ref.strip() for ref in evidence_ids):
        raise ValueError("evidence references must be non-empty strings")
    matches = [item for item in case.tests if item.test_id == test_id]
    if len(matches) != 1:
        raise ValueError("test_id must match exactly one proposed test")
    updated = replace(
        matches[0], status=status, observed_result=observed_result.strip(),
        evidence_ids=tuple(evidence_ids), execution_provenance=provenance,
    )
    tests = tuple(updated if item.test_id == test_id else item for item in case.tests)
    result = replace(case, tests=tests)
    issues = result.validate()
    if issues:
        raise ValueError("recorded CTP case is invalid: " + "; ".join(issues))
    return result
