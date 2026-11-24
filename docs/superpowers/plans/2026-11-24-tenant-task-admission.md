# Tenant-Bound Task Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every OrchestratorLedger Task creation to carry an Ed25519 grant reserved by TenantDirectory and bound to the exact canonical Task, tenant, project, membership version, policy version, and idempotency inputs.

**Architecture:** TenantDirectory is the sole admission authority. It snapshots membership/policy state, signs outside SQLite, then rechecks and persists an immutable reservation plus audit event in one local transaction. OrchestratorLedger verifies the asymmetric signature and exact Task digest, then atomically consumes the grant, stores the Task and admission receipt, and enqueues a `task.admitted` Outbox event.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers Web Crypto Ed25519, SQLite-backed Durable Objects, Vitest/Cloudflare test runtime, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-24-tenant-task-admission-contract.md`

## Global Constraints

- Preserve `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`; all changes stay on `security/tenant-admission-version-fence-2026-11-24`.
- Production, Staging deployments, laptop state, Wrangler bindings, Cron schedules, and secret values are out of scope.
- Private signing keys exist only in the TenantDirectory runtime; Ledger receives public Ed25519 JWKs only.
- All crypto operations occur outside SQLite `transactionSync`; local transaction callbacks remain synchronous.
- Task admission uses fixed action `task.create` and maximum grant lifetime 300 seconds.
- Admission reservation commit is the authority linearization point; no cross-Durable-Object atomicity or instant task cancellation is claimed.
- Fail closed on missing keys, malformed claims, signature mismatch, scope mismatch, stale authority snapshot, expiry, and replay conflict.

## Review Focus

- Caller changes the Task after authorization: Ledger recomputes the canonical Task digest before the transaction.
- A revocation or policy update races with signing: Directory rechecks membership/rule/epoch in the final transaction.
- A caller replays a grant after commit: admission ID and JTI uniqueness return the original receipt without duplicate Task/Outbox writes.
- A grant is signed by a non-authoritative key or contains private key material: Ledger accepts only configured public Ed25519 JWKs.
- An Outbox insert or receipt write fails after Task insert: one thrown error must roll back the Task, JTI consumption, receipt, and Outbox event together.

---

### Task 1: Shared Ed25519 admission grant protocol

**Files:**
- Create: `cloud-engineering-connector/orchestrator-admission.js`
- Test: `cloud-engineering-connector/test/orchestrator-admission.test.js`
- Modify: `cloud-engineering-connector/package.json` (syntax-check list only)

**Interfaces:**
- Produces `normalizeTaskForAdmission(task)`, `taskAdmissionDigest(task)`, `admissionTextDigest(value)`, `createTaskAdmissionGrant(privateKeySet, activeKid, claims)`, and `verifyTaskAdmissionGrant(publicKeySet, token, expected)`.
- Grant format: `ad1.<kid>.<canonical-payload-base64url>.<ed25519-signature-base64url>`.
- Private JWK ring: `{ kid: { kty: "OKP", crv: "Ed25519", x, d } }`; public JWK ring excludes `d`.

- [ ] Step 1: Write test `rejects noncanonical payloads, malformed key rings, private material in public rings, and invalid Ed25519 signatures`.
- [ ] Step 2: Run `npm test -- --runInBand` only if supported; otherwise add the test to Node's existing `test/*.test.js` discovery and run `npm run test:node`. Expected: the new exported functions are missing.
- [ ] Step 3: Implement the exact grant parser, canonical JSON, JWK validation, Ed25519 sign/verify, claim schema, 300-second lifetime, and digest helpers in `orchestrator-admission.js`.
- [ ] Step 4: Add positive and negative tests for valid sign/verify, unknown kid, changed claims, malformed base64url, expired grant, future-issued grant beyond skew, and rejection of private JWK fields in the verifier.
- [ ] Step 5: Run `npm run test:node` and `node --check orchestrator-admission.js`.

### Task 2: TenantDirectory authoritative reservation

**Files:**
- Modify: `cloud-engineering-connector/identity/tenant-directory.js`
- Modify: `cloud-engineering-connector/identity/tenant-directory-adapter.js`
- Test: `cloud-engineering-connector/cloudflare-test/tenant-directory-admission.test.js`

**Interfaces:**
- Add `TenantDirectory.prepareTaskAdmission({ tenantId, projectId, principalId, taskId, taskDigest, idempotencyKey, inputHash, now })`.
- Add `admissionStore.prepareTaskAdmission(input)` to `createTenantDirectoryAdapters`, enforcing the adapter's tenant binding.
- Add schema v3 table `tenant_task_admission_reservations`, unique by admission ID, JTI, tenant/project/idempotency-key digest, and tenant/project/task ID.
- Runtime key configuration: `TENANT_DIRECTORY_ADMISSION_PRIVATE_KEYS` and `TENANT_DIRECTORY_ADMISSION_ACTIVE_KID`.

- [ ] Step 1: Write test `reserves a signed grant only for an active member and an exact-or-wildcard allow rule for task.create`.
- [ ] Step 2: Run the focused Vitest test. Expected: `prepareTaskAdmission` is not available.
- [ ] Step 3: Implement schema v3, reservation lookup/insert, signed grant generation, and append-only audit in the final transaction.
- [ ] Step 4: Add a controlled WebCrypto-sign delay test: mutate membership/policy while signing is suspended; after release expect `TASK_ADMISSION_SNAPSHOT_STALE` and zero reservation/audit additions.
- [ ] Step 5: Add tests for same-key exact replay, changed input conflict, missing signing key, policy deny, revoked membership, and reservation-before-revocation ordering.
- [ ] Step 6: Run the focused TenantDirectory Durable Object suite.

### Task 3: Trusted application-context admission API

**Files:**
- Modify: `cloud-engineering-connector/identity/tenant-context.js`
- Modify: `cloud-engineering-connector/identity/tenant-directory-adapter.js` if Task 2 left adapter integration incomplete.
- Test: `cloud-engineering-connector/test/tenant-authorization.test.js`

**Interface:**
- Add `prepareTaskAdmission({ principal, tenantContext, task, idempotencyKey, inputHash, now, admissionStore })`.
- Require the exact opaque principal and WeakSet-verified tenant context; require task tenant to match tenantContext; normalize and digest the same Task projection Ledger will store.
- Return the signed grant and admission ID only after Directory reservation succeeds.

- [ ] Step 1: Write tests `rejects fabricated principals and contexts before the admission store is called`, `rejects task scope mismatch`, and `returns only a Directory-issued signed grant for the exact normalized Task`.
- [ ] Step 2: Run the focused Node test and observe expected missing-function failures.
- [ ] Step 3: Implement the trusted-context API with fail-closed error mapping.
- [ ] Step 4: Run `npm run test:node`.

### Task 4: Atomic OrchestratorLedger grant consumption and Task persistence

**Files:**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-admission.test.js`
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-idempotency-scope.test.js`
- Modify: existing direct `createTask` fixtures so each uses a valid Directory grant; missing-scope tests must continue rejecting before authentication.

**Interfaces:**
- Extend `createTask({ task, idempotencyKey, inputHash, now, workerId, workerAssertion, admissionGrant })`; no grant means `TASK_ADMISSION_REQUIRED`.
- Add schema v10 table `orchestrator_task_admission_receipts` with unique `admission_id`, unique `jti`, and exact scope/digest/version evidence.
- Runtime verifier configuration: `ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS`.
- Atomically persist Task, admission receipt, and Outbox event type `task.admitted`; reuse existing `enqueueOutboxInTransaction`.

- [ ] Step 1: Write a real Durable Object integration test that obtains a grant from TenantDirectory, attempts Task creation without the grant (deny), then successfully creates with the valid exact grant.
- [ ] Step 2: Run the focused Vitest test and observe `TASK_ADMISSION_REQUIRED`/missing verification behavior before implementation.
- [ ] Step 3: Verify the grant outside the transaction; recompute Task, idempotency-key, and input digests; compare tenant/project/task IDs and grant claims.
- [ ] Step 4: In one `transactionSync`, consume scheduler assertion, recognize grant replay, create Task, insert admission receipt, enqueue `task.admitted`, and sync the claim candidate.
- [ ] Step 5: Add hostile tests for Task tampering, tenant/project substitution, wrong idempotency key, wrong input hash, expired grant, invalid signature, unknown key ID, JTI collision, same-grant replay, and changed-claim replay.
- [ ] Step 6: Inject a trigger failure on receipt or Outbox insert; assert no Task, admission receipt, Outbox row, consumed grant JTI, or consumed worker JTI remains.
- [ ] Step 7: Update existing Task creation tests to use the real TenantDirectory grant path, not synthetic unsigned decisions.
- [ ] Step 8: Run the complete Cloudflare Durable Object suite.

### Task 5: Independent hostile verification and handoff

**Files:**
- Modify: `cloud-engineering-connector/package.json` (syntax-check list only, if needed)
- Modify: `docs/superpowers/specs/2026-11-24-tenant-task-admission-contract.md` with exact verification evidence and remaining gaps.

- [ ] Step 1: Run `npm test`.
- [ ] Step 2: Run `npm audit --audit-level=moderate`.
- [ ] Step 3: Run `npm run check` (includes default and Staging Wrangler dry-runs; no deployment).
- [ ] Step 4: Verify Gitleaks PR-diff scan separately from full-history scan; do not suppress historical findings.
- [ ] Step 5: Re-read exact PR diff and test logs; record any remaining failures without claiming readiness.
- [ ] Step 6: Keep the PR Draft and unmerged; no deployment or secret provisioning.

