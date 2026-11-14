# Master Brain — Unified Architecture & Integration Plan
**Date:** 2026-11-15  
**Status:** Approved design baseline; implementation not yet integrated or production-verified  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Integration branch:** `integration/master-brain-unification-2026-11-15`  
**Base:** `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`

## 1. Mission and non-goals

Unify the existing Master Brain implementations into one coherent, modular, evidence-governed system. Preserve useful historical work, avoid duplicate authorities, and keep the system extensible across domains, models, agents, tools, and deployment environments.

This is an integration program, not a big-bang rewrite. It does not authorize merging every branch, deleting historical branches, changing `main`, changing production Cloudflare resources, reading or rotating secrets, or modifying the user's local computer.

The target is a single logical product with explicit module and service boundaries. Logical modules do not automatically become separate network services.

## 2. Evidence baseline and known discrepancies

The following are repository observations, not claims of runtime correctness:

- `master-brain/integrated-mvp` describes a deterministic Python prototype combining A (intelligence/opportunity) and B (proof/evidence/engineering controls). It contains `core.py`, `ctp.py`, synthetic tests, and an architecture baseline. Its own README says the tests have not been independently validated and the branch is not production-ready.
- `master-brain/integrated` contains a Python HTTP API and service entry point. Its API contract documents `/v1/missions` and related mission, approval, execution, audit, and result routes. The service defaults to loopback and port 8765. This is not the same API contract as the Hub's legacy `/api/brain/entries` expectation.
- `cloud-agent/README.md` on `main` describes a Cloudflare Worker engineering agent with model inference, Durable Object sessions and budget ledger, and read-only GitHub tools. It explicitly does not execute project test suites or make code changes.
- `cloud-engineering-connector/README.md` describes a separate MCP connector with repository inspection and bounded draft-PR capabilities. It is not itself the full Master Brain.
- PR #129 and PR #140 were merged into `integration/unify-main-and-integrated-2026-11-02`, not directly into `main`. Their descriptions contain release and live-acceptance gates; a merge or green CI does not prove production readiness.
- PRs #186 and #188 were isolated follow-ups on another feature branch. Their individual green CI runs do not prove combined integration.
- At the inspected refs, the old integration branch is substantially divergent from current `main`; it must not be adopted wholesale without commit-level reconciliation.

All above must be rechecked against current GitHub refs before implementation. A PR body is evidence of a claimed process/result, not independent proof.

## 3. Target logical architecture

### 3.1 Supreme Command Core
Owns the user objective, global policy, priorities, budget ceilings, risk classification, final synthesis, and escalation. It is the final policy authority. It does not implement every specialist function.

### 3.2 Strategic Intelligence / Meta-Intelligence
Mandatory coordination layer between Command Core and domain islands. It frames missions, identifies relevant domains, decomposes tasks, maps dependencies, chooses providers/tools, plans evidence collection and verification, reports capability gaps, and records routing rationale. It cannot override policy, fabricate evidence, approve its own privileged actions, or treat model consensus as truth.

### 3.3 Specialist domain islands
Independently versioned modules with a shared typed contract. Initial domains: general reasoning, industrial engineering, economics/markets, accounting/finance, science/research, software/AI, security/risk, and extensible future domains. Cross-domain missions are first-class. Missing capabilities must be reported as gaps, not simulated consultations.

### 3.4 Intelligence Plane and Proof Plane
The Intelligence Plane researches, reasons, proposes hypotheses and opportunities. The Proof Plane challenges claims, checks provenance and independence, generates rival hypotheses, defines falsifiers and discriminating tests, runs deterministic checks, red-team cases and independent evaluations. The planes share typed evidence, not hidden model state.

### 3.5 Shared foundations
- Mission and policy registry
- Orchestrator and explicit state machine
- Provider/model adapters
- Evidence registry and provenance
- CTP (Contradiction-to-Proof) case engine
- Knowledge/Brain Store
- Canonical document Vault and immutable revisions
- Memory with distinct session, project, and user-approved durable scopes
- Identity, authorization, approval, and action gateway
- Audit, observability, cost/budget control, reliability, backup and rollback

