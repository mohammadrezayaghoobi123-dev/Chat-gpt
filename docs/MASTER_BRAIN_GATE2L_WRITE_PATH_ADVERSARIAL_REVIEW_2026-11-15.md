# Master Brain — Gate 2L Adversarial Implementation Review: Write Path vs Gate 2K
**Date:** 2026-11-15  
**Mission:** MB-G2L-WRITE-PATH-ADVERSARIAL-REVIEW-2026-11-15-001  
**Reviewed branch:** integration/master-brain-unification-2026-11-15  
**Status:** REVIEW COMPLETE — BLOCKERS OPEN — NO IMPLEMENTATION AUTHORIZED  
**Production decision:** NO-GO

## 1. Executive verdict

Gate 2K is a useful target contract, but it is not an accurate description of the current write-path implementation. The reviewed branch contains the Worker write path, Tenant Directory, OrchestratorLedger, and related tests, but its complete Git tree contains no dedicated WriteControl implementation or operation state machine matching the Gate 2K contract.

The active create_change_pr function performs GitHub API writes directly after membership and project-policy checks. It has no durable operation reservation, operation-level idempotency, lease fencing, operation audit chain, or durable UNKNOWN/reconciliation record. The code does retain a branch when the final PR-creation request has an ambiguous outcome, but that is not equivalent to a durable recovery protocol.

The Tenant Directory also accepts wildcard resource policies for any action, including project.create_pr, while Gate 2K explicitly says wildcard write authorization must be rejected unless separately approved.

**Conclusion:** do not implement from the assumption that Gate 2K controls already exist. First reconcile the contract with observed code, decide the wildcard policy, and define a safe migration. No code or deployment change is made by this review.

## 2. Evidence inspected

All evidence below was fetched from the reviewed branch unless marked main:
- cloud-engineering-connector/worker.js — blob 8911b4fc7df279ecbea7689506e0f814b2414dff
- cloud-engineering-connector/identity/tenant-context.js — blob 2282a056d1b0436ad8e573f7c8d7873d4fe5c34b
- cloud-engineering-connector/identity/tenant-directory.js — blob 47647f84afc03c554b808060b6adce200d31e13d
- cloud-engineering-connector/identity/tenant-directory-adapter.js — blob a0efff296235b6b52ab6fcd568f1f0858744b84b
- cloud-engineering-connector/test/write-hardening.test.js — blob 9522a0aa308de8a9e4d1ae5edae86e1dcdf60496
- cloud-engineering-connector/test/tenant-authorization.test.js — blob 1a4f25130f4fc5f907cafd07e9326668802103ff
- cloud-engineering-connector/test/worker.test.js — blob 51ffdbfd8ebe798918b107ca666c12c18e6129ab
- cloud-engineering-connector/cloudflare-test/tenant-directory.test.js — blob 4e891b305ee71a01f39e08118c714fe602c7aa1a
- cloud-engineering-connector/orchestrator-ledger.js — blob ba32281b3698d40917505096d2a61501f8c0f9e4
- cloud-engineering-connector/identity/oauth-provider.js — blob a05ae52df029e3d4e6644a4c21e1470086248ec7
- cloud-engineering-connector/wrangler.toml — blob 6c81ef6761497f6e8889a1ed8aa715b70922a949
- docs/MASTER_BRAIN_GATE2K_UNIFIED_WRITE_EXECUTION_CONTRACT_DRAFT_2026-11-15.md — blob 060daa5788388cb7a8602dec605ebd886a3018bd

The complete recursive Git tree was inspected. It contains no file named or functioning as a dedicated write-control operation ledger matching the proposed Gate 2K responsibilities. OrchestratorLedger is present, but its task/outbox aggregates are distinct and are not a drop-in implementation of the proposed GitHub write-operation state machine.

## 3. Findings

### F-01 — No durable WriteControl operation state machine
**Severity:** BLOCKER

**Observed evidence**
- worker.js createChangePr performs GitHub calls directly: repository metadata, base ref, parent commit, tree POST, commit POST, branch POST, and PR POST.
- No operation reservation is written before the first external mutation.
- The reviewed Git tree has no dedicated WriteControl module or schema implementing operation admission, operation identity, per-operation leases, phase transitions, and reconciliation receipts.
- OrchestratorLedger implements orchestration tasks, execution leases, outbox events, and their tenant/project scope. Its task/outbox idempotency is not proof that createChangePr is controlled by that ledger.

