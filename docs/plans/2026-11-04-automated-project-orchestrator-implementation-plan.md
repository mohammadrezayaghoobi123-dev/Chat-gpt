# Automated Project Orchestrator Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a zero-cost, policy-enforced project orchestrator for bounded engineering tasks, preserving KnowledgeStore as canonical knowledge and enabling real ChatGPT/Claude collaboration only when official authenticated zero-cost invocation is independently proven.

**Architecture:** GitHub remains authoritative for code, task intake, branches, CI, and reviews. Extend the existing Cloudflare SQLite Durable Object KnowledgeStore and its transactional outbox rather than introducing a second database or queue by default. Execute changes in isolated GitHub Actions jobs; keep Notion as a sanitized projection and preserve Master Brain's deterministic core.

**Tech Stack:** Node.js 22+, ES modules, Cloudflare Workers, SQLite-backed Durable Objects, Wrangler 4.155.0, Vitest 4.1.12, Node built-in test runner, GitHub Actions, GitHub REST/Webhooks.

## Global Constraints

- Strict zero-cost operation. No paid model APIs, hosting, queues, databases, plan upgrades, auto-reload, billing activation, or billable fallback.
- `main` remains unchanged. Implementation uses a new task-specific branch based on the approved integration branch after fresh preflight.
- Do not modify, merge, rebase, force-push, close, or otherwise alter PRs #145, #146, or #147.
- Never read, print, copy, rotate, or mutate secret values. Non-sensitive secret names and binding metadata may be inspected.
- No deployment, traffic shift, Worker production setting change, or live Staging/Production migration without separate explicit owner authorization.
- Agents cannot read/write secrets, change billing or permissions, change branch protection, merge protected branches, or deploy.
- GitHub is authoritative for code, task intake, branch/PR/CI/review evidence. KnowledgeStore remains canonical project knowledge under Option C. Notion is a non-authoritative management projection.
- The orchestrator is an additional coordination layer, not a replacement for Master Brain domain logic or canonical knowledge.
- Consumer ChatGPT/Claude subscriptions are not API credentials. No browser-session automation, cookie reuse, password sharing, quota bypass, or fabricated agent execution.
- Mock adapters prove protocol behavior only; they never prove live model integration.
- Unknown actor, scope, policy state, stop-switch state, branch/SHA, or approval state means deny and audit.
- Every external side effect requires durable idempotency, a valid lease/fencing token, and a fresh stop-switch check immediately before the effect.
- Maximum four automated agent-to-agent rounds per task, durably enforced across retries.
- No production-readiness claim without inspectable evidence and independent review.

---

## Repository Baseline and Observed Interfaces

The approved design branch is `design/automated-project-orchestrator-2026-11-04`, based on `integration/unify-main-and-integrated-2026-11-02` at `8830dfe8908bf1e44a86e592946fb84eacb51756`. At planning time, it is one commit ahead and zero behind; its only change is the approved architecture specification.

Observed paths and interfaces:

- `cloud-engineering-connector/worker.js`: existing MCP request handling, tool dispatch, repository allowlist, and scheduled outbox processing.
- `cloud-engineering-connector/index.js`: exports `WriteControl`, `KnowledgeStore`, and the Worker default.
- `cloud-engineering-connector/knowledge-store.js`: SQLite-backed `KnowledgeStore` Durable Object; schema version 3; existing `enqueueOutbox`, `claimOutbox`, `completeOutbox`, `deferOutbox`, `failOutbox`, and `getOutboxEvent` methods.
- `cloud-engineering-connector/write-control.js`: idempotent write-operation ledger and fencing-generation controls; it does not currently provide the project-wide orchestrator stop switch.
- `cloud-engineering-connector/wrangler.toml`: declares `WRITE_CONTROL` and `KNOWLEDGE_STORE` SQLite Durable Object bindings and migration tags v1/v2.
- `cloud-engineering-connector/package.json`: `npm run test:node`, `npm run test:do`, `npm test`, and `npm run check` are the existing validation entry points.
- `cloud-engineering-connector/cloudflare-test/knowledge-store.test.js`: existing Durable Object test conventions.
- `.github/workflows/connector-ci.yml`: existing Node 22 CI, npm audit, tests, and Wrangler dry-run checks.

