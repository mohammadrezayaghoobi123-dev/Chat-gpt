# Email OTP MCP OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared human-facing bearer-token path with a verified Cloudflare Access email-OTP identity and OAuth-protected MCP resource, while retaining Tenant Directory as the separate authorization authority.

**Architecture:** Integrate the maintained `@cloudflare/workers-oauth-provider` in the existing Worker rather than introducing a second Worker. Cloudflare Access for SaaS supplies upstream OIDC authentication; the OAuth provider owns MCP authorization-server endpoints and token lifecycle; the existing Tenant Directory remains authoritative for membership and project policy.

**Tech Stack:** Cloudflare Workers, JavaScript ES modules, `@cloudflare/workers-oauth-provider`, Cloudflare Access for SaaS OIDC, Workers KV, Node test runner, Vitest, Wrangler.

**Spec:** `docs/architecture/2026-11-08-email-otp-mcp-oauth-design.md`

## Global Constraints

- Work only on `integration/multi-tenant-migration-2026-11-08`; re-fetch PR #196 head before each write.
- Never modify `main`, merge PR #196, deploy, provision Cloudflare resources, or mutate secrets.
- Email OTP only; no SMS, passwords, personal API keys, or automatic tenant membership.
- PIN validity is 10 minutes and single-use, delegated to Cloudflare Access; do not implement a custom OTP generator.
- Canonical human identity is a stable opaque value derived from validated OIDC `iss + sub`; email is a verified profile attribute only.
- Tenant and project authorization are independent of authentication and fail closed.
- Never treat `service:shared-mcp-bearer` as a human identity.
- Tests must precede production code; record a real red result and the matching green result for each behavioral increment.
- Do not hand-edit dependency lockfile integrity metadata. Generate lockfiles using reproducible npm tooling.
- No secrets, tokens, authorization codes, cookies, OTPs, or raw identity claims in logs.

## Review Focus

- OIDC issuer/audience/nonce/signature mismatch must reject before creating an OAuth grant.
- Missing, unverified, or mutable email claims must not become a principal identifier.
- A caller-supplied tenant/project selector must not grant membership or policy.
- Refresh-token reuse, revocation, and wrong resource audience must not retain MCP access.
- Cloudflare Access/KV outage must fail closed without falling back to the shared bearer.

---

### Task 1: Stable OIDC human principal

**Files:**
- Modify: `cloud-engineering-connector/identity/tenant-context.js`
- Test: `cloud-engineering-connector/test/tenant-authorization.test.js`

**Interfaces:**
- Extend `resolvePrincipal({ credential, authenticator })` so a trusted authenticator may return validated OIDC claims `{ authenticated: true, issuer, subject, email, emailVerified: true }`.
- Return the existing opaque principal shape `{ id, type: "human", authenticated: true }`; derive `id` from SHA-256 of the exact issuer and subject with a versioned `oidc:v1:` prefix. Never include email in the ID.

- [ ] Write test `resolvePrincipal derives a stable opaque ID from verified issuer and subject, not email`; assert same issuer+subject yields same ID despite email change and a different subject yields a different ID.
- [ ] Run `npm run test:node -- --test-name-pattern="stable opaque ID"` from `cloud-engineering-connector`; verify expected failure due to missing OIDC claim support.
- [ ] Implement only the validated-claim path; preserve existing service-principal behavior for explicitly trusted service authenticators.
- [ ] Run the focused test, then `npm run test:node`; record full outputs.
- [ ] Commit the test and implementation together after red-green evidence.

### Task 2: OAuth provider and metadata boundary

