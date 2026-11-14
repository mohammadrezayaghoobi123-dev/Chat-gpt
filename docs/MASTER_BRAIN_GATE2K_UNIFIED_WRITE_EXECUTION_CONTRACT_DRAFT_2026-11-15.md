# Master Brain — Gate 2K Unified Write Execution Contract and Test Specification
**Date:** 2026-11-15  
**Mission:** MB-G2K-UNIFIED-WRITE-EXECUTION-CONTRACT-2026-11-15-001  
**Status:** DRAFT — FOR ADVERSARIAL REVIEW — NOT FROZEN  
**Implementation authorization:** NONE  
**Deployment authorization:** NONE

## 1. Purpose and scope

This document defines the candidate contract for state-changing external operations initiated through the Cloud Engineering Connector, beginning with create_change_pr.

It composes two independent mandatory controls:
1. Authorization: who may perform which action on which tenant/project/resource now.
2. Execution safety: how the external side effect is admitted, deduplicated, fenced, quarantined, reconciled, and audited.

This contract does not merge Python Mission, Node OrchestrationTask, KnowledgeStore, BrainEntry, or WriteOperation into one aggregate or database. It defines only the adapter boundary for a protected external write. Each bounded context retains its authoritative writer.

The contract is based on identity contract candidate v2 (not frozen), current main Tenant Directory/project authorization source, staging-candidate WriteControl implementation, and Gates 2H–2J.

## 2. Invariants

1. No GitHub write before successful authentication, principal resolution, current membership check, exact project/action/resource authorization, request validation, and durable write admission.
2. Client-supplied principal, actor, tenant, project, role, authorization decision, or scope hash is never authoritative.
3. Service and human principals remain distinct closed types.
4. Every protected write is scoped by principal, tenant, project, action, and normalized resource.
5. Same-scope/same-key/same-request replay is idempotent within the documented retention window.
6. Same-scope/same-key/different-request is rejected as IDEMPOTENCY_CONFLICT.
7. Different security scopes never collide, replay, or reveal operation existence to each other.
8. Current authorization is re-evaluated before returning replay data or continuing recovery.
9. UNKNOWN is a first-class outcome. No ambiguous external result is silently treated as success or failure.
10. Reconciliation requires independently observed, exact external evidence and a distinct capability.
11. Durable write-control failure, authorization unavailability, audit failure, or integrity failure is fail-closed.
12. No automatic merge or deployment is part of create_change_pr.
13. Tests not executed remain NOT_RUN; unknown outcomes remain UNKNOWN.
14. One authoritative writer per aggregate; no global single-writer mandate.

## 3. Trusted execution context

### 3.1 Server-derived context

The authorization adapter produces a typed context only after authentication and claim validation:
- schema_version;
- request_id and correlation_id;
- principal.type: human | service;
- principal.id: canonical immutable identifier;
- principal.issuer_ref for human OIDC identities, where applicable;
- credential_id/session_id and credential_version;
- tenant.id;
- membership.id and membership.version;
- project.id and project.policy_version;
- action: exact action identifier, e.g. project.create_pr;
- resource.type and normalized resource identity;
- resource.digest;
- authorization.decision_id;
- authorization.decision: allow | deny;
- authorization.policy_version;
- authorization.decided_at;
- authorization.expires_at, if policy explicitly uses an expiring decision;
- source_component and authenticated executor service.

The context is constructed inside the trusted Worker from the validated authenticator and authoritative Tenant Directory. It is not accepted as a complete object from MCP arguments.

### 3.2 Principal classes

The only accepted principal types are human and service.
- Human principal IDs follow the approved identity contract only after the OIDC verifier has validated issuer, subject, signature, audience, nonce, state, PKCE, expiry, and replay constraints.
- Service principal IDs are resolved by a server-side service authenticator or registry. Preserve service:shared-mcp-bearer as a legacy service identity until a separately reviewed migration exists.
- A shared bearer authenticates a service capability, not the individual human operating a client.
- Email is mutable profile data, not principal identity.
- No automatic linking by email and no service-to-human conversion.

