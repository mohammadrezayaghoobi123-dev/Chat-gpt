# Multi-Tenant Autonomous Engineering Platform — Reference Architecture v1.0

**Status:** Draft for architecture review; not an implementation authorization  
**Date:** 2026-11-08  
**Baseline:** `integration/claim-engine-observability-owner-webhook-2026-11-08` at `967be9f64d0366528a3657fd42d385dfcfc0802e`  
**Product class:** Cloud-native, AI-native, multi-project, multi-tenant autonomous engineering platform

## 1. Executive intent

Build one extensible platform that can operate multiple independent software projects for multiple organizations (tenants), with isolated identities, project permissions, knowledge, agents, execution environments, integrations, budgets, audit trails, and release lifecycles.

Multi-tenancy is a foundational domain model and security property. It is not a late-stage feature, a UI filter, or a caller-supplied `tenant_id`. Every request and background execution must carry a server-derived, authenticated tenant and project context. Every persistence, retrieval, event, artifact, secret, tool, and audit boundary must preserve and enforce that context.

The platform is intended to evolve across multiple hosting cells and execution providers. It must not assume that every logical module is a microservice, or that Kubernetes, a particular database, or a particular model provider is mandatory. Deployment topology is selected from measured workload, isolation, availability, cost, and operational constraints.

## 2. Product and domain model

Canonical hierarchy:

```text
Platform
  ├── Platform control domains (identity federation, policy, catalog, cell registry)
  └── Tenant / Organization
        ├── Tenant members, teams, roles, entitlements, budgets
        ├── Projects
        │     ├── Project members and scoped roles
        │     ├── Repositories and source-of-truth references
        │     ├── Environments: development / test / staging / production
        │     ├── Knowledge, documents, indexes and project memory
        │     ├── Tasks, workflows, agents and execution runs
        │     ├── Integrations, webhooks and scoped credentials
        │     └── Artifacts, releases, evidence and audit events
        └── Tenant-level policies, retention, billing and isolation tier
```

Definitions:
- **Platform:** control and service plane operated by the platform owner.
- **Tenant:** organization and primary security, governance, quota, retention and billing boundary.
- **Project:** independently governed engineering workload within a tenant; may map to one or more repositories.
- **Environment:** named deployment and verification boundary for a project. Production is always a protected environment.
- **Cell:** independently operable deployment/failure domain that hosts a bounded set of tenants and their workloads.
- **Principal:** human, service, integration or agent identity. A principal may belong to multiple tenants only through explicit membership.
- **Agent identity:** short-lived workload identity with a task-bound capability set; it is not a human identity and cannot grant itself privileges.

Tenant isolation and project authorization are separate checks: a user can be a tenant member without having access to every project. A project identifier supplied by a client is only a selector; it never proves authorization.

## 3. Architectural style and deployment strategy

Adopt domain-driven design, explicit bounded contexts, hexagonal boundaries, versioned contracts, and event-driven integration where asynchronous decoupling is beneficial.

Start from a modular application and a small number of independently scaled runtime components. Split a module into a separately deployed service only when a documented quality attribute requires independent scaling, fault isolation, security boundary, release cadence, or ownership. Avoid premature microservice proliferation and distributed transactions.

Use a **hybrid cell-based tenancy model**:
1. **Pooled tier:** tenants share stateless gateway/control services and pooled execution capacity; tenant-scoped data and authorization remain mandatory.
2. **Cell-isolated tier:** tenants are assigned to a cell with separate runtime/data partitions and independent capacity limits.
3. **Dedicated tier:** selected tenants can receive dedicated storage, execution, network, or deployment resources when contractual or threat-model requirements justify the cost.

Cell placement is an internal platform decision. Tenant movement between cells must be an explicit migration workflow with source/destination validation, copy verification, cutover fencing, rollback plan, and audit evidence. No cross-cell move is implied to be atomic across external providers.

Cloudflare Workers and SQLite-backed Durable Objects are current implementation candidates, not universal platform constraints. The initial implementation must document provider-specific limits, object lifecycle, storage limits, concurrency model, backups/export, data residency, and cost. Provider portability is maintained through domain interfaces and adapters, not by pretending provider semantics are identical.

## 4. Logical architecture planes

