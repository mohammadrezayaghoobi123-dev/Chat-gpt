# Master Brain — Identity, Authorization, and Trust-Boundary Map
**Date:** 2026-11-15  
**Mission:** MB-G2C-IDENTITY-TRUST-MAP-2026-11-15-001  
**Workspace:** mohammadrezayaghoobi123-dev/Chat-gpt  
**Target branch:** integration/master-brain-unification-2026-11-15  
**Mode:** Read-only source and design reconciliation; documentation only.

## 1. Purpose

Gate 2C determines whether current identity implementations can safely interoperate. It separates:
1. Authentication — who presented a valid credential.
2. Canonical principal — the stable identity key.
3. Tenant membership — whether that principal belongs to a tenant.
4. Project authorization — whether that principal may perform a specific action on a specific project/resource.
5. Approval authority — whether the principal may approve a high-risk Mission.
6. Service identity — which non-human service is acting.

These are separate trust decisions. A verified email, OAuth scope, tenant selector, project selector, request-body user_id, or service bearer must not substitute for another decision.

## 2. Evidence snapshot

### 2.1 Python Mission source — master-brain/integrated

| File | Blob SHA-1 | Relevant evidence |
|---|---|---|
| src/master_brain/identity.py | d5abaa87beae5a4a72052caafacb482bf33e9314 | Identity, Authenticator, StaticTokenAuthenticator, ChainAuthenticator |
| src/master_brain/http_api.py | 1cfcf1da456798218b280d3266793ae89430cb55 | make_server, bearer/cookie selection, session endpoints, loopback/TLS boundary |
| src/master_brain/accounts.py | f5afe8b91ab0da754803cb8e8c0818b87f9fee5f | local account store, password verification, sessions, role lookup/revocation |
| src/master_brain/security_log.py | 5f6919d47183d6a8d00b77f8d48394682c2a4d69 | security events and fail-closed account changes |
| src/master_brain/mission_approval.py | b4c19544e21044a438e98aa1bfcdcc1afb857524 | signed approval bound to subject, contract digest, key, expiry and action |
| tests/test_http_api.py | 5ad80279aefa2cf1b72edbc8cacc7c653d31ad70 | bearer auth, cross-user isolation, auth-before-body, role and API tests |
| tests/test_accounts.py | 9a2899de03921273835b1346baff5ea3790aad71 | scrypt, sessions, token hashing, expiry, revocation, role changes |

### 2.2 Connector / Cloud Agent source — main at 919b19ca3d3887352cdef06b03c668ead04fbce7

| File | Blob SHA-1 | Relevant evidence |
|---|---|---|
| cloud-engineering-connector/worker.js | 8911b4fc7df279ecbea7689506e0f814b2414dff | shared bearer authentication, service principal, tenant/project authorization |
| cloud-engineering-connector/index.js | 1a8a3f50cc4bbd2d1522311f48d21a36bf5adc33 | exported Worker and Durable Object classes |
| cloud-engineering-connector/identity/tenant-context.js | 2282a056d1b0436ad8e573f7c8d7873d4fe5c34b | opaque principal, OIDC claim validation path, tenant context, project policy |
| cloud-engineering-connector/identity/oauth-provider.js | a05ae52df029e3d4e6644a4c21e1470086248ec7 | isolated OAuth provider constructor and protocol endpoints |
| cloud-engineering-connector/identity/tenant-directory.js | 47647f84afc03c554b808060b6adce200d31e13d | membership, project policy, provisioning assertions, audit |
| cloud-engineering-connector/identity/tenant-directory-assertion.js | a97a1504b6bed1d1a6fbc1548d5ba0462ee1bc3f | signed admin assertions for directory writes |
| cloud-engineering-connector/wrangler.toml | 6c81ef6761497f6e8889a1ed8aa715b70922a949 | OAUTH_KV and TenantDirectory bindings |
| cloud-engineering-connector/test/oauth-provider.test.js | f13e5f0da3fe748633762825d788a365a27b7528 | isolated OAuth metadata/resource tests |
| cloud-engineering-connector/test/tenant-authorization.test.js | 1a4f25130f4fc5f907cafd07e9326668802103ff | principal and tenant/project negative tests |
| cloud-agent/src/worker.js | 95b90c0fd962876ff92c8c675575d72f01bf0c4d | owner/user bearer principals and session capability |
| cloud-agent/test/principal.runtime.test.js | 7077155f9189d5d86846a526d9723c08cfd9a025 | session/principal separation tests |