The identity candidate v2 is not frozen; the exact human derivation and authenticator remain subject to independent approval.

### 3.3 Tenant and project selectors

MCP arguments may include tenant_id and project_id only as selectors. The server must:
1. authenticate and resolve the principal;
2. look up the selected tenant membership in Tenant Directory;
3. reject missing, suspended, expired, or revoked membership;
4. resolve the exact project;
5. authorize the exact action and resource;
6. create a server-owned context.

A selector never creates membership or grants access. A project ID cannot be inferred from repository owner, email, source.user_id, or client metadata.

## 4. Authorization decision contract

The authorization adapter returns:
- decision_id;
- decision: allow | deny;
- reason_code from a bounded enumeration;
- principal_ref;
- tenant_id and membership_id;
- project_id;
- action;
- resource_digest;
- policy_version;
- decided_at;
- evidence_ref.

Rules:
- A missing or malformed decision is DENY.
- Policy service unavailable is DENY.
- A wildcard resource rule is not accepted for create_change_pr until the wildcard policy owner explicitly approves it.
- Write authorization defaults to an exact normalized resource digest.
- No positive authorization cache for writes in v1.
- Re-evaluate authorization on every replay and every continuation after UNKNOWN.
- A historical allow decision is provenance, not perpetual authority.
- Reconciliation uses a separate capability and cannot be obtained merely from project.create_pr.

## 5. Canonical operation identity and idempotency

### 5.1 Versioned key derivation

Candidate v2 operation identity serialization fields, in fixed order:

MB-WRITE-OP, version=2, action, principal.type, principal.id, tenant.id, project.id, resource.type, resource.owner_lowercase, resource.name_lowercase, client_idempotency_key.

All fields are UTF-8. The serialization must use a formally specified delimiter/length-prefix scheme so values cannot create ambiguous concatenations. A length-prefixed binary tuple or canonical JSON with a fixed field order is preferred over unescaped newline concatenation.

operation_key = SHA-256(canonical_operation_identity_bytes).

The domain separator and version prevent collisions with older key formats. A v2 implementation must not reinterpret existing v1 keys in place.

### 5.2 Request fingerprint

A separate SHA-256 request digest covers all operation-affecting fields:
- schema/version and action;
- principal type/ID, tenant ID, project ID;
- canonical repository identity;
- base branch;
- validated/sorted path list, preserving case-sensitive path identity;
- SHA-256 digest and byte length of each UTF-8 file content;
- normalized title;
- normalized summary;
- knowledge-vault expected blob SHA and any other conditional-write precondition;
- policy-relevant options.

Do not hash secret values or credentials. Do not include volatile timestamps, trace IDs, retry counters, or transport headers.

Canonicalization rules must be deterministic and golden-tested:
- owner/repository are validated slugs and canonicalized to lowercase;
- branch names are validated but remain case-sensitive;
- paths must pass existing path validation and Unicode NFC constraints; path case is preserved;
- file entries are sorted by normalized path before fingerprinting;
- content is UTF-8 encoded and hashed exactly after input validation;
- title and summary normalization must match the exact values used in the GitHub payload;
- duplicate paths are rejected before hashing.

### 5.3 Replay matrix

| Existing operation | Incoming scope/key | Request digest | Required result |
|---|---|---|---|
| absent | authorized scope + new key | any valid digest | admit once |
| present | same full scope + same key | same | return/continue same operation after current authorization |
| present | same full scope + same key | different | IDEMPOTENCY_CONFLICT |
| present | different principal | same client key | independent operation; no disclosure |
| present | different tenant | same client key | independent operation; no disclosure |
| present | different project | same client key | independent operation; no disclosure |
| present | same scope after terminal retention expires | same key | follow explicit documented expiry/reuse policy |
| UNKNOWN | same scope/key | same | remain quarantined until exact reconciliation evidence |