1. **Experience plane:** web/mobile clients and administrative interfaces. Clients render state and collect intent; they do not make authoritative policy or approval decisions.
2. **Identity and access plane:** authentication, principal registry, tenant memberships, project roles, service identities, workload identity and session lifecycle.
3. **Intelligence plane:** model gateway, planner, specialist agents, context assembly, retrieval, evaluation, and human review support.
4. **Engineering control plane:** project registry, task admission, policy evaluation, workflow orchestration, scheduling, quotas and approval state.
5. **Execution plane:** isolated workers, ephemeral sandboxes, tool adapters, repository operations, test runners and artifact production.
6. **Knowledge and data plane:** GitHub Vault, Brain Store, derived search indexes, project memory, evidence and data lifecycle.
7. **Integration plane:** MCP gateway, versioned APIs, webhooks, GitHub/Cloudflare adapters, event delivery and connector registry.
8. **Security and governance plane:** policy-as-code, secrets, cryptographic verification, audit, retention, compliance and separation of duties.
9. **Reliability and operations plane:** telemetry, SLOs, capacity, incident response, backup/restore, disaster recovery and reconciliation.
10. **Release plane:** artifact registry, provenance, SBOM, environment promotion, staging acceptance and human-gated production release.

These are responsibility boundaries, not a mandate for ten deployable services.

## 5. Bounded contexts and ownership

| Bounded context | Owns | Must not own |
|---|---|---|
| Identity & Membership | principals, tenant memberships, project memberships, sessions | project source code or knowledge |
| Tenant & Entitlements | tenant lifecycle, isolation tier, quotas, retention, billing dimensions | task execution state |
| Project Registry | project identity, repository links, environment catalog, project policy references | canonical document contents |
| Policy & Governance | policy versions, decisions, approval requirements, protected actions | agent-generated authority |
| Orchestration | task contracts, workflow state, leases, fencing, idempotency, outbox, recovery | canonical project knowledge |
| Agent Runtime | ephemeral agent sessions, capabilities, execution records | tenant membership authority |
| Knowledge | structured project knowledge, document references, sync state, derived indexes | workflow/lease authority |
| Source Vault | canonical source documents and code history in Git repositories | mutable duplicate document authority |
| Integration | provider adapters, webhook receipts, protocol sessions | cross-tenant authorization authority |
| Artifact & Release | immutable artifacts, attestations, release manifests, promotion records | source-code authority |
| Usage & Cost | metering, budgets, attribution, quotas | authorization authority |
| Observability & Audit | operational telemetry and append-only security/audit evidence | business source-of-truth state |

Each context has one authoritative owner for each data class. Cross-context reads use explicit interfaces or projections. Cross-context writes use commands/events and reconciliation, not direct table mutation.

## 6. Identity, tenant context and authorization

### 6.1 Trust establishment

- Authenticate the caller before resolving tenant membership.
- Resolve principal identity from a validated credential/session, not from request body fields.
- Resolve tenant membership and project permissions server-side.
- Reject ambiguous, missing, disabled, expired or revoked membership.
- Do not accept caller-supplied `tenant_id` as authority. Tool schemas must not expose it.
- A client may select a `project_id`; the server must prove the principal has access to that project and its owning tenant.
- Internal service calls carry a signed or otherwise integrity-protected context containing principal, tenant, project, purpose, capability, expiry, correlation ID and policy version. Context must not be forgeable by a client or agent.
- Background jobs persist the initiating principal, tenant, project, task and policy snapshot. On execution, the runtime revalidates revocation and current policy before consequential actions.

### 6.2 Authorization model

Use RBAC for stable role bundles and ABAC for resource/context conditions. Candidate roles include platform operator, tenant owner/admin/member, project owner/maintainer/developer/reviewer/reader, service principal and agent workload. Exact role names and grant semantics require a permission matrix and threat-model review before implementation.

Authorization decisions must include:
- principal and identity assurance;
- tenant and project membership;
- resource ownership and classification;
- requested action and capability;
- environment sensitivity;
- policy version and relevant constraints;
- expiry/revocation state.

Default is deny. Privilege is not inherited across tenants. Tenant administrators cannot alter platform-global policy. Agents cannot change their own capabilities, membership, branch protection, required checks, approval rules or secret access policy.

### 6.3 Cross-tenant isolation invariants

1. No cross-tenant read, write, search result, relationship, event, artifact, secret, log payload or memory retrieval without an explicit platform-authorized operation.
2. Every tenant-owned record includes tenant identity; project-owned records also include project identity.
3. Composite tenant-aware foreign keys or equivalent storage-enforced partition boundaries protect relationships.
4. Every query path, including search, joins, exports, background workers and administrative tools, enforces tenant scope.
5. Tenant context is derived at the trusted boundary and propagated immutably.
6. A missing or inconsistent context fails closed.
7. Tests include same-ID collisions across tenants, confused-deputy attempts, forged context, project substitution, stale membership, and background-job replay.

