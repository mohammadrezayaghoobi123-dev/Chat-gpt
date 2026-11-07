# Production Readiness Remediation Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the verified code, runtime, security, recovery, and release-governance gaps before any Production release is considered.

**Architecture:** Preserve the Option C separation between KnowledgeStore and OrchestratorLedger. Keep all remediation changes on this branch and promote them through independently reviewed pull requests. Runtime changes are staged only after a trusted evidence gate, backup, and explicit operator approval; Production remains fail-closed.

**Tech Stack:** Cloudflare Workers, Durable Objects, Wrangler, GitHub Actions, JavaScript modules, GitHub REST API, Cloudflare API.

## Global Constraints

- Do not modify `main` directly.
- Do not deploy Production, alter Production traffic, or change Production secrets as part of this remediation branch.
- Do not treat CI success as runtime readiness.
- Do not trust caller-supplied booleans as proof of identity, approval, backup, restore, or authorization.
- Keep KnowledgeStore and OrchestratorLedger as separate Durable Object namespaces.
- All side effects must be idempotent or reconciled; exactly-once execution must not be claimed.
- Any missing trusted evidence must produce BLOCKED/NO-GO.
- Every release approval must bind to the exact repository, branch, full commit SHA, workflow run, and evidence digest.
- Preserve existing data. Durable Object migrations require a tested backup/restore plan and explicit operator approval.
- Never log credentials, token values, authorization headers, or secret-bearing request bodies.

---

### Task 1: Establish trusted evidence verification

**Files:**
- Create: `cloud-engineering-connector/evidence-verifier.js`
- Create: `cloud-engineering-connector/test/evidence-verifier.test.js`
- Modify: `cloud-engineering-connector/orchestrator-github-write-preflight.js`
- Modify: `cloud-engineering-connector/package.json` only if a focused test script is required

**Interfaces:**
- Consumes: exact repository, branch, head SHA, actor identity, review ID/state, workflow run ID/conclusion, backup artifact digest, stop-switch state, and evidence issuer metadata.
- Produces: `verifyReleaseEvidence(input, trustedSources) -> { decision: "PASS" | "BLOCKED", verifiedClaims, evidenceDigest, reasons }`.
- The verifier must obtain claims from authenticated trusted sources; it must not accept `authenticated=true`, `identityVerified=true`, or `backupRestoreVerified=true` as proof.

- [ ] **Step 1: Add focused failing tests**
  - Reject missing issuer signature, expired evidence, mismatched repository, mismatched branch, mismatched full SHA, stale review SHA, non-APPROVED review, author self-approval, failed/skipped workflow, missing backup digest, and active stop switch.
  - Accept only a fully signed, unexpired evidence bundle whose claims match independently fetched GitHub and backup-provider records.
  - Assert every failure returns BLOCKED and never authorizes execution.

- [ ] **Step 2: Verify the relevant failure**
  - Run: `npm test -- --runInBand test/evidence-verifier.test.js`
  - Expected: tests fail because the verifier module and trusted-source contract do not yet exist. Confirm the repository's actual test runner before using this command; adapt only to the existing runner.

- [ ] **Step 3: Implement the minimum verifier**
  - Define a versioned, canonical evidence envelope and deterministic digest.
  - Verify issuer signatures against configured public keys and enforce expiry/clock-skew bounds.
  - Fetch review, commit, workflow and repository identity from authenticated GitHub APIs; reject mismatched SHA and author identity.
  - Treat backup/restore evidence as valid only when an independently authenticated backup provider returns a matching artifact digest and completed restore-drill record.
  - Fail closed on unavailable sources, malformed claims, duplicate claim IDs, stale evidence, or source disagreement.

- [ ] **Step 4: Verify focused pass**
  - Run the focused evidence-verifier tests.
  - Expected: all positive and negative cases pass; no test uses caller-supplied booleans as trusted proof.

- [ ] **Step 5: Run affected integration checks**
  - Run the existing connector test suite and static checks.
  - Expected: existing P2-B behavior remains BLOCKED until the verifier has valid trusted evidence.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit only verifier, focused tests, and the preflight integration.

