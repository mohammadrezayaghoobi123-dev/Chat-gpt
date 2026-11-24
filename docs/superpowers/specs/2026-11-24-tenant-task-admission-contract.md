# Tenant-Bound Task Admission Contract

**Status:** Implementation contract for the next isolated security increment  
**Date:** 2026-11-24  
**Depends on:** TenantDirectory policy-scope version fence in PR #426

## Intent

Bind the persisted Task created by `OrchestratorLedger` to an independently signed authorization issued by the tenant's authoritative `TenantDirectory`. The authorization must cover the exact canonical Task, the tenant/project scope, the caller's membership version, the selected policy rule version, and the policy-scope epoch.

## Integrated architecture

There is one authorization authority: the tenant-partitioned TenantDirectory. It checks active membership and the `task.create` policy, signs a short-lived Ed25519 admission grant, and durably records the reservation before returning the grant. The reservation commit is the authorization linearization point.

The Ledger is the independent persistence and replay authority. It verifies the grant using public keys only, recomputes the canonical Task digest, and atomically consumes the grant JTI, persists the Task, records an immutable admission receipt, and creates the `task.admitted` Outbox event.

This is a two-Durable-Object protocol, not a distributed transaction. A Directory reservation can exist without a Ledger Task if the caller fails between the two calls. The same idempotency key returns the same still-valid grant, and the Ledger's admission receipt makes repeated delivery idempotent. The protocol guarantees one committed Ledger persistence effect per admission, not exactly-once network delivery.

## Trust boundaries and key custody

- TenantDirectory receives `TENANT_DIRECTORY_ADMISSION_PRIVATE_KEYS` and `TENANT_DIRECTORY_ADMISSION_ACTIVE_KID`. The private JWK must contain Ed25519 `d` and `x`.
- OrchestratorLedger receives `ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS`. Public JWKs must contain Ed25519 `x` and must reject private `d` material.
- The two key sets are deliberately asymmetric. Ledger cannot mint a valid admission grant.
- Missing, malformed, unknown-kid, or invalid key material fails closed.
- No private key, shared HMAC key, secret value, or key-generation operation is added to source control. Runtime key provisioning is a separate explicitly approved operational activity.

## Admission grant claims

The canonical signed payload contains exactly:

- `v`: protocol version 1
- `iss`: `tenant-directory`
- `aud`: `orchestrator-ledger`
- `sub`: authenticated principal ID
- `tenantId`, `projectId`, `taskId`
- `taskDigest`: SHA-256 of the normalized canonical Task projection
- `idempotencyKeyDigest`: SHA-256 of the caller idempotency key
- `inputHash`: existing Task input hash
- `membershipId`, `membershipVersion`
- `policyScopeEpoch`, `policyRuleVersion`, `policyRuleResourceDigest`, `policyDecisionId`
- `admissionId`, `jti`
- `iat`, `exp` (maximum lifetime 300 seconds)

The policy action is fixed to `task.create`. The rule resource digest must be the exact Task digest or the wildcard `*`.

## Consistency and revocation semantics

1. Directory reads membership, selected policy rule, and scope epoch as one synchronous snapshot.
2. Directory signs outside SQLite transactions. WebCrypto must never run inside `transactionSync`.
3. Directory opens a final `transactionSync`, re-reads membership/rule/epoch, and compares all versions with the signed snapshot.
4. If any authority value changed while signing, Directory rejects with `TASK_ADMISSION_SNAPSHOT_STALE`; no reservation or audit event is committed.
5. If the recheck succeeds, the reservation and append-only audit event commit together. That commit linearizes admission.
6. A revocation committed before the reservation causes admission to fail. A reservation committed first remains a historically valid admission even if revocation follows before Ledger persistence. This does not cancel already admitted or running work; cancellation and execution-time revocation are separate contracts.

## Ledger atomicity contract

Within one Ledger SQLite `transactionSync`:

- consume the existing one-time scheduler worker assertion;
- reject or idempotently recognize a previously consumed admission grant;
- insert the Task;
- insert the immutable `orchestrator_task_admission_receipts` row with unique `admissionId` and `jti`;
- insert one `task.admitted` Outbox event;
- synchronize the claim candidate index.

Any thrown SQL or persistence error rolls back all of these writes, including both one-time assertion consumption and grant receipt. A replay of the same valid admission returns the original Task and receipt and does not create another Task or Outbox event.

## Explicit non-goals

- No cross-Durable-Object transaction is claimed.
- No Scheduler runtime or `ScheduledController` provenance is proven. The existing system worker assertion remains a separate control and its runtime reachability remains open (PR #416).
- No live Cron, Queue consumer, Worker binding, key, secret, staging, or Production configuration is changed.
- No immediate cancellation semantics are added for membership revocation.
- No task execution or claim-time authorization check is added in this increment.

## Required hostile tests

- Valid signed grant is accepted for the exact Task and exact tenant/project.
- Task mutation, tenant/project/task substitution, idempotency-key substitution, or input-hash substitution is rejected.
- Tampered signature, unknown key ID, private key material supplied to verifier, expired token, missing key configuration, and unsupported protocol version fail closed.
- Grant replay with the same admission ID/JTI is idempotent; reused JTI with conflicting claims is rejected.
- A policy or membership mutation during asynchronous signing causes the final Directory recheck to reject and leaves no reservation/audit write.
- Revocation after committed reservation does not retroactively invalidate that already-authorized admission.
- An injected Outbox or admission-receipt insert failure leaves no Task, no receipt, no Outbox row, and no consumed JTI.
- Existing idempotency and tenant/project isolation behavior remains intact.

## Cloudflare implementation constraints

Cloudflare Workers Web Crypto supports Ed25519 `generateKey`, `importKey`, `exportKey`, `sign`, and `verify`. SQLite-backed Durable Object `transactionSync` callbacks must complete synchronously; exceptions roll back the transaction. The implementation therefore performs key operations before the final local transaction and rechecks all snapshotted authority versions inside it.
