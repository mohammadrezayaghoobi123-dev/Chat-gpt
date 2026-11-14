# Master Brain — Identity Contract and Adapter Specification (Draft)
**Date:** 2026-11-15  
**Mission:** MB-G2D-IDENTITY-CONTRACT-DRAFT-2026-11-15-001  
**Workspace:** mohammadrezayaghoobi123-dev/Chat-gpt  
**Target branch:** integration/master-brain-unification-2026-11-15  
**Status:** DRAFT FOR ARCHITECTURE REVIEW — NOT IMPLEMENTATION AUTHORIZATION  
**Scope:** Contract design only; no code, secrets, identity-provider configuration, or deployment changes.

## 1. Objective

Define one interoperable identity contract across Master Brain components without creating one global authorization system or collapsing bounded contexts.

The contract must preserve these distinctions:
- Human principal versus service principal.
- Authentication versus tenant membership.
- Tenant membership versus project/action authorization.
- Mission operator/approver roles versus tenant membership roles.
- Identity profile attributes versus immutable principal identity.
- Authentication/session revocation versus authorization revocation.

## 2. Proposed canonical principal

### 2.1 Human principal

The proposed human sign-in method for v1 is verified email through Cloudflare Access One-time PIN, followed by OAuth authorization-code flow with PKCE S256. SMS, password login, social login, and personal API keys remain out of scope for this proposed v1 design.

The canonical principal is derived only from a validated upstream OIDC issuer and subject:

- Principal type: human.
- Principal ID: versioned opaque value, oidc:v1:<sha256>.
- Digest input: canonical JSON tuple containing the version marker, exact issuer, and exact subject; use the same canonicalization in every adapter.
- Email: verified profile attribute, mutable and not part of the principal key.
- Email verification: accepted only from the trusted OIDC validation result, never from a caller-supplied body/query/header.
- No automatic identity linking across issuers based only on matching email strings.

This follows the existing source-level OIDC principal derivation in tenant-context.js. The exact canonicalization and prefix must be frozen in a golden fixture before any second implementation is written.

### 2.2 Service principal

A service principal is a non-human actor and must never be converted to a human principal.

The existing Connector identity service:shared-mcp-bearer is a legacy service identity. Preserve its type and scope during any transition. Do not reassign its identifier to a human account.

For new service identities, the registry must provide:
- immutable service principal ID;
- service name and owning component;
- credential/key ID, not raw credential;
- allowed tenant/project/action scope;
- credential expiry and rotation state;
- revocation status;
- audit actor attribution.

No new service-ID string format is frozen by this draft. It requires a separate compatibility review so existing worker assertions and receipts are not invalidated.

## 3. Proposed contract schemas

The following are logical contract shapes, not deployed JSON schemas. Exact field validation, optionality, canonical serialization, and version numbers must be frozen through golden fixtures.

### 3.1 PrincipalRef v1

| Field | Meaning | Rule |
|---|---|---|
| schema_version | Principal schema version | required, exact supported version |
| principal_id | Stable opaque identifier | required; server-derived |
| principal_type | human or service | required |
| issuer | Trusted issuer identifier | required for OIDC human; not caller-selected |
| subject_fingerprint | Versioned digest of validated issuer + subject | required for OIDC human; never raw token |
| email | Verified email profile attribute | optional/mutable; never identity key |
| email_verified | Verification state from trusted OIDC validation | true only when verified by trusted provider |
| created_at / updated_at | Registry timestamps | server-generated |

Do not place raw passwords, bearer tokens, OAuth codes, OTPs, session cookies, private keys, or raw OIDC tokens in this object or audit payloads.

### 3.2 TenantMembership v1

| Field | Meaning | Rule |
|---|---|---|
| tenant_id | Tenant scope | selected by caller only as a selector; verified by store |
| principal_id | Canonical human/service principal | must match authenticated principal |
| membership_id | Stable membership record ID | immutable after creation |
| role | Tenant membership role | assigned by trusted provisioning |
| status | active, suspended, revoked | server-authoritative |
| version | Optimistic concurrency version | increment on mutation |
| created_at / updated_at / revoked_at | Lifecycle timestamps | server-generated |
| provenance_ref | Provisioning decision/assertion reference | required for auditable mutations |

Tenant Directory remains the candidate authoritative owner for memberships. Successful email authentication never creates membership automatically.

### 3.3 ProjectAuthorizationDecision v1

| Field | Meaning | Rule |
|---|---|---|
| decision_id | Unique policy decision | server-generated |
| principal_id | Authenticated principal | exact match |
| tenant_id | Verified tenant | exact match |
| project_id | Selected project | exact match |
| action | Requested operation | explicit allow-list |
| resource_digest | Digest of the exact resource/action context | canonicalized |
| effect | allow or deny | only policy authority may decide |
| policy_version | Policy revision | required |
| evaluated_at | Decision time | server-generated |
| provenance_ref | Policy rule/decision evidence | required |