### 3.6 Edge and execution adapters
MCP Gateway, Cloud Agent, Hub clients, plugins, and external tools are adapters around the core. They must not each become a competing source of mission truth or independently implement policy.

## 4. Canonical contracts and compatibility strategy

Do not silently choose one existing endpoint based on convenience. First inventory consumers and producers, then define versioned canonical domain contracts.

Candidate canonical domain model: mission, objective, constraints, success criteria, risk tier, selected islands, evidence references, hypotheses, tests, approvals, execution attempts, outcomes, audit events, and verification state.

- The Python API's `/v1/missions` is a candidate domain transport and must be reviewed for completeness/security before adoption.
- The Hub's `/api/brain/entries` is a legacy consumer contract. Keep a compatibility adapter only if a live consumer is confirmed; otherwise deprecate through a documented migration.
- MCP is a protocol/tool boundary, not the canonical persistence API.
- Every adapter must map errors, idempotency, identity, correlation IDs, pagination, size limits, and version negotiation explicitly.
- No client-supplied tenant or actor identity is trusted. Identity and authorization derive from authenticated server-side principals.
- Unknown outcomes remain `UNKNOWN`; unrun tests remain `NOT_RUN`. Never coerce unknown into pass or fail.

## 5. Data ownership and source-of-truth rules

Proposed Option C boundary, subject to verification:
- GitHub Vault: canonical source for versioned documents, ADRs, code, and immutable revisions.
- Brain Store: operational metadata, tenant-scoped entities/relationships/tags, synchronization state, proposal lifecycle, and outbox.
- Search indexes and caches: derived, rebuildable projections; never authoritative.
- Audit log: append-only decision and action evidence with integrity checks; not a mutable knowledge store.
- Session store: short-lived conversational/session state; not project knowledge.
- Durable Objects/SQLite: implementation technology, not an independent source-of-truth policy.

Define ownership, retention, deletion, tenant isolation, consistency, conflict resolution, backup, restore, and migration rules before enabling live writes.

## 6. Integration phases and atomic gates

### Phase 0 — Preservation and inventory
Freeze the evidence snapshot (refs/SHAs), map branches/PRs/workflows/files, classify artifacts as source, duplicate, experiment, superseded, or unknown. Do not delete or rewrite historical sources. Produce a traceability matrix.

**Exit:** complete inventory for selected candidate components; unresolved items explicitly UNKNOWN.

### Phase 1 — Architecture and contract freeze
Approve component boundaries, canonical schemas, API/MCP boundaries, data ownership, identity model, threat model, cost ceilings, and compatibility/deprecation plan.

**Exit:** ADRs and versioned schemas with contract tests.

### Phase 2 — Deterministic core integration
Integrate domain records, Command Core, Meta-Intelligence, routing registry, mission state machine, CTP, evidence references, and policy checks in the isolated branch. Keep provider/network/action adapters disabled in unit tests.

**Exit:** import/build checks, unit/contract/property tests, state-transition invariants, deterministic replay, and migration compatibility.

### Phase 3 — Persistence and audit integration
Integrate Brain Store/Vault adapters, idempotency, transaction boundaries, outbox reconciliation, schema migration, integrity checks, tenant isolation, and backup/restore.

**Exit:** crash/replay/concurrency tests, data-integrity checks, restore drill, and tenant-isolation negative tests.

### Phase 4 — Provider, Cloud Agent, MCP and Hub adapters
Connect provider adapters and Cloud Agent as optional model/runtime capabilities; MCP as protocol gateway; Hub as a client/compatibility adapter. No duplicate orchestrator or knowledge authority.

**Exit:** end-to-end authenticated contract tests, real client handshake/tool tests, bounded cost tests, failure injection, and verified read-only behavior.

### Phase 5 — Domain islands
Integrate each domain behind the shared contract, one at a time. Require capability declaration, evidence format, evaluation set, safety boundaries, cost budget, and explicit limitations.