### Task 2: Make OrchestratorLedger Outbox bounded and recoverable

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/test/orchestrator-ledger-outbox.test.js`
- Modify: `cloud-engineering-connector/worker.js`

**Interfaces:**
- Consumes: existing Ledger lease/fencing APIs and an authenticated destination publisher.
- Produces: bounded outbox claim, completion, retry, quarantine, and reconciliation operations. Destination delivery must carry a stable idempotency key.

- [ ] **Step 1: Add focused failing tests**
  - Verify expired claims can be reclaimed only with a new fencing generation.
  - Verify attempts cannot exceed configured maximum.
  - Verify exhausted, malformed, or ambiguous deliveries move to QUARANTINED.
  - Verify crash-after-delivery-before-ack does not duplicate destination effects when the destination honors the stable idempotency key.
  - Verify completion from stale worker/generation is rejected.

- [ ] **Step 2: Verify the relevant failure**
  - Run the focused Ledger tests and capture the current unbounded retry / missing quarantine failures.

- [ ] **Step 3: Implement bounded lifecycle**
  - Add explicit retry policy with finite maximum attempts, bounded exponential backoff, and jitter.
  - Add QUARANTINED/DEAD_LETTER state and authenticated reconciliation operation.
  - Require current lease, worker identity, fencing generation, and record version for every state transition.
  - Never retry an ambiguous external side effect without destination idempotency or a verified reconciliation decision.
  - Connect a separate Ledger outbox publisher to the scheduled handler; isolate its failures from KnowledgeStore publication.

- [ ] **Step 4: Verify focused pass**
  - Run the Ledger and publisher tests with deterministic clock and injected crash points.

- [ ] **Step 5: Run affected integration checks**
  - Run all Durable Object tests, Worker route tests, and connector CI.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit Ledger lifecycle and publisher integration together.

### Task 3: Close GitHub Intake trust and replay gaps

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-github-intake.js`
- Create: `cloud-engineering-connector/github-webhook-auth.js`
- Create: `cloud-engineering-connector/test/github-webhook-auth.test.js`
- Modify: `cloud-engineering-connector/worker.js`

**Interfaces:**
- Consumes: raw webhook bytes, GitHub signature header, delivery ID, event header, and configured webhook secret.
- Produces: authenticated normalized event and durable replay decision; no task execution from an unauthenticated or duplicate delivery.

- [ ] **Step 1: Add focused failing tests**
  - Reject missing/invalid HMAC, altered raw body, unsupported event, missing delivery ID, duplicate delivery ID, stale timestamp where applicable, and oversized body.
  - Accept valid signature only when computed over the exact raw bytes.
  - Verify replay state survives Worker instance restart through durable storage.

- [ ] **Step 2: Verify the relevant failure**
  - Run webhook-auth and intake tests; capture failures for absent signature verifier and in-memory replay state.

- [ ] **Step 3: Implement**
  - Verify GitHub HMAC SHA-256 using constant-time comparison over raw request bytes.
  - Enforce request-size and time limits before parsing.
  - Persist delivery IDs with a bounded retention policy in a Durable Object or existing durable store.
  - Keep event normalization separate from authorization and task creation.
  - Return non-sensitive error responses and never log signature or secret values.

- [ ] **Step 4: Verify focused pass**
  - Run webhook-auth and intake tests including restart/replay scenarios.

- [ ] **Step 5: Run affected integration checks**
  - Run Worker routing, intake contract, and secret scan workflows.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit signature verification, durable replay store, and tests.

### Task 4: Align Runtime bindings, migrations, and scheduled execution

