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
- The release-approval guard is included in this SHA. Runbook updates are documentation-only and do not change Worker traffic, secrets, or deployments.
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
- With both intended client Origins (`https://claude.ai` and `https://chatgpt.com`), Staging `initialize` and `tools/list` return HTTP 200. The same tools list still has five tools with null annotations. `https://chat.openai.com` is rejected with HTTP 403 `forbidden_origin`.
- Unauthenticated `project_inspect`: JSON-RPC HTTP 200 with `isError=true`; underlying GitHub API returned HTTP 403 rate limit exceeded. This is consistent with the missing dedicated read-only token.

**Production runtime**
- `GET /healthz`: HTTP 200, but the legacy response exposes `github_configured=true` and `auth_configured=true` booleans. This is a configuration-presence disclosure (not secret-value disclosure) and differs from the candidate's tested health response, which does not disclose credential configuration.
- `GET /readyz`: HTTP 404 (`not_found`).
- MCP `initialize` and `tools/list` without a bearer token: HTTP 401 `unauthorized`. `https://claude.ai` and `https://chatgpt.com` pass the origin gate and reach HTTP 401 authentication; the Worker hostname and `https://chat.openai.com` return HTTP 403 `forbidden_origin`. This verifies the intended client Origins are allowlisted, but not authenticated acceptance.
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
- The current application-code candidate SHA is `b23eec24e5f2df74e778451d89da4096c75c2dfe`; the current runbook revision is documentation-only and does not change application code.
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

## 8.1 Live Cloudflare state audit — 2026-11-02 20:12 UTC+03:30

The following is a direct read-only observation of the currently deployed Workers and Cloudflare deployment metadata. It is not a test of the PR #129 candidate; the candidate is not deployed.

| Observation | Staging | Production |
|---|---|---|
| Worker | `chat-gpt111-staging` | `chat-gpt111` |
| Current 100% version | `b2ee9cb2-b52c-4c6e-9446-38405d257cc3` | `a07fbd3b-e44f-494e-a327-403a62661e05` |
| `GET /healthz` | HTTP 200 | HTTP 200 |
| `GET /readyz` | HTTP 404 | HTTP 404 |
| `GITHUB_READONLY_TOKEN` | Missing | Missing |
| `PUBLIC_READ_ONLY` | Plain-text `true` | Secret-text binding |
| `MCP_RATE_LIMITER` | Namespace `78294164` | Namespace `78294163` |
| `WRITE_CONTROL` | Namespace `1d0f4257b609483eba4fc5fdb39ed781` | Missing |

Staging's active deployment annotation explicitly identifies the current 100% version as a controlled rollback while the dedicated read-only GitHub token is absent. Production's active deployment is a dashboard deployment dated 2026-11-01; it is not the PR #129 candidate.

The HTTP 200 `/healthz` response is liveness only. The current live Workers return 404 for `/readyz`, so readiness is not established. The candidate source contains a `/readyz` probe that checks the Durable Object binding and schema version; this behavior must be validated after deploying that exact candidate to Staging.

The Cloudflare API returned the binding names and types only. No secret values were read. The GitHub integration returned HTTP 403 for `GET /branches/main/protection` (`Resource not accessible by integration`); current branch-protection state therefore remains unverified by this session and must not be treated as enabled.

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

## 10. Latest integrated Candidate verification — 2026-11-02

**Exact candidate SHA:** `0d32dabfa94250027a07dbf50f0b8785d079dfe0`  
**PR:** #129, base `integration/unify-main-and-integrated-2026-11-02`; Draft; mergeable; no independent reviews.

### Exact-head automated evidence
- Cloud Engineering Connector: **198 Node tests passed, 0 failed**; **41 Durable Object tests passed**; `npm audit` reported **0 vulnerabilities**; syntax and Wrangler configuration checks passed.
- Python/CTP: **1411 passed, 3 skipped, 4 collection warnings, 1050 subtests passed**.
- Master Brain MVP: **1414 passed, 3 skipped**; dedicated privileged kernel-enforcement suite **8/8 passed**; offline demo passed.
- Master Brain MCP CI, Cloud Agent CI, browser/accessibility checks, static informational workflow and full-history Gitleaks passed.
- All check-runs for this SHA completed with no failures. `post-deploy-staging-smoke` is intentionally skipped because this exact candidate has not been deployed; this is not live Staging acceptance.
- One duplicate Master Brain workflow attempt encountered a transient incomplete Python package download. The failed job was retried and completed successfully; a separate same-SHA run also passed.
- New security regression coverage paginates both associated PRs and PR review history. A `CHANGES_REQUESTED` review on page 2 blocks release approval; the test passed.

