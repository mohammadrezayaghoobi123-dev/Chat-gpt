# Master Brain — Gate 2E Adversarial Identity and Trust-Boundary Review
**Date:** 2026-11-15  
**Mission:** MB-G2E-ADVERSARIAL-IDENTITY-REVIEW-2026-11-15-001  
**Repository:** mohammadrezayaghoobi123-dev/Chat-gpt  
**Target branch:** integration/master-brain-unification-2026-11-15  
**Review mode:** Read-only source inspection and adversarial contract review  
**Decision:** ARCHITECTURE_REVISION_REQUIRED — IDENTITY CONTRACT NOT FROZEN  
**Execution status:** Source inspected; tests not executed in this review.

## 1. Executive decision

The current architecture has useful, separately implemented security controls:
- Connector service-bearer authentication;
- tenant membership and project policy enforcement;
- signed, version-bound Mission approvals;
- Python local account/session revocation;
- fail-closed behavior when required authorization dependencies are unavailable.

However, the human identity path is not end-to-end implemented. The active Connector Worker authenticates only the shared service bearer. The OAuth provider module is isolated and its authorization handler deliberately returns HTTP 503. The proposed email One-time PIN login therefore remains a design proposal, not a live login capability.

The identity draft also contains unresolved contract ambiguities and trust-boundary gaps. No implementation or migration should begin from the current draft.

## 2. Evidence snapshot

All references below are immutable Git blob SHA-1 values inspected during this review.

### 2.1 Current branch draft

| File | Blob SHA-1 |
|---|---|
| docs/MASTER_BRAIN_IDENTITY_CONTRACT_DRAFT_2026-11-15.md | 2d664e58e1cddc457ecfc135c8516f0545cb1797 |

### 2.2 Connector source — main

| File | Blob SHA-1 | Inspected responsibility |
|---|---|---|
| cloud-engineering-connector/identity/tenant-context.js | 2282a056d1b0436ad8e573f7c8d7873d4fe5c34b | principal derivation, membership resolution, project authorization |
| cloud-engineering-connector/identity/tenant-directory.js | 47647f84afc03c554b808060b6adce200d31e13d | membership, project policy, provisioning audit |
| cloud-engineering-connector/identity/tenant-directory-assertion.js | a97a1504b6bed1d1a6fbc1548d5ba0462ee1bc3f | signed tenant-scoped provisioning assertions |
| cloud-engineering-connector/identity/tenant-directory-adapter.js | a0efff296235b6b52ab6fcd568f1f0858744b84b | tenant-scoped Durable Object adapters |
| cloud-engineering-connector/identity/oauth-provider.js | a05ae52df029e3d4e6644a4c21e1470086248ec7 | OAuth provider wrapper and unavailable authorization handler |
| cloud-engineering-connector/worker.js | 8911b4fc7df279ecbea7689506e0f814b2414dff | active MCP authentication and tool dispatch |
| cloud-engineering-connector/test/tenant-authorization.test.js | 1a4f25130f4fc5f907cafd07e9326668802103ff | principal, membership, policy, resource-fingerprint tests |
| cloud-engineering-connector/test/oauth-provider.test.js | f13e5f0da3fe748633762825d788a365a27b7528 | OAuth metadata and invalid bearer tests |
| cloud-engineering-connector/test/worker.test.js | 51ffdbfd8ebe798918b107ca666c12c18e6129ab | Worker service bearer, public read-only and mocked policy tests |
| cloud-engineering-connector/index.js | 1a8a3f50cc4bbd2d1522311f48d21a36bf5adc33 | Worker and Durable Object exports |
| cloud-engineering-connector/wrangler.toml | 6c81ef6761497f6e8889a1ed8aa715b70922a949 | OAuth KV and Durable Object binding declarations |

### 2.3 Python Mission source — master-brain/integrated

| File | Blob SHA-1 | Inspected responsibility |
|---|---|---|
| src/master_brain/identity.py | d5abaa87beae5a4a72052caafacb482bf33e9314 | Identity subject and role model; static bearer authenticator |
| src/master_brain/accounts.py | f5afe8b91ab0da754803cb8e8c0818b87f9fee5f | local account/session lifecycle and current roles |
| src/master_brain/approvers.py | 3736b681e193bdc57fa4f735d4eeb373c99917c3 | NoApprovers, StaticApprovers, AccountApprovers |
| src/master_brain/mission_service.py | 0bfc5ef134dba6384175104cd231a7b74dd95ead | approval challenge/submission, approver checks, reconciliation |
| src/master_brain/mission_approval.py | b4c19544e21044a438e98aa1bfcdcc1afb857524 | version-bound approval receipt and signature gate |
| tests/test_mission_approval.py | 107186aa9c52554d3aca6c2e5ffc57e133453030 | Mission approval test suite |
| tests/test_accounts.py | 9a2899de03921273835b1346baff5ea3790aad71 | account/session test suite |