**Files:**
- Modify: `cloud-engineering-connector/wrangler.toml`
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/package.json`
- Create: `cloud-engineering-connector/test/runtime-contract.test.js`

**Interfaces:**
- Consumes: explicit Staging environment configuration and Durable Object migrations.
- Produces: machine-checkable expected Runtime inventory and readiness contract for KnowledgeStore, OrchestratorLedger, WriteControl, rate limiter, and scheduled handler.

- [ ] **Step 1: Add failing runtime contract tests**
  - Assert Staging declares each required binding and migration in the correct environment.
  - Assert scheduled handler invokes both KnowledgeStore and Ledger outbox processors independently.
  - Assert missing binding, missing migration, or missing Cron schedule yields not-ready.
  - Assert Production configuration cannot be changed by Staging release workflow.

- [ ] **Step 2: Verify failure**
  - Run Wrangler config validation and runtime contract tests against current configuration; capture missing binding and schedule mismatches.

- [ ] **Step 3: Implement**
  - Keep namespace class names and migration tags monotonic and compatible with deployed history.
  - Add explicit staging bindings and migrations only after a migration compatibility review.
  - Add scheduled dispatch with independent bounded execution and per-subsystem error reporting.
  - Readiness must inspect actual environment bindings and runtime capability, not Source declarations alone.
  - Add an inventory endpoint restricted to non-secret metadata.

- [ ] **Step 4: Verify focused pass**
  - Run Wrangler dry-run/config validation and runtime contract tests.

- [ ] **Step 5: Run affected integration checks**
  - Run connector CI and a Staging deployment preview; do not apply migrations in this task.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit runtime contract, Worker dispatch, and Wrangler changes.

### Task 5: Add backup/restore and external audit anchoring

**Files:**
- Create: `cloud-engineering-connector/backup-evidence.js`
- Create: `cloud-engineering-connector/audit-anchor.js`
- Create: `cloud-engineering-connector/test/backup-evidence.test.js`
- Create: `cloud-engineering-connector/test/audit-anchor.test.js`
- Modify: `cloud-engineering-connector/scripts/write-release-evidence.mjs`

**Interfaces:**
- Consumes: backup artifact ID/digest, restore drill record, audit chain root, trusted timestamp response, and independently authenticated storage provider.
- Produces: signed backup/restore attestation and externally anchored audit root, both bound to exact release SHA.

- [ ] **Step 1: Add failing tests**
  - Reject missing artifact, digest mismatch, restore failure, stale restore drill, untrusted timestamp, anchor write failure, and mismatched release SHA.
  - Verify evidence generation never upgrades a missing anchor to PASS.

- [ ] **Step 2: Verify failure**
  - Run focused tests and record missing provider integration.

- [ ] **Step 3: Implement**
  - Define provider adapters with explicit authentication and response schemas.
  - Store no secret values in evidence.
  - Sign canonical evidence and publish audit root to an independently administered immutable destination.
  - Record trusted timestamp provider response and verification material.
  - If no supported provider is configured, return BLOCKED; do not fabricate evidence.

- [ ] **Step 4: Verify focused pass**
  - Run tests with valid provider fixtures and negative failure fixtures.

- [ ] **Step 5: Run affected integration checks**
  - Run release-evidence tests and verify generated manifest binds exact SHA and evidence digest.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit adapters, tests, and evidence script integration.

### Task 6: Separate Staging and Production release authority

**Files:**
- Modify: `.github/workflows/connector-staging-release.yml`
- Modify: `.github/workflows/connector-production-release.yml`
- Modify: `cloud-engineering-connector/release-approval.js`
- Modify: `cloud-engineering-connector/scripts/verify-release-approval.mjs`
- Create: `cloud-engineering-connector/test/release-scope.test.js`

**Interfaces:**
- Consumes: release candidate SHA, environment-specific approval, evidence verifier output, and GitHub Environment protection result.
- Produces: staging-only workflow that cannot mutate Production and production workflow that refuses to run without a separately approved exact-SHA release.

- [ ] **Step 1: Add failing tests**
  - Reject staging workflow referencing Production environment, production secrets, production Worker name, or production deployment action.
  - Reject Production release without exact SHA, independent APPROVED review, required checks, verified backup/restore, audit anchor, and explicit Production Environment approval.
  - Reject approval for any SHA other than the release candidate.

- [ ] **Step 2: Verify failure**
  - Run workflow policy tests against the current PR diff and demonstrate the staging/production scope mismatch.

- [ ] **Step 3: Implement**
  - Remove Production workflow changes from the Staging candidate scope.
  - Require GitHub Environment protection and exact-SHA approval for Production.
  - Make all unavailable evidence and API errors fail closed.
  - Keep Production workflow inert until its separate release PR is approved.

- [ ] **Step 4: Verify focused pass**
  - Run release-scope and approval tests.

- [ ] **Step 5: Run affected integration checks**
  - Run all workflow lint/static checks, CI, and secret scan.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit Staging/Production workflow separation and tests.

### Task 7: Release governance and final acceptance

**Files:**
- Create: `docs/evidence/production-readiness-gate.md`
- Modify: `docs/evidence/orchestrator-p2b-write-preflight.md`
- Create: `cloud-engineering-connector/test/release-acceptance.test.js`

**Interfaces:**
- Consumes: exact SHA, official GitHub review, CI job conclusions, live Runtime inventory, MCP acceptance results, backup/restore attestation, audit anchor, rollback drill, and operator approval.
- Produces: signed PASS/NO-GO decision with evidence register and explicit owner for every unresolved risk.

- [ ] **Step 1: Add failing acceptance tests**
  - Reject skipped required jobs, stale review, self-approval, branch protection missing, Runtime drift, absent Cron, failed MCP auth tests, missing backup/restore, missing audit anchor, or absent rollback drill.
  - Accept only when every required gate is independently verified on the exact release SHA.

- [ ] **Step 2: Verify failure**
  - Run acceptance tests against current evidence and expect NO-GO for multiple independently confirmed blockers.

- [ ] **Step 3: Implement**
  - Generate an auditable gate report without exposing secrets.
  - Distinguish PASS, FAIL, and UNVERIFIED; treat FAIL and UNVERIFIED as release blockers.
  - Keep the Production release decision separate from Staging acceptance.

- [ ] **Step 4: Verify focused pass**
  - Run acceptance tests with synthetic complete and incomplete evidence sets.

- [ ] **Step 5: Run affected integration checks**
  - Run the complete repository CI suite and validate the final evidence report.

- [ ] **Step 6: Commit the passing deliverable**
  - Commit acceptance contract, report, and tests.

---

## External prerequisites and decision seams

These cannot be truthfully completed by code changes alone:

1. **Independent reviewer:** a genuinely independent GitHub user must have repository review permission and submit an official APPROVED review on the exact final SHA. A second account controlled by the repository author is not independent.
2. **GitHub governance:** repository owner/admin must enable branch protection or rulesets with required reviews, required status checks, no force-push, and no branch deletion for protected branches. Current connected tools do not expose a verified governance-write action.
3. **Cloudflare runtime authorization:** a Staging operator must approve irreversible Durable Object namespace migrations after a verified backup. No Production configuration or traffic change is authorized here.
4. **Trusted evidence providers:** owner must configure authenticated GitHub, backup/restore, timestamp, and immutable audit-anchor providers. If no provider is available, the release gate remains BLOCKED.
5. **MCP acceptance:** an authorized client/operator must run valid-token and invalid-token acceptance tests against the deployed Staging endpoint without disclosing token values.
6. **Production authorization:** separate explicit approval after Staging acceptance; no inferred authorization from this remediation request.

## Verification and acceptance criteria

- All focused tests and complete CI pass on the exact final SHA.
- No required release job is skipped.
- Runtime inventory matches the deployed Worker version and bindings.
- KnowledgeStore and OrchestratorLedger migrations are confirmed by Cloudflare Runtime evidence.
- Cron schedules are visible in Cloudflare API and scheduled executions are evidenced.
- MCP valid/invalid authentication tests pass.
- Backup and restore drill is independently attested.
- Audit root is externally anchored and timestamp-verifiable.
- Branch protection and independent GitHub approval are active on the exact SHA.
- Staging and Production workflows are isolated.
- Any missing or conflicting evidence yields NO-GO.

**Release rule:** Production remains NO-GO until every criterion above is independently evidenced. A green CI run, a code comment, or an operator assertion cannot substitute for a missing gate.
