# Hybrid Admission Authorization — Architecture Design

- **Status:** Proposed design; awaiting owner review
- **Date:** 2026-11-24
- **Scope:** Scheduled Orchestrator Task Admission across Tenant Directory and Orchestrator Ledger
- **Baseline:** main at 919b19ca3d3887352cdef06b03c668ead04fbce7
- **Change class:** Documentation only; no runtime or deployment changes

## 1. Intent

Define one coherent admission protocol that combines:

1. Cryptographically verifiable admission evidence.
2. Strict authorization freshness and revocation ordering.
3. A single per-tenant authority for membership, policy, admission, and execution-start authorization.

The design must close the current gap between Tenant Directory authorization and Ledger Task creation without pretending that separate Durable Objects share an ACID transaction.

## 2. Current-State Evidence

The following observations were verified against the stated main baseline:

| Source | Observed behavior | Design consequence |
|---|---|---|
| cloud-engineering-connector/identity/tenant-directory-adapter.js | The adapter selects one TenantDirectory object using the selected tenant identifier and namespace idFromName mapping. | TenantDirectory is already a natural per-tenant coordination boundary. |
| identity/tenant-directory.js, membership schema and getActiveMembership | Membership records carry an increasing numeric version; the membership lookup returns it. | Membership freshness can be bound to an admission. |
| identity/tenant-directory.js, upsertMembership and revokeMembership | Membership mutation and associated policy disabling occur inside a synchronous storage transaction. | Membership revocation already has a local atomic state-change boundary. |
| identity/tenant-directory.js, upsertProjectPolicy | Each policy row has a numeric row version and a decision identifier. | The numeric row version must be distinguished from the caller-supplied policyVersion label. |
| identity/tenant-directory.js, authorizeProjectAction | The authorization result currently returns decisionId and policyVersion, but not membership version, selected policy rule version, or a policy-scope epoch. | The current decision cannot be used as a complete freshness proof. |
| identity/tenant-context.js | The verified tenant context currently omits the membership version; the final authorization result also omits the policy row version. | Version provenance is discarded before it can be bound to admission. |
| orchestrator-ledger.js, createTask | Task creation verifies a Scheduler worker assertion and tenant/project syntax, then consumes the assertion and persists the task. It does not accept or verify a Tenant Directory decision or signed admission receipt. | A cryptographic Scheduler identity assertion is not a substitute for project authorization. |
| worker.js and index.js | The default Worker exports fetch only; index.js re-exports TenantDirectory and OrchestratorLedger, but no scheduled handler or Scheduler-to-Ledger createTask path was found. | Runtime scheduling reachability is not implemented in the reviewed Worker path. |
| wrangler.toml | The source configuration contains no Cron trigger declaration. | Adding a scheduled handler alone would not activate a schedule; the Cron trigger must be separately reviewed and configured in staging. |
| wrangler.toml | Source configuration declares both ORCHESTRATOR_LEDGER and TENANT_DIRECTORY bindings for production and staging. | Source bindings do not prove that the live Production Worker has those bindings or an active scheduler. |

No production exploitability conclusion is made from these facts. The design addresses a source-level authorization and reachability gap.

## 3. Non-Negotiable Invariants

1. **One authorization authority per tenant.** TenantDirectory is the sole authority for membership state, effective policy, admission decisions, revocation ordering, and execution-start authorization.
2. **No caller-asserted identity.** HTTP input, RPC arguments, task JSON, and arbitrary controller-shaped objects cannot establish Scheduler provenance.
3. **Grant-to-request binding.** Every admission proof binds the exact principal, tenant, project, action, resource digest, task identifier, canonical task digest, idempotency scope, Scheduler invocation, membership version, policy-scope version, selected rule version, and decision identifier.
4. **Freshness is numeric and authoritative.** A caller-supplied policyVersion label is descriptive metadata, not a monotonic revocation counter.
5. **Fail closed.** Missing authority, unavailable state, unknown signing key, invalid signature, stale version, replay, digest mismatch, ambiguous timeout, or invalid Scheduler provenance cannot authorize execution.
6. **No cross-object ACID claim.** Durable Object transactions are local to one object's private storage. Cross-object delivery is recoverable and idempotent, not one distributed SQL transaction.
7. **No exactly-once transport claim.** Delivery may be repeated. Durable identity constraints make the resulting state transition idempotent.
8. **No secret exposure.** Private signing material, HMAC keys, credentials, and raw bearer assertions never enter Task JSON, Outbox payloads, audit details, logs, or PR text.

