# Email OTP and MCP OAuth Identity Design

**Date:** 2026-11-08  
**Status:** Proposed for user review; not implementation authorization  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Target:** PR #196 working branch only

## Intent

Provide one low-friction human sign-in method for the Cloud Engineering MCP connector: verified email using Cloudflare Access One-time PIN, followed by OAuth authorization for ChatGPT and Claude. Users must not need passwords or personal API keys. OAuth sessions should avoid repeating email OTP on every MCP request.

## Goals

- Email OTP is the only interactive identity method in v1; SMS and password login are out of scope.
- Use Cloudflare Access as the upstream OIDC identity provider, with its email OTP login method enabled by policy.
- Use `@cloudflare/workers-oauth-provider` for MCP OAuth 2.1 authorization, discovery, client registration compatibility, PKCE, token issuance, refresh-token rotation, and revocation.
- Derive a stable human principal from the validated upstream issuer and subject (`iss + sub`); treat email as a verified profile attribute, not the primary key.
- Keep authentication, OAuth consent, tenant membership, and project authorization as distinct gates.
- Resolve tenant membership and project policy through the existing Tenant Directory; default deny on missing, inactive, mismatched, or unavailable membership/policy.
- Preserve current repository data and existing Worker behavior except where a test-backed auth boundary requires change.
- Verify ChatGPT and Claude interoperability independently before any release decision.

## Non-goals

- No SMS OTP, password authentication, social login, or automatic account linking.
- No user-facing personal API keys.
- No automatic tenant membership from successful email verification.
- No merge to `main`, Cloudflare resource provisioning, secret mutation, staging deployment, or production deployment in this work increment.
- No claim of Production readiness from unit/CI success alone.

## Selected approach

**Recommended: one Worker using the Workers OAuth Provider integration, with Cloudflare Access for SaaS as the upstream OIDC login.**

The existing MCP Worker already owns the `/mcp` resource endpoint. Integrating the OAuth provider in the same Worker keeps the first implementation operationally small and avoids introducing a second Worker and service-binding hop. The provider will own OAuth protocol endpoints and token lifecycle; a dedicated, testable authorization handler will perform upstream Access OIDC login and explicit consent.

Alternatives considered:

1. **Direct Access protection only:** simple for browser access, but does not by itself provide the MCP OAuth authorization-server/token lifecycle required for general MCP clients. Not selected.
2. **Separate authorization Worker and MCP resource Worker:** clean role separation and service-binding token validation, but introduces another Worker, service binding, deployment unit, and operational surface. Keep as a future option if the single-Worker integration becomes a measured limitation.
3. **Custom OAuth implementation:** rejected because protocol security, discovery, PKCE, token rotation, and revocation should be delegated to the maintained Cloudflare provider library.

## Authentication and authorization flow

1. MCP client discovers protected-resource and authorization-server metadata.
2. Client starts OAuth authorization-code flow with PKCE (S256); provider validates the request, client, redirect URI, resource, state, and PKCE requirements.
3. Authorization handler redirects the user to the configured Cloudflare Access for SaaS OIDC authorization endpoint.
4. Access policy allows only intended users and requires the One-time PIN login method. Cloudflare sends a single-use PIN to the approved email; PIN validity is 10 minutes.
5. Callback validates state and exchanges the authorization code. ID token validation must check signature against trusted JWKS, exact issuer, audience/client ID, expiry, issued-at constraints, nonce, and required subject/email claims. Never trust an email supplied only by query/form parameters.
6. Show an anti-framing consent page identifying the MCP client, requested scopes, and resource hostname. Grant only supported least-privilege scopes.
7. Complete OAuth authorization with a stable user identifier derived from validated `iss + sub`; carry only minimal identity attributes in encrypted provider props.
8. For each MCP request, derive principal only from the provider-validated OAuth context. Do not treat a client-supplied email, tenant ID, or project ID as proof of identity or authorization.
9. Resolve active membership in Tenant Directory, then authorize the exact project/action/resource. Fail closed before any side effect.
10. Use provider-managed refresh-token rotation and revocation; users should not repeat OTP while the OAuth grant remains valid.

