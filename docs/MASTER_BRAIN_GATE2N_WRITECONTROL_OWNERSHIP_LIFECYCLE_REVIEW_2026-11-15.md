# Master Brain — Gate 2N: WriteControl Ownership and Lifecycle Architecture Review
**Date:** 2026-11-15  
**Mission:** MB-G2N-WRITECONTROL-OWNERSHIP-2026-11-15-001  
**Branch:** integration/master-brain-unification-2026-11-15  
**Reviewed head:** 0e0a98e97318a980cb681a5413f0dee6968be6f3  
**Main / merge-base:** 919b19ca3d3887352cdef06b03c668ead04fbce7  
**Status:** DESIGN REVIEW COMPLETE — PROPOSED ARCHITECTURE — OWNER APPROVAL AND INDEPENDENT REVIEW PENDING  
**Implementation authorization:** NONE  
**Test execution:** NOT_RUN  
**Deployment authorization:** NONE

## 1. Executive result

Gate 2N examined whether the existing `OrchestratorLedger` should own the protected external GitHub write-operation lifecycle or whether a dedicated `WriteControl` bounded context is required.

**Recommendation:** create a dedicated `WriteControl` Durable Object bounded context for external write operations. Do not extend `OrchestratorLedger` with the GitHub write-operation aggregate.

For the first controlled service-only v1, use one logically global WriteControl coordinator instance only if measured write volume and latency demonstrate that its serialization/availability characteristics are acceptable. This is a bounded initial deployment choice, not a claim of unlimited scale. Keep tenant, service-principal, project, repository, and global emergency quotas as separate dimensions. Do not shard until load, contention, recovery, and migration evidence justify it.

This recommendation is not yet owner-approved. Gate 2M accepted the service-only identity direction only; it did not approve this storage architecture, code changes, or a release.

## 2. Scope and evidence

The review was documentation/source inspection only. No tests, live endpoint probes, deployment inspection, or runtime mutations were performed.

Reviewed source at the stated branch:
- `cloud-engineering-connector/worker.js`, blob `8911b4fc7df279ecbea7689506e0f814b2414dff`
- `cloud-engineering-connector/orchestrator-ledger.js`, blob `ba32281b3698d40917505096d2a61501f8c0f9e4`
- `cloud-engineering-connector/identity/tenant-directory.js`, blob `47647f84afc03c554b808060b6adce200d31e13d`
- `cloud-engineering-connector/identity/tenant-context.js`, blob `2282a056d1b0436ad8e573f7c8d7873d4fe5c34b`
- `cloud-engineering-connector/wrangler.toml`, blob `6c81ef6761497f6e8889a1ed8aa715b70922a949`
- Gate 2K contract, blob `060daa5788388cb7a8602dec605ebd886a3018bd`
- Gate 2L review, blob `38c6fafcd6fd436be21d589f0877ba286513fc2c`
- Gate 2M service-only decision, blob `2b5e0297f4f1d2dfa425d52a5faa40c936e82fe0`

Branch integrity check:
- Current branch head: `0e0a98e97318a980cb681a5413f0dee6968be6f3`
- `main`: `919b19ca3d3887352cdef06b03c668ead04fbce7`
- Branch is 16 commits ahead, 0 behind; merge-base equals main.
- At review start, all 15 changed files were documentation additions; no source changes were present in the branch delta.

## 3. Verified implementation facts

### 3.1 OrchestratorLedger has a different aggregate owner

The existing Durable Object contains task-oriented tables and APIs, including:
- `orchestrator_tasks`;
- processed task messages;
- task execution leases and claim candidates;
- task outbox events, receipts, and dead letters;
- worker/reconciliation assertion-consumption records;
- GitHub webhook delivery records;
- owner-command receipts;
- `orchestrator_audit_events`.

Its public operations include `createTask`, `getTask`, `transitionTask`, `claimTask`, `renewLease`, `releaseLease`, `enqueueOutbox`, `claimOutbox`, `failOutbox`, `completeOutbox`, `executeOwnerCommand`, and `appendAuditEvent`.