Read-only infrastructure observations at planning time:

- The GitHub repository is public. Standard GitHub-hosted Actions runners for public repositories do not incur billable minutes.
- Cloudflare account inventory returned zero D1 databases and zero Queues.
- Durable Object inventory returned `WriteControl` for `chat-gpt111-staging` and two namespaces for `master-brain-cloud-agent`; it did not return a deployed `KnowledgeStore` namespace. Source and Wrangler configuration declare the class, so source/deployment drift is a preflight blocker.
- Production and Staging Workers were not changed or probed by this planning operation.
- Cloudflare free-tier limits are bounded. Queues have limited free operations and 24-hour free retention; do not add one by default. Prefer the existing SQLite outbox only after runtime activation and recovery behavior are proven.
- Anthropic API use requires Console authentication and is credit/billing-based; Free and Pro consumer subscriptions do not qualify for the monthly API-credit program. OpenAI API eligibility and any free allowance must be checked for the actual account and geography at P0; no free access is presumed.

## Delivery Plan

### Task 1: P0 read-only feasibility and repository preflight

**Files:**
- Create: `docs/evidence/2026-11-04-orchestrator-p0-preflight.md`
- Create: `.github/workflows/orchestrator-preflight.yml`
- Create: `cloud-engineering-connector/scripts/orchestrator-preflight.mjs`
- Test: `cloud-engineering-connector/test/orchestrator-preflight.test.js`
- Modify: `cloud-engineering-connector/package.json` (register only the new test and syntax-check paths)

**Interfaces:**
- `runPreflight({ github, cloudflareInventory, agentEligibility, repo, ref, sha })` returns `{ status, checks, blockers, evidenceRefs }`.
- The report records repository/ref/SHA, baseline tests, Cloudflare resources and plan limits, KnowledgeStore deployment evidence, official agent eligibility, reviewer identity, backup/restore, and explicit blockers.
- The workflow is `workflow_dispatch` plus PR validation; permissions are read-only: `contents: read`, `pull-requests: read`, `actions: read`.
- No secret values, write APIs, deployments, billing operations, or provider invocations.

- [ ] **Step 1: Add focused failing tests**

Test public-repository baseline, KnowledgeStore source-present/runtime-absent, no D1/Queues, unknown agent eligibility, missing independent reviewer, missing backup evidence, and redaction of secret-shaped values from reports.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-preflight.test.js`

Expected: tests fail because the report builder and workflow do not exist.

- [ ] **Step 3: Implement the minimum behavior**

Add a read-only workflow using Node 22, `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, and `npm run check`. The workflow has no deploy step. The report builder emits sanitized metadata and exact evidence references. Verify current branch topology and PR #145/#146/#147 heads without modifying them; inspect actual Cloudflare plan and live resources without reading secret values; check the KnowledgeStore namespace/readiness without migration; verify GitHub Actions permissions; assess OpenAI and Anthropic official invocation separately; and record independent-reviewer and external-backup status.

A temporary trial credit is not a sustainable free tier. If either model lacks a documented, account-eligible, no-card, no-billing, hard-zero-spend route, its adapter remains disabled.

- [ ] **Step 4: Verify the focused pass**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-preflight.test.js`

Expected: all report-builder tests pass, including fail-closed cases.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm test && npm run check`

Expected: existing tests pass and Wrangler dry-runs complete without deploying.

- [ ] **Step 6: Commit the passing deliverable**

Commit only the workflow, script, focused tests, package-script additions, and sanitized evidence report on the dedicated implementation branch.

