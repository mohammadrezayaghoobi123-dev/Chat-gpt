# Evidence Protocol v0 — implementation note

**Branch:** `master-brain/proof-protocol-v0`  
**Scope:** deterministic, provider-independent claim review gate  
**Maturity:** implemented in branch; CI execution pending until workflow reports a run

## What it does

- Defines explicit claim and evidence records with source references, source groups, polarity, relevance, reliability, time validity, method, and limitations.
- Rejects malformed scores, missing identifiers, duplicate evidence IDs, cross-claim evidence, and timezone-naive timestamps.
- Excludes expired or policy-stale records.
- Caps each independent source group to its strongest contribution per polarity. Multiple outputs from the same model/provider/report family therefore do not automatically count as independent corroboration.
- Keeps supporting evidence and counterevidence visible.
- Returns conservative states: `unverified`, `insufficient_evidence`, `insufficient_independence`, `contested`, `provisionally_supported`, or `provisionally_refuted`.
- Exposes per-record contributions, reasons, and limitations for audit.

## Critical interpretation boundary

The score is a configurable **review gate**, not a probability that a statement is true. Source-kind multipliers are initial heuristics, not empirically calibrated reliability estimates. `truth_established` is always false. A result must not be presented as scientific proof or used as the sole basis for a high-impact action.

## What is not implemented

- Automated URL fetching, citation validation, source authenticity checks, or cryptographic signatures.
- Semantic equivalence/contradiction detection across differently worded claims.
- Domain-specific freshness policies or empirically calibrated source weights.
- Durable audit storage, signed logs, provider orchestration, UI, human-review workflow, or production authorization.
- Independent validation against real-world ground truth.

## Validation plan

The new unit tests cover empty evidence, independent source groups, correlated-source caps, counterevidence, model-only evidence, expiry, malformed IDs, cross-claim mixing, timestamps, and bounded inputs. The repository's GitHub Actions workflow is configured to run the full existing suite on this feature branch. Until an actual workflow result is observed, tests must be reported as **authored, execution unconfirmed**.

## Architectural fit

This module strengthens the integrated A+B design: broad reasoning/opportunity discovery may propose claims and options, while this protocol preserves provenance, counterevidence, independence limits, and explicit uncertainty. It does not replace the existing CTP prototype or the inaccessible original Master Brain source.
