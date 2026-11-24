# Hybrid Admission Authorization — Hostile Design Review

- **Review status:** DESIGN HOLD — not implementation-ready
- **Review date:** 2026-11-24
- **Reviewed proposal:** PR #425, head `422ef1e4a40d8ef15eb3af47bf4e52ab61f2318f`
- **Reviewed baseline:** `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`
- **Review class:** Evidence-only adversarial architecture review
- **Production changes:** None
- **Application-code changes:** None

## 1. Executive Verdict

The hybrid architecture is directionally coherent: signed admission evidence, strict authorization freshness, and one per-tenant authority are the right three control families to combine. The proposal correctly rejects the fiction of a cross-Durable-Object ACID transaction and instead separates local transactions from idempotent cross-object delivery.

However, PR #425 is **not yet implementation-ready**. The hostile review found four blocking contract gaps and five high-risk specification gaps. These are not reasons to discard the architecture. They are reasons to prevent premature implementation or claims of strict atomic revocation.

The highest-risk issues are:

1. The proposed `START_AUTHORIZED` linearization point does not mean the Ledger has committed a lease or that an external effect has begun. A revocation committed afterward can precede actual execution.
2. The Outbox delivery guarantee still depends on unproven atomicity between SQL commit and Durable Object alarm scheduling, or an alternative durable discovery mechanism.
3. The production Ledger object identity/partition contract is not established in code or live Cloudflare state.
4. The new receipt-based admission path is not reconciled with the existing Ledger `createTask` contract, its worker-assertion consumption, and its global uniqueness constraints.

The design may proceed to an implementation plan only after these contract decisions are resolved and the listed falsification tests are defined. No source mutation is recommended by this review.

## 2. Evidence Scope and Freshness

### 2.1 GitHub source baseline

All source observations below were fetched from `main` at:

`919b19ca3d3887352cdef06b03c668ead04fbce7`

Relevant source blob identifiers:

| File | Blob SHA |
|---|---|
| `cloud-engineering-connector/identity/tenant-directory.js` | `47647f84afc03c554b808060b6adce200d31e13d` |
| `cloud-engineering-connector/identity/tenant-directory-adapter.js` | `a0efff296235b6b52ab6fcd568f1f0858744b84b` |
| `cloud-engineering-connector/identity/tenant-context.js` | `2282a056d1b0436ad8e573f7c8d7873d4fe5c34b` |
| `cloud-engineering-connector/orchestrator-ledger.js` | `ba32281b3698d40917505096d2a61501f8c0f9e4` |
| `cloud-engineering-connector/orchestrator-worker-identity.js` | `b2ef5f2f4063b63e82d10f6abe428a5b1dd1acdc` |
| `cloud-engineering-connector/worker.js` | `8911b4fc7df279ecbea7689506e0f814b2414dff` |
| `cloud-engineering-connector/index.js` | `1a8a3f50cc4bbd2d1522311f48d21a36bf5adc33` |
| `cloud-engineering-connector/wrangler.toml` | `6c81ef6761497f6e8889a1ed8aa715b70922a949` |
| `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-idempotency-scope.test.js` | `a481d3ff6009a1a5113289f35391990ab8ec96f7` |

### 2.2 PR state at review time

PRs #423, #424, and #425 were re-read:
- all were Open, Draft, and Unmerged;
- PR #425 remained based on `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`;
- the `main` branch still resolved to `919b19ca3d3887352cdef06b03c668ead04fbce7`.

### 2.3 Live Cloudflare read-only inventory

The Cloudflare connector was used for GET-only inventory and Worker settings inspection. No secret values were read or emitted.

Observed:
- Cron schedules for `chat-gpt111`, `chat-gpt111-staging`, and `master-brain-cloud-agent` were all empty.
- The account's Durable Object namespace inventory contained exactly three namespaces:
  - `master-brain-cloud-agent_AgentBudget` — class `AgentBudget`;
  - `master-brain-cloud-agent_AgentSession` — class `AgentSession`;
  - `chat-gpt111-staging_WriteControl` — class `WriteControl`.
- No live Durable Object namespace for `OrchestratorLedger` or `TenantDirectory` was present in that inventory.
- Production `chat-gpt111` script settings exposed secret-text and rate-limit bindings, but no Durable Object namespace binding.
- Staging `chat-gpt111-staging` exposed `WriteControl` as its only Durable Object namespace binding; it did not expose TenantDirectory or OrchestratorLedger bindings.