## 4. Chosen Architecture: Hybrid Per-Tenant Admission Authority

### 4.1 Authority placement

Extend the existing TenantDirectory Durable Object as the per-tenant Admission Authority. Do not create a global singleton. The current tenant-to-object mapping remains the isolation boundary.

The Authority owns:
- Membership and membership version.
- Project policy rules and a policy-scope epoch.
- Admission records and signed Admission Receipts.
- Admission Outbox and projection acknowledgements.
- Execution-start authorization and one-time Execution Permits.
- Append-only authorization and admission audit events.
- Tenant-scoped signing-key identifiers and public-key metadata.

The OrchestratorLedger remains the operational Task projection, idempotency, execution lease, transition, and outbox store. It is not an independent authorization authority.

### 4.2 Why the three options are combined

| Mechanism | Responsibility | Required invariant |
|---|---|---|
| Signed Admission Grant | Portable cryptographic evidence of one exact admission decision. | A receipt cannot be moved to another tenant, project, principal, task, resource, or Scheduler invocation. |
| Strict Revocation | Detect all relevant membership and policy changes before execution-start authorization. | Any stale membership version or policy-scope epoch blocks a not-yet-start-authorized task. |
| Single Admission Authority | Serialize admission, policy mutation, revocation, and execution-start authorization for one tenant. | Concurrent operations have a single durable commit order within the tenant authority. |

A signature proves who issued a statement and what it covers. It does not prove that the statement is still current. Current-state revalidation is mandatory.

## 5. Authorization Version Model

### 5.1 Membership version

Carry the existing numeric membership version through:
- getActiveMembership;
- resolveTenantContext;
- authorizeProjectAction;
- Admission Receipt;
- Authority execution-start revalidation.

Every membership mutation that changes status, role, or active membership identity must increment the version. Reactivation must never restore an old version.

### 5.2 Policy-scope epoch

Add a monotonically increasing policy-scope epoch keyed by:

- tenant;
- project;
- principal;
- action.

Increment the epoch in the same TenantDirectory SQL transaction whenever any policy rule in that scope is created, changed, disabled, replaced, or deleted. This must include wildcard-rule changes and exact-resource overrides.

This scope epoch is required because the currently selected rule can change when a new exact rule is added even if the previously selected wildcard rule itself did not change.

The authorization result and receipt must include:
- policy-scope epoch;
- selected policy rule resource digest;
- selected policy rule numeric version;
- decision identifier;
- policyVersion label.

The selected rule and epoch must be read from one consistent TenantDirectory state.

### 5.3 Canonical digests

Use the repository's canonical JSON and SHA-256 primitives, with a documented, versioned canonicalization contract.

Canonicalize the Task exactly once at request admission into immutable serialized bytes. The exact bytes used for signing and Outbox delivery must be the same; do not re-read a mutable caller object after hashing.

Compute independently:
- resourceDigest: exact resource descriptor used by policy evaluation;
- taskDigest: complete canonical Task payload accepted by the Ledger;
- idempotencyKeyDigest: tenant/project-scoped idempotency identity.

The Ledger must recompute taskDigest from the received Task. It must not trust a caller-supplied inputHash as proof that the Task matches the receipt.

## 6. Cryptographic Evidence

### 6.1 Admission Receipt

Use Ed25519 signatures through the Workers Web Crypto implementation, subject to a compatibility/runtime test before implementation.

The signed claim set must contain at least:
- contract version and key identifier;
- issuer, audience, token type, issued-at and expiry;
- admission identifier and unique JTI;
- principal identifier and membership identifier;
- tenant, project, and authorized action;
- membership version;
- policy-scope epoch;
- selected policy rule identifier/key and numeric version;
- decision identifier and policyVersion label;
- resource digest and canonical task digest;
- task identifier and idempotency-key digest;
- Scheduler invocation identifier, configured cron identifier, and scheduled time.

