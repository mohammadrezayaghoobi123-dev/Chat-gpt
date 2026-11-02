# Master Brain — Implementation Gap Register
**Audit date:** 2026-10-11  
**Branch:** `master-brain/integrated-mvp`  
**Scope:** Read-only source review of the current MVP files and specifications. This document is an engineering assessment, not proof of runtime behavior.

## 1. Evidence and limits
Reviewed on this branch:
- `MASTER_BRAIN_INTEGRATED_ARCHITECTURE.md`
- `README_MASTER_BRAIN_MVP.md`
- `docs/META_INTELLIGENCE_LAYER_SPEC.md`
- `docs/CONTRADICTION_DRIVEN_PROOF_CHARTER.md`
- `src/master_brain/core.py`
- `src/master_brain/archipelago.py`
- `src/master_brain/meta_intelligence.py`
- `src/master_brain/ctp.py`
- `tests/test_core.py`, `tests/test_archipelago.py`, `tests/test_meta_intelligence.py`, `tests/test_ctp.py`

The source confirms a deterministic planning/validation scaffold. The review did not execute the suite, access the live Codespace, or validate provider calls, persistence, external retrieval, or production behavior. The original reported ~3,000-line implementation remains `INACCESSIBLE / RECOVERY PENDING`, not confirmed lost.

## 2. Current component maturity
| Component | Source-level finding | Evidence-based status |
|---|---|---|
| Core routing | Keyword-based route selection in `core.py` | IMPLEMENTED; test execution not verified in this audit |
| Archipelago planner | Selects general + keyword-matched islands and shared foundations | IMPLEMENTED; test execution not verified in this audit |
| Meta-Intelligence planner | Adds assumptions, unknowns, review level, verification steps, budget/deadline bounds | IMPLEMENTED as deterministic scaffold; not semantic AI |
| CTP | Defines rival hypotheses, falsifiers, discriminating tests and structural validation | IMPLEMENTED as planning/validation scaffold; does not run tests or establish truth |
| Evidence review | Summarizes support/counterevidence for a claim ID | PARTIAL; no full source-quality adjudication or persistent provenance graph |
| Opportunity scoring | Weighted, bounded illustrative score | PARTIAL; weights are uncalibrated and score is not a forecast |
| Provider/model adapters | No wired live providers shown in the reviewed README/source | NOT IMPLEMENTED in reviewed MVP |
| External evidence retrieval | No live retrieval shown in reviewed MVP | NOT IMPLEMENTED in reviewed MVP |
| Durable mission/evidence store | No database/persistence shown in reviewed MVP | NOT IMPLEMENTED in reviewed MVP |
| Audit/event log | Specified architecturally; no durable event store shown in reviewed MVP | SPEC ONLY / GAP |
| Dependency graph validation | Required by Meta-Intelligence specification; current `CoordinationPlan` does not expose task dependency edges | SPEC ONLY / GAP |
| Action gateway | Approval concepts exist; no external action execution is in scope | SPEC ONLY / GAP |
| Controlled repair/rollback | Described in architecture; no deployment pipeline shown in reviewed source | SPEC ONLY / GAP |
| Legacy ~3,000-line implementation | Not located in sources reviewed so far | INACCESSIBLE / RECOVERY PENDING |

## 3. Key architectural gaps
### G1 — Multiple overlapping routing/planning entry points
`core.route_task`, `archipelago.plan_mission`, and `meta_intelligence.plan_coordination` each implement overlapping parts of routing. They do not yet expose one canonical mission-plan contract. This creates risk of divergent rules and inconsistent capability-gap reporting.

**Required direction:** do not delete or merge them during recovery. First define a canonical typed contract and map each existing output to it; then write compatibility tests before any refactor.

### G2 — Mission identity and lifecycle are missing from the current plan contract
The Meta-Intelligence specification calls for stable mission/run IDs, task prerequisites, expected result schemas, audit events and plan status. The current `Mission` / `CoordinationPlan` records do not contain the full lifecycle contract.

**Required direction:** design a versioned contract for mission, task, assignment, status, dependency, result and audit event. Keep original objective text immutable and store normalized forms separately.

### G3 — Evidence provenance is too shallow for the stated proof standard
The core `Evidence` record has a source string, claim ID, support flag, timestamp, independence group and limitations, but lacks structured source URI/artifact hash, retrieval time, method, quote/span, source type, version, dependence edges and verification status.

**Required direction:** design provenance schema and migration mapping first. Do not silently reinterpret existing evidence fields.

### G4 — CTP validates case structure, not evidence truth
The CTP scaffold checks references and status consistency. It does not execute discriminating tests, verify attached evidence, determine source independence, or adjudicate which hypothesis is best supported.

**Required direction:** keep proposed tests distinct from executed test runs. An executed result must include run ID, procedure/version, timestamp, raw artifact references, outcome, limitations and reviewer. Never promote NOT_RUN to PASS.