## 3. Adversarial findings

### F-01 — Interactive human OAuth is not wired
**Severity:** BLOCKER / P0 for any claim of live human sign-in.

Evidence:
- oauth-provider.js uses an unavailable authorization handler. Requests to /authorize receive HTTP 503 with the message that interactive sign-in is not configured.
- worker.js does not construct or call createOAuthProvider. The active MCP path validates MCP_AUTH_TOKEN and creates service:shared-mcp-bearer.
- index.js exports the Worker and Durable Object classes but does not wrap the Worker with the OAuth provider.
- OAUTH_KV is declared in wrangler.toml and checked by the isolated OAuth wrapper, but the active Worker path does not consume it.
- oauth-provider.test.js verifies metadata, S256 advertisement, protected-resource metadata, invalid bearer rejection, and missing-storage behavior. It does not prove an interactive OIDC callback, email OTP, consent, token issuance, refresh rotation, or revocation end to end.

Adversarial conclusion:
The active product has a shared service-bearer path, not a verified human email-OTP login. Metadata advertising authorization_code and PKCE is not proof that the authorization flow is implemented.

Required correction:
Keep human sign-in status NOT_WIRED. Before activation, implement and independently verify the full Access/OIDC authorization path, exact issuer/audience validation, state/nonce/PKCE binding, callback replay rejection, grant persistence, refresh rotation, and revocation. Then wire the provider into the actual Worker entry point and prove it with runtime integration tests. Do not weaken the existing fail-closed service-bearer path during this work.

### F-02 — Principal hash contract is underspecified
**Severity:** BLOCKER / P1 before cross-language identity adapters.

Evidence:
- tenant-context.js derives the OIDC principal using UTF-8 bytes of the exact JavaScript expression JSON.stringify(["oidc:v1", issuer, subject]), then SHA-256.
- The identity draft describes a canonical JSON tuple but does not state the exact byte representation, string escaping rules, Unicode handling, issuer normalization, or whether URL normalization is permitted.
- The existing implementation preserves the exact issuer and subject strings; it does not normalize them before hashing.

Adversarial conclusion:
A second implementation in Python, another Worker, or a mobile client could compute a different principal ID for the same claims if it uses a different serializer or normalizes issuer/subject.

Required correction:
For compatibility with the existing source, specify the exact UTF-8 byte sequence of JSON.stringify(["oidc:v1", issuer, subject]) as the v1 digest input, including array order and no pre-hash normalization. Publish golden vectors with exact issuer, subject, serialized bytes, digest, and expected principal ID. If a new canonicalization is desired, use a new version identifier and an explicit migration; never silently change v1.

### F-03 — OIDC trust validation is delegated but no concrete trusted adapter exists
**Severity:** BLOCKER / P1 for human identity.

Evidence:
- resolvePrincipal trusts the server-side authenticator's returned object when authenticated === true.
- Its OIDC branch checks non-empty issuer/subject, basic email syntax, emailVerified === true, and that issuer is HTTPS without credentials/query/fragment.
- resolvePrincipal itself does not validate an OIDC signature, allowed issuer, audience, nonce, state, PKCE, expiry, not-before, algorithm policy, or replay.
- No concrete OIDC authenticator/callback is wired into the active Worker.

Adversarial conclusion:
This is acceptable only as a narrow principal-construction function behind a separately verified authenticator. It is unsafe to interpret its local checks as full OIDC validation.

Required correction:
Specify the trusted authenticator interface and require it to return claims only after cryptographic and protocol validation against a pinned issuer and audience. Caller-supplied claims, headers, or request-body fields must never enter this path. Add negative tests for signature, issuer, audience, expiry/not-before, nonce, state, PKCE, callback replay, and key rotation.

### F-04 — Non-OIDC principal type is not a closed set
**Severity:** P1.

Evidence:
- The non-OIDC branch of resolvePrincipal accepts any non-empty principalId and any non-empty type from the trusted authenticator.
- The active Worker separately checks the exact pair id === service:shared-mcp-bearer and type === service before create_change_pr.