The private key must remain inside the TenantDirectory authority boundary and must never be returned by RPC. The Ledger receives only public verification material and key identifiers. It resolves a key identifier through a narrow read-only TenantDirectory RPC for the receipt's tenant; it must not accept a public key supplied by the receipt sender. Unknown identifiers fail closed. Private-key persistence, encryption-at-rest, restore behavior, rotation, and emergency replacement must be tested before enabling production signing.

Do not reuse the existing Scheduler HMAC key as the Admission Receipt signing key. Use domain separation and independent key identifiers.

### 6.2 Scheduler provenance

The Worker must introduce an explicit scheduled-event handler. Only that handler may construct a Scheduler invocation proof from the platform-delivered scheduled event context.

The proof must be bound to:
- fixed issuer, subject, audience, and operation constants;
- an allowlisted configured cron identifier;
- platform-provided scheduled time;
- a fresh invocation identifier;
- tenant/project/task scope and task digest.

The public fetch path must not mint or accept a Scheduler proof. A caller-supplied boolean, role string, cron string, timestamp, or object shaped like a scheduled controller is not evidence of a real scheduled invocation.

The existing Scheduler assertion helper audited in the evidence PR is not sufficient as a runtime-origin proof because it accepts caller-supplied expected claims and does not establish that the call originated in the scheduled handler.

## 7. Atomic Admission Protocol

Cryptographic operations are asynchronous, while SQLite transactionSync callbacks must be synchronous. Therefore signing must not occur inside transactionSync.

The Authority performs:

1. Validate the authenticated principal, exact scope, Scheduler proof, resource descriptor, and canonical Task payload.
2. Read a consistent authorization snapshot: membership status/version, selected rule, policy-scope epoch, decision identifier, and effective policy.
3. Reject unless membership is active and the exact policy decision is allow.
4. Compute canonical digests and sign a candidate Admission Receipt outside the SQL transaction.
5. Enter a synchronous TenantDirectory storage transaction.
6. Re-read membership, selected rule, policy-scope epoch, and all expected versions.
7. Reject with AUTHORIZATION_STATE_CHANGED if any value differs from the signed snapshot.
8. Insert the Admission record, unique receipt/JTI identity, append-only audit event, and Outbox event in the same transaction.
9. Commit. This commit is the linearization point for Admission.
10. Schedule the TenantDirectory alarm for Outbox delivery after the commit.

The receipt is not accepted as executable permission merely because it is signed. It records an admission decision and its immutable version snapshot.

An identical retry with the same tenant/project idempotency key and identical task digest returns the original admission. Reuse of that key with a different task digest returns an idempotency conflict.

## 8. Cross-Durable-Object Atomicity and Outbox

### 8.1 Explicit boundary

Cloudflare documents private transactional storage per Durable Object. It does not provide one transaction spanning TenantDirectory and OrchestratorLedger.

Consequently:
- Admission plus Authority Outbox is one local transaction.
- Ledger receipt consumption plus Task projection plus its local claim-candidate updates is a separate local transaction.
- Delivery and acknowledgement between those objects are an idempotent protocol.
- The Authority remains the source of truth; Ledger state is a projection.

### 8.2 Delivery state machine

Authority Outbox:
- PENDING;
- LEASED;
- DELIVERED;
- RETRY_WAIT;
- DEAD_LETTER.

The TenantDirectory alarm:
1. Atomically claims a bounded batch with a lease.
2. Calls the Ledger outside the storage transaction.
3. The Ledger verifies the signature, tenant/project/task scope, current accepted contract version, and recomputed task digest.
4. The Ledger atomically inserts its admission-consumption identity and Task projection. Duplicate identical delivery returns the original result; conflicting reuse is rejected.
5. The Authority records the acknowledgement in a separate local transaction.
6. If the call or acknowledgement outcome is uncertain, the Authority retries after lease expiry. The Ledger's uniqueness constraints make duplicate delivery safe.

No Outbox payload contains private keys or raw authentication credentials. An Outbox event carries only the signed receipt and the minimum Task projection required by the Ledger.

### 8.3 Recovery guarantees

