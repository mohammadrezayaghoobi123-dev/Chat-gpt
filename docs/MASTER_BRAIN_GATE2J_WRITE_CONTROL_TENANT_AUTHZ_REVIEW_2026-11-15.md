# Master Brain — Gate 2J Write-Control / Tenant-Authorization Adversarial Review
**Date:** 2026-11-15  
**Mission:** MB-G2J-WRITE-CONTROL-TENANT-AUTHZ-REVIEW-2026-11-15-001  
**Mode:** Static source and contract review; no code changes  
**Decision:** WRITE-CONTROL CANDIDATE IS NOT MULTI-TENANT READY  
**Tests:** NOT_RUN  
**Deployment:** NOT_AUTHORIZED

## 1. Executive conclusion

The staging-candidate implementation contains valuable write-safety mechanisms: atomic admission, idempotency conflict detection, rate limiting, lease fencing, explicit UNKNOWN state, reconciliation, and bounded terminal retention.

However, the reviewed candidate (release/staging-candidate-2026-11-09, head 8c81d88f4e8958411bd89fae2320f53b66f39fa1) is a single shared-bearer/owner-oriented implementation. Its create_change_pr input has no authenticated principal, tenant ID, or project ID. The global write ledger's idempotency key is scoped only by canonical repository and caller-supplied idempotency key.

The current main Worker (919b19ca3d3887352cdef06b03c668ead04fbce7) introduces service-principal validation plus Tenant Directory membership and project-action authorization, but does not contain the candidate's write-control.js or the corresponding WRITE_CONTROL binding in its Wrangler configuration.

These are two separate security controls that must be composed. Neither source snapshot alone currently supplies both controls. The candidate must not be described as multi-tenant safe, and the current main Worker must not be deployed as a replacement until idempotency/UNKNOWN recovery is integrated and verified.

This is a design and release blocker, not evidence that a cross-tenant exploit has been demonstrated in the current owner-only deployment.

## 2. Source snapshots and evidence

### 2.1 Staging candidate

Repository: mohammadrezayaghoobi123-dev/Chat-gpt  
Branch: release/staging-candidate-2026-11-09  
Head: 8c81d88f4e8958411bd89fae2320f53b66f39fa1  
Relevant blobs:
- cloud-engineering-connector/worker.js: 5df5ef53195d0cdbbb271c3891109ee747fcdef4
- cloud-engineering-connector/write-control.js: c103f8f41d9627bf06250bf1ce01c271fdb43f41
- cloud-engineering-connector/wrangler.toml: e7a39c372b77208ea6ad696b4c2e8fd91fa747aa
- cloud-engineering-connector/cloudflare-test/write-control.test.js: be9b55e5d365b599ccca1e77776c9f7838403cb3
- cloud-engineering-connector/cloudflare-test/write-control-retention.test.js: d113b588f21f50f9942b487f4cb28f68950522d3

Relevant code locations:
- worker.js lines 40-41: create_change_pr schema requires idempotency key, owner, repo, base branch, title, summary, files; no principal/tenant/project.
- worker.js lines 274-310: request validation, global Durable Object selection and key/request hashing.
- worker.js lines 311-337 onward: admission, replay, UNKNOWN and lease handling.
- worker.js lines 815-821: callTool dispatches create_change_pr without a principal argument.
- worker.js lines 837 onward and 1174 onward: MCP shared-bearer/public-read-only authentication boundary.
- write-control.js lines 212-297: atomic admission and global rate/backlog policy.
- write-control.js lines 300 onward: phase transition and lease-generation checks.
- wrangler.toml lines 35-46: global WRITE_CONTROL binding and migration.
- Tests include admission, idempotency replay/conflict, lease/phase handling, UNKNOWN reconciliation, and retention cases.

### 2.2 Current main

Repository: same  
Branch: main  
Head: 919b19ca3d3887352cdef06b03c668ead04fbce7  
Relevant blobs:
- cloud-engineering-connector/worker.js: 8911b4fc7df279ecbea7689506e0f814b2414dff
- cloud-engineering-connector/wrangler.toml: 6c81ef6761497f6e8889a1ed8aa715b70922a949

Observed in main:
- imports resolvePrincipal, resolveTenantContext, and authorizeProjectAction;
- imports Tenant Directory adapters;
- createChangePr requires the service:shared-mcp-bearer service principal;
- resolves tenant membership and project.create_pr policy before GitHub write calls;
- requires tenant and project selectors;
- does not include the candidate's write-control.js implementation or WRITE_CONTROL binding.

### 2.3 Provenance caveat

Cloudflare's deployed staging version is dated 2026-11-02. The reviewed candidate branch head is dated 2026-11-09. Exact commit-to-deployed-artifact provenance remains UNKNOWN (Gate 2I). Candidate source inspection is not proof that every reviewed line is present in the deployed staging version.

## 3. Findings

