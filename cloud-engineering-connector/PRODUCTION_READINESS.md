# Production Readiness and Release Runbook

**Snapshot date:** 2026-11-02  
**Release status:** BLOCKED — do not promote to Production.

This document is the release gate for the Cloud Engineering Connector. A green unit-test run is necessary but does not constitute a production release.

## 1. Verified engineering evidence

| Gate | Latest evidence | Status |
|---|---|---|
| Node test suite | 184 passed, 0 failed | PASS |
| Vitest Durable Object suite | 41 passed, 0 failed | PASS |
| npm dependency audit | 0 reported vulnerabilities | PASS |
| JavaScript syntax and Wrangler configuration checks | CI job passed | PASS |
| Gitleaks | PR diff and fetched refs scan passed | PASS |
| MCP transport / Claude protocol | Unit and Staging-era smoke coverage includes 2025-06-18 and modern discovery | PARTIAL |
| Live Staging smoke for this PR head | Skipped; this candidate is not deployed | BLOCKED |
| GitHub live read-only integration | Current Staging candidate hit GitHub unauthenticated rate limit; dedicated token not configured | BLOCKED |
| Claude account acceptance | Must be executed in the user's Claude account | BLOCKED |
| Production deployment | Not performed | BLOCKED |

### Latest exact-head CI evidence — 2026-11-02

- Reviewed PR #127 head: `f3d50d9a32f7c5d1f8847d351e3ebe9c6d6a376c`.
- Cloud Engineering Connector PR CI run [41469740201](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/41469740201): success. Node suite: **184 passed, 0 failed**; Cloudflare Workers/SQLite Durable Object suite: **41 passed, 0 failed**; `npm audit --audit-level=moderate`: **0 vulnerabilities**; syntax checks and Production/Staging Wrangler dry-runs completed successfully.
- Full History Secret Scan run [41469740313](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/41469740313): success on the PR diff and fetched refs.
- TDD evidence: the new immutable-candidate smoke contract test failed as expected on intermediate commit `23c863b1117f94860f353c055fdf0d96803cf857` because the Staging smoke used a hard-coded branch. The fix adds `resolveCandidateRef`, requires `RELEASE_ENV`, and verifies that `GITHUB_REF_NAME` exactly matches `GITHUB_SHA`. Repository inspection now uses the release branch; file reads and architecture analysis use the exact commit SHA.
- The CI `post-deploy-staging-smoke` job was **skipped** because this PR head is not deployed to Staging. This is not live acceptance.
- Removed unsupported top-level and `env.staging.tags` fields from `wrangler.toml`; the regression assertion and exact-head Wrangler dry-runs pass without the prior warnings.


