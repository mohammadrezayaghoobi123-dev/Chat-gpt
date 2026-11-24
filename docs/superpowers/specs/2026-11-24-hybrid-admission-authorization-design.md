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
9. Persist and set the next Outbox wake-up alarm as part of the same local transaction only if an integration test proves that setAlarm participates in transactionSync commit and rollback semantics. The test must prove both directions: rollback leaves no new alarm; commit leaves both Outbox and alarm durable.
10. If setAlarm cannot be proven to participate in the same transaction, do not schedule it after commit and claim atomicity. Select and test an independent durable wake/reconciliation mechanism before implementation; a periodic scanner requires an explicit tenant registry or equivalent discoverable work index.
11. Commit. This commit is the linearization point for Admission.

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
7. The alarm handler must be idempotent and persist retry state. Cloudflare alarm delivery is at-least-once and runtime retries failures with backoff; after its retry budget is exhausted, the handler must leave work recoverable and schedule another wake-up while due work remains.
8. Each Durable Object has one alarm slot. TenantDirectory must coordinate that slot through a persisted due-work index; it must not overwrite another alarm consumer.

No Outbox payload contains private keys or raw authentication credentials. An Outbox event carries only the signed receipt and the minimum Task projection required by the Ledger.

### 8.3 Recovery guarantees

- Authority commit succeeds, Ledger unavailable: the durable Outbox remains pending and is retried.
- Ledger commits, acknowledgement is lost: redelivery returns the same Ledger admission projection.
- Authority restarts: persisted Outbox state and alarm scheduling recover delivery only after the alarm/transaction integration gate above is proven; otherwise the independently reviewed recovery scanner is mandatory.
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
- Alarm delivery tests use the Cloudflare Durable Object test API to trigger the alarm deterministically and verify duplicate/retry safety.
- Alarm atomicity tests prove that Outbox commit and alarm scheduling commit together, and that a forced rollback leaves neither durable. If the platform behavior cannot meet this condition, the fallback wake mechanism must be tested under crash-before-wake and restart conditions.
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
- Outbox wake-up cannot be lost between transaction commit and alarm scheduling; this requires proven alarm/transaction behavior or an independent durable recovery mechanism;
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

## 17. Hostile Contract-Closure Addendum

- **Status:** Engineering recommendations for owner review; not owner-approved and not implementation authorization.
- **Review date:** 2026-11-24.
- **Review inputs:** PR #428 hostile findings; fresh GitHub branch/PR reads; fresh Cloudflare GET-only inventory; Cloudflare documentation reviewed on 2026-11-24.
- **Change class:** Design clarification only. No runtime behavior is authorized by this addendum.

This section converts each blocking/high-risk finding into a proposed contract, an explicit decision boundary, and falsifiable acceptance criteria. Recommendations are not silently promoted to requirements. The owner decisions in Section 15 remain open until explicitly accepted.

### 17.1 Evidence delta and deployment boundary

The following observations were freshly rechecked:

| Surface | Observed fact | Consequence |
|---|---|---|
| GitHub main | `main` remained at `919b19ca3d3887352cdef06b03c668ead04fbce7`. | This addendum is based on the same reviewed baseline. |
| PR #425 | Open, draft, unmerged; design branch head `422ef1e4a40d8ef15eb3af47bf4e52ab61f2318f` before this addendum. | The design is still under review. |
| PR #428 | Open, draft, unmerged; hostile review head `4009cdd4929dce6d65ec090630247f3ab24cbdc6`. | The blockers remain review findings, not resolved implementation facts. |
| Cloudflare schedules | `chat-gpt111`, `chat-gpt111-staging`, and `master-brain-cloud-agent` each returned an empty schedule list. | No active Cron Trigger was observed for these Workers. |
| Cloudflare Durable Object namespaces | The inspected account listed `AgentBudget`, `AgentSession`, and staging `WriteControl`; no `OrchestratorLedger` or `TenantDirectory` namespace was listed. | The proposed admission objects are not present in this inspected live account inventory. This does not prove that no other account/environment ever held legacy data. |
| Worker bindings | Production `chat-gpt111` had no Durable Object namespace binding. Staging exposed `WriteControl`, not the proposed admission namespaces. | Source declarations must not be treated as proof of deployed bindings. |
| Worker secrets | Only binding names/types were read; secret values were not accessed. | No secret value is included in this review. |

The deployment delta is a release-readiness fact, not a claim that the source design is invalid. Any future staging implementation must first establish the exact account, script, namespace, binding, migration, and data-inventory scope.

