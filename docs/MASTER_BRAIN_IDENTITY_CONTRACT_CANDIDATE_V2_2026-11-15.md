# Master Brain — Identity Contract Candidate v2
**Date:** 2026-11-15  
**Mission:** MB-G2F-IDENTITY-CONTRACT-REVISION-2026-11-15-001  
**Repository:** mohammadrezayaghoobi123-dev/Chat-gpt  
**Target branch:** integration/master-brain-unification-2026-11-15  
**Status:** CANDIDATE FOR REVIEW — NOT FROZEN — NOT IMPLEMENTATION AUTHORIZATION  
**Supersedes:** none; preserves v1 draft as historical review input.

## 1. Purpose and boundary

This candidate revises the identity draft using Gate 2E source evidence. It defines the minimum safe cross-component identity contract while preserving bounded contexts.

It does not create one global authorization database, one universal role system, or one global aggregate. Each domain retains its authoritative records:
- Connector Tenant Directory owns tenant memberships and project policy.
- Python Mission owns Mission-specific operator/approver and ownership decisions.
- Cloud Agent retains its own service/session identity boundary until an adapter is approved.
- Hub/BrainEntry remains outside the contract until its backend is identified.

Authentication, principal identity, tenant membership, project authorization, Mission approval authority, and service identity remain distinct decisions.

## 2. Identity classes

### 2.1 Closed principal type

The contract permits exactly:
- human
- service

Any other principal_type value is invalid. No adapter may infer a principal type from an email address, user ID, token prefix alone, tenant role, or caller-provided JSON.

### 2.2 Human principal

The selected user-facing factor for the first version is verified email One-time PIN. The exact upstream provider and deployment path are not yet frozen. Cloudflare Access One-time PIN is the candidate already described in the repository, but its active Worker integration is not present in the inspected source.

Human principal fields:
- principal_type = human;
- principal_id = versioned opaque ID derived from the validated OIDC issuer and subject;
- issuer = exact configured issuer identifier;
- subject_fingerprint = same digest used by principal_id;
- email = verified profile attribute required by the selected email login policy;
- email_verified = true only when asserted by the trusted OIDC validation result.

Email is mutable profile data and is excluded from the immutable principal key. Email equality must never auto-link two identities from different issuers.

### 2.3 Service principal

Service principals are non-human and must use a trusted service registry or a dedicated, server-side service authenticator. Preserve the existing legacy principal ID service:shared-mcp-bearer as a service identity during compatibility.

The service registry must bind:
- immutable service principal ID;
- service name and owning component;
- credential/key ID, never raw secret;
- allowed tenant/project/action/resource scope;
- expiry, rotation, and revocation state;
- initiating actor/delegation metadata where a human initiated the action.

A service principal cannot be converted to a human principal, and a human principal cannot acquire a service capability by presenting a human token.

## 3. Exact human principal derivation v1

For compatibility with the current Connector source, v1 is defined byte-for-byte:

1. Obtain issuer and subject only from the output of a trusted OIDC authenticator after full token and protocol validation.
2. Do not trim, lowercase, URL-normalize, Unicode-normalize, or otherwise rewrite issuer or subject before hashing.
3. Construct the JavaScript-compatible JSON array serialization of exactly three string elements, in this order:
   - oidc:v1
   - exact issuer string
   - exact subject string
4. Encode that serialization as UTF-8.
5. Compute SHA-256.
6. Encode the digest as 64 lowercase hexadecimal characters.
7. Principal ID is oidc:v1: followed by that digest.

The existing source expression is JSON.stringify(["oidc:v1", issuer, subject]). A second implementation must reproduce the exact JSON string escaping and UTF-8 bytes, not merely serialize an equivalent conceptual tuple.

The issuer must be on an explicit allow-list and must match the validated token issuer exactly. HTTPS syntax is necessary but not sufficient. Issuer allow-list changes are configuration/security changes and must be audited.

Required golden vectors:
- exact issuer and subject input strings;
- exact serialized JSON string;
- exact UTF-8 hex bytes;
- exact SHA-256 hex;
- exact principal ID.
Include non-ASCII subject, escaped characters, trailing slash distinction, and same-subject/different-issuer cases.

Any future derivation change requires a new version prefix and a controlled mapping/migration. Never silently modify v1.

## 4. Trusted OIDC authenticator contract

The principal-construction helper is not an OIDC verifier. Its authenticator must validate, before returning claims:
- cryptographic signature using trusted issuer keys and an explicit algorithm allow-list;
- exact issuer allow-list match;
- audience and authorized-party/client binding;
- expiry, not-before, and issued-at policy;
- nonce and state correlation;
- authorization-code PKCE S256 verifier;
- exact redirect URI and callback binding;
- authorization-code single-use/replay behavior;
- key rotation and unknown key ID behavior;
- verified email claim required by the selected email OTP policy.