### 2.3 Product identity decision record

The repository contains:
- docs/architecture/2026-11-08-email-otp-mcp-oauth-design.md — blob SHA 21ec52a8be34112460e6b079f619b452d2567320.
- docs/superpowers/plans/2026-11-08-email-otp-mcp-oauth.md — blob SHA 93ab232d6d9b8db0e1b6505cf8f373ab4971206a.

The design record proposes:
- verified email via Cloudflare Access One-time PIN as the only interactive identity method in v1;
- SMS, password login, social login, and personal API keys out of scope;
- a stable human principal derived from validated OIDC issuer + subject;
- email as a verified profile attribute, not the immutable primary key;
- Tenant Directory membership and project policy as independent authorization gates;
- no automatic tenant membership from email verification.

The design document status is **PROPOSED FOR USER REVIEW; NOT IMPLEMENTATION AUTHORIZATION**. This audit preserves that distinction and does not silently mark the design approved.

## 3. Current identity implementations

### 3.1 Python Mission API: local bearer and local account/session authentication

The Python identity seam defines:
- Identity(subject, roles), with a constrained subject string and a closed role set (operator, approver);
- an Authenticator protocol returning an Identity or None;
- StaticTokenAuthenticator, which stores SHA-256 token digests and compares in constant time;
- ChainAuthenticator, which can compose authenticators.

The HTTP transport authenticates before reading the request body. It accepts a Bearer credential or, when configured, the mb_session cookie. The Authorization header takes precedence over cookies. Cookie-authenticated state-changing requests require same-origin validation. The server defaults to loopback; non-loopback binding requires explicit opt-in and an allowed-host list. The transport itself does not provide TLS; secure cookies are intended only behind TLS.

The Python branch also contains a local AccountStore and SessionAuthenticator:
- accounts are operator-created; no public self-registration;
- password records use scrypt with per-account salt;
- sessions use random opaque tokens; only SHA-256 digests are stored;
- idle and absolute expiry, session caps, logout, password-change and disable revocation are implemented;
- roles/disabled state are re-read during authentication;
- account changes require a security-log event before the change is committed.

The AccountStore module documents limits including no MFA, no password-reset flow, and no password-breach list. This is a local account/session implementation, not a selected external identity provider and not the email-OTP-only design proposed for the Connector.

**Interpretation:** Python Mission has an implemented local authentication seam and local session path. It does not yet share the Connector's OIDC principal issuer or Tenant Directory mapping.

### 3.2 Connector: shared service bearer is active; OAuth provider module is not wired

The current Connector Worker directly validates MCP_AUTH_TOKEN and constructs one service identity: service:shared-mcp-bearer.

For create_change_pr, it resolves tenant membership and a project-specific policy decision through Tenant Directory. The service principal is not a human user. It must not be silently reclassified as one.

A separate identity/oauth-provider.js module imports the Cloudflare Workers OAuth Provider and can construct metadata, token, revoke, and resource handling. Unit tests exercise provider metadata, PKCE S256 advertisement, protected-resource metadata, and rejection of invalid/missing bearer credentials.

However, direct source inspection found:
- worker.js contains zero references to createOAuthProvider, OAuthProvider, OAUTH_KV, or /oauth/token;
- index.js imports the Worker and exports Durable Object classes, but does not import or wire the OAuth provider;
- wrangler.toml declares OAUTH_KV, but the current Worker does not consume it.

Therefore, the OAuth provider module and its isolated tests are **code-exists / tests-authored**, not evidence of a live OAuth authorization flow. The Cloudflare Access for SaaS OIDC callback, email OTP, consent, validated OIDC token, refresh rotation, and revocation are not wired in the current Worker source.

### 3.3 Connector principal and Tenant Directory

The Connector's resolvePrincipal accepts:
- an authenticated service principal returned by a trusted server-side authenticator; or
- validated OIDC claims with HTTPS issuer, subject, syntactically valid email, and emailVerified === true.

For the OIDC path, the human principal ID is derived from a versioned SHA-256 fingerprint of the exact issuer + subject. Email is excluded from the principal ID. The result is frozen and does not retain the raw credential.

resolveTenantContext requires an authenticated principal and active membership from the membership store. A tenant selector only selects the membership to check; it is not proof of membership. authorizeProjectAction requires a verified tenant context and a policy decision bound to the exact principal, tenant, project, action, and resource digest. Non-allow, missing, mismatched, or unavailable policy decisions fail closed.

