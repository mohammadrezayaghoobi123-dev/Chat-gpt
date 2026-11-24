# Environment Deployment Review Actor Correlation Implementation Plan

> **Execution:** Native implementation on the isolated child branch security/deployment-review-actor-correlation-2026-11-24, targeting Draft PR #429. No merge or deployment.

**Goal:** Require the same immutable GitHub User ID to approve the exact candidate PR head and the deployment to the exact protected Environment for the current workflow run.

**Architecture:** Extend the existing release approval verifier to read the workflow run's review history through the GitHub REST GET approvals endpoint. Bind its approved Environment and numeric actor ID to the PR review already selected from the Environment allowlist. The current Actions: read permission is reused.

**Tech Stack:** Node.js 22 ESM, node:test, GitHub REST API, GitHub Actions workflow run context.

**Spec:** docs/superpowers/specs/2026-11-24-environment-deployment-review-actor-correlation-design.md

## Global Constraints

- Use GET only for the workflow run review history endpoint.
- Require one exact approved record for the release Environment.
- Require its numeric actor ID to equal the independent PR approver ID.
- Compare PR authors by numeric User ID.
- Use GITHUB_RUN_ID from github.run_id; fail closed if missing or malformed.
- Do not add GitHub permissions, secrets, variables, or external services.
- Keep the PR Draft and unmerged; do not change main, live Environments, Cloudflare, or deployment state.

## Review Focus

- No approval record for the target Environment: release must block.
- More than one record for the target Environment: release must block as ambiguous.
- Record is rejected or names another Environment: release must block.
- Missing, invalid, or non-positive approval actor ID: release must block.
- PR reviewer and Environment deployment reviewer are different valid users: release must block.
- PR author submits a review under a changed login name: numeric author identity must still exclude it.

---

### Task 1: Specify actor correlation with adversarial tests

**Files:**
- Modify: cloud-engineering-connector/test/release-approval.test.js
- Modify: cloud-engineering-connector/test/environment-protection-contract.test.js

- [x] Add same-actor success and mismatch, wrong Environment, rejected, missing/ambiguous, malformed actor, missing run ID, immutable author identity, and workflow run ID wiring tests.
- [x] Verify valid RED on CI run 45373113236: 461 Node tests; 449 passed, 12 failed on missing behavior/contract.

### Task 2: Implement read-only Environment deployment review verification

**Files:**
- Modify: cloud-engineering-connector/release-approval.js
- Modify: cloud-engineering-connector/scripts/verify-release-approval.mjs

**Interface:**
- verifyReleaseApproval receives workflowRunId as a positive safe integer.
- The verifier reads GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals.
- It requires exactly one approved record that names exactly the requested release Environment.
- The recorded deployment approver User ID must equal the non-author PR approver User ID selected from the Environment reviewer set.

- [x] Fail closed on missing, malformed, rejected, wrong-environment, or ambiguous deployment review data.
- [x] Exclude the PR author by numeric User ID.

### Task 3: Wire both release workflows and record evidence

**Files:**
- Modify: .github/workflows/connector-staging-release.yml
- Modify: .github/workflows/connector-production-release.yml
- Create: cloud-engineering-connector/docs/evidence/2026-11-24-environment-deployment-review-actor-correlation.md

- [x] Pass github.run_id to the approval verifier in both release workflows.
- [x] Preserve existing Actions: read; do not add write permissions.
- [x] Record valid RED, final GREEN, secret-scan split status, and live-release unknowns.

### Task 4: Final verification

- [x] Verify full Node and Vitest suites on the latest PR head.
- [x] Verify dependency audit, syntax checks, and Wrangler dry-runs.
- [x] Re-check Draft/unmerged chain and unchanged main SHA.