This is a **source-versus-live deployment delta**, not proof of a failed deployment. The current source declares the classes and Wrangler bindings; the live account inventory shows that this proposed architecture is not currently deployed there.

### 2.4 Platform references consulted

- Durable Object SQLite transaction API: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Durable Object rules and coordination: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Scheduled handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cron Trigger configuration: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Durable Object automatic retries: https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/

## 3. Blocking Findings

### HADR-B01 — Start authorization is not the same event as actual execution start

**Severity:** BLOCKER for any claim of immediate/strict revocation at actual task start.

**Evidence:**
- PR #425 defines the Authority's commit of `START_AUTHORIZED` and the one-time Execution Permit as the linearization point.
- The Ledger lease is committed afterward in a different Durable Object.
- The proposal explicitly says a revocation after `START_AUTHORIZED` does not retroactively erase that ordering.
- The external side-effect section acknowledges that arbitrary providers such as GitHub cannot participate in the same storage transaction.

**Counterexample:**
1. Authority commits `START_AUTHORIZED`.
2. The Ledger RPC is delayed or unavailable.
3. Membership is revoked and the revocation transaction commits.
4. The old permit is later reconciled and consumed by the Ledger.
5. A worker receives a lease and attempts work after the revocation commit.

Under the current design this work is ordered as authorized before revocation, even though the actual Ledger lease and execution can occur later.

**Required contract decision:**
- **Model A — Decision-time revocation:** The authorization decision is irrevocable after the Authority commits `START_AUTHORIZED`; later revocation prevents only future start reservations. This is a precise linearizable decision contract, but not a guarantee that no new execution or external effect occurs after revocation.
- **Model B — Effect-boundary revocation:** A revocation must prevent all not-yet-committed work effects, including work holding a prior lease or permit. This requires a fencing/authorization check at each effect boundary and cannot be guaranteed for an external provider that does not enforce the fencing token atomically.

Do not label Model A as instantaneous task-start revocation. The product must explicitly choose the guarantee it actually needs.

**Falsification tests:**
- Pause after Authority `START_AUTHORIZED` commit and before Ledger lease commit; revoke membership; then resume. Assert the chosen model's exact expected outcome.
- Pause after Ledger lease commit but before the first effectful adapter call; revoke; then resume. Assert the adapter rejects or the documented decision-time model allows it.
- Repeat with an external API adapter and explicitly record whether the external provider can enforce the fencing token.

### HADR-B02 — Outbox wake-up atomicity remains unproven

**Severity:** BLOCKER for a no-lost-Outbox guarantee.

**Evidence:**
- PR #425 records the Admission and Outbox row in a TenantDirectory SQL transaction.
- The proposal requires the alarm to be durably scheduled with the Outbox commit if platform testing proves this.
- The fallback requires an independent durable work-discovery mechanism.
- Cloudflare documents one alarm slot per Durable Object and alarm delivery/retry behavior. The documentation reviewed does not establish that `setAlarm()` participates in the same `transactionSync()` rollback boundary as the SQL writes.

**Counterexample:**
1. Admission and Outbox row commit.
2. The isolate terminates before alarm scheduling is durably recorded.
3. No alarm wakes the tenant object.
4. No independent registry/scanner discovers the pending Outbox row.
5. The Ledger projection remains pending indefinitely.

**Required contract:**
- Prove alarm scheduling is part of the same local transaction by a deterministic integration test that checks both commit and rollback; or
- specify a separate durable discovery/activation mechanism with a defined tenant registry, due-work index, recovery cursor, and bounded scan semantics.

An after-commit call to `setAlarm()` without proof is not an atomic wake-up guarantee.

**Falsification tests:**
- Force an exception after Outbox insert but before alarm operation; verify both records roll back.
- Commit the transaction; evict/restart the object; verify alarm and Outbox are both discoverable.
- Exhaust the alarm retry budget while Ledger is unavailable; verify persisted work is scheduled again without another external request.
- Run two concurrent alarm owners and prove no consumer can overwrite another due-work schedule.

### HADR-B03 — Ledger object identity and partition contract are undefined

**Severity:** BLOCKER for data correctness, tenant isolation, and migration safety.

