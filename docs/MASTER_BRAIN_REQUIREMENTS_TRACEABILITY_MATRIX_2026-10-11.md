# Master Brain — Requirements Traceability Matrix
**Date:** 2026-10-11  
**Branch:** `master-brain/integrated-mvp`  
**Purpose:** Map architectural requirements to reviewed source and tests before implementation changes.

## Status vocabulary
- `IMPLEMENTED_SCAFFOLD`: relevant deterministic code exists, but does not imply production behavior.
- `PARTIAL`: some requirement exists; important contract or behavior is missing.
- `SPEC_ONLY`: requirement is documented but no corresponding implementation was found in the reviewed MVP files.
- `NOT_VERIFIED`: test/runtime evidence has not been independently executed in this audit.
- `RECOVERY_PENDING`: historical source or live environment is not yet accessible.

## Traceability matrix

| ID | Requirement | Source/spec anchor | Existing test anchor | Assessment | Gap / acceptance evidence |
|---|---|---|---|---|---|
| MB-ARCH-001 | Integrate intelligence/opportunity (A) with proof/engineering discipline (B) | `MASTER_BRAIN_INTEGRATED_ARCHITECTURE.md`; `README_MASTER_BRAIN_MVP.md` | Cross-module tests | IMPLEMENTED_SCAFFOLD | Demonstrate a single end-to-end mission where opportunity proposals are reviewed by the proof plane and limitations remain visible. |
| MB-CORE-001 | Route tasks deterministically and flag high-risk/external actions for approval | `src/master_brain/core.py::route_task` | `tests/test_core.py::RoutingTests` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | Execute full suite; add negative tests for every risk tier and external-action combination. This flag is not yet an action-enforcement gateway. |
| MB-CORE-002 | Detect potential contradiction only when claim scopes match | `src/master_brain/core.py::assess_contradictions` | `tests/test_core.py::ContradictionTests` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | Add unit conversion, missing-context, definition drift, source provenance and temporal edge cases. Flagging is not adjudication. |
| MB-CORE-003 | Preserve supporting evidence and counterevidence; no evidence stays unverified | `src/master_brain/core.py::evaluate_claim` | `tests/test_core.py::EvidenceTests` | PARTIAL; NOT_VERIFIED | Expand source identity, artifact hashes, retrieval method/time, spans, dependence links and verification status. |
| MB-CORE-004 | Opportunity scoring must be transparent and bounded | `src/master_brain/core.py::score_opportunity` | `tests/test_core.py::OpportunityTests` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | Current score is illustrative and weights are uncalibrated. Require documented scale, sensitivity tests and domain benchmark before using as a forecast. |
| MB-ARCHI-001 | Plan missions across multiple specialist islands and shared foundations | `src/master_brain/archipelago.py::plan_mission` | `tests/test_archipelago.py` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | Keyword-based matching may miss implied/multilingual intent. Test dependency gaps and island registry versioning. |
| MB-META-001 | Preserve original objective, expose unknowns, questions, risk-based review, budget and deadline | `src/master_brain/meta_intelligence.py::Mission`, `CoordinationPlan` | `tests/test_meta_intelligence.py` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | The typed plan lacks stable mission/run IDs, dependency edges, expected result schemas, explicit lifecycle status and persisted audit events. |
| MB-META-002 | Plan prerequisites and dependencies, detect cycles, specify handoffs and stop conditions | `docs/META_INTELLIGENCE_LAYER_SPEC.md` | No dedicated test identified in reviewed test files | SPEC_ONLY / GAP | Add typed task/dependency graph, cycle detection, missing-prerequisite tests and explicit handoff contracts. |
| MB-META-003 | Report selected islands honestly; selection does not mean execution | `src/master_brain/meta_intelligence.py::plan_coordination`; `README_MASTER_BRAIN_MVP.md` | `tests/test_meta_intelligence.py` | IMPLEMENTED_SCAFFOLD | Preserve this invariant in result schemas and user-facing synthesis; later provider runs must record actual execution status. |
| MB-CTP-001 | Represent rival hypotheses, falsifiers and discriminating tests | `src/master_brain/ctp.py` | `tests/test_ctp.py::CTPCaseTests` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | CTP currently validates structure; it does not run tests or decide which hypothesis is true. |
| MB-CTP-002 | A NOT_RUN test cannot claim an observed result/evidence; PASS/FAIL requires result | `src/master_brain/ctp.py::CTPCase.validate` | `tests/test_ctp.py` | IMPLEMENTED_SCAFFOLD; NOT_VERIFIED | Add evidence artifact validation, reviewer identity, procedure version, timestamps, run IDs and invalidation handling. |
| MB-CTP-003 | Seek counterevidence; no contradiction found is not proof; preserve unresolved conflicts | `docs/CONTRADICTION_DRIVEN_PROOF_CHARTER.md` | Partial coverage in `tests/test_core.py` and `tests/test_ctp.py` | PARTIAL | Create benchmark cases with known ground truth and adversarial near-conflicts; measure false positives/negatives and appropriate abstention. |
| MB-ROUTER-001 | Route work to suitable model/provider based on capability, evidence needs, privacy, latency and cost | Architecture and CTP charter | No provider adapter tests identified | SPEC_ONLY / GAP | Define adapter interface and routing policy; do not connect providers until contracts, secrets handling and budget controls are reviewed. |
| MB-EVID-001 | Retrieve external evidence and maintain claim-level provenance | Architecture / proof charter | No live retrieval tests identified | SPEC_ONLY / GAP | Define source/artifact record and retrieval interface; preserve URL, timestamp, hash, method, excerpt/span, independence and limitations. |
| MB-MEM-001 | Persist mission state, evidence, decisions and audit events | Architecture / Meta-Intelligence spec | No persistence tests identified | SPEC_ONLY / GAP | Choose storage contract only after recovery; specify retention, migration, export, corruption recovery and secret redaction. |
| MB-SEC-001 | Enforce least privilege and human approval at the point of consequential action | Architecture and Meta-Intelligence spec | Planner-level tests only | SPEC_ONLY / GAP | Add an action gateway with deny-by-default policy and tests proving unauthorized operations cannot execute. A planner flag alone is insufficient. |
| MB-AUDIT-001 | Record decisions, resource selections, costs, errors and unresolved hypotheses without secrets | Architecture and Meta-Intelligence spec | No durable audit tests identified | SPEC_ONLY / GAP | Define versioned append-only audit event schema and redaction tests. |
| MB-REPAIR-001 | Controlled repair: patch, isolated tests, baseline comparison, approval and rollback | Architecture | No deployment/rollback tests identified | SPEC_ONLY / GAP | Keep out of MVP execution until recovery, isolation and rollback gates exist. |
| MB-ISLAND-001 | Support all requested specialist domains, including blockchain, crypto, digital economy, web/content and consumer technology | Scope documents and target architecture | Current default registries cover a smaller set | PARTIAL / ROADMAP | Add profiles/contracts and tests incrementally. Never claim a specialist performed work just because its name is in scope. |
| MB-LEGACY-001 | Recover and compare historical ~3,000-line implementation before replacing behavior | `docs/LEGACY_RECOVERY_AUDIT_2026-10-11.md` | Not a normal unit-test requirement | RECOVERY_PENDING | Snapshot first; inspect history, branches, tags, stash/reflog, ignored/untracked files, workspace artifacts and export. Absence from reviewed sources is not proof of loss. |
| MB-LIVE-001 | Prove end-to-end behavior in the actual running environment | README explicitly disclaims real-world proof from fixtures | No live run verified in this audit | NOT_VERIFIED | Requires authorized environment access, reproducible run logs, artifact references and independent review. Do not infer from CI or unit tests. |

