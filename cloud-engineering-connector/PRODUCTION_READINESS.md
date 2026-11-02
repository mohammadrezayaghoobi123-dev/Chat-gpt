# Production Readiness and Release Runbook

**Snapshot date:** 2026-11-02  
**Release status:** BLOCKED — do not promote to Production.

This document is the release gate for the Cloud Engineering Connector. A green unit-test run is necessary but does not constitute a production release.

## 1. Verified engineering evidence

| Gate | Latest evidence | Status |
|---|---|---|
| Node test suite | 196 passed, 0 failed | PASS |
| Vitest Durable Object suite | 41 passed, 0 failed | PASS |
| npm dependency audit | 0 reported vulnerabilities | PASS |
| JavaScript syntax and Wrangler configuration checks | CI job passed | PASS |
| Python static analysis baseline | Informational workflow: 37 Ruff F/E findings and 50 Mypy diagnostics; workflow intentionally uses `|| true` | FINDINGS — not clean |
| Gitleaks | PR diff and fetched refs scan passed | PASS |
| MCP transport / Claude protocol | Unit and Staging-era smoke coverage includes 2025-06-18 and modern discovery | PARTIAL |
| Live Staging smoke for this PR head | Skipped; this candidate is not deployed | BLOCKED |
| GitHub live read-only integration | Current Staging candidate hit GitHub unauthenticated rate limit; dedicated token not configured | BLOCKED |
| Claude account acceptance | Must be executed in the user's Claude account | BLOCKED |
| Production deployment | Not performed | BLOCKED |

### Latest exact-head CI evidence — 2026-11-02

