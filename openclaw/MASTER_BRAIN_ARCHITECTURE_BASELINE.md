# Master Brain — Architecture Baseline (Draft)

**Status:** Planning baseline; not production-ready.  
**Branch:** `master-brain/planning-baseline`  
**Purpose:** Define a safe, testable first version of a model-agnostic personal AI orchestration system. This document supplements the existing OpenClaw bootstrap architecture; it does not require OpenClaw to be running.

## 1. Product objective

Master Brain is a central decision and orchestration layer that routes a user's task to the most suitable model, tool, or specialist workflow; checks the result against evidence and constraints; and returns a concise, actionable recommendation with uncertainty clearly stated.

It is not merely a multi-model chat window. Its differentiators are:
- Task classification and routing based on capability, cost, latency, privacy, and reliability.
- Evidence-aware synthesis, with sources and assumptions separated from conclusions.
- Explicit disagreement detection and targeted second opinions for consequential or uncertain questions.
- User-approved tools and bounded permissions.
- Durable, user-controlled project context without storing secrets in source control.
- A small, reliable core before expanding to many integrations.

## 2. Core principles

1. **Evidence before confidence:** cite primary sources where possible; distinguish facts, calculations, assumptions, and interpretation.
2. **Least privilege:** enable only the tools needed for the current task; keep write, shell, browser, messaging, and financial actions disabled until individually reviewed.
3. **Human approval for consequential actions:** no purchases, external messages, destructive edits, credential changes, or deployments without explicit authorization.
4. **Provider independence:** use adapters so models can be replaced without rewriting orchestration logic.
5. **Graceful degradation:** if a provider or tool is unavailable, explain the limitation and offer a safe fallback.
6. **Traceability:** record task ID, routing decision, provider/model, tool calls, sources, validation outcome, and final status—excluding secrets and unnecessary personal data.
7. **Smallest useful MVP:** start with one orchestrator, a small number of provider adapters, and read-only tools. Add complexity only when tests show value.

## 3. Logical architecture

```text
User Interface (chat / web UI)
          |
          v
API + Authentication + Session Context
          |
          v
Task Intake and Policy Gate
  - intent / domain classification
  - risk and privacy classification
  - missing-information check
          |
          v
Orchestrator / Router
  - capability registry
  - provider availability and budget rules
  - single-model vs. multi-model decision
          |
          +---------------------+
          |                     |
          v                     v
Model Provider Adapters     Tool Adapters
(Claude, OpenAI, etc.)      (search, files, GitHub, etc.)
          |                     |
          +----------+----------+
                     v
            Evidence / Result Store
                     |
                     v
        Validator and Disagreement Resolver
          - citation and source checks
          - schema / constraint checks
          - independent review when warranted
                     |
                     v
        Response Composer + Audit Record
                     |
                     v
                  User
```

This is a logical design, not a claim that these components already exist in code.

## 4. Initial component boundaries

- **UI/API:** accepts requests and returns progress/results; authenticates users and enforces request limits.
- **Task classifier:** outputs a typed task category, risk tier, privacy tier, and required capabilities. It must not execute tools.
- **Policy gate:** rejects disallowed actions and requires confirmation for defined high-impact operations.
- **Provider registry:** declares each provider's supported capabilities, auth mode, context limits, cost metadata (when available), and health state.
- **Router:** selects the minimum viable set of models/tools using explicit rules; never silently assumes a provider is available.
- **Provider adapters:** normalize requests, responses, errors, timeouts, and usage metadata behind a common interface.
- **Tool adapters:** narrow, typed interfaces with allowlists, timeouts, and output-size limits.
- **Evidence bundle:** stores source URL/title/retrieval time, relevant excerpts, calculations, and provenance for claims.
- **Validator:** checks output structure, required citations, arithmetic where possible, constraints, and conflicting findings.
- **Memory layer:** separates ephemeral session context, project knowledge, and durable user-approved memory. Secrets and credentials are never memory content.
- **Audit/observability:** records safe metadata, failures, routing rationale, and verification status; redacts tokens and sensitive payloads.

## 5. Routing policy (first version)

Use deterministic rules before introducing a learned or self-modifying router.

1. Classify the task and risk level.
2. If current facts are required, obtain fresh evidence before synthesis.
3. If the task is a simple, low-risk request, use one capable provider.
4. If the task is complex, high-uncertainty, or explicitly requests cross-checking, obtain an independent review only when it is likely to add value.
5. Use specialist tools for exact operations (repository reads, calculations, document parsing) instead of asking a language model to guess.
6. Compare results against evidence and constraints; do not decide by majority vote alone.
7. If sources conflict or evidence is weak, disclose the conflict and state what would resolve it.
8. Apply budget, timeout, retry, and rate-limit rules. Avoid unbounded agent loops.
9. Before any write or external side effect, enforce the policy gate and required user confirmation.
10. Return the conclusion, evidence, confidence/uncertainty, next action, and any unresolved issue.

