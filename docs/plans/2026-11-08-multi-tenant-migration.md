# Multi-Tenant Platform Migration Implementation Plan

> **For agentic workers:** Execute task-by-task on the isolated integration branch. Every task is a separate reviewable commit. Do not merge this branch until all required gates pass and an independent review is recorded.

**Goal:** Evolve the Cloud Engineering Connector into a secure multi-project, multi-tenant engineering platform while preserving the existing repository history, data, and protected Production boundary.

**Architecture:** Use modular DDD/hexagonal boundaries with server-derived principal, tenant, and project context. Keep GitHub Vault canonical for code/specifications/ADRs, Brain Store canonical for structured knowledge, Orchestrator Ledger canonical for task/lease/outbox state, derived indexes rebuildable, and artifacts content-addressed. Start with pooled logical tenant isolation and preserve adapter seams for future cell isolation; do not bind the product to an unselected identity provider.

**Tech Stack:** Node.js 22 ESM, Cloudflare Workers, SQLite-backed Durable Objects, Vitest 4.1.12, Wrangler 4.155.0, GitHub Actions, npm audit, full-history secret scanning.

## Global Constraints

- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`.
- Immutable starting point for this migration branch: `main` at `1cf4bb4dcf49728721c7c770ecd202e859982021`.
- All work remains on isolated branches. No direct commits to `main`.
- Never merge the existing 1,704-commit integration stack wholesale. Its current comparison against main is 1,704 commits ahead and 5 behind; import only reviewed, necessary code and tests.
- Preserve all existing branches, PRs, Git history, tenant data, and existing Durable Object records. No branch deletion, forced push, bulk rebase, or destructive schema rewrite.
- Production deploy and Production rollback require direct human approval. No such action is included in this plan.
- Staging deployment may occur only after exact-SHA CI, security, immutable release-manifest, and preflight gates pass. No claim of live Staging acceptance before the smoke test actually passes.
- Never read, print, persist, or log secret values. Agent identities receive task-scoped capabilities; agents cannot approve their own actions or change policy/branch protection.
- Client-supplied `tenant_id` is never authorization evidence. Tenant context must be derived from an authenticated principal and verified membership. Client-supplied `project_id` is only a selector and requires server-side membership authorization.
- External GitHub, Cloudflare, and Queue effects are not described as one ACID transaction. Use transactional outbox, deterministic idempotency keys, immutable request fingerprints, reconciliation, and lease-generation fencing.
- Every behavior change follows TDD: observe the focused test fail for the intended reason, implement the minimum change, rerun the same test, then run affected integration tests.
- Do not silently decide the identity provider, complete RBAC/ABAC grant matrix, dedicated-tenant thresholds, data residency, billing semantics, or numeric SLO/RTO/RPO. Keep affected release capabilities gated until those decisions are made.

---

## Repository evidence and migration boundary

Observed on 2026-11-08:

- `main` is protected and points to `1cf4bb4dcf49728721c7c770ecd202e859982021`.
- The current candidate integration branch is `integration/claim-engine-observability-owner-webhook-2026-11-08` at `967be9f64d0366528a3657fd42d385dfcfc0802e`. It compares as 1,704 commits ahead and 5 behind main. It is not a safe merge base for this migration.
- PR #193 exact HEAD `fe6dc7360d47d01554d2f0ef1e8a9fe993ad92d4` and PR #194 exact HEAD `967be9f64d0366528a3657fd42d385dfcfc0802e` have successful reported Cloud Engineering Connector CI and Full History Secret Scan runs. Staging post-deploy acceptance is not established.
- Main currently has the connector `worker.js`, `wrangler.toml`, package manifest, and tests, but does not contain the Orchestrator Ledger or Brain Store modules present in the integration candidate.
- The integration candidate contains `cloud-engineering-connector/knowledge-store.js` and `orchestrator-ledger.js` as separate Durable Object modules. The earlier PR #150 design instead places orchestration records inside KnowledgeStore; that ownership model conflicts with the approved architecture and must not be imported.
- The integration candidate's Knowledge Store helper explicitly rejects every tenant except `owner`. Its MCP bearer telemetry classifies a shared bearer rather than claiming it identifies a unique human.
- The integration candidate's Ledger readiness ping executes `PRAGMA quick_check(1)`; readiness tests currently expect integrity metadata. This is a candidate for separating cheap liveness/readiness from deep integrity diagnostics.
- The current claim engine has tests for idempotent task creation, concurrent claims, lease fencing, reconciliation evidence, and bounded candidate selection. The Worker does not yet provide a complete end-to-end admission → scheduling → claim → execution → verification path.
- GitHub's branch-protection endpoint returned 403 through the connected integration. Required-check enforcement therefore remains unverified and must be verified by an authorized repository administrator before a merge gate is declared enforced.

## Task 0: Establish clean migration lineage and reproducible baseline

**Files:**
- Create: `docs/architecture/REFERENCE_ARCHITECTURE_MULTI_TENANT_V1.md`
- Create: `docs/plans/2026-11-08-multi-tenant-migration.md`
- No production-code changes in this task.

**Interfaces:**
- Consumes: main SHA `1cf4bb4dcf49728721c7c770ecd202e859982021`.
- Produces: clean integration branch rooted at that SHA; approved architecture and migration plan tracked on that branch.

- [ ] **Step 1: Record the clean branch base**
  
  Create `integration/multi-tenant-migration-2026-11-08` from the exact main SHA above. Never change the base retroactively.

- [ ] **Step 2: Preserve the approved architecture**
  
  Copy the reviewed reference architecture into the clean branch. Mark it approved for implementation planning while explicitly stating that it is not implementation or release evidence.

- [ ] **Step 3: Add this migration plan**
  
  Commit this plan alongside the architecture record. Keep the existing PR #195 unchanged; it remains a historical review branch stacked on the oversized integration line.

- [ ] **Step 4: Verify lineage**
  
  Run: GitHub compare API for `main...integration/multi-tenant-migration-2026-11-08`.
  
  Expected: exactly the documentation commits/files added by this task; zero unrelated source changes; base ancestor is the recorded main SHA.

- [ ] **Step 5: Open a Draft PR to main**
  
  Expected: PR remains Draft, no merge, no deploy, and the diff contains only the two architecture/plan documents.

## Task 1: Port the minimum reviewed connector foundation without importing unrelated history

**Files (observed source paths on the integration candidate; destination paths remain the same):**
- Create: `cloud-engineering-connector/orchestrator-core.js`
- Create: `cloud-engineering-connector/orchestrator-protocol.js`
- Create: `cloud-engineering-connector/orchestrator-worker-identity.js`
- Create: `cloud-engineering-connector/orchestrator-reconciliation-evidence.js`
- Create: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/knowledge-store.js`
- Create: `cloud-engineering-connector/orchestrator-owner-assertion.js`
- Create: `cloud-engineering-connector/orchestrator-owner-command.js`
- Create: `cloud-engineering-connector/github-webhook-auth.js`
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/wrangler.toml`
- Modify: `cloud-engineering-connector/package.json` and lockfile
- Create/modify: focused files under `cloud-engineering-connector/test/` and `cloud-engineering-connector/cloudflare-test/`

**Interfaces:**
- Consumes: Worker fetch/queue handlers; Cloudflare Durable Object bindings; versioned task and message-envelope contracts.
- Produces: isolated Brain Store and Orchestrator Ledger classes with no shared persistence ownership; authenticated, testable Worker integration.

- [ ] **Step 1: Build a file-level dependency inventory**
  
  Compare the exact source PR patches (#180, #186, #187, #188, #190, #193, #194) against main. Build a dependency map for every imported module, binding, migration, workflow, and test. Do not use the 1,704-commit branch as a merge base.

- [ ] **Step 2: Add tests for module boundaries before porting**
  
  Assert that KnowledgeStore owns only knowledge entities, relationships, tags, Vault references, synchronization, and derived indexes. Assert that OrchestratorLedger owns tasks, task events, leases, fencing, orchestration outbox, receipts, and orchestration audit events. Assert that no task/lease/outbox table is created by KnowledgeStore and no knowledge table is created by OrchestratorLedger.

- [ ] **Step 3: Port the minimum dependency-closed source set**
  
  Import only the files required by the tested vertical slice. Keep unrelated Python/CTP, OpenClaw, demo, and historical integration files out of this connector migration branch. Preserve the separate Durable Object classes and migrations.

- [ ] **Step 4: Verify the focused RED/GREEN sequence**
  
  Run from `cloud-engineering-connector`:
  ```bash
  npm ci --ignore-scripts --no-audit --no-fund
  npm run test:do -- --run cloudflare-test/knowledge-store.test.js cloudflare-test/orchestrator-ledger.test.js
  ```
  Expected after implementation: KnowledgeStore and OrchestratorLedger schema/ownership tests pass; there is no duplicate authority for task or knowledge records.

- [ ] **Step 5: Run the connector suite**
  
  Run: `npm test`, `npm audit --audit-level=moderate`, and `npm run check`.
  
  Expected: zero test failures, zero moderate-or-higher npm advisories, syntax checks and both Wrangler dry-runs pass. Record actual counts and exact SHA.

- [ ] **Step 6: Commit the isolated foundation**
  
  Commit only the files belonging to this task. No merge or deployment.

## Task 2: Remove deep integrity scans from the hot readiness path

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`
- Modify: `cloud-engineering-connector/test/worker.test.js`