### 17.2 Decision D1 — Revocation semantics and the meaning of start

**Recommended v1 contract: reservation-time authorization, not instantaneous effect-time revocation.**

Define three distinct events:

1. `ADMITTED`: the Authority commits a valid admission and Outbox record.
2. `START_RESERVED`: the Authority serializes a one-time start reservation against membership and policy mutations. The reservation commit is the authorization linearization point.
3. `LEASE_CONSUMED`: the Ledger consumes the matching permit and commits the executor lease.

The name `START_AUTHORIZED` must not be described as proof that the worker's first instruction or an external side effect has already occurred. A reservation committed before a revocation is ordered before that revocation, even if the Ledger lease or worker execution happens later.

Under the recommended v1 semantics:

- A revocation prevents new start reservations whose Authority transaction linearizes after the revocation.
- An admission with no committed start reservation becomes stale when its membership version or policy-scope epoch changes.
- A start reservation committed before revocation is treated as in-flight authorization. The system does not claim that revocation can retroactively erase it.
- A permit has a short, explicit expiry and one immutable reservation identity; expiry does not create a second reservation.
- Any UI, audit, and API status must distinguish `START_RESERVED` from `LEASE_CONSUMED` and `RUNNING`.

**Stronger effect-boundary guarantee:** If the product requires no effect to commit after revocation, each effect adapter must carry the monotonic fencing epoch and the external effect boundary itself must atomically reject stale epochs. A check performed only before a remote API call is not sufficient: revocation can race between the check and the provider's commit. Where the provider cannot enforce a fencing condition at its own commit boundary, an absolute post-revocation no-effect guarantee is unavailable and must not be advertised.

**Owner decision remains required:** accept reservation-time semantics for v1, or defer execution until every effectful integration has a provider-enforced fencing contract. This document recommends the former only as a scoped, accurately labelled first release.

**Falsification tests:**

- Pause after `START_RESERVED` commits but before the Ledger RPC; revoke membership; resume. The result must match reservation-time ordering, with no new reservation created after revoke.
- Pause before `START_RESERVED`; revoke membership; resume. The Authority must reject the stale admission.
- Pause after `LEASE_CONSUMED` and before an effect adapter; revoke membership. An adapter claiming strong fencing must reject a stale epoch at its provider commit boundary; otherwise the test must record that the provider cannot supply the strong guarantee.
- Expire a permit and retry the same reservation. The system must return the same terminal reservation outcome, not mint a second reservation.

### 17.3 Decision D2 — Outbox wake-up and recovery

Cloudflare's current Alarms documentation says alarms are modified through the Durable Object Storage API and that alarm operations follow the same rules as other storage operations. The SQLite `transactionSync` documentation separately states that its callback must be synchronous and that synchronous storage operations can participate in the transaction. The reviewed documentation does not explicitly state, in one normative example or guarantee, that `setAlarm()` is rolled back atomically with a SQLite `transactionSync()` callback.

Therefore, documentation alone is not accepted as proof of the Outbox wake-up invariant.

**Required test gate before choosing the alarm path:**

- In a real `cloudflare:test` SQLite Durable Object integration test, write an Outbox row and call `setAlarm()` within the intended transaction boundary, then force the callback to throw. After object re-instantiation, assert that neither the row nor the newly scheduled alarm exists.
- In the commit case, write the row and alarm, commit, evict/restart the object, and assert that both remain discoverable.
- Exercise an already-existing alarm to ensure the next-due calculation does not overwrite an earlier or later due item incorrectly.
- Exercise duplicate scheduling and concurrent request interleavings. The single alarm slot must remain a wake-up pointer to the earliest durable due-work item, not the source of truth for individual work records.

**Decision rule:**

- If the commit/rollback/restart tests pass on the exact runtime and compatibility configuration selected for staging, the same-object Outbox plus alarm may be used, subject to regression tests on runtime upgrades.
- If any result is failing, inconsistent, or unavailable, alarm atomicity remains `UNKNOWN`; do not claim no-lost-wakeup behavior and do not implement an after-commit best-effort alarm as an equivalent substitute.
- The fallback is a periodic reconciler over a pre-provisioned durable tenant registry. Tenant registration must complete before a tenant can be admitted; the reconciler stores a durable cursor, scans bounded batches, asks each registered TenantDirectory for pending due work, and reschedules itself. Its own registry and cursor require independent failure/restart tests. This fallback is a separate component and cost decision, not a free side effect of the existing design.

