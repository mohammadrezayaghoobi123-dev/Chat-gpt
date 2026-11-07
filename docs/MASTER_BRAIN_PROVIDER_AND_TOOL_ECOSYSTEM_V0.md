# Master Brain — Provider and Tool Ecosystem Strategy V0

**Status:** Proposed design contract; not evidence that integrations exist.
**Branch:** `master-brain/proof-protocol-v0`
**Purpose:** Prevent the architecture from collapsing into a small, fixed set of models or apps while keeping integrations testable, secure, replaceable, and cost-aware.

## 1. Decision

Master Brain will be **capability-first, provider-neutral, and integration-open**.

- No single model, vendor, agent framework, connector, or tool is the system's permanent brain.
- The Supreme Command Core owns objectives, policy, budgets, final synthesis, and escalation.
- Meta-Intelligence chooses the required capabilities and delegates only to registered, available integrations.
- Intelligence Plane proposes; Proof Plane checks claims, evidence, counterevidence, and outcomes.
- An integration is considered *available* only after a health/capability check; *selected* does not mean *called*; *called* does not mean *successful*; *successful* does not mean *verified*.
- The registry is extensible. New providers/tools should be addable through an adapter and contract tests, without rewriting domain logic.
- This is a design direction, not a claim that all providers or tools have been connected.

## 2. Separate the three catalogs

Do not mix models, tools, and specialist domains into one flat list.

### A. Model/provider catalog
Describes inference and multimodal capabilities: text reasoning, coding, vision, audio, long-context, structured output, tool calling, embeddings, and local inference.

Examples of candidate ecosystems to evaluate—not a mandated or exhaustive list—include OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral, Cohere, Azure-hosted models, AWS Bedrock, Vertex AI, OpenRouter, and locally hosted open-weight models. Availability, model names, geographic access, data terms, prices, and capabilities must be checked at integration time.

### B. Tool/service catalog
Describes operations that models may request or the orchestrator may call: web search, scientific literature, document retrieval, code repositories, test runners, databases, spreadsheets, accounting, inventory, design, communication, calendar, file storage, analytics, deployment, and industrial calculations.

Examples of integration mechanisms include direct vendor APIs, existing first-party/third-party connectors, MCP-compatible tools, and narrowly scoped internal adapters. A protocol is not a security review: every server still requires provenance, permission review, and input/output validation.

### C. Specialist-island catalog
Describes *expertise and review responsibilities*, not a particular model or app. For example, industrial engineering may use a language model, supplier documents, engineering calculations, and a spreadsheet tool in the same mission. The island remains accountable for the quality and limitations of its result even when its underlying provider changes.

## 3. Canonical integration contract

Every registered model or tool must expose a versioned capability record with at least:

- stable integration ID and version;
- integration type: model, retrieval tool, action tool, data source, evaluator, or agent;
- capabilities and supported input/output schemas;
- supported languages, modalities, context/output limits, and structured-output/tool-call support where relevant;
- availability/health state and last checked time;
- latency and rate-limit information where known;
- price/cost model and per-mission budget constraints where known;
- data handling, retention, region, and training-use terms where known;
- required permissions/scopes and action risk class;
- source/provenance and integration owner;
- timeout, retry, idempotency, cancellation, and failure behavior;
- test status, benchmark evidence, known limitations, and last validation date.

Unknown fields remain **unknown**. They must not be silently filled with assumptions.

## 4. Routing policy: select by capability, not brand

For each mission, derive a capability requirement before selecting an integration. Evaluate eligible candidates against:

1. task fit and output-contract compatibility;
2. evidence quality and independent verification options;
3. security, privacy, and data residency constraints;
4. current availability and reliability;
5. latency and deadline;
6. total cost, including retries, retrieval, storage, and review;
7. provider diversity where it meaningfully reduces correlated failure;
8. reversibility and failure recovery.

Routing should return the candidates considered, exclusion reasons, selected route, estimated cost/latency, policy decision, and uncertainty. Initially, use deterministic and inspectable rules. LLM-assisted routing may be introduced only behind evaluation, cost limits, and a deterministic fallback.

Do not assume the most expensive or largest model is always best. Do not assume two models are independent reviewers merely because they come from different vendors. Record shared sources, shared tools, and known correlation risks where possible.

## 5. Model diversity and independent review

Use different models when there is a specific reason: complementary capability, adversarial critique, alternative reasoning, or a genuinely separate evaluation path. Avoid sending every task to every model by default.

For consequential claims:
- preserve the original claim and its scope;
- generate rival hypotheses and explicit falsifiers;
- search for counterevidence, not only confirmation;
- identify whether reviewers rely on the same source material;
- run discriminating tests when feasible;
- label outcomes as rejected, disputed, provisionally supported, or unknown;
- never equate model agreement with truth or independent evidence.

A deterministic rule, reproducible calculation, primary source, instrument result, or real-world outcome may be more probative than another model response.

## 6. Tool and action risk tiers

