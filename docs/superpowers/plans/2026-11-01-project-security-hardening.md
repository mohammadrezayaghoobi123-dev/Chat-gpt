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

- [x] Add tests proving authenticated requests consume the authenticated namespace.
- [x] Add tests proving a denied authenticated request returns 429 with Retry-After and does not execute MCP methods.
- [x] Add tests proving limiter outage or malformed client identity fails closed with 503.
- [x] Run the focused test and verify expected failure before production changes.
- [x] Apply minimal change and run the full connector test suite (152/152 on the latest verified Connector CI run).

### Task 2: Authorization and Server-Side Input Boundary

**Files:**
- Review/modify: `cloud-engineering-connector/worker.js`
- Review/modify: `cloud-engineering-connector/test/worker.test.js`

- [x] Build an explicit tool authorization matrix for authenticated and PUBLIC_READ_ONLY callers.
- [x] Test write-tool denial under unauthenticated, public-read-only, invalid-bearer, short-token, and missing-GitHub-credential configurations.
- [x] Test unknown tool names, extra properties, malformed JSON-RPC params, repository identifiers, branch names, file paths, file sizes, and file counts.
- [x] Fix only demonstrated gaps; retain server-side allowlists and fail-closed behavior. No additional Task 2 production defect was reproduced; new boundary tests pass.
- [x] Run all connector tests (152/152).

### Task 3: Cloud Agent Session and Budget Authorization

**Files:**
- Review/modify: `cloud-agent/src/worker.js`, `cloud-agent/src/core.js`, `cloud-agent/src/budget.js`
- Review/modify: `cloud-agent/test/*.test.js`, `cloud-agent/wrangler*.toml`

- [x] Verify per-session capability isolation and constant-time verifier comparison.
- [x] Verify session expiry, cross-session ownership boundaries, and capability/history secrecy. Expiry removes history, rate state, timestamp, and verifier; history returns only role/content; no console/logger calls exist in Agent worker/core/budget source.
- [x] Verify daily budget reservations fail closed and cannot be bypassed through concurrent sessions.
- [x] Add regression tests for confirmed auth-failure rate-limit gap before code changes.
- [x] Run Node and Workers Vitest/workerd suites (52/52 Node; 15/15 runtime).

### Task 4: Browser, Transport, and Operational Security

**Files:**
- Review: browser console/static assets and deployment configuration.
- Review: `.github/workflows/*.yml`, package manifests, lockfiles, ignore rules and Git history.