**Evidence:**
- No production call site to `env.ORCHESTRATOR_LEDGER` was found in the reviewed Worker source.
- The Worker module exposes a `fetch` handler; the module entrypoint re-exports the Durable Object classes but does not define a production Scheduler-to-Ledger routing path.
- Existing tests create Ledger stubs using caller-chosen names, for example:
  `env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name))`.
- The idempotency test uses one test Ledger instance and writes records for multiple tenants inside it.
- The source schema uses `task_id TEXT PRIMARY KEY` and `idempotency_key TEXT NOT NULL UNIQUE` within each Ledger object.
- The live Cloudflare account had no OrchestratorLedger namespace at review time.

**Counterexample:**
If production later uses one Ledger object per tenant while tests and migrations assume a shared Ledger object, a legacy global task ID or idempotency identity may be routed to a different storage partition. The reverse mismatch can mix tenant rows inside a shared object and create an unanticipated global bottleneck.

**Required contract:**
Choose and document exactly one Ledger routing model before schema work:
- one Ledger object per tenant;
- a deterministic shard model with stable tenant-to-shard mapping; or
- a shared Ledger object with explicit tenant partitioning and accepted throughput/isolation consequences.

For the chosen model, define:
- canonical object name/ID derivation;
- compatibility with already persisted IDs and rows;
- handling of task ID collisions;
- migration/backfill and rollback behavior;
- test fixture construction using the same canonical mapping.

Do not claim that the current object identity is preserved when no production caller establishes it.

**Falsification tests:**
- Derive the same tenant's Ledger object ID from every production entrypoint and assert identity equality.
- Derive different tenants' IDs and assert the chosen isolation/partition policy.
- Replay legacy tasks and idempotency keys through the selected mapping; assert no record becomes unreachable or silently duplicated.

### HADR-B04 — The receipt-based path is not reconciled with the existing Ledger admission API

**Severity:** BLOCKER for safe implementation.

**Evidence:**
- Current `OrchestratorLedger.createTask()` requires `workerId` and `workerAssertion`.
- It verifies an HMAC worker assertion against `LEDGER_WORKER_ASSERTION_KEYS`.
- It consumes the worker assertion JTI in the Ledger transaction.
- It then writes `orchestrator_tasks` and claim-candidate state.
- The current schema has a task primary key and unique idempotency key, but no declared admission receipt ID or admission-consumption table in the reviewed schema.
- PR #425 proposes signed Admission Receipts and a new admission identity, but does not define whether `createTask()` is replaced, wrapped, versioned, or retained for legacy callers.

**Counterexample:**
A future caller invokes the legacy `createTask()` path with a valid HMAC Scheduler assertion but no Admission Receipt. If that path still writes a task, the stated invariant “no new scheduled Task without verified Admission evidence” is false. Conversely, if the legacy method is simply disabled, existing legitimate callers/tests may break without a migration strategy.

**Required contract:**
- Define the exact public Ledger RPC method for receipt projection.
- Define the disposition of legacy `createTask()`: reject new scheduled admission, delegate only through verified Receipt, or maintain a separately scoped legacy path that cannot create new scheduled Tasks.
- Define the uniqueness constraints for `admissionId`, `jti`, `taskId`, and idempotency identity.
- Define whether the original HMAC assertion is removed, retained as a second independent factor, or used only for a distinct operation.
- Preserve `assertNoSecretFields` and the existing canonical serialization/32 KiB record limit.

**Falsification tests:**
- Call every task-creation RPC without a Receipt; assert no Task row or claim-candidate row is written.
- Submit a valid Receipt and replay it twice; assert one Task and one admission-consumption row.
- Reuse the same admission ID with a different digest or Task ID; assert conflict and no second write.
- Submit the existing HMAC Scheduler assertion without a Receipt; assert rejection.

## 4. High-Risk Specification Findings

### HADR-H01 — Membership revocation must advance every affected policy scope epoch

**Severity:** HIGH.

Current `TenantDirectory.revokeMembership()` changes membership status/version and bulk-disables all active project policy rows for the principal in the same SQL transaction. The current operation does not yet maintain the proposed policy-scope epoch, because that epoch does not exist.

The new policy-scope epoch is keyed by tenant/project/principal/action. A membership revocation that disables multiple rule rows therefore must increment every distinct affected scope epoch in the same transaction as:
- membership revocation;
- policy rule disable/version updates;
- audit event append.

Otherwise the policy-scope epoch is not a complete version of the effective authorization state.