A caller-supplied project or tenant identifier selects the resource to check; it does not grant access. Missing membership, policy denial, unavailable policy store, or scope mismatch must fail closed before side effects.

### 3.4 MissionRoleAssignment v1

Mission roles are a separate bounded-context authorization model:
- operator: narrow cross-owner audit/result access and reconciliation duties;
- approver: permission to approve a Mission when designated by the Mission approval policy.

Do not automatically translate a Tenant Directory role into Python operator or approver. A trusted role-assignment policy must define issuer, approver, target principal, scope, version, expiry/revocation, and audit event. Until such policy exists, the Python role assignment remains domain-local.

## 4. Component adapter contracts

| Adapter | Input identity | Output / mapping | Required checks | Current status |
|---|---|---|---|---|
| Access OIDC → Connector OAuth | validated issuer, subject, verified email | PrincipalRef human | signature, issuer, audience, expiry, issued-at, nonce, PKCE, redirect, state, replay | OIDC callback not wired |
| Connector → Tenant Directory | authenticated PrincipalRef | verified TenantMembership and ProjectAuthorizationDecision | membership active, tenant match, exact project/action/resource, default deny | service-principal path exists |
| Connector → Python Mission | authenticated PrincipalRef | Python Identity.subject = canonical principal_id | roles from trusted Mission role assignment; never from client/email; ownership checks | NOT_DEFINED |
| Connector → Cloud Agent | human or service PrincipalRef | explicit scoped session principal | session bound to principal and credential; no implicit identity translation | NOT_DEFINED |
| Hub → Brain API backend | backend-authenticated PrincipalRef | BrainEntry ownership scope | backend owner, auth, tenant scope, retention, and API contract first | BLOCKED: backend UNKNOWN |
| Service-to-service | service PrincipalRef | bounded service capability | explicit allow-list, tenant/project/action scope, rotation and revocation | partially implemented per component |

The Hub adapter must not treat BrainEntry.source.user_id as proof of identity. The Brain API backend must be located and inspected before this adapter can be specified beyond a placeholder.

## 5. Authorization decision order

Every protected operation must follow this order:

1. Validate credential through a trusted server-side authenticator.
2. Resolve canonical principal and principal type.
3. Validate token audience/resource and token lifecycle.
4. Resolve active tenant membership, if the operation is tenant-scoped.
5. Resolve project/action/resource policy.
6. Apply domain-specific role/policy, such as Mission ownership, operator, or approver.
7. Validate idempotency and replay constraints.
8. Persist required audit/provenance before acknowledging durable acceptance.
9. Execute the bounded action.
10. Record outcome, including UNKNOWN where external effect cannot be established.

No step may be skipped because an upstream identity provider authenticated the user. OAuth scopes are not a substitute for Tenant Directory policy. Tenant membership is not a substitute for project authorization. A Mission approver is not automatically a project administrator.

## 6. Revocation and lifecycle contract

| Revocation event | Immediate expected effect | Required evidence |
|---|---|---|
| OAuth grant/token revoked | subsequent MCP resource requests rejected | provider revocation result and negative request |
| Access identity disabled or credential rotated | new authentication denied; affected grants/sessions invalidated per provider policy | identity-provider event and post-revocation negative test |
| Tenant membership suspended/revoked | tenant-scoped requests denied even if OAuth token remains valid | Tenant Directory version/status and negative request |
| Project policy changed to deny | exact project/action request denied | policy version and decision ID |
| Python operator/approver role removed | role-dependent Mission operations denied on next authorization check | role-change security event and negative request |
| Cloud Agent user registry entry revoked | new requests rejected; existing session inaccessible | registry revision and session negative test |
| Service credential rotated/revoked | old credential rejected; service identity remains non-human | key ID, rotation record, and old-key negative test |

A shared cross-system revocation event is not yet implemented. Until it is designed and tested, each component must check its authoritative local revocation source on every protected operation or use a bounded, explicitly documented cache lifetime.

## 7. Cross-context event envelope proposal

A future integration envelope should contain:
- event_id and event_type;
- schema_version;
- aggregate_type and aggregate_id;
- principal_ref (principal_id and principal_type; no raw credential);
- tenant_id and project_id where applicable;
- correlation_id and causation_id;
- idempotency_scope and idempotency_key;
- occurred_at and recorded_at with explicit UTC semantics;
- source_component and source_version;
- payload_digest and evidence/provenance references;
- data_classification and retention_class.

This envelope is a transport record. It does not become a global aggregate or global event store. Domain-local stores remain authoritative for their own aggregates.