The task and outbox model is not a generic external-write ledger:
- `createTask` validates a task projection and tenant/project scope, and its idempotency is tied to task identity and input hash.
- `enqueueOutbox` requires an existing task in the same tenant/project and stores a task-linked event.
- Outbox workers authenticate through worker assertions and use task-oriented publisher/consumer roles.
- `appendAuditEvent` requires a `taskId`, tenant/project scope, actor, worker identity/assertion, and event type.
- The audit stream is therefore task-associated, not a native `WriteOperation` aggregate.

These are useful, mature primitives for the Orchestrator domain. Their existence does not establish that the domain owns arbitrary GitHub write operations.

### 3.2 Current create_change_pr does not use OrchestratorLedger

In `worker.js`, `createChangePr`:
1. requires `service:shared-mcp-bearer`;
2. validates request fields and file paths;
3. resolves tenant membership;
4. authorizes `project.create_pr`;
5. reads the repository/base commit;
6. directly POSTs a Git tree;
7. directly POSTs a Git commit;
8. creates a random branch;
9. directly POSTs a pull request.

No call to `env.ORCHESTRATOR_LEDGER` or an operation ledger appears in this write path. The Worker path does not reserve a durable operation, persist a request fingerprint, acquire a write-operation lease, or record each external phase before dispatch.

The `index.js` export and `wrangler.toml` binding make the OrchestratorLedger class available to the Worker runtime, but availability is not a call-path integration. The reviewed Worker does not use that binding for `create_change_pr`.

### 3.3 TenantDirectory owns authorization state

TenantDirectory stores membership records, project-policy rules, versions, and its own audit events. It exposes membership and project authorization operations. It is the authoritative source for the current membership/policy decision in the reviewed connector design.

The current authorization lookup accepts either the exact resource digest or the wildcard `*`. Gate 2M explicitly records that wildcard authorization for `project.create_pr` must remain DENY until separately approved; the reviewed implementation has not yet enforced that decision.

Gate 2L also found that membership version is present in TenantDirectory records but omitted from the trusted context returned to the Worker. These findings remain open and must not be treated as closed by this architecture document.

### 3.4 Credential identity is not yet versioned in the write path

The reviewed Worker validates the shared bearer against the configured `MCP_AUTH_TOKEN` and derives the fixed service principal `service:shared-mcp-bearer`. The current authenticator does not return a non-secret credential identifier or credential version into the operation context.

Gate 2M requires credential issuance, custody, rotation, revocation, expiry/overlap, emergency disable, and audit to be defined. It also prohibits direct end-user distribution of the shared bearer. No secret value was read, copied, or modified in this review.

## 4. Bounded-context ownership decision

The following ownership boundaries are recommended:

| Bounded context | Authoritative owner | Owns | Must not absorb |
|---|---|---|---|
| Identity / credential authentication | Trusted Worker authenticator and credential authority | Service credential validation, principal derivation, credential version/status | Tenant membership, GitHub operation state |
| Tenant Directory | TenantDirectory DO | Membership, project policy, policy/membership versions, authorization decisions | GitHub write phases or task lifecycle |
| Orchestration | OrchestratorLedger DO | Mission/task projections, task transitions, execution leases, task outbox and task-linked audit | Generic external write-operation aggregate |
| External Write Control | New WriteControl DO | Write admission, idempotency, request fingerprint, operation lease/fencing, phases, UNKNOWN, reconciliation receipts, operation audit/outbox, write quotas | Mission/task aggregate, tenant membership source of truth, repository content |
| External repository | GitHub | Actual refs, trees, commits, pull requests and their observable state | Master Brain authorization or internal operation ledger |

A `WriteControl` operation may carry references to a task/mission for correlation, but those references do not transfer ownership of the task or mission aggregate to WriteControl.

## 5. OrchestratorLedger extension versus dedicated WriteControl

### Option A — Extend OrchestratorLedger