### 5.4 Retention

The candidate source currently retains terminal success/failure records for 30 days and deliberately does not prune UNKNOWN or IN_PROGRESS operations. This is a candidate policy, not yet approved as the final Master Brain retention policy.

Before implementation freeze:
- specify the exact retention window and boundary behavior;
- unresolved operations must never be silently deleted;
- after terminal tombstone expiry, key reuse must be explicitly documented;
- audit evidence retention may exceed idempotency-record retention;
- deletion must not erase security/audit evidence required for investigation or legal retention.

## 6. Durable Write Control contract

### 6.1 Responsibilities

WriteControl owns only the durable state machine for one external write operation:
- admission and idempotency;
- per-operation request digest and security scope;
- lease generation/fencing;
- phase transitions;
- UNKNOWN quarantine;
- reconciliation receipts;
- bounded rate/backlog policy;
- operation-state audit events.

It does not own Mission lifecycle, OrchestrationTask lifecycle, Knowledge entities, or BrainEntry content.

### 6.2 Required commands

- admit(scope, operation_identity, request_digest, quota_policy)
- getOperation(scope, operation_id)
- transition(scope, operation_id, expected_phase, next_phase, lease_generation, evidence)
- markUnknown(scope, operation_id, lease_generation, reason_code)
- reconcile(scope, operation_id, lease_generation, external_evidence)
- getScopedStatus(scope, operation_id)
- getHealth()

Every command must validate the full scope. A raw key hash alone is not sufficient authorization to read or mutate an operation.

The initial operation reservation and its first append-only audit event must be committed atomically in the same Durable Object transaction. If the audit sink is a separate bounded context, write a transactional outbox record in the same transaction; do not rely on two independent non-atomic writes. A failed reservation/audit transaction must produce no external GitHub side effect.

### 6.3 Required state machine

Candidate phases:
- RESERVED
- TREE_DISPATCHED
- TREE_WRITTEN
- COMMIT_DISPATCHED
- COMMIT_WRITTEN
- BRANCH_WRITTEN
- PR_DISPATCHED
- PR_CREATED

Terminal statuses: SUCCEEDED, FAILED.  
Non-terminal/quarantine statuses: IN_PROGRESS, UNKNOWN.

Transitions must be monotonic and compare-and-swap protected. Every transition must check:
- exact operation scope;
- current phase;
- current status;
- lease generation;
- expected evidence;
- immutable GitHub object identity where applicable.

A stale lease cannot mutate state. A lease-generation mismatch is a hard conflict, not a retry hint.

### 6.4 Durable Object partitioning

Candidate v1 recommendation: retain one physical WriteControl Durable Object as the atomic coordinator only if:
- every operation row stores principal, tenant, project, action, resource, and scope digest;
- operation IDs are derived from the full versioned scope;
- every read, replay, transition, and reconciliation checks the full scope;
- tenant-specific quotas and unresolved counts are enforced transactionally;
- a global emergency ceiling remains independent of tenant fairness;
- no response reveals another tenant's operation existence or metadata.

This preserves atomic global safety limits while logically isolating tenant records. Sharding by tenant may be introduced only after load/cost measurements and an explicit migration plan. Do not assume one global DO is automatically multi-tenant safe.

### 6.5 Quotas and fairness

Separate:
- global emergency ceiling for unresolved operations and total external write pressure;
- per-tenant admission quota;
- per-principal/service quota where required;
- per-repository quota if GitHub abuse limits require it.

A tenant must not exhaust all ordinary capacity for every other tenant. The exact numbers are OPEN and must be selected from measured load, GitHub rate limits, and the cost budget. The candidate's five-per-minute limit is not automatically adopted as a per-tenant limit.

## 7. Exact execution order