**Exit:** cross-domain mission tests and routing rationale review.

### Phase 6 — Independent verification and release readiness
Run the full combined test suite, security review, red-team, CTP falsification tests, performance/cost tests, backup/restore, deployment identity checks, staging smoke, live client compatibility, and rollback rehearsal.

**Exit:** independent approval of the exact SHA and complete acceptance evidence. Production remains NO-GO until all required gates pass.

## 7. Atomic engineering protocol

Each change set must:
1. State one bounded objective and explicit non-goals.
2. Record base SHA and expected touched paths.
3. Add/adjust a failing regression test where applicable before the implementation (RED).
4. Make the smallest coherent change.
5. Run targeted tests, then relevant full suites (GREEN).
6. Compare behavior and contracts against the baseline (regression check).
7. Record test command, environment, exact SHA, exit code, and artifacts.
8. Preserve failed/unknown results and counter-evidence.
9. Be independently reviewed on the exact head SHA.
10. Remain isolated until all gates pass; rollback is a documented operation.

Do not mix unrelated fixes in one PR. Do not rebase or force-push shared branches without explicit authorization and a fresh lease check.

## 8. CTP and evidence discipline

For every material claim or architectural decision record:
- claim and scope/context/time;
- source and immutable reference;
- provenance, authenticity, completeness, and independence;
- supporting and contradicting evidence;
- rival hypotheses;
- falsification conditions;
- discriminating tests and expected outcomes;
- actual result with exact artifact/commit;
- status: PROPOSED, DISPUTED, PROVISIONALLY_SUPPORTED, REJECTED, UNKNOWN, or independently validated as appropriate.

A synthetic test proves only the behavior represented by its fixture. Model agreement is not independent corroboration. Unknown experimental results are neither success nor failure.

## 9. Security and operational invariants

- Default deny; least privilege; read-only until explicitly authorized.
- Secrets never enter source, prompts, logs, artifacts, or screenshots.
- No public unauthenticated write surface.
- Strong tenant isolation and server-derived identity.
- Idempotency and replay protection for state-changing requests.
- Fail closed on unavailable authorization, policy, audit, or integrity checks.
- Explicit approval for consequential, destructive, financial, public, or irreversible actions.
- Separate staging and production identities, credentials, namespaces, and budgets.
- Observability must redact credentials and sensitive payloads.
- Cost ceilings, rate limits, timeouts, cancellation, circuit breakers, and bounded retries.
- Tested backup, restore, rollback, and disaster recovery.
- No direct writes to `main`; no production mutation during integration.

## 10. Current branch strategy

The new branch `integration/master-brain-unification-2026-11-15` was created from protected `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`. This is a clean integration workspace, not a claim that `main` is the best implementation source for every module.

Candidate sources are to be reconciled selectively by commit and path. The old integration branch is not a safe wholesale merge base because it diverges significantly from current `main`. The integrated Python API and integrated MVP are also distinct historical lines. No bulk merge is approved.

## 11. Required independent architecture review

A reviewer must inspect the current repository and this plan independently, challenge assumptions, identify contradictions and missing components, propose alternatives, and return:
- findings with file paths and exact commit SHAs;
- severity and confidence;
- supporting and contradicting evidence;
- rival architecture hypotheses;
- falsifiable tests;
- migration/data-loss/security risks;
- cost and operational trade-offs;
- required ADR changes;
- a sequenced, atomic integration plan;
- explicit UNKNOWN items.

The reviewer must not modify branches, files, PRs, settings, secrets, deployments, or production resources. Recommendations must distinguish code-exists, tests-authored, tests-executed, staging-verified, and production-verified.

## 12. Acceptance status

At document creation:
- isolated branch creation: DONE;
- architecture baseline written: DONE;
- complete source inventory: NOT_DONE;
- independent Claude architecture review: NOT_RUN;
- contract freeze: NOT_DONE;
- code integration: NOT_STARTED;
- combined verification: NOT_RUN;
- staging/production acceptance: NOT_RUN.

No production or `main` changes were made.
