# Project Security Hardening Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-first changes and independent verification. Keep each task in a separately reviewable commit.

**Goal:** Reduce exploitable security risk across the Cloud Engineering Connector and Cloud Agent without changing production resources or weakening the existing project architecture.

**Architecture:** Audit the repository and deployed configuration as separate evidence domains. Apply code fixes only on this isolated branch, with focused regression tests before implementation. Treat live Worker configuration changes, credential rotation, and deployment as separate operational changes requiring explicit approval.

**Tech Stack:** Cloudflare Workers, Durable Objects, JavaScript/Node.js tests, Wrangler, GitHub Actions, GitHub REST API.

**Spec:** User request dated 2026-11-01: audit and fix authentication, secrets, data access, server-side validation, XSS/SQLi/CSRF, admin routes, rate limiting, security headers, CORS, cookies, uploads, debug mode, vulnerable dependencies, and leaked Git secrets.

## Global Constraints

- Preserve `main` at `f2cae91de818385ec48daafc43c621b9e2cc0675`; do not merge.
- Base this branch on `hardening/daily-neuron-budget` head `c0f3be179a62985aa9abf67dec8e10b39ba72518`.
- Do not deploy, change live Worker routes/bindings/secrets, rotate credentials, or change billing.
- Never print, copy into logs, or commit secret values.
- Use TDD: add a focused failing regression test, verify the failure, implement the minimum fix, then run the full suite.
- Keep findings distinct from fixes; a clean unit test does not prove hosted Cloudflare behavior.
- Treat non-applicable controls (password storage, cookie sessions, multipart uploads, direct SQL) as N/A only after confirming no such feature exists.

## Review Focus

- Authenticated request flood: apply an independent authenticated rate-limit namespace and fail closed on limiter errors.
- Untrusted forwarded identity: trust only Cloudflare's edge-provided `cf-connecting-ip`; reject malformed or missing identity.
- CORS/CSRF: reject unapproved origins and credentials; verify that browser credential/cookie semantics are not accidentally enabled.
- Tool authorization: enforce write-tool authorization independently of advertised tool lists and caller-supplied arguments.
- Data boundary: ensure repository, branch, file-path, and content validation happens server-side before GitHub API writes.
- Secret leakage: inspect current tree and reachable Git history using secret scanners; distinguish findings from provider secret-scanning coverage.
- Dependency integrity: inspect lockfiles, exact versions, audit advisories, and GitHub Actions supply-chain pinning.
- Hosted configuration: report binding types and missing settings without retrieving or exposing secret values.

---

### Task 1: Authenticated Connector Rate Limiting

**Files:**
- Modify: `cloud-engineering-connector/test/worker.test.js`
- Modify: `cloud-engineering-connector/worker.js`
- Review: `cloud-engineering-connector/wrangler.toml`

**Interfaces:**
- Existing `enforceRateLimit(request, env, keyPrefix)` remains the shared fail-closed limiter.
- Authenticated requests use a distinct `authenticated-mcp:` namespace, separate from `auth-failure:` and `public-mcp:`.

- [ ] Add tests proving authenticated requests consume the authenticated namespace.
- [ ] Add tests proving a denied authenticated request returns 429 with Retry-After and does not execute MCP methods.
- [ ] Add tests proving limiter outage or malformed client identity fails closed with 503.
- [ ] Run the focused test and verify expected failure before production changes.
- [ ] Apply minimal change and run the full connector test suite.

### Task 2: Authorization and Server-Side Input Boundary

**Files:**
- Review/modify: `cloud-engineering-connector/worker.js`
- Review/modify: `cloud-engineering-connector/test/worker.test.js`

- [ ] Build an explicit tool authorization matrix for authenticated and PUBLIC_READ_ONLY callers.
- [ ] Test write-tool denial under every unauthenticated/public configuration.
- [ ] Test unknown tool names, extra properties, malformed JSON-RPC params, repository identifiers, branch names, file paths, file sizes, and file counts.
- [ ] Fix only demonstrated gaps; retain server-side allowlists and fail-closed behavior.
- [ ] Run all connector tests.

### Task 3: Cloud Agent Session and Budget Authorization

**Files:**
- Review/modify: `cloud-agent/src/worker.js`, `cloud-agent/src/core.js`, `cloud-agent/src/budget.js`
- Review/modify: `cloud-agent/test/*.test.js`, `cloud-agent/wrangler*.toml`

- [ ] Verify per-session capability isolation and constant-time verifier comparison.
- [ ] Verify session expiry, ownership boundaries, and that no capability or token is logged or returned from history.
- [ ] Verify daily budget reservations fail closed and cannot be bypassed through concurrent sessions.
- [ ] Add regression tests for every confirmed gap before code changes.
- [ ] Run Node and Workers Vitest/workerd suites.

### Task 4: Browser, Transport, and Operational Security

**Files:**
- Review: browser console/static assets and deployment configuration.
- Review: `.github/workflows/*.yml`, package manifests, lockfiles, ignore rules and Git history.

- [ ] Audit CORS, CSP/security headers, HTML escaping, DOM sinks, CSRF exposure, cookies, debug routes, and upload handlers.
- [ ] Audit direct database/SQL usage and document whether injection is applicable.
- [ ] Scan current tree and all reachable history for credential patterns with a dedicated secret scanner; never expose values.
- [ ] Run dependency advisory scans using the repository's lockfile and package manager.
- [ ] Review GitHub Actions permissions, third-party action pinning, and workflow trigger trust boundaries.
- [ ] Record non-applicable features and evidence.

### Task 5: Independent Verification and Report

- [ ] Re-run all relevant tests from a fresh workflow run.
- [ ] Review the complete diff against the base and inspect every changed line.
- [ ] Confirm `main` and deployed Workers remain unchanged.
- [ ] Record hosted Cloudflare canary gaps separately; do not claim them tested.
- [ ] Keep the PR Draft until all code-level gates pass and live configuration changes are separately approved.