Adversarial conclusion:
The central identity helper does not enforce the contract's intended closed distinction between human and service principals. The Worker-specific check protects this one write operation but does not define a reusable type system for future adapters.

Required correction:
Freeze a closed principal_type enum (human, service) and separate constructors/authenticator interfaces. Service identities must be provisioned from a trusted registry with explicit component ownership and scope. Reject arbitrary type strings and never infer a human principal from a service credential.

### F-05 — Tenant Directory provisioning audit collapses actor attribution
**Severity:** P1 for auditability and privileged administration.

Evidence:
- tenant-directory-assertion.js fixes the assertion subject to tenant-directory-provisioner.
- tenant-directory.js verifies that fixed subject and records verified.subject as the audit event actor_id.
- The assertion claims bind operation, tenant, optional project, target digest, time window, key ID, and JTI, but do not contain a distinct initiating human/service principal.

Adversarial conclusion:
The audit log can prove that the provisioner service authorized a tenant-scoped mutation, but cannot distinguish which human or upstream service initiated it. A single service actor string is not sufficient attribution for high-impact membership and project-policy changes.

Required correction:
In a new assertion schema version, bind both:
- actor_principal_id and actor_principal_type for the initiating authenticated actor;
- executor_service_id for the provisioner performing the mutation.
The signed assertion must cover both fields, tenant/project, operation, target digest, and expiry. Audit events must preserve both identities. Keep v1 verification for historical records during a controlled compatibility period.

### F-06 — Tenant membership role is not currently a project permission
**Severity:** P1 contract ambiguity.

Evidence:
- TenantDirectory stores and returns a membership role.
- authorizeProjectAction checks active membership and then an exact principal/tenant/project/action/resource policy rule. It does not inspect membership.role when granting project access.
- The active Connector tool uses action project.create_pr and requires a project policy allow.

Adversarial conclusion:
The role field is currently membership metadata. It must not be interpreted as a project permission or mapped automatically to Python operator/approver authority.

Required correction:
State explicitly that membership role has no authorization effect unless a separately versioned role-to-policy evaluator is added. Project access continues to require an explicit policy decision bound to principal, tenant, project, action, and resource.

### F-07 — Wildcard resource policy weakens exact-resource semantics
**Severity:** P1 for write/high-risk policy design.

Evidence:
- TenantDirectory.upsertProjectPolicy accepts resourceDigest === "*".
- authorizeProjectAction may match either the exact resource digest or "*".
- The decision returned to the caller is bound to the requested resource digest, even when the underlying rule is a wildcard.

Adversarial conclusion:
The current policy engine supports project/action-wide rules, not only exact-resource rules. The identity draft currently describes exact resource binding without documenting the wildcard exception. A wildcard allow for a write action can authorize multiple resources within the project.

Required correction:
Document wildcard as an explicit broad grant, never as an exact-resource match. Default to disallow wildcard allows for write, administrative, approval, deployment, or destructive actions. If retained for low-risk reads, require a separate policy capability, explicit approval, provenance, and negative tests proving its exact scope.

### F-08 — Mission approver authority is a separate Python policy, not Tenant Directory role
**Severity:** P1 for cross-context integration.

Evidence:
- Python provides NoApprovers (fail-closed), StaticApprovers (operator-supplied allow-list), and AccountApprovers (reads the live approver role from AccountStore).
- MissionService checks the current ApproverPolicy when requesting/submitting approvals and again when determining whether recorded approvals still count.
- The approval service requires a configured verifier for its challenge/submission path; the approval module itself documents that recording an approval does not authenticate the approver.
- Python Identity operator/approver roles and the ApproverPolicy are domain-local. No Connector OIDC-to-Python subject/role adapter is defined.

Adversarial conclusion:
Do not infer Mission approval authority from Tenant Directory membership or a project role. Do not assume the Python AccountStore subject and OIDC principal are already the same identity.

Required correction:
Define a trusted, auditable role-provisioning contract for Mission operator and approver duties. The mapping must bind canonical principal ID, assignment scope, assigning authority, version, expiry/revocation, and audit evidence. Keep the current Python policy as the authority until an approved adapter is implemented and verified.

### F-09 — Revocation is locally enforced, not globally propagated
**Severity:** P1 before federated sessions.

