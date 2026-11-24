# GitHub Environment Full Posture Census Implementation Plan

> **For agentic workers:** Native implementation in the current session. Steps use checkbox syntax for tracking.

**Goal:** Collect all independently verifiable Staging and Production Environment protection controls without allowing the first violation to hide subsequent findings.

**Architecture:** Add one shared `inspectEnvironmentProtection` API. The existing release verifier enforces its complete result and remains fail-closed; the read-only audit consumes the same result and emits all sanitized findings.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, GitHub REST API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-24-environment-full-posture-census-design.md`

## Global Constraints

- GET-only Environment and deployment-branch-policy requests.
- Use existing `actions: read` and `contents: read` permissions only.
- Fixed targets: `staging` and `production`.
- Never bind the audit Job to a GitHub Environment.
- Never read Environment Secrets or Variables.
- Never print reviewer IDs, token values, or raw API bodies.
- Keep `verifyEnvironmentProtection` fail-closed for every non-READY inspection.
- No live GitHub writes, Cloudflare calls, deployments, or `main` changes.

## Review Focus

- Administrator bypass enabled while branch policy is otherwise readable.
- Self-review enabled while reviewer identities and branch patterns remain readable.
- Custom branch policies disabled: do not call their dependent list endpoint.
- Custom branch policies enabled but branch-policy endpoint returns 404: preserve UNKNOWN alongside other findings.
- Environment missing, denied, malformed, pagination-incomplete, or contradictory API responses.

---

### Task 1: Add adversarial posture-inspection tests

**Files:**
- Modify: `cloud-engineering-connector/test/environment-protection.test.js`
- Modify: `cloud-engineering-connector/test/environment-preflight.test.js`

- [ ] Test that bypass/self-review violations do not prevent branch-policy retrieval when custom policies are explicitly enabled.
- [ ] Test that every independent finding is retained in one immutable report.
- [ ] Test that branch-policy 404 remains UNKNOWN without erasing independent BLOCKED findings.
- [ ] Test that disabled custom policies do not trigger the branch-policy endpoint.
- [ ] Test that audit output never contains reviewer IDs or token values.
- [ ] Test that the release verifier still rejects the same non-READY posture.

### Task 2: Implement the shared inspector

**Files:**
- Modify: `cloud-engineering-connector/scripts/verify-environment-protection.mjs`

**Interface:**
- Export `inspectEnvironmentProtection({ repository, releaseEnvironment, token, fetchImpl })`.
- Return an immutable sanitized posture object with `status`, `findings`, `administratorBypassAllowed`, `preventSelfReview`, `requiredReviewerRuleCount`, `requiredReviewerCount`, `deploymentBranchPolicy`, `branchPolicyState`, and `branchPattern`.
- Retain authorized reviewer User IDs only in the internal inspector result for the existing release output; audit serialization must omit them.
- Refactor `verifyEnvironmentProtection` into an enforcement wrapper over the inspector.

- [ ] Implement independent field validation and finding accumulation.
- [ ] Query branch policies whenever `custom_branch_policies === true`, regardless of other finding types.
- [ ] Keep Environment 404 distinct from branch-policy 404 and API uncertainty.
- [ ] Preserve the verifier's successful return fields and fail-closed behavior.

### Task 3: Integrate complete diagnostics into the audit

**Files:**
- Modify: `cloud-engineering-connector/scripts/audit-environment-protection.mjs`
- Modify: `.github/workflows/environment-read-only-preflight.yml`

- [ ] Consume the shared inspector; remove first-error classification from the audit.
- [ ] Report each control and every finding for both environments.
- [ ] Preserve READY/BLOCKED/MISSING/UNKNOWN aggregate semantics.
- [ ] Keep the trigger restricted to the existing diagnostic branch families and permissions read-only.

### Task 4: Verify and record evidence

**Files:**
- Create: `cloud-engineering-connector/docs/evidence/2026-11-24-environment-full-posture-census.md`
- Modify: this plan.

- [ ] Record valid RED and final GREEN run IDs.
- [ ] Re-run the live read-only census and record all independently observed controls.
- [ ] Verify no reviewer IDs, tokens, Secrets, Variables, or raw API payloads enter the report.
- [ ] Verify npm audit, syntax, Wrangler dry-runs, Gitleaks diff, and full-history scan separately.
- [ ] Confirm PR remains Draft/open/unmerged and main SHA is unchanged.
