"""Contradiction and falsification workflow for Master Brain claims.

This module organizes rival hypotheses and explicit disconfirmation criteria.
It does not infer truth from missing counterevidence: every review remains
provisional and records what was and was not tested.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable

from master_brain.evidence_protocol import (
    ClaimAssessment,
    ClaimRecord,
    EvidenceRecord,
    ProtocolPolicy,
    ReviewStatus,
    assess_claim,
)


class FalsificationStatus(str, Enum):
    NOT_DESIGNED = "not_designed"
    READY_TO_TEST = "ready_to_test"
    TESTS_INCOMPLETE = "tests_incomplete"
    COUNTEREXAMPLE_FOUND = "counterexample_found"
    CONTRADICTION_REMAINS = "contradiction_remains"
    SURVIVED_TESTS_PROVISIONALLY = "survived_tests_provisionally"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True)
class RivalHypothesis:
    hypothesis_id: str
    statement: str
    discriminating_test_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.hypothesis_id.strip() or not self.statement.strip():
            raise ValueError("rival hypothesis ID and statement must not be empty")
        if len(self.discriminating_test_ids) != len(set(self.discriminating_test_ids)):
            raise ValueError("discriminating test IDs must be unique")


@dataclass(frozen=True)
class FalsificationPlan:
    claim: ClaimRecord
    rival_hypotheses: tuple[RivalHypothesis, ...]
    disconfirmation_criteria: tuple[str, ...]
    test_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if len(self.test_ids) != len(set(self.test_ids)):
            raise ValueError("test IDs must be unique")
        if len({r.hypothesis_id for r in self.rival_hypotheses}) != len(self.rival_hypotheses):
            raise ValueError("rival hypothesis IDs must be unique")
        if any(not value.strip() for value in self.disconfirmation_criteria):
            raise ValueError("disconfirmation criteria must not be empty")
        if any(not value.strip() for value in self.test_ids):
            raise ValueError("test IDs must not be empty")


@dataclass(frozen=True)
class TestObservation:
    test_id: str
    executed: bool
    outcome: str
    observed_result: str
    evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.test_id.strip():
            raise ValueError("test_id must not be empty")
        if self.executed and not self.observed_result.strip():
            raise ValueError("executed tests require an observed result")
        if not self.executed and self.observed_result.strip():
            raise ValueError("unexecuted tests cannot claim an observed result")
        if len(self.evidence_ids) != len(set(self.evidence_ids)):
            raise ValueError("evidence IDs must be unique per test observation")


@dataclass(frozen=True)
class FalsificationReview:
    claim_id: str
    status: FalsificationStatus
    evidence_assessment: ClaimAssessment
    missing_test_ids: tuple[str, ...]
    unexpected_test_ids: tuple[str, ...]
    rival_hypothesis_ids: tuple[str, ...]
    disconfirmation_criteria: tuple[str, ...]
    executed_observations: tuple[TestObservation, ...]
    unexecuted_test_ids: tuple[str, ...]
    counterexample_evidence_ids: tuple[str, ...]
    reasons: tuple[str, ...]
    truth_established: bool = False


def review_falsification_plan(
    plan: FalsificationPlan,
    observations: Iterable[TestObservation],
    evidence_records: Iterable[EvidenceRecord],
    policy: ProtocolPolicy = ProtocolPolicy(),
) -> FalsificationReview:
    """Review whether a claim survived specified tests; never call it proven.

    Only evidence explicitly attached to executed observations is eligible.
    A test outcome of 'counterexample' or 'contradiction' is treated as a
    disconfirmation signal. Other outcome strings are preserved but not
    interpreted as proof.
    """
    observed = tuple(observations)
    evidence = tuple(evidence_records)
    observation_ids = [item.test_id for item in observed]
    if len(observation_ids) != len(set(observation_ids)):
        raise ValueError("observation test IDs must be unique")
    evidence_ids = [item.evidence_id for item in evidence]
    if len(evidence_ids) != len(set(evidence_ids)):
        raise ValueError("evidence IDs must be unique")
    if any(item.claim_id != plan.claim.claim_id for item in evidence):
        raise ValueError("evidence must reference the reviewed claim")

    planned = set(plan.test_ids)
    supplied = set(observation_ids)
    missing = tuple(sorted(planned - supplied))
    unexpected = tuple(sorted(supplied - planned))
    evidence_by_id = {item.evidence_id: item for item in evidence}
    eligible_ids: set[str] = set()
    reasons: list[str] = [
        "Surviving specified tests is provisional, not proof of truth.",
        "Absence of a discovered counterexample is not evidence that the search was exhaustive.",
    ]

    for observation in observed:
        if not observation.executed:
            if observation.evidence_ids:
                reasons.append(
                    f"Unexecuted test {observation.test_id} references evidence; those records were excluded."
                )
            continue
        for evidence_id in observation.evidence_ids:
            if evidence_id not in evidence_by_id:
                reasons.append(
                    f"Test {observation.test_id} references missing evidence {evidence_id}."
                )
            else:
                eligible_ids.add(evidence_id)

    eligible = [evidence_by_id[key] for key in sorted(eligible_ids)]
    assessment = assess_claim(plan.claim, eligible, policy)
    executed = tuple(item for item in observed if item.executed)
    unexecuted = tuple(sorted(
        set(plan.test_ids) - {item.test_id for item in executed}
    ))
    counterexamples = tuple(sorted(
        item.evidence_id for item in eligible
        if item.polarity.value == "counters"
    ))
    explicit_counterexample = any(
        item.executed and item.outcome.strip().lower() in
        {"counterexample", "contradiction", "falsified", "refuted"}
        for item in observed
    )
    explicit_contradiction = any(
        item.executed and item.outcome.strip().lower() in
        {"contradiction", "conflict"}
        for item in observed
    )

    if explicit_counterexample or (
        assessment.status is ReviewStatus.PROVISIONALLY_REFUTED
    ):
        status = FalsificationStatus.COUNTEREXAMPLE_FOUND
        reasons.append("A disconfirmation signal was recorded; inspect its scope and validity.")
    elif assessment.status is ReviewStatus.CONTESTED or explicit_contradiction:
        status = FalsificationStatus.CONTRADICTION_REMAINS
        reasons.append("Supporting and counterevidence conflict or an observation explicitly reports contradiction.")
    elif missing or unexecuted or unexpected:
        status = FalsificationStatus.TESTS_INCOMPLETE
        reasons.append("The planned test set is incomplete, includes unexecuted tests, or has unexpected observations.")
    elif not plan.disconfirmation_criteria or not plan.test_ids:
        status = FalsificationStatus.NOT_DESIGNED
        reasons.append("No complete disconfirmation criteria and test set were defined.")
    elif assessment.status is ReviewStatus.PROVISIONALLY_SUPPORTED:
        status = FalsificationStatus.SURVIVED_TESTS_PROVISIONALLY
        reasons.append("The claim survived the specified checks and evidence gate provisionally; it is not proven.")
    else:
        status = FalsificationStatus.INSUFFICIENT_EVIDENCE
        reasons.append("Available evidence does not justify a stronger conclusion.")

    if unexpected:
        reasons.append("Unexpected observations are preserved for review rather than silently discarded.")
    if counterexamples:
        reasons.append("Counterevidence IDs are preserved for direct inspection.")

    return FalsificationReview(
        claim_id=plan.claim.claim_id,
        status=status,
        evidence_assessment=assessment,
        missing_test_ids=missing,
        unexpected_test_ids=unexpected,
        rival_hypothesis_ids=tuple(item.hypothesis_id for item in plan.rival_hypotheses),
        disconfirmation_criteria=plan.disconfirmation_criteria,
        executed_observations=executed,
        unexecuted_test_ids=unexecuted,
        counterexample_evidence_ids=counterexamples,
        reasons=tuple(reasons),
        truth_established=False,
    )
