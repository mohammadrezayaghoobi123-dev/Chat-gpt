# Audit records (MVP)

The `master_brain.audit.AuditRecord` contract provides a small validated event format and deterministic JSON serialization.

## Example

```python
from master_brain.audit import AuditRecord

event = AuditRecord(
    event_id="evt-001",
    event_type="claim_review",
    occurred_at="2026-10-12T09:30:00Z",
    component="proof_plane",
    status="completed",
    input_refs=("claim-001",),
    output_refs=("decision-001",),
    metadata={"risk_tier": "medium", "evidence_count": 3},
)
line = event.to_stable_json()
```

## Safety and limits

- Timestamps must be ISO-8601 and include a timezone.
- Stable JSON uses sorted keys, compact separators, UTF-8 characters, and rejects non-finite numbers.
- Metadata keys that look like credential/secret fields are rejected, including nested keys.
- Store references, counts, and safe summaries rather than raw prompts, private business records, model outputs, or credentials.
- Key-name checks cannot detect a secret embedded in an arbitrary string. Callers must still apply data minimization and secret redaction.
- This is an in-memory serialization contract only. It does not yet provide durable storage, tamper-evident signing, access control, or a complete audit pipeline.