1. Validate the transport envelope and bounded request size.
2. Perform pure local request validation: schema, path safety, payload size, base-branch syntax, preconditions, and deterministic resource normalization. This step performs no external call and creates no durable operation record.
3. Authenticate the credential.
4. Resolve canonical principal and credential version.
5. Resolve current tenant membership.
6. Resolve the exact project.
7. Authorize the exact action against the normalized resource digest.
8. Construct the trusted execution context and canonical operation identity.
9. Atomically admit the operation, reserve a fenced lease, and append the initial audit event (or transactional outbox record) in one transaction.
10. Perform external GitHub writes one phase at a time.
11. Verify each returned GitHub object against exact expected identity.
12. Persist each phase transition and audit event with compare-and-swap and lease fencing.
13. On ambiguous response or crash, mark UNKNOWN and stop blind retry.
14. Re-evaluate current authorization before replay or recovery.
15. Reconcile only from independently fetched GitHub evidence under the separate reconciler capability.
16. Persist terminal outcome and audit receipt.
17. Return only scope-authorized result data.

Any failure before step 9 must create no write reservation and no GitHub side effect. If authentication or authorization fails, no operation existence or cross-scope metadata may be returned. Any failure after step 9 but before an external side effect may be safely failed or reopened only under explicit state-machine rules. Any uncertain external outcome becomes UNKNOWN.

## 8. Audit event contract

Each state transition records an append-only event containing:
- event_id and schema_version;
- operation_id and idempotency_version;
- principal type/ID and authenticated executor service;
- tenant, membership, project and policy versions;
- action and resource digest;
- authorization decision ID and timestamp;
- request digest;
- previous and next phase/status;
- lease generation;
- external GitHub object IDs/SHAs where verified;
- evidence references and verifier identity;
- timestamp and correlation/causation IDs;
- outcome/reason code.

Do not record bearer tokens, OAuth tokens, secret values, raw credentials, or unnecessary personal data.

WriteControl operation events are local to the WriteControl bounded context. OrchestratorLedger audit and outbox remain authoritative for orchestration aggregates. Cross-context references use correlation IDs and a future versioned event envelope; they do not create a second writer for either aggregate.

## 9. Executable test specification

All tests below are required. Their current execution state is NOT_RUN unless a future run artifact explicitly proves otherwise.

### 9.1 Golden canonicalization fixtures
1. same principal/tenant/project/repository/key produces same operation ID across processes;
2. different principal type produces different operation ID;
3. different principal ID produces different operation ID;
4. different tenant produces different operation ID;
5. different project produces different operation ID;
6. different action or resource produces different operation ID;
7. owner/repository case normalization is deterministic;
8. path case remains distinct;
9. Unicode non-NFC path is rejected before hashing;
10. file-order permutation produces the documented canonical digest;
11. changed file content changes request digest;
12. changed base branch/title/summary/precondition changes request digest;
13. delimiter/control-character input cannot create serialization ambiguity;
14. old v1 operation IDs cannot be interpreted as v2.

### 9.2 Authorization and tenant-isolation tests
15. unauthenticated create is denied;
16. service principal cannot be silently treated as human;
17. human principal cannot inherit service capability;
18. unknown principal type is denied;
19. forged tenant selector is denied;
20. absent/revoked membership is denied;
21. suspended/expired membership is denied;
22. wrong project is denied;
23. missing exact-resource policy is denied;
24. wildcard write policy is denied until approved;
25. policy service outage is fail-closed;
26. denial creates no ledger reservation and no GitHub write;
27. no positive write authorization cache survives policy revocation.

### 9.3 Idempotency and concurrency tests
28. same-scope/same-key/same-payload produces one operation;
29. same-scope/same-key/different-payload returns conflict;
30. same key across different tenants yields independent records;
31. same key across different principals yields independent records;
32. same key across different projects yields independent records;
33. concurrent duplicate admission has exactly one winner;
34. stale lease cannot transition;
35. stale owner cannot reconcile;
36. cross-scope operation lookup returns indistinguishable not-found/denied behavior;
37. tenant quota saturation does not consume another tenant's quota;
38. global emergency ceiling blocks all new writes without corrupting existing records.