**Advantages**
- Existing Durable Object SQL storage and transactional patterns.
- Existing tenant/project scoping utilities and worker assertion machinery.
- Existing audit and outbox mechanisms.
- Fewer Durable Object classes and bindings.

**Disqualifying design pressure**
- Existing outbox events require a valid task association.
- Existing audit append requires a task ID and task-oriented actor/worker semantics.
- Existing leases and state transitions govern task execution, not external GitHub write phases.
- Adding `WriteOperation` tables and APIs would mix task lifecycle with an independent external side-effect lifecycle.
- A write operation can exist without an OrchestrationTask; requiring a synthetic task would create false domain coupling.
- Reusing task idempotency would conflate task identity with external request identity and its full principal/tenant/project/action/resource scope.
- The current Worker does not call the existing ledger, so extension alone would not close the missing integration path.

**Disposition:** REJECT as the aggregate owner. Reconsider only if a later formal domain review proves the two lifecycles are one aggregate, which current evidence does not support.

### Option B — Dedicated WriteControl Durable Object

**Advantages**
- Clear ownership of external write admission and recovery.
- Native operation identity independent of task/mission IDs.
- Can persist every GitHub dispatch phase and its outcome.
- Can preserve UNKNOWN without conflating it with task status.
- Can enforce full-scope idempotency and tenant/service/project quotas transactionally.
- Can atomically reserve the operation and append its initial audit/outbox event inside its own storage transaction.
- Allows the OrchestratorLedger to remain the task authority.

**Costs and risks**
- New DO class, binding, migration, schema, tests, and operational monitoring.
- A single global instance may become a throughput/availability bottleneck.
- Cross-DO authorization and audit cannot be made one atomic transaction with TenantDirectory.
- New code must avoid duplicating identity or authorization policy.

**Disposition:** RECOMMENDED, subject to owner approval, capacity measurements, threat review, and independent adversarial review.

## 6. Initial partitioning recommendation

### 6.1 v1: one bounded global coordinator instance

For the first controlled service-only release, the recommended initial topology is one logical WriteControl coordinator instance (for example, a stable named Durable Object ID) for all protected GitHub write operations.

Reasons:
- The initial release is deliberately narrow and service-only.
- It allows global emergency ceiling, per-tenant quotas, unresolved-operation counts, and operation admission to be updated in one transaction.
- It avoids premature sharding and cross-shard idempotency/recovery complexity.
- It gives the project one inspectable operation ledger while actual write volume and contention are measured.

This is not a global single-writer mandate for Master Brain. It is a temporary bounded-context choice for one low-volume protected-write capability.

### 6.2 Mandatory limits

Before any implementation approval, capacity analysis must establish:
- expected and peak write admission rate;
- acceptable admission latency;
- maximum operation record size;
- maximum active and UNKNOWN operations;
- Durable Object storage and transaction cost;
- worst-case GitHub API call duration and retry/reconciliation load;
- blast radius if the coordinator becomes unavailable.

No numeric quotas are invented in this review.

### 6.3 Future sharding

Do not shard in v1. A future sharding proposal must include:
- deterministic versioned partition key;
- stable operation ID independent of physical shard;
- migration of active, terminal, and UNKNOWN operations;
- duplicate prevention during cutover;
- tenant fairness preservation;
- a separately specified global emergency ceiling across shards;
- rollback and reconciliation plan;
- load-test evidence demonstrating the need.

A global ceiling cannot be claimed to be transactionally strict across multiple DOs unless the design supplies an explicit coordination mechanism. Independent per-shard counters are not a strict global ceiling.

## 7. Operation identity and request fingerprint

### 7.1 Stable operation identity

Use a versioned, domain-separated, length-prefixed canonical tuple containing:
- schema/domain separator and version;
- action;
- principal type and stable principal ID;
- tenant ID;
- project ID;
- resource type;
- canonical repository owner/name;
- client idempotency key.

The resulting operation ID is a cryptographic digest of those canonical bytes.