Only validated claims may reach resolvePrincipal. Raw callback parameters, unverified JWT payloads, headers, query values, request-body identity fields, or user-selected issuer URLs are not trusted identity inputs.

Until this adapter is wired into the active Worker and passes end-to-end negative tests, human login status remains NOT_WIRED.

## 5. Tenant membership and project authorization

### 5.1 TenantMembership

Tenant Directory remains the authoritative owner for tenant membership. Its role field is membership metadata unless a separately versioned policy explicitly consumes it. Membership role does not, by itself, grant project access or Mission authority.

Authentication does not create tenant membership. The tenant selector only identifies which membership to look up.

### 5.2 ProjectAuthorizationDecision

Every project action requires an explicit decision bound to:
- authenticated principal ID and principal type;
- verified tenant ID and membership ID;
- exact project ID;
- action identifier;
- resource digest;
- decision ID and policy version;
- effect allow or deny;
- provenance reference.

Missing membership, unavailable policy store, missing rule, denied effect, or any scope mismatch must fail closed before side effects.

### 5.3 Wildcard resource policy

The current Tenant Directory supports resourceDigest = "*" as a broad project/action rule. This is not an exact-resource authorization.

Candidate v1 policy:
- exact resource digest is the default for write, admin, approval, deployment, and destructive actions;
- wildcard allow is denied for those actions unless a separately approved privileged policy capability explicitly permits it;
- wildcard for low-risk read actions may be considered only with documented scope, actor attribution, policy version, and tests;
- the returned decision must state whether it came from exact or wildcard matching.

The wildcard policy decision remains OPEN pending the project security policy owner’s approval. Until resolved, no new wildcard write grants should be provisioned.

## 6. Mission roles remain domain-local

Python Mission operator and approver authority is not derived from Tenant Directory membership.

Current source-level authority:
- operator access is represented in Python Identity roles;
- approver eligibility is controlled by ApproverPolicy, implemented through NoApprovers, StaticApprovers, or AccountApprovers;
- AccountApprovers reads the current local AccountStore approver role;
- MissionService checks current approver eligibility during approval request/submission and when deciding whether an unused approval still counts;
- the service approval flow requires its configured verifier and uses a signed challenge/approval path.

Until an explicit adapter is approved:
- Python AccountStore and ApproverPolicy remain authoritative;
- no automatic email-based account linking;
- no automatic Tenant Directory role-to-Mission role mapping;
- no caller-supplied role may be accepted;
- no unknown mapping is treated as a successful identity match.

A future MissionRoleAssignment contract must include principal ID/type, role, scope, assigning authority, assignment version, created/expiry/revocation timestamps, and immutable audit provenance.

## 7. Provisioning actor attribution

The current Tenant Directory admin assertion uses a fixed provisioner subject. The resulting audit actor identifies the provisioner service, not the human or upstream service that initiated the change.

Candidate assertion v2 must cryptographically bind:
- actor_principal_id;
- actor_principal_type;
- executor_service_id;
- operation;
- tenant ID;
- project ID when applicable;
- target digest;
- issued-at and expiry;
- assertion ID/JTI;
- key ID and signature.

The audit record must persist both initiating actor and executing service. The executor cannot invent or overwrite the initiating actor; it must be supplied by a separately authenticated upstream context and included in the signed assertion.

Keep v1 verification for existing assertions/history during migration. Do not reinterpret historical fixed provisioner actors as human actors.

## 8. Revocation and cache policy

Until a cross-context revocation protocol is implemented and independently verified:
- Connector must check current Tenant Directory membership and project policy for each protected operation;
- Python must check its current account/session and ApproverPolicy authority for each protected Mission operation;
- Cloud Agent must check its own credential/session registry;
- adapters must fail closed when the authoritative revocation source is unavailable;
- no positive authorization decision may be cached for write, approval, admin, deployment, or destructive actions;
- no cross-system session may remain valid solely because an upstream token has not yet expired.

For v1, the safe default is no authorization-result cache. Any later cache requires an explicit maximum stale interval, invalidation/replay design, and measured risk acceptance.

A future cross-context revocation event must include event ID, schema version, principal ID/type, authority scope, state version, effective time, correlation/causation IDs, and provenance. Consumers must be idempotent and reconcile missed events against the authoritative store.

## 9. Service-to-service and OAuth scopes

The active Connector currently uses the shared service bearer and Tenant Directory project policy. The isolated OAuth provider is not wired into the Worker and its /authorize handler is unavailable.