## 7. Data architecture and source-of-truth rules

Preserve the approved Option C knowledge architecture and make its boundaries explicit:

- **GitHub Vault:** canonical source for code, specifications, ADRs and versioned documents. Revisions are pinned to commit SHA and content SHA-256. Writes use expected-SHA compare-and-swap and reviewable PRs.
- **Brain Store:** canonical structured project knowledge, entities, relationships, tags, document references, synchronization state and knowledge outbox. All records are tenant- and project-scoped.
- **Derived retrieval:** FTS/vector/graph retrieval indexes are versioned projections, disposable and rebuildable from canonical sources. They are never the sole source of truth.
- **Orchestration Ledger:** canonical task/workflow/lease/fencing/idempotency/outbox state. It is a separate bounded context from Brain Store. It must not become a second knowledge store.
- **Artifact Store:** immutable build/test/release outputs addressed by content digest and governed retention.
- **Audit Store:** append-only security and governance evidence, with independently verifiable integrity anchors where required.

No dual editable copies. A source-of-truth conflict is resolved by the owner of that data class; derived indexes are rebuilt. Data schemas are versioned, migrations are additive where feasible, and destructive migrations require export/restore rehearsal and rollback criteria.

### 7.1 Tenant data placement

Initial recommendation: tenant-partitioned storage with a tenant-specific logical partition/object identity where supported, and project IDs within that partition. Large or regulated tenants may move to dedicated storage/cells. The exact partition granularity must be benchmarked against object-count limits, hot-tenant contention, backup/restore granularity, data residency and cost before locking a provider-specific implementation.

Tenant-aware keys and authorization remain required even when storage is physically isolated. Physical isolation is defense in depth, not a substitute for access control.

## 8. AI, agents and knowledge context

- A model gateway abstracts provider selection, credentials, rate limits, budgets, fallback policy and telemetry.
- Agent roles are task-oriented specialists (e.g. architect, implementer, test engineer, security reviewer, reliability reviewer); role labels do not grant permissions.
- Planning, execution and verification are separate responsibilities. A worker must not be the sole verifier of its own consequential output.
- Context assembly is tenant- and project-scoped, permission-filtered, source-attributed and bounded by data classification.
- Memory has explicit scope: platform policy, tenant knowledge, project knowledge, task-local context. Cross-scope retrieval is prohibited unless an explicit policy grants it.
- Retrieved content is untrusted data, never executable instruction or authority. Prompt injection defenses apply to repository files, issues, comments, documents and tool results.
- Agent execution uses ephemeral task identity, bounded time/resources, explicit tool capabilities, network allowlists and secret broker access only when required.
- Model outputs are proposals. State transitions, writes, approvals and releases are performed by policy-enforcing services, not by model text.
- Evaluation includes task success, correctness, regression rate, security violations, provenance quality, cost and human override rate. Model/provider agreement is not independent evidence when sources are correlated.

## 9. Orchestration, workflow and distributed consistency

Use explicit versioned state machines and durable workflow records. Each task has immutable identity, tenant/project scope, idempotency key, input hash, acceptance criteria, assigned capability, state version and evidence references.

Leases use monotonically increasing fencing generations. Every state-changing operation verifies task scope, lease expiry, generation, expected version and actor capability. Stale workers cannot commit.

Database-local state changes are atomic within the owning store. External effects (GitHub, Cloudflare, model APIs, queues) are not part of that database transaction. Use transactional outbox, idempotency keys, durable receipts, bounded retries, dead-letter handling and reconciliation. Do not claim global exactly-once delivery; design for at-least-once delivery with idempotent effect and evidence-based recovery.

Workflow semantics must define cancellation, timeout, retry budget, compensation, ambiguous external outcomes, manual intervention and dead-letter recovery. Queue publication and consumption must be fenced against stale task versions.

The Orchestrator Ledger remains distinct from Brain Store. PR #150's proposed reuse of KnowledgeStore for orchestration state conflicts with this separation and must be reconciled before integration. PRs #193/#194 already implement a separate ledger direction; this direction is the current recommendation, subject to measured storage and failure-domain validation.

## 10. Execution isolation and software supply chain