Tenant Directory persists memberships and project policy rules and uses signed, tenant-scoped administrative assertions for provisioning. Missing membership or policy defaults to deny.

### 3.4 Cloud Agent: separate token registry and session principal

Cloud Agent authenticates:
- an owner credential as principal owner;
- optional user credentials via a configured map of principal IDs to SHA-256 token digests.

Sessions bind to both the principal ID and the fingerprint of the bearer credential. Session capabilities are separately generated and stored only as hashes. The tests cover cross-principal session access, credential rotation, owner/user separation, malformed registry, unknown token, and revocation.

This is useful service-level identity separation, but it is not OIDC, email identity, tenant membership, or project authorization. Cloud Agent does not use Tenant Directory in the inspected Worker source.

### 3.5 Hub BrainEntry identity metadata is not authorization

The Hub client sends BRAIN_API_KEY as a Bearer token only if configured. Its BrainEntry data contract permits optional source.user_id, but the Hub repository contains no backend authentication implementation. A client-supplied user_id is metadata, not authenticated identity.

Backend enforcement, tenant mapping, ownership checks, and data retention remain UNKNOWN until the Brain API server is identified.

## 4. Cross-system trust-boundary matrix

| System | Credential / authenticator | Canonical principal currently evidenced | Authorization authority | Scope | Status |
|---|---|---|---|---|---|
| Python Mission | Static bearer; optional local password + server-side session cookie | caller-configured Identity.subject | closed Python roles, ownership checks, approver policy | subject + mission ID | CODE-DEFINED; local only; external IdP UNKNOWN |
| Connector MCP | shared MCP_AUTH_TOKEN | service:shared-mcp-bearer | Tenant Directory membership + project policy | tenant + project + action + resource digest | SERVICE PATH CODE-DEFINED; human OAuth flow NOT_WIRED |
| Connector OIDC design | proposed Access OIDC + OAuth Provider | oidc:v1:<hash(issuer,subject)> | Tenant Directory after authentication | principal → tenant membership → project policy | PROPOSED; not live |
| Cloud Agent | owner bearer + optional principal-token digest registry | owner or configured principal ID | token registry + session ownership checks | principal + session capability | CODE-DEFINED; no tenant/project policy |
| Hub Brain API | optional BRAIN_API_KEY | backend-defined; UNKNOWN | backend-defined; UNKNOWN | optional source.user_id; no verified tenant/project model | BACKEND UNKNOWN |
| Tenant Directory | trusted internal principal context; signed admin assertions for provisioning | opaque principal ID | membership and project policy tables | tenant + project | CODE-DEFINED; used by Connector service path |

## 5. Canonical identity direction — proposal, not frozen

To preserve the email-only, low-friction v1 design while maintaining correct security boundaries, the candidate direction is:

1. **Human authentication:** Cloudflare Access One-time PIN to a verified email, followed by OAuth authorization-code flow with PKCE S256. No password, SMS, social login, or user-managed API key in this v1 path.
2. **Immutable human principal:** derive a versioned opaque ID from the exact validated OIDC issuer + subject. Email remains a verified, mutable profile attribute and must not be the primary key.
3. **Service principals:** retain explicit non-human identities, such as service:shared-mcp-bearer, in a separate namespace. Never merge a service identity into a human account.
4. **Tenant membership:** successful authentication does not create or imply membership. Tenant Directory is authoritative.
5. **Project authorization:** a tenant member still needs an explicit allow decision for the exact project/action/resource.
6. **Python Mission bridge:** a future adapter may map the canonical opaque principal ID to Python Identity.subject, but must not copy client email or caller-supplied roles. Python operator/approver roles require explicit trusted assignment and revocation semantics.
7. **Cloud Agent bridge:** do not convert its local token-registry IDs into human OIDC principals without a separately authenticated migration and session invalidation plan.
8. **Hub bridge:** do not use BrainEntry.source.user_id as an authorization identity. The backend must first be identified and must derive the principal from a validated server-side credential.

This direction is consistent with the repository's proposed email-OTP design, but remains **PROPOSED** until the user approves the exact identity contract and its operational dependencies.

## 6. Documentation contradiction requiring correction

docs/MASTER_BRAIN_API_CONTRACT_V1.md begins by stating that there is no server, persistence, or authentication provider. Later in the same document it describes:
- Gate 2a local HTTP server implementation;
- Gate 2c-2 local AccountStore and SessionAuthenticator;
- session cookies, role refresh, account management, revocation, and related endpoints.