- Integrated release candidate PR: [#129](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/129), branch `assistant/unified-product-release-candidate-2026-11-02`.
- Exact application-code SHA with a fully green CI matrix: `b23eec24e5f2df74e778451d89da4096c75c2dfe`.
- The release-approval guard is included in this SHA. A subsequent runbook-only update will trigger Connector CI again; no Worker deployment is part of this documentation change.
- Current `main` head: `f2cae91de818385ec48daafc43c621b9e2cc0675`; the candidate compares as 945 commits ahead and 0 behind. No commit was pushed to `main`.
- Connector CI: PASS; **196 Node tests and 41 Durable Object tests** passed; npm audit reported 0 vulnerabilities; Wrangler configuration checks passed.
- Cloud Agent CI: PASS.
- Master Brain MCP CI: PASS.
- Master Brain MVP: PASS; 1414 tests passed, 3 skipped. Dedicated privileged kernel enforcement: **8/8 passed**, including seccomp, process-flood, aggregate-memory-flood, disk-flood/ENOSPC and kernel-limit recording.
- Python tests: PASS; **1411 passed, 3 skipped, 4 collection warnings, 1050 subtests passed**.
- Browser/accessibility checks: PASS.
- Full-history Gitleaks: PASS.
- Static analysis is **not clean**: the informational workflow reported 37 Ruff F/E findings and 50 Mypy diagnostics. It uses `|| true`, so a green workflow means the analyzers completed, not that the code passed lint/type checks. Treat this as tracked quality debt; do not report Static Clean.
- All checks on the exact candidate are complete and successful except `post-deploy-staging-smoke`, intentionally skipped because this candidate is not deployed. CI green is not live Staging acceptance.
- The process-flood regression test asserts the runner's fail-closed cgroup-event result rather than assuming the killed child flushed buffered stdout.
- Release governance is enforced in both release workflows: Staging requires an open, non-draft PR whose head SHA is exactly the release SHA and whose base is the approved integration branch; Production requires a merged PR to `main` whose merge commit equals the release SHA. Both require an independent APPROVED review on the PR head, reject self-approval and stale approvals, and block an outstanding `CHANGES_REQUESTED` review. The read-only GitHub token is injected only into the approval step.

PR: [#129](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/129)  
Base: `integration/unify-main-and-integrated-2026-11-02`  
PR remains Draft; no independent review has been submitted.
## 2. Required Cloudflare secrets and bindings

Configure secrets directly in the Cloudflare dashboard. Never paste secret values into chat, source code, PR comments, workflow logs, or test fixtures.

### Staging Worker: `chat-gpt111-staging`

Required:
- `GITHUB_READONLY_TOKEN`: fine-grained PAT restricted to `mohammadrezayaghoobi123-dev/Chat-gpt`, with **Metadata: Read-only** and **Contents: Read-only** only.
- `GITHUB_TOKEN`: separate credential for authenticated draft-PR creation; grant only the repository permissions required for Contents and Pull requests.
- `MCP_AUTH_TOKEN`: high-entropy bearer token, 32–512 characters.
- `MCP_ALLOWED_ORIGINS`: explicit browser origins only; same-origin console requests are allowed without broad CORS.
- `PUBLIC_READ_ONLY=true`: required for the anonymous Staging acceptance profile.

Bindings:
- `MCP_RATE_LIMITER`: independent Staging rate-limit namespace.
- `WRITE_CONTROL`: Staging Durable Object namespace created by the checked-in SQLite migration.

The Worker strips `GITHUB_TOKEN` from anonymous read-only execution and requires `GITHUB_READONLY_TOKEN`. It does not fall back to unauthenticated GitHub quota. Authenticated draft-PR creation requires both `MCP_AUTH_TOKEN` and `GITHUB_TOKEN`.

### Production Worker: `chat-gpt111`

Before promotion, configure the same secret names with Production-specific values and separate Production-only Durable Object and rate-limit namespaces. Never reuse Staging namespace IDs for Production. The non-secret `PUBLIC_READ_ONLY` flag must be configured as a verifiable plain-text value `true`; the Production release preflight rejects a secret-text binding because its value cannot be safely verified without reading secret material.

## 3. GitHub token creation

Create `GITHUB_READONLY_TOKEN` in GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:
1. Restrict resource owner to the repository owner.
2. Select only repository `Chat-gpt`.
3. Grant **Metadata: Read-only** and **Contents: Read-only**.
4. Do not grant Pull requests, Contents write, Actions, Administration, organization, or other permissions.
5. Store it directly as a Cloudflare Worker Secret named `GITHUB_READONLY_TOKEN` on both Staging and Production, using separate credential values where possible. Do not transmit it to ChatGPT.

Keep `GITHUB_TOKEN` separate for the authenticated draft-PR operation. Review and rotate it if its current permissions or provenance are unknown.

## 4. Controlled Staging deployment

The repository includes `.github/workflows/connector-staging-release.yml`. It is intentionally triggered only by a push to a branch named `integration/staging-release-<full-40-character-commit-sha>`. The branch suffix must equal the pushed commit SHA, so the deployed candidate is immutable. The job uses the GitHub Actions `staging` environment, runs the immutable-SHA and independent-review guard before dependency installation, then runs the full test/audit/Wrangler dry-run gates, verifies the required Cloudflare Worker secret binding names without reading values, captures the active immutable version ID, deploys only `chat-gpt111-staging`, and executes `test/staging-smoke.mjs`. The review guard requires an open, non-draft PR whose exact head SHA is the release SHA, base is `integration/unify-main-and-integrated-2026-11-02`, and latest independent review is APPROVED on that exact head. Self-approval, stale approval, or an outstanding change request blocks deployment. `RELEASE_GITHUB_TOKEN` has only `pull-requests: read` and is injected only into the approval step. The smoke script validates that `GITHUB_REF_NAME` is exactly `integration/staging-release-${GITHUB_SHA}` and pins GitHub file/architecture reads to that immutable commit. If live acceptance fails after deployment, it attempts to restore the captured 100% version through the Cloudflare deployment API and checks Staging liveness.

Required GitHub Actions configuration: environment `staging` must contain secret `CLOUDFLARE_API_TOKEN` with Workers Scripts Read/Edit permissions and variable `CLOUDFLARE_ACCOUNT_ID`. Configure required reviewers for the environment. The repository's independent PR-review guard is mandatory even if environment protection is unavailable. The Cloudflare Worker must already contain the Worker secrets listed above; the workflow checks only binding names/types and never retrieves secret values. A missing `GITHUB_READONLY_TOKEN` fails preflight before deployment.

To release a reviewed candidate, create a branch from the exact approved 40-character SHA using the naming convention `integration/staging-release-<SHA>`. Do not reuse an old release branch or change its commit after the release run begins.

### Current release state — 2026-11-02

- Current application-code candidate: `b23eec24e5f2df74e778451d89da4096c75c2dfe` (PR #129, Draft).
- No release branch has been created for this SHA and no candidate deployment has been performed.
- The latest previous guarded Staging attempt failed before deployment because the GitHub Actions `staging` environment lacked `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Do not reuse that older release branch.
- Current Cloudflare settings independently show that Staging still lacks `GITHUB_READONLY_TOKEN`; its workflow preflight will block before deployment.
- Do not create `integration/staging-release-<SHA>` until the GitHub Actions environment contains the Cloudflare token/account ID and the Staging Worker has the required GitHub read-only secret. Then use the exact reviewed candidate SHA and run the immutable release workflow.
## 4A. Live Cloudflare state — current configuration audit

The Cloudflare API was read directly on 2026-11-02. This inspection did not change Worker code, traffic, secrets, routes, or bindings.

| Item | Staging `chat-gpt111-staging` | Production `chat-gpt111` |
|---|---|---|
| Latest deployment | `df3a13c1-df48-4736-8682-0503abebd8d1` | `864256de-1985-428d-8943-c372b0af5ebd` |
| Active version | `b2ee9cb2-b52c-4c6e-9446-38405d257cc3` (100%) | `a07fbd3b-e44f-494e-a327-403a62661e05` (100%) |
| `GITHUB_READONLY_TOKEN` | MISSING | MISSING |
| `GITHUB_TOKEN` | secret binding present | secret binding present |
| `MCP_AUTH_TOKEN` | secret binding present | secret binding present |
| `MCP_ALLOWED_ORIGINS` | secret binding present | secret binding present |
| `PUBLIC_READ_ONLY` | plain-text `true` | secret-text — INVALID TYPE; value cannot be verified |
| `MCP_RATE_LIMITER` | namespace `78294164` | namespace `78294163` |
| `WRITE_CONTROL` | namespace `1d0f4257b609483eba4fc5fdb39ed781` | MISSING |

The rate-limit namespaces are distinct. The Staging Durable Object namespace exists and is attached to the Staging Worker. No Production `WRITE_CONTROL` namespace appears in the current Worker settings or account namespace inventory. Production preflight must therefore continue to block until its migration creates the namespace and post-deploy verification confirms isolation.

Fresh live runtime probes were completed on 2026-11-02 against the active deployments above; these are rollback versions, not the PR #129 candidate.

**Staging runtime**
- `GET /healthz`: HTTP 200; reports `status=ok`, Cloudflare Workers execution, `laptop_dependency=false`, Durable Objects and MCP status.
- `GET /readyz`: HTTP 404 (`not_found`).
- MCP `initialize`: HTTP 200 for both protocol versions `2025-06-18` and `2025-11-25`.
- MCP `tools/list`: HTTP 200, five tools; every tool has `annotations=null`. The anonymous tool list correctly omits authenticated `create_change_pr`.
- Unauthenticated `project_inspect`: JSON-RPC HTTP 200 with `isError=true`; underlying GitHub API returned HTTP 403 rate limit exceeded. This is consistent with the missing dedicated read-only token.

**Production runtime**
- `GET /healthz`: HTTP 200, but the legacy response exposes `github_configured=true` and `auth_configured=true` booleans. This is a configuration-presence disclosure (not secret-value disclosure) and differs from the candidate's tested health response, which does not disclose credential configuration.
- `GET /readyz`: HTTP 404 (`not_found`).
- MCP `initialize` and `tools/list` without a bearer token: HTTP 401 `unauthorized`. A probe using the Worker hostname as the Origin returned HTTP 403 `forbidden_origin`; the actual Claude/ChatGPT client origins must be validated against the configured allowlist.
- No valid bearer token was used or retrieved, and no authenticated Production tool call was attempted.

These probes establish protocol reachability of legacy Workers only. They do not establish readiness, GitHub integration, annotation compliance, current-candidate deployment, or actual Claude-account acceptance. A successful `initialize` or `tools/list` alone is not end-to-end acceptance.

**Conclusion:** Staging is a rollback version, not the candidate. Production has a non-verifiable public-read-only flag and no write-control namespace. Both Workers lack the dedicated GitHub read-only credential. No deployment or promotion is authorized.
## 5. Staging acceptance sequence

After the Staging secrets are configured:

1. Deploy the exact reviewed PR #127 head to `chat-gpt111-staging` only.
2. Record the immutable Cloudflare version ID and preserve the last known-good version ID for rollback.
3. Verify `GET /healthz` returns HTTP 200 and `status=ok`. This endpoint is liveness only.
4. Verify `GET /readyz` returns HTTP 200 and `status=ready`, with the Durable Object ping successful.
5. Run `test/staging-smoke.mjs` against the deployed URL. It must verify:
   - security headers and same-origin console;
   - `GET /mcp` returns 405 with POST-only contract;
   - missing and invalid bearer tokens are rejected where authentication is required;
   - anonymous read-only `tools/list` returns only the five read-only tools;
   - every tool has title, read-only and destructive annotations;
   - Claude-supported legacy initialization and modern discovery;
   - real GitHub repository inspection and file read using `GITHUB_READONLY_TOKEN`;
   - `architecture_analyze` returns bounded, line-grounded evidence;
   - `create_change_pr` is never advertised anonymously.
6. Connect the Staging URL in the actual Claude account and execute a read-only repository inspection. Protocol tests alone do not prove the external client connection.
7. Run the full CI and Gitleaks workflows on the exact deployed commit.
8. Review logs for token leakage, unexpected 401/403, GitHub quota errors, rate-limit bypass, Durable Object exceptions, or unexpected write operations.

Do not treat a passing `/healthz` as proof that MCP, GitHub, or the Durable Object is ready.

## 6. Superproject integration topology

The active integrated candidate is PR #129, branch `assistant/unified-product-release-candidate-2026-11-02`, based on `integration/unify-main-and-integrated-2026-11-02`.

- PR #129 contains the unified Master Brain/Python/CTP history and the Cloud Engineering Connector / Cloud Agent feature history through a real merge commit. The merge topology preserves both parent histories; do not squash or rewrite it.
- PR #127 is a feature-history/audit reference incorporated into PR #129; do not merge it separately to `main`.
- The current application-code candidate SHA is `b23eec24e5f2df74e778451d89da4096c75c2dfe`; the runbook-only commit is `9264780df3cfd2f82f9c0d953d75b1f3617d7c04`.
- Current `main` remains `f2cae91de818385ec48daafc43c621b9e2cc0675`; GitHub compare reports the candidate as 945 commits ahead and 0 behind.
- PR #129 is Draft, mergeable, and has zero submitted reviews at the latest check. The new Staging release guard will reject it until it is marked ready and an independent reviewer approves the exact current head.
- Keep all changes on the candidate branch. Do not merge to `main`, close superseded audit PRs, or rewrite history until independent review, governance controls, and release gates are satisfied.
## 7. Production release gates

Production remains **NO-GO** until every mandatory item has current evidence:

- PR #129 receives an independent approval from a reviewer other than the PR author. It is currently Draft with zero submitted reviews. The Staging workflow enforces this on the exact PR head; the Production workflow additionally requires a merged PR to `main` with an exact merge-commit match.
- The Production release workflow requires the release SHA to be the exact merge commit of a merged PR to `main`; it verifies an independent APPROVED review on that PR's exact head commit and blocks any outstanding change request. Its read-only GitHub token is scoped only to the approval step.
- GitHub governance is enforced: a `main` ruleset must require PR reviews and the relevant status checks, prohibit force pushes and deletion, and restrict direct pushes. The last live governance audit reported `main.protected=false` and an empty repository rulesets list. No merge is allowed until this is corrected and verified.
- GitHub Actions `staging` and `production` environments contain the correct Cloudflare API token secret and account ID variable. Both environments must require human approval; the independent PR-review guard is enforced in code.
- Cloudflare account MFA enforcement is enabled and independently verified. The last account-level read reported `enforce_twofactor=false`; re-check before release.
- Both Workers have `GITHUB_READONLY_TOKEN` as a secret binding; Production also has separate write credential and valid auth/origin secrets.
- Production `PUBLIC_READ_ONLY` is a plain-text Worker variable with exact value `true`, not a secret binding.
- Production and Staging rate-limit namespaces and `WRITE_CONTROL` Durable Object namespaces are distinct. Production's current `WRITE_CONTROL` binding is absent; the checked-in migration and post-deploy namespace check must create and verify it.
- Exact candidate SHA is deployed to Staging; `/healthz`, `/readyz`, MCP initialization, tool discovery/annotations, authenticated GitHub reads, architecture analysis, denial boundaries and rollback all pass.
- Claude-account acceptance is performed in the actual user account. Protocol smoke tests are not a substitute.
- Production smoke passes after the controlled deployment; an immutable rollback target, monitoring, alerting, backup/restore, incident ownership and credential rotation are verified.
- A second independent security review checks the full candidate diff, authentication, write admission, secret redaction, Durable Object state transitions, supply-chain integrity and rollback behavior.

Do not treat a successful CI matrix as approval to deploy or merge.
## 8. Production rollout and rollback

Use a controlled rollout only after explicit release approval:
1. Create an immutable Worker version and verify its metadata and bindings.
2. Deploy 5–10% traffic, observe health, errors, latency, rate limits and Durable Object behavior.
3. Increase to 50%, then 100% only after the prior stage remains clean.
4. Keep the immediately previous known-good version available.
5. Roll back by deploying the previous immutable version ID; do not delete or recreate Durable Object namespaces as a rollback mechanism.
6. After rollback, verify `/healthz`, `/readyz`, MCP initialize and the read-only tool contract.

The Durable Object terminal-operation retention policy is 30 days. Unresolved UNKNOWN/IN_PROGRESS operations must not be deleted to clear backlog; resolve or reconcile them through the documented state machine.

## 9. Current external blockers

1. GitHub Actions Staging environment is missing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (last recorded guarded release attempt failed before deployment).
2. Both Cloudflare Workers lack `GITHUB_READONLY_TOKEN`; Staging preflight will block.
3. Production `PUBLIC_READ_ONLY` is currently a secret-text binding, not a verifiable plain-text `true`.
4. Production has no `WRITE_CONTROL` binding/namespace; the Production migration has not been applied.
5. The latest active Staging deployment is the rollback version, not PR #129. The new release guard also prevents a Draft or unapproved PR from being deployed. Its last verified `/readyz` response was HTTP 404 and its old MCP tool annotations were null.
6. No independent PR #129 review exists; PR #129 remains Draft.
7. GitHub `main` protection/ruleset was previously observed absent. Required review/status enforcement must be established before merge.
8. Cloudflare account MFA enforcement was previously observed disabled; re-check and enable.
9. Actual Claude-account connection and tool invocation remain unverified.
10. Production monitoring, alerting, backup/restore and incident response have not been demonstrated.

**Release decision:** NO-GO. The exact candidate is CI-green, but live Staging acceptance, independent review, governance, and Production configuration are not complete.