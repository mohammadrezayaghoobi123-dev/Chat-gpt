# Ledger Admission Receipt Projection Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a signed, tenant-bound Admission Receipt the only authorization evidence that can create a newly scheduled Task in OrchestratorLedger.

**Architecture:** TenantDirectory stores only tenant-scoped Ed25519 public verification keys and exposes a read-only lookup. OrchestratorLedger resolves the key through its TenantDirectory binding, validates a strict canonical Receipt and recomputes the bounded Task digest, then atomically consumes admission/JTI/idempotency identities and inserts the Task plus claim candidate. The legacy `createTask()` entrypoint becomes a fail-closed compatibility shim that cannot insert without the same Receipt path.

**Tech Stack:** Cloudflare Workers Durable Objects, SQLite, Web Crypto Ed25519, Node.js 22, Vitest 4, `@cloudflare/vitest-plugin`.

## Global Constraints

- Preserve the existing per-tenant TenantDirectory mapping and do not claim a new canonical OrchestratorLedger partition mapping.
- A Ledger verifier must resolve the public key from TenantDirectory by the Receipt tenant and key ID. It must never trust a public key supplied in the Receipt or RPC input.
- Private signing material must not be introduced into Ledger, Task, Outbox, audit, logs, repository files, or Cloudflare secrets as part of this step.
- Keep the existing HMAC Scheduler assertion only as an independent workload-authentication factor for the new projection operation. It is not authorization evidence.
- Receipt signature verification and TenantDirectory RPC occur outside `transactionSync`; all consumption identities and Task/claim-candidate writes occur in one synchronous Ledger transaction.
- Recompute the canonical Task digest from the normalized Task after `assertNoSecretFields` and the existing 32 KiB serialization bound.
- Preserve the existing task primary key and tenant/project idempotency namespace. Add explicit durable constraints for admission ID and Receipt JTI.
- An identical replay returns the original projection. Reuse with a different Task, digest, scope, admission ID, or JTI returns a conflict without a second Task.
- `createTask()` without a Receipt returns `ADMISSION_RECEIPT_REQUIRED` before consuming a worker assertion or writing Task, idempotency, admission, JTI, or claim-candidate state.
- Do not change `main`, `wrangler.toml`, Worker bindings, Cron schedules, secrets, staging, Production, or Cloudflare resources. Do not merge or deploy.
- This phase does not implement Receipt issuance, Scheduler event provenance, Outbox delivery/recovery, Execution Permit, or final Ledger partition selection.

## Receipt Contract

The signed envelope is exactly:

```json
{
  "header": {
    "alg": "Ed25519",
    "kid": "tenant-key-id",
    "typ": "AdmissionReceipt",
    "v": 1
  },
  "claims": {
    "v": 1,
    "iss": "tenant-directory",
    "aud": "orchestrator-ledger",
    "iat": 1800000000,
    "exp": 1800000060,
    "admissionId": "admission-1",
    "jti": "receipt-jti-1",
    "principalId": "principal-1",
    "membershipId": "membership-1",
    "tenantId": "tenant-1",
    "projectId": "project-1",
    "action": "project.task.create",
    "membershipVersion": 1,
    "policyScopeEpoch": 2,
    "policyRuleId": "policy-decision-1",
    "policyRuleVersion": 1,
    "decisionId": "policy-decision-1",
    "policyVersion": "policy-v1",
    "resourceDigest": "<64 lowercase hex characters>",
    "taskDigest": "<64 lowercase hex characters>",
    "taskId": "task-1",
    "idempotencyKeyDigest": "<64 lowercase hex characters>",
    "schedulerInvocationId": "scheduler-invocation-1",
    "cron": "0 * * * *",
    "scheduledTime": 1800000000000
  },
  "signature": "<base64url Ed25519 signature>"
}
```

The signature is Ed25519 over UTF-8 `canonicalJson({ header, claims })`. The contract accepts only the exact header and claim key sets shown above. The maximum Receipt lifetime is 60 seconds; `iat` and `exp` are Unix seconds. `scheduledTime` is milliseconds. The Task must be `SCHEDULED`, version 1, and carry matching `taskId`, `tenantId`, `projectId`, and `resourceDigest`. The Receipt's `taskDigest` is recomputed over the normalized bounded Task JSON. The idempotency key persisted by Ledger is the Receipt's SHA-256 idempotency-key digest in the existing tenant/project injective namespace.

## Task 1: Tenant-Scoped Public-Key Registry

**Files:**
- Modify: `cloud-engineering-connector/identity/tenant-directory.js`
- Modify: `cloud-engineering-connector/identity/tenant-directory-assertion.js`
- Modify: `cloud-engineering-connector/identity/tenant-directory-adapter.js`
- Test: `cloud-engineering-connector/cloudflare-test/tenant-directory.test.js`