**Required test:** seed multiple projects, actions, exact-resource rules, and wildcard rules; revoke the membership; assert every affected scope epoch changes exactly once, no unaffected scope changes, and the audit evidence identifies the full affected scope set or an immutable digest of it.

### HADR-H02 — Execution Permit scope does not yet bind the executor and lease transition

**Severity:** HIGH.

The Receipt binds the Task, but the design does not fully define the Execution Permit binding to:
- intended executor identity;
- expected Task state and version;
- lease generation/fencing value;
- unique lease reservation;
- exact transition/action.

Without these claims, an otherwise valid one-time permit may be consumed by a different eligible executor or against a changed Task version unless the Ledger independently enforces all of those facts.

**Required contract:** sign the exact Task version/state and executor/lease reservation. Consume the permit, admission ID, expected Task version, and lease generation in one Ledger transaction. A conflicting executor or state must reject.

**Falsification test:** race two workers against one permit and one Task; exactly one expected executor/lease reservation may commit.

### HADR-H03 — Scheduler principal and allowed schedule scope are still unspecified

**Severity:** HIGH.

The live account currently has no Cron schedules for the three inspected Workers, and `wrangler.toml` contains no `[triggers].crons` declaration. The source Worker exposes only `fetch` in its default export. The design correctly proposes a scheduled handler but does not establish the tenant-scoped service principal that each schedule is authorized to act as.

A runtime scheduled event proves invocation origin; it does not grant project permission.

**Required contract:** specify the exact allowlisted cron identifiers, the task class each may create, the tenant-scoped service principal for each class, and the policy action evaluated for the target Project.

**Falsification test:** invoke a valid schedule with an unprovisioned service principal or unauthorized project; assert no Admission or Outbox row is created.

### HADR-H04 — Key custody and rotation policy is an implementation blocker, not an operational detail

**Severity:** HIGH.

PR #425 correctly prohibits the Ledger from receiving private signing material and requires a trusted key lookup by tenant/key identifier. However, private-key persistence, access control, restore, backup, rotation overlap, emergency replacement, and compromised-key revocation remain open.

**Required contract:** define the private-key custody boundary and the verification-key trust path. A public key supplied by the receipt sender must never be trusted. Rotation must define the overlap window and behavior for pending Outbox records, existing Admissions, and previously issued Execution Permits.

**Falsification test:** rotate keys while Outbox records and permits are pending; verify old receipts remain verifiable only for the approved purpose/window and that a revoked key cannot authorize new Admission or Execution Permit issuance.

### HADR-H05 — One-time permit recovery must remain bound to an immutable start reservation

**Severity:** HIGH.

The design states that an uncertain Authority-to-Ledger acknowledgement reuses the same permit ID and start reservation. The exact persistent reservation schema and uniqueness constraint are not specified.

**Required contract:** define an immutable `startReservationId` unique per Admission, and map it to one executor, one task version, one permit JTI, and one lease generation. A retry must retrieve the same outcome. It must not mint a second start reservation.

**Falsification test:** commit the Authority reservation, drop the RPC response, restart both objects, and retry. Assert the same reservation and lease result are returned and no second permit or lease is created.

## 5. Confirmed Design Strengths

These parts of PR #425 are consistent with the inspected source and Cloudflare platform model:

1. The existing TenantDirectory is already selected by tenant identity through `namespace.idFromName(tenantId)`, making a per-tenant coordination authority a natural extension.
2. Membership rows already have a monotonically increasing numeric version; policy rows already have a numeric version and decision ID. The proposal correctly distinguishes these values from the caller-supplied `policyVersion` label.
3. The current Ledger serializer `serializeBounded()` uses the repository's `canonicalJson()` helper and enforces a 32 KiB record limit. This is a sound reuse point, provided receipt hashing uses the exact same immutable serialized bytes and the existing secret-field rejection remains in force.
4. The proposal correctly keeps Web Crypto signing outside synchronous SQLite transaction callbacks and then rechecks versions inside the transaction.
5. The proposal correctly states that TenantDirectory and OrchestratorLedger cannot share one cross-object ACID transaction. Local atomic writes plus idempotent delivery are the correct abstraction.
6. The proposal correctly rejects treating `policyVersion` as a monotonic version and identifies the need to bind numeric policy freshness.
7. The proposal correctly protects `main`, Production, secret values, and automatic deployment from this design review.

## 6. Consolidated Hostile Test Matrix

The following tests are additional to PR #425's HA-01 through HA-22 list.