- **T0 — Public/read-only:** public documentation and public search. Validate sources and content; treat retrieved text as untrusted data.
- **T1 — Private/read-only:** user's connected files, repositories, analytics, and business records. Require identity, object-level authorization, and minimum necessary access.
- **T2 — Reversible write:** create a draft, branch, report, or non-public artifact. Require scoped permissions, audit, and a recovery path.
- **T3 — External/consequential:** send messages, publish, deploy, change production data, make purchases, or affect finances. Require explicit policy checks and the appropriate user approval bound to the exact action payload.
- **T4 — Destructive/irreversible/high impact:** delete critical data, transfer funds, revoke access, or perform similarly consequential operations. Default deny; require strong re-authentication, explicit confirmation, independent validation, and recovery planning where possible. Some actions may remain permanently human-only.

A model must never grant itself permissions. Approval must be enforced by the trusted server at dispatch time, not merely displayed in the client or written into a plan.

## 7. Interoperability strategy

- Prefer narrow, typed adapter interfaces over vendor-specific logic inside the domain core.
- Evaluate MCP as an agent-to-tool integration option; validate server identity, authentication, tool schemas, scopes, and outputs before enabling it.
- Evaluate A2A only when cross-agent delegation has a concrete need; it is not a replacement for the internal mission contract, policy gate, or audit trail.
- Keep direct API adapters available where they provide better control, reliability, or security than a generic protocol.
- Pin and test protocol/SDK versions; document migrations and deprecations.
- Do not install or enable every connector by default. Discover broadly, evaluate, then enable the minimum set needed for each mission.

## 8. Failure handling and fallbacks

Every integration call must have a bounded timeout, a budget ceiling, structured errors, and a trace/correlation ID. Retries must be bounded and used only when safe. Side-effecting calls require idempotency or explicit duplicate-risk handling.

Fallback order should be policy-driven, for example:
1. retry a transient read-only request within budget;
2. use an equivalent approved provider/tool;
3. downgrade to a cheaper or local option if its capability is adequate;
4. return partial results with the missing capability and uncertainty stated;
5. stop and ask for direction when the failure changes the risk or conclusion.

Never silently switch to a provider with weaker privacy terms or broader permissions. Never fabricate a successful call when a connector is unavailable.

## 9. Integration lifecycle and maturity

Use explicit states:

`DISCOVERED → REVIEWED → CONTRACT_TESTED → SECURITY_REVIEWED → ENABLED → MONITORED`

Any state can transition to `SUSPENDED` or `RETIRED`. Only enabled integrations are eligible for dispatch. A change to permissions, endpoint, schema, SDK, data terms, or provider behavior may require re-review.

Record maturity per integration:
`PROPOSED`, `SPECIFIED`, `IMPLEMENTED`, `TESTED`, `INDEPENDENTLY_VALIDATED`, `PRODUCTION_VERIFIED`.

Do not promote maturity based on documentation alone. Preserve raw test results, benchmark versions, environment details, and failure cases.

## 10. Implementation order

1. Define the typed capability/adapter contract and fake adapters; test routing without network access.
2. Build a registry with explicit capability, permission, health, cost, and maturity fields.
3. Add one read-only model adapter and one read-only retrieval/tool adapter as a vertical slice.
4. Add traceable routing, bounded budgets, structured failures, and fallback tests.
5. Add a second provider only where it tests portability or adds measurable capability.
6. Add independent evaluation and correlation-aware evidence review.
7. Add private data connectors only after object-level authorization and secret handling are tested.
8. Add write/action tools last, behind server-side policy enforcement and approval checks.
9. Expand the catalog from measured user needs, not from a goal of maximizing the number of integrations.

## 11. Acceptance tests before any real integration is trusted

- A missing or unhealthy provider is never reported as consulted.
- An unsupported capability excludes a provider with a recorded reason.
- Budget, timeout, and retry limits are enforced.
- Secrets do not appear in prompts, logs, error traces, or artifacts.
- Tool outputs are schema-validated and treated as untrusted input.
- Cross-user/private-object access is denied.
- Stale or mismatched approvals cannot authorize a changed action payload.
- Duplicate retries cannot cause duplicate consequential side effects.
- Provider failure produces a truthful partial result or a stop, not fabricated evidence.
- The same mission can use a replacement provider without changing domain contracts.
- A model's self-reported confidence never substitutes for external evidence or a test result.

## 12. Current implementation boundary

The reviewed MVP currently contains deterministic routing/planning scaffolds and a proof/evidence design. The README and source reviewed for this branch do not show live model-provider adapters, live external evidence retrieval, or a production action gateway. These remain implementation gaps; this document does not imply they exist.

## 13. Design references

- OpenAI tool/MCP integration documentation: https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Anthropic MCP overview: https://docs.anthropic.com/en/docs/mcp
- Google Gemini function calling and remote MCP documentation: https://ai.google.dev/gemini-api/docs/function-calling
- A2A protocol overview: https://a2a-protocol.org/latest/

These references establish available integration approaches, not that any provider or protocol is automatically appropriate, safe, available, or enabled for Master Brain.
