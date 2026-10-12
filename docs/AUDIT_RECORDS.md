# Audit records (MVP)

The `master_brain.audit.AuditRecord` contract provides a validated event format and deterministic JSON serialization. The integrated runtime now returns in-memory audit events alongside each `MissionRun`.

## Emitted event types

- `mission_run`: final run status, review level, and counts for selected/executed/missing islands, errors, claims, evidence, contradictions, reviews, and unresolved issues.
- `claim_review`: one event per distinct claim review, with evidence identifiers and counts of supporting and counterevidence.
- `contradiction_detected`: one event per detected potential conflict, linked to the two claim identifiers.

Events are available as `MissionRun.audit_records`. Each record has a generated event ID and timezone-aware UTC timestamp. A run blocked by an unknown risk tier or a missing approval mechanism still emits a `mission_run` event.

## Privacy and limits

- Raw mission objectives, island summaries, evidence text, model outputs, and credentials are not copied into audit metadata.
- Metadata contains only status labels, review level, counts, and other bounded fields; references contain non-empty identifiers only.
- Key-name checks reject credential-like metadata keys, including nested keys. They cannot detect a secret embedded inside an arbitrary string.
- Callers should continue to minimize data and redact sensitive values before constructing records.
- These events are returned in memory only. They are not durably stored, tamper-evident, signed, access-controlled, or guaranteed to survive a process exit.
- The event stream is a first integration seam, not a complete audit pipeline or independent verification of the underlying claims.

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