**Interfaces:**
- Consumes: `OrchestratorLedger.ping()` and Worker `GET /readyz`.
- Produces: constant-work readiness metadata and a separate explicit deep-integrity diagnostic operation.

- [ ] **Step 1: Add failing readiness tests**
  
  Verify `ping()` confirms SQLite can execute `SELECT 1`, schema version, and required-table presence, but does not issue `PRAGMA quick_check`. Verify `/readyz` fails closed when required schema/tables or verifier configuration are absent. Verify the response never exposes SQL, paths, tenant payloads, or secrets.

- [ ] **Step 2: Observe the intended failure**
  
  Run: `npm run test:do -- --run cloudflare-test/orchestrator-ledger.test.js` and `node --test test/worker.test.js`.
  
  Expected RED: a spy/diagnostic assertion detects the deep integrity command on the hot path.

- [ ] **Step 3: Implement bounded readiness**
  
  Keep readiness to bounded metadata queries. Move full `PRAGMA quick_check` into a separately invoked maintenance/diagnostic method that is not called by every readiness request. Do not claim that `quick_check(1)` bounds total work; it bounds reported error rows, not necessarily scan cost.

- [ ] **Step 4: Verify**
  
  Run the identical focused commands.
  
  Expected: readiness tests pass; explicit diagnostic tests still detect SQLite corruption; failure remains fail-closed.