- Run untrusted repository code in ephemeral sandboxes with non-root identity, resource limits, restricted filesystem, syscall/process controls where supported, and deny-by-default network access.
- Separate control-plane credentials from execution workers. Workers receive scoped short-lived tokens, never platform master credentials.
- Pin actions, dependencies and tool versions; produce SBOM and build provenance for release artifacts.
- Verify source commit, build recipe, dependency lock, test evidence and artifact digest.
- Do not allow a worker to alter required checks, branch protections, policy bundles, trust roots or its own sandbox policy.
- Treat generated artifacts and test reports as untrusted until independently validated.
- Maintain reproducible build capability where technically feasible; document non-deterministic inputs and their provenance.

## 11. Integration and API contracts

- API-first, versioned contracts with explicit schemas, compatibility rules, error envelopes and correlation IDs.
- MCP is an integration protocol, not the authorization system or source of truth.
- Each connector declares tenant/project scope, read/write capabilities, data classification, idempotency behavior, timeout/retry behavior and audit requirements.
- Webhook authentication validates signature over raw request bytes before parsing or trusting payload fields. Durable receipt deduplication is scoped to provider, tenant/project and event identity.
- GitHub repository allowlists, branch policy, expected-SHA updates and PR-based source changes remain mandatory.
- Provider adapters expose normalized domain interfaces but retain provider-specific semantics and failure modes.
- Public anonymous read-only access must be isolated from authenticated tenant data and must never expose private knowledge tools.

## 12. Security, privacy and governance

Threat modeling covers tenant escape, broken object-level authorization, confused deputy, prompt injection, credential theft, replay, webhook forgery, privilege escalation, supply-chain compromise, data exfiltration, noisy-neighbor denial of service, audit tampering and malicious insiders.

Secrets are held by a secret manager/KMS or provider secret bindings. Values are not returned to agents, persisted in task payloads, included in logs, or copied into prompts. Access is mediated by scoped broker operations and audited metadata.

Audit records include actor, tenant, project, action, target, policy version, decision, correlation/task ID, timestamp and evidence digest. Sensitive payloads are minimized. Audit integrity and retention requirements are documented separately from operational logs.

Production deployment and Production rollback are protected actions requiring direct human approval from an authorized owner. Approval binds to immutable release ID, source SHA, artifact digest, configuration/manifest digest, environment and evidence set. Any change to these inputs invalidates approval. The agent cannot approve its own release.

## 13. Reliability, observability and operations

Use OpenTelemetry-compatible traces, metrics and structured logs. Correlation propagates across API, queue, workflow, agent, provider and release boundaries. Tenant identifiers in telemetry are pseudonymized or access-controlled; secrets and sensitive document content are excluded.

Define service-level indicators and objectives for availability, latency, queue age, task completion, recovery time, isolation violations and provider dependency health. Numerical SLOs, RTO and RPO are not invented in this draft; they must be set after workload, cost and recovery requirements are measured and approved.

Required operational capabilities:
- health, readiness and liveness semantics with bounded cost;
- rate limits, quotas and fair scheduling per tenant;
- circuit breakers and bounded retries for external providers;
- backup, restore, retention and deletion workflows;
- disaster recovery exercises and evidence;
- migration compatibility and rollback;
- incident response, audit export and tenant notification policies;
- capacity planning and cost attribution by tenant/project/workflow/model.

Deep database integrity scans must not silently become unbounded hot-path readiness work. Readiness checks should be cheap and bounded; deep integrity diagnostics run on a separately controlled schedule or explicit operation, with observable duration and result.

## 14. Release and environment model

Each project has independent development, test, staging and production environment identities, policy and configuration. Environment promotion is artifact-based, not rebuild-by-branch.

A release manifest binds:
- repository and source commit SHA;
- build workflow and pinned toolchain;
- artifact digest;
- SBOM and provenance attestation;
- test, security and policy evidence;
- configuration and migration digests;
- target environment and release identity.

Merge is allowed only when repository protection, required checks and independent review are enforced on the exact head SHA. Staging acceptance is separate from CI. Production deploy and rollback require direct human approval bound to the exact immutable manifest. No approval survives a changed artifact or configuration.

## 15. Usage, capacity and economic architecture

Every billable or scarce operation is metered with tenant, project, workflow, agent/model, provider, resource class and timestamp attribution. Quotas cover concurrency, CPU/time, memory, storage, egress, provider calls, model tokens and queue backlog as supported by the runtime.

Fair scheduling prevents one tenant from monopolizing shared capacity. Admission control rejects or queues work predictably when budgets or capacity are exhausted. No paid provider, hosting tier, billing enablement or paid fallback is assumed; any such choice requires an explicit product/budget decision.