### History integrity
- Candidate is **956 commits ahead, 0 behind** `main`; observed `main` head remains `f2cae91de818385ec48daafc43c621b9e2cc0675`.
- Candidate is **203 ahead, 0 behind** the unified integration base and **786 ahead, 0 behind** the connector feature branch.
- No direct change to `main`, no squash and no history rewrite.

### Live release status
The Cloudflare audit remains unchanged: both Workers lack `GITHUB_READONLY_TOKEN`; Production `PUBLIC_READ_ONLY` remains a secret-text binding; Production has no `WRITE_CONTROL` binding; account MFA enforcement is disabled; Staging remains on the rollback version, not this candidate. GitHub `main` protection/rulesets are absent and PR #129 has no independent review. No Worker setting, secret, traffic, deployment, or `main` branch was modified.

**Decision:** CI is green for the exact candidate, but release remains **NO-GO** until the infrastructure, governance, independent review, Staging, and real Claude/ChatGPT acceptance gates above are satisfied.


## 11. Application-code verification snapshot (parent commit) — 2026-11-02

**Verified application-code parent SHA:** `5423b0e8a53427db2e22f8476eba65679f69e42b`  
**Parent:** `0d32dabfa94250027a07dbf50f0b8785d079dfe0`  
**Scope of this parent:** the parent commit was the previously verified application-code candidate. The current commit following it is a runbook-only documentation update; no Worker or Python source changed.  
**PR state at verification:** Draft, open, mergeable; zero submitted reviews and zero review threads.

### Exact-head CI evidence

The eight PR-triggered workflow runs associated with this exact SHA were completed with conclusion `success`:
- Cloud Engineering Connector CI: 198 Node tests and 41 Durable Object tests passed; npm audit reported 0 vulnerabilities; syntax and Wrangler checks passed.
- Python/CTP: 1411 passed, 3 skipped, 4 collection warnings, and 1050 subtests passed.
- Master Brain MVP: 1414 passed, 3 skipped; privileged kernel-enforcement suite 8/8 passed; offline demo passed.
- Master Brain MCP CI, Cloud Agent CI, real-browser/accessibility checks, static informational workflow, and full-history Gitleaks completed successfully.
- Post-deployment Staging smoke remains unexecuted for this candidate. A successful CI workflow does not establish live Staging acceptance.
- Static analysis remains informational, not clean: 37 Ruff E9/F findings and 50 Mypy diagnostics remain quality debt.

### Current release disposition

No candidate deployment or live account acceptance is evidenced by these workflow runs. The Cloudflare blockers, GitHub governance requirements, independent review, Staging acceptance, and real Claude/ChatGPT account acceptance documented above remain mandatory. This runbook update does not authorize deployment, merge, or Production traffic changes.

**Decision: NO-GO.**


## 12. Live Cloudflare binding re-audit after GitHub read-only token setup — 2026-11-02 19:22 UTC

This section supersedes only the stale token-presence statements in Sections 8–11; it does not erase the historical snapshots above.

### Read-only API evidence

The Cloudflare API confirmed the following binding names and types. Secret values were not read:

| Binding | Staging `chat-gpt111-staging` | Production `chat-gpt111` |
|---|---|---|
| `GITHUB_READONLY_TOKEN` | `secret_text` present | `secret_text` present |
| `GITHUB_TOKEN` | `secret_text` present | `secret_text` present |
| `MCP_AUTH_TOKEN` | `secret_text` present | `secret_text` present |
| `MCP_ALLOWED_ORIGINS` | `secret_text` present | `secret_text` present |
| `MCP_RATE_LIMITER` | namespace `78294164` | namespace `78294163` |
| `PUBLIC_READ_ONLY` | plain-text `true` | `secret_text` — invalid type for release preflight |
| `WRITE_CONTROL` | Durable Object namespace `1d0f4257b609483eba4fc5fdb39ed781` | missing |

### Active deployment identity

