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
- Exact-head hosted runs on `fd4bf4a02494d93fa449735764d1c8e5a0ac5a28`: PR run [45457816102](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45457816102) and push run [45457796175](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45457796175). Both PR-diff scans passed with zero findings (14 commits / 243.83 KB on the PR event; 1 commit / 531 bytes on push). Both all-fetched-ref scans examined 4,955 commits / approximately 15.23 MB and failed with 13 `generic-api-key` findings (exit 2).
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
| Latest completed exact-head PR-diff scan (head f4c43a7) | `PASS` | Run 45461431988: 18 commits / 253.16 KB, 0 findings |
| Latest completed exact-head all-fetched-refs scan (head f4c43a7) | `FAIL` | Run 45461431988: 4,960 commits / 15.25 MB, 13 findings |
| Documentation snapshot head f3a4250 Gitleaks | `NOT_EVIDENCED` | Superseded by exact-head run 45461431988 on f4c43a7 |
| Hosted manual canary | `NOT_RUN` | Separate default-branch registration and explicitly approved canary |
| Reviewer/provider execution | `BLOCKED` | Separate approval after durable reservation, budgets, and provider semantics are proven |

**Disposition:** continue with read-only evidence gathering and isolated tests only. Do not register the workflow on `main`, alter Actions policy, modify secrets, activate the reviewer, or merge PR #463 until the unknown gates are resolved and separately approved.


## Exact PR #463 head reconciliation — 2026-11-24

This section supersedes earlier candidate-head scan identifiers and reconciles the test-evidence scope. It is an append-only evidence correction; it does not change execution policy or authorize activation.

- Exact current PR head at reconciliation: `f24939bab2d5177f2c604b863c0fbf8f1edadb88`; base: `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`; 15 commits ahead, 0 behind; Draft / Open / Unmerged.
- Full isolated `npm ci --ignore-scripts --no-audit --no-fund` and `npm test` evidence: **136/136 pass, 0 fail, 0 skipped** on code/test commit `fcc83c57f647aa36ff30f8552e5524eca1d2b285`, Node.js `v22.16.0`, npm `10.9.2`, Git `2.39.5`. This is not a GitHub Actions test run.
- A GitHub compare from `fcc83c57f647aa36ff30f8552e5524eca1d2b285` to current head `f24939bab2d5177f2c604b863c0fbf8f1edadb88` reports eight commits and exactly one changed path: this `OPERATIONS.md` file. Therefore the executable source, test files, workflow, package manifest, and lockfile are unchanged since the passing 136-test run. Correct disposition: `PASS_ON_IDENTICAL_CODE_TEST_TREE`; do not describe the test command as having been executed literally at `f24939b`.
- Current-head hosted Gitleaks PR run `45458247747` and push run `45458229940` are both completed. Each PR-diff scan examined 15 commits / approximately 244.36 KB and found **0** leaks. Each all-fetched-refs scan examined 4,957 commits / approximately 15.24 MB and failed with **13** `generic-api-key` detections (exit 2). The all-ref result is a real failure and remains unresolved.
- The 13 matches were inspected at their recorded source lines: one application idempotency-key construction in `worker.js`; nine synthetic event/idempotency test fixtures in `orchestrator-owner-command.test.js`; one local marker-key rotation test fixture in `review.test.mjs`; and two public ICU repository/commit/fingerprint references in the audit Markdown. Their non-credential interpretation remains `PROVISIONALLY_SUPPORTED`, not proven. No finding was suppressed, allowlisted, or cleared. Actual secret-store reuse and credential revocation remain `UNKNOWN`.
- GitHub Combined Status for current head returned no status checks. The only hosted workflow run returned for this head is the Gitleaks workflow; no hosted `npm test` run is evidenced. `actionlint 1.7.7` is reported PASS for the unchanged workflow blob.
- The PR review thread on `tools/9router-review/review.js` remains unresolved. The 307/308 local-server regression is present and asserts one physical POST, no redirect-target request, zero accepted comments, and an UNKNOWN publication failure. Keep the thread unresolved until the test evidence is independently revalidated against the exact code/test tree and an independent review disposition is recorded.
- The repository ruleset still requires one approving review and review-thread resolution. The observed PR review submissions are comments by the PR author; no independent approving review is evidenced. `mergeable=true` is not approval.
- The bootstrap workflow remains absent from `main`; hosted manual canary is `NOT_RUN`. Reviewer remains statically disabled (`if: false`). Effective Actions policy, secret names/scopes, and actual credential reuse/revocation remain `UNKNOWN`. Durable cross-run reservation and at-most-once provider dispatch remain unproven.
- No merge, default-branch workflow registration, reviewer activation, 9Router/provider dispatch, comment publication, secret read, repository-policy change, Cloudflare operation, or local-host change was performed by this reconciliation.

**Disposition:** keep PR #463 Draft. Continue with read-only evidence and isolated validation. Do not resolve the outstanding review thread, register the workflow on `main`, activate the reviewer, merge, or deploy on the basis of these results alone.


## Post-reconciliation verification — 2026-11-24

This is the latest read-only state after the documentation-only evidence correction above.