- Authority commit succeeds, Ledger unavailable: the durable Outbox remains pending and is retried.
- Ledger commits, acknowledgement is lost: redelivery returns the same Ledger admission projection.
- Authority restarts: persisted Outbox state and alarm scheduling recover delivery.
- Ledger restarts: unique admission/JTI records prevent duplicate Task creation.
- Repeated conflict or exhausted retry policy: dead-letter and alert; never mark delivered without a Ledger acknowledgement.
- An operator replay must preserve admission ID, receipt, and task digest. It must not mint a new authorization implicitly.

## 9. Strict Revocation and Execution Start

### 9.1 Start authorization

Before a Task can obtain an execution lease or perform work, the Ledger/Worker must request an Execution Permit from the TenantDirectory authority.

The Authority:
1. Loads the immutable Admission record.
2. Reads current membership status/version and current effective policy.
3. Recomputes the current policy-scope epoch and compares every bound version, scope, decision, and digest.
4. Rejects if membership is inactive, policy is no longer allow, a version changed, the admission is not eligible, or the receipt is invalid.
5. Signs a short-lived one-time Execution Permit outside the SQL transaction.
6. In a synchronous transaction, rechecks the same current state and expected versions.
7. Atomically records START_AUTHORIZED, the unique permit/JTI, and a monotonic fencing value.
8. Commits. This is the linearization point for execution-start authorization.
9. The Ledger consumes the permit and persists the lease in its own transaction. Duplicate permit delivery returns the same lease result; conflicting use is rejected.
10. If the authority commit succeeded but the Ledger acknowledgement is uncertain, recovery must reuse the same logical permit identifier and admission start reservation. It must not create a second start authorization. Permit expiry and recovery horizon are configuration decisions; once START_AUTHORIZED committed, later revocation does not retroactively erase that ordering.

A revocation that commits before step 7 prevents execution-start authorization. A start authorization that commits before revocation is ordered before that revocation. This is a precise serialization rule, not a claim that the remote worker's first CPU instruction or external side effect is part of the Authority transaction.

### 9.2 Revocation effects

- Membership revoke/suspend increments membership version and updates status in the Authority transaction.
- Policy changes increment the policy-scope epoch in the Authority transaction.
- An admitted but not START_AUTHORIZED task with a stale snapshot cannot obtain a permit.
- Reactivation or a later policy allow does not revive the old receipt; a fresh admission is required.
- Already START_AUTHORIZED or running work is not retroactively made never-started. Cancellation of running work requires a separate cooperative cancellation/fencing contract at every effectful boundary.

### 9.3 External side-effect limit

No transaction can atomically include Cloudflare Durable Object storage and an arbitrary external API such as GitHub. If the product requires that no external side effect occur after a revocation commit, every effectful adapter must enforce the current fencing/authorization epoch at its own commit boundary. An external provider that cannot participate in such fencing cannot be given an absolute instantaneous-revocation guarantee.

## 10. State Machines

Admission:
- REQUESTED;
- ADMITTED_PENDING_PROJECTION;
- PROJECTED;
- START_AUTHORIZED;
- RUNNING;
- COMPLETED;
- FAILED;
- AUTHORIZATION_STALE;
- REJECTED;
- DEAD_LETTERED.

Execution Permit:
- ISSUED;
- CONSUMED;
- EXPIRED;
- REJECTED;
- RECONCILIATION_REQUIRED.

Transitions must be explicit, validated, append-only audited, and idempotent. No state may move backward. Terminal state policy and the distinction between execution failure and authorization rejection must be maintained.

## 11. Proposed Code Ownership