**Counter-evidence / boundary**
- OrchestratorLedger does provide tenant/project-scoped idempotency and lease fencing for its own task/outbox aggregates.
- This is positive infrastructure, but no adapter or call path from createChangePr into those aggregates was found.

**Impact**
The write endpoint can create external GitHub side effects without a durable local operation record that can be queried and recovered after a timeout, worker restart, or lost response.

**Falsification test**
Instrument every external mutating GitHub request. For each request, prove that a durable operation row and audit/outbox reservation already exist, that both carry the exact full security scope and request digest, and that one operation ID maps to no more than one external logical write. Inject worker termination immediately before and after every external call.

**Disposition**
Open. Gate 2K's WriteControl remains a design contract, not an implemented control.

### F-02 — Wildcard resource policy is accepted for write authorization
**Severity:** HIGH

**Observed evidence**
- TenantDirectory.authorizeProjectAction queries policy rules with resource_digest IN (?, '*').
- Exact resource matches are preferred, but a wildcard row remains an accepted fallback.
- Gate 2K states that wildcard resource authorization is not accepted for create_change_pr until the policy owner explicitly approves it.
- No such explicit wildcard-write approval flag or policy capability is checked by the current authorization path.

**Impact**
A wildcard allow for project.create_pr authorizes resources beyond the exact resource digest requested. This is broader than the Gate 2K target policy.

**Falsification test**
Provision a wildcard allow for principal P, tenant T, project J, action project.create_pr; submit two distinct repository/resource digests. The expected result under Gate 2K is DENY for both unless an explicit reviewed wildcard-write capability is present. Verify the actual result through the Worker path and the real TenantDirectory Durable Object, not a permissive mock.

**Disposition**
Open. Choose one: prohibit wildcard rules for all write actions, or introduce a separately governed and auditable wildcard capability. Do not silently treat the existing fallback as approved.

### F-03 — No operation-level idempotency for create_change_pr
**Severity:** HIGH

**Observed evidence**
- The Worker generates a fresh random branch suffix for each call.
- No client idempotency key is part of the tool schema.
- No canonical operation key or request fingerprint is persisted.
- OrchestratorLedger's task/outbox idempotency uses a separate API and aggregate; createChangePr does not call it.

**Impact**
A client retry after a lost response can create another tree, commit, branch, and draft PR. Tenant/project scoping of task and outbox keys does not prevent duplicate GitHub PR creation in this separate path.

**Falsification test**
Submit an identical request twice with a simulated lost first response. Assert that the second request returns the original operation/PR receipt and creates zero additional GitHub mutations. Then alter one payload field while reusing the key and assert IDEMPOTENCY_CONFLICT.

**Disposition**
Open. Requires an explicit client key, versioned canonical scope, request digest, durable uniqueness, and retention policy.

### F-04 — Ambiguous failures are not durably quarantined across all mutation phases
**Severity:** HIGH

**Observed evidence**
- The final /pulls POST has a catch branch: uncertain outcome retains the branch and returns an uncertainty error; certain non-success attempts branch cleanup.
- Earlier mutations (/git/trees, /git/commits, /git/refs) are outside that recovery block.
- A timeout after branch POST can leave the branch created while the caller receives an error, with no durable operation ID or recovery record.
- No operation reconciliation command or persistent reconciliation receipt is wired into createChangePr.

**Counter-evidence**
The existing code is not completely unaware of ambiguity: it intentionally retains a branch when PR creation outcome is uncertain. Tests in worker.test.js cover this final-PR ambiguity and branch cleanup cases. These are useful local safeguards, but they do not provide durable state or cover every mutation boundary.

**Impact**
The system cannot reliably distinguish “not created”, “created but response lost”, and “partially completed” across all phases. Blind retry can duplicate effects; manual recovery lacks an authoritative operation record.

**Falsification test**
Inject a timeout after each of tree POST, commit POST, branch POST, and PR POST. After process restart, query a durable operation ID and reconcile against exact GitHub object IDs/SHAs. The expected state must remain UNKNOWN until exact evidence is verified; no new mutation may occur during an unverified replay.

**Disposition**
Open. Add phase-specific durable state and a privileged reconciliation capability before enabling retries.

### F-05 — Shared bearer does not provide human-level attribution or individual revocation
**Severity:** HIGH for a human-facing multi-user product; bounded if intentionally service-only

**Observed evidence**
- The Worker resolves a single shared bearer to service:shared-mcp-bearer.
- createChangePr explicitly requires that service principal.
- The OAuth provider module exists, but worker.js does not import or route requests through createOAuthProvider. The current write path is not using the drafted human OIDC flow.
- The PR body itself labels the requester as a shared-bearer service principal, not a human identity.

