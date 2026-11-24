# Environment Reviewer Identity Binding Implementation Plan

> **Execution:** Native implementation on the isolated child branch `security/environment-reviewer-identity-binding-2026-11-24`, targeting Draft PR #427. No merge or deployment.

**Goal:** Require the independent PR approval for a release candidate to originate from one of the exact GitHub User identities configured as required reviewers on that release's protected Environment.

**Architecture:** The existing Environment verifier reads its configured reviewer User IDs from the live Environment metadata and emits the validated numeric set through the current step's `GITHUB_OUTPUT`. Each release workflow passes that step output to the existing PR approval verifier. The approval verifier compares the GitHub review author's immutable numeric user ID against that set, while preserving exact-candidate-SHA, non-author, latest-review, and outstanding-change-request checks.

**Tech Stack:** Node.js 22 ESM, `node:test`, GitHub REST API, GitHub Actions step outputs.

**Spec:** PR #427's GitHub Environment Protection Runtime Guard and the reviewer-identity binding contract.

## Global Constraints

- Do not read Environment Secrets, repository Secrets, or Environment Variables.
- Do not introduce another reviewer allowlist that is mutable from the candidate branch.
- Do not widen GitHub workflow permissions or call mutating GitHub endpoints.
- Use numeric GitHub User IDs, not mutable login names, for identity comparison.
- Require one to six unique positive User IDs; missing, malformed, duplicate, or empty identity sets fail closed.
- Reject Team reviewers because this personal-account repository cannot safely map team IDs to individual PR review user IDs under the current contract.
- Preserve exact candidate SHA, non-author approval, latest-review semantics, and the existing blocking behavior for outstanding change requests.
- Keep this PR Draft, based on PR #427, and unmerged; do not modify `main`, live Environments, Secrets, Variables, Cloudflare resources, or deployments.

## Review Focus

- Environment reviewer identity is a Team or malformed: block because it cannot be compared to a PR review User ID.
- Environment reviewer's User ID is missing, non-positive, duplicated, or unsafe: block.
- PR approval is from a valid but unrelated account: block.
- PR approval is from the PR author: block.
- Approval is for an older commit or latest reviewer state is a change request: block.
- The workflow output is empty, malformed, or not wired into either release workflow: block before credential-bearing steps.

---

### Task 1: Specify the identity-binding behavior with adversarial tests

**Files:**
- Modify: `cloud-engineering-connector/test/environment-protection.test.js`
- Modify: `cloud-engineering-connector/test/release-approval.test.js`
- Modify: `cloud-engineering-connector/test/environment-protection-contract.test.js`

- [x] Add tests for exact reviewer User ID export, fail-closed Team handling, unrelated PR reviewer rejection, empty allowlist rejection, and both workflow output bindings.
- [x] Verify valid RED in CI: 451 Node tests, 445 passed, 6 expected failures; npm dependency audit passed.

### Task 2: Export reviewer identities from the Environment trust gate

**Files:**
- Modify: `cloud-engineering-connector/scripts/verify-environment-protection.mjs`

**Interface:**
- `verifyEnvironmentProtection(...)` returns `authorizedReviewerUserIds` as a sorted, frozen numeric array.
- The CLI writes only `reviewer_user_ids=<comma-separated numeric IDs>` to the GitHub Actions output file.
- No reviewer identities or credential material are logged.

- [x] Restrict the configured reviewer set to User identities that can be compared directly with PR review authors.
- [x] Fail closed if the GitHub Actions output file is unavailable.

### Task 3: Enforce the same identity set in the independent PR approval gate

**Files:**
- Modify: `cloud-engineering-connector/release-approval.js`
- Modify: `cloud-engineering-connector/scripts/verify-release-approval.mjs`

- [x] Require one to six unique positive safe-integer Environment reviewer IDs.
- [x] Key latest review state by numeric GitHub user ID.
- [x] Accept approval only from a configured Environment reviewer, not the PR author, and only on the exact PR head commit.
- [x] Preserve fail-closed handling of outstanding change requests and malformed/missing review identity metadata.

### Task 4: Wire Staging and Production workflows

**Files:**
- Modify: `.github/workflows/connector-staging-release.yml`
- Modify: `.github/workflows/connector-production-release.yml`

- [x] Add stable `environment-protection` step IDs.
- [x] Pass `steps.environment-protection.outputs.reviewer_user_ids` only to the subsequent approval-verifier step.
- [x] Preserve the existing secret-mapping order and least-privilege workflow permissions.

### Task 5: Verify and record evidence

**Files:**
- Create: `cloud-engineering-connector/docs/evidence/2026-11-24-environment-reviewer-identity-binding.md`

- [x] Record valid RED and final GREEN CI evidence.
- [x] Confirm no live Environment, Secret, Variable, Cloudflare, deployment, or `main` change.
- [x] Retain Draft/unmerged status and verify the final branch diff.