| Path | Responsibility |
|---|---|
| identity/tenant-directory.js | Membership/policy scope epoch, Admission records, signing, revocation ordering, execution-start authorization, Outbox and alarm. |
| identity/tenant-directory-adapter.js | Narrow typed adapters for membership, policy, admission, receipt verification metadata, and execution-start authorization. |
| identity/tenant-context.js | Preserve verified membership version and policy evidence across trust-boundary objects. |
| identity/tenant-directory-assertion.js | Keep provisioning assertion responsibilities separate from admission receipt and Scheduler provenance contracts. |
| orchestrator-scheduler-assertion.js (proposed) | Private scheduled-handler provenance minting and verification; no fetch/RPC caller-controlled issuance. |
| orchestrator-admission-receipt.js (proposed) | Versioned canonical receipt/permit claims and Ed25519 signing/verification helpers. |
| orchestrator-ledger.js | Verify receipt, consume admission/JTI, apply idempotent Task projection, consume Execution Permit, and persist lease. |
| worker.js | Add explicit scheduled handler and route scheduled work through the per-tenant Authority; retain fetch path without Scheduler minting capability. |
| wrangler.toml | Add only the required alarm/handler configuration and staged bindings after review; no Production binding/deployment changes in the design phase. |

The existing Ledger Durable Object ID mapping is not established by the reviewed Worker call sites. Implementation must inspect existing namespace identity usage and persisted data before selecting or changing a partition key. Do not silently re-key existing Ledger objects or migrate legacy records.

## 12. Hostile Test Matrix

Tests must run against the actual TenantDirectory and OrchestratorLedger classes using deterministic interleaving barriers, not timing sleeps.

| ID | Adversarial case | Required result |
|---|---|---|
| HA-01 | HTTP caller attempts to mint Scheduler provenance | Reject; no scheduler key/signing capability on fetch path. |
| HA-02 | Fake controller-shaped object passed to helper | Reject; only scheduled handler owns minting capability. |
| HA-03 | Membership revocation commits before Admission transaction | Admission rejects as stale. |
| HA-04 | Admission commits before Membership revocation | Receipt remains historical; later start authorization rejects. |
| HA-05 | Exact policy override is added after wildcard-based Admission | Policy-scope epoch changes; old start request rejects. |
| HA-06 | Policy row disabled/changed after Admission | Old start request rejects. |
| HA-07 | Membership reactivated at a new version | Old receipt remains invalid. |
| HA-08 | policyVersion label reused while numeric policy state changes | Old receipt rejects based on numeric epoch/version. |
| HA-09 | Task field changed after signing | Ledger recomputed digest mismatch; reject. |
| HA-10 | Receipt copied to another tenant/project/principal | Reject scope binding. |
| HA-11 | Admission receipt or Execution Permit replayed | Same idempotent outcome only where payload is identical; otherwise reject. |
| HA-12 | Two identical admission requests race | One durable admission identity and one Task projection. |
| HA-13 | Same idempotency key with different task digest | Conflict; no second Task. |
| HA-14 | Signature invalid, unknown kid, expired permit, wrong audience | Fail closed. |
| HA-15 | Authority commits Outbox but delivery fails | Pending event remains recoverable. |
| HA-16 | Ledger commits projection but acknowledgement is lost | Retry returns same projection; no duplicate Task. |
| HA-17 | Authority/DO restart with leased Outbox event | Lease expires/reconciles and delivery resumes safely. |
| HA-18 | Revocation races Execution Permit commit | Authority commit order determines outcome; no stale version accepted. |
| HA-19 | Ledger attempts direct createTask without Admission Receipt | Reject for all new scheduled-task admission paths. |
| HA-20 | Key rotation while receipts are pending | Active and retained verification keys validate only within defined rotation window. |
| HA-21 | Dead-letter replay with same receipt | Same admission identity; no duplicate Task or new grant. |
| HA-22 | Cross-tenant object routing mismatch | Reject before persistence; no fallback to a global/legacy scope. |

Required test properties:
- Every race test has deterministic barriers and asserts both legal commit orders.
- Alarm delivery tests use the Cloudflare Durable Object test API to trigger the alarm deterministically and verify duplicate/ retry safety.
- All rejected cases assert no Task, lease, or unauthorized Outbox side effect was committed.
- Replay tests assert both the stored digest and admission identity.
- Key-rotation tests include restart and previous-key retirement.
- Property tests vary key order and nested Task fields to validate canonicalization.
- Test output distinguishes REJECTED, DISPUTED, and UNKNOWN. An unexecuted race test is UNKNOWN, not passed.

## 13. Rollout and Rollback