Evidence:
- TenantDirectory authorization queries current active membership and current project policy.
- Python session authentication re-reads account roles and disabled status; AccountApprovers reads current account roles.
- StaticApprovers and StaticTokenAuthenticator are configuration-based and do not provide a shared dynamic revocation registry.
- Cloud Agent has a separate token/session registry.
- No cross-system revocation contract or event consumer was identified in the reviewed source.

Adversarial conclusion:
A token can remain valid at one component after another component revokes a membership or role unless the receiving component checks its own authority or a bounded revocation mechanism.

Required correction:
Until a shared revocation protocol exists, every protected adapter must consult its authoritative local membership/role/session state at operation time, or use an explicitly bounded cache with a maximum stale-authorization interval. Cross-context revocation events require versioning, idempotency, delivery/replay handling, and reconciliation.

### F-10 — Tenant admin assertion JTI is not a consumed one-time nonce
**Severity:** P2; privileged replay hardening.

Evidence:
- The signed assertion includes a random JTI and has a maximum lifetime of 60 seconds.
- verifyTenantDirectoryAdminAssertion validates JTI syntax, signature, scope, and time window, but no persistent JTI-consumption registry was identified in the verifier.
- Membership/policy writes use optimistic expectedVersion checks, which mitigate duplicate mutations but are not equivalent to explicit one-time assertion consumption.

Adversarial conclusion:
The JTI is an identifier, not demonstrated replay prevention. State-version checks reduce repeated effects but do not prove that every assertion can be consumed only once.

Required correction:
Either implement atomic JTI consumption at the authoritative Durable Object boundary or explicitly document the assertion as short-lived/replay-constrained by expectedVersion rather than one-time. Test duplicate, concurrent, and delayed replay attempts.

### F-11 — OAuth scopes and tool authorization are not yet one coherent policy
**Severity:** P2.

Evidence:
- oauth-provider.js defines REQUIRED_SCOPES as mcp:read; it also declares a SUPPORTED_SCOPES constant including mcp:write and offline_access, but the constant is not used in the provider construction.
- Resource metadata and tests advertise mcp:read.
- Active Worker write access is guarded by the shared service bearer plus Tenant Directory policy, not by an OAuth grant.

Adversarial conclusion:
Do not imply that OAuth write scopes currently govern MCP write operations. There are two separate authorization paths in source: a dormant OAuth wrapper and an active shared service-bearer path.

Required correction:
When OAuth is activated, define a mapping from validated OAuth scopes to tool-level capabilities, while retaining Tenant Directory project policy as a separate mandatory check. A read-only scope must never authorize create_change_pr.

## 4. Positive controls confirmed in source

The adversarial review also records controls that should be preserved:

1. resolveTenantContext accepts only principals created by the module's private WeakSet; a caller-constructed object claiming authenticated=true is rejected.
2. authorizeProjectAction requires a verified tenant context and validates that the returned policy decision matches principal, tenant, project, action, and resource digest.
3. TenantDirectory checks active membership again when evaluating a project policy, reducing stale-membership exposure between context resolution and authorization.
4. The active Worker requires the exact shared service principal for create_change_pr and resolves tenant membership and project policy before the first GitHub API request.
5. Public read-only mode has an explicit tool allow-list and does not expose create_change_pr.
6. Python approval flow uses a challenge and signature verification before recording the approval; the current approver policy is checked again when evaluating whether an approval still counts.
7. Python account-backed sessions re-read current account roles and disabled state, so role removal/disablement affects an existing session on the next authentication.
8. Required membership/policy dependency failures are rejected rather than silently converted to allow.

These are source-level findings; they are not claims that the tests were executed during this review.

## 5. Corrected identity contract decisions required

Before implementation, the identity draft must be revised to state:

1. Human principal derivation: exact v1 bytes are UTF-8 encoding of JSON.stringify(["oidc:v1", issuer, subject]); SHA-256 output is lowercase hexadecimal and ID prefix is oidc:v1:. No implicit normalization.
2. Issuer trust: only a configured, pinned OIDC issuer is accepted by a concrete cryptographic authenticator; HTTPS syntax alone is insufficient.
3. Principal types: closed human/service values; service identity is registry-backed and non-human.
4. Human email: if the chosen Access OTP policy requires a verified email, email is mandatory at authentication time, but remains mutable and excluded from the principal key. Do not describe it as optional in the login validation path.
5. Membership role: informational unless a separately specified role policy says otherwise.
6. Project policy wildcard: explicit broad grant with restricted usage; not equivalent to exact resource binding.
7. Provisioning audit: initiating actor and executing service must both be recorded and cryptographically bound.
8. Mission roles: remain under Python ApproverPolicy/Identity authority until an explicit cross-context assignment adapter is approved.
9. Revocation: local authority checks remain mandatory until an end-to-end revocation contract is implemented.
10. OAuth scope: define exact scope-to-tool capability mapping only when the OAuth provider is wired into the active Worker.
11. Hub backend: remain blocked/UNKNOWN until its actual API owner, server, persistence, identity, and tenant scope are inspected.

