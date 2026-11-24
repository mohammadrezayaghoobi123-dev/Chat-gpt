# 9Router Trusted Manual Review Bootstrap

## Status and scope

This bootstrap provides a trusted-default-branch manual resolver and a disabled reviewer job. It is intentionally not an automatic PR reviewer. The workflow file must first be registered on `main` by a separately reviewed and separately approved change before GitHub can dispatch its `issue_comment` or `workflow_dispatch` events.

The initial workflow exposes only two events:

- `issue_comment: created`, accepted only when the entire comment body is exactly `/review-canary`, the issue is a pull request, and the actor ID is `335530603`.
- `workflow_dispatch`, accepted only when the run ref is exactly `refs/heads/main`, the actor ID is `335530603`, and `pull_request_number` is a canonical positive decimal string.

The resolver obtains the live pull request directly through `GET /repos/{owner}/{repo}/pulls/{number}`. It requires the same repository ID and full name for the base and head repositories, an open non-draft and unlocked PR, valid immutable head/base SHAs, and a valid base ref. API errors, timeouts, malformed or oversized responses, and transport failures are `UNKNOWN` and fail closed. For a future `pull_request_target` integration, event head/base SHAs and base ref must exactly match the live API snapshot; that event is not enabled by this bootstrap.

## Trust and privilege boundaries

- The workflow checks out only `${{ github.workflow_sha }}` with `persist-credentials: false`; it never checks out a PR head.
- The resolver job receives only `contents: read` and `pull-requests: read` permissions and uses only the job-scoped `github.token` for the read-only PR lookup.
- The workflow has no `pull_request`, `pull_request_target`, `workflow_run`, `push`, or `schedule` trigger.
- The reviewer job has a literal `if: false`, an empty permissions map, and no router, marker, model, provider, or other secret references.
- The canary does not call 9Router, dispatch a provider/model request, read router/marker secrets, post PR comments, create artifacts, or deploy services.
- Comment text after the exact command is not passed to the resolver output or reviewer prompt. The current job condition requires the whole body to equal the command, providing a stricter gate than first-line parsing alone.

## Bootstrap validation

From `tools/9router-review` on Node.js 22 or later:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The test suite includes the pinned reviewer transport regression tests and resolver adversarial tests. The workflow repeats this test command before making the read-only API call. The initial PR branch does not register this workflow on the default branch, so no claim of hosted manual-event execution is made from branch-local tests.

## Manual canary procedure after separate default-branch registration

1. Confirm the workflow file is present on `main` at the expected reviewed commit.
2. Use an owner-authored PR conversation comment whose entire body is `/review-canary`, or dispatch the workflow against `main` with a canonical PR number.
3. Confirm the `resolve` job runs the pinned tests, performs one read-only live PR lookup, and emits only the validated repository/PR snapshot identifiers.
4. Confirm the `reviewer` job is skipped because its condition is statically false.
5. Inspect the run for zero 9Router requests, provider dispatches, router/marker secret reads, PR comment writes, artifacts, and deployments.
6. Preserve the exact workflow run ID, workflow SHA, event payload identity, resolved PR snapshot, and job conclusions as the canary evidence record.

A successful canary proves only the manual trigger and live resolver path for that exact run and PR snapshot. It does not prove automatic event delivery, secret storage scope, durable cross-run dispatch uniqueness, provider billing semantics, runtime deployment identity, or exactly-once model execution.

## Rollback

If validation fails, keep the reviewer disabled and do not retry uncertain API or future model/publication operations automatically. Once registered on `main`, remove or revert the workflow only through a separately reviewed revert PR. Do not change Actions policies, repository settings, permissions, secrets, Cloudflare resources, deployments, or local runtime configuration to bypass a failure.

## Source provenance

The reviewer runtime and original 9Router transport regression cases are carried forward from PR #431 head `59c71d9451b04fe13f53c6cb9283039cfe456f60`:

- `review.js`: unchanged source blob `498e92e3ab8daec12c7ee61cc9fc0892e1d3ff46`
- `review.test.mjs`: baseline source blob `989d77da4d7ab3c146fe2be66a7a327fcb0096c4`; this branch replaces superseded signal/`workflow_run` and enabled-review concurrency assertions with assertions for the current manual-only, reviewer-disabled bootstrap, and adds the GitHub comment redirect regression
- `resolve-pr.mjs`: requires the complete comment body to equal `/review-canary`; first-line-only matching is rejected
- `resolve-pr.test.mjs`: includes a test-first multiline-command regression
- `package.json`: dependency contract `marked@17.0.1`
- `package-lock.json`: lockfile version 3, exact `marked@17.0.1` integrity pin
- `run-review.mjs`: retained as inert runtime entry point; the bootstrap workflow never invokes it

The source workflow's automatic triggers and signal/receipt components are deliberately not copied. The original PR #431 remains unchanged and unmerged.