## 8. Golden fixture set required before implementation

The following fixtures must be authored and independently reviewed:

1. Valid OIDC human: stable principal from issuer + subject.
2. Same issuer + subject with changed verified email: same principal ID.
3. Different issuer with same subject/email: different principal ID.
4. Different subject with same email: different principal ID.
5. Missing/unverified email where email is required by policy: reject.
6. Invalid signature, issuer, audience, nonce, expiry, PKCE, or callback replay: reject before grant creation.
7. Service principal presented to a human-only operation: reject.
8. Human principal presented with a service-only capability: reject.
9. Caller-supplied principal/email/tenant/project/role fields conflict with authenticated context: ignore or reject; never trust them.
10. Missing/inactive/mismatched tenant membership: deny before downstream call.
11. Project policy deny/unavailable/scope mismatch: deny before side effect.
12. Tenant member without Mission approver assignment: cannot approve high-risk Mission.
13. Mission owner without operator role: cannot reconcile unknown outcome.
14. Revoked OAuth grant, tenant membership, project policy, Mission role, and service credential: subsequent operation denied.
15. Duplicate event delivery with same idempotency scope: one effect only; changed payload with same key: conflict.
16. Unknown schema version: reject safely without partial write.

For each fixture record expected status, actual status, exact source SHA, command, runtime, output artifact, and independent reviewer. Until executed, status is NOT_RUN.

## 9. Compatibility and migration rules

- Do not rewrite existing principal IDs, account subjects, Mission IDs, task IDs, or historical actor strings in place.
- Add explicit mapping records only after proving uniqueness and ownership.
- Preserve existing service:shared-mcp-bearer as a service principal until a separate migration removes or replaces it.
- Do not auto-link Python local accounts to OIDC identities by matching email.
- Do not migrate Hub BrainEntry records until its backend, schema, tenant model, ownership, retention, and deletion semantics are verified.
- Keep existing sessions invalidated or explicitly re-bound during any principal migration; never let an old token silently acquire a new principal.
- Use additive migrations, dual-read only when necessary, one authoritative writer, reconciliation reports, backup/restore tests, and a reversible cutover.
- Never enable two independent writers for one membership, policy, principal, or BrainEntry aggregate.

## 10. Open decisions and blockers

| Decision / gap | Status | Why it matters |
|---|---|---|
| Email OTP + OAuth as sole human login for v1 | PROPOSED | Must be explicitly approved and live Access/OIDC integration verified |
| Exact OIDC issuer and stable subject contract | PROPOSED | Must match provider claims and golden fixtures |
| Tenant Directory canonical principal namespace | PARTIAL | Current service path exists; human OIDC path is not wired |
| Mission operator/approver provisioning source | UNKNOWN | Must not infer roles from tenant roles or email |
| Python adapter to OIDC principal | NOT_DEFINED | Current Python local accounts and static tokens are separate |
| Cloud Agent identity federation | NOT_DEFINED | Current owner/user token registry is separate |
| Hub backend principal and tenant ownership | UNKNOWN | Backend repository/runtime not identified |
| Shared revocation event or bounded revalidation | NOT_DEFINED | Stale grants can persist without explicit semantics |
| Cross-context event envelope | PROPOSED | No shared envelope currently proven |
| Golden fixtures and execution evidence | NOT_RUN | Design claims need falsifiable tests |

## 11. Gate 2D acceptance status

| Criterion | Status |
|---|---|
| Human/service principal distinction defined | DRAFTED |
| OIDC human principal derivation specified | DRAFTED |
| Email separated from immutable identity key | DRAFTED |
| Tenant membership and project policy boundaries specified | DRAFTED |
| Mission role boundary specified | DRAFTED |
| Component adapters inventoried | DRAFTED |
| Revocation semantics specified | DRAFTED |
| Event envelope proposed | DRAFTED |
| Golden fixtures authored and executed | NOT_RUN |
| Backend ownership resolved | UNKNOWN |
| Independent architecture review | NOT_RUN |
| User approval of final identity contract | PENDING |
| Implementation authorized | NO |

**Gate 2D draft is complete for review, but not accepted or frozen.** No identity integration code may be written from this draft until the user approves the contract and the missing backend/role/revocation decisions are resolved.

## 12. Next atomic step

The next step is a focused architecture review of this draft against the email-OTP design, Python Mission role model, Tenant Directory, and service-principal compatibility. Resolve only contradictions and missing decisions; do not expand into unrelated application features. After review, present the exact identity contract for approval before implementation.

## 13. Safety

Documentation only. No code, identity settings, OAuth KV, Cloudflare Access application, secrets, deployment, PR, main branch, or production resource was modified. Production remains **NO-GO**.