Alarm delivery remains at-least-once. The Outbox row and Ledger projection must remain idempotent after duplicate delivery, retry exhaustion, object restart, and downstream outage.

### 17.4 Decision D3 — Canonical Ledger object identity and partitioning

**Recommended model for a new deployment:** one OrchestratorLedger Durable Object per tenant, using one documented, stable canonical name derivation shared by every production entrypoint and test fixture. The proposed v1 derivation is `idFromName(tenantId)`, matching the existing TenantDirectory tenant-name convention. The selected string must be treated as immutable once any task is persisted.

Consequences of this recommendation:

- Each tenant receives an independent Ledger storage/transaction boundary.
- Existing per-object `task_id` and `idempotency_key` uniqueness constraints remain local to that tenant's Ledger.
- Cross-tenant rows in one Ledger object are no longer the test topology. Tests must create one canonical Ledger stub per tenant.
- The tenant-wide object may become a throughput hotspot for a very large tenant; this is an explicit trade-off, not a hidden scalability claim.

**Migration safety gate:** do not switch an existing shared Ledger to per-tenant naming by changing `idFromName()` in place. First inventory every deployed environment and legacy namespace/object-name convention, determine whether persisted tasks or idempotency keys exist, and produce a deterministic migration/backfill/rollback map. If any persisted legacy object is found, the current identity must be preserved until a separately reviewed migration can prove row conservation and replay safety.

The fresh Cloudflare inventory found no Ledger namespace or Ledger binding for the three inspected Workers. That is useful evidence for a clean new rollout in this account, but it does not prove that there is no legacy object or data in another account, script, environment, or previously deployed namespace.

**Falsification tests:**

- Every production route for the same tenant resolves to the same Ledger object ID.
- Different tenant IDs resolve to different Ledger object IDs.
- A tenant ID cannot be changed or normalized differently across API, Scheduler, adapter, and test paths.
- Migration rehearsal preserves every legacy task ID, idempotency identity, status, claim, and audit reference; counts and canonical row digests must reconcile before/after.
- A simulated interrupted migration can resume without duplicate or unreachable tasks.

### 17.5 Decision D4 — Receipt projection API and legacy createTask closure

**Recommended API:** introduce `projectAdmittedTask(input)` as the only Ledger write path for a newly scheduled Task.

The input contains the immutable Task payload plus the Admission Receipt. The Ledger must:

1. Reject malformed, expired, wrong-audience, wrong-issuer, unknown-key, invalid-signature, wrong-tenant, wrong-project, wrong-task, wrong-resource, or wrong-digest receipts.
2. Resolve the verification key through a trusted TenantDirectory lookup keyed by tenant and key ID. It must never trust a public key supplied by the receipt sender.
3. Recompute the canonical Task digest from the exact bounded payload bytes; never treat a caller-supplied `inputHash` as proof.
4. Preserve `assertNoSecretFields`, canonical JSON serialization, and the existing 32 KiB serialized Task limit.
5. In one Ledger transaction, consume the receipt identity and insert the Task plus the local claim-candidate projection.
6. Return the original result for an identical replay; reject conflicting reuse without writing a second Task.

**Required unique identities (subject to compatibility review of current indexes):**

- `task_id`: existing primary key within the chosen Ledger partition.
- `admission_id`: unique for the tenant's immutable admission.
- `(issuer, receipt_jti)`: unique receipt replay identity.
- `(tenant_id, project_id, idempotency_key_digest)`: unique idempotency scope, or an equivalent exact constraint proved equivalent under the selected partition model.
- `start_reservation_id`: unique and immutable per Admission.
- `(permit_issuer, permit_jti)`: unique one-time permit consumption identity.

The database migration must explicitly define conflict behavior for every identity; application-only pre-checks are not substitutes for unique constraints.

**Legacy `createTask()` disposition:** it must not remain a second route that can insert a newly scheduled Task using only the existing HMAC Worker Assertion. Recommended transition:

- Retain the method temporarily only as a compatibility shim.
- Without a valid Admission Receipt, return a stable `ADMISSION_RECEIPT_REQUIRED` error before any Task, idempotency, JTI, or claim-candidate write.
- With a receipt, delegate to the exact same validation and transaction path as `projectAdmittedTask`; do not duplicate persistence logic.
- Keep the HMAC assertion only as a separate workload-authentication factor during migration, if existing deployment policy requires it. It is never authorization evidence and never replaces the Receipt. Bind it to the same tenant, project, task digest, audience, operation, and Scheduler invocation.
- Remove the shim and retire the old assertion only in a separate reviewed migration after every caller and test has been migrated. No legacy bypass is implied by the compatibility period.