**Gate:** If the KnowledgeStore namespace is absent, do not deploy it during P0. If either model has no verified zero-cost route, mark that adapter `DISABLED_BY_POLICY`.

### Task 2: P1 versioned task/message contracts and deterministic state machine

**Files:**
- Create: `cloud-engineering-connector/orchestrator/contracts.js`
- Create: `cloud-engineering-connector/orchestrator/state-machine.js`
- Create: `cloud-engineering-connector/test/orchestrator-contracts.test.js`
- Create: `cloud-engineering-connector/test/orchestrator-state-machine.test.js`
- Modify: `cloud-engineering-connector/package.json`

**Interfaces:**
- `validateTask(input)` and `validateEnvelope(input)` return versioned validated contracts or typed errors.
- `canTransition(currentState, nextState, evidence)` returns `{ allowed, reason }`.
- `MAX_AGENT_ROUNDS = 4`.
- States: `RECEIVED`, `VALIDATING`, `READY`, `SCHEDULED`, `RUNNING`, `VERIFYING`, `REVIEW_PENDING`, `COMPLETED`, `BLOCKED`, `FAILED`, `CANCELLED`, `DISPUTED`, `QUARANTINED`, `RETRY_WAIT`.

- [ ] **Step 1: Add focused failing tests**

Test unique task/message IDs, correlation/parent IDs, input hash, expiry, task type, explicit path/operation scope, acceptance criteria, dependency/evidence references, and durable four-round enforcement. Test all legal transitions and reject direct `RUNNING → COMPLETED`, `FAILED → COMPLETED`, and completion without verification/review evidence.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-contracts.test.js test/orchestrator-state-machine.test.js`

Expected: tests fail because the modules do not exist.

- [ ] **Step 3: Implement the minimum behavior**

Use pure functions with no Cloudflare, GitHub, filesystem, network, or model-provider dependencies. Treat Issue bodies, PR comments, repository files, and model output as untrusted data. A self-declared sender name never establishes identity. Preserve the approved state names and four-round limit.

- [ ] **Step 4: Verify the focused pass**

Run the same Node test command.

Expected: all contract and state-transition tests pass.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm run test:node`

Expected: all existing and new Node suites pass.

- [ ] **Step 6: Commit the passing deliverable**

Commit only contract/state-machine modules, tests, and package-script registration.

### Task 3: P1 durable task ledger using the existing KnowledgeStore

**Files:**
- Modify: `cloud-engineering-connector/knowledge-store.js`
- Modify: `cloud-engineering-connector/cloudflare-test/knowledge-store.test.js`
- Create: `cloud-engineering-connector/orchestrator/ledger.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`
- Modify: `cloud-engineering-connector/wrangler.toml` only if an additive SQLite class migration is proven necessary
- Modify: `cloud-engineering-connector/package.json`

**Interfaces:**
- Durable Object methods: `createTask(input)`, `getTask(input)`, `appendTaskEvent(input)`, `transitionTask(input)`, `recordMessage(input)`, `claimTask(input)`, `setStopSwitch(input)`, `getStopSwitch(input)`.
- `recordMessage` returns `{ inserted, priorResult }`; duplicate message IDs are no-ops.
- `claimTask` returns a monotonically increasing fencing token; stale tokens cannot commit.
- Existing outbox methods remain backward-compatible and are reused for dispatch.

- [ ] **Step 1: Add focused failing Durable Object tests**