**Files:**
- Modify: `cloud-engineering-connector/package.json`
- Generate: `cloud-engineering-connector/package-lock.json`
- Create: `cloud-engineering-connector/oauth/provider.js`
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/wrangler.toml`
- Test: new `cloud-engineering-connector/test/oauth-provider.test.js`

**Interfaces:**
- Pin a reviewed compatible `@cloudflare/workers-oauth-provider` version and produce the lockfile using npm.
- Register the MCP resource route `/mcp`; authorization, registration, token, and discovery routes must follow the library's documented API.
- Require a dedicated OAuth KV binding; absence must fail closed.
- Keep provider configuration separate from the resource request handler.

- [ ] Verify the exact installed provider API and compatible Node/Workers runtime from official package documentation and package metadata.
- [ ] Add tests for authorization-server metadata, protected-resource metadata, PKCE S256, redirect URI rejection, resource binding, and absent KV configuration.
- [ ] Run focused tests and record red.
- [ ] Add provider integration and minimum required Wrangler binding declarations (no real KV namespace IDs or secrets).
- [ ] Generate package lock with npm tooling in CI or a supported execution environment; do not fabricate it.
- [ ] Run focused and full Node/Workers tests; run Wrangler dry-run only, not deploy.
- [ ] Commit after green evidence.

### Task 3: Cloudflare Access OIDC email OTP

**Files:**
- Create: `cloud-engineering-connector/oauth/access-oidc.js`
- Modify: `cloud-engineering-connector/oauth/provider.js`
- Test: `cloud-engineering-connector/test/access-oidc.test.js`

**Interfaces:**
- Use configured Access for SaaS authorization, token, and JWKS endpoints; no hard-coded tenant URLs or allowlists.
- Callback returns only validated issuer, subject, verified email attribute (where supported), and minimal identity properties.
- Validate signature, exact issuer, audience, expiry, issued-at bounds, nonce, subject, and email claim requirements. Pin trusted JWKS issuer and key source; reject algorithm confusion and key/issuer substitution.

- [ ] Add tests for wrong issuer, wrong audience, expired token, invalid signature, nonce mismatch, missing subject, unverified/missing email, malformed JWKS, and callback replay.
- [ ] Run focused tests and record red.
- [ ] Implement OIDC validation using a maintained JOSE library or documented Workers-native verification path; no custom JWT parser.
- [ ] Run focused and full suites; commit only after green.

### Task 4: Wire validated OAuth principal into MCP Worker

**Files:**
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/identity/tenant-context.js`
- Test: `cloud-engineering-connector/test/worker.test.js`

**Interfaces:**
- Resource handler receives only provider-validated token context, not client-supplied identity headers or email.
- Map validated `iss + sub` to the stable human principal from Task 1.
- Explicitly isolate any temporary legacy service-bearer compatibility; never map it to a human user. The final policy for removing it must be proven by tests and documented.

- [ ] Add Worker tests for no token, invalid token, wrong resource audience, provider-authenticated human, client-supplied email spoofing, and service bearer not treated as human.
- [ ] Run focused tests and record red.
- [ ] Wire provider middleware and remove direct shared-bearer human authentication.
- [ ] Preserve public read-only behavior only if explicitly configured and rate-limited; no unauthenticated writes.
- [ ] Run full Node and Vitest suites plus Wrangler dry-runs; commit after green.

### Task 5: Tenant Directory enforcement

**Files:**
- Modify: `cloud-engineering-connector/worker.js`
- Modify: `cloud-engineering-connector/identity/tenant-directory-adapter.js` only if a contract gap is demonstrated
- Test: `cloud-engineering-connector/test/worker.test.js` and `cloud-engineering-connector/test/tenant-authorization.test.js`

**Interfaces:**
- Membership lookup receives only the opaque principal ID and trusted tenant selector.
- Project policy decision is bound to exact principal, tenant, project, action, and resource digest.
- Directory/policy errors, inactive membership, absent membership, or mismatched scope reject before GitHub or any other side effect.

- [ ] Add integration tests for absent/inactive membership, cross-tenant substitution, cross-project substitution, policy denial, directory outage, and zero downstream side effects.
- [ ] Observe expected red.
- [ ] Wire verified provider principal to existing directory adapter and policy checks.
- [ ] Run focused and full tests; commit after green.

### Task 6: Client interoperability and release evidence

**Files:**
- Create: `docs/architecture/email-otp-oauth-validation-matrix.md`
- Optional tests: client-independent discovery/authorization contract tests.

- [ ] Validate discovery, email OTP login, consent, tool listing, MCP request, refresh, and revocation independently with ChatGPT and Claude.
- [ ] Record client, date, environment, exact result, and evidence; do not infer Claude compatibility from ChatGPT or vice versa.
- [ ] Verify all CI workflows on the exact PR head and inspect failed job logs if any.
- [ ] Keep PR #196 Draft until all mandatory gates are met; no merge or deploy is part of this plan.
