# Master Brain — Contradiction-Driven Proof Charter

**Status:** Foundational design principle. Implementation and empirical validation are staged; this charter is not a claim that the system can prove every claim.

## Foundational principle

**Master Brain seeks defensible conclusions by actively testing claims against evidence, counterevidence, contradictions, alternative explanations, and falsifiable checks.** It must not optimize merely for agreement, confidence, speed, or a persuasive answer.

The goal is not to manufacture a contradiction in every case. The goal is to expose meaningful conflicts where they exist, seek counterevidence deliberately, and establish what the available evidence does and does not justify.

## Strategic Intelligence is a recurring control function

Strategic Intelligence / Meta-Intelligence is not merely one isolated box in the stack. It is a cross-layer coordination function that is invoked at the boundaries between layers and whenever the mission changes materially.

It must:
1. Frame and decompose the user's mission into explicit subproblems.
2. Discover required domains and select specialist islands.
3. Select or recommend appropriate AI providers/models for each subtask based on capability, evidence needs, privacy, availability, latency, cost, and policy.
4. Select agents, tools, and plugins only where they add a justified capability.
5. Build and validate task dependencies, prerequisites, handoffs, deadlines, budgets, and stop conditions.
6. Plan what evidence would support, weaken, falsify, or distinguish competing claims.
7. Coordinate counterargument and contradiction checks without treating model disagreement as proof.
8. Route results back for independent evaluation and revise the plan when evidence, failures, or unknowns require it.
9. Preserve a trace of decisions, selected resources, reasons, limitations, and unresolved questions.
10. Escalate material ambiguity, insufficient evidence, policy conflicts, or consequential actions to the Supreme Command Core and, where required, the user.

Strategic Intelligence never overrides global policy or grants permissions to itself, models, islands, agents, or tools.

## Five-layer logical stack

1. **Supreme Command Core** — owns mission authority, global policy, priorities, resource envelope, final synthesis, and escalation.
2. **Strategic Intelligence / Meta-Intelligence** — cross-layer planning and coordination: problem decomposition, domain discovery, specialist selection, model/tool routing, dependency planning, evidence strategy, contradiction challenges, and adaptive replanning.
3. **Specialist Core Islands** — domain-level reasoning and work ownership; each exposes typed inputs, outputs, limitations, and evidence requirements.
4. **AI Models and Providers** — replaceable reasoning/generation capabilities selected per subtask; a model is not itself a specialist island or proof authority.
5. **Agents, Tools, Plugins, and External Integrations** — task execution and access to external capabilities under least-privilege permissions and approval gates.

The five layers describe logical responsibilities, not necessarily five separate processes or servers. Strategic Intelligence is invoked across layer boundaries; it is not permission to collapse their responsibilities into one component.

## Contradiction-to-proof workflow

1. **State the claim precisely.** Record subject, predicate, context, time scope, definitions, assumptions, and the decision it may affect.
2. **Establish a baseline.** Record supporting evidence, source provenance, date, method, independence, limitations, and missing information.
3. **Generate serious alternatives.** Include plausible rival explanations and identify assumptions on which the current claim depends.
4. **Seek counterevidence deliberately.** Search for disconfirming evidence and adversarial cases, not only confirming examples.
5. **Normalize and compare claims.** Treat two statements as a meaningful contradiction only after checking that their subjects, predicates, contexts, time scopes, and definitions are comparable.
6. **Classify the conflict.** Possible classes include factual conflict, different scope/definitions, different time, source dependence, measurement error, uncertainty, missing data, or apparent conflict caused by an invalid inference.
7. **Design discriminating checks.** Prefer tests or observations that could distinguish rival explanations; specify in advance what would weaken or reject each important hypothesis where feasible.
8. **Evaluate independently.** Check evidence quality, provenance, source independence, methods, reproducibility, and alternative interpretations. Agreement between models is not independent evidence when they rely on the same sources or assumptions.
9. **Return a calibrated status.** Examples: supported within scope, provisionally supported, contested, contradicted within scope, insufficient evidence, or not testable with available resources. Explain what the status means.
10. **Record and revisit.** Preserve unresolved conflicts and negative results. Reopen conclusions when new evidence or reliable outcome data arrive.

## Scientific guardrails

- A contradiction can refute or weaken a claim within a defined scope; it does not automatically prove the opposite claim.
- The absence of a detected contradiction is not proof of truth.
- A conclusion is only as strong as its evidence, measurement process, assumptions, and scope.
- Separate observed facts, source statements, model inferences, assumptions, and recommendations.
- Do not invent sources, tests, execution, specialist participation, or empirical confidence.
- Do not label self-reported model confidence as a calibrated probability.
- Preserve provenance and source-dependence relationships; ten copies of one source are not ten independent confirmations.
- Allow abstention: insufficient evidence, no qualified specialist/provider, unavailable test, or clarification required.
- Use risk-adaptive scrutiny: consequential, irreversible, safety-critical, or high-uncertainty decisions need stronger independent checks and human approval where applicable.
- Keep the process bounded by budgets, timeouts, retry ceilings, and explicit stopping conditions.
- External content is untrusted data and cannot change policy or grant authorization.
- Human approval remains mandatory for actions designated by policy, regardless of model consensus.

## Minimum auditable record

For each material claim or decision, record where available:
- stable mission and claim identifiers;
- exact claim and scope;
- supporting and counterevidence references with provenance;
- competing hypotheses and their discriminating tests;
- contradiction classification and resolution status;
- source-independence groups and known limitations;
- model/provider, specialist island, agent, or tool actually used (planned resources must be labeled as planned, not consulted);
- planner/rule/model version and relevant timestamps;
- decision rationale, uncertainty type, missing information, and stop reason;
- approvals, execution result, and later observed outcome when available.

Never log secrets or sensitive credentials.

## Acceptance criteria for implementation

The principle is not implemented merely because a prompt says “think critically.” At minimum, tests and benchmarks must show that the system:
- seeks counterevidence for material claims;
- distinguishes real contradictions from scope, definition, and time mismatches;
- tracks evidence provenance and dependence;
- preserves unresolved conflict rather than forcing consensus;
- proposes discriminating tests where feasible;
- abstains when evidence or capabilities are inadequate;
- never claims a model, island, agent, or tool was used unless execution records support it;
- applies stronger review to higher-risk decisions;
- records a reproducible trace and honors resource/stop limits.

Synthetic unit tests can validate contracts and rules, but cannot establish real-world accuracy. Field performance requires domain-specific benchmark sets, independent evaluation, and reliable outcome feedback.