**Interfaces:**
- `upsertAdmissionVerificationKey(input)` provisions a 32-byte Ed25519 public key under a tenant/key ID using the existing TenantDirectory admin assertion and optimistic key version.
- `getAdmissionVerificationKey({ tenantId, keyId, now })` returns only active or verification-only, currently valid public-key metadata; revoked, unknown, and expired keys return `null`.
- Adapter adds `admissionVerificationKeyStore.getAdmissionVerificationKey(input)`, binding the tenant ID before the RPC.

- [ ] **Step 1: Add failing key-registry tests**
  - Provision a new active key with expected version 0; assert version 1 and read-back through the read-only adapter.
  - Change active to verification-only with expected version 1; assert it remains verifiable.
  - Revoke with expected version 2; assert lookup returns null.
  - Reject an unknown key ID, malformed/non-32-byte public key, unsupported algorithm, invalid validity interval, optimistic version conflict, public-key rebinding under an existing key ID, and revoked-key reactivation.
  - Drop the key registry table after schema v3 and assert schema initialization fails closed.

- [ ] **Step 2: Verify RED**
  - Run: `cd cloud-engineering-connector && npx vitest run --config vitest.config.js cloudflare-test/tenant-directory.test.js`.
  - Expected: the new public-key registry tests fail because the RPC, table, and schema-v3 migration do not exist.

- [ ] **Step 3: Implement schema v3 and key registry**
  - Add `tenant_admission_verification_keys` with a composite tenant/key primary key, Ed25519-only algorithm constraint, status constraint, public key, validity bounds, optimistic row version, and timestamps.
  - Migrate schema v2 to v3 idempotently. Once v3 is recorded, missing registry table is `TENANT_DIRECTORY_SCHEMA_CORRUPT`; do not reconstruct it silently.
  - Add `upsertAdmissionVerificationKey` to the existing admin assertion operation allowlist. Bind the exact tenant, key ID, public key, algorithm, status, validity interval, and expected version in the signed admin target.
  - Keep key ID and public-key bytes immutable; permit only ACTIVE -> VERIFY_ONLY/REVOKED and VERIFY_ONLY -> REVOKED transitions.
  - Append audit evidence without exposing private material; the table stores only public keys.
  - Add the read-only lookup and tenant-bound adapter method.

- [ ] **Step 4: Verify focused and full TenantDirectory suites**
  - Run the focused test above and then `cd cloud-engineering-connector && npm test`.
  - Expected: all existing and new tests pass; schema version is 3.

- [ ] **Step 5: Commit**
  - `feat: add tenant admission verification key registry`.

## Task 2: Strict Receipt Verification and Atomic Ledger Projection