- Staging: 100% traffic on version 32, ID `2a3283f0-f443-4d51-885c-e30e4ff7434a`; version metadata identifies source `dash` and annotation `Add secret: GITHUB_READONLY_TOKEN`.
- Production: 100% traffic on version 34, ID `c6d24ebd-4ce9-425d-9b22-fc8d1d7b1362`; version metadata identifies source `dash` and annotation `Add secret: GITHUB_READONLY_TOKEN`.
- These are Dashboard-generated versions for binding changes, not a deployment of the immutable PR #129 code candidate. The candidate SHA remains `5e723a93c2a8c1587326dd4cf05ed85e954b9c87`; it has not passed the Staging release workflow or live acceptance.

### Current decision and next gates

1. The missing `GITHUB_READONLY_TOKEN` binding blocker is cleared on both Workers.
2. Staging's binding preflight is now structurally satisfied for the token, read-only flag, rate limiter and Durable Object namespace. Release still cannot proceed because PR #129 remains Draft and has no independent approval, and the GitHub Actions Staging environment credentials/reviewer controls have not been verified.
3. Production remains NO-GO: `PUBLIC_READ_ONLY` must be changed to a plain-text `true` variable; Production `WRITE_CONTROL` must be created by the reviewed migration and then verified as isolated from Staging.
4. Do not substitute `GITHUB_TOKEN` for `GITHUB_READONLY_TOKEN`; do not expose either secret value.
5. No Worker code deployment, traffic change, PR merge, or `main` update was performed during this audit.

**Updated disposition: Staging configuration preflight — PASS for the newly added token and existing required bindings; Staging release — BLOCKED pending independent PR approval and GitHub Actions environment controls; Production — NO-GO.**

## 13. Least-privilege release workflow hardening — 2026-11-02 20:02 UTC

**Current candidate SHA:** `1d03e3e4825a00b57fc4a247e7b319f480d9ef68`  
**PR:** #129, Draft / open; base remains `integration/unify-main-and-integrated-2026-11-02`.

### Security correction and regression coverage

