# Hybrid Admission Authorization V1 Implementation Plan

> **For agentic workers:** Execute task by task. Steps use checkbox syntax for tracking.

**Goal:** Implement the first atomic authorization-freshness slice of the hybrid admission protocol without enabling task creation or deployment.

**Architecture:** TenantDirectory remains the per-tenant policy authority. A monotonic policy-scope epoch is updated in the same SQLite transaction as each relevant policy mutation, including the distinct scopes disabled by membership suspension or revocation. Authorization reads return a version-complete snapshot containing membership version, policy-scope epoch, selected rule version, decision identifier, and resource scope. This slice does not mint receipts or alter Ledger task-write behavior.

**Tech Stack:** JavaScript ES modules, Cloudflare Durable Objects with SQLite storage, Vitest, Cloudflare Vitest plugin, Wrangler.

## Global Constraints

- Preserve the current main baseline and work only on the design branch.
- Do not alter main, live Cloudflare resources, bindings, secrets, Cron schedules, or deployment state.
- Use transactionSync for epoch and policy/membership writes; perform no asynchronous operation inside its callback.
- Preserve default-deny behavior, exact-resource-before-wildcard precedence, numeric membership and rule versions, and append-only audit events.
- A policy-scope key is the exact tuple of tenant_id, project_id, principal_id, and action.
- Increment each distinct affected scope exactly once per mutation transaction. Do not increment unaffected scopes.
- A missing epoch is represented as zero and never authorizes.
- Keep technical artifacts English-only.
- Do not claim the full Admission protocol is implemented by this slice.

---

### Task 1: Add failing policy-freshness and revocation tests

**Files:**
- Create: cloud-engineering-connector/cloudflare-test/tenant-directory-policy-epoch.test.js

**Interfaces:**
- Consumes: createTenantDirectoryAdapters, createTenantDirectoryAdminAssertion, upsertMembership, upsertProjectPolicy, revokeMembership, authorizeProjectAction.
- Produces: executable assertions for the version-complete authorization snapshot and tenant_policy_scope_epochs.

- [ ] **Step 1: Add the focused failing test**

Test these behaviors:

1. Create active membership and an allow wildcard policy. Verify authorization returns membership version, selected rule version, policy-scope epoch, selected resource digest, and decision ID.
2. Add an exact-resource rule for the same project/action. Verify exact-resource precedence and exactly one additional epoch increment.
3. Seed active policy rows spanning multiple projects and actions, including wildcard and exact-resource rows. Revoke membership. Verify every distinct affected scope advances exactly once, all active rules are disabled in the same transaction, and an unrelated principal's epoch does not change.
4. Query authorization after revocation. Verify deny, the new membership version, current policy-scope epoch, and no selected active rule.
5. Force a transaction failure after epoch updates with a test-only abort trigger. Verify membership state, policy statuses, scope epochs, and audit row count all roll back together.

- [ ] **Step 2: Verify the relevant failure**

Run: npm run test:do -- cloudflare-test/tenant-directory-policy-epoch.test.js

Expected: the test fails because version metadata/table/epoch behavior is missing. A module-resolution, test setup, or syntax error does not count as red and must be corrected first.

### Task 2: Implement the atomic policy-scope epoch

**Files:**
- Modify: cloud-engineering-connector/identity/tenant-directory.js
- Modify: cloud-engineering-connector/identity/tenant-context.js
- Test: cloud-engineering-connector/cloudflare-test/tenant-directory-policy-epoch.test.js

**Interfaces:**
- Consumes: existing TenantDirectory membership, project-policy tables, and transaction boundary.
- Produces: tenant_policy_scope_epochs with a composite primary key and monotonic integer epoch; complete authorization decision metadata.

- [ ] **Step 1: Create the storage table**

Add an idempotent table with tenant_id, project_id, principal_id, action, epoch, and updated_at. Use a composite primary key over the four scope fields and constrain epoch to a non-negative integer.

- [ ] **Step 2: Add synchronous epoch helpers**

Implement a transaction-local helper that increments one scope with an UPSERT. Implement a second helper that reads distinct active policy scopes for one tenant/principal and increments each exactly once. Both helpers use the active transaction's SQL handle and perform no asynchronous operations.

- [ ] **Step 3: Wire all relevant mutations**

- upsertProjectPolicy increments the exact policy scope once in the same transaction as the policy write and audit event.
- upsertMembership with a non-active status enumerates distinct active policy scopes before disabling rules, then increments each once in the same transaction as membership status/version, policy disable, and audit writes.
- revokeMembership applies the same operation in the same transaction as membership revocation, policy disabling, and audit append. An already-revoked membership may be a no-op only when no active policy rows remain.

- [ ] **Step 4: Return a consistent authorization snapshot**

Synchronously read membership status/version, the selected active rule, selected rule numeric version/resource digest, and policy-scope epoch without yielding between reads. Return these fields for allow and deny results. Missing epoch is zero. Missing/inactive membership or missing active rule remains deny.

- [ ] **Step 5: Preserve the provider-neutral context**

Carry the Directory numeric membership version into the verified tenant context and carry decision version metadata out of authorizeProjectAction. Never infer a missing version from a caller-supplied label.

- [ ] **Step 6: Verify the focused pass**

Run: npm run test:do -- cloudflare-test/tenant-directory-policy-epoch.test.js

Expected: the identical tests pass with exact epoch deltas and rollback assertions.

- [ ] **Step 7: Run all affected validation**

Run: npm test

Expected: existing Node tests and all Cloudflare Durable Object tests pass.

Run: npm run check

Expected: JavaScript syntax checks and both Wrangler dry-run configuration checks complete with exit code zero. These commands do not deploy.

- [ ] **Step 8: Review the diff**

Verify only the plan, focused test, TenantDirectory, and tenant-context files changed. Verify there are no secret values, live resource changes, or unrelated formatting changes.

## Explicit scope boundary

This is the first independently testable implementation slice. It establishes the authoritative version snapshot required by signed Admission Receipts. It does not yet implement receipt signing, Ledger receipt consumption, Scheduler event provenance, Outbox delivery, start reservations, or effect-boundary fencing. Those components must consume this exact contract; they must not invent parallel version counters or bypass the Directory.

## Acceptance rule

The slice is complete only when the expected red failure is observed, the same focused test turns green, the full test suite and npm run check are freshly executed, and the changed-file diff matches the scope above. Until then, status is IN_PROGRESS or UNKNOWN, not complete.
