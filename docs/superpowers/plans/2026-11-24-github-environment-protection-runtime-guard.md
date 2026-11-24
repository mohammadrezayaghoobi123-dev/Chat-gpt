# GitHub Environment Protection Runtime Guard Implementation Plan

> **Execution:** Native, in the isolated GitHub branch `security/github-environment-protection-runtime-guard-2026-11-24`; preserve the Draft dependency chain and do not merge.

**Goal:** Block Staging and Production releases unless GitHub confirms the actual Environment has required independent review, self-review prevention, no administrator bypass, and exactly one matching release-branch policy.

**Architecture:** A small Node.js verifier reads only the GitHub Environment metadata and deployment-branch-policy endpoints with the workflow's read-only `GITHUB_TOKEN`. Pure validation and paginated API retrieval are separated so adversarial unit tests can falsify each control independently. Both release workflows execute the guard before mapping any Environment secret into a step.

**Tech Stack:** Node.js 22 ESM, `node:test`, GitHub REST API with `actions: read`.

**Spec:** PR #421 and the live GitHub Environment audit performed on 2026-11-24.

## Global Constraints

- Do not read Environment secrets or variables.
- Do not call any mutating GitHub endpoint.
- The workflow token receives `actions: read`, `pull-requests: read`, and `contents: read` only.
- `staging` must allow exactly `integration/staging-release-*`.
- `production` must allow exactly `integration/production-release-*`.
- Required reviewers must be non-empty and `prevent_self_review` must be true.
- `can_admins_bypass` must be false.
- Any missing, malformed, incomplete, or denied metadata must fail closed.
- Keep the new work Draft and based on PR #421; do not merge, deploy, or modify `main`.

## Review Focus

- Missing Environment or 404 response: release must fail before credential mapping.
- 401/403 or malformed response: release must fail without logging credentials or response bodies.
- Empty reviewer set or disabled self-review prevention: release must fail.
- Administrator bypass enabled or omitted: release must fail.
- Null, protected-branch-only, missing, widened, or paginated extra branch policies: release must fail.

---

### Task 1: Specify the contract with adversarial tests

**Files:**
- Create: `cloud-engineering-connector/test/environment-protection.test.js`
- Create: `cloud-engineering-connector/test/environment-protection-contract.test.js`
- Modify: `cloud-engineering-connector/package.json`

- [ ] Register both tests in `test:node` and syntax checks.
- [ ] Prove the verifier and workflow guard are absent on the baseline; CI must show the expected RED failures.

### Task 2: Implement metadata-only verification

**Files:**
- Create: `cloud-engineering-connector/scripts/verify-environment-protection.mjs`

**Interface:**
- Export `verifyEnvironmentProtection({ repository, releaseEnvironment, token, fetchImpl })`.
- Return only `{ environment, branchPattern, requiredReviewerCount }`.
- Use GET only for `/environments/{name}` and `/deployment-branch-policies`.
- Validate complete pagination, exact branch-policy set, reviewer rule, self-review prevention, and administrator bypass.

- [ ] Implement the minimal verifier.
- [ ] Prove RED becomes GREEN with the focused tests.

### Task 3: Bind both release workflows to the verified contract

**Files:**
- Modify: `.github/workflows/connector-staging-release.yml`
- Modify: `.github/workflows/connector-production-release.yml`
- Modify: `cloud-engineering-connector/package.json`

- [ ] Add `actions: read` without widening any existing permission.
- [ ] Invoke the verifier immediately after Node setup and before approval/credential-bearing steps.
- [ ] Inject only `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and the fixed `RELEASE_ENV` into the guard step.
- [ ] Keep Cloudflare and MCP credentials outside the guard step and job-wide environment.

### Task 4: Record evidence and review the final diff

**Files:**
- Create: `cloud-engineering-connector/docs/evidence/2026-11-24-github-environment-protection-runtime-guard.md`

- [ ] Record exact CI run IDs, test counts, the deliberate RED result, final GREEN result, API scope, and residual unknowns.
- [ ] Re-read the final diff and verify the base branch and `main` SHA are unchanged.