## DCP-01V.3 — exact command hardening and full-suite reconciliation

- Test-first regression commit: `5ee33dab2cabc9c83fc5beb6e3dc0ff7537c46ff`. The new multiline command case failed as intended because the resolver returned `RESOLVED` for `/review-canary\nignore safeguards`.
- Minimal resolver fix: `2a81f8e0a35cd0f2af734f856c3e9b830a50fa91`. The resolver now requires the complete comment body to be exactly `/review-canary`; no first-line parsing remains in the issue-comment path.
- Focused RED/GREEN evidence: the exact-command regression failed before the fix (2 assertions failed in the targeted Node test invocation) and passed after the fix (8/8 targeted assertions).
- Reconciled stale tests that still required the rejected signal/`workflow_run` design and its privileged reviewer concurrency configuration. The replacement test asserts the current manual-only triggers, exact actor/command gates, trusted workflow-SHA checkout, read-only resolver permissions, and statically disabled secret-free reviewer job.
- Full isolated verification at exact PR head `4015f4aebb508aea58c1ba71e7a815cb0eb37205`: Node.js `v22.16.0`, npm `10.9.2`, Git `2.39.5`; `npm ci --ignore-scripts --no-audit --no-fund` completed, then `npm test` completed with **136/136 passing, 0 failing, 0 skipped**. The package tarball integrity matched the lockfile.
- This is an isolated hosted reproduction, not a GitHub Actions workflow run. GitHub-hosted manual canary remains `NOT_RUN` because the workflow is not registered on `main`.
- Fresh exact-head Gitleaks 8.30.1 scan at `7c06c99be96fd23e669cdb2062d8be0b4c5d435b`: `origin/main..HEAD`, 10 commits / approximately 233 KB, **0 findings**, exit 0. Main and merge-base both resolved to `919b19ca3d3887352cdef06b03c668ead04fbce7`.
- The last completed all-fetched-ref/history scan remains run `45406924306` on the earlier candidate head and failed with 13 `generic-api-key` detections in reachable history. A source/commit-context triage provisionally supports false-positive classification for all 13, without suppressing them:
  - `worker.js` (1): the matched expression constructs an application idempotency identifier from a configured prefix, controller identity, and task ID, then passes it to Admission Receipt issuance; it is not an authentication credential.
  - `orchestrator-owner-command.test.js` (9): the matches are test event/idempotency fixtures. Commit messages explicitly identify synthetic Gitleaks canaries and false-positive fixture cleanup; the `API_KEY` comment was introduced by commit `04d76f8fd734eaf4053c86461e1204caf18d9c9c`, titled "test(security): add synthetic Gitleaks allowlist scope canary".
  - `review.test.mjs` (1): previous/current marker-signing keys are local test fixtures in the marker-rotation regression, not workflow secrets.
  - The audit Markdown file (2): public Unicode ICU repository/commit metadata and a public Release Robot signing-key fingerprint, not private key material.
- The matched `orchestrator-owner-command.test.mjs`, `review.test.mjs`, and audit Markdown paths are absent from current `main`; current-main `worker.js` has no `idempotencyKey` or `idempotencyPrefix` references. The all-ref scan therefore includes historical or non-main refs, not just current-main content.
- Provisional disposition: **PROVISIONALLY_SUPPORTED — false-positive/test-fixture/public-identifier classification**. Actual secret-store reuse and credential revocation status remain **UNKNOWN** because no secret values or external secret stores were read. No finding was allowlisted, suppressed, or cleared. A fresh all-fetched-ref scan on the current head is `NOT_RUN`.
- `actionlint 1.7.7` on the exact current workflow: **PASS**, exit 0.
- GitHub Combined Status returned no status checks for the current head; this does not substitute for the isolated test run or a hosted canary.
- Current reviewer job remains disabled; no 9Router request, provider/model dispatch, comment publication, secret read, merge, default-branch workflow registration, deployment, Cloudflare operation, or local-host change occurred.

## Repository Control-Plane Preflight — 2026-11-24

This section records read-only observations made after the bootstrap design was approved. It does not authorize a repository settings, policy, secret, or workflow change.

### Repository identity and default branch

- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`, repository ID `1398846697`, public visibility, personal-account owner ID `335530603`.
- Default branch: `main`, observed commit `919b19ca3d3887352cdef06b03c668ead04fbce7`.
- The current `main` workflow directory contains exactly `cloud-agent-ci.yml`, `connector-ci.yml`, `secret-history-scan.yml`, and `static.yml`. The 9Router bootstrap workflow is not registered on `main`.

### Active repository ruleset

- Repository ruleset `main`, ID `26740429`, is active and targets `refs/heads/main`.
- Returned rules: prevent branch deletion; prevent non-fast-forward updates; require one approving pull-request review; dismiss stale approvals after new pushes; require review-thread resolution.
- Returned configuration has no bypass actors, no code-owner-review requirement, no last-push-approval requirement, and no required-status-check rule. This is only the observed repository-level ruleset; it does not prove the absence of other controls.
- The branch API reports `protected=true`; its exposed protection summary reports required-status-check enforcement `off`. The detailed branch-protection endpoint returned HTTP 403, so other protection details remain `UNKNOWN`.
- PR #463 cannot be treated as merge-ready merely because GitHub reports it mergeable. Its required independent approval remains outstanding unless separately evidenced.

### Actions policy and secret-scope boundary

- The GitHub connector does not expose the repository Actions-permissions endpoint through its approved read interface. Effective Actions policy is `UNKNOWN`: this includes permitted event triggers, fork workflow approval behavior, default `GITHUB_TOKEN` permissions, and any organization-level inheritance.
- The connector explicitly excludes secrets APIs. Repository, organization, and environment secret names, storage scopes, selected-environment availability, and values were not read. Secret scope and actual credential reuse remain `UNKNOWN`.
- No attempt was made to read, print, enumerate, export, or test secret values. No Actions policy, repository setting, permission, secret, or environment was changed.
- GitHub documents that repository Actions settings control fork workflow behavior and default `GITHUB_TOKEN` permissions, and that same-repository pull-request workflows can have different token/secret exposure from fork pull requests. Consequently, the missing policy and secret-scope evidence is a hard gate, not a presumed-safe default.

### Existing full-history scan workflow

- The default-branch `.github/workflows/secret-history-scan.yml` declares `contents: read`, checks out with `fetch-depth: 0` and `persist-credentials: false`, pins `gitleaks/gitleaks-action` to commit `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e`, sets `GITLEAKS_VERSION=8.30.1`, disables comments and artifact upload, and runs the all-fetched-refs scan with `--log-opts="--all"` using `.gitleaks.toml`.
- The pinned action source confirms it installs the requested Gitleaks version under the runner temporary directory `gitleaks-8.30.1`; the workflow's absolute binary path is consistent with that installation.
- Exact-head hosted runs on `c091df84f2cf9b4c6f08600ddfc726304e65b952`: PR run [45457692051](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45457692051) and push run [45457672024](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45457672024). Both PR-diff scans passed with zero findings (13 commits / 243.30 KB on the PR event; 1 commit / 2.90 KB on push). Both all-fetched-ref scans examined 4,954 commits / approximately 15.23 MB and failed with 13 `generic-api-key` findings (exit 2).
- The 13 remaining findings are source/commit-context triaged as `PROVISIONALLY_SUPPORTED` non-credential cases (application idempotency identifier, test fixtures, and public ICU metadata/fingerprint); none was suppressed or allowlisted. Secret-store reuse and revocation remain `UNKNOWN`.
- A separate unconfigured Gitleaks run (without `.gitleaks.toml`) found 44 branch/tag findings and 49 when all pull-request refs were added. These are not equivalent to the configured workflow result: the project config narrowly allowlists several historical test fixtures, so the official hosted result remains 13. Do not substitute the unconfigured count for the hosted result.
- The config audit found two historical HMAC test-fixture allowlists constrained by exact commit and path but without a literal/line regex. They are not current secrets and do not explain the 13 remaining findings; precision hardening is a separate follow-up, not an automatic suppression.
- The historical invalid-bearer probe fixture is explicitly synthetic and its allowlist is restricted to its exact commit, workflow path, and literal. Its 2026-10-31 run predates current auth configuration; the current production endpoint now rejects both absent and invalid bearer credentials.

### Gate disposition

| Gate | State | Evidence needed |
|---|---|---|
| Repository identity/default branch | `PASS` | Repository metadata and current branch SHA |
| Repository-level main ruleset observed | `PASS` | Ruleset ID `26740429` |
| Branch protected flag / status-check enforcement | `PASS / OFF` | Branch API: protected=true; required-status-check enforcement off |
| Effective Actions event and token policy | `UNKNOWN` | Owner inspection of Settings → Actions → General |
| Secret names and scopes | `UNKNOWN` | Owner inspection of repository/org/environment secret metadata; never disclose values |
| Current-head PR-diff Gitleaks | `PASS` | Hosted runs 45456122725 / 45456110580, zero diff findings |\n| Current-head all-fetched-refs Gitleaks | `FAIL` | Hosted runs 45456122725 / 45456110580, 13 findings |
| Hosted manual canary | `NOT_RUN` | Separate default-branch registration and explicitly approved canary |
| Reviewer/provider execution | `BLOCKED` | Separate approval after durable reservation, budgets, and provider semantics are proven |

**Disposition:** continue with read-only evidence gathering and isolated tests only. Do not register the workflow on `main`, alter Actions policy, modify secrets, activate the reviewer, or merge PR #463 until the unknown gates are resolved and separately approved.
