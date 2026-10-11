"""Bridge CTP experiment records to evidence review without upgrading plans to proof."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from master_brain.ctp import CTPCase, TestStatus
from master_brain.evidence_protocol import (
    ClaimAssessment,
    ClaimRecord,
    EvidenceRecord,
    ProtocolPolicy,
    assess_claim,
)


@dataclass(frozen=True)
class CTPEvidenceReview:
    case_id: str
    structural_issues: tuple[str, ...]
    unresolved_test_ids: tuple[str, ...]
    missing_claim_ids: tuple[str, ...]
    missing_evidence_ids: tuple[str, ...]
    orphan_evidence_ids: tuple[str, ...]
    claim_assessments: tuple[ClaimAssessment, ...]
    truth_established: bool = False

    @property
    def ready_for_human_review(self) -> bool:
        return (
            not self.structural_issues
            and not self.missing_claim_ids
            and not self.missing_evidence_ids
            and not self.orphan_evidence_ids
            and bool(self.claim_assessments)
        )


def review_ctp_evidence(
    case: CTPCase,
    claims: Mapping[str, ClaimRecord],
    evidence_records: Iterable[EvidenceRecord],
    policy: ProtocolPolicy = ProtocolPolicy(),
) -> CTPEvidenceReview:
    """Review only evidence explicitly linked to executed CTP tests.

    Evidence attached to NOT_RUN or INCONCLUSIVE tests is reported as an
    integrity issue, never silently treated as observed experimental evidence.
    The result is a review package, not a declaration that a claim is true.
    """
    evidence_list = tuple(evidence_records)
    evidence_by_id: dict[str, EvidenceRecord] = {}
    duplicate_ids: list[str] = []
    for item in evidence_list:
        if item.evidence_id in evidence_by_id:
            duplicate_ids.append(item.evidence_id)
        else:
            evidence_by_id[item.evidence_id] = item

    structural = list(case.validate())
    if duplicate_ids:
        structural.append(
            "duplicate evidence IDs supplied: " + ", ".join(sorted(set(duplicate_ids)))
        )

    case_claim_ids = set(case.claim_ids)
    missing_claims = sorted(case_claim_ids - set(claims))
    orphan_evidence: set[str] = set()
    linked_ids: set[str] = set()
    missing_evidence: set[str] = set()

    for test in case.tests:
        if test.status in (TestStatus.NOT_RUN, TestStatus.INCONCLUSIVE) and test.evidence_ids:
            structural.append(
                f"test {test.test_id} has evidence references but status is {test.status.value}"
            )
            orphan_evidence.update(test.evidence_ids)
            continue
        if test.status not in (TestStatus.PASS, TestStatus.FAIL):
            continue
        if not test.observed_result.strip():
            structural.append(f"executed test {test.test_id} has no observed result")
            orphan_evidence.update(test.evidence_ids)
            continue
        for evidence_id in test.evidence_ids:
            item = evidence_by_id.get(evidence_id)
            if item is None:
                missing_evidence.add(evidence_id)
                continue
            if item.claim_id not in case_claim_ids:
                structural.append(
                    f"evidence {evidence_id} refers to claim {item.claim_id} outside CTP case"
                )
                orphan_evidence.add(evidence_id)
                continue
            linked_ids.add(evidence_id)

    assessments: list[ClaimAssessment] = []
    for claim_id in case.claim_ids:
        claim = claims.get(claim_id)
        if claim is None:
            continue
        claim_evidence = [
            evidence_by_id[evidence_id]
            for evidence_id in sorted(linked_ids)
            if evidence_by_id[evidence_id].claim_id == claim_id
        ]
        assessments.append(assess_claim(claim, claim_evidence, policy))

    return CTPEvidenceReview(
        case_id=case.case_id,
        structural_issues=tuple(dict.fromkeys(structural)),
        unresolved_test_ids=case.unresolved_test_ids,
        missing_claim_ids=tuple(missing_claims),
        missing_evidence_ids=tuple(sorted(missing_evidence)),
        orphan_evidence_ids=tuple(sorted(orphan_evidence)),
        claim_assessments=tuple(assessments),
        truth_established=False,
    )