- Removed `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from job-level environments in both Staging and Production release workflows.
- Removed both Cloudflare credentials from the immutable SHA-validation step. That step now validates only the release branch suffix against `GITHUB_SHA` and receives no Cloudflare deployment credential.
- Cloudflare credentials are scoped only to the named operational steps: Staging preflight, deploy, post-deploy confirmation, rollback; Production preflight, deploy, Durable Object namespace verification, post-deploy confirmation, rollback.
- Regression tests enforce: no job-level credential exposure, no credential exposure in SHA validation, and exact allowlisted step names and credential-pair counts.
- Valid red test evidence: connector CI run `41515105550` on the prior test commit failed exactly the two Staging/Production validation-step assertions because the credentials were still present in the SHA-validation step. The failure was the intended security regression, not an infrastructure error.
- Green evidence on current candidate `1d03e3e4825a00b57fc4a247e7b319f480d9ef68`: Cloud Engineering Connector CI run `41515317148` completed successfully. Logs show **200 Node tests passed, 0 failed**, **41 Durable Object tests passed**, `npm audit` passed, and JavaScript syntax/Wrangler configuration checks passed.
- Full-history Gitleaks run `41515317052` on the current candidate completed successfully.
- Master Brain MVP tests run `41515317302` on the current candidate were still in progress at this snapshot; do not treat them as passed until the final job conclusion is recorded.

### Cross-workflow verification context

- The preceding candidate `c13acf8e729aa2a408fb61704acf2c4f5b1a91aa` completed Cloud Engineering Connector CI, Python tests, Master Brain MVP tests, Master Brain MCP CI, Cloud Agent CI, browser/accessibility checks, full-history Gitleaks, and informational static checks successfully. That preceding candidate did not include the latest allowlist-test refinement and workflow validation-step cleanup; therefore it is supporting regression context, not a substitute for current-head verification.
- Static checks remain informational and are not a release gate. Existing Ruff/Mypy diagnostics are quality debt and must not be described as a clean static-analysis result.

### Repository governance and live deployment

- The repository Rulesets API returned an empty list. The branch-protection endpoint for `main` returned HTTP 403 `Resource not accessible by integration`; therefore this session cannot independently assert the complete classic branch-protection state. Required review/status enforcement remains unverified.
- The GitHub Actions Environments endpoint is not available through the connected GitHub integration in this session; environment reviewer/secret configuration remains unverified.
- No PR review has been submitted; PR #129 remains Draft. No release workflow or post-deploy Staging smoke has run for the current candidate.
- Cloudflare binding facts and active version IDs remain as recorded in Section 12. Production still has invalid `PUBLIC_READ_ONLY` binding type and missing `WRITE_CONTROL`; no Worker setting, deployment, traffic, merge, or `main` update was performed.

**Disposition:** application CI for the connector and full-history secret scan are green on the current candidate; Master Brain MVP current-head result is pending. Staging release remains blocked pending independent approval and environment controls; Production remains NO-GO.

## 14. Production binding semantics recheck — 2026-11-02 20:03 UTC

Read-only Cloudflare API recheck of both Worker settings was performed. Secret values were not read.

- Staging `chat-gpt111-staging`: `GITHUB_READONLY_TOKEN`, `GITHUB_TOKEN`, `MCP_AUTH_TOKEN`, and `MCP_ALLOWED_ORIGINS` are `secret_text`; `PUBLIC_READ_ONLY` is plain-text `true`; `MCP_RATE_LIMITER` and `WRITE_CONTROL` are bound to the Staging-specific namespaces. The active 100% version remains Dashboard-generated version `2a3283f0-f443-4d51-885c-e30e4ff7434a`, not the PR #129 candidate.
- Production `chat-gpt111`: the four GitHub/MCP secrets are present as `secret_text`; its rate limiter has a namespace distinct from Staging; `PUBLIC_READ_ONLY` is still `secret_text` and therefore fails the Production preflight requirement for `plain_text` exactly equal to `true`. The active 100% version remains Dashboard-generated version `c6d24ebd-4ce9-425d-9b22-fc8d1d7b1362`, not the PR #129 candidate.
- Production `SERVICE_MODE` is also a `secret_text` binding, while Staging has a plain-text `SERVICE_MODE=cloud`. Inspection of the current Connector runtime files (`worker.js`, `index.js`, `console.js`, `write-control.js`, and release approval code) found no runtime reference to `SERVICE_MODE`; the Wrangler environment contract test explicitly asserts that it is not declared in `wrangler.toml`. Treat the existing Production binding as an unused legacy setting, not a release blocker, and do not mutate it without a demonstrated consumer.
- Production `WRITE_CONTROL` is currently absent. The checked-in `wrangler.toml` defines the `WriteControl` Durable Object and SQLite migration `v1`; Production preflight deliberately allows a first deployment with no existing namespace, then the post-deploy verification step checks that the migration created an isolated Production namespace distinct from Staging. Therefore the absence is a mandatory migration/post-deploy verification condition, not a reason to create an unrelated namespace manually in advance.
- Production's hard configuration blocker from this recheck is `PUBLIC_READ_ONLY` type/value. No binding, secret, Worker deployment, traffic, or account setting was changed.

**Corrected disposition:** Staging binding configuration preflight is structurally satisfied, but Staging release remains blocked by independent PR approval and unverified GitHub Actions environment controls. Production remains NO-GO until `PUBLIC_READ_ONLY` is changed to a non-secret `plain_text` value `true`, and the first Production Durable Object migration plus post-deploy isolation verification are proven.

## 15. Exact-head integrated CI closure — 2026-11-02 20:07 UTC

**Exact verified candidate SHA:** `0000c55af28eec81247647e726b559c448385664` (the current PR head at this audit).

At least one PR-triggered run for every workflow below completed with conclusion `success` on this exact SHA:

- Cloud Engineering Connector CI (`41515819702`): **200 Node tests passed, 0 failed; 41 Durable Object tests passed; npm audit found 0 vulnerabilities; syntax and Wrangler configuration checks passed**.
- Python tests (`41515810136`): **1411 passed, 3 skipped, 4 warnings; 1050 subtests passed**.
- Master Brain MVP tests (`41515810384`): **1414 tests passed with 3 skipped**; kernel-enforcement suite **8/8 passed**; offline demo completed successfully.
- Web client checks / real browser / accessibility (`41515819406`): passed.
- Master Brain MCP CI (`41515819613`): passed.
- Cloud Agent CI (`41515819358`): passed.
- Full History Secret Scan / Gitleaks (`41515819691`): passed.
- Static checks workflow (`41515819633`): workflow completed successfully, but it is informational only and its commands intentionally tolerate findings. The log reports **37 Ruff E9/F findings and 50 Mypy diagnostics**. This remains a material quality-debt item; the green workflow status must not be misrepresented as clean static analysis.

Duplicate same-SHA runs were observed for Python and Master Brain MVP; one completed successfully for each. The remaining duplicate attempts were still in progress at the time of the audit and do not invalidate the completed successful runs.

### Updated disposition

- Automated CI on the exact current candidate: **PASS** for all eight workflow families listed above.
- Release-workflow least-privilege regression: **PASS** on the exact candidate; Cloudflare credentials are absent from job-level env and immutable-SHA validation, and are constrained to allowlisted operational steps.
- Live Staging deployment and live MCP acceptance: **NOT RUN** for this candidate; the Staging smoke job is intentionally skipped until approval/deployment gates are satisfied.
- GitHub independent review and environment controls: **NOT SATISFIED / NOT VERIFIED**. PR #129 remains Draft with zero reviews. Rulesets API returned an empty list; classic branch-protection read was denied to this integration.
- Production: **NO-GO** because `PUBLIC_READ_ONLY` remains a secret binding instead of plain-text `true`. First Production deployment must also prove the Durable Object migration and post-deploy namespace isolation check.
- Static-analysis debt: **OPEN** (37 Ruff findings, 50 Mypy diagnostics).

**No merge, deployment, Worker setting mutation, traffic change, or `main` update occurred.**


## 16. Fail-closed Worker observability release gate — 2026-11-02 20:23 UTC

**Current PR candidate SHA:** `6f07797ac4abd6452bd6f110b1bbdf80c24d53ea`  
**PR:** #129, Draft / open; base remains `integration/unify-main-and-integrated-2026-11-02`.

### Verified live configuration (read-only)

- Staging `chat-gpt111-staging`: `observability.enabled=true`, `head_sampling_rate=1`, `redact_query_string=true`, persistent logs enabled, persistent log sampling rate 1, and invocation logs disabled.
- Production `chat-gpt111`: the Worker settings response contains no `observability` object; `logpush=false`. This remains a verified production observability gap.
- Cloudflare account `enforce_twofactor=false`; account-level MFA enforcement remains disabled.
- No Worker setting, binding, secret, account security control, deployment, or traffic was changed.

### Regression evidence and implementation

- The test harness executes the actual Node preflight script extracted from each release workflow and supplies controlled Cloudflare API responses with `observability: null`.
- Valid red on prior test candidate `4c487871f59d9701c413a7f01641f9795c4d9973`: Connector CI `41517524646` completed with 200/202 tests passing and two failures. Both failures were the new Staging/Production assertions: the preflight scripts returned exit status 0 despite missing observability. This demonstrated a genuine fail-open release gate.
- Corrected both release workflows. Before capturing rollback target or allowing deploy to proceed, each now asserts: observability enabled; query-string redaction enabled; top-level custom-log sampling rate 100%; persistent logs enabled and persisted; persistent-log sampling rate 100%; invocation logs disabled.
- The checks match the observed secure Staging settings and reject the current missing Production observability object.
- Current candidate Connector CI `41518548916`: **202/202 Node tests passed, 0 failed; npm audit reported 0 vulnerabilities; JavaScript syntax and Wrangler configuration checks passed.**
- Current candidate Full History Gitleaks `41518548770`: passed.
- Current candidate Master Brain MCP CI `41518548771`: passed.
- At the time this section was written, Python tests, Master Brain MVP tests, and browser/accessibility checks were still running; do not mark them complete until their exact-head runs conclude.

### Current release decision

- **Staging:** configuration supports the new observability gate, but no candidate deployment or live MCP acceptance has occurred. PR #129 remains Draft with no independent approval; GitHub Actions environment reviewer/secret controls and branch-protection enforcement remain unverified.
- **Production:** NO-GO. Observability is missing; `PUBLIC_READ_ONLY` remains a `secret_text` binding instead of plain-text `true`; first deployment must verify the Durable Object migration and namespace isolation. Cloudflare account MFA enforcement is also disabled.
- Static-analysis debt remains open (the last recorded run reported 37 Ruff E9/F findings and 50 Mypy diagnostics; static workflow is informational and is not a clean-analysis guarantee).
- Actual Claude and ChatGPT client compatibility is not yet proven by independent live client sessions.
- No merge, deployment, traffic shift, Worker setting mutation, secret read, or `main` update occurred.

**Disposition:** Observability release gate — implemented and Connector CI PASS; exact-head cross-workflow CI — partial/pending; Staging — blocked pending independent approval and governance verification; Production — NO-GO.

## Temporary read-only Staging smoke trigger

This branch exists only to execute the `post-deploy-staging-smoke` job against the already-active Staging Worker. It does not deploy code, change Worker settings, shift traffic, or merge into another branch.