PR: [#127](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/127)  
Base: `integration/durable-write-control-release` (consolidated write-control line)  
`main` was not modified; its observed head remained `f2cae91`.

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

Before promotion, configure the same secret names with Production-specific values and separate Production-only Durable Object and rate-limit namespaces. Never reuse Staging namespace IDs for Production.

## 3. GitHub token creation

Create `GITHUB_READONLY_TOKEN` in GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**:
1. Restrict resource owner to the repository owner.
2. Select only repository `Chat-gpt`.
3. Grant **Metadata: Read-only** and **Contents: Read-only**.
4. Do not grant Pull requests, Contents write, Actions, Administration, organization, or other permissions.
5. Store the token directly as a Cloudflare Worker Secret named `GITHUB_READONLY_TOKEN` on Staging. Do not transmit it to ChatGPT.

Keep `GITHUB_TOKEN` separate for the authenticated draft-PR operation. Review and rotate it if its current permissions or provenance are unknown.

## 4. Controlled Staging deployment

The repository includes `.github/workflows/connector-staging-release.yml`. It is intentionally triggered only by a push to a branch named `integration/staging-release-<full-40-character-commit-sha>`. The branch suffix must equal the pushed commit SHA, so the deployed candidate is immutable. The job uses the protected GitHub Actions `staging` environment, runs the full test/audit/Wrangler dry-run gates, verifies the required Cloudflare Worker secret binding names without reading values, captures the active immutable version ID, deploys only `chat-gpt111-staging`, and executes `test/staging-smoke.mjs`. The smoke script validates that `GITHUB_REF_NAME` is exactly `integration/staging-release-${GITHUB_SHA}` and pins GitHub file/architecture reads to that immutable commit. If live acceptance fails after deployment, it attempts to restore the captured 100% version through the Cloudflare deployment API and checks Staging liveness.

Required GitHub Actions configuration: environment `staging` must contain secret `CLOUDFLARE_API_TOKEN` with Workers Scripts Read/Edit permissions and variable `CLOUDFLARE_ACCOUNT_ID`. Configure required reviewers for the environment if available. The Cloudflare Worker must already contain the Worker secrets listed above; the workflow checks only binding names/types and never retrieves secret values. A missing `GITHUB_READONLY_TOKEN` fails preflight before deployment.

To release a reviewed candidate, create a branch from the exact approved 40-character SHA using the naming convention `integration/staging-release-<SHA>`. Do not reuse an old release branch or change its commit after the release run begins.

### Latest guarded release attempt

- Candidate: `8fcb434af5def0b5d41529aaeb2f6bcd37fd8e13`
- Release branch: `integration/staging-release-8fcb434af5def0b5d41529aaeb2f6bcd37fd8e13`
- GitHub Actions run: [41464809638](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/41464809638)
- Result: **blocked before deployment**. The workflow's first credential guard reported that the GitHub Actions `staging` environment is missing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. All deployment, smoke, and rollback steps were skipped. No Cloudflare Worker version was changed by this attempt.
- Next action: add those two values to the GitHub Actions environment `staging`. The PR head has advanced since this failed attempt, so do not rerun this older branch. The current exact PR #127 head is `f3d50d9a32f7c5d1f8847d351e3ebe9c6d6a376c` and its source CI is green. Do not create a release branch until the GitHub Actions `staging` environment contains `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and the Staging Worker contains the required `GITHUB_READONLY_TOKEN`. Then create a new branch named `integration/staging-release-<current-full-SHA>`. Cloudflare Worker preflight will independently verify the required bindings before deployment.

## 4A. Live Staging observation — rolled-back version only

The currently active Staging deployment was inspected without changing Worker code, traffic, secrets, routes, or bindings:

- Worker: `chat-gpt111-staging`; active version: `b2ee9cb2-b52c-4c6e-9446-38405d257cc3` at 100%; deployment ID: `df3a13c1-df48-4736-8682-0503abebd8d1`.
- `GET /healthz`: HTTP 200; response reported `status=ok`, Cloudflare Workers execution, `laptop_dependency=false`, `durable_objects=ok`, and `mcp=ok`.
- `GET /readyz`: HTTP 404 `not_found`. This is the rolled-back version, not the PR #127 candidate; it does not implement the candidate's readiness route.
- Read-only `POST /mcp` `tools/list`: HTTP 200; exactly five tools were advertised: `project_inspect`, `read_project_file`, `engineering_standards`, `architecture_review`, and `architecture_analyze`.
- Live `project_inspect` against the public GitHub repository returned a JSON-RPC tool error caused by GitHub's unauthenticated API rate limit (HTTP 403 upstream). This is direct evidence that public GitHub reads are not operationally reliable without the dedicated read-only credential.
- Live `read_project_file` for `cloud-engineering-connector/README.md` returned successfully. One successful read does not override the rate-limit failure on repository inspection.
- Worker settings inspection confirmed that Staging currently has `GITHUB_TOKEN`, `MCP_AUTH_TOKEN`, and `MCP_ALLOWED_ORIGINS` secret bindings, but **does not have `GITHUB_READONLY_TOKEN`**. `PUBLIC_READ_ONLY=true`, the Staging rate-limit namespace, and the Staging `WRITE_CONTROL` namespace are present.

This is a live smoke of the rolled-back Staging version only. It is not acceptance of PR #127, does not validate its `/readyz` route, and does not authorize promotion. The release workflow must fail preflight until `GITHUB_READONLY_TOKEN` is installed on Staging.

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

Two distinct lines must be combined before the final merge:

- PR #113, branch `integration/unify-main-and-integrated-2026-11-02`, contains the Python/CTP, Master Brain MCP, evidence-protocol, and production Worker history. It is 753 commits ahead of `main`.
- PR #103, branch `integration/security-hardening-stack`, contains the Cloud Agent and newer connector security/CI line. It is 37 commits ahead of `main` and does not contain the Python/CTP tree.
- These branches diverged from `main`. **Do not merge the security branch alone to `main`.**

Feature chain:
- PR #121 consolidates write-control/retention and supersedes #116/#120.
- PR #127 adds the architecture analyzer and secure console on top of #121 and supersedes #118/#119/#126.
- Keep superseded PRs as audit references; do not merge them independently.

The single-line candidate must be built on the PR #113 tree with a merge commit whose first parent is the PR #113 head and second parent is the PR #127 head. Preserve all Python/CTP/Master Brain-only paths; apply the reviewed PR #127 versions to overlapping Cloud Agent, connector, CI, and security paths. The exact bearer-token regression test is retained in the newer connector suite.

After full combined CI and full-history Gitleaks pass on that exact merge head, obtain independent review of the complete diff and merge **only PR #113** to `main`. Do not merge #103/#121/#127 separately to `main`.

## 7. Production release gates

Production remains blocked until all of the following are true:

- PR #121 and PR #127 have independent review and approved merge order.
- Required status checks are enforced on `main` and release branches; direct pushes are restricted.
- **Live governance audit (2026-11-02):** GitHub reports `main.protected=false` and the repository rulesets endpoint returns an empty list. Required checks, approval rules, and force-push/deletion restrictions are therefore not enforced by a repository ruleset. The linked GitHub integration cannot write repository administration settings; the owner must configure a `main` branch ruleset in GitHub Settings before release.
- PR #121 and PR #127 have no independent submitted reviews as of the latest review-list check. Both remain Draft; self-review by the implementation author is not a substitute for an independent approval.
- Cloudflare account MFA enforcement is enabled and verified. The last account-level read showed `enforce_twofactor=false`.
- Staging acceptance above passes on the exact candidate version.
- Claude account acceptance passes using the actual Claude account and its configured custom connector.
- Production has the dedicated `GITHUB_READONLY_TOKEN`, a separate `GITHUB_TOKEN`, valid `MCP_AUTH_TOKEN`, its own `WRITE_CONTROL` namespace and its own rate-limit namespace.
- Production `/readyz`, MCP initialize, tool discovery, GitHub read-only calls and write-control dry-run/denial tests pass.
- A rollback target and operator are recorded before rollout.
- Monitoring, alerting, backup/restore, incident ownership and credential-rotation procedures are documented and tested.

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

- Staging was rolled back to its last known-good version 27; PR #127 is not deployed. Production remains on its older Worker version and has no `WRITE_CONTROL` Durable Object binding yet.
- Staging and Production currently do not list a `GITHUB_READONLY_TOKEN` secret.
- Cloudflare account MFA enforcement was observed disabled.
- GitHub branch-protection endpoint access is unavailable to the connected GitHub integration; the repository rulesets query returned an empty list. A repository administrator must verify required reviews and status checks in GitHub settings.
- The latest Staging smoke job is skipped for PR #127 because the candidate has not been deployed. Do not enable the job against an unrelated Staging version and call it acceptance.
- Actual Claude-account connection and tool invocation remain unverified.

**Release decision:** NO-GO until all blockers above have evidence attached to the release candidate.
