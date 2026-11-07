# Evidence Protocol v0 — implementation note

**Branch:** `master-brain/proof-protocol-v0`  
**Scope:** deterministic claim review, CTP evidence bridge, and offline audit-chain primitive  
**Maturity:** implemented; check the linked latest CI run for execution status

## Evidence review

- Defines explicit claim and evidence records with source references, source groups, polarity, relevance, reliability, time validity, method, and limitations.
- Rejects malformed scores, missing identifiers, duplicate evidence IDs, cross-claim evidence, and timezone-naive timestamps.
- Excludes expired or policy-stale records.
- Caps each independent source group to its strongest contribution per polarity. Multiple outputs from the same model/provider/report family therefore do not automatically count as independent corroboration.
- Keeps supporting evidence and counterevidence visible.
- Returns conservative states: `unverified`, `insufficient_evidence`, `insufficient_independence`, `contested`, `provisionally_supported`, or `provisionally_refuted`.
- Exposes per-record contributions, reasons, and limitations for audit.

## CTP evidence bridge

`src/master_brain/ctp_evidence_bridge.py` links evidence to claim assessments only when a CTP test is marked `PASS` or `FAIL` and has a non-empty observed result. It reports unresolved tests, missing claim/evidence references, duplicate IDs, and evidence linked to claims outside the case. Evidence attached to `NOT_RUN` or `INCONCLUSIVE` tests is treated as an integrity issue and is not used in claim scoring. The bridge returns `truth_established=False`; a ready review package is not proof of truth.

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

Unit tests cover empty evidence, independent source groups, correlated-source caps, counterevidence, model-only evidence, expiry, malformed IDs, cross-claim mixing, timestamps, bounded inputs, CTP test status/evidence linking, missing and orphan references, hash-chain creation/verification, payload tampering, reordering, duplicate IDs, and invalid JSON numbers. GitHub Actions is the execution source of truth; passing synthetic tests does not establish real-world correctness.

## Architectural fit

This module strengthens the integrated A+B design: broad reasoning/opportunity discovery may propose claims and options, while this protocol preserves provenance, counterevidence, independence limits, and explicit uncertainty. CTP records which discriminating tests remain unresolved and links only executed test records to the evidence review. The audit primitive makes event changes detectable relative to a trusted checkpoint. None of these components replaces the inaccessible original Master Brain source.