1. **Design review:** approve this contract and resolve the open decisions below.
2. **Staging schema phase:** additive migrations only; test membership/policy version epochs and key initialization. No scheduled production traffic.
3. **Authority phase:** implement Admission and Outbox in staging; verify local transaction invariants and revocation races.
4. **Ledger phase:** implement receipt verification and idempotent projection; keep direct new Task admission fail-closed.
5. **Scheduler phase:** add scheduled handler and allowlisted cron only in staging, behind an explicit disabled-by-default gate.
6. **End-to-end phase:** fault-inject DO RPC loss, acknowledgement loss, restarts, replay, clock skew, key rotation, and out-of-order revocation races.
7. **Canary phase:** only after all acceptance gates pass and explicit deployment approval.
8. **Production phase:** requires a separate user approval. No automatic merge, migration, binding modification, secret creation, Cron activation, or deploy is authorized by this design.

Rollback must disable new scheduled admissions first, preserve all Admission/Outbox/Audit records, prevent new execution permits, and leave existing Ledger task data intact. Never rollback by deleting consumed JTI/admission records or re-enabling stale receipts.

## 14. Acceptance Gates

The design is implementation-ready only after:
- all 22 hostile scenarios have executable tests;
- all invariants have a source-level owner and an observable assertion;
- no asynchronous operation occurs inside transactionSync;
- admission state and its outbox event commit atomically in TenantDirectory;
- Ledger receipt consumption and Task projection commit atomically in Ledger;
- execution-start authorization is serialized with Membership/Policy mutation in the same TenantDirectory object;
- no code path can create a new scheduled Task without verified Admission evidence;
- Scheduler provenance is reachable only from the platform scheduled handler;
- the approved Cron expression is declared explicitly in Wrangler staging configuration and exercised through the actual scheduled handler;
- all retries and uncertain outcomes are idempotently reconciled;
- key rotation, restore, and failure behavior are verified;
- staging passes the full suite, and Production remains unchanged until explicitly approved.

## 15. Open Decisions Requiring Owner Review

1. **Already-started work:** The proposed default is that revocation blocks tasks that have not committed START_AUTHORIZED. Work already past that linearization point is treated as in-flight; stopping it requires a separate cooperative cancellation/fencing policy. Confirm whether revocation must also attempt to cancel already-running work.
2. **Signing-key custody:** Confirm the acceptable boundary for private-key custody, rotation, backup/restore, and emergency replacement. The recommendation is Ed25519 with private signing material isolated to the TenantDirectory authority and public verification material available to the Ledger.
3. **Ledger partition identity:** Before implementation, establish the existing OrchestratorLedger object-name convention and whether any persisted legacy task data depends on it. Preserve existing IDs; no implicit re-partitioning.
4. **Scheduler scope:** Confirm the allowed cron identifiers and which tenant-scoped service principal is the policy subject for each scheduled task class. The runtime scheduled event proves Scheduler origin; it does not itself grant project permission.

These decisions do not change the core choice to combine Signed Admission, Strict Revocation, and a Single Per-Tenant Authority.

## 16. Source and Platform References

Repository baseline:
- Tenant Directory: cloud-engineering-connector/identity/tenant-directory.js
- Tenant context: cloud-engineering-connector/identity/tenant-context.js
- Tenant adapters: cloud-engineering-connector/identity/tenant-directory-adapter.js
- Ledger: cloud-engineering-connector/orchestrator-ledger.js
- Worker handler: cloud-engineering-connector/worker.js
- Durable Object bindings: cloud-engineering-connector/wrangler.toml
- Canonical JSON and digest: cloud-engineering-connector/orchestrator-protocol.js
- Existing Directory tests: cloud-engineering-connector/cloudflare-test/tenant-directory.test.js

Cloudflare platform references:
- Durable Object storage and transactionSync: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Durable Object per-object private storage: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- Durable Object coordination and transaction boundaries: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workers Web Crypto algorithm support, including Ed25519: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Durable Object automatic retries and idempotency requirements: https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/
- Durable Object alarm execution and retry semantics: https://developers.cloudflare.com/durable-objects/api/alarms/
- Worker scheduled handler and ScheduledController fields: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cron Trigger configuration: https://developers.cloudflare.com/workers/configuration/cron-triggers/

