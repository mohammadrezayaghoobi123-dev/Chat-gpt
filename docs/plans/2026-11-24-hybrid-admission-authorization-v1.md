# Hybrid Admission Authorization V1 — Executed Atomic Foundation

**Status:** Foundation slice implemented and CI-verified on 2026-11-24. Full Admission protocol remains incomplete and is not deployed.

**Branch:** design/hybrid-admission-authorization-2026-11-24  
**Baseline:** main at 919b19ca3d3887352cdef06b03c668ead04fbce7  
**Verified commit:** 1b7ce1e8aa5cb1e47f1def94920d11cdc0214645

## Objective

Implement a single coherent foundation that supplies (1) authoritative authorization freshness per tenant, and (2) a private per-tenant signing-key capability without persisting extractable private-key bytes in TenantDirectory.

## Global invariants

- All changes stay on this branch. Main and Production are out of scope.
- No Cloudflare live binding, secret, trigger, namespace, script, or deployment mutation is authorized by this plan.
- TenantDirectory remains the authority for membership and effective policy.
- Policy and membership changes and their epoch/audit updates share one local synchronous SQLite transaction.
- A scope epoch is keyed by the exact tuple `(tenant_id, project_id, principal_id, action)`.
- Each distinct affected scope advances exactly once; unaffected scopes do not advance.
- Unknown or invalid key lookups fail closed and never create/provision a key.
- Signing-key material is available only to the isolated signer Worker. TenantDirectory stores an authenticated ciphertext envelope and public verification key, not a private CryptoKey or plaintext PKCS#8/JWK.
- No cross-Durable-Object ACID claim is made.
- Unexecuted behavior remains UNKNOWN, not pass or fail.
- Technical artifacts are English-only.

---

## Executed task 1 — Policy-scope epoch and authorization snapshot

**Files**
- `identity/tenant-directory.js`
- `identity/tenant-context.js`
- `cloudflare-test/tenant-directory-policy-epoch.test.js`

**Implementation**
- Added `tenant_policy_scope_epochs` with a composite primary key over tenant, project, principal, and action.
- Added synchronous transaction-local UPSERT helpers.
- Advanced every distinct affected epoch in the same transaction as policy update, membership suspension, and membership revocation.
- Included exact-resource and wildcard rule precedence effects.
- Authorization results now expose authoritative membership version, scope epoch, selected numeric rule version, selected resource digest, and decision ID.
- Tenant context propagates metadata only when supplied by the authority, preserving the legacy shape for older adapter implementations.

**Hostile assertions**
- Exact-resource precedence increments the shared policy scope epoch once.
- Membership suspension disables all active policy rows and increments each distinct affected scope once.
- Membership revocation does the same, without changing unrelated principals' epochs.
- A test-only SQLite abort trigger proves that membership state, rule state, epoch updates, and audit rows roll back together.
- Authorization after suspension/revocation returns deny with the new authoritative version snapshot.

## Executed task 2 — Runtime proof for private-key persistence

**File**
- `cloudflare-test/tenant-directory-admission-crypto-persistence.test.js`

The Cloudflare Durable Object test runtime rejects storing a Web Crypto `CryptoKey` object in SQLite-backed DO storage with `DataCloneError`. The test also verifies Ed25519 private-key non-extractability in memory and successful signature verification before persistence is attempted.

**Decision**
Direct CryptoKey persistence is rejected as an implementation strategy. No fallback to plaintext PKCS#8 or private JWK storage in TenantDirectory is allowed.

## Executed task 3 — Isolated admission signer

**Files**
- `admission-signer/worker.js`
- `admission-signer/wrangler.toml`
- `cloudflare-test/admission-signer.test.js`
- `vitest.config.js`