When OAuth is activated:
- scopes must be explicitly mapped to tool capabilities;
- mcp:read must never authorize create_change_pr;
- OAuth scopes do not replace Tenant Directory membership/project policy;
- service bearer and human OAuth grant remain separate authentication paths;
- token refresh, revocation, audience, resource binding, and principal attribution must be tested end to end.

Until then, OAuth scope mapping status is NOT_IMPLEMENTED.

## 10. Cross-context adapter status

| Adapter | Contract status | Current disposition |
|---|---|---|
| Access/OIDC → Connector | candidate schema defined; trusted callback absent | BLOCKED / NOT_WIRED |
| Connector → Tenant Directory | service path exists | preserve; strengthen audit attribution and policy semantics |
| Connector → Python Mission | no canonical subject/role bridge | BLOCKED |
| Connector → Cloud Agent | no identity federation contract | BLOCKED |
| Hub → Brain backend | backend owner/runtime unknown | BLOCKED / UNKNOWN |
| Service-to-service | legacy shared bearer exists | preserve as non-human service principal; scope explicitly |

No adapter may use a client-supplied user_id, email, tenant ID, project ID, or role as proof of identity or permission.

## 11. Golden fixtures and acceptance tests

Before any adapter implementation:
1. Same issuer + subject, changed email → same principal ID.
2. Same subject, different issuer → different principal ID.
3. Exact byte-for-byte v1 serialization and digest vector.
4. Issuer not on allow-list → reject.
5. Invalid signature, audience, expiry, nonce, state, PKCE, redirect URI, or replay → reject before grant creation.
6. Arbitrary principal type → reject.
7. Service principal on human-only operation → reject.
8. Human principal on service-only operation → reject.
9. Tenant role change without explicit project policy → no implicit project grant.
10. Wildcard write allow → deny unless separately approved capability exists.
11. Provisioning assertion v2 preserves distinct initiating actor and executor.
12. Duplicate/concurrent assertion replay → no duplicate mutation and explicit replay outcome.
13. Revoked membership with otherwise-valid token → next protected operation denied.
14. Removed Mission approver duty → unused approval cannot authorize dispatch.
15. Read-only OAuth scope attempting create_change_pr → denied before GitHub API call.
16. Missing Hub backend identity mapping → fail closed.
17. Unknown schema version → reject without partial write.
18. Cross-context mapping absent or ambiguous → UNKNOWN/deny, never inferred.

All test states remain NOT_RUN until commands are executed in a recorded environment. Authored tests, mocked adapters, source inspection, and live integration tests must be reported separately.

## 12. Open decisions requiring explicit approval

| Decision | Candidate recommendation | Status |
|---|---|---|
| Human login factor | verified email One-time PIN only | user preference previously stated; provider implementation not approved |
| Upstream identity provider | Cloudflare Access OIDC candidate | OPEN |
| Exact issuer and audience | pinned deployment-specific values | OPEN; do not hardcode until deployment design approved |
| Wildcard policy | deny wildcard writes by default | OPEN |
| Provisioning actor model | separate initiating actor + executor service in assertion v2 | RECOMMENDED |
| Mission role bridge | keep domain-local until separate review | RECOMMENDED |
| Authorization cache | none for v1 | RECOMMENDED |
| Hub backend | identify repository/runtime before adapter design | BLOCKED |
| OAuth activation | only after real Access/OIDC callback and Worker wiring | BLOCKED |

## 13. Gate 2F status

| Criterion | Status |
|---|---|
| Exact principal derivation clarified from current source | DRAFTED |
| OIDC validation boundary clarified | DRAFTED |
| Human/service principal distinction closed | DRAFTED |
| Tenant membership and project policy separated | DRAFTED |
| Wildcard behavior documented | DRAFTED; decision OPEN |
| Provisioning actor attribution corrected in candidate schema | DRAFTED |
| Mission role authority kept domain-local | DRAFTED |
| Revocation/cache policy specified | DRAFTED |
| Hub backend resolved | UNKNOWN |
| OAuth login flow implemented | NO |
| Golden fixtures authored/executed | NOT_RUN |
| Independent review | NOT_RUN |
| User approval | PENDING |
| Contract frozen | NO |
| Implementation authorized | NO |

**Gate 2F produces a revised candidate, not a frozen identity contract.** The remaining decisions are explicit and must not be silently assumed.

## 14. Safety

Documentation-only revision. No source code, tests, identity settings, OAuth KV, Cloudflare Access application, secrets, deployment, PR, main branch, or production resource was modified. Production remains NO-GO.