- Current PR branch head: `22243a913fa1c44564966088296078b0f6af88f8`; base remains `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`. PR #463 remains Open / Draft / Unmerged.
- Compare from the verified code/test commit `fcc83c57f647aa36ff30f8552e5524eca1d2b285` to this head reports nine commits and exactly one changed path, `tools/9router-review/OPERATIONS.md`. The executable source, tests, workflow, package manifest, and lockfile remain unchanged from the code/test tree on which the isolated **136/136** test run was recorded. The test run was not re-executed at this documentation commit and is not a hosted GitHub Actions test.
- Exact current-head Gitleaks run `45461043268`: PR-diff scan PASS, 16 commits / approximately 248.45 KB, 0 findings; all-fetched-refs scan FAIL, 4,958 commits / approximately 15.24 MB, 13 `generic-api-key` detections (exit 2). The 13 findings remain `PROVISIONALLY_SUPPORTED` as non-credential source/test/public-identifier matches, not cleared. No suppression or allowlist change was made; actual secret reuse/revocation remains `UNKNOWN`.
- GitHub Combined Status for this head returned no status checks. The only workflow run returned for this head is the Gitleaks run above; no hosted `npm test` run is evidenced.
- The review thread on `review.js:341` remains unresolved. The redirect correction and 307/308 local-server test are present, but no independent approving review is recorded. The current review submissions are `COMMENTED`, not an approval.
- The workflow remains absent from `main`; manual canary is `NOT_RUN`; reviewer execution remains statically disabled. Durable cross-run reservation, provider at-most-once dispatch, effective Actions policy, and secret scopes remain unproven or `UNKNOWN`.
- No merge, workflow registration, reviewer activation, provider/model dispatch, comment publication, secret read, policy change, Cloudflare deployment, or local-host change was performed.

**Current disposition:** Draft / hold. Continue only with read-only evidence and isolated validation. Do not merge, activate, register, or deploy.


## Previous branch-head status snapshot — 2026-11-24 (superseded by the final snapshot below)

- Current PR #463 head: `f3a425009dc42a08425ee0392f0101f38b53bcd2`; base SHA remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; Draft / Open / Unmerged.
- Compare from code/test commit `fcc83c57f647aa36ff30f8552e5524eca1d2b285` to current head reports ten commits and exactly one changed path, `tools/9router-review/OPERATIONS.md`. The executable code, test files, workflow, package manifest, and lockfile remain unchanged from the isolated test tree with 136/136 passing. That test result is inherited by identical executable inputs; the command was not rerun at `f3a4250`.
- Latest completed Gitleaks run is `45461043268` on parent head `22243a913fa1c44564966088296078b0f6af88f8`: PR-diff PASS (16 commits / 248.45 KB, zero findings) and all-fetched-refs FAIL (4,958 commits / 15.24 MB, 13 findings). No PR-triggered workflow run was returned for `f3a4250`; this query does not expose push-triggered runs, so the exact-current-head Gitleaks state is `UNKNOWN`, not PASS or FAIL.
- Combined Status for `f3a4250` returned no status checks. This does not prove that no push-triggered workflow ran.
- The review thread at `review.js:341` remains unresolved; no independent approving review is recorded. PR #463 remains Draft. The reviewer job remains `if: false`; workflow registration on `main`, manual canary, model/provider dispatch, durable cross-run reservation, secret scope, and revocation remain unverified or blocked.
- The only new repository changes in this continuation are documentation commits to `OPERATIONS.md` on the PR branch. No source, workflow, test, dependency, main-branch, secret, repository-policy, Cloudflare, deployment, or local-host change was made.

**Disposition:** preserve Draft and all unresolved gates. Do not merge, register the workflow on `main`, activate reviewer execution, or deploy.


## Final exact-head evidence snapshot — 2026-11-24

This snapshot records the latest completed code/security evidence before this final documentation-only reconciliation.

- Audited PR head: `f4c43a738df3ce7008e60d55efbf9ca8548b70dd`; base: `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`; 18 commits ahead, 0 behind; PR #463 Open / Draft / Unmerged.
- Code/test provenance: isolated `npm ci --ignore-scripts --no-audit --no-fund` and `npm test` recorded **136/136 passing, 0 failing, 0 skipped** on `fcc83c57f647aa36ff30f8552e5524eca1d2b285`. Compare from that code/test commit to `f4c43a7` shows 11 commits and exactly one changed path, `tools/9router-review/OPERATIONS.md`; no executable source, test, workflow, package manifest, or lockfile changed. Therefore the same code/test tree is covered, but the command was not rerun literally at `f4c43a7`, and no hosted npm-test run is evidenced.
- Exact-head hosted Gitleaks run `45461431988` completed with failure: PR-diff scan PASS (18 commits / 253.16 KB, zero findings); all-fetched-refs scan FAIL (4,960 commits / 15.25 MB, 13 `generic-api-key` findings; exit 2). The 13 detections remain `PROVISIONALLY_SUPPORTED` as non-credential source/test/public-identifier matches, not proven false positives. No allowlist or suppression was added; credential-store reuse and revocation remain `UNKNOWN`.
- Combined Status returned no status checks. The Gitleaks run is the only workflow run returned for this head. This does not establish any additional CI or hosted npm-test execution.
- The 307/308 GitHub comment POST regression exists on the reviewed code tree and asserts one physical POST, no redirect-target request, zero accepted comments, and an UNKNOWN publication failure. The review thread at `review.js:341` remains unresolved. The recorded reviews are `COMMENTED` by the PR author; no independent approving review is evidenced.
- The bootstrap workflow is not registered on `main`; manual canary is `NOT_RUN`; reviewer execution remains statically disabled (`if: false`). Durable cross-run reservation, at-most-once provider dispatch, effective Actions policy, and secret scopes remain unproven or `UNKNOWN`.
- This final record is itself a documentation-only update to `OPERATIONS.md`. Gitleaks run `45461431988` covers the pre-update head `f4c43a7`, not the resulting documentation commit. Do not represent it as a scan of the commit that adds this snapshot.

**Disposition:** keep PR #463 Draft. Preserve the unresolved review thread, full-history Gitleaks failure, independent-review requirement, and manual-canary gate. No merge, default-branch workflow registration, reviewer activation, model/provider dispatch, secret read, repository-policy change, Cloudflare deployment, or local-host change is authorized by this record.