**Impact**
All callers presenting the same bearer are indistinguishable at this authorization boundary. Tenant Directory policy is evaluated for the shared service principal, not for the individual human operating the client. Individual human membership, attribution, and revocation cannot be enforced here.

**Counter-evidence / boundary**
This may be acceptable for a tightly controlled backend service credential where the human identity is authenticated and audited upstream. No such trusted upstream human-identity assertion was evidenced in this Worker path.

**Falsification test**
Two different humans using the same bearer must be distinguishable in the authenticated execution context and audit trail, and revoking one human must not revoke or retain the other's rights. If the design intentionally remains service-only, document the trust boundary and prove the bearer is never distributed to end users.

**Disposition**
Open decision. Either formally freeze a service-only v1 with a trusted upstream actor assertion, or integrate and verify human OIDC before claiming human multi-user authorization.

### F-06 — Authorization resource fingerprint omits the PR summary
**Severity:** MEDIUM

**Observed evidence**
- createChangePr builds fileResources from path, content SHA-256, and byte size.
- The resource passed to authorizeProjectAction includes repository, baseBranch, safeTitle, and fileResources.
- The PR body later includes args.summary.trim() but summary is not part of that authorization resource object.
- Gate 2K request fingerprint includes normalized summary among operation-affecting fields.

**Impact**
Two requests with identical code/title but different PR descriptions receive the same resource authorization digest. This violates the proposed exact request binding and leaves a client-controlled part of the resulting GitHub object outside the authorization fingerprint.

**Falsification test**
Hold all fields constant and vary only summary. Verify that the canonical request digest changes and that the authorization/operation record binds to the exact summary digest.

**Disposition**
Open. Include a normalized summary digest in the request fingerprint, or explicitly separate and justify a non-security-relevant metadata field in the policy contract.

### F-07 — Membership version is dropped from the trusted tenant context
**Severity:** MEDIUM

**Observed evidence**
- TenantDirectory membership records include a version.
- resolveTenantContext checks active status and identity/scope equality, but the returned frozen context includes only principalId, tenantId, membershipId, and role.
- Gate 2K expects membership ID and version in the trusted execution context.

**Impact**
The write audit/operation context cannot identify the exact membership version used for authorization. Current membership is checked at admission, but historical authorization evidence is less precise and cannot independently demonstrate which membership revision was observed.

**Falsification test**
Change membership role/status/version between two requests and verify that each authorization receipt records the exact membership version. Revocation must deny the next request.

**Disposition**
Open. Carry membership.version through the trusted context and audit envelope. This does not replace re-checking current membership.

### F-08 — No tenant/principal write quota or fairness control in this path
**Severity:** MEDIUM

**Observed evidence**
- Worker rate limiting is keyed from the client IP and uses separate authenticated/public namespaces.
- No per-tenant, per-principal, per-project, or unresolved-operation quota is checked by createChangePr.
- Gate 2K calls for tenant quotas and a global emergency ceiling.

**Impact**
IP rate limiting does not establish tenant fairness. A shared egress IP can cause noisy-neighbor throttling, while distributed client IPs can evade a per-IP limit. There is no bounded unresolved-operation backlog because no operation ledger exists.

**Falsification test**
Run two tenants under shared and distributed IPs. Saturate one tenant's write allowance and prove the other retains its independently allocated quota while the global emergency ceiling still blocks all new writes when triggered.

**Disposition**
Open. Define quota keys and values from measured load, GitHub limits, and cost ceilings; do not copy the current IP limit as a tenant quota.

### F-09 — Current Worker tests do not prove the full real-DO write authorization composition
**Severity:** MEDIUM

**Observed evidence**
- worker.test.js and write-hardening.test.js inject a Tenant Directory stub that always returns an active membership and allow decision.
- tenant-authorization.test.js tests the provider-neutral context with mocked stores.
- cloudflare-test/tenant-directory.test.js tests the real Tenant Directory Durable Object separately.
- No inspected test composes the real Worker create_change_pr path with the real TenantDirectory Durable Object and exercises exact-vs-wildcard policy, revocation, full write sequence, and crash recovery together.
- No tests were executed during this review.

**Impact**
Unit-level checks exist, but the composition boundary most relevant to the write security decision is not demonstrated by an end-to-end test artifact.