The current http_api.py and accounts.py source corroborate that these local components exist. The top-level status statement is therefore stale or scoped to an earlier snapshot and must be corrected or explicitly versioned before contract freeze. Do not treat the document header as the current implementation truth.

## 7. Required security and interoperability tests

Existing test files are evidence that tests were authored; no tests were executed in this read-only audit.

| Test family | Required assertions | Current evidence |
|---|---|---|
| OIDC validation | bad signature, issuer, audience, nonce, expiry, missing subject, unverified email, replayed callback all reject before grant creation | design plan specifies; Access OIDC callback not found in active Worker |
| Principal stability | same issuer+subject gives same ID despite email change; different issuer or subject gives different ID | tenant-context.js supports validated-claim derivation; test suite exists |
| Service/human separation | shared service bearer never becomes human; service principal cannot impersonate OIDC user | design requirement; current shared bearer is service identity |
| Tenant membership | absent, inactive, wrong-principal, wrong-tenant membership rejects before side effects | Tenant Directory + tenant authorization tests exist |
| Project policy | deny, unavailable, mismatched project/action/resource digest reject | Tenant Directory + tenant authorization tests exist |
| Python account/session | no role escalation from body; session expiry/revocation/role changes effective; cross-user Mission isolation | Python HTTP/account tests exist |
| Python role bridge | only trusted provisioning grants operator/approver; email/tenant fields cannot grant role | not established across Connector/Python |
| Cloud Agent session | another principal cannot read a session even with capability; rotation invalidates prior session | runtime tests exist |
| Hub identity | client-supplied source.user_id cannot grant read/write access; backend derives identity | backend unavailable; NOT_RUN |
| Cross-system revocation | OIDC revocation, Tenant Directory membership revocation, Python session/role revocation, Cloud Agent registry revocation do not leave stale cross-context grants | no shared revocation contract; NOT_RUN |

## 8. Gate 2C acceptance status

| Criterion | Status |
|---|---|
| Python local auth/session implementation inspected | CONFIRMED IN SOURCE |
| Python external IdP selected | UNKNOWN |
| Connector service principal separated from human identity | CONFIRMED IN SOURCE |
| Connector OIDC principal derivation code inspected | CONFIRMED IN SOURCE |
| Connector OAuth provider module and isolated tests found | CONFIRMED IN SOURCE |
| OAuth provider wired into active Connector Worker | NOT_WIRED |
| Cloudflare Access email OTP callback and OIDC validation wired | NOT_FOUND IN INSPECTED WORKER |
| Tenant Directory membership/project policy authority inspected | CONFIRMED IN SOURCE |
| Cloud Agent token/session principal boundary inspected | CONFIRMED IN SOURCE |
| Hub backend principal and authorization model | UNKNOWN |
| Cross-system canonical principal mapping | NOT_DEFINED |
| Cross-system revocation semantics | NOT_DEFINED |
| Positive/negative cross-system golden fixtures | NOT_AUTHORED |
| Runtime/CI tests executed in this audit | NOT_RUN |
| Identity contract freeze | NO |

**Gate 2C is PARTIALLY COMPLETE, NOT PASSED.** Component-level trust boundaries are identified, but a canonical human principal is not yet wired end-to-end. The email-OTP design is a proposal, not a verified login path.

## 9. Next atomic step

Proceed to **Gate 2D — identity contract and adapter specification**, without code changes:
1. Freeze the human principal schema and versioned derivation rule from validated issuer + subject.
2. Define service-principal namespace and prohibit implicit human/service conversion.
3. Define how trusted operator and approver roles are provisioned, audited, changed, and revoked.
4. Define the Tenant Directory membership and project-policy interfaces as mandatory post-authentication gates.
5. Define explicit adapters for Connector → Python Mission, Connector → Cloud Agent (if needed), and Hub → Brain backend only after the backend owner is found.
6. Define logout, token refresh, revocation, session expiry, and emergency disable semantics across components.
7. Add golden positive/negative fixtures and independent review criteria.

No cross-context write path or data migration may be enabled until Gate 2D is reviewed and the Brain backend is identified. Do not treat the proposed OAuth module as active until the Worker call path and live end-to-end tests prove it.

## 10. Safety

Documentation only. No code, identity settings, OAuth KV, Cloudflare Access application, secrets, deployment, PR, main branch, or production resource was modified. Production remains **NO-GO**.
