# Master Brain — Durable Audit Store v0

## Purpose

Persist claims, evidence reviews, contradiction outcomes, test results, and decision changes as append-only audit events. This first increment stores generic structured events; domain-specific event schemas will be added separately.

## Guarantees

- JSON Lines persistence: one event per line.
- Each event is linked to the prior event by the SHA-256 hash chain from `audit_ledger.py`.
- Appends verify the full existing history first, reject duplicate event IDs, flush the file, and call `fsync`.
- Reads fail closed on malformed records, blank lines, invalid hashes, broken links, or modified payloads.
- Existing history is never automatically repaired, truncated, or rewritten.

## Explicit limits

- Single-writer only; concurrent writes to the same file are unsupported.
- This is local file persistence, not a database, distributed log, or encrypted store.
- A hash chain alone cannot prove who authored an event or when it was authored.
- An attacker able to rewrite the complete file can recompute the chain. Production integrity needs externally anchored checkpoints, controlled access, backups, and potentially digital signatures.
- `fsync` reduces data-loss risk but does not guarantee every filesystem or device has committed data to stable media.
- The store has no encryption, access-control layer, retention policy, schema migration, or automatic secret redaction. Do not write credentials, tokens, or sensitive personal data into event payloads.

## Usage

```python
from master_brain.audit_store import AuditStore

store = AuditStore("data/master_brain_audit.jsonl")
store.append(
    event_id="event-0001",
    event_type="claim.created",
    recorded_at="2026-10-11T12:00:00Z",
    actor="master-brain-core",
    subject_ref="claim:capacity-001",
    payload={"statement": "The line sustains 1,000 kg/day"},
)
events = store.read_all()  # verifies the complete chain before returning
```

## Maturity

Prototype persistence layer for local single-writer workflows. Synthetic unit tests verify persistence and corruption detection; they do not establish production readiness.