Credential ID/version belongs in the immutable authorization/audit context, not in the stable principal identity. Rotating a credential for the same service principal must not accidentally create a new security principal or bypass idempotency.

### 7.2 Request fingerprint

A separate digest binds every operation-affecting input:
- operation schema/version and action;
- full principal/tenant/project scope;
- repository and base branch;
- normalized, sorted file paths;
- each file content SHA-256 and byte length;
- exact normalized title;
- exact normalized summary;
- any expected blob SHA or conditional-write precondition;
- policy-relevant options.

The normalized summary is mandatory in the fingerprint because it becomes part of the GitHub pull-request body. The current Worker authorization resource omits it; that Gate 2L finding remains open.

### 7.3 Replay rules

- Same full scope + same key + same request digest: return or continue the same operation only after current authorization is re-evaluated.
- Same full scope + same key + different request digest: reject with `IDEMPOTENCY_CONFLICT`.
- Different principal, tenant, project, action, or resource scope: independent key space; no operation existence or metadata disclosure.
- UNKNOWN: remain quarantined until a separately authorized reconciliation records exact evidence.
- Terminal-record expiry and key reuse must follow an explicit, versioned retention policy.

## 8. WriteControl state machine and lease fencing

### 8.1 Candidate phases

1. `RESERVED`
2. `TREE_DISPATCHED`
3. `TREE_WRITTEN`
4. `COMMIT_DISPATCHED`
5. `COMMIT_WRITTEN`
6. `BRANCH_DISPATCHED`
7. `BRANCH_WRITTEN`
8. `PR_DISPATCHED`
9. `PR_CREATED`

Terminal statuses: `SUCCEEDED`, `FAILED`.  
Non-terminal statuses: `IN_PROGRESS`, `UNKNOWN`.

The added `BRANCH_DISPATCHED` phase is required to record intent before branch creation, rather than recording only after the external side effect.

### 8.2 Required transition envelope

Every state transition must bind:
- operation ID and full security scope;
- current phase and expected next phase;
- status;
- lease generation and lease holder;
- request fingerprint;
- dispatch attempt ID;
- timestamp from the trusted runtime;
- evidence reference/digest;
- external GitHub object identity when known.

Transitions are monotonic and compare-and-swap protected. A stale lease generation must be rejected as a hard fence failure.

### 8.3 External side-effect rule

The operation ledger transaction must commit the `*_DISPATCHED` phase before the external GitHub request begins. The network call occurs outside the DO transaction. A confirmed response is then recorded in a separate transaction.

If the Worker crashes, times out, or loses the response after dispatch, the operation becomes or remains `UNKNOWN`. Do not infer success or failure from a timeout. Do not automatically resend an ambiguous non-idempotent GitHub POST.

## 9. UNKNOWN and reconciliation authority

Reconciliation is a distinct privileged capability, not an ordinary retry and not an extension of `project.create_pr`.

Required behavior:
1. Re-authenticate the service principal and verify credential is currently active.
2. Re-check current tenant membership and exact project/action/resource policy.
3. Verify the caller has the separate reconciliation capability.
4. Read GitHub state without mutating it.
5. Match exact repository, base branch, generated branch, commit/tree identity, PR metadata, operation marker, and request fingerprint where available.
6. Record evidence source, observation time, exact remote identifiers, evidence digest, reconciler identity, and decision.
7. Resolve only when evidence uniquely supports a state transition.
8. If evidence is incomplete, contradictory, stale, or non-unique, remain UNKNOWN.

No automatic cleanup of uncertain branches, commits, or pull requests is allowed until a separate cleanup policy is reviewed. A reconciler must not be able to turn ambiguous evidence into a success assertion.

## 10. Transaction and audit/outbox boundary

### 10.1 Atomic local admission

Within one WriteControl Durable Object `transactionSync` transaction, atomically:
- validate the complete operation scope and idempotency uniqueness;
- enforce relevant tenant/service/project/global admission counters;
- reserve the operation and initial lease;
- persist immutable request fingerprint and authorization snapshot references;
- append the initial operation audit event;
- append a transactional outbox event if a separate audit sink is required.