| ID | Finding | Severity | Evidence | Disposition |
|---|---|---|---|---|
| WC-01 | Candidate write operation has no authenticated principal/tenant/project in its input or dispatch contract | P1 architecture blocker | worker.js 40-41, 274-310, 815-821 | Add trusted execution context, not caller-asserted identity |
| WC-02 | Idempotency key hash is repository + client key only | P1 for multi-tenant | worker.js 305-310 | Include principal, tenant, project, action and resource scope |
| WC-03 | Candidate uses one global Durable Object identity create-change-pr-global | P2 scaling/isolation concern | worker.js 297-310; wrangler.toml WRITE_CONTROL | Keep only if every record and operation is scope-bound; otherwise shard by tenant |
| WC-04 | Current main has tenant/project authorization but no integrated durable write-control path | P1 release blocker | main worker.js 1-2, 85-122; main Wrangler has no WRITE_CONTROL binding | Compose both controls before staging |
| WC-05 | Current candidate maps authenticated bearer to a fixed owner context for Knowledge Store, not a canonical human principal | P1 for human identity claims | worker.js 815-821 and request dispatch around 1174+; authenticated ? owner : null | Treat as service/owner-only v1; do not claim individual human attribution |
| WC-06 | Candidate source provenance for deployed staging is not established | P1 release evidence gap | Cloudflare version metadata and branch timestamps; Gate 2I | Require artifact-to-commit attestation |
| WC-07 | Existing tests are authored but were not executed in this audit | UNKNOWN | test files inspected only | NOT_RUN; no pass claim |

## 4. Adversarial scenarios and falsification tests

### A. Idempotency collision across principals or tenants

Scenario: Two principals in different tenants submit the same repository and idempotency key but different operation content.

Candidate behavior: keyHash is derived from create_change_pr, canonical owner/repo, and idempotency key. requestHash is calculated separately from request data. The first operation occupies the global key. The second request can receive IDEMPOTENCY_CONFLICT; it cannot be independently admitted under its own tenant scope.

Risk: In a future multi-tenant system this creates cross-tenant key collision/denial-of-service and potentially operation-existence side channels. Current owner-only deployment does not establish an exploitable cross-tenant case.

Required falsification test: Submit the same idempotency key concurrently from two distinct test principals and tenant/project scopes. Expected: independent operation identities and no cross-scope read, replay, collision, or denial. Then repeat with the same scope and changed request payload; expected: deterministic conflict.

### B. Replay after authorization revocation

Scenario: A request succeeds or becomes UNKNOWN; tenant membership or project permission is revoked; the caller replays the same idempotency key.

Candidate behavior: The candidate has no tenant/project authorization context to re-evaluate. Replay reads the existing operation by key hash.

Risk: A future tenant-aware adapter could return operation state or continue recovery without proving current authorization.

Required falsification test: Create operation, revoke membership or project.create_pr, replay same key. Expected: deny before returning operation metadata and before any external GitHub request. An authorized auditor/reconciler must use a separate explicit permission path.

### C. Authorization ordering versus write admission

Scenario: Unauthorized request attempts to reserve an idempotency key or consume rate-limit capacity.

Candidate behavior: The reviewed candidate has no Tenant Directory policy check. It performs write-control admission before external GitHub writes. Main has tenant/project authorization but no write-control admission.

Required target order: authenticate → resolve principal → validate service capability → resolve membership → authorize exact project/action/resource → validate request → scoped idempotency admission → persist reservation → external side effect.

Required falsification test: Deny membership/project policy and assert zero ledger reservation, zero GitHub API write calls, zero branch/commit/PR creation.

### D. Unknown outcome and recovery

Scenario: GitHub accepts a write but the response is lost, or the Worker crashes between an external write and ledger transition.

Candidate strengths: It marks ambiguous outcomes UNKNOWN, uses phase/lease generation checks, deterministic branch identity, and evidence-based reconciliation. It does not intentionally blind-retry an ambiguous write.

Remaining requirement: Preserve those properties when tenant authorization is added. Reconciliation must not become a bypass around current authorization or audit.

Required falsification test: Inject a timeout after each GitHub side effect (tree, commit, branch, PR); restart/replay; prove one operation identity, no duplicate external object, UNKNOWN quarantine when evidence is insufficient, and deterministic recovery only after exact external evidence.

### E. Global backlog and rate limit

Scenario: One tenant generates unresolved UNKNOWN operations or consumes all write admissions.

Candidate behavior: One global Durable Object tracks unresolved backlog and a five-per-minute admission window.

Risk: In multi-tenant operation one tenant can consume global capacity and block others. This may be an intentional global emergency brake, but it is not tenant fairness.

Required design decision: Define both global safety ceilings and per-tenant/per-principal quotas. Preserve a global circuit breaker, but prevent one tenant from exhausting all normal admission capacity.

Required falsification test: Saturate one tenant's quota and prove another tenant retains its configured fair share while the global emergency ceiling still blocks all tenants when reached.