Test migration from schema v3 to v4 without data loss; task creation and idempotent replay; conflicting idempotency keys; append-only events; expected-state compare-and-set; tenant isolation; duplicate messages; lease expiry; stale fencing rejection; stop-switch persistence; and outbox retry/dead-letter behavior.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && npm run test:do -- --run cloudflare-test/orchestrator-ledger.test.js`

Expected: tests fail because the new ledger tables/methods are absent.

- [ ] **Step 3: Implement the minimum behavior**

Additive SQLite tables cover tasks, task events, processed message IDs, execution leases, approvals, policy decisions, agent capability snapshots, control state, and audit events. Enforce unique task idempotency and message IDs. Store state transitions as events and current state as a projection. Reuse `knowledge_outbox`; do not create D1 or Queues. Use `transactionSync` for multi-row state transitions and compare-and-set. Keep all records tenant-scoped and exclude secret values.

The stop switch defaults to enabled until an authenticated owner-controlled activation exists. An unreadable control row is treated as enabled.

- [ ] **Step 4: Verify the focused pass**

Run: `cd cloud-engineering-connector && npm run test:do -- --run cloudflare-test/orchestrator-ledger.test.js cloudflare-test/knowledge-store.test.js`

Expected: ledger and existing KnowledgeStore tests pass; schema version is 4; existing Option C entities/documents remain readable.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm run test:do`

Expected: all Durable Object suites pass, including existing write-control and KnowledgeStore retention tests.

- [ ] **Step 6: Commit the passing deliverable**

Commit only additive KnowledgeStore schema/methods, ledger adapter, focused tests, and package-script updates.

### Task 4: P1 deterministic policy engine and orchestration core

**Files:**
- Create: `cloud-engineering-connector/orchestrator/policy.js`
- Create: `cloud-engineering-connector/orchestrator/core.js`
- Create: `cloud-engineering-connector/test/orchestrator-policy.test.js`
- Create: `cloud-engineering-connector/test/orchestrator-core.test.js`
- Modify: `cloud-engineering-connector/package.json`

**Interfaces:**
- `evaluatePolicy({ actor, action, task, branch, stopSwitch, capability, approval })` returns `{ allowed, decisionCode, reason }`.
- `intakeTask(input, deps)` validates and persists a task plus outbox event.
- `scheduleTask(taskId, deps)` checks dependencies, scope, capability, quota, and stop switch.
- `processAgentMessage(envelope, deps)` deduplicates and checks authenticated sender, correlation, scope, expiry, and round count.
- `requestCancellation(taskId, actor, deps)` records cancellation and prevents further effects.
- `runDispatchCycle(deps)` processes a bounded number of outbox events and never invokes an unverified adapter.

- [ ] **Step 1: Add focused failing tests**

Deny missing/unknown actors, unknown scope/branch, missing acceptance criteria/capability, exhausted quota, active or unreadable stop switch, protected branch, secret/billing/permission/deployment actions, missing independent approval, duplicate/expired/mismatched messages, and fifth agent round. Test transient failures as `RETRY_WAIT`; permanent policy failures as `BLOCKED` or `QUARANTINED`; conflicting findings as `DISPUTED`.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-policy.test.js test/orchestrator-core.test.js`

Expected: tests fail because policy/core modules do not exist.

- [ ] **Step 3: Implement the minimum behavior**

Keep core and policy deterministic and dependency-injected. No direct network/provider SDK calls. Re-read stop-switch state and verify lease fencing immediately before each external effect. Never allow task text or model output to expand stored scope. Use durable outbox/idempotency for each effect. Retry only classified transient failures with bounded exponential backoff and jitter; never auto-retry authorization, scope, signature, or stop-switch failures.

- [ ] **Step 4: Verify the focused pass**

Run the same Node test command.

Expected: all policy/core tests pass, including deny-by-default and replay cases.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm run test:node`

Expected: all Node suites pass without changing existing MCP behavior.

- [ ] **Step 6: Commit the passing deliverable**

Commit only policy/core modules, tests, and package-script registration.

### Task 5: P2 authenticated GitHub intake and isolated execution workers

**Files:**
- Create: `cloud-engineering-connector/orchestrator/github-webhook.js`
- Create: `cloud-engineering-connector/orchestrator/github-adapter.js`
- Create: `cloud-engineering-connector/test/orchestrator-github-webhook.test.js`
- Create: `cloud-engineering-connector/test/orchestrator-github-adapter.test.js`
- Create: `.github/workflows/orchestrator-worker.yml`
- Modify: `cloud-engineering-connector/worker.js` (add a separate webhook route; preserve current MCP routes)
- Modify: `cloud-engineering-connector/package.json`