If a non-scheduled legacy producer is discovered, it must receive a separate explicitly scoped API and authorization contract; it must not be silently grandfathered through the scheduled-task admission path.

**Falsification tests:**

- Call every task-creation method with no Receipt but with a valid legacy HMAC assertion. Assert rejection and zero writes to Task, idempotency, JTI, and claim-candidate state.
- Submit a valid Receipt and Task twice. Assert exactly one Task and one receipt-consumption row.
- Reuse an admission ID or JTI with a different task digest, task ID, or tenant. Assert conflict and no second write.
- Mutate the caller object after digest calculation. Assert the persisted bytes remain exactly those that were signed.
- Submit a secret-bearing or over-limit Task. Assert rejection before persistence.

### 17.6 Decision D5 — Complete policy-scope epoch mutation semantics

The policy-scope key is the exact tuple `(tenant_id, project_id, principal_id, action)`.

In the same TenantDirectory SQL transaction as the policy/membership mutation:

- Increment the epoch exactly once for each distinct affected tuple whose effective rule set changes.
- For an individual policy update, increment the affected tuple even when the selected rule was not previously the winning rule; insertion of an exact-resource rule can change precedence over a wildcard rule.
- For membership revoke/suspend, derive the distinct set of tuples from every active policy row being disabled, then increment each distinct tuple exactly once.
- Do not increment unrelated tuples.
- Append an audit record containing the affected tuple set or a canonical digest plus count of that set.
- If the transaction fails, neither policy rows, membership state, epochs, nor audit event may partially commit.

**Required test matrix:** multiple projects, multiple actions, exact and wildcard resources, duplicate rows within a tuple, inactive rows, already-revoked membership, and forced transaction rollback. Assert exact epoch deltas and exact affected-set digest.

### 17.7 Decision D6 — Execution Permit and start-reservation binding

An Execution Permit is not a general bearer capability. It is a one-time authorization for one immutable start reservation and one expected Ledger lease transition.

The signed permit must bind at least:

- contract version, issuer, audience, key ID, permit ID, and unique JTI;
- tenant, project, admission ID, task ID, and task digest;
- expected Task version and expected Task state;
- immutable `startReservationId`;
- exact executor identity;
- lease identifier and expected lease generation/fencing value;
- exact operation/transition and bounded expiry.

The Ledger must atomically validate and consume the permit, verify the expected Task version/state, bind the executor and lease reservation, increment or confirm the lease generation, and persist the resulting transition. A competing executor, stale Task version, changed state, different reservation ID, or second permit JTI must fail without partial state.

The Authority must persist the immutable reservation before issuing/retrying the permit. An uncertain RPC outcome is recovered by querying/replaying the same `startReservationId`; the system must not create a second reservation to recover an acknowledgement.

### 17.8 Decision D7 — Scheduler principal and allowed schedules

The platform scheduled handler proves invocation origin; it does not confer tenant project permission.

Before any Cron Trigger is configured, define a versioned allowlist mapping:

`cron_identifier -> task_class -> tenant_service_principal -> allowed_action/resource_scope`

Each entry must include the target environment and a versioned configuration identifier. The scheduled handler must compare the exact platform-provided cron value against this allowlist and use the configured service principal; it must not accept a principal, cron identifier, tenant, or action override from an HTTP caller.

A valid scheduled event with an unknown cron, unprovisioned service principal, disabled task class, or unauthorized target project must create no Admission, Outbox, Task, or lease record.

**Owner decision remains required:** supply the exact cron identifiers, task classes, tenant-scoped principal IDs, and target policy actions. The empty live schedule inventory means none of these values may be inferred from the current deployment.

### 17.9 Decision D8 — Signing-key custody, rotation, and recovery

Cloudflare Workers Secrets documentation describes encrypted secret bindings available to Worker code. That protects secret values at rest in the platform, but a secret binding is not by itself a per-tenant Hardware Security Module boundary: code running with the binding can access it. The Workers Web Crypto documentation lists Ed25519 support, but the exact standard algorithm/compatibility configuration and import/export behavior still require a runtime compatibility test.

**Do not claim HSM-grade or per-tenant isolation from a shared Worker secret binding. Do not persist plaintext private signing material in TenantDirectory SQL.**

Candidate custody models:

| Model | Security boundary | Trade-off | Review state |
|---|---|---|---|
| Dedicated external KMS/HSM signer | Private signing key remains outside Worker and DO storage. | Stronger separation; introduces a network dependency, cost, and availability/failure semantics. | Preferred where the required assurance and service availability are supportable. |
| Dedicated signing Worker with narrowly scoped secret access | Private key is accessible to the signer Worker code only; other Workers call a constrained signing API. | Reduced exposure compared with a shared application binding, but still depends on signer Worker isolation and its secret scope. | Viable fallback after separate Worker, authentication, rate, and audit design. |
| Shared application Worker secret binding | Secret is encrypted at rest by Cloudflare but available to code with that binding. | Simplest operationally; broadest code-compromise blast radius; not per-tenant key isolation. | Not recommended for a high-assurance per-tenant isolation claim. |

For any selected model, specify generation, provisioning, access policy, key ID format, rotation overlap, old-key verification policy, emergency revocation, backup/restore, loss-of-key behavior, and audit trail. A key rotation must not strand pending Outbox records or silently invalidate receipts already admitted; verification and new-signing permissions must be separate.

Before implementation, test the exact Ed25519 Web Crypto algorithm, compatibility date/flags, key generation/import, signature verification after object restart, and rotation with pending Admissions and permits. Unknown or revoked key IDs fail closed.

**Owner decision remains required:** select a supported custody model and accept its blast radius and operational dependency. No key or secret is to be created or changed as part of this design review.

### 17.10 Consolidated implementation gates

The design remains **DESIGN HOLD** until all of the following evidence exists:

| Gate | Required artifact/evidence | Failure classification |
|---|---|---|
| G-01 Revocation semantics | Owner-approved reservation/effect guarantee wording and race tests. | BLOCKED |
| G-02 Alarm/Outbox | Deterministic commit, rollback, restart, and failure-injection integration tests, or an independently tested registry reconciler. | UNKNOWN until run |
| G-03 Ledger identity | Cross-environment namespace/data inventory, canonical object mapping, and migration rehearsal. | BLOCKED |
| G-04 Receipt-only Task creation | API contract, schema constraints, legacy bypass-negative tests, and transaction tests. | BLOCKED |
| G-05 Policy epoch completeness | Revocation bulk-update tests proving exact affected tuple increments. | BLOCKED |
| G-06 Permit binding | Executor/task-version/reservation/lease-generation race and replay tests. | BLOCKED |
| G-07 Scheduler trust | Exact allowlist, service-principal mapping, real scheduled-handler test, and no HTTP minting path. | BLOCKED |
| G-08 Key custody | Owner-approved custody model plus restart, rotation, revocation, restore, and crypto runtime tests. | BLOCKED |
| G-09 Live staging parity | Staging-only binding/migration/cron inventory and a full end-to-end admission-to-lease test. | NOT STARTED |
| G-10 Security/CI signal | PR-diff scan and historical findings triage reported separately; no historical finding is silently waived. | OPEN |

An unexecuted test is `UNKNOWN`, not pass or fail. A design statement is not a runtime test. A source binding is not a deployed binding. A signed receipt is not current authorization. A committed reservation is not proof of an external side effect's timing.

### 17.11 Owner decision ledger

The following are recommendations for review, not decisions attributed to the owner:

| Decision | Engineering recommendation | Owner status |
|---|---|---|
| Revocation | Reservation-time semantics for v1; do not claim absolute post-revocation suppression of arbitrary remote effects. | OPEN |
| Outbox recovery | Prefer same-object alarm only after the deterministic transaction test; otherwise use a separately designed pre-provisioned registry reconciler. | OPEN |
| Ledger partition | One Ledger object per tenant for a new deployment, only after legacy inventory proves a safe cutover. | OPEN |
| Task creation | `projectAdmittedTask` is the only scheduled-task writer; legacy `createTask` has no Receipt-free write capability. | OPEN |
| Policy epoch | Increment every distinct affected tuple exactly once inside the same mutation transaction. | OPEN |
| Execution Permit | Bind executor, task version/state, immutable start reservation, permit JTI, and lease generation. | OPEN |
| Scheduler | Exact allowlist mapping from cron to task class and tenant service principal; no caller-provided provenance. | OPEN |
| Key custody | External signer where assurance/service constraints permit; otherwise isolated signer Worker, with shared binding explicitly treated as lower assurance. | OPEN |

No implementation, schema migration, Worker binding, Cron Trigger, secret, staging deployment, Production deployment, or merge is authorized by this addendum. The next engineering phase is implementation planning only after the owner decisions are accepted and the blocking evidence gates are closed.