### F. Fixed owner identity versus human attribution

Scenario: Multiple human operators use the same shared MCP bearer.

Candidate behavior: Authenticated requests are represented as the fixed owner tenant for Knowledge Store operations; create_change_pr receives no principal. Individual operator attribution is not established.

Risk: Audit logs cannot reliably prove which human initiated an operation. A shared service credential must not be presented as a human login or a human principal.

Required falsification test: Two distinct authenticated human identities must produce distinct canonical principals and audit actors. Service bearer use must remain service:* and never become a human identity.

## 5. Required unified contract

Before implementation, specify and freeze a single adapter contract.

### Trusted request context (server-derived only)
- principal.type: human | service;
- principal.id: canonical immutable principal identifier;
- tenant.id: resolved from authenticated principal and membership;
- membership.id and membership.version;
- project.id and project.policy_version;
- action: exact capability such as project.create_pr;
- resource: normalized repository identity and protected-resource classification;
- authorization.decision_id and decision timestamp;
- credential/session version and revocation epoch.

None of these fields may be trusted from MCP tool arguments. Caller-supplied tenant/project selectors are selectors only; the server resolves and authorizes them against the trusted principal.

### Scoped idempotency identity
Define canonical serialization and golden fixtures for:

action | principal.type | principal.id | tenant.id | project.id | repository.owner | repository.name | idempotency_key

Hash the canonical byte sequence using a versioned domain separator. The request fingerprint must additionally include all operation-affecting values, including base branch, normalized paths, content digests, title, summary, and policy-relevant options.

### Replay and recovery rules
- Re-check current authorization before returning replay data or continuing recovery.
- Store authorization decision provenance with the operation, but do not treat a historical allow decision as perpetual authority.
- Keep UNKNOWN as a first-class state; no blind retry.
- Restrict reconciliation to a distinct capability and require independent GitHub evidence.
- Do not expose cross-tenant operation existence or metadata.
- Keep service and human identities separate.
- Record actor, tenant, project, action, resource, idempotency version, request digest, lease generation, state transitions, evidence references, and final outcome in an append-only audit trail.

## 6. Architecture decision

Adopt two independent mandatory gates, not one combined permission flag:

1. Authorization gate: principal + tenant membership + project/action/resource policy.
2. Execution-safety gate: scoped idempotency + lease/fencing + UNKNOWN quarantine + reconciliation + quotas.

The first answers: "May this principal perform this action on this resource now?"
The second answers: "Can this external side effect be executed and recovered without duplication or ambiguous success?"

Both must pass before GitHub side effects. Neither substitutes for the other.

A single physical Durable Object may coordinate operations, but its logical namespace and every read/write must enforce the full scope. The current global key scheme is insufficient for the multi-tenant contract.

## 7. Gate 2J acceptance criteria

| Criterion | Required evidence | Current status |
|---|---|---|
| Candidate write-control code inspected | exact source/blob references | CONFIRMED |
| Candidate idempotency scope | principal/tenant/project included | FAIL |
| Candidate current authorization | current Tenant Directory and project policy checked | FAIL |
| Main authorization path | service principal + tenant + project policy | PRESENT IN SOURCE |
| Main durable write-control | atomic admission/UNKNOWN/reconciliation | ABSENT IN SOURCE |
| Combined request ordering | negative tests show deny before reservation and side effect | NOT_RUN |
| Cross-tenant replay isolation | adversarial tests pass | NOT_RUN |
| Revocation-before-replay | negative test passes | NOT_RUN |
| Per-tenant fairness | quotas and saturation tests pass | NOT_DEFINED |
| Human attribution | canonical human identity and distinct audit actor | NOT_IMPLEMENTED IN CANDIDATE |
| Deployed artifact provenance | exact commit/artifact attestation | UNKNOWN |
| Independent review | separate reviewer signs exact commit and evidence | NOT_RUN |

**Gate 2J verdict: BLOCKED — WRITE CONTROL AND AUTHORIZATION MUST BE COMPOSED BEFORE MULTI-TENANT RELEASE.**

## 8. Next atomic gate

Gate 2K — unified write execution contract and executable test specification:
1. Define canonical trusted execution context and exact policy decision interface.
2. Define versioned idempotency key serialization and request fingerprint.
3. Define Durable Object partitioning, global/per-tenant quotas, and retention semantics.
4. Define replay/reconciliation authorization and separate reconciler capability.
5. Specify deterministic failure injection points and golden fixtures.
6. Have an independent reviewer challenge the contract before implementation.

No code changes or deployments until the contract is reviewed and explicitly approved.

## 9. Safety and limitations

Read-only GitHub source inspection and documentation only. No test was executed. No GitHub PR was opened. No Cloudflare Worker, Durable Object, binding, secret, route, DNS record, deployment, database, or production resource was modified. Deployed staging source provenance remains UNKNOWN. Production remains NO-GO.