### 9.4 Replay and revocation tests
39. terminal replay requires current authorization;
40. IN_PROGRESS replay does not start a second external write;
41. UNKNOWN replay does not blindly retry;
42. membership revoked after original write blocks user replay;
43. project permission revoked after original write blocks user replay;
44. authorized reconciler can recover only within its explicit capability;
45. reconciler cannot read another tenant's operation;
46. operation result metadata is not returned to a different scope.

### 9.5 Crash and external-side-effect injection
47. crash before reservation;
48. crash after reservation but before first GitHub request;
49. timeout after tree POST;
50. timeout after commit POST;
51. timeout after branch POST;
52. timeout after PR POST;
53. GitHub returns mismatched tree/commit/branch/PR identity;
54. lease expires during external request;
55. Durable Object unavailable before admission;
56. Durable Object unavailable after external write;
57. audit append fails before external write;
58. audit append fails after external write;
59. reconciliation evidence missing, stale, or contradictory;
60. restart/replay recovers only from exact immutable GitHub evidence.

### 9.6 Retention, migration, and recovery
61. terminal record at exact retention boundary;
62. terminal record just beyond expiry;
63. UNKNOWN and IN_PROGRESS never auto-pruned;
64. unresolved backlog cap fails closed;
65. additive schema migration from existing v1 data;
66. rollback to prior Worker with compatible Durable Object schema;
67. backup/restore preserves operation identity and audit chain;
68. restored stale lease cannot execute external writes;
69. v1 records remain readable under explicit compatibility rules;
70. migration does not reinterpret or silently rewrite existing operation IDs.

### 9.7 Required test evidence

Every test run must produce exact commit SHA, toolchain/runtime versions, command and environment, test count and pass/fail/skip totals, raw logs/artifacts, deterministic seed for concurrency/failure injection, expected versus actual result, evidence hash, reviewer and timestamp.

A test that was authored but not executed is NOT_RUN. A timeout with uncertain external state is UNKNOWN, not FAIL or PASS.

## 10. Implementation slices and exit gates

| Slice | Work | Exit evidence |
|---|---|---|
| K1 | Freeze trusted context and policy interface | contract review and golden fixtures |
| K2 | Add versioned operation identity and request digest | canonicalization tests |
| K3 | Scope WriteControl records and every RPC method | cross-scope negative tests |
| K4 | Compose authorization before admission | deny-before-reservation tests |
| K5 | Preserve lease/UNKNOWN/reconciliation behavior | crash-injection matrix |
| K6 | Add quotas, retention, audit, migration | fairness, retention, restore tests |
| K7 | Staging-only isolated release candidate | exact artifact provenance and runtime acceptance |
| K8 | Independent red-team review | signed findings and closure evidence |

No implementation slice is authorized by this draft. Each slice requires an approved contract and a separate atomic change set.

## 11. Open decisions requiring explicit owner approval

- Exact canonical principal serialization and authenticator.
- Whether the first live release remains service-only or enables human OIDC.
- Tenant Directory wildcard-resource policy.
- Per-tenant and per-principal quota values.
- Global unresolved-operation ceiling and retention duration.
- Physical Durable Object partitioning strategy after cost/load measurement.
- Reconciler service identity and operational approval model.
- Audit evidence retention and external anchoring.
- Deployment provenance attestation mechanism.
- Backend ownership and BrainEntry persistence remain separate unresolved gates.

No default is silently selected for these decisions.

## 12. Gate 2K status

DRAFTED — NOT FROZEN — NOT IMPLEMENTED — NOT TESTED — NOT APPROVED.

This document is a candidate interface and test plan. It does not establish that the implementation exists, that tests pass, or that a live service is safe.

## 13. Safety

Documentation-only change. No source code, test suite, Worker, Durable Object, secret, binding, route, DNS record, database, PR, main branch, or production resource was modified. No tests or live endpoint probes were executed. Production remains NO-GO.
