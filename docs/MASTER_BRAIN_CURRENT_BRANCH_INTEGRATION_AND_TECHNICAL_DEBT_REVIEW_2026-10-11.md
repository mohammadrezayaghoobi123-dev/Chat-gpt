# Master Brain — Current-Branch Integration and Technical-Debt Review

**Date:** 2026-10-11  
**Branch:** `master-brain/proof-protocol-v0`  
**Scope:** Source-level review of the current prototype branch. This is not a live OpenClaw/Codespace integration test.

## Verified state

- The branch contains a structured evidence protocol, falsification/contradiction review, SHA-256 hash-chain ledger, JSONL audit store, and an adapter that runs a falsification review and persists its audit event.
- CI has passed for prior commits on this branch. The latest code change still requires its own CI result before it is called verified.
- The integration is **within the new prototype branch**. It has not been merged into `main`, the original OpenClaw runtime, or the inaccessible legacy implementation.
- The audit adapter retains evidence provenance (source reference/group/type, polarity, reliability/relevance, timestamps, method, limitations, verification flag), test observations, counterevidence IDs, rival hypotheses, and explicit reasons for a changed decision.
- A changed decision requires a non-empty explanation.
- Evidence associated with unexecuted tests is retained for traceability but marked as not attached to an executed test; the falsification engine excludes it from assessment.
- A contradiction label and an explicit counterexample label are now treated as different signals. A contradiction remains contested unless the evidence assessment or explicit counterexample criteria justify a stronger status.

## Priority technical debt

### P0 — Live runtime integration is not yet established
The new API is callable in tests, but the existing mission/planning flow does not yet invoke it automatically. The current branch has no demonstrated end-to-end path from user mission → canonical plan → executed test → evidence review → durable audit event in the original OpenClaw environment.

**Action:** Keep this integration isolated. Define a narrow application service interface and test its call contract before wiring it into any runtime. Do not claim live integration until the actual target environment and a non-destructive smoke test are available.

### P1 — Three overlapping planning/routing entry points
`core.route_task`, `archipelago.plan_mission`, and `meta_intelligence.plan_coordination` use different keyword registries and return different data structures. This can cause divergent routing, risk decisions, and capability-gap reporting.

**Action:** Define a versioned canonical mission/plan contract first. Write mapping and compatibility tests for each planner. Do not delete or rewrite existing planners before their behavior is captured.

### P1 — Two evidence representations coexist
The legacy `core.Evidence` / `evaluate_claim` path is materially simpler than `EvidenceRecord` / `assess_claim`. If both are used for high-impact decisions, their statuses and thresholds may disagree.

**Action:** Treat the newer evidence protocol as the candidate shared evidence contract, but do not silently migrate data. Add explicit conversion functions, provenance-loss warnings, and cross-path tests before routing decisions through one implementation.

### P1 — Audit durability has important boundaries
The JSONL store is single-writer and verifies the chain before read/append, but it has no inter-process lock, access-control policy, encryption, redaction policy, schema migration mechanism, or external checkpoint anchoring. A sufficiently privileged actor can rewrite the entire chain and recompute hashes.

**Action:** Keep this as a local prototype store. Before production use, add concurrency protection, permissions/secret redaction, versioned event schemas, and independently retained checkpoints. Avoid logging credentials, private prompts, or unnecessary personal data.

### P1 — Review outcomes are partly free-form
Test observations currently carry string outcomes. This permits spelling variants and makes it easier to confuse a conflict, a counterexample, and a successful run.

**Action:** Add a versioned outcome enum and an explicit mapping policy. Unknown outcome strings must be preserved but must not be interpreted as passing or falsifying evidence.

### P2 — Evidence scoring is heuristic
Source multipliers and independence groups are review heuristics, not calibrated probabilities. A score crossing a threshold is not a probability that a claim is true.

**Action:** Keep the provisional labels and limitations visible. Add calibration/benchmark work only when representative domain data and an evaluation protocol exist.

### P2 — Evidence IDs are not sufficient for independent reproduction
The audit record preserves source references and test descriptions, but the current schema does not require immutable artifact hashes, exact test procedure/version, environment fingerprint, or reviewer identity for every observation.

**Action:** Add a versioned `TestRun` / `SourceArtifact` contract before relying on this system for regulated or high-consequence decisions.

## Required merge gate for the previous environment

Do not merge by copying files blindly. When the original environment becomes accessible and the user authorizes inspection:

1. Snapshot source and configuration before changes.
2. Record the source commit, file hashes, dependency versions, and runtime status.
3. Compare behavior and contracts capability-by-capability.
4. Map legacy evidence and planner records to the new schemas without dropping provenance.
5. Run compatibility tests and a reversible smoke test in an isolated environment.
6. Merge only after explicit review; keep `main` and the original runtime unchanged until that gate passes.

## Next safe implementation step

Create a versioned canonical mission/plan interface and compatibility tests around the three existing planners. In parallel, harden falsification observation outcomes into an enum. Do not connect live providers or allow external actions until the mission lifecycle, evidence provenance, policy gate, and audit boundary are enforced and tested.
