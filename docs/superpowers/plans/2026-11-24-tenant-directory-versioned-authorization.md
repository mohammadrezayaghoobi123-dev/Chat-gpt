# Tenant Directory Versioned Authorization Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with the TDD cycle. The GitHub feature branch is the isolated workspace; do not write to main.

**Goal:** Make TenantDirectory authorization decisions carry a complete, monotonic membership and policy freshness snapshot, with policy mutations and membership revocation updating that snapshot atomically.

**Architecture:** Add a per-scope epoch table keyed by (tenant_id, project_id, principal_id, action). Every policy-row mutation increments its scope epoch in the same SQLite transaction; suspend/revoke increments each distinct affected scope exactly once while disabling its rows. TenantContext carries the membership version, and policy evaluation must reject a stale context while returning the selected rule version and policy-scope epoch.

**Tech Stack:** Cloudflare Workers Durable Objects with SQLite, Node.js 22, Vitest 4, @cloudflare/vitest-plugin.

**Spec:** docs/superpowers/specs/2026-11-24-hybrid-admission-authorization-design.md, Sections 5.1, 5.2, 7, and 17.6.

## Global Constraints

- Preserve the per-tenant TenantDirectory boundary and existing membership/policy schemas.
- Keep all writes for membership state, policy disabling, policy-scope epochs, and audit evidence inside one synchronous transactionSync callback.
- Do not put asynchronous cryptography or RPC operations inside transactionSync.
- Keep the existing default-deny behavior and exact-resource-before-wildcard precedence.
- Treat caller-provided policyVersion as descriptive metadata; only numeric versions/epochs establish freshness.
- Do not change main, wrangler.toml, Cloudflare bindings, secrets, Cron schedules, staging, or Production.
- Do not merge or deploy.

## Review Focus

1. Existing TenantDirectory instances must migrate from schema v1 to v2 without losing membership, policy, or audit rows.
2. Multiple exact/wildcard policy rows in one scope must advance the scope epoch once per mutation, not once per row.
3. A membership revoke/suspend affecting several policy rows and scopes must advance each distinct scope exactly once and leave unrelated scopes untouched.
4. A context resolved before a membership version change must not authorize under the newer membership state.
5. A failed epoch update must roll back membership, policy rows, epochs, and the audit event together.

---

### Task 1: Durable Policy-Scope Epochs and Atomic Mutation

**Files:**
- Modify: cloud-engineering-connector/identity/tenant-directory.js
- Test: cloud-engineering-connector/cloudflare-test/tenant-directory.test.js

**Interfaces:**
- Add table tenant_policy_scope_epochs(tenant_id, project_id, principal_id, action, epoch, updated_at), primary key on the four-part scope, epoch >= 1.
- Add private helper #advancePolicyScopeEpoch(sql, scope, now) returning the new integer epoch.
- Add private helper #disableMembershipPolicies(sql, tenantId, principalId, now) returning sorted distinct affected scope records.
- Increment schema migration version to 2 while preserving v1 data.
- upsertProjectPolicy returns policyScopeEpoch.
- Audit event details for suspension/revocation include the derived affected scope set; the signed admin assertion digest remains bound to the original request target.

- [ ] **Step 1: Write failing Durable Object tests**
  - Add test: increments the policy-scope epoch once per policy mutation across exact and wildcard rules. Create a wildcard rule and an exact-resource rule in one scope; assert epochs 1 then 2, and assert exact-resource precedence still selects the exact rule.
  - Add test: advances every distinct affected policy scope once when membership is revoked. Seed multiple projects, actions, and multiple resource rules per scope; revoke once; assert only distinct active scopes advance, each exactly once, all targeted rules disable, and unrelated tenant/principal scopes remain unchanged.
  - Add test: atomically rolls back revocation, policy disabling, epochs, and audit evidence. Install a test SQLite trigger that aborts an epoch update; revoke; assert membership, policy rows, epoch rows, and audit count all remain at their pre-transaction state.
  - Assert TenantDirectory schema health reports version 2 after migration.

- [ ] **Step 2: Run the tests to verify RED**
  - CI command: cd cloud-engineering-connector && npm test.
  - Expected: the new assertions fail because no scope-epoch table or epoch mutation exists; existing unrelated tests remain diagnosable.