**Implementation**
- Added a separate Worker source with `workers_dev = false` and no public routes.
- The signer reads `ADMISSION_SIGNER_MASTER_KEYS`; this binding is not configured on the primary Worker.
- It creates tenant-specific Ed25519 signing keys and wraps the private PKCS#8 bytes using HKDF-SHA-256-derived AES-256-GCM keys.
- AEAD associated data binds envelope version, tenant ID, signing key ID, wrapping-key ID, public key, and KDF salt.
- Signing imports the private key as non-extractable in memory and returns only the signature.
- Requests are size-bounded; unknown routes/methods, missing/malformed key material, tenant substitution, ciphertext tampering, and retired wrapping keys fail closed.
- The local Vitest Service Binding invokes the real signer Worker module with a fresh random test KEK generated at config-load time; no test key is committed.

**Hostile assertions**
- Returned key envelopes contain no private-key or master-key field.
- A signature verifies against the returned public key.
- Tenant substitution and ciphertext tampering fail.
- Rotation overlap accepts an old wrapping key only while it remains in the ring; removal rejects the old envelope.
- Missing/malformed signer configuration fails closed.
- Unrecognized route, method, and oversized request are rejected.

## Executed task 4 — TenantDirectory signer integration

**Files**
- `identity/tenant-directory.js`
- `identity/tenant-directory-adapter.js`
- `cloudflare-test/tenant-directory-admission-key.test.js`

**Implementation**
- TenantDirectory persists a pending signing-key ID before calling the signer, so an ambiguous call can retry with the same identifier.
- Concurrent calls within one object share the in-flight provisioning Promise.
- The validated encrypted envelope is persisted under a tenant-specific key; plaintext private material is never returned to TenantDirectory.
- `signAdmissionMessage` routes bounded bytes through the Service Binding and returns only tenant/key identifiers, public key, and signature.
- `getAdmissionVerificationKey` is read-only: an unknown tenant/key is rejected without provisioning.
- The tenant adapter enforces exact selected-tenant scope for both methods.

**Hostile assertions**
- Concurrent signing calls reuse one key ID and public key.
- Both signatures verify.
- Stored state contains the encrypted envelope and no private-key or master-key fields.
- Verification-key lookup returns only the public key.
- Unknown key IDs and cross-tenant lookups reject.
- An unknown-tenant key lookup leaves no provisioned envelope behind.

## Verification evidence

- **Red evidence for Task 1:** GitHub Actions run `45370294820` failed on the new missing epoch/snapshot assertions as expected.
- **Final integrated green run:** GitHub Actions run `45373603783`, commit `1b7ce1e8aa5cb1e47f1def94920d11cdc0214645`, completed successfully.
- Node tests: **185 passed, 0 failed**.
- Cloudflare Durable Object tests: **20 files, 63 passed, 0 failed**.
- `npm audit --audit-level=moderate`: passed.
- `node --check` validation, including TenantDirectory, adapter, signer Worker and test files: passed.
- Wrangler dry-run validation: primary Worker production/staging configuration and signer Worker production/staging configuration all exited successfully. No deployment occurred.
- Gitleaks PR diff-range scan: no leaks found.
- Gitleaks full-history scan: failed on **12 historical `generic-api-key` findings** in pre-existing commits/files. They are not waived or assumed false positives.

## Residual blockers — not implemented by this foundation

1. Admission Receipt issuance and canonical claim schema.
2. Scheduler invocation provenance from a real platform `scheduled(controller, env, ctx)` handler and an explicit cron-to-service-principal allowlist.
3. Ledger `projectAdmittedTask` receipt verification and unique admission/JTI consumption.
4. Removal or fail-closed compatibility disposition of the legacy HMAC-only `createTask` write path.
5. Outbox wake-up atomicity or an independently tested recovery registry.
6. Execution Permit binding to executor, Task state/version, immutable start reservation, and lease generation.
7. Canonical Ledger object identity and legacy-data migration proof.
8. Effect-boundary fencing for any integration that needs stronger post-revocation guarantees.
9. Rewrapping of already-persisted tenant envelopes during wrapping-key rotation. Old KEKs must not be removed until a verified rewrap inventory and migration exists.
10. Live staging parity and end-to-end admission-to-lease test.

**Current delivery status:** The policy-freshness and isolated-signer foundation is implemented in source and CI-verified. The overall Admission protocol remains **NOT IMPLEMENTED / NOT DEPLOYED**. No source Worker binding in this branch proves that the corresponding live Cloudflare binding exists.