**Interfaces:**
- `verifyGitHubWebhook({ rawBody, signature256, secret })` verifies the exact raw body with HMAC-SHA256.
- `acceptGitHubDelivery({ deliveryId, eventName, payload, deps })` performs durable delivery deduplication and task intake.
- `createTaskBranch({ taskId, baseRef, allowedPaths, githubClient })` creates a task branch only after policy authorization.
- Worker input is task ID plus exact base SHA; output includes commit SHA, changed paths, workflow run ID, test results, and evidence references.

- [ ] **Step 1: Add focused failing tests**

Test valid/invalid/missing signatures, altered body, missing/duplicate delivery ID, unsupported event, sender-ID mismatch, replay, oversized payload, prompt injection, scope escalation, protected-branch target, branch collision, and minimal workflow permissions.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-github-webhook.test.js test/orchestrator-github-adapter.test.js`

Expected: tests fail because GitHub intake modules do not exist.

- [ ] **Step 3: Implement the minimum behavior**

Verify signature before parsing. Use `X-GitHub-Delivery` as the durable replay/deduplication key; do not assume GitHub supplies a signed timestamp header. Derive actor ID from the signed payload's `sender.id` and compare it with separately configured owner/reviewer identity. Restrict repository/event types to the approved intake contract.

Run the worker in an isolated task workspace/branch. Grant only the minimum task permissions. It may open a draft PR but may not merge, deploy, mutate secrets, change repository settings, or write to `main`. Pin Actions by full commit SHA. Do not add a broad PAT or admin token. If no already-authorized least-privilege GitHub App/token exists, stop at queueing and record the blocker; do not create or rotate secrets.

- [ ] **Step 4: Verify the focused pass**

Run the same Node test command.

Expected: all signature, replay, actor, branch-scope, and permission-contract tests pass.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm test && npm run check`

Expected: existing tests pass and Wrangler dry-runs validate configuration without deployment.

- [ ] **Step 6: Commit the passing deliverable**

Commit only GitHub intake/adapter modules, Worker route, workflow, tests, and package-script updates.

### Task 6: P4 agent adapter contract and zero-cost capability gating

**Files:**
- Create: `cloud-engineering-connector/orchestrator/agent-adapter.js`
- Create: `cloud-engineering-connector/orchestrator/adapters/mock.js`
- Create: `cloud-engineering-connector/test/orchestrator-agent-adapter.test.js`
- Conditional only after P0 passes: `cloud-engineering-connector/orchestrator/adapters/openai.js`
- Conditional only after P0 passes: `cloud-engineering-connector/orchestrator/adapters/anthropic.js`
- Modify: `cloud-engineering-connector/package.json`

**Interfaces:**
- `getCapability()` returns `AVAILABLE_VERIFIED_FREE`, `AVAILABLE_LIMITED_FREE`, `UNAVAILABLE`, `AUTHENTICATION_UNVERIFIED`, `QUOTA_EXHAUSTED`, or `DISABLED_BY_POLICY`.
- `invoke({ task, envelope, signal })` returns `{ provider, authenticatedIdentity, responseRef, usage, completedAt }`.
- `MockAdapter` is test-only and every result is explicitly marked `mock: true`.

- [ ] **Step 1: Add focused failing tests**