## 6. Risk tiers

- **R0 — Informational:** explanations and drafting; no external side effects.
- **R1 — Read-only research:** web, repository, and document reads under explicit scope.
- **R2 — Reversible workspace changes:** create a branch or draft artifact; preserve diffs and verify results.
- **R3 — External side effects:** send, publish, deploy, purchase, modify live systems, or change access. Require explicit, specific confirmation.
- **R4 — Destructive or sensitive operations:** deletion, credential rotation, broad shell access, or handling highly sensitive data. Disabled by default; require a separate security review and confirmation.

## 7. MVP scope

### Include
- One orchestrator and a typed request/response contract.
- Two provider adapters initially, selected based on accessible authentication and practical availability.
- Read-only web research and repository/file inspection.
- Structured task routing with clear fallback behavior.
- Source/provenance capture and a lightweight validation step.
- Unit tests for routing, policy decisions, adapter errors, and citation requirements.
- Configuration through environment variables; safe example configuration only.
- Basic structured logs with secret redaction.

### Defer
- Autonomous self-modifying agents, unrestricted shell, persistent browser sessions, messaging, financial execution, and production deployment.
- A large multi-agent swarm or consensus-by-voting.
- Vector database and elaborate long-term memory until retrieval needs are demonstrated.
- Provider integrations that require credentials not yet available.
- OpenClaw runtime dependency. OpenClaw can be added later as an optional adapter after its availability and security posture are verified.

## 8. Suggested implementation sequence

**Stage 0 — Discovery and baseline**
- Inspect the Claude documents and current repository before editing.
- Reconcile duplicate or conflicting architecture statements.
- Mark requirements as confirmed, proposed, or undecided.
- Record actual runtime, language/framework, test commands, and available credentials without exposing secrets.
- Preserve existing files and work; use a feature branch.

**Stage 1 — Contracts and policy**
- Define typed task, provider, tool-result, evidence, and final-response schemas.
- Implement risk classification and approval policy.
- Add tests for forbidden actions and confirmation requirements.

**Stage 2 — Single-provider vertical slice**
- Implement one end-to-end request path with one provider adapter.
- Add timeout/error handling, logs, and deterministic tests.
- Verify the system reports provider unavailability honestly.

**Stage 3 — Second provider and routing**
- Add a second adapter behind the same interface.
- Implement deterministic capability-based routing and bounded fallback.
- Test provider disagreement and partial failure.

**Stage 4 — Evidence and validation**
- Add source metadata, citation checks, and claim/evidence separation.
- Add independent review only for tasks where it provides measurable benefit.

**Stage 5 — Read-only tools and usable interface**
- Add scoped repository/document/search tools and a minimal interface.
- Verify permission boundaries and data redaction.
- Evaluate on a fixed set of representative tasks before expanding scope.

Each stage must have a passing test suite, a reviewable diff, and a rollback path before moving forward.

## 9. Minimum acceptance criteria

- No secrets, access tokens, private keys, cookies, or private user data in committed files or logs.
- A missing or failed provider produces a clear error/fallback, never a fabricated success.
- Routing decisions are explainable and testable.
- Tool calls enforce allowlists, timeouts, and output limits.
- Any R3/R4 operation is blocked without the required approval.
- Research claims retain source provenance; weak or conflicting evidence is disclosed.
- Tests cover success, provider failure, timeout, malformed output, policy denial, and confirmation-required paths.
- No direct writes to `main`; changes are reviewed in a feature branch or pull request.

## 10. Open decisions — do not guess

- **Runtime and language:** determine from existing project files and Claude's current project documents.
- **Primary provider and authentication:** use only a confirmed, supported sign-in/API path; do not assume account entitlements.
- **Second provider:** choose after checking access, cost, privacy, and capability.
- **Storage:** begin with the simplest safe option supported by the existing stack; no database selection before discovery.
- **Interface:** reuse an existing UI if one exists; otherwise choose after confirming device and deployment constraints.
- **Deployment:** local, hosted, or hybrid remains undecided until budget, connectivity, data residency, and maintenance are assessed.
- **Private knowledge backup:** keep private memory and credentials outside this public repository.
- **OpenClaw:** explicitly out of scope for the current milestone.

## 11. Immediate next actions for Claude and Cursor

1. In Claude, ask it to compare this baseline with the existing Master Brain documents and return a gap/conflict list without overwriting the originals.
2. In Cursor, open the existing repository and inspect the actual file tree, package manifests, tests, and current diff. Do not run install scripts or change files yet.
3. Reconcile findings into a short implementation plan, then implement Stage 1 only after the runtime/framework and current code state are verified.
4. Before any code change, create or use a feature branch, show the proposed diff, run tests, and report exact evidence of success/failure.

**Important:** This file is a proposed baseline for review, not a claim that the architecture has been implemented or validated in a running system.