- [ ] **Step 3: Implement the migration and atomic epoch updates**
  - Create the epoch table idempotently and record migration version 2.
  - Use SQL SELECT DISTINCT project_id, action before bulk policy disable.
  - Increment each distinct scope exactly once in the same transaction as the policy row updates and audit append.
  - Increment the single scope epoch in the same transaction as every upsertProjectPolicy.
  - Preserve exact-resource precedence and all existing version-conflict checks.

- [ ] **Step 4: Run targeted and full Durable Object tests**
  - Run: npx vitest run --config vitest.config.js cloudflare-test/tenant-directory.test.js.
  - Expected: all TenantDirectory tests pass.
  - Run: npm test.
  - Expected: complete Node and Durable Object suites pass.

- [ ] **Step 5: Commit the task**
  - Commit message: feat: version tenant policy authorization scopes.

### Task 2: Bind Authorization to Membership and Policy Snapshot

**Files:**
- Modify: cloud-engineering-connector/identity/tenant-directory.js
- Modify: cloud-engineering-connector/identity/tenant-context.js
- Test: cloud-engineering-connector/cloudflare-test/tenant-directory.test.js

**Interfaces:**
- membershipRecord(row) continues exposing the existing numeric version.
- resolveTenantContext requires a positive safe integer membership.version and returns immutable membershipVersion.
- TenantDirectory.authorizeProjectAction requires expectedMembershipVersion, reads membership, scope epoch, and selected rule in one synchronous read transaction, and rejects a mismatched membership version with TENANT_DIRECTORY_MEMBERSHIP_VERSION_STALE.
- Authorization decisions return membershipId, membershipVersion, policyScopeEpoch, and selected policyRuleVersion in addition to the existing scoped decision fields.
- authorizeProjectAction forwards tenantContext.membershipVersion; it maps a stale-version error to TENANT_MEMBERSHIP_STALE and validates all returned version fields before accepting an allow.

- [ ] **Step 1: Write failing context and stale-snapshot tests**
  - Add test: propagates membership version and policy scope epoch through the verified context. Assert the immutable tenant context contains membership version and an allow decision carries the same membership version, numeric policy epoch, and selected rule version.
  - Add test: rejects authorization when the resolved membership context becomes stale. Resolve a context at membership version 1, mutate the membership to version 2, then authorize with the old context; assert TENANT_MEMBERSHIP_STALE.
  - Add test: rejects a membership store result without a valid numeric version. An incomplete membership record must not produce a verified tenant context.

- [ ] **Step 2: Run the tests to verify RED**
  - Expected: missing context version propagation and the missing stale-version guard cause the intended failures.

- [ ] **Step 3: Implement strict version propagation and snapshot evaluation**
  - Reject missing/invalid membership versions at the context boundary.
  - Pass the expected version to TenantDirectory.
  - Evaluate membership, epoch, and selected rule in one synchronous local storage transaction.
  - Reject stale membership snapshots; return numeric epoch and selected policy row version on allow and deny decisions where available.
  - Keep the decision fail-closed if the authority omits or corrupts any required version field.

- [ ] **Step 4: Run the targeted and full suites**
  - Expected: all TenantDirectory integration tests and the full package suite pass.

- [ ] **Step 5: Commit the task**
  - Commit message: feat: bind tenant authorization to versioned snapshots.

### Task 3: Independent Verification and PR Gate

**Files:**
- Review: all Task 1 and Task 2 files.
- Update: PR description with exact verification evidence.

- [ ] **Step 1: Re-read the implementation from the remote branch**
  - Verify schema migration, scope key, epoch update placement, transaction boundaries, strict version comparison, and audit details.
- [ ] **Step 2: Inspect the full GitHub Actions results**
  - Record the Node test suite, Durable Object Vitest suite, syntax/Wrangler dry-run checks, dependency audit, and secret scan separately.
- [ ] **Step 3: Review the diff against the feature branch base**
  - Expected: only the planned source, tests, plan, and design record are changed; no Wrangler/deployment or secret changes.
- [ ] **Step 4: Keep the PR Draft and unmerged**
  - This task does not authorize deployment, merge, or closure of the larger admission design hold.

## Acceptance Criteria

- Schema v2 migrates without data loss.
- Every policy mutation increments exactly one epoch for its scope.
- Bulk suspension/revocation increments every distinct affected scope exactly once in the same transaction.
- A stale tenant context cannot receive an allow decision after membership version changes.
- Allow decisions bind membership version, policy-scope epoch, and selected policy-row version.
- Transaction failure leaves membership, policy rows, epochs, and audit evidence unchanged.
- The complete repository CI reports results from the actual run; unknown or unavailable checks remain UNKNOWN.