Test capability-state transitions, aborts, timeouts, provider errors, quota exhaustion, usage accounting, authenticated identity, and mock labeling. A mock result must never satisfy a live-provider acceptance check.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-agent-adapter.test.js`

Expected: tests fail because the adapter contract does not exist.

- [ ] **Step 3: Implement the minimum behavior**

Implement the generic contract and deterministic mock. Do not create live OpenAI/Anthropic adapters unless P0 documents official, authenticated, account-eligible zero-cost invocation with no card, no billing activation, no auto-reload, no paid fallback, and a testable hard spend ceiling. If either route fails, keep that adapter disabled and tasks `BLOCKED`. Do not emulate browser interaction or claim a model was invoked.

- [ ] **Step 4: Verify the focused pass**

Run the same Node test command.

Expected: contract/mock tests pass; live adapter tests remain explicitly gated with a recorded policy reason when P0 eligibility is absent.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm test`

Expected: all deterministic adapter and existing connector tests pass.

- [ ] **Step 6: Commit the passing deliverable**

Commit only the generic adapter contract, test-only mock, tests, and package-script updates. Provider-specific adapters require a separate reviewed task after P0 passes.

### Task 7: P5 security, concurrency, recovery, observability, and release evidence

**Files:**
- Create: `cloud-engineering-connector/test/orchestrator-security.test.js`
- Create: `cloud-engineering-connector/test/orchestrator-recovery.test.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-recovery.test.js`
- Create: `cloud-engineering-connector/orchestrator/audit.js`
- Create: `docs/runbooks/orchestrator-operations.md`
- Create: `docs/runbooks/orchestrator-recovery.md`
- Modify: `cloud-engineering-connector/package.json`
- Modify: `.github/workflows/connector-ci.yml` only to include new tests and static checks.

**Interfaces:**
- `appendAuditEvent(input)` records task/execution/correlation IDs, authenticated actor, policy decision, branch/base/result SHA, changed paths, workflow IDs, retry count, lease generation, and sanitized evidence references.
- `verifyAuditChain(events, checkpoint)` detects internal chain discontinuity but does not claim external tamper-proofing.
- Runbooks define pause, resume, cancellation, quota exhaustion, stale lease, unknown side-effect outcome, backup restore, and escalation.

- [ ] **Step 1: Add focused failing tests**

Test 100 duplicate deliveries yielding one effective side effect; concurrent workers and single valid lease; stale worker rejection; crash injection at every side-effect boundary; outbox restart recovery; stop-switch checks before every effect; invalid signature/replay/path traversal/symlink escape/cross-task leakage/secret-shaped content/prompt injection; disputed findings; reviewer absence; audit-chain modification detection; and sanitized Notion projection.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-security.test.js test/orchestrator-recovery.test.js`

Expected: tests fail because the audit and recovery suites do not exist.

- [ ] **Step 3: Implement the minimum behavior**

Implement append-only audit events, chain verification, bounded retry/backoff with jitter, GitHub reconciliation for unknown outcomes, stop-switch rechecks immediately before effects, and sanitized structured logs. Document backup retention and restore verification. A hash chain is not an external trust anchor; production requires a checkpoint outside the primary Cloudflare/GitHub control plane and a successful restore drill.

- [ ] **Step 4: Verify the focused pass**

Run the same Node test command.

Expected: all security/recovery tests pass, including concurrency and crash-injection cases.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm test && npm run check && npm audit --audit-level=moderate`

Expected: all Node/DO tests pass, Wrangler dry-runs pass, and no unresolved moderate-or-higher npm advisory remains.

- [ ] **Step 6: Commit the passing deliverable**

Commit only audit/recovery modules, runbooks, tests, and CI updates.

### Task 8: P6/P7 release evaluation (separate owner authorization required)

**Files:**
- Create: `docs/evidence/orchestrator-staging-acceptance.md`
- Create: `docs/evidence/orchestrator-production-readiness.md`
- Create: `docs/runbooks/orchestrator-rollback.md`
- Create: `cloud-engineering-connector/test/orchestrator-release-evidence.test.js`
- No Worker production configuration, secrets, traffic weights, branch protection, or deployment workflow changes until separately authorized.