**Falsification test**
Add a Cloudflare integration test that invokes Worker.fetch with a real TenantDirectory binding and a controlled GitHub fetch stub. Cover no membership, revoked membership, exact allow, wildcard allow, policy outage, duplicate request, and failures after every GitHub mutation.

**Disposition**
Open. Test authoring and test execution must be reported separately. Current status remains NOT_RUN for this review.

## 4. Contract-to-code matrix

| Gate 2K requirement | Observed implementation | Result |
|---|---|---|
| Server-derived service principal | Shared bearer resolves to one service principal | PARTIAL; service-only boundary |
| Human OIDC principal | OAuth provider module exists but Worker does not wire it | NOT ACTIVE |
| Current Tenant membership | TenantDirectory lookup before GitHub API calls | PRESENT |
| Exact project/action/resource policy | Policy lookup is scope-bound | PARTIAL; wildcard fallback accepted |
| Membership version in context | Directory has version; context drops it | MISSING |
| Durable write admission | No createChangePr operation reservation found | MISSING |
| Principal+tenant+project+action+resource idempotency | No write-operation key in this path | MISSING |
| Request digest includes summary | Authorization resource omits summary | MISSING |
| Lease/fencing for external write | Not wired to createChangePr | MISSING |
| UNKNOWN quarantine for every phase | Only final PR ambiguity has special handling | PARTIAL |
| Independent reconciliation receipt | Not wired to createChangePr | MISSING |
| Atomic operation audit/outbox | No operation audit reservation | MISSING |
| Per-tenant quotas/fairness | IP-based rate limiting only | MISSING |
| Real-DO Worker integration evidence | Components tested separately; Worker uses test stub | NOT DEMONSTRATED |
| Test execution evidence in this review | No tests run | NOT_RUN |

## 5. Required corrective sequence

Do not combine all fixes in one large commit. The safe sequence is:

1. **K2L-A — Policy semantics decision:** decide whether wildcard write policies are prohibited or require a separately signed capability. Add negative tests first.
2. **K2L-B — Identity boundary decision:** freeze service-only v1 or approve a human OIDC integration. Never infer human identity from a shared bearer.
3. **K2L-C — Write operation model:** specify the exact bounded context, owner, durable storage, operation schema, scope key, request digest, and retention. Reuse OrchestratorLedger only if a formal aggregate-ownership review proves it is appropriate; do not merge unrelated aggregates.
4. **K2L-D — Crash-safe execution adapter:** make each external phase stateful, lease-fenced, idempotent where GitHub permits, and UNKNOWN on ambiguous outcomes.
5. **K2L-E — Atomic audit/outbox:** ensure reservation and initial audit/outbox are committed in one transaction within the owning storage boundary.
6. **K2L-F — Fairness controls:** define global emergency, tenant, principal/service, and repository limits.
7. **K2L-G — End-to-end negative and failure injection tests:** run against the actual Worker and real TenantDirectory DO, with stubbed GitHub API and captured artifacts.
8. **K2L-H — Independent re-review:** close every blocker with evidence, then consider a separate staging-only implementation PR.

## 6. Required design clarifications before implementation

- Is v1 intentionally service-only, or must individual humans authenticate?
- If service-only, where is the human actor authenticated and how is that assertion bound to the service request?
- Are wildcard rules categorically forbidden for write actions?
- Which bounded context owns the external GitHub write operation aggregate?
- Is the operation ledger a new DO or a carefully scoped extension of an existing owner?
- What exact retry behavior is allowed for GitHub tree, commit, branch, and PR operations?
- What is the approved terminal idempotency retention and unresolved-operation recovery policy?
- Who may reconcile UNKNOWN and how is that capability provisioned/revoked?
- What are the quota and emergency-ceiling values?
- What evidence-retention and backup/restore guarantees are required?

These questions are open; this review does not silently choose answers.

## 7. Gate 2L result

**REVIEW COMPLETE — BLOCKERS OPEN — CONTRACT NOT FROZEN — IMPLEMENTATION NOT AUTHORIZED — PRODUCTION NO-GO.**

This is an adversarial review by the current assistant based on fetched source and document evidence. It is not an external Claude review or a signed third-party attestation. A genuinely independent second reviewer remains desirable for Gate 2L closure.

## 8. Safety and provenance

Documentation-only change. No application source, tests, Worker configuration, Durable Object schema, secret, binding, route, DNS, database, deployment, pull request, merge, main branch, or local computer was modified.

No tests were executed. No live endpoint was probed. No runtime deployment was inspected in this gate. Test status: NOT_RUN. Production status: NO-GO.