- [ ] **Step 5: Run connector integration tests and commit**
  
  Run: `npm test` and `npm run check`. Commit only readiness code and tests.

## Task 3: Introduce tenant/project-scoped orchestration records and additive schema migration

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/orchestrator-core.js`
- Modify: `cloud-engineering-connector/orchestrator-protocol.js`
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-claim-candidates.test.js`
- Create: `cloud-engineering-connector/docs/tenant-project-ledger-migration.md`

**Interfaces:**
- Consumes: authenticated `tenantId`, authorized `projectId`, task contract, idempotency key, input hash, worker assertion, and lease generation.
- Produces: versioned schema migration and task/lease/outbox operations that preserve tenant and project scope end-to-end.

- [ ] **Step 1: Add schema migration tests**
  
  Start from a populated schema-v7 fixture. Assert migration is additive, preserves every existing task/event/lease/outbox/receipt/audit row, and upgrades to the next schema version exactly once. Assert a second initialization is idempotent.

- [ ] **Step 2: Add cross-tenant negative tests**
  
  Test same task ID in different tenants, same idempotency key in different tenants, cross-tenant task lookup, cross-tenant claim, cross-tenant transition, cross-tenant lease renewal/release, cross-tenant outbox receipt replay, and cross-tenant audit query. A tenant A assertion must never read or mutate tenant B data.

