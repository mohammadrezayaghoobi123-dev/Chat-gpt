# GitHub Environment Read-Only Preflight Implementation Plan

> **Execution:** Native implementation on the isolated branch `security/environment-read-only-preflight-2026-11-24`, as a Draft child of PR #430. No merge or deployment.

**Goal:** Obtain a live, read-only GitHub Environment protection report for Staging and Production without creating missing Environments or reading credentials.

**Architecture:** Reuse `verifyEnvironmentProtection` for each fixed Environment. Catch each target's result independently, classify it as READY/BLOCKED/MISSING/UNKNOWN, and render a sanitized step summary. A dedicated push-triggered workflow grants only `actions: read` and `contents: read`; it deliberately has no job-level `environment:` property.

**Tech Stack:** Node.js 22 ESM, `node:test`, GitHub REST API, GitHub Actions Step Summary.

**Spec:** `docs/superpowers/specs/2026-11-24-github-environment-read-only-preflight-design.md`

## Global Constraints

- Call the existing Environment verifier; do not duplicate its security policy.
- Inspect both `staging` and `production` even when one fails.
- Classify 404 as MISSING, policy mismatch as BLOCKED, and transport/permission/schema uncertainty as UNKNOWN.
- Use GET only, with Actions read and Contents read.
- Do not declare a GitHub Actions job-level Environment.
- Do not access Secrets, Variables, Cloudflare, or deployment APIs.
- Keep the workflow trigger restricted to `security/environment-read-only-preflight-*`.
- Keep the PR Draft/unmerged and leave `main` unchanged.

## Review Focus

- Staging is blocked but Production is still queried.
- Production is absent and is reported as MISSING, not auto-created.
- GitHub returns 401/403: classify UNKNOWN without leaking response bodies.
- GitHub returns malformed JSON or incomplete pagination: classify UNKNOWN.
- Environment exists but reviewer, bypass, self-review, or branch policy settings are wrong: classify BLOCKED.
- Report output must not expose reviewer IDs, token values, or raw API payloads.

---

### Task 1: Specify audit output and status behavior

**Files:**
- Create: `cloud-engineering-connector/test/environment-preflight.test.js`
- Create: `cloud-engineering-connector/test/environment-preflight-contract.test.js`

- [ ] Add behavior tests for READY, BLOCKED, MISSING, UNKNOWN, and continue-after-first-target-failure.
- [ ] Add workflow contract tests for push scope, minimum permissions, no job-level Environment, no Secret/Variable use, and no deploy operations.
- [ ] Run CI and record valid RED failures.

### Task 2: Implement the read-only audit script

**Files:**
- Create: `cloud-engineering-connector/scripts/audit-environment-protection.mjs`

**Interface:**
- Export `auditEnvironmentProtection({ repository, token, fetchImpl })`.
- Return a frozen report with fixed target outcomes and an overall `ready` boolean.
- Export `renderEnvironmentAuditSummary(report)` with reviewer counts only; never user IDs.
- CLI writes `GITHUB_STEP_SUMMARY` and returns non-zero unless both targets are READY.

- [ ] Implement independent per-target collection using the existing verifier.
- [ ] Classify 404 as MISSING, policy mismatches as BLOCKED, and all unverified API states as UNKNOWN.
- [ ] Verify exact behavior against all RED tests.

### Task 3: Add the isolated GitHub Actions workflow

**Files:**
- Create: `.github/workflows/environment-read-only-preflight.yml`

- [ ] Trigger only on push to `security/environment-read-only-preflight-*`.
- [ ] Grant only `actions: read` and `contents: read`.
- [ ] Omit job-level `environment:` and every Secret/Variable mapping.
- [ ] Invoke the audit script; do not include deployment steps.

### Task 4: Verify and record evidence

**Files:**
- Create: `cloud-engineering-connector/docs/evidence/2026-11-24-github-environment-read-only-preflight.md`

- [ ] Record the live per-target outcomes from the GitHub Actions run.
- [ ] Verify the workflow contains no write-capable API calls or deployment steps.
- [ ] Record final Node/Vitest, syntax, npm audit, and workflow run evidence.
- [ ] Confirm PR remains Draft and `main` SHA is unchanged.