- [x] Audit CORS, CSP/security headers, HTML escaping, DOM sinks, CSRF exposure, cookies, debug routes, and upload handlers; a global response wrapper now enforces restrictive headers on JSON, preflight, 202 notification, SSE, and HTML responses, with HSTS only over HTTPS.
- [x] Audit direct database/SQL usage; the inspected services use Durable Object storage and GitHub APIs, with no direct SQL query surface.
- [x] Scan current tree and all fetched refs/reachable history with Gitleaks 8.30.1; no findings after exact-value, commit-scoped allowlists for verified synthetic fixtures. Latest scan: 1,497 commits / 5.28 MB / zero findings.
- [x] Commit package-lock.json for both packages; CI uses npm ci and npm audit --audit-level=moderate. Latest runs reported 0 vulnerabilities in both packages. Vitest upgraded to 4.1.12 to resolve two moderate @vitest/mocker advisories.
- [x] Review GitHub Actions permissions and trigger scope; CI uses contents:read, full-SHA-pinned actions, and push triggers for security/**. Non-blocking Node 20 deprecation warnings remain for the v4 action SHAs.
- [x] Record non-applicable features: password hashing, cookie sessions, multipart uploads, and direct SQL are not present in the inspected services.

### Task 5: Independent Verification and Report

- [x] Re-run all relevant tests from fresh GitHub Actions runs.
- [x] Review the complete changed-file list and PR patches against the base.
- [x] Confirm `main` SHA is unchanged; read-only Cloudflare binding metadata was reviewed. No deployment, secret, binding, route, or billing mutation was issued.
- [x] Record hosted Cloudflare canary gaps separately; no production canary was run.
- [x] Keep the PR Draft; live secret migration, rotation, and deployment remain separately gated.


## Execution Record — 2026-11-01

- Isolated branch: `security/project-security-hardening`; PR #101 remains Draft.
- Base: `hardening/daily-neuron-budget` at `c0f3be179a62985aa9abf67dec8e10b39ba72518`; merge-base verified; no commits behind base.
- Latest code/workflow head at this record: `889640ec7594a4b47298c5d08643e0c6dffa46ae`. The repository owner consolidated the secret-scan workflow; that commit was preserved.
- TDD evidence: authentication/rate-limit regressions and the later response-header/HSTS tests failed on the pre-fix implementation, then passed after minimum fixes. Session ownership/history tests are characterization coverage of existing safeguards; no production change was required for those checks.
- Latest Connector CI: run `41321751976`; 152/152 tests, moderate-level npm audit with 0 vulnerabilities, syntax checks, and Production/Staging Wrangler dry-runs passed.
- Latest Cloud Agent CI: run `41321751904` (PR) and `41321601835` (push); 52/52 Node tests, 15/15 Vitest/workerd tests, moderate-level npm audit with 0 vulnerabilities, syntax checks, and Wrangler dry-run passed.
- Dependency graph is now committed in both package lockfiles. A one-shot lockfile-generation workflow committed the lockfiles and removed itself; it is absent from the final tree.
- `main` remains at `f2cae91de818385ec48daafc43c621b9e2cc0675` and is still unprotected (`protected:false`); this P0 repository control remains unresolved.
- No live Worker deployment, route/binding/secret change, credential rotation, or billing change was performed. Read-only binding metadata was reviewed; Production `GITHUB_TOKEN` is `plain_text` and account 2FA enforcement is disabled. Hosted canary remains outstanding.
- Remaining high-priority work: protect `main` and require checks; remediate the Production `GITHUB_TOKEN` plain-text binding through separately approved revocation/rotation and Secret binding; enable Cloudflare account 2FA; validate a hosted staging canary after separate approval. Billing plan remains unverified.


### Hosted Configuration Evidence — Read Only

- Cloudflare account setting `enforce_twofactor=false`; no account security setting was changed.
- Production Worker `chat-gpt111`: `MCP_AUTH_TOKEN`, `MCP_ALLOWED_ORIGINS`, and `PUBLIC_READ_ONLY` are `secret_text`; `MCP_RATE_LIMITER` is configured at 60 requests / 60 seconds; `SERVICE_MODE` is plain text `cloud`.
- Critical Production finding: `GITHUB_TOKEN` is configured as `plain_text`, not `secret_text`. Its value was not copied into this report. Treat it as potentially compromised until the owner verifies it; rotate/revoke if valid, then recreate it as a repository-scoped least-privilege Secret. This operational remediation was not performed.
- Staging Worker `chat-gpt111-staging`: `MCP_AUTH_TOKEN` and `MCP_ALLOWED_ORIGINS` are `secret_text`; `PUBLIC_READ_ONLY` is plain text `true`; `MCP_RATE_LIMITER` is separately namespaced at 60 requests / 60 seconds; no `GITHUB_TOKEN` binding is present.
- Only the two Connector Workers above were listed; no separately named Cloud Agent Worker was found in this account listing. Cloud Agent code CI does not establish a hosted Agent deployment.
- Account `usage_model=standard` is not sufficient evidence of the Cloudflare billing plan; billing remains unverified.
- All Cloudflare calls in this pass were read-only. No secret values were requested from the secrets endpoint.

### Secret Scan Evidence — Current Branch

- The Gitleaks workflow scans the PR change range and all fetched Git refs with `fetch-depth: 0` and `--log-opts=--all`.
- Latest scan run `41321747587` on report head `54b5facd` (code/workflow head `889640ec`): 1,497 commits and approximately 5.28 MB scanned; zero findings.
- Historical suppressions were narrowed from broad field-name/pattern allowlists to exact synthetic fixture values, exact historical commits, and exact file paths. The AWS-shaped test value was verified as a sequential alphabetic placeholder before its exact-value allowlist was retained.
- The repository has one full-history secret-scan workflow in the final tree; the duplicate workflow was removed/consolidated by a subsequent repository-owner commit and that commit was preserved.


### Execution Record — CI Runtime and Action Supply-Chain Refresh — 2026-11-01

- Refreshed all repository workflow references to signed, full-commit-SHA pins:
  - `actions/checkout` v7.0.1: `3d3c42e5aac5ba805825da76410c181273ba90b1`; GitHub commit signature verified.
  - `actions/setup-node` v7.1.0: `949feb2413d6458794dcd2491c4babbbce0c15c1`; GitHub commit signature verified.
  - Explicitly disabled setup-node package-manager caching with `package-manager-cache: false`; Node project runtime remains pinned to major 22.
  - Migrated `gitleaks/gitleaks-action` from deprecated v2.3.9 / Node 20 to v3.0.0 / Node 24: `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`; GitHub commit signature verified. Inputs and behavior are unchanged per upstream release notes.
- Latest head: `ba939f362495cde3918fe5f583d69a3e024f8ebf`.
- Latest CI evidence on this exact head:
  - Connector run `41322316542`: 152/152 tests; npm audit 0 vulnerabilities; both Wrangler dry-runs passed.
  - Cloud Agent run `41322316450`: 52/52 Node tests; 15/15 Workers runtime tests; npm audit 0 vulnerabilities; Wrangler dry-run passed.
  - Full-history Gitleaks run `41322316428`: 1,502 commits / approximately 5.28 MB; zero findings.
- Gitleaks v3 itself completed successfully. Its logs still include upstream Node dependency deprecation warnings (`punycode`, `url.parse`); these are non-failing and should be tracked for upstream remediation.
- No changes to `main`, Production resources, secrets, routes, bindings, billing, or deployments. PR #101 remains Draft.


### Execution Record — Secret Allowlist Precision and PR Overlap Review — 2026-11-01

- A focused review of .gitleaks.toml found three historical allowlists scoped to exact commit/path/rule but matching generic identifiers (MCP_AUTH_TOKEN, const SECRET, and const token) rather than the synthetic fixture literal. This was broader than the stated policy and could suppress a finding on those exact lines.
- Replaced all three regexes with exact matching of the verified synthetic 32-character fixture value, retaining the existing exact commit, file path, and target-rule constraints.
- Gitleaks run 41322485860 on head bf875196f574bed8d1f993e7758c9cb6c04a20f9 passed: 1,504 commits / approximately 5.28 MB / zero findings. The workflow's PR-diff scan and full-history scan both completed.
- PR #97 and PR #101 are both Draft and target the same base hardening/daily-neuron-budget at c0f3be179a62985aa9abf67dec8e10b39ba72518. PR #101 is the more complete canonical hardening candidate: it contains lockfiles, npm ci, moderate-level audit gates, full-history scanning, and the session/rate-limit/security-header fixes. PR #97's separate security-audit.yml duplicates scanning and uses npm install without committed lockfiles and npm audit --audit-level=high; merging both unchanged would create redundant and less reproducible checks.
- PR #97 contains potentially useful non-overlapping additions (.github/dependabot.yml, .gitignore, and .devcontainer permission/log hardening). These should be evaluated for selective porting; do not merge PR #97 wholesale or merge both Draft PRs as-is.
- Review limitation: Connector constantTimeEqual avoids early exit on differing content but loops to max(left.length, right.length), so execution remains length-dependent. Do not claim a strict constant-time guarantee. This is recorded for follow-up assessment; no timing benchmark or exploitability test has been performed.
- main remains unchanged at f2cae91de818385ec48daafc43c621b9e2cc0675 and unprotected. No merge, deployment, live secret mutation, or credential rotation was performed.

### Execution Record — Selective Repository Hygiene Carry-Forward and Reverification — 2026-11-01

- Selectively carried forward the two non-overlapping repository-hygiene controls identified in Draft PR #97 onto the canonical hardening branch:
  - Added root `.gitignore` entries for Node/Workers build artifacts, local environment files, Cloudflare vars, OpenClaw runtime state, logs, private-key material, and infrastructure state.
  - Added `.github/dependabot.yml` for weekly grouped npm updates in both Worker packages and weekly GitHub Actions updates.
- Did not copy PR #97's duplicate `security-audit.yml`, because this branch already has the canonical full-history Gitleaks workflow and deterministic `npm ci`/moderate-audit checks. Did not alter legacy Dev Container scripts in this pass.
- Current branch head after the two additions: `7eb202b97487a3424787ba17aa689a5ad8585cfa`.
- CI was rerun against this branch head:
  - Connector CI run `41323734196`: 152/152 tests passed; 0 failed; `npm audit --audit-level=moderate` reported 0 vulnerabilities; syntax checks and Production/Staging Wrangler dry-runs passed.
  - Cloud Agent CI run `41323734211`: 52/52 Node tests passed; 0 failed; 15/15 Cloudflare Workers runtime tests passed; npm audit reported 0 vulnerabilities; syntax checks and Wrangler dry-run passed.
  - Full-history Gitleaks run `41323734229`: PR diff scan covered 28 commits / approximately 73.75 KB with no leaks; all fetched refs covered 1,507 commits / approximately 5.28 MB with no leaks.
- Read-only GitHub verification: `main` remains at `f2cae91de818385ec48daafc43c621b9e2cc0675`; branch metadata reports `protected:false`. Repository rulesets endpoint returned an empty list. The separate branch-protection endpoint returned 403 to the connected integration, so detailed required-check settings could not be inspected.
- Read-only Cloudflare verification:
  - Production `chat-gpt111` still exposes the `GITHUB_TOKEN` binding as `plain_text`; the value was not read or logged.
  - Staging `chat-gpt111-staging` still has no `GITHUB_TOKEN` binding.
  - Production deployment version 31 (`6bdf25fa-a044-458b-a54d-93b3169911ac`) is 100% deployed, source `dash`, annotation `Add variable: GITHUB_TOKEN`, and has no source commit SHA annotation. Provenance to a tested commit is therefore unproven.
  - Staging deployment version 7 (`2caf6cae-f955-40c1-a612-841ced20b7e6`) points to commit `86f9e0fc72e0795a7fbe11a485d196ea19c02df0` / PR #85, not this hardening branch.
  - No live Worker mutation, deployment, secret read, credential rotation, billing change, or route change was performed.
- Draft PR state: #97, #96, and #101 remain open and unmerged. PR #96 contains a separate per-user identity design (`AGENT_USER_KEYS`, principal-bound sessions, 12/minute per-principal and 60/minute aggregate limits) but is not included in this hardening branch. The current Cloud Agent implementation remains owner/shared-token authenticated; multi-user tester rollout requires a separately reviewed integration of PR #96 and owner provisioning. No such provisioning was performed.
- Timing caveat remains: Connector `constantTimeEqual` and Agent `constantTimeTextEqual` avoid content-based early exit but have length-dependent work. They must not be described as a strict runtime constant-time guarantee; no timing benchmark has been performed.
- The Production `GITHUB_TOKEN` plain-text binding remains a P0 release blocker. The last-known Cloudflare account 2FA enforcement state is disabled; it was not rechecked in this read-only pass.
