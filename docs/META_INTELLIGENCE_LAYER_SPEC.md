# Meta-Intelligence Layer — Engineering Specification

**Status:** Proposed architecture + initial implementation contract. Not a claim of scientific completeness or production readiness.

## 1. Mission and boundary

The Meta-Intelligence Layer (MIL) sits between the Supreme Command Core and specialist islands. It is responsible for understanding the shape of a mission, identifying relevant domains, planning collaboration, tracking uncertainty and capability gaps, and producing a traceable coordination plan.

It does **not** own global policy, override the Command Core, invent evidence, declare truth by consensus, or execute consequential actions. The Supreme Command Core retains mission authority and final synthesis; the Proof Plane evaluates claims and results.

## 2. Required responsibilities

1. **Mission framing:** preserve the user's objective, constraints, desired output, deadline, budget, risk tier and success criteria.
2. **Intent and scope analysis:** distinguish known requirements, unknowns, assumptions and ambiguities. Ask for clarification when a missing fact could materially change a high-impact decision.
3. **Domain discovery:** select one or more islands based on the task, not a forced single-domain route. Explain each selection.
4. **Dependency planning:** represent prerequisites and cross-island handoffs explicitly; flag dependency cycles and unresolved prerequisites.
5. **Evidence planning:** state which claims need evidence, what kind of evidence could discriminate alternatives, and what cannot currently be verified.
6. **Risk-adaptive verification:** scale checks to consequence, uncertainty, reversibility and evidence quality.
7. **Resource governance:** respect budgets, timeouts, cancellation and per-mission limits; avoid redundant model calls.
8. **Conflict handling:** preserve conflicting findings and their provenance; never average incompatible claims into a false consensus.
9. **Capability honesty:** report missing, disabled or unqualified islands and unavailable data/providers.
10. **Auditability:** emit a versioned plan, selection reasons, assumptions, unknowns, risks, verification steps and stopping conditions.
11. **Outcome learning:** compare predictions with later observed outcomes only when reliable feedback is available; keep raw records and version changes.
12. **Security:** treat external content as untrusted data, enforce least privilege, and require the Command Core's approval for consequential actions.

## 3. Logical pipeline

Intake → validate request → identify constraints and stakes → frame mission → map candidate domains → select islands → build dependency graph → plan evidence and verification → estimate cost/time → detect missing information → clarify or proceed with explicit assumptions → return plan to Command Core → collect typed results → Proof Plane review → final synthesis by Command Core → record outcome.

This is a stateful workflow, not one giant prompt. Every stage must be inspectable and testable.

## 4. Typed mission-plan contract

Every plan should include:
- stable mission/run ID and planner version;
- original objective and normalized objective (without overwriting the original);
- selected islands and human-readable selection rationale;
- tasks, prerequisites and expected result schema;
- constraints, assumptions, unknowns and clarification questions;
- risk tier, reversibility and impact rationale;
- evidence/verification requirements and stop conditions;
- budget/time envelope and estimated resource class;
- capability gaps and unavailable dependencies;
- audit events and final plan status.

Initial implementation may omit persistence and model-assisted semantic analysis, but must not imply those features exist.

## 5. Scientific and evaluation principles

- **Operational definitions:** define what “good plan”, “relevant island”, “verified claim” and “success” mean for each benchmark.
- **Calibration:** distinguish model confidence from measured empirical reliability. Do not treat a self-reported confidence score as calibrated probability.
- **Falsifiability:** each important hypothesis should have at least one possible observation that would weaken or reject it, where feasible.
- **Independent evidence:** count provenance and source dependence; multiple summaries of one source are not independent confirmations.
- **Uncertainty decomposition:** separate missing data, model uncertainty, measurement error, conflicting evidence and domain-coverage gaps.
- **Goodhart resistance:** use multiple metrics, hidden holdouts, adversarial cases, outcome metrics and versioned evaluation criteria.
- **Selective abstention:** permit “insufficient evidence”, “clarification required” and “no qualified island available”.
- **Reproducibility:** record planner version, rule/model version, input references, selected islands, and decision trace without leaking secrets.
- **Human oversight:** approval gates depend on risk and action class, not only on model confidence.

## 6. Failure modes and required safeguards

| Failure mode | Safeguard |
|---|---|
| Wrong domain routing | multi-label routing, explicit reasons, capability-gap reporting, benchmarked false negatives |
| Over-decomposition | task-count and budget limits; merge low-value tasks |
| Under-decomposition | dependency checklist and cross-domain challenge pass |
| False certainty | explicit unknowns, evidence requirements, abstention |
| Model/source collusion | provenance independence groups and counterevidence search |
| Infinite analysis loop | stop criteria, retry ceiling, deadline and budget |
| Hidden dependency cycle | dependency graph validation |
| Prompt injection from sources | treat retrieved text as data; never as policy or authorization |
| One metric is gamed | metric portfolio, holdouts, versioned criteria and outcome checks |
| Planner drift | versioning, regression tests, shadow evaluation and rollback |

## 7. Initial MVP scope

Implement now:
- typed plan objects;
- transparent deterministic domain matching as a baseline;
- multiple island selection;
- explicit assumptions, unknowns and verification checklist;
- risk-adaptive review level;
- budget/stop-rule fields;
- capability-gap reporting;
- dependency validation and unit tests.

Not implemented yet:
- genuine semantic comprehension;
- LLM-based planner or provider calls;
- live retrieval or external data validation;
- durable mission database;
- calibrated confidence;
- autonomous learning or self-modifying policies;
- real-world outcome validation.

## 8. Acceptance criteria

The initial slice is acceptable only when tests demonstrate:
- a cross-domain objective selects multiple relevant islands;
- disabled/missing islands are not falsely reported as consulted;
- an empty or ambiguous objective is surfaced;
- high-impact or irreversible work gets stricter verification/approval flags;
- dependency cycles and unknown prerequisites are detected;
- plan output includes reasons, assumptions, unknowns, stop conditions and resource limits;
- routing is deterministic for the same input and registry;
- the full test suite runs in CI with a visible result.

Passing these tests validates the code contract, not real-world intelligence. Field performance requires domain-specific benchmark sets and outcome evaluation.