If any of these writes fail, the transaction must roll back and no GitHub side effect may be dispatched.

### 10.2 Cross-DO boundary

TenantDirectory and WriteControl are separate Durable Objects. Their storage transactions cannot be treated as one atomic transaction.

Therefore:
- TenantDirectory remains authoritative for membership and policy.
- WriteControl stores the exact authorization decision ID, membership version, policy version, resource digest, and decision timestamp used at admission.
- Current authorization must be re-evaluated on replay, continuation after UNKNOWN, and immediately before each new external dispatch.
- The contract must define the authorization linearization point: revocation after a dispatch has already been sent cannot retroactively cancel that external request. The operation must record which authorization version was checked before dispatch.
- Any inability to obtain a fresh required authorization decision fails closed before the next external side effect.

This design does not claim cross-DO atomicity or eliminate the time-of-check/time-of-use interval; it makes the boundary explicit and auditable.

### 10.3 Why not reuse OrchestratorLedger's outbox

The existing outbox is task-linked and requires a task in the same tenant/project. A GitHub write operation may exist without a task. Reusing it would either force synthetic task creation or weaken the existing task/outbox contract.

WriteControl should own its own operation audit/outbox records. A later generic event transport may deliver those records to external sinks, but delivery does not transfer ownership of the WriteControl aggregate.

## 11. Service credential lifecycle for service-only v1

The service-only decision remains in force. Required implementation contract:
- credential secrets stay in the platform secret manager; never in operation rows, logs, audit details, Git, or client responses;
- authenticator returns a stable service principal plus non-secret credential ID and credential version/key ID;
- credential ID/version and validation timestamp are recorded in the immutable operation context;
- support overlap rotation with explicit not-before/expiry windows;
- new admissions reject revoked/expired credentials;
- replay and UNKNOWN continuation re-check current credential status;
- emergency disable blocks new dispatches and recovery actions according to the approved revocation policy;
- old and new credential versions may overlap only for a bounded, explicitly approved window;
- the service bearer is never distributed to end-user clients;
- audit identifies the service credential version, never a human actor.

The current Worker does not yet provide credential version metadata. The credential authority, issuer, rotation operator, revocation propagation bound, and emergency-disable control remain OPEN. Do not read or alter any live secret during this design gate.

## 12. Quota and emergency-control model

Keep these dimensions separate:
1. Global emergency ceiling / kill switch.
2. Per-tenant admission rate and active-operation ceiling.
3. Per-service-principal admission rate and active-operation ceiling.
4. Per-project admission rate and active-operation ceiling.
5. Per-repository write rate, where justified by GitHub constraints.
6. Per-tenant UNKNOWN/unresolved-operation ceiling.
7. Global UNKNOWN/unresolved-operation ceiling.

The first implementation should enforce quota reservations atomically with operation admission. Terminal transitions release active-operation counters exactly once. UNKNOWN remains counted against unresolved capacity until reconciled or explicitly dispositioned.

Quota values must be derived from measured baseline traffic, expected peak, GitHub API rate limits, Worker/DO cost, recovery capacity, and owner-approved risk tolerance. Do not invent values or equate the existing per-IP rate limit with tenant fairness.

## 13. Retention, migration, and backup

- IN_PROGRESS and UNKNOWN records must never be silently pruned.
- Terminal idempotency tombstones require a documented retention period and exact expiry boundary.
- Audit evidence may require longer retention than idempotency records.
- Secret material is never retained.
- Schema migration must be additive, versioned, restart-safe, and tested against representative existing data.
- Backup/restore must preserve operation IDs, request fingerprints, phase ordering, lease generations, audit-chain integrity, and UNKNOWN status.
- Restoring an older snapshot must not permit stale leases or duplicate external writes; define a restore epoch/fencing mechanism before implementation.
- No migration of existing OrchestratorLedger task/outbox data into WriteControl is authorized or required by this proposal.

