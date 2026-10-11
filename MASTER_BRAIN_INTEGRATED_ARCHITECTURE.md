# Master Brain — Integrated Architecture (A + B)
**Status:** Design baseline for an incremental MVP. This is a specification, not a claim that a production system exists.

## Architectural decision
A and B are merged into one system, not two adjacent products:
- **A — intelligence / opportunity:** multi-model reasoning, research planning, opportunity generation and ranking, adaptive tool/model routing.
- **B — proof / engineering discipline:** evidence provenance, contradiction detection, independent evaluation, security policy, traceability, budget limits, reproducible tests, rollback and controlled repair.

Every decision-producing workflow uses both planes. The Intelligence Plane proposes; the Proof Plane tests, challenges and qualifies. Neither model consensus nor fluent writing counts as ground truth.

## Core loop
Intake → Clarify objective and constraints → Plan research/actions → Gather evidence → Generate hypotheses/options → Challenge contradictions → Evaluate proof/risk/value → Recommend → Obtain approval when needed → Execute permitted action → Verify real outcome → Record learning.

## Core components
1. **Goal & Policy Registry:** objective, constraints, success criteria, budget, risk tier, permissions.
2. **Orchestrator:** state machine, task decomposition, routing, retries, timeouts and cancellation.
3. **Provider Adapters:** common interface for model providers; providers are optional and replaceable.
4. **Research & Evidence Engine:** source records, claim-level support, timestamps, provenance, independence, confidence and counterevidence.
5. **Contradiction-to-Proof (CTP):** normalize claims; check same subject/context/time/definitions; generate rival hypotheses and falsifiers; select discriminating tests; preserve unresolved cases.
6. **Opportunity Engine:** generate and rank options by expected value, feasibility, time-to-value, downside, reversibility, uncertainty and evidence quality.
7. **Proof Plane / Evaluator:** independent checks, deterministic rules, tests, benchmarks, red-team cases and reality outcomes.
8. **Memory & Knowledge Store:** separate transient session state, project knowledge and user-approved durable memory; preserve raw artifacts and version interpretations.
9. **Action Gateway:** least privilege; read-only by default; explicit approval for external, destructive, financial, public or irreversible actions.
10. **Observability & Audit:** traces, costs, source links, decisions, errors, failed hypotheses and recovery attempts with secret redaction.
11. **Controlled Repair:** propose patch → isolated test → regression suite → compare baseline → optional canary → approval → rollback-ready release.
12. **Interface:** one user-facing coordinator; specialists remain internal and report through a consistent contract.

## Trust and safety invariants
- Never expose secrets in logs, prompts or repository.
- Never execute consequential actions without policy authorization and any required user approval.
- Keep claims, evidence, inference and recommendations distinguishable.
- Preserve negative evidence and invalid test runs; do not silently delete failed outcomes.
- A source's accessibility, credibility and independence are separate attributes.
- Model agreement is not independent corroboration unless the underlying evidence is independent.
- Unknown/unavailable is a valid result; do not fabricate missing sources or test results.
- Lab PASS + Reality FAIL = final FAIL.
- No direct implementation commits to `main`; work in feature branches.
- Do not overwrite historical architecture documents. Reconcile by explicit requirement mapping.

## MVP scope (first vertical slice)
1. Typed task/claim/evidence/decision records.
2. Deterministic policy and routing, no learned routing initially.
3. Evidence-linked claim review and conservative contradiction flags.
4. Opportunity scoring with explicit weighted criteria and uncertainty.
5. Unit tests with synthetic fixtures; clearly label these as fixture tests.
6. No external side effects; read-only, no live provider dependency in unit tests.

## Maturity labels
PROPOSED → SPECIFIED → IMPLEMENTED → TESTED → INDEPENDENTLY_VALIDATED → PRODUCTION_VERIFIED.
Each component must carry its actual status. Passing fixture tests only supports TESTED against those fixtures.

## Delivery sequence
Phase 0: map legacy requirements and preserve source artifacts.
Phase 1: implement deterministic domain core and tests (this branch).
Phase 2: add persistent store and audit schema.
Phase 3: add provider adapters and evidence retrieval.
Phase 4: add independent evaluation/CTP benchmarks and adversarial tests.
Phase 5: add optional action tools behind policy/approval gates.
Phase 6: deployment, monitoring, rollback and real-world outcome verification.

## Open questions that must remain explicit
- Which historical code/artifacts can be recovered?
- What data store and deployment target are available and affordable?
- Which providers are legally/technically accessible, at what cost and under which rate limits?
- What constitutes independent ground truth for each task family?
- Which action classes may ever be automated, and which always require approval?

## Source relationship
This integrated design combines the earlier broad Master Brain / Opportunity Engine requirements with the newer implementation-safety baseline. It does not replace either source and does not imply recovery of the historical ~3,000-line implementation.


## Archipelago architecture (accepted direction, implementation staged)
Master Brain is a growing archipelago, not a flat list of agents. The architecture has four logical levels:

1. **Supreme Command Core** — owns the user objective, global priorities, policy boundaries, budgets, final synthesis and escalation. It does not need to perform every specialist task itself.
2. **Meta-Intelligence / Strategic Coordination Layer** — interprets the problem across domains, discovers which islands are relevant, decomposes the mission, selects collaborators, detects missing expertise and coordinates cross-island dependencies. This is the layer between command and specialists.
3. **Specialist Islands** — independently versioned domain modules (general reasoning, industrial engineering, economics/markets, accounting/finance, science/research, software/AI, security/risk, and future domains). Islands expose a common contract and may be added without rewriting the command core.
4. **Shared foundations** — Intelligence Plane, Proof Plane, memory/evidence provenance, policy/security, audit, budgets and evaluation. These are shared services/capabilities, not duplicated independently inside every island.

### Coordination rules
- One mission may involve multiple islands; the coordinator must not force a single-domain route when cross-domain dependencies are apparent.
- Domain discovery is open-ended: the registry can grow. "Everything in the universe" is a long-term extensibility goal, not a claim that all knowledge domains are prebuilt or perfectly covered.
- The command core retains final responsibility for the synthesized response and policy enforcement; specialists cannot grant themselves extra permissions.
- Islands exchange typed task briefs and evidence-linked results, not unstructured hidden state.
- The coordinator must record why each island was selected, what it contributed, its limitations, and unresolved cross-domain conflicts.
- A missing island is reported as a capability gap; the system must not pretend that a nonexistent specialist was consulted.
- Initial domain routing is deterministic and testable. Learned/LLM-assisted routing may be added later behind evaluation and cost controls.
- The architecture is logical first. MVP modules do not need to run as separate servers/processes; split deployment only when justified by reliability, scaling or security.

### First implementation slice
The first executable slice introduces a domain registry, an explicit mission plan, multi-island selection and traceable selection rationales. It does not yet invoke real LLM providers or claim specialist-level expertise. The initial rules are a baseline to be tested and improved.
