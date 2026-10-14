# Audit records (MVP)

The `master_brain.audit.AuditRecord` contract provides a validated event format and deterministic JSON serialization. The integrated runtime returns in-memory audit events alongside each `MissionRun`.

## Emitted event types

- `mission_run`: final run status, review level, and counts for selected/executed/missing islands, errors, claims, evidence, contradictions, reviews, CTP cases, and unresolved issues.
- `claim_review`: one event per distinct claim review, with evidence identifiers and counts of supporting and counterevidence.
- `contradiction_detected`: one event per detected potential conflict, linked to the two claim identifiers.
- `ctp_case_planned`: one event per generated Contradiction-to-Proof case, with counts of hypotheses, falsifiers, and proposed tests.

Events are available as `MissionRun.audit_records`. CTP plans are available separately as `MissionRun.ctp_cases`. Each audit record has a generated event ID and timezone-aware UTC timestamp. A run blocked by an unknown risk tier or a missing approval mechanism still emits a `mission_run` event.

## CTP planning behavior

When the proof plane detects a potential conflict, it proposes a CTP case containing two rival hypotheses, a falsifier for each hypothesis, and a discriminating test. A claim explicitly marked `high` or `critical` also receives a standalone CTP case when no detected contradiction already covers it. The test remains `not_run`; the planner does not conduct experiments, fetch external evidence, or decide which hypothesis is true. An executed outcome can be recorded through `record_test_execution`, which requires timezone-aware execution time, source, method, an independence group and rationale. `PASS` and `FAIL` require evidence references; `INCONCLUSIVE` remains unresolved. A plan alone is never evidence. The proposed procedure calls for scope/unit normalization and independent measurement, and explicitly notes that acceptance criteria should be defined before interpreting an outcome.

Importance is explicitly supplied by the caller using the `ClaimImportance` tier (`routine`, `high`, or `critical`); the system does not infer criticality from claim wording in this slice. CTP plans are not automatically updated from later evidence, and there is no automated test-execution service yet.

## Claim evidence independence gate

`Decision.independent_supporting_group_count` counts distinct non-empty `independent_group` labels attached to supporting evidence only; counterevidence groups do not inflate the supporting count. `Decision.independent_support_demonstrated` is true when that count is at least two. Multiple models or reports assigned to the same group count as one group, regardless of how many outputs they produce. This is a conservative bookkeeping gate, not a claim-truth verdict: group labels and source descriptions are caller-supplied and are not authenticated, and correlated sources may be mislabeled as independent.

## Privacy and limits

- Raw mission objectives, island summaries, evidence text, model outputs, and credentials are not copied into audit metadata.
- Metadata contains only status labels, review level, counts, and other bounded fields; references contain non-empty identifiers only.
- Key-name checks reject credential-like metadata keys, including nested keys. They cannot detect a secret embedded inside an arbitrary string.
- Callers should continue to minimize data and redact sensitive values before constructing records.
- Audit events are returned in memory only. They are not durably stored, tamper-evident, signed, access-controlled, or guaranteed to survive a process exit.
- Execution provenance is caller-supplied metadata, not authenticated proof that the named source or method was used. Evidence IDs are references only in this slice; artifact existence, content hashes, signatures, and independence are not independently verified. An `independent_group` label does not itself prove independence.
- Neither a generated CTP plan nor a successful fixture test is independent verification of the underlying claims.

## Standalone example

```python
from master_brain.audit import AuditRecord

event = AuditRecord(
    event_id="evt-001",
    event_type="claim_review",
    occurred_at="2026-10-12T09:30:00Z",
    component="proof_plane",
    status="supported_by_recorded_evidence",
    input_refs=("evidence-001",),
    output_refs=("claim-001",),
    metadata={"supporting_evidence_count": 1, "counterevidence_count": 0},
)
line = event.to_stable_json()
```