## 14. Contract-to-code status

| Requirement | Current evidence | Gate 2N disposition |
|---|---|---|
| Separate task and external-write aggregates | OrchestratorLedger is task/outbox/audit oriented | Dedicated WriteControl recommended |
| WriteControl class/binding/schema | Not present | NOT_IMPLEMENTED |
| create_change_pr admission call | Not present | NOT_INTEGRATED |
| Full-scope operation identity | Not present in Worker path | NOT_IMPLEMENTED |
| Request digest includes summary | Summary omitted from current authorization resource | OPEN BLOCKER |
| Per-phase durable state | Direct GitHub POST sequence | NOT_IMPLEMENTED |
| Lease/fencing for GitHub write | No WriteControl lease | NOT_IMPLEMENTED |
| UNKNOWN for every ambiguous phase | Only final PR POST has special ambiguity handling | INCOMPLETE |
| Reconciliation capability/evidence | No integrated WriteControl reconciler | NOT_IMPLEMENTED |
| Atomic admission + operation audit/outbox | No write-operation reservation | NOT_IMPLEMENTED |
| Credential ID/version lifecycle | Shared bearer maps to fixed service principal only | OPEN |
| Wildcard write DENY | Current Directory accepts exact digest or '*' | OPEN BLOCKER |
| Membership version in trusted context | Dropped by current context adapter | OPEN |
| Tenant/service/project quotas | Not enforced in createChangePr path | NOT_IMPLEMENTED |
| Real Worker + Directory + WriteControl composition tests | Not evidenced | NOT_RUN |

## 15. Test matrix — specifications only

All cases below are **NOT_RUN**. This is a test plan, not evidence of implementation or passing behavior.

| ID | Test objective | Expected invariant |
|---|---|---|
| G2N-01 | Same scope/key/request replay | One operation; no duplicate GitHub dispatch |
| G2N-02 | Same scope/key/different request | IDEMPOTENCY_CONFLICT |
| G2N-03 | Same client key, different tenant | Isolated operation; no cross-tenant disclosure |
| G2N-04 | Same client key, different project | Isolated operation |
| G2N-05 | Same client key, different principal | Isolated operation |
| G2N-06 | Canonical tuple delimiter attack | Distinct tuples produce distinct canonical bytes |
| G2N-07 | Owner/repository case normalization | Stable canonical repository identity |
| G2N-08 | Branch case preservation | Distinct case-sensitive branch values remain distinct |
| G2N-09 | Path Unicode NFC and duplicate-path checks | Deterministic normalized fingerprint; duplicates rejected |
| G2N-10 | File content digest/size binding | Any content change changes request digest |
| G2N-11 | Summary-only change | Request digest changes |
| G2N-12 | Title-only change | Request digest changes |
| G2N-13 | Expected blob SHA change | Request digest changes |
| G2N-14 | Atomic operation + audit reservation | Either both commit or neither commits |
| G2N-15 | Audit/outbox storage failure | No external GitHub request is dispatched |
| G2N-16 | Concurrent duplicate admission | Exactly one reservation is admitted |
| G2N-17 | Concurrent quota exhaustion | No tenant/project counter oversubscription |
| G2N-18 | Global emergency ceiling | New admission denied when disabled/ceiling reached |
| G2N-19 | Tenant fairness | One tenant cannot consume another tenant's quota |
| G2N-20 | Lease expiry and generation increment | Old generation cannot transition |
| G2N-21 | Crash before dispatch | Operation remains safely resumable without external side effect |
| G2N-22 | Crash after TREE_DISPATCHED | UNKNOWN; no blind POST replay |
| G2N-23 | Crash after TREE_WRITTEN | Exact tree evidence required to continue |
| G2N-24 | Crash after COMMIT_DISPATCHED | UNKNOWN; no blind commit POST replay |
| G2N-25 | Crash after COMMIT_WRITTEN | Commit identity is persisted and verified |
| G2N-26 | Crash after BRANCH_DISPATCHED | UNKNOWN; read-only branch reconciliation |
| G2N-27 | Crash after BRANCH_WRITTEN | Branch SHA must match expected commit |
| G2N-28 | Crash after PR_DISPATCHED | UNKNOWN; search/read exact PR evidence |
| G2N-29 | Non-unique GitHub reconciliation evidence | Remain UNKNOWN |
| G2N-30 | Stale or contradictory reconciliation evidence | Remain UNKNOWN |
| G2N-31 | Reconciler without distinct capability | DENY |
| G2N-32 | Revoked service credential on replay | DENY |
| G2N-33 | Credential rotation overlap | Only explicitly active versions accepted |
| G2N-34 | Credential emergency disable | No new external dispatch |
| G2N-35 | Membership revoked before dispatch | DENY before next side effect |
| G2N-36 | Policy version changes before dispatch | Fresh decision required |
| G2N-37 | Wildcard-only write policy | DENY |
| G2N-38 | TenantDirectory unavailable | Fail closed |
| G2N-39 | WriteControl unavailable | No GitHub write |
| G2N-40 | Audit sink unavailable with required outbox | Admission may proceed only if local atomic outbox commits; otherwise DENY |
| G2N-41 | Terminal tombstone expiry boundary | Explicit reuse policy; no accidental duplicate |
| G2N-42 | UNKNOWN retention cleanup attempt | UNKNOWN preserved |
| G2N-43 | Restore stale snapshot | Old lease cannot authorize a new dispatch |
| G2N-44 | Audit chain tampering | Integrity verification fails closed |
| G2N-45 | Oversized operation/audit payload | Rejected before admission |
| G2N-46 | Secret-like fields in payload | Rejected; no secret persisted |
| G2N-47 | Real Worker + TenantDirectory + WriteControl integration | Actual composition enforces all gates |
| G2N-48 | GitHub API failure at each phase | Correct FAILED versus UNKNOWN classification |
| G2N-49 | Duplicate GitHub PR marker | Reconciliation avoids duplicate PR |
| G2N-50 | Global coordinator contention/load | Measured latency/cost stays within approved SLO |

