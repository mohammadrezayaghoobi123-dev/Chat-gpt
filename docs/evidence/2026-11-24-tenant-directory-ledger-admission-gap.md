# Tenant Directory to Ledger Admission Authority Gap

- Audit date: 2026-11-24
- Base: `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`
- Scope: current-main source and connected Cloudflare metadata; evidence-only
- Disposition: architectural trust-boundary gap; live exploitability unknown

## Executive finding

The repository contains a functioning Tenant Directory authorization path, but that path is not connected to `OrchestratorLedger.createTask`.

This refines the earlier finding: tenant/project authorization is not absent from the project. It exists in `identity/tenant-context.js` and `identity/tenant-directory.js`, and the default Worker imports and uses it for its project operations. The gap is specifically at the Task Admission boundary: the Ledger accepts a system Scheduler assertion and a Task payload, but does not consume a Tenant Directory decision or authenticated authorization envelope.

## Source evidence

### 1. Tenant Directory has a deny-by-default policy authority

Files:
- `cloud-engineering-connector/identity/tenant-context.js`
- `cloud-engineering-connector/identity/tenant-directory-adapter.js`
- `cloud-engineering-connector/identity/tenant-directory.js`
- `cloud-engineering-connector/identity/tenant-directory-assertion.js`

Observed behavior:
- `resolveTenantContext` requires an authenticated principal and an active membership matching the selected tenant.
- `authorizeProjectAction` computes a resource digest, asks the policy store, and validates that the returned decision matches principal, tenant, project, action, and resource digest.
- An allow decision must include a non-empty decision ID and policy version.
- `TenantDirectory.authorizeProjectAction` checks active membership and a matching active policy rule; absent membership or policy yields default deny.
- The policy decision returned by the Directory is a plain structured object with principal, tenant, project, action, resource digest, effect, decision ID, and policy version. It is not a signed admission capability in the current implementation.

### 2. Worker uses this authority for project operations

`worker.js` imports `resolvePrincipal`, `resolveTenantContext`, `authorizeProjectAction`, and `createTenantDirectoryAdapters`.

This establishes that Tenant Directory is not merely an unused module: it is wired into the Worker request authorization path. The reviewed Worker path does not call `OrchestratorLedger.createTask` or mint a Scheduler assertion.

### 3. Ledger Task Admission does not consume that authority

File: `cloud-engineering-connector/orchestrator-ledger.js`

The current `createTask` boundary:
- requires tenant and project identifiers in the Task object;
- requires `workerId === "orchestrator-scheduler"`;
- verifies a `system / createTask` assertion for the fixed Scheduler subject;
- consumes the assertion JTI and persists the Task inside a Durable Object transaction;
- does not accept a Tenant Directory decision, decision ID, policy version, principal identity, membership version, or signed request digest;
- does not recompute or verify an authorization envelope tied to the exact Task.

The existing transaction provides atomicity for the Ledger's local assertion consumption and Task persistence. It does not make a separate Tenant Directory authorization decision atomic with that Ledger transaction.

### 4. Tenant membership and policy freshness

The Directory checks current active membership when `authorizeProjectAction` is evaluated. The resulting decision is then returned to its caller as a normal object. The current Task Admission API does not carry that decision to the Ledger.

Even if a caller were to pass the plain object through, the Ledger could not authenticate its origin or establish freshness. A membership revocation or policy change can occur after a decision is evaluated and before a separate admission operation. The current interface does not define whether authorization is point-in-time, bounded-staleness, or immediate-revocation.

This is a consistency-contract gap, not proof that a race is currently exploitable.

## Connected Cloudflare metadata cross-check

A fresh read-only inventory of the connected Cloudflare account returned exactly:
- `chat-gpt111`
- `chat-gpt111-staging`
- `master-brain-cloud-agent`

The production `chat-gpt111` settings did not list an `ORCHESTRATOR_LEDGER` Durable Object namespace binding. Staging listed `WRITE_CONTROL` / `WriteControl`, but not `ORCHESTRATOR_LEDGER`. The metadata response did not disclose secret values and no secret values were requested.

This is consistent with the previously established unreleased-source delta. It does not establish the state of other accounts, external services, or other deployments.

## Threat and consistency analysis

### Trust boundary

`Tenant Directory -> Worker -> Scheduler/Admission caller -> OrchestratorLedger`

The first two components implement principal, membership, and project-policy checks. The last component independently verifies a system assertion but receives no cryptographically verifiable evidence that those checks authorized the exact Task.