- [ ] **Step 3: Implement additive tenant/project scope**
  
  Add tenant and project identity to task records, event records, processed-message deduplication, leases, candidate membership/cursors, outbox events, receipts, reconciliation evidence consumption, and audit records. Update unique keys and indexes to include the correct scope. Keep the existing global pooled Durable Object only as an initial deployment cell; logical authorization must be enforced for every query and mutation.

- [ ] **Step 4: Preserve fencing and query behavior**
  
  All claims and mutations must validate tenant/project scope before compare-and-set. Lease generation remains monotonic. Candidate selection remains bounded and deterministic by `(created_at, task_id)`; candidate membership updates remain synchronized with task/lease/assignment transitions. Never let a stale worker generation mutate a task after reassignment.

- [ ] **Step 5: Verify migration and query plans**
  
  Run: `npm run test:do -- --run cloudflare-test/orchestrator-ledger.test.js cloudflare-test/orchestrator-claim-candidates.test.js`.
  
  Expected: migration preserves old rows; all cross-tenant attacks fail closed; existing contention, reconciliation, keyset pagination, and fencing tests remain green; `EXPLAIN QUERY PLAN` confirms tenant/project predicates and composite keyset range use intended indexes.

- [ ] **Step 6: Run full connector tests and commit**
  
  Run: `npm test` and `npm run check`. Commit the schema migration and its tests together.

## Task 3 implementation evidence — incremental Ledger scope gates

The implementation is intentionally incremental; Task 3 remains open until every Ledger API, key constraint, query plan, and replay/recovery path is covered.

- Schema v8 adds tenant/project columns to all 15 Ledger tables and backfills task-linked rows only from persisted task projections. Unmapped historical records remain explicitly under `__legacy__`.
- Schema v9 migrates task and outbox idempotency values to an injective length-prefixed tenant/project namespace (`tp1:<tenant-length>:<tenant>:<project-length>:<project>:<key-length>:<key>`). Existing global UNIQUE constraints and primary identifiers are preserved; composite unique indexes enforce scoped key uniqueness. This avoids destructive table rebuilds while allowing the same caller key in independent tenant/project scopes.
- Public task APIs now require both tenant and project scope. Cross-tenant negative tests cover task transitions, claim, agent-round advancement, lease renewal/release, outbox admission, audit append, and message recording. Outbox receipt verification binds task-version checks to the source event's persisted tenant/project scope.
- TDD evidence: the outbox receipt regression test first failed because a receipt was accepted across scope; the fix passed. The idempotency test first failed with SQLite UNIQUE constraint on a shared caller key; schema v9 and scoped key derivation resolved it. Migration tests cover explicit tenant/project backfill, legacy-scope backfill, and repeat initialization.
- Latest exact-head verification at `9c155c602f19fe404a1921851e2ba83f397bd854`: 176 Node tests and 26 Vitest/Cloudflare tests passed; npm audit, syntax checks, Production/Staging Wrangler dry-runs, and Full History Secret Scan passed. Staging smoke was skipped.

Remaining Task 3 work includes message/outbox/event identifier constraints beyond idempotency, complete cross-tenant tests for every public/system path, independent query-plan review, and validation of reconciliation and replay behavior under failure injection. Do not treat this increment as complete end-to-end multi-tenant enforcement.

## Task 4: Add provider-neutral principal, membership, and project authorization seams