## 16. Architecture decisions and open decisions

### Current recommendations

- Multi-project and multi-tenant are foundational, not optional future extensions.
- Hybrid cell-based tenancy is the target deployment model.
- Modular domain architecture precedes service decomposition.
- Tenant context is derived from authenticated membership and propagated as trusted context.
- Brain Store and Orchestrator Ledger remain separate bounded contexts.
- GitHub Vault is canonical for source documents; Brain Store owns structured knowledge; indexes are disposable.
- Agent permissions are task-bound and non-self-escalating.
- Production deploy and rollback require direct human approval.

### Decisions requiring evidence before implementation lock-in

1. Identity provider and exact authentication/session protocol.
2. Tenant/project role matrix and delegation semantics.
3. Physical storage partition granularity and dedicated-tenant thresholds.
4. Cell placement algorithm and migration/cutover protocol.
5. Canonical database/object storage and backup/export mechanism under actual hosting/cost constraints.
6. Numerical SLO, RTO, RPO, retention and data residency targets.
7. Usage/billing product semantics and paid-service policy.
8. Agent/model provider catalog and allowed data classifications.
9. Independent reviewer model and cryptographic trust-root ownership.
10. Tenant deletion, legal hold, export and offboarding semantics.

These are explicit decision seams; implementation must not silently choose externally observable product behavior.

## 17. Repository conformance and migration strategy

This reference architecture supersedes conflicting implementation assumptions only after review and approval. It does not authorize bulk rebasing, merging, deleting branches, changing Cloudflare resources, rotating credentials or deploying.

Initial repository observations at the stated baseline:
- `main` is at `1cf4bb4dcf49728721c7c770ecd202e859982021` and does not contain the current Orchestrator/Brain Store implementation paths found on the integration candidate.
- PR #133 contains a tenant-scoped KnowledgeStore foundation, but the approved Option C contract describes a fixed owner principal in the current Connector path; this is not full multi-tenant product identity/membership.
- PRs #149/#150 contain task contracts and a KnowledgeStore-integrated orchestration proposal. PR #150's shared-store direction conflicts with the separate Orchestrator Ledger boundary recommended here.
- PRs #180/#186/#187/#188/#190/#193/#194 form overlapping webhook, claim, readiness and telemetry work. Their changed-file overlap requires sequential integration and exact-head combined verification.
- The current Connector's tenant mapping to a fixed owner principal is a single-owner bootstrap, not a multi-tenant identity system.
- PR #193/#194 report CI evidence in their descriptions, but live Staging acceptance is not established by those descriptions.

Migration sequence:
1. Approve this reference architecture and record superseded/retained ADRs.
2. Build a full branch/PR dependency and changed-file overlap graph; classify active, stacked, historical, release and abandoned branches without deleting anything.
3. Establish canonical integration ancestry and exact-SHA verification gates.
4. Define identity/membership and tenant/project authorization contracts before exposing tenant-aware writes.
5. Reconcile KnowledgeStore, Orchestrator Ledger and task schema ownership; define additive migrations and recovery.
6. Implement cross-tenant isolation tests at API, storage, search, event, agent-memory and background-job boundaries.
7. Wire the end-to-end orchestrator runtime only after identity, authorization, execution isolation and recovery contracts pass.
8. Complete cell scheduling, quotas, usage attribution and dedicated isolation as independently testable slices.
9. Verify staging with live evidence and environment parity; production remains separately human-gated.

All migration work preserves Git history and existing project data. No branch is deleted merely because it is old or unreferenced. No production mutation is included.

## 18. Acceptance criteria for this architecture

The architecture is ready for implementation planning only when:
- all bounded contexts have explicit owners and non-overlapping data authority;
- tenant and project identity/authorization contracts are reviewed;
- all data classes have a source-of-truth, partitioning, retention and deletion policy;
- the storage and cell strategy is supported by workload/cost evidence;
- the KnowledgeStore/Orchestrator Ledger boundary conflict is resolved;
- cross-tenant threat model and test matrix are approved;
- execution isolation and secret mediation are defined;
- workflow/outbox/reconciliation semantics are explicit;
- artifact provenance and production approval contracts are immutable and testable;
- open product decisions that change observable behavior are resolved or deliberately deferred behind a non-implemented seam.

**Maturity statement:** This document is a proposed reference architecture. It is not evidence of implementation, independent validation, staging acceptance or production readiness.