## 6. Required golden tests — not yet authored/executed as a complete suite

| ID | Adversarial case | Expected result |
|---|---|---|
| ID-G01 | Same issuer + subject, changed email | same principal ID |
| ID-G02 | Same subject/email, different issuer | different principal ID |
| ID-G03 | Exact serialized v1 input bytes | exact fixed digest vector |
| ID-G04 | Issuer not in configured allow-list | reject before principal creation |
| ID-G05 | Invalid signature/audience/expiry/nonce/state/PKCE | reject before grant creation |
| ID-G06 | OAuth /authorize without configured upstream flow | explicit unavailable; no token/grant |
| ID-G07 | Arbitrary non-OIDC principal type | reject |
| ID-G08 | Service principal used as human | reject |
| ID-G09 | Human principal used for service-only capability | reject |
| ID-G10 | Membership role changed without project policy | no implicit project grant |
| ID-G11 | Wildcard allow for write action | reject by policy or require explicit privileged capability |
| ID-G12 | Tenant Directory assertion replay, including concurrent replay | at most one accepted mutation; durable replay evidence |
| ID-G13 | Two different provisioning actors use the same service | audit preserves both distinct initiating actor IDs |
| ID-G14 | Tenant membership revoked while token remains valid | next protected request denied |
| ID-G15 | Mission approver assignment removed after challenge/approval | approval no longer counts before dispatch |
| ID-G16 | Cross-context role or principal mapping missing | fail closed; no inferred mapping |
| ID-G17 | OAuth read-only scope attempts create_change_pr | denied before GitHub API call |
| ID-G18 | Hub user_id supplied by caller without authenticated backend identity | no ownership or authorization grant |

For every test, record expected and actual result, source SHA, command, runtime, output artifact, and independent reviewer. All remain NOT_RUN until actually executed.

## 7. Gate 2E status

| Criterion | Status |
|---|---|
| Current identity and authorization source paths inspected | SOURCE_INSPECTED |
| Human OIDC flow proven active | NO — NOT_WIRED |
| Principal derivation contract byte-exact | NO — REVISION_REQUIRED |
| OIDC cryptographic validation adapter identified and wired | NO |
| Principal type model closed | NO |
| Tenant membership and project policy fail-closed controls | SOURCE_CONFIRMED |
| Wildcard policy semantics accepted | NO — DECISION_REQUIRED |
| Provisioning actor attribution complete | NO — REVISION_REQUIRED |
| Mission role federation defined | NO |
| Cross-system revocation contract | NO |
| JTI one-time replay protection proven | NO |
| Complete golden fixture suite | NOT_AUTHORED |
| Runtime tests executed during this review | NOT_RUN |
| Independent second reviewer | NOT_RUN |
| Identity contract freeze | NO |
| Implementation authorized | NO |

**Gate 2E verdict: ARCHITECTURE_REVISION_REQUIRED.** This is not a production approval and not a test pass.

## 8. Next atomic gate

Gate 2F — revise the identity contract and freeze only the minimum safe v1 boundary.

Scope:
1. Correct the exact principal digest algorithm and golden-vector requirements.
2. Specify the trusted OIDC authenticator contract and pinned issuer/audience.
3. Close the principal type enum.
4. Define provisioning actor attribution.
5. Clarify membership role versus project policy and wildcard semantics.
6. Keep Mission role authority domain-local pending an explicit adapter.
7. Define local-first revocation and the maximum allowed stale cache interval.
8. Leave Hub backend and OAuth activation blocked until their prerequisites are evidenced.

Deliverables: a revised contract draft, a decision log, and a list of unresolved user decisions. No implementation code, migration, PR, deployment, secret, or production change is authorized by this gate.

## 9. Safety and branch integrity

Documentation-only review. No code, test suite, identity-provider setting, OAuth KV, Cloudflare Access application, secret, deployment, PR, main branch, or production resource was modified. No test was run. Production remains NO-GO.
