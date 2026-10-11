# Evidence Protocol v0 — implementation note

**Branch:** `master-brain/proof-protocol-v0`  
**Scope:** deterministic, provider-independent claim review gate plus offline audit-chain primitive  
**Maturity:** implemented in branch; validate the latest CI run before reporting tests as passing

## Evidence review

- Defines explicit claim and evidence records with source references, source groups, polarity, relevance, reliability, time validity, method, and limitations.
- Rejects malformed scores, missing identifiers, duplicate evidence IDs, cross-claim evidence, and timezone-naive timestamps.
- Excludes expired or policy-stale records.
- Caps each independent source group to its strongest contribution per polarity. Multiple outputs from the same model/provider/report family therefore do not automatically count as independent corroboration.
- Keeps supporting evidence and counterevidence visible.
- Returns conservative states: `unverified`, `insufficient_evidence`, `insufficient_independence`, `contested`, `provisionally_supported`, or `provisionally_refuted`.
- Exposes per-record contributions, reasons, and limitations for audit.

## Hash-chain audit primitive

`src/master_brain/audit_ledger.py` serializes event bodies with canonical JSON (sorted keys, compact separators, UTF-8) and SHA-256, linking each event to the previous digest. It can build and verify an in-memory chain, and detects changed payloads, broken links, reordered events, and duplicate event IDs.

**Security boundary:** a hash chain is not a digital signature, trusted timestamp, or persistent store. Anyone who can rewrite the entire chain can recompute its hashes. Production use needs durable append-only storage, access controls, and checkpoints anchored in a separately controlled location. No credentials or secrets belong in event payloads.

## Critical interpretation boundary

The evidence score is a configurable **review gate**, not a probability that a statement is true. Source-kind multipliers are initial heuristics, not empirically calibrated reliability estimates. `truth_established` is always false. A result must not be presented as scientific proof or used as the sole basis for a high-impact action.

## Not implemented

- Automated URL fetching, citation validation, source authenticity checks, or cryptographic signatures.
- Semantic equivalence/contradiction detection across differently worded claims.
- Domain-specific freshness policies or empirically calibrated source weights.
- Durable audit storage, externally anchored checkpoints, provider orchestration, UI, human-review workflow, or production authorization.
- Independent validation against real-world ground truth.

## Validation coverage

Unit tests cover empty evidence, independent source groups, correlated-source caps, counterevidence, model-only evidence, expiry, malformed IDs, cross-claim mixing, timestamps, bounded inputs, hash-chain creation/verification, payload tampering, reordering, duplicate IDs, and invalid JSON numbers. The latest GitHub Actions result is the source of truth for execution status.

## Architectural fit

This module strengthens the integrated A+B design: broad reasoning/opportunity discovery may propose claims and options, while this protocol preserves provenance, counterevidence, independence limits, and explicit uncertainty. The audit primitive makes event changes detectable relative to a trusted checkpoint. Neither component replaces the existing CTP prototype or the inaccessible original Master Brain source.