**Files:**
- Create: `cloud-engineering-connector/orchestrator-admission-receipt.js`
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/orchestrator-worker-identity.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-admission-receipt.test.js`

**Interfaces:**
- `verifyAdmissionReceipt(receipt, expected, resolvePublicKey)` strictly validates the exact envelope/claim schema, fixed issuer/audience/action, validity, expected Task/scope/digests, resolves a key only from TenantDirectory, and verifies Ed25519.
- `OrchestratorLedger.projectAdmittedTask({ task, receipt, now, workerId, workerAssertion })` authenticates the scheduler workload, normalizes and bounds the Task, recomputes its digest, verifies the Receipt, and atomically consumes identities and persists the Task.
- `OrchestratorLedger.createTask(input)` returns `ADMISSION_RECEIPT_REQUIRED` before any write if the Receipt is absent; if present it delegates to the exact projection path.
- `orchestrator_task_admissions` records tenant/project, admission ID, Receipt issuer/JTI, task ID/digest, resource digest, idempotency digest, and consumption time with database-enforced primary/unique constraints.

- [ ] **Step 1: Add failing Ledger tests**
  - Valid Ed25519 Receipt creates one Task, one admission-consumption record, and the expected claim candidate.
  - Identical Receipt/task retry returns the original Task and does not increase any row count.
  - Valid legacy HMAC assertion with no Receipt passed to `createTask()` returns `ADMISSION_RECEIPT_REQUIRED`; assert zero writes to tasks, admissions, consumed assertions, and claim candidates.
  - Reject unknown/revoked/expired key, bad signature, altered header, altered claim, wrong issuer/audience/action, stale/expired Receipt, wrong tenant/project/task/resource, wrong task digest, wrong idempotency digest, and invalid numeric versions.
  - Reject reused admission ID, reused issuer/JTI, task ID collision, idempotency collision, and conflicting replay without writing a second Task.
  - Mutate the caller Task after digest construction; assert the persisted Task bytes match only the signed canonical payload.
  - Reject secret-bearing, malformed, and over-32-KiB Task payloads before persistence.
  - Drop `orchestrator_task_admissions` after schema v10 and assert Ledger initialization fails closed.

- [ ] **Step 2: Verify RED**
  - Run: `cd cloud-engineering-connector && npx vitest run --config vitest.config.js cloudflare-test/orchestrator-ledger-admission-receipt.test.js`.
  - Expected: the new suite fails because Receipt verification, the TenantDirectory key RPC, schema v10 identities, and Receipt-only Task creation do not exist.

- [ ] **Step 3: Implement strict receipt verification**
  - Canonicalize `{ header, claims }` using the existing shared `canonicalJson`.
  - Decode raw 32-byte Ed25519 public keys and 64-byte signatures using strict base64url decoding.
  - Resolve `kid` only through `env.TENANT_DIRECTORY.get(idFromName(receipt.claims.tenantId)).getAdmissionVerificationKey(...)`; never accept a public key from the sender.
  - Verify signature and all expected bindings before opening the Ledger SQL transaction.

- [ ] **Step 4: Implement schema v10 and atomic projection**
  - Add `orchestrator_task_admissions` with `PRIMARY KEY(tenant_id, admission_id)`, `UNIQUE(receipt_issuer, receipt_jti)`, and `UNIQUE(tenant_id, project_id, task_id)`; use a foreign key to the Task.
  - Record schema v10 only after the table and constraints are created. If schema v10 exists but the table is missing, fail with `LEDGER_SCHEMA_CORRUPT` instead of silently reconstructing replay state.
  - In one `transactionSync`: consume the verified HMAC workload assertion, check admission/JTI/idempotency/task identities, return an identical replay or conflict, insert the Task, insert the admission-consumption row, and synchronize the claim candidate.
  - If any insert or claim-candidate write fails, the local transaction rolls back all Task and admission writes.
  - Keep `createTask()` as a receipt-required shim only; never leave an HMAC-only creation branch.

- [ ] **Step 5: Verify focused and full suites**
  - Run the new focused Vitest file, existing `orchestrator-ledger-idempotency-scope.test.js`, `orchestrator-ledger-tenant-scope-api.test.js`, then `cd cloud-engineering-connector && npm test`.
  - Expected: all focused and full tests pass; no unhandled Vitest errors.

- [ ] **Step 6: Commit**
  - `feat: require admission receipts for ledger task projection`.

## Task 3: Independent Adversarial Review and Release Boundary

**Files:**
- Review: every changed source and test file.
- Update: this plan with exact evidence and PR description with verification results.

- [ ] **Step 1: Re-read the complete branch diff**
  - Confirm only TenantDirectory key registry, Ledger Receipt verifier/projector, related tests, plan/spec, and workload-assertion allowlist changed.
  - Confirm no Wrangler, binding, secret, Cron, or Worker scheduled-handler changes.
- [ ] **Step 2: Inspect CI**
  - Record Node, Durable Object, dependency audit, syntax/Wrangler dry-run, PR diff Gitleaks, and full-history Gitleaks separately.
- [ ] **Step 3: Recheck parent/base integrity**
  - Confirm parent PR #434 head is unchanged and `main` remains unchanged.
  - Confirm this PR is stacked on the PR #434 feature branch and remains Draft/unmerged.
- [ ] **Step 4: Record gates**
  - Receipt issuance, signing-key custody approval, Scheduler provenance, Outbox wake/recovery, Execution Permit, live Ledger namespace/binding, and canonical Ledger object routing remain separate gates.
  - Do not merge or deploy.

## Acceptance Criteria

- Public keys are provisioned per tenant under immutable key IDs and are returned only by the matching TenantDirectory lookup.
- Ledger never uses a caller-supplied public key.
- Invalid, expired, revoked, wrong-scope, replayed, or digest-mismatched Receipts cannot create a Task.
- Every accepted Task has one durable admission identity and one unique receipt JTI in the Ledger transaction.
- Identical replay is idempotent; conflicting reuse is rejected without extra state.
- HMAC-only `createTask()` attempts are rejected before all writes.
- Task payload secret-field rejection and 32 KiB serialization cap remain enforced.
- Schema v3 and v10 migrations preserve old records and fail closed when their required new tables are missing after the version is recorded.
- No claim of production readiness, Receipt issuance, Outbox delivery, Scheduler reachability, or execution authorization is made by this phase.

## Explicitly Unresolved / Not Implemented

- Private-key custody, signer isolation, key generation/export, rotation procedure, backup/restore, compromise response, and actual Receipt issuance remain subject to the owner-approved custody decision.
- Scheduler event provenance and cron allowlist remain unimplemented.
- Outbox wake-up atomicity, tenant discovery registry, retry/recovery, and Ledger acknowledgement remain unimplemented.
- Canonical production Ledger DO routing/partition model remains unresolved; this API is partition-agnostic and does not claim a production object-ID mapping.
- Execution Permit and start-reservation semantics remain unimplemented.