**Interfaces:**
- Staging acceptance binds every result to exact branch, commit SHA, deployment ID, and workflow run ID.
- Production-readiness evidence records all gate outcomes, independent reviewer identity, cost/quota evidence, backup/restore evidence, rollback result, and explicit owner-authorization reference.

- [ ] **Step 1: Add contract tests for release evidence**

Test missing SHA, mismatched deployment SHA, missing independent review, missing backup/restore evidence, unverified agent identity, and quota/billing ambiguity. Every case must fail closed.

- [ ] **Step 2: Verify the relevant failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-release-evidence.test.js`

Expected: tests fail until the release-evidence validator exists.

- [ ] **Step 3: Implement the minimum behavior**

Implement evidence validation and runbooks only. Actual Staging deployment, live migration, traffic shift, and Production deployment are outside this plan's authorization and require a separate owner instruction after independent review.

- [ ] **Step 4: Verify the focused pass**

Run the same Node test command.

Expected: exact-SHA evidence passes; missing or ambiguous gates are denied.

- [ ] **Step 5: Run the affected integration check**

Run: `cd cloud-engineering-connector && npm test && npm run check`

Expected: full test suite and dry-run checks pass without deployment.

- [ ] **Step 6: Commit the passing deliverable**

Commit only release-evidence validators and runbooks. Do not deploy or merge protected branches.

---

## Release Gates

- **G0 Architecture:** approved specification and this implementation plan are active contracts.
- **G1 Repository:** implementation branch is based on the approved integration SHA; protected PRs and `main` remain untouched.
- **G2 Functional:** task contract, state machine, ledger, policy, and GitHub intake tests pass.
- **G3 Security:** signature, replay, identity, scope, stop-switch, redaction, and permission tests pass.
- **G4 Integration:** exact-SHA CI, Worker dry-run, KnowledgeStore schema, and outbox recovery tests pass.
- **G5 Agent coordination:** protocol, durable deduplication, four-round limit, capability states, and mock/live distinction pass.
- **G6 Reliability:** concurrency, fencing, crash recovery, retry, backup, and restore tests pass.
- **G7 Independent review:** a distinct, independently authenticated reviewer approves the exact candidate SHA.
- **G8 Staging:** owner-authorized Staging deployment and live acceptance pass.
- **G9 Production:** separate security sign-off, cost review, rollback drill, operational runbook, and explicit owner authorization pass.

No gate inherits approval from another SHA. No test-only/mock result satisfies a live integration gate.

## Unresolved External Decisions (must be closed with evidence, not guessed)

1. **KnowledgeStore runtime activation:** Cloudflare lists no deployed `KnowledgeStore` namespace although the repository declares the class. Determine whether Staging can be safely migrated after read-only validation; any live migration requires separate owner authorization.
2. **OpenAI invocation eligibility:** verify an official, authenticated, no-card, no-billing, zero-cost API allowance for the actual account and a hard zero-spend guard. Otherwise the ChatGPT API adapter remains disabled.
3. **Anthropic invocation eligibility:** verify an official, authenticated, sustainable zero-cost API route for the actual account. Trial credits are not presumed to be a permanent free tier. Otherwise the Claude adapter remains disabled.
4. **Independent reviewer:** identify a reviewer whose authenticated identity is distinct from the owner automation account and both agent identities.
5. **External audit checkpoint and backup owner:** identify a no-cost destination outside the primary control plane and an accountable owner for retention/restore drills.
6. **Task-level GitHub write authority:** verify an existing GitHub App/token can create only task branches and draft PRs with least privilege. If unavailable, intake remains read-only until credential provisioning is separately authorized.

## Completion Definition

The first usable release is a deterministic, auditable task coordinator that can safely intake, validate, persist, schedule, execute bounded repository tasks, verify exact-SHA evidence, and pause safely when a capability is unavailable. Full two-model autonomy is a separate acceptance outcome and remains blocked unless both live official zero-cost integrations are independently proven. Production is not ready until G0–G9 have inspectable evidence and separate owner authorization.