## Identity and tenant rules

- Canonical principal key: namespaced stable subject derived from the exact validated OIDC issuer and `sub`; never use email as the immutable key.
- Email is accepted only from the validated OIDC identity response after Access has completed the OTP login.
- No automatic merge of identities based on matching email strings from different issuers.
- Tenant selector is only a selector. Tenant Directory membership is authoritative.
- Project selector is only a selector. The policy store is authoritative for each action and resource.
- Existing `service:shared-mcp-bearer` remains a service identity only; it must never be silently converted to a human principal. Any compatibility path must be explicitly isolated and restricted.
- No membership means deny. Store or policy outage means deny.

## State and secrets

Required runtime binding/configuration is to be finalized against the pinned provider API and Wrangler schema during implementation. Expected categories:

- Provider KV namespace for OAuth clients, grants, authorization codes, and token metadata.
- Upstream Access for SaaS OIDC client ID/secret and authorization, token, and JWKS endpoints.
- Cryptographically random cookie/session encryption key.
- Existing Tenant Directory binding.

Secret names may be added to documentation/config templates; secret values must never be committed, logged, or changed by this PR. Actual Cloudflare setup is a separately approved operational task.

## Security and abuse controls

- OAuth authorization code + PKCE S256; exact redirect URI validation; state and nonce validation.
- Strict OIDC signature, issuer, audience, expiry, issued-at, and nonce validation.
- CSRF-resistant callback/session handling; secure, HttpOnly, SameSite cookies; anti-framing consent UI; strict CSP.
- Short, bounded authorization/session state; no raw OTP storage or custom OTP generation.
- Rate limits on authorization initiation, callback failures, and MCP requests; generic failure messages to avoid account enumeration.
- Minimal PII in logs; never log tokens, authorization codes, cookies, or raw user payloads.
- OAuth scopes are not a substitute for Tenant Directory authorization.

## Verification gates

- Unit tests: malformed OAuth requests, redirect mismatch, PKCE downgrade, state/nonce mismatch, invalid signature, wrong issuer/audience, expired/not-yet-valid tokens, missing subject/email, replayed callback, cookie tampering, denied consent, refresh rotation, revocation, and token/resource audience mismatch.
- Worker integration tests: unauthenticated request rejected; invalid bearer rejected; provider-authenticated subject becomes an opaque human principal; caller-supplied email cannot override it; Tenant Directory membership and project policy are required; cross-tenant/project attempts fail before storage or side effects.
- Compatibility tests: separately connect ChatGPT and Claude; record discovery, login, consent, tool listing, request authorization, refresh, and revocation outcomes.
- CI: exact-commit Node tests, Vitest/Workers tests, dependency audit, syntax checks, and Wrangler dry-runs. Do not claim live Access/OAuth interoperability from unit tests.
- Operational acceptance: requires a separately approved Access SaaS app, KV binding, secrets, and staging smoke. None are created or changed by this design document.

## Rollback

Revert only the identity/OAuth integration commits on the working branch. Keep Tenant Directory data and existing Durable Object data intact. Do not delete OAuth KV or identity records as part of code rollback. Production rollback remains a separately human-approved operation.

## Open implementation checks

- Confirm the exact installed `@cloudflare/workers-oauth-provider` v1 API and compatibility with the repository's Worker entrypoint before coding.
- Confirm Access for SaaS OIDC claim shape, especially stable `sub`, issuer, audience, nonce, and whether email verification is represented as a claim; do not assume unsupported claims.
- Generate and commit a lockfile update through reproducible npm tooling; do not hand-edit dependency integrity data.
- Confirm ChatGPT and Claude supported OAuth client registration/discovery behavior with real clients before marking compatibility.