### Required properties

Before connecting the two subsystems, the architecture must define:

1. **Authorization subject:** which authenticated principal or platform service requested the Task.
2. **Action:** a distinct policy action such as `task.create`, not reuse of a generic project-read/write permission.
3. **Request binding:** tenant ID, project ID, task ID, and a canonical digest of the complete normalized Task and relevant admission inputs.
4. **Decision provenance:** decision ID, policy version, issuer, audience, and an authenticated signature/MAC over the decision envelope.
5. **Membership freshness:** membership ID and version/revocation epoch, or an explicitly bounded authorization lifetime.
6. **Replay control:** unique JTI and one-time consumption in the same Ledger transaction as Task insertion.
7. **Fail-closed behavior:** missing, malformed, expired, mismatched, or unverifiable authorization must reject admission.
8. **Auditability:** persist the verified decision ID, policy version, principal, request digest, and issuer reference with the Task admission audit record.

### Cross-Durable-Object consistency decision

Tenant Directory and Orchestrator Ledger are separate Durable Objects. Their local transactions do not provide a single atomic transaction across both objects.

The project must choose one explicit contract:

- **Bounded-staleness grant:** Directory issues a short-lived, signed, Task-bound admission grant. Ledger verifies it and atomically consumes its JTI with Task insertion. Revocation is bounded by the grant TTL.
- **Strict revocation:** admission must consult a current authoritative revocation/policy epoch at the admission boundary using a protocol that prevents stale grants from being accepted. This requires a separately designed coordination/serialization mechanism; do not claim cross-DO atomicity.
- **Single admission authority:** move the final policy check and Task insertion behind one authority boundary, if the resulting ownership and scaling model is acceptable.

Do not silently assume that a short TTL provides immediate revocation. Do not introduce a distributed transaction claim that the platform does not provide.

## Falsifiable hypotheses

| ID | Hypothesis | Current disposition | Falsification evidence |
|---|---|---|---|
| H1 | Tenant Directory authorization exists in current source. | Supported | Current-main context, adapter, Directory, and tests. |
| H2 | The default Worker uses Tenant Directory for project authorization. | Supported | Worker imports and invokes the context/adapters in project request paths. |
| H3 | Ledger Task Admission independently verifies a Directory decision. | Rejected by inspected API | `createTask` signature and verification path do not accept one. |
| H4 | A plain Directory decision object is authenticated by Ledger. | Rejected by interface | No signature or verification method for the decision envelope is present in `createTask`. |
| H5 | Revocation is immediately consistent across Directory and Ledger. | Unknown / not specified | Requires a defined cross-object protocol and race tests. |
| H6 | A live production Scheduler can reach the Ledger in the connected account. | Not observed | Current Worker metadata has no Ledger binding; external paths remain unknown. |

## Atomic hostile test plan (not executed)

1. **No decision:** valid Scheduler assertion + Task but no admission grant -> reject.
2. **Forged decision object:** caller supplies a plain object with `effect: allow` -> reject.
3. **Wrong tenant/project:** valid grant replayed against a different tenant or project -> reject.
4. **Wrong Task:** same grant used with changed Task ID or canonical digest -> reject.
5. **Policy mutation:** grant issued under policy version N, policy changes to N+1 before admission -> behavior must match the explicitly selected freshness contract.
6. **Membership revocation race:** revoke membership between decision and admission -> behavior must match the selected revocation contract.
7. **Replay:** same JTI submitted concurrently twice -> exactly one Task admission.
8. **Rollback:** force Task insert failure after JTI validation/consumption -> no partially committed admission; transaction semantics explicitly tested.
9. **Mutation testing:** remove each binding, signature verification, freshness check, and JTI consumption independently; its paired negative test must fail.

## Safe disposition

- Do not connect the two systems by passing an unsigned decision object.
- Do not weaken the existing default-deny Tenant Directory behavior.
- Do not add Tenant Directory calls to the current Worker or Ledger without a selected consistency contract and a test-first design.
- Keep `main`, Production, Cloudflare resources, bindings, and secrets unchanged.
- PR #423 remains a separate audit of the Scheduler assertion minting helper. This document addresses the distinct Directory-to-Ledger authority and consistency boundary.

## Verification limitations

- Source review and Cloudflare settings metadata only.
- No runtime tests, mutation tests, deployment, or production invocation were performed.
- Cloudflare inspection used GET operations only.
- No secret values or key material were retrieved.