## Current safe test command
From repository root in a controlled environment:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```

Capture the full stdout/stderr, Python version, commit SHA and environment metadata. This command has not been executed as part of this read-only source review.

## Proposed next engineering sequence
1. **Recovery gate:** preserve all accessible source and environment artifacts before any refactor.
2. **Test evidence gate:** execute the existing suite and retain raw results.
3. **Contract design:** define versioned canonical schemas for Mission, Task, Dependency, Assignment, Claim, Evidence, SourceArtifact, Contradiction, DiscriminatingTest, TestRun, Decision, Approval and AuditEvent.
4. **Compatibility gate:** map every current dataclass/function to the canonical schema and add compatibility tests before refactoring.
5. **Vertical slice:** demonstrate intake → plan → island assignments → evidence records → CTP proposal marked NOT_RUN → independent review → qualified decision → audit record.
6. **Only then:** add external retrieval, model adapters, durable storage and policy-gated actions.

## Non-negotiable invariants
- Architecture A and B stay integrated.
- Planning, selection, execution and verification are separate statuses.
- A contradiction may refute a scoped claim; it does not prove the opposite.
- No contradiction found is not proof.
- Model consensus is not independent corroboration without independent evidence.
- Unknown, inaccessible and not tested remain explicit states.
- No destructive or live-environment changes before backup and authorization.