**Files:**
- Create: `cloud-engineering-connector/identity/principal.js`
- Create: `cloud-engineering-connector/identity/tenant-context.js`
- Create: `cloud-engineering-connector/identity/authorization.js`
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/test/credential-matrix.test.js`
- Create: `cloud-engineering-connector/test/tenant-authorization.test.js`
- Create: `cloud-engineering-connector/docs/identity-and-authorization-contract.md`

**Interfaces:**
- `resolvePrincipal({ request, env, now }) -> AuthenticatedPrincipal | AuthError`
- `resolveTenantContext({ principal, requestedTenantSelector, membershipStore }) -> TenantContext | AuthorizationError`
- `authorizeProjectAction({ principal, tenantContext, projectId, action, resource }) -> PolicyDecision`
- MCP tool arguments never accept an authoritative tenant ID. Project ID is an untrusted selector and is authorized server-side.

- [ ] **Step 1: Add boundary tests**
  
  Assert shared bearer credentials are classified as shared credentials, not unique humans. Assert a missing/invalid principal, absent membership, revoked membership, unknown tenant, unknown project, and cross-tenant project selector are denied before KnowledgeStore/Ledger access. Assert public read-only calls cannot reach private knowledge or orchestration operations.

- [ ] **Step 2: Observe RED**
  
  Run: `node --test test/tenant-authorization.test.js test/credential-matrix.test.js`.
  
  Expected RED: fixed-owner-only behavior cannot resolve a second authorized tenant and cannot distinguish tenant membership from project membership.

- [ ] **Step 3: Implement provider-neutral seams**
  
  Separate credential authentication from principal identity, tenant membership, project authorization, and action policy. Preserve current owner access only as an explicit bootstrap mapping. Do not treat the shared `MCP_AUTH_TOKEN` as per-user identity. Unknown or missing membership fails closed. Do not select or integrate a commercial IdP in this task.

- [ ] **Step 4: Verify isolation through the real MCP boundary**
  
  Exercise two distinct test principals and two tenants through `tools/call`; assert tenant A cannot read, search, write, sync, propose, inspect, claim, or mutate tenant B resources. Assert unauthorized requests do not invoke any Durable Object RPC.

- [ ] **Step 5: Run full connector suite and commit**
  
  Run: `npm test`, `npm audit --audit-level=moderate`, and `npm run check`.

## Task 5: Wire end-to-end task admission, scheduling, execution, and verification

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-github-intake.js`
- Modify: `cloud-engineering-connector/orchestrator-policy.js`
- Modify: `cloud-engineering-connector/orchestrator-core.js`
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/worker.js`
- Create: `cloud-engineering-connector/orchestrator-scheduler.js`
- Create: `cloud-engineering-connector/orchestrator-agent-runtime.js`
- Create: focused Node and Durable Object tests under `test/` and `cloudflare-test/`

**Interfaces:**
- `admitTask({ principal, tenantContext, projectId, request, idempotencyKey }) -> AdmissionResult`
- `scheduleEligibleTasks({ cellId, now, limit }) -> ScheduleResult`
- `executeClaimedTask({ task, lease, capabilitySnapshot, deadline }) -> ExecutionEvidence`
- `verifyTaskCompletion({ task, evidence, policyVersion, reviewer }) -> VerificationDecision`

- [ ] **Step 1: Add end-to-end contract tests**
  
  Assert unauthorized intake produces no ledger write; authorized intake creates exactly one task/outbox event; duplicate delivery with same fingerprint replays the same task; conflicting fingerprint is rejected; scheduler claims one eligible task with a fenced lease; expired/reassigned workers cannot complete; execution output is treated as untrusted; completion requires tests, policy, and independent review evidence.

- [ ] **Step 2: Observe RED**
  
  Run focused Node/Vitest tests for intake, scheduling, claims, lease renewal, outbox publication, and completion.
  
  Expected RED: current intake remains dry-run only and there is no Worker call path that completes admission → scheduling → execution → verification.

- [ ] **Step 3: Implement policy-gated runtime wiring**
  
  Keep GitHub webhook validation stateless until authentication, owner/tenant/project authorization, and idempotency checks pass. Commit task and outbox event in one Ledger transaction. Publish via Queue with deterministic event identity. Scheduler and agents receive short-lived task-bound assertions/capabilities. Every state transition verifies current lease generation and project scope. Agent output can propose changes but cannot approve policy, change protected branches, merge, or deploy Production.

- [ ] **Step 4: Add failure-injection tests**
  
  Cover timeout before/after Queue send, duplicate delivery, Queue retry, DLQ archive/replay, worker crash, expired lease, stale generation, signing-key rotation, invalid evidence, task cancellation/quarantine, and ambiguous GitHub write reconciliation.

- [ ] **Step 5: Verify**
  
  Run focused tests, then `npm test`, `npm audit --audit-level=moderate`, and `npm run check`. Expected: no lost task/outbox event, no duplicate side effect, no stale-worker mutation, and no unauthorized cross-project execution.

## Task 6: Bind immutable artifacts, evidence, and protected release approvals

**Files:**
- Modify: `cloud-engineering-connector/release-approval.js`
- Modify: `cloud-engineering-connector/scripts/verify-release-approval.mjs`
- Modify: `cloud-engineering-connector/scripts/write-release-evidence.mjs`
- Modify: `cloud-engineering-connector/test/release-approval.test.js`
- Modify: `cloud-engineering-connector/test/release-approval-contract.test.js`
- Modify: `.github/workflows/connector-staging-release.yml`
- Modify: `.github/workflows/connector-production-release.yml`

**Interfaces:**
- Release manifest includes release ID, tenant/project, source SHA, artifact digest, config/manifest digest, target environment, test/security evidence digests, and approval identity/time.
- `verifyReleaseApproval({ manifest, approval, environment, now }) -> VerifiedApproval | Rejection`.

- [ ] **Step 1: Add failing manifest-binding tests**
  
  Approval must be rejected if any of source SHA, artifact digest, configuration digest, target environment, evidence set, approver identity, or expiry changes. Reject self-approval, stale approval, outstanding change request, mutable tag references, and cross-environment approval reuse.

- [ ] **Step 2: Observe RED**
  
  Run: `node --test test/release-approval.test.js test/release-approval-contract.test.js`.
  
  Expected RED: every mutable or mismatched manifest dimension is not yet bound by the current approval contract.

- [ ] **Step 3: Implement immutable release manifest verification**
  
  Bind approval to all manifest digests. The Worker and CI must independently verify the same manifest. Production deployment and rollback remain disabled absent a direct human approval for the exact immutable manifest. Staging approval must not imply Production approval.

- [ ] **Step 4: Verify workflow guard behavior**
  
  Test wrong SHA, wrong branch, wrong environment, missing approval, self-approval, stale approval, missing secret binding names, artifact mismatch, and retry after partial deployment. Ensure secret values are never printed or read by the verification step.

- [ ] **Step 5: Run full release checks and commit**
  
  Run: `npm test`, `npm audit --audit-level=moderate`, `npm run check`, and workflow contract tests.

## Task 7: Multi-tenant operations, observability, recovery, and cost controls

**Files:**
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/orchestrator-outbox-publisher.js` (create only if absent after the clean port)
- Modify: `cloud-engineering-connector/test/orchestrator-outbox-publisher.test.js`
- Modify: `cloud-engineering-connector/test/worker.test.js`
- Create: `cloud-engineering-connector/docs/operations-and-recovery.md`