## 16. Open decisions before implementation authorization

1. Owner approval of dedicated WriteControl bounded context.
2. Owner approval of one logical global coordinator for v1, subject to capacity evidence.
3. Credential issuer/custodian, version metadata, rotation overlap, revocation and emergency disable.
4. Exact authorization linearization point and revocation behavior after an external dispatch has begun.
5. Whether the external audit sink is required for admission or local durable audit/outbox is sufficient.
6. Retention period, tombstone expiry and backup/restore guarantees.
7. Quota values and operational SLOs from measured traffic/cost.
8. Reconciliation role/capability issuer and independent evidence requirements.
9. Independent adversarial review of this Gate 2N design.
10. Exact implementation/test sequence and rollback strategy.

No values or owner decisions are silently inferred.

## 17. Gate 2N conclusion

**DESIGN REVIEW COMPLETE.**  
**RECOMMENDATION:** dedicated WriteControl Durable Object; keep OrchestratorLedger task-owned; one logical coordinator for constrained v1 only if capacity measurements support it.  
**OWNER APPROVAL:** PENDING.  
**INDEPENDENT REVIEW:** NOT_RUN.  
**IMPLEMENTATION:** NOT_AUTHORIZED.  
**TESTS:** NOT_RUN.  
**STAGING/PRODUCTION:** NO-GO.

The recommendation is falsifiable: if a formal aggregate review demonstrates that external write operations are lifecycle-owned by OrchestratorTask, or measured capacity proves a single WriteControl coordinator violates approved SLOs, this architecture must be revised before implementation.

## 18. Safety and provenance

This review created no application source changes and executed no tests. No Worker, Durable Object schema, secret, binding, route, DNS, database, deployment, PR, merge, main branch, or local computer was modified during the source review.

All source claims are limited to the exact branch and blob SHAs listed in Section 2. Current runtime/deployed artifact equivalence was not re-established by Gate 2N.