| ID | Counterexample / mutation | Required invariant |
|---|---|---|
| HAT-23 | Revocation commits after START_AUTHORIZED but before Ledger lease | Observed outcome must match the explicitly selected revocation model. |
| HAT-24 | Revocation commits after Ledger lease but before first effect | Effect boundary rejects under effect-boundary revocation, or is explicitly outside the guarantee. |
| HAT-25 | One membership revocation disables multiple exact and wildcard policy rules | Every affected policy-scope epoch advances in the same Authority transaction. |
| HAT-26 | Ledger projection called through legacy createTask with only HMAC assertion | No new scheduled Task is created without a verified Admission Receipt. |
| HAT-27 | Two executors race to consume one Execution Permit | Only the executor bound into the permit can commit the lease. |
| HAT-28 | Execution Permit replayed with a different Task version or lease generation | Reject; no lease mutation. |
| HAT-29 | Same tenant routed through two different Ledger naming helpers | Both helpers must resolve to the one canonical partition, or one must be rejected. |
| HAT-30 | Legacy Task ID collides after partitioning change | No overwrite, orphaning, or cross-tenant read exposure. |
| HAT-31 | Receipt digest computed before secret-field rejection or from mutable object state | Reject or prove digest and persisted Task bytes are identical. |
| HAT-32 | Cloudflare alarm retry budget is exhausted during a downstream outage | Pending work remains discoverable and a durable future wake-up is scheduled. |
| HAT-33 | Policy wildcard changes while an exact-resource receipt is being signed | Final version recheck rejects the stale snapshot. |
| HAT-34 | Key rotation occurs after Authority commit but before Ledger projection | Ledger validates only against the configured trusted key-retention policy. |

Every race test must use deterministic barriers and assert both legal commit orders. Sleeps and timing-only tests are insufficient. Unexecuted tests remain UNKNOWN, not PASS or FAIL.

## 7. Implementation-Readiness Gates

PR #425 should not be treated as implementation-ready until the following are closed:

- [ ] Choose and document decision-time versus effect-boundary revocation.
- [ ] Prove alarm/Outbox atomicity or approve and test an independent durable scanner/queue.
- [ ] Establish the canonical Ledger object-ID mapping and compatibility/migration behavior.
- [ ] Specify the new Ledger receipt-projection API and the disposition of legacy `createTask()`.
- [ ] Define receipt/JTI/admission uniqueness constraints and task ID partition scope.
- [ ] Advance every affected policy-scope epoch during membership revocation.
- [ ] Bind Execution Permits to executor, Task version/state, start reservation, and lease generation.
- [ ] Define Scheduler service principal mapping and cron allowlist.
- [ ] Approve key custody, rotation, recovery, and compromise response.
- [ ] Verify staging namespace bindings and scheduled-handler reachability without changing Production.
- [ ] Execute HA-01 through HA-22 and HAT-23 through HAT-34 in the real Workers test harness.
- [ ] Keep Production unmodified until a separate explicit deployment approval.

## 8. CI and Security-Signal Status

The latest observed PR #425 Full History Secret Scan failed:
- the PR diff-range scan reported no leaks;
- the full-history scan reported 12 historical `generic-api-key` findings in pre-existing repository files/commits.

These findings are not adjudicated as false positives by this review. The failure is a repository-history/security-triage issue, not evidence that the new design document introduced a secret. No test suite for application code was run because this review made no application-code changes.

## 9. Recommended Next Atomic Step

Do not start implementation yet.

The next atomic engineering step is a **contract-closure revision** of PR #425 that:
1. records the chosen revocation linearization guarantee;
2. specifies canonical Ledger routing and receipt-projection compatibility;
3. defines start reservation and Execution Permit scope;
4. specifies policy-scope epoch updates for membership-driven bulk policy disable;
5. closes the Outbox wake-up proof gate.

After those are resolved, create a repository-aligned implementation plan with independently testable migrations, Authority operations, Ledger projection, Scheduler entrypoint, and recovery tests. Implementation and staging deployment remain separate approval gates.

## 10. Scope and Safety Statement

This review is evidence-only:
- no application source changed;
- no schema or migration changed;
- no branch protection, Worker binding, Cron schedule, Durable Object namespace, or secret changed;
- no local machine or user environment was modified;
- no PR was merged;
- no Production deployment was performed.

Unknown or untested behavior is explicitly left UNKNOWN.