**Interfaces:**
- Privacy-safe events carry correlation ID, principal classification, tenant/project IDs only where policy permits, task/release IDs, bounded outcome, latency, and evidence digest.
- Recovery operations are idempotent and fenced; tenant-level usage counters are attributable without logging payloads or secrets.

- [ ] **Step 1: Add tests**
  
  Cover tenant-scoped queue backlog, fair scheduling, rate/concurrency quotas, per-tenant failure isolation, DLQ reconciliation, audit correlation, log redaction, and metrics cardinality bounds.

- [ ] **Step 2: Implement bounded operational telemetry**
  
  Do not emit raw prompts, tool arguments/results, credentials, source contents, or secret-bearing exception text. Separate liveness/readiness from deep diagnostics. Enforce quotas before expensive provider/model/execution operations.

- [ ] **Step 3: Verify recovery and observability**
  
  Run the focused Cloudflare tests, then the full suite. Expected: tenant A saturation does not starve tenant B beyond the configured fairness policy; DLQ and replay do not duplicate side effects; telemetry contains no secret or raw user payload.

## Task 8: Staging acceptance and migration readiness gate

**Files:**
- Modify only if required by verified failures: `cloud-engineering-connector/test/staging-smoke.mjs`, `cloud-engineering-connector/test/staging-smoke-contract.test.js`, `.github/workflows/connector-staging-release.yml`, and `cloud-engineering-connector/PRODUCTION_READINESS.md`.