### G5 — Risk gating is a planning signal, not an enforcement boundary
Risk tiers and human-gated review levels are represented in planning objects. A complete action gateway enforcing permissions at the point of execution is not shown in this MVP.

**Required direction:** no external side effects until a separate policy enforcement boundary exists and has negative tests for unauthorized actions.

### G6 — Opportunity score is illustrative only
The weighted score clamps inputs to [0,1] and uses fixed weights. No calibration data, sensitivity analysis, benchmark, or outcome feedback loop is shown.

**Required direction:** retain explicit component scores and uncertainty; label the aggregate illustrative until a domain-specific benchmark and calibration process exists.

### G7 — Capability registry does not yet represent the full requested archipelago
The current default profiles cover general reasoning, industrial, economics, accounting, research, software/AI, and security/risk. Other target islands (including blockchain engineering, digital economy, crypto markets/risk, betting-platform analysis, web/content and consumer technology) are scope/roadmap items, not confirmed implemented specialists.

**Required direction:** add islands only through explicit profiles/contracts and tests; do not claim a specialist was consulted when only a planner selected its ID.

### G8 — Verification state must be made visible
The source README says tests use synthetic fixtures and do not prove real-world performance. This audit did not run the tests; a status query for the inspected commit returned no status entries in the current response.

**Required direction:** rerun the complete test suite in a reproducible environment and retain the raw command output/CI run URL. Until then, label test execution as NOT VERIFIED IN THIS AUDIT.

## 4. Ordered work plan
### Phase 0 — Preserve-first recovery (blocking)
1. Keep `main` unchanged and do not reset/rebuild/revoke/delete or mutate the live workspace.
2. Preserve accessible source artifacts and compare duplicate/versioned documents by actual hashes and content.
3. When live access is permitted, create an external snapshot before inspecting or repairing the environment.
4. Inspect Git history, branches, tags, stash/reflog, ignored/untracked files and local workspace copies read-only.
5. Maintain an artifact register with provenance, hash, timestamp, dependencies, and recovery status.

### Phase 1 — Requirements traceability (safe documentation work)
1. Map each architecture/spec requirement to code, test, and evidence.
2. Record status as `VERIFIED_IMPLEMENTED`, `PARTIAL`, `SPEC_ONLY`, `NOT_TESTED`, `INACCESSIBLE`, or `NOT_FOUND_IN_REVIEWED_SOURCES`.
3. Track open contradictions between old artifacts and current specifications.
4. Do not deduplicate or overwrite source documents until differences are recorded.

### Phase 2 — Test verification
1. Run `PYTHONPATH=src python -m unittest discover -s tests -v` in a controlled environment.
2. Save full output, interpreter version, commit SHA and environment metadata.
3. Add tests for dependency cycles, missing prerequisites, risk-gate enforcement, multilingual routing, evidence dependence, and CTP state transitions only after preserving existing behavior.
4. Keep synthetic contract tests separate from live/domain benchmark results.

### Phase 3 — Canonical contract design (before refactor)
Define versioned schemas for:
- `Mission`, `Task`, `IslandProfile`, `Assignment`, `Dependency`
- `Claim`, `Evidence`, `SourceArtifact`, `Contradiction`, `DiscriminatingTest`, `TestRun`
- `Opportunity`, `Decision`, `Approval`, `AuditEvent`

Define stable IDs, timestamps, status enums, schema versions, provenance, resource limits, cancellation and serialization rules. Provide a mapping from every current data class before changing implementation.

### Phase 4 — Vertical slice after recovery and contract approval
Implement one deterministic end-to-end slice without live provider dependency:
intake → mission plan → multiple island assignments → evidence records → CTP proposal → explicit NOT_RUN state → independent rule-based review → decision with uncertainty → audit trace.

Only after this passes reproducible tests should provider adapters, retrieval, persistence, and optional action tools be added behind separate interfaces and policy gates.

## 5. Non-negotiable invariants
- Architecture A (broad intelligence/opportunity) and B (evidence/proof/engineering discipline) remain integrated.
- The original reported implementation is not declared lost without evidence.
- Planned/selected resources are not described as consulted/executed.
- A contradiction can weaken/refute a scoped claim; it does not prove its opposite.
- No detected contradiction is not proof.
- Model consensus is not independent corroboration.
- No secrets in logs, prompts, commits, or audit artifacts.
- No consequential external action without explicit policy authorization and required human approval.
- Every component carries its actual maturity status.
- No refactor or destructive environment action before preservation and recovery gates are satisfied.

## 6. Immediate next decision
The next safe engineering activity is **requirements traceability plus source recovery**, not adding live providers or rewriting the planner. The first code-changing milestone should be approved only after the original source inventory/snapshot gate and canonical contract mapping are complete.