**Interfaces:**
- Exact-SHA release candidate, immutable manifest, Staging environment approval, Cloudflare version ID, smoke evidence, rollback evidence.

- [ ] **Step 1: Run exact-head CI**
  
  Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `npm audit --audit-level=moderate`, `npm run check`, and Full History Secret Scan on the exact release SHA.

- [ ] **Step 2: Verify preflight without secret disclosure**
  
  Confirm required secret binding names/types and environment isolation only. Do not retrieve secret values. Verify Queue producers/consumers, Durable Object bindings/migrations, rate-limit namespaces, and active-version provenance.

- [ ] **Step 3: Deploy Staging only**
  
  Use the existing immutable-SHA Staging workflow after its exact PR/review/environment guards pass. Record deployed Worker version ID and source SHA.

- [ ] **Step 4: Execute live Staging smoke**
  
  Verify health, readiness, MCP initialize/tools, invalid bearer rejection, public read-only boundaries, two-tenant isolation, project authorization, task lifecycle, Queue delivery/replay, DLQ recovery, and rollback-to-prior-Staging-version behavior. A skipped smoke is a failed acceptance gate.

- [ ] **Step 5: Produce a signed evidence report**
  
  Report exact source SHA, artifact digest, Worker version ID, test/run IDs, findings, and remaining blockers. Production remains blocked and untouched.

## Commands and expected baseline

From `cloud-engineering-connector/` on Node 22:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm audit --audit-level=moderate
npm run check
```

Expected only after implementation: all Node and Vitest tests pass; npm audit reports no moderate-or-higher advisories; syntax checks and both Wrangler dry-runs pass. The exact counts must be recorded from the actual run and must not be inferred from earlier PR descriptions.

## Explicit unresolved product decisions

These decisions are not silently chosen by this plan. They gate the corresponding production capabilities:

1. Identity provider and authentication/session protocol. The code can define provider-neutral interfaces first; selecting and enabling an external IdP requires a separate product decision.
2. Tenant/project role matrix, delegation, invitation, suspension, and service-principal grant semantics. No broad default role grants are introduced.
3. Physical partitioning and dedicated-tenant thresholds. Initial implementation uses logical tenant/project isolation in the pooled cell; cell-isolated/dedicated placement is not activated without measured workload and threat-model evidence.
4. Cell migration and tenant move semantics, including cutover windows and rollback acceptance.
5. Data residency, tenant deletion, export, legal hold, retention, and backup/restore obligations.
6. SLO, RTO, RPO, availability targets, and the measurement period required to set them.
7. Billing and metering semantics, quota enforcement, and any paid model/hosting provider. No paid provider or billing enablement is assumed.
8. Agent/model provider catalog, data-processing boundaries, and model-specific retention/training controls.
9. Independent reviewer/trust-root policy for non-Production changes and the authorized human approver set for Production.
10. GitHub branch protection and required-check policy. The current connected GitHub integration could not read the protection endpoint; an authorized administrator must verify enforcement before merge readiness is asserted.

## Self-review checklist

- Every phase has exact observed or proposed files, explicit interfaces, tests, and commands.
- The plan preserves main and avoids the 1,704-commit integration ancestry.
- KnowledgeStore and OrchestratorLedger have non-overlapping data authority.
- Tenant/project scope is enforced at authentication, authorization, persistence, queue, artifact, and audit boundaries.
- Existing schema-v7 data is migrated additively and idempotently.
- Readiness performs bounded checks; deep integrity scans are explicit diagnostics.
- Task scheduling and execution are not called operational until the end-to-end path and live Staging acceptance pass.
- Production deployment and rollback remain human-gated.
