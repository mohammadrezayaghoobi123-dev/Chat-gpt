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


## Post-record exact-head Gitleaks result — 2026-11-24

- Exact PR head scanned: `a2793da91ea1e858804fb1e99b532d4abba5c8fb`.
- Hosted run: `45461675413`, completed with failure. PR-diff scan: **PASS**, 19 commits / approximately 256.44 KB, zero findings. All-fetched-refs scan: **FAIL**, 4,961 commits / approximately 15.25 MB, 13 `generic-api-key` findings (exit 2).
- This confirms that the 13 historical findings persist at the exact scanned PR head. Their source/test/public-identifier classification remains `PROVISIONALLY_SUPPORTED`; no finding was suppressed or allowlisted. Credential reuse and revocation remain `UNKNOWN`.
- This addendum itself is a documentation-only update to `OPERATIONS.md`; run `45461675413` covers its parent head `a2793da`, not the commit that adds this addendum. No executable source, test, workflow, package, or lockfile changes are included.

**Gate:** full-history Gitleaks remains FAIL. Keep PR #463 Draft and preserve all existing activation, review, and merge blocks.


## Atomicity adversarial finding — concurrent reviewer publication

**Finding ID:** `9R-ATOMIC-001`  
**Disposition:** `OPEN / FAIL-CLOSED`  
**Severity:** `HIGH` for any future reviewer activation; no current publication path is enabled by the bootstrap because `reviewer.if: false`.

### Evidence from the reviewed source tree

- `runReview()` performs `findMatchingReviewComments()` and returns early only when a matching signed marker already exists (currently source lines approximately 860–891).
- If no marker exists, the run proceeds through model inference and only later reaches the final PR SHA gate and comment POST (approximately lines 895–966).
- There is no atomic reservation, compare-and-set, lease, or durable unique constraint between the duplicate check and publication.
- The workflow `.github/workflows/9router-pr-review.yml` has no workflow-level or job-level `concurrency` group. Its reviewer job remains statically disabled (`if: false`).
- Therefore two runs for the same repository/PR/head/base can both observe no marker and both publish. This is a source-level race analysis, not a reproduced runtime exploit; disposition is `PROVISIONALLY_SUPPORTED` until the concurrency regression test is executed.

### Required red-phase regression

Create a deterministic test that starts two `runReview()` invocations behind a barrier:

1. Both runs complete the matching-comment preflight and observe an empty history.
2. Both are released to proceed concurrently.
3. Count model requests and GitHub comment POSTs.
4. Assert the system-wide invariant for one immutable key `(repository_id, pull_request, head_sha, base_sha)`: at most one publication may be accepted.
5. Force one reservation holder to crash/timeout and verify lease expiry/recovery cannot create a second accepted publication.
6. Repeat with changed head SHA and changed base SHA; distinct immutable snapshots must not incorrectly block one another.

The first test must fail against the current implementation because both invocations can reach POST. A test that only checks sequential duplicate calls is insufficient.

### Remediation decision — do not implement an in-memory lock

An in-process mutex is not a valid fix: GitHub Actions jobs execute in separate processes/runners. A workflow `concurrency` group with `cancel-in-progress: false` is a useful serialization defense, but by itself it does not prove durable at-most-once behavior across cancellation, reruns, manual dispatch, or other invocation paths.

Before activation, choose and document a durable reservation authority with:
- an atomic unique key for `repository_id + pull_request + head_sha + base_sha`;
- lease owner, lease expiry, monotonic fencing token, and explicit terminal states;
- safe recovery after worker death;
- publication reconciliation after an ambiguous POST response;
- a rule that UNKNOWN publication state blocks automatic retry until the remote comment history is reconciled;
- tests for simultaneous claims, lease expiry, stale lease holders, process restart, API timeout after remote acceptance, and changed snapshots.

The reservation store and its trust boundary must be reviewed independently. Do not assume GitHub Actions concurrency is a transactional database.

### Scope and gate

No source, test, workflow, dependency, secret, repository-policy, `main`, Cloudflare, production, or local-host changes were made for this finding. No canary or provider call was run.

**Gate:** `9R-ATOMIC-001` blocks reviewer activation and any claim of cross-run at-most-once publication. Keep PR #463 Draft. The required next engineering action is a red-phase concurrency test and an explicit durable-reservation design review; implementation must follow only after the test demonstrates the defect.


### Static corroboration on the current source/test blobs

Exact blob evidence retrieved from the PR head `52b00c544e8c2fd499c11738cae4d075331f8fbc`:

- `review.js` blob: `9d5d60abe7551a0cfb63235b760cd61df8cb142a`; duplicate preflight begins at line 870; the final publication gate is at lines 940–941; the GitHub comment POST is at lines 944–950.
- `review.test.mjs` blob: `104996a167d4a9e6883714eb89112d8f061eded6`; the retrieved 147,938-byte test file contains sequential duplicate suppression and ambiguous-first-POST reconciliation tests, but no concurrency/barrier/parallel-invocation/reservation/lease/at-most-once test was found by targeted source scan.
- Workflow blob: `737e37cdafe3d12322226f493e78bf4856555a2e`; no `concurrency`, `group`, or `cancel-in-progress` directive exists. Reviewer remains disabled.
- This corroborates the static race finding and the missing regression coverage. It is not a runtime reproduction and does not replace the required red-phase concurrent test.
- Exact-head CI evidence remains absent for this documentation commit: the commit-workflow query returned no PR-triggered runs and Combined Status returned no status checks. The previously recorded 136/136 local result applies to the identical executable tree rooted at `fcc83c5`; it has not been freshly re-executed in this turn.

**Verification disposition:** static corroboration PASS; concurrency regression execution NOT_RUN; exact-current-head npm test NOT_RUN; reviewer activation BLOCKED.


## Durable reservation protocol design — 9R-ATOMIC-001 — 2026-11-24

**Design status:** provider-agnostic contract for review; not an implementation and not evidence of at-most-once behavior.  
**Decision:** no storage vendor or service is selected in this record. Backend selection is deferred until transaction, consistency, availability, cost, and access-control properties are evidenced.

### 1. Scope and immutable identity

The reservation protects one logical reviewer publication for one immutable pull-request snapshot. It does not establish exactly-once model inference, exactly-once billing, or exactly-once external execution.

Canonical reservation identity:

`(repository_id, pull_request_number, head_sha, base_sha)`

Requirements:

- `repository_id` is the immutable numeric GitHub repository identity, not only an owner/name string.
- `pull_request_number` is the positive repository-local PR number.
- `head_sha` and `base_sha` are full immutable commit object IDs validated against the live PR snapshot.
- Canonical key serialization must be versioned, unambiguous, and deterministic; the storage primary key may be `SHA-256(canonical_key_bytes)`, while all original tuple fields remain stored and checked for collision/mismatch.
- A changed head or base produces a different reservation. A repository rename does not change repository identity.
- Reservation rows are never deleted or silently reused. Retention/archival must preserve uniqueness and publication evidence for the full replay horizon.

### 2. Required storage semantics

The chosen authority MUST provide all of the following; a cache, process-local mutex, GitHub comment search, or best-effort key/value write is insufficient:

1. A unique constraint on the canonical reservation key.
2. Linearizable/serializable conditional state transitions, or an equivalent single-record compare-and-set primitive with documented consistency guarantees.
3. Atomic allocation of a monotonically increasing fencing generation for each pre-publication lease acquisition/recovery.
4. Authoritative server-side time for lease comparisons; worker clocks are not authoritative.
5. Durable acknowledgement semantics: a successful write response means the committed record survives the failure model claimed by the backend.
6. Read-after-write consistency for the reservation key.
7. Authentication and authorization scoped to the minimum required record operations; no public unauthenticated write path.
8. Auditable transition metadata without storing credentials, model prompts, or full review bodies unless separately justified.

If the backend cannot prove these properties under concurrent writers and failover, it is rejected for this safety-critical role.

### 3. Minimal record and interface contract

Logical record fields:

- `key_version`, `reservation_key`, `repository_id`, `pull_request_number`, `head_sha`, `base_sha`
- `state`, `generation`, `owner_id`, `lease_expires_at`
- `publication_attempt_id`, `publication_payload_sha256`, `publication_intent_at`
- `remote_comment_id`, `published_at`
- `last_error_class`, `unknown_reason`
- `created_at`, `updated_at`, append-only transition/audit sequence

The implementation boundary MUST expose equivalent operations (names are proposed):

- `claim(key, owner, lease_duration) -> CLAIMED | BUSY | ALREADY_PUBLISHED | DUPLICATE_ACCEPTED | UNKNOWN`
- `renew(key, owner, generation, lease_duration) -> RENEWED | LOST_OWNERSHIP`
- `startWork(key, owner, generation) -> IN_PROGRESS | LOST_OWNERSHIP`
- `beginPublication(key, owner, generation, attempt_id, payload_hash) -> PUBLISHING | LOST_OWNERSHIP | TERMINAL`
- `completePublication(key, attempt_id, remote_comment_id) -> PUBLISHED | CONFLICT`
- `markUnknown(key, attempt_id, reason) -> UNKNOWN | CONFLICT`
- `reconcilePublication(key, evidence) -> PUBLISHED | DUPLICATE_ACCEPTED | UNKNOWN`

Every mutating operation is conditional on the current state and expected owner/generation/attempt. A caller must not receive a publish capability from a stale read. State transitions and their audit events commit atomically.

### 4. State machine and irreversible publication boundary

Allowed states:

- `UNCLAIMED`: no worker owns the reservation.
- `CLAIMED`: one owner has a time-bounded lease; no inference or publication has started.
- `IN_PROGRESS`: the current fenced owner may perform bounded preparation and model inference; no publication request is permitted yet.
- `PUBLISHING`: a single-use publication intent has been durably committed. This state is an irreversible safety boundary.
- `PUBLISHED`: one matching remote comment is authoritatively identified and its ID recorded.
- `UNKNOWN`: publication may have occurred, but the system cannot establish the remote outcome.
- `DUPLICATE_ACCEPTED`: more than one matching remote comment is found; terminal invariant violation requiring incident handling.
- `EXPIRED`: a pre-publication lease expired; a new generation may be claimed atomically.
- `ABORTED`: a pre-publication run stopped safely and cannot publish under that generation.

Allowed transitions:

- `UNCLAIMED -> CLAIMED`: atomic insert/claim; unique key arbitrates concurrent workers.
- `CLAIMED -> IN_PROGRESS`: owner and generation match, lease is valid.
- `CLAIMED | IN_PROGRESS -> EXPIRED`: authoritative lease expiry is observed atomically before publication intent exists.
- `EXPIRED -> CLAIMED`: atomic takeover with generation increment and a new owner/lease.
- `CLAIMED | IN_PROGRESS -> ABORTED`: owner-conditional transition before publication intent.
- `IN_PROGRESS -> PUBLISHING`: atomic compare-and-set; validate owner, generation, lease, immutable key, attempt ID, and payload hash; persist publication intent before any network request.
- `PUBLISHING -> PUBLISHED`: only after a validated successful GitHub response or authoritative reconciliation identifies exactly one matching comment.
- `PUBLISHING -> UNKNOWN`: timeout, process death, transport failure, malformed response, lost acknowledgement, or any outcome where remote acceptance cannot be excluded.
- `UNKNOWN -> PUBLISHED`: reconciliation finds exactly one comment whose repository, issue, bot identity, signed marker, snapshot SHAs, and payload identity match.
- `UNKNOWN -> DUPLICATE_ACCEPTED`: reconciliation finds more than one matching accepted comment; this is an invariant violation requiring incident handling.

No transition from `PUBLISHING`, `UNKNOWN`, or `PUBLISHED` back to `CLAIMED` or `IN_PROGRESS` is allowed. In particular, lease expiry MUST NOT reassign a `PUBLISHING` reservation to another publisher. The first publication intent is single-use and never reset.

### 5. Publication protocol

1. Read the live PR and validate repository identity, open/draft/locked policy, and exact head/base SHAs.
2. Atomically claim the canonical key. A loser returns `BUSY` and MUST NOT call the model or GitHub comment endpoint.
3. Perform preparation and inference under the current owner/generation. Before publication, revalidate the live PR snapshot.
4. Build the final comment deterministically; compute its payload hash and a unique attempt ID.
5. Atomically transition `IN_PROGRESS -> PUBLISHING`. Only the successful caller may issue the one GitHub comment POST for that key.
6. Immediately issue exactly one POST with redirect handling set to `error`. Do not automatically retry on timeout, 5xx, connection reset, malformed response, or client cancellation.
7. On a validated 201 response, persist the remote comment ID and transition to `PUBLISHED`. If persistence acknowledgement is lost, the state remains `PUBLISHING` or becomes `UNKNOWN`; reconcile before any other action.
8. On any ambiguous outcome, transition/retain `UNKNOWN`, then perform read-only reconciliation. A positive exact match can prove publication. A zero-result search, partial pagination, API error, stale replica, or incomplete visibility does NOT prove non-publication and MUST NOT authorize another POST.
9. If no remote comment can be found but non-publication cannot be proven by an authoritative API guarantee, retain `UNKNOWN` indefinitely or until an explicitly reviewed manual disposition. Never silently reset the reservation.

**Important limitation:** GitHub comment creation does not provide a caller-supplied transactional idempotency key coupled to the reservation store. Therefore the safe contract is *at-most-one publication attempt per immutable key*, with conservative UNKNOWN on ambiguous outcomes. It intentionally sacrifices automatic liveness after a crash at the publication boundary. It does not claim exactly-once delivery or exactly-once provider execution.

### 6. Safety invariants

- **S1 — Unique identity:** at most one durable reservation row exists for each canonical immutable key.
- **S2 — Single active pre-publication owner:** at most one current owner/generation can transition a pre-publication state.
- **S3 — Fencing:** stale generations cannot renew, start work, abort, or enter `PUBLISHING`.
- **S4 — Single-use publication intent:** at most one successful transition to `PUBLISHING` exists for a key; it is never reclaimed or reset.
- **S5 — No blind retry:** `PUBLISHING` and `UNKNOWN` never authorize another POST.
- **S6 — Snapshot binding:** every reservation and published marker is bound to repository ID, PR number, head SHA, and base SHA.
- **S7 — Evidence before success:** `PUBLISHED` requires one validated remote comment identity; a local POST attempt alone is not success.
- **S8 — Audit completeness:** every successful transition records prior/new state, generation, actor/owner, attempt ID where applicable, server timestamp, and reason.
- **S9 — Fail closed:** storage unavailability, stale reads, conditional-write conflict, clock uncertainty, or schema/version mismatch blocks model dispatch/publication rather than falling back to uncoordinated behavior.

### 7. Liveness and cost trade-off

Liveness is intentionally subordinate to publication safety. Expired `CLAIMED` or `IN_PROGRESS` work may be recovered because no publication intent exists. A crashed `PUBLISHING` worker cannot be safely replaced merely because its lease elapsed: the remote POST may already have been accepted. Such a record remains `UNKNOWN` until reconciled. This can strand a reservation and suppress a valid review; that is an explicit safety-over-availability choice, not a hidden failure.

The backend decision must compare only candidates that can meet the required atomicity and durability semantics. Evaluate total cost at expected write/read volume, free-tier ceilings, egress, retention, backup/restore, regional consistency, credentials, operational burden, and failure behavior. Do not assume a free tier is durable or that a vendor's generic "atomic" claim covers the required conditional transition.

### 8. Deterministic adversarial test matrix

Tests MUST use two or more independent store clients and independent worker instances. A single process-local fake mutex does not test the required property.

| Test | Fault/interleaving | Required result |
|---|---|---|
| T01 | 100 simultaneous claims for one key | Exactly one current claim succeeds; all others are BUSY or observe the same reservation |
| T02 | Two workers both read UNCLAIMED before either claims | Unique constraint/CAS admits one; no double owner |
| T03 | Old owner pauses; lease expires; new generation claims pre-publication row | Old generation cannot renew, start work, abort, or enter PUBLISHING |
| T04 | Old owner resumes after takeover | Every stale mutation is rejected; no model or POST after rejected transition |
| T05 | Worker crashes in CLAIMED | Lease expiry permits a new generation |
| T06 | Worker crashes in IN_PROGRESS before publication intent | Lease expiry permits safe takeover; old generation is fenced |
| T07 | Two workers race IN_PROGRESS -> PUBLISHING | Exactly one CAS succeeds; exactly one worker receives the single-use publish permit |
| T08 | Worker crashes after PUBLISHING commit but before socket write | Reservation remains PUBLISHING/UNKNOWN; no second POST is authorized |
| T09 | GitHub accepts POST but client times out before response | UNKNOWN; reconciliation may mark PUBLISHED; no second POST |
| T10 | GitHub returns 201 but store completion write loses acknowledgement | Read-after-restart reconciliation finds the exact comment or retains UNKNOWN; no retry |
| T11 | GitHub 307/308/5xx/reset/malformed response | No automatic replay; UNKNOWN where acceptance cannot be excluded |
| T12 | Partial/paginated comment listing returns zero | UNKNOWN; zero from incomplete evidence is not proof of non-publication |
| T13 | Reconciliation finds exactly one exact signed-marker/snapshot match | PUBLISHED with remote comment ID |
| T14 | Reconciliation finds two matching comments | DUPLICATE_ACCEPTED and explicit incident; no further POST |
| T15 | Head SHA changes while base remains fixed | New key; old reservation cannot authorize publication for new snapshot |
| T16 | Base SHA changes while head remains fixed | New key; old reservation cannot authorize publication for new snapshot |
| T17 | Repository rename with same repository ID | Same logical repository identity; no duplicate key caused by name change |
| T18 | Backend failover, stale replica, lost commit acknowledgement, or transaction conflict | No fallback to local lock; fail closed and preserve UNKNOWN where commit outcome is ambiguous |
| T19 | Reservation store unavailable before claim or before publication CAS | No model dispatch or POST |
| T20 | Schema/key-version mismatch or hash collision simulation | Reject mismatched tuple; preserve original identity; no publication |

The red-phase integration test against the current reviewer MUST deterministically demonstrate the existing race: synchronize both workers after the empty marker preflight, release both, and observe that both can reach the comment POST. Record this as a reproduction only after the test is actually executed. The current source-level race remains a static finding until then.

### 9. Backend selection gate

No backend is selected by this design. A candidate may proceed only after an evidence table records:

- documented transaction/CAS primitive and its consistency model;
- concurrent-client test results, including failover and acknowledgement-loss behavior;
- server-side lease-time semantics;
- authentication model and least-privilege enforcement;
- backup, retention, restore, and auditability;
- actual free-tier limits and cost at forecast volume;
- data residency/region and operational dependency;
- a tested recovery path for `PUBLISHING` and `UNKNOWN`.

A backend that offers only workflow concurrency, object overwrite, eventually consistent KV, or process-local state is rejected for the reservation authority. A separate workflow concurrency group may be evaluated later as defense in depth, not as the correctness mechanism.

### 10. Implementation gates

Implementation is NOT authorized by this design record. The next implementation sequence is:

1. Add the deterministic two-runner red test and prove it fails against the current code.
2. Define the store adapter contract and backend conformance suite without selecting a vendor prematurely.
3. Evaluate at least two viable backend candidates against the same conformance suite and cost/security evidence.
4. Select a backend only when all mandatory storage semantics pass; otherwise retain the reviewer disabled.
5. Implement the smallest transactional reservation adapter and integrate it before model dispatch.
6. Add crash/timeout/failover fault injection for every transition and the GitHub publication boundary.
7. Obtain independent security review and exact-head full test evidence.
8. Keep reviewer activation, workflow registration on `main`, provider dispatch, and merge as separate approvals.

**Disposition:** design contract drafted; no backend selected; no source/test/workflow changes; no runtime reproduction; no at-most-once claim. PR #463 remains Draft and reviewer activation remains BLOCKED.


## Red-phase concurrency test authored — 2026-11-24

**Test:** `tools/9router-review/review.test.mjs` — `deterministic concurrent duplicate-publication red test`  
**Test-only commit:** `e5745a254eab612f9efa8c75636e71f2fc34e5ea`  
**Test execution:** `NOT_RUN` in this environment. No RED result is claimed.

### Harness construction and falsification target

- The test launches two independent `runReview()` invocations with the same immutable repository/PR/head/base tuple and independent per-run legacy snapshot wrappers.
- Both invocations share one deterministic fake GitHub transport.
- The comment-history endpoint increments a shared counter and blocks each invocation at a Promise barrier until both have arrived. Only then does it return an empty comment list to both callers.
- This establishes the critical interleaving: both runs have independently observed the same empty marker history before either can continue.
- The fake 9Router endpoint counts model requests and returns a deterministic valid report.
- The fake GitHub comment endpoint counts physical POST requests and returns a structurally valid bot-authored 201 response.
- The test asserts two completed empty-history reads, exactly one physical comment POST, exactly one invocation reporting a newly published comment, and one model invocation.

### Expected current-code outcome (prediction, not execution evidence)

Static control-flow analysis predicts that the current implementation has no shared reservation between the barrier and POST. Therefore both runs are expected to invoke the model and both are expected to POST. The intended red assertion is `commentPosts === 1`; current source is predicted to violate it. This remains a falsifiable prediction until Node.js executes the test and records the actual counts.

### Adversarial review of the test itself

- **Barrier liveness:** the test releases only when both history reads arrive; `Promise.all` starts both workers. A missing second arrival causes a test timeout/failure rather than a false pass.
- **No timing sleeps:** synchronization uses a Promise barrier, not arbitrary delays.
- **Same-key collision:** both calls use identical repository, PR number, head SHA, and base SHA.
- **Independent invocations:** each call enters the public `runReview` wrapper separately; no shared in-process application mutex is supplied by the fixture.
- **Observable side effects:** model calls and physical comment POSTs are counted independently.
- **No live side effects:** all GitHub and 9Router requests are intercepted by the fake transport; no credentials or network calls are made.
- **Scope:** this test targets the current duplicate-preflight/publication race. It does not yet test a real durable store, multiple operating-system processes, worker crashes, lease fencing, or GitHub acceptance followed by lost acknowledgement. Those remain separate conformance/fault-injection gates.

### Current disposition

- Test artifact authored: **PASS (repository write acknowledged and content re-fetched)**.
- Test runtime: **NOT_RUN**.
- Predicted red result: **PROVISIONALLY_SUPPORTED** by source control flow; not experimentally confirmed.
- Durable reservation implementation: **NOT_STARTED**.
- Reviewer activation: **BLOCKED**.
- PR #463 remains Draft / Open / Unmerged. No workflow, dependency, source implementation, main-branch, secret, Cloudflare, or local-host changes were made.


## Hosted security scan for the red-test parent snapshot — 2026-11-24

- Gitleaks hosted run: `45463837165`.
- Scanned PR head: `fc96e7419fefda43be305f3e40ce06c6db19b72b` (the parent snapshot before the final assertion-order correction and documentation reconciliation).
- PR-diff scan: **PASS**, 29 commits / approximately 285.38 KB, zero findings.
- All-fetched-refs scan: **FAIL**, 4,971 commits / approximately 15.28 MB, 13 `generic-api-key` detections, exit code 2.
- The 13 detections match the previously observed historical set: one application idempotency-key construction, nine synthetic test fixtures, one local marker-key test fixture, and two public ICU repository/commit/fingerprint references. This is a provisional classification, not clearance. No suppression or allowlist was added. Actual credential reuse/revocation remains `UNKNOWN`.
- The run did not execute `npm test`; it is not evidence that the new concurrency test passed or failed.
- The current branch has advanced beyond the scanned parent. This run MUST NOT be represented as an exact-current-head security scan. Await the run associated with the final current PR head.

**Disposition:** PR-diff secret scan PASS on the recorded parent; full-history secret scan FAIL; concurrency test runtime NOT_RUN; no implementation or activation authorization.


## Adversarial verification checkpoint — 2026-11-24

### Immutable repository snapshot

- Pull request: #463, Draft / Open / Unmerged.
- Branch: `feat/9router-trusted-manual-bootstrap-2026-11-24`.
- Base SHA: `919b19ca3d3887352cdef06b03c668ead04fbce7`.
- Exact branch HEAD observed before this checkpoint: `055a3fd0719ca9a4c55dd2acbcceee755bd77a8e`.
- Compare result: 32 commits ahead, 0 behind; the nine changed paths remain the original bootstrap files. No workflow, dependency, or source implementation changes were introduced by the prior concurrency-test/doc commits.
- Test file blob at this checkpoint: `4153df7ab5a4a259c612d82a1c2a2d4833fe031e`.
- Workflow blob: `737e37cdafe3d12322226f493e78bf4856555a2e`; reviewer job remains literal `if: false`, with empty permissions.

### Hosted Gitleaks run — event-snapshot discrepancy

- Associated GitHub Actions run: `45464042892`; job: `138694046256`.
- Job conclusion: **FAIL**.
- PR-diff scan step: **PASS**, 30 commits / approximately 285.51 KB, zero findings, exit 0.
- Full fetched-ref scan step: **FAIL**, 4,974 commits / approximately 15.28 MB, 13 `generic-api-key` detections, exit 2.
- The job checkout log identifies the synthetic PR merge ref as `d4d33c28ceb9ea794d7a8dd00dacf5ace7cd8153`, whose log message merges `055a3fd0719ca9a4c55dd2acbcceee755bd77a8e` into the recorded base.
- However, the Gitleaks PR-diff command in that same job uses the range `2b0e8f74bbb5ce5ca8f22613f9137d0c3ccf6473^..e5745a254eab612f9efa8c75636e71f2fc34e5ea`, not the exact branch HEAD `055a3fd...`. The run is therefore **not accepted as exact-HEAD PR-diff evidence**. The workflow event/range snapshot and checkout merge snapshot are inconsistent and require investigation in the scanner workflow/event metadata.
- The 13 historical detections are the same known categories: one application idempotency identifier in `cloud-engineering-connector/worker.js`; nine synthetic test fixtures in `cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js`; one local marker-key test fixture in `tools/9router-review/review.test.mjs`; and two public ICU repository/commit/fingerprint references in the Master Brain audit document. Context inspection of the application identifier shows it is composed for admission-receipt idempotency, not used as an authentication token. The test fixture values are test-only in their cited historical commits; the ICU values are public repository/signing-fingerprint metadata. These classifications remain **PROVISIONALLY_SUPPORTED**, not a credential clearance.
- No secret values were read. External secret-store reuse and revocation remain **UNKNOWN**. No findings were suppressed or allowlisted.
- The current-head combined status query returned no status entries. The workflow-run association alone does not prove a current-head test or trusted scanner pass.

### Runtime test execution gate

- The deterministic concurrency regression remains present at the current branch snapshot.
- The hosted run above is a Gitleaks workflow; it did not execute `npm ci` or `npm test`.
- No available GitHub connector action provides a safe arbitrary command execution or workflow-dispatch path for this branch. The only observed workflow run is the security scan; it cannot establish the concurrency test's RED result.
- Test execution remains **NOT_RUN**. The expected duplicate POST remains a static prediction, not an observed reproduction. No GREEN implementation is authorized before a valid RED result.
- The TDD supporting reference `writing-good-tests.md` could not be retrieved from the installed skill bundle; this is a process-reference limitation, not a test result.

### Disposition and next falsification requirements

1. Preserve the reviewer as disabled and PR #463 as Draft.
2. Do not treat the associated Gitleaks run as exact-head PR-diff evidence; reconcile the event SHA/range against the checkout merge SHA.
3. Obtain an isolated, reproducible Node.js 22 execution of the exact test file and record command, exit code, assertion output, and exact tested commit. If the assertion fails, verify the failure is specifically the physical duplicate POST count, not setup or syntax.
4. Only after valid RED, define and test the durable reservation adapter contract with independent clients and crash/acknowledgement fault injection.
5. Do not select a storage vendor, change source implementation, register the workflow on `main`, activate reviewer/provider dispatch, merge, read/change secrets, deploy Cloudflare, or alter the local host in this checkpoint.

**Checkpoint verdict:** static race finding remains **PROVISIONALLY_SUPPORTED**; concurrency runtime reproduction **NOT_RUN**; exact-head PR-diff Gitleaks evidence **UNKNOWN** due event-range mismatch; full-history scan **FAIL** with 13 provisionally classified detections; reviewer activation **BLOCKED**.


## Deterministic concurrency race — hosted RED reproduction — 2026-11-24

### Execution identity

- Isolated verification branch: `verify/9router-concurrency-red-2026-11-24`.
- Verification commit: `1f04aacde97fbd342e491b7db4f6c75f2d8f63b9`.
- Verification branch was created from PR #463 documentation checkpoint `00ff2ddeb297583a8994ad89881d79959f3c11c6`.
- Target test file blob: `4153df7ab5a4a259c612d82a1c2a2d4833fe031e`.
- Temporary workflow: `.github/workflows/9router-concurrency-red.yml`; it exists only on the isolated verification branch and was not added to PR #463.
- Workflow commit: `1f04aacde97fbd342e491b7db4f6c75f2d8f63b9`.
- Runner: GitHub-hosted `ubuntu-24.04`.
- Runtime: Node.js `v22.23.5`; npm `10.9.9`.
- Dependency installation: `npm ci --ignore-scripts --no-audit --no-fund`; completed successfully, one locked package installed.
- Test command: `node --test --test-name-pattern="deterministic concurrent duplicate-publication red test" review.test.mjs`.
- Workflow run: `45468257408`; job: `138708889846`.
- Run URL: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45468257408

### Observed result

- Both independent `runReview()` invocations reached and completed the synchronized empty comment-history preflight; otherwise the barrier would not have released and the test would not have reached its assertion.
- The test failed at the intended physical side-effect assertion:
  - Assertion: `one immutable PR snapshot must produce at most one comment POST`.
  - Expected: `1`.
  - Actual: `2`.
  - Error: `AssertionError [ERR_ASSERTION]`.
  - Test location: `review.test.mjs:3587:10`.
  - Test duration: approximately 18.5 ms.
  - Test summary: 1 test, 0 pass, 1 fail; process exit code 1.
- Setup, checkout, Node setup, and locked dependency installation all succeeded. The failure was not a dependency, syntax, or runner-setup failure.
- This is a deterministic reproduction of duplicate physical comment publication under the tested interleaving. It is not merely a predicted race.

### Updated finding status

- `9R-ATOMIC-001`: **REPRODUCED / CONFIRMED FOR TESTED INTERLEAVING**.
- Evidence scope: two independent in-process `runReview()` invocations sharing a deterministic fake GitHub transport and identical immutable PR snapshot.
- The result proves the current implementation does not enforce at-most-one comment POST for this interleaving.
- It does not prove behavior across multiple operating-system processes, independent hosts, or a durable reservation service; those remain untested.
- Model-call count was not asserted in this failing execution because the physical-POST assertion is intentionally first. Do not infer or report a measured model-call count from this run.
- No production implementation was changed. No live GitHub comment or model-provider request was sent by the test; all test HTTP calls were intercepted.
- The temporary workflow grants only `contents: read`, uses pinned checkout/setup-node actions, installs with lifecycle scripts disabled, and runs only the targeted test. It does not access repository secrets, dispatch the reviewer, or deploy anything.

### Required next phase

1. Preserve this RED run and do not alter the failing assertion to make the test green.
2. Define a storage-independent reservation adapter contract and its state-transition API before choosing a vendor.
3. Add independent-client conformance tests for unique claim, CAS, fencing, lease expiry, one-shot publication intent, lost acknowledgement, and fail-closed behavior.
4. Compare at least two backend candidates against those tests and documented consistency semantics.
5. Implement only after the adapter contract and backend evidence are independently reviewed; then require a fresh GREEN run of this exact regression plus the full suite.

**Disposition:** race reproduction **CONFIRMED for the tested interleaving**; durable fix **NOT_STARTED**; backend **NOT_SELECTED**; reviewer activation **BLOCKED**; PR #463 remains Draft / Open / Unmerged.

## Integrated Reservation Adapter Contract and Adversarial Design Review — 9R-ATOMIC-001 — 2026-11-24

**Authority:** This section is the current normative design for 9R-ATOMIC-001. It supersedes earlier draft text in this file wherever state names, transition rules, retry semantics, model-dispatch treatment, or recovery behavior conflict. Earlier sections remain historical evidence and are not an implementation contract.

**Design disposition:** integrated contract drafted and adversarially reviewed at design level; implementation NOT_AUTHORIZED; backend NOT_SELECTED; conformance tests NOT_EXECUTED; independent external security review NOT_COMPLETED; reviewer activation BLOCKED.

### 1. Problem statement and guarantee boundary

The reproduced defect is two concurrent reviewer invocations observing an empty marker-comment history and both issuing a physical GitHub comment POST for the same immutable PR snapshot. The durable reservation authority must arbitrate this race across independent processes and hosts, not merely within one process.

The system has two potentially costly or externally visible effects:

1. A model-provider request, which may incur cost or consume quota.
2. A GitHub comment-creation request, which has no transactional idempotency key coupled to the reservation database.

The contract therefore makes two deliberately narrow claims:

- **At-most-one authorized model-dispatch attempt per reservation key.**
- **At-most-one authorized GitHub comment-creation attempt per reservation key.**

These are application-protocol guarantees contingent on a conforming linearizable store, a single-use transition discipline, and a transport that performs no hidden retries. They are NOT exactly-once execution, exactly-once billing, exactly-once delivery, or proof that a remote service received the request exactly once.

A durable pre-effect transition is committed before each external request. If a worker crashes after that transition but before sending, the operation may never happen. If the remote service accepts a request but the response or local acknowledgement is lost, the outcome is UNKNOWN. The system chooses safety over automatic liveness and MUST NOT repeat that effect automatically.

### 2. Immutable identity and canonicalization

The logical reservation key is:

`(repository_id, pull_request_number, head_sha, base_sha)`

- `repository_id` is the immutable numeric GitHub repository ID. Repository owner/name is metadata, not identity.
- `pull_request_number` is the canonical positive repository-local integer.
- `head_sha` and `base_sha` are full commit object IDs from one validated live PR snapshot.
- Canonical serialization is versioned, length-delimited, UTF-8, and deterministic. A SHA-256 digest may be used as the physical primary key, but every original tuple field MUST be stored and compared after lookup; digest equality alone is insufficient.
- A repository rename preserves the key. A changed head or base creates a different key.
- The reviewer policy/runtime digest is recorded with the row. A policy mismatch for an existing key is a conflict requiring an explicit versioning decision; it MUST NOT silently create a second reservation and duplicate comment for the same PR snapshot. At claim time, derive a deterministic marker ID as SHA-256 over the versioned canonical reservation tuple plus policy and runtime digests. This ID MUST be independent of the HMAC signing key so key rotation cannot create a second marker identity. Persist the signing-key ID separately for signature verification. After the review payload exists, compute its canonical digest and HMAC-sign the tuple, policy digest, marker ID, and payload digest. Retain verification capability for old signing-key IDs for at least the replay horizon.
- Rows are durable tombstones for at least the complete replay/retention horizon. Deletion or key reuse is prohibited unless a separately reviewed archival protocol preserves uniqueness and audit evidence.

### 3. Normative record

The logical record contains:

- Identity: `key_version`, `reservation_key`, `repository_id`, `pull_request_number`, `head_sha`, `base_sha`.
- Contract identity: `reviewer_policy_digest`, `runtime_digest`, `schema_version`.
- Ownership: `state`, `generation`, `owner_id`, `owner_nonce`, `lease_expires_at`.
- Model boundary: `model_attempt_id`, `model_request_digest`, `model_result_digest`, `model_attempt_deadline_at`, `model_effect_ledger_intent_id`, `model_effect_ledger_outcome_id`, and a protected durable result reference or encrypted result envelope when continuation requires the result.
- Comment boundary: `comment_attempt_id`, `comment_payload_digest`, `comment_marker_id`, `comment_marker_key_id`, `comment_marker_signature`, `comment_remote_id`, `comment_accepted_at`, `comment_attempt_deadline_at`, `snapshot_validation_id`, `snapshot_validation_digest`, `comment_effect_ledger_intent_id`, `comment_effect_ledger_outcome_id`.
- Diagnosis: `unknown_stage`, `unknown_reason_code`, `last_error_class`.
- Audit: monotonic `record_version`, `created_at`, `updated_at`, and append-only transition events with actor, prior/new state, generation, operation ID, server timestamp, and reason.

The model/comment attempt deadline fields are written in the same transaction as the one-time attempt transition and are used only by a recovery worker to classify a lost worker as UNKNOWN; they never authorize a retry. A marker signature is an HMAC over the canonical reservation tuple, policy digest, runtime digest, marker ID, and payload digest, using a separately protected signing key identified by `comment_marker_key_id`. Reconciliation requires the expected bot author identity and a valid signature; a user-authored or invalidly signed lookalike is not a match.

Secrets, provider credentials, raw authorization headers, signing keys, and unredacted prompts MUST NOT be stored in the reservation record. If a model result must survive a worker restart, the result reference must resolve to an access-controlled, integrity-checked, encrypted durable object. The record may enter `MODEL_COMPLETED` only after the result is durably retrievable and its digest is committed. An orphaned result object is safe to garbage-collect only after proving no live record references it.

### 4. State machine

Normative states:

| State | Meaning | Lease takeover |
|---|---|---|
| `UNCLAIMED` | No reservation row exists | Initial claim only |
| `CLAIMED` | One owner has a valid lease; no external effect has been authorized | Yes, after authoritative expiry and generation increment |
| `MODEL_ATTEMPTED` | The one-time model dispatch boundary was durably consumed; remote execution may or may not have started | Never |
| `MODEL_COMPLETED` | One model result is durably recorded and bound to the reservation | Yes, by a continuation-only lease that cannot repeat model dispatch |
| `COMMENT_ATTEMPTED` | The one-time GitHub comment POST boundary was durably consumed; remote acceptance may or may not have occurred | Never |
| `PUBLISHED` | One exact matching remote comment ID is recorded from validated positive evidence; this is not an exactly-once delivery claim | Terminal except escalation to `DUPLICATE_ACCEPTED` if later evidence proves duplicates |
| `UNKNOWN` | An external effect may have happened, but evidence is insufficient to determine the result | Never automatically |
| `ABORTED` | Safely stopped before the model-attempt boundary | Terminal for this key |
| `CLOSED_NO_PUBLISH` | Model result exists, but publication was safely suppressed (for example, the PR snapshot became stale) | Terminal for this key |
| `DUPLICATE_ACCEPTED` | More than one matching remote comment is positively observed | Terminal incident state |

Allowed transitions:

| From | To | Atomic preconditions |
|---|---|---|
| absent / `UNCLAIMED` | `CLAIMED` | Unique insert or linearizable CAS; allocate generation 1 and owner nonce; persist deterministic marker ID and signing-key ID |
| `CLAIMED` | `PUBLISHED` | Complete pre-model reconciliation finds exactly one valid signed marker from the expected bot for this exact key; no model request |
| `CLAIMED` | `DUPLICATE_ACCEPTED` | Complete pre-model reconciliation finds more than one valid signed marker for this exact key; no model request |
| `CLAIMED` | `ABORTED` | Explicit safe abort before model-attempt boundary |
| `CLAIMED` | `CLAIMED` | Renew only if owner, nonce, generation, record version, and server-side lease validity match |
| expired `CLAIMED` | `CLAIMED` | Server-time expiry predicate and CAS; increment generation and replace owner/nonce |
| `CLAIMED` | `MODEL_ATTEMPTED` | One-time CAS consumes the model attempt before any provider request |
| `MODEL_ATTEMPTED` | `MODEL_COMPLETED` | Matching attempt ID; durable result reference and digest committed |
| `MODEL_ATTEMPTED` | `UNKNOWN` | Provider timeout, attempt deadline expiry, worker crash recovery, lost acknowledgement, or any ambiguous result |
| `MODEL_COMPLETED` | `MODEL_COMPLETED` | Continuation lease acquisition by CAS only when no valid continuation lease exists or its server-time expiry is reached; increment generation and replace owner/nonce; no model dispatch is authorized |
| `MODEL_COMPLETED` | `PUBLISHED` | Positive exact reconciliation finds one comment matching this reservation's persisted signed marker; no POST |
| `MODEL_COMPLETED` | `DUPLICATE_ACCEPTED` | Positive exact reconciliation finds more than one comment matching this reservation's persisted signed marker; no POST |
| `MODEL_COMPLETED` | `COMMENT_ATTEMPTED` | Snapshot revalidation; complete duplicate preflight; one-time CAS consumes the comment attempt before POST |
| `MODEL_COMPLETED` | `CLOSED_NO_PUBLISH` | Explicit safe stop after model completion (for example, stale PR snapshot); no comment POST |
| `COMMENT_ATTEMPTED` | `PUBLISHED` | Validated 201 response plus durable remote ID commit, or authoritative positive reconciliation |
| `PUBLISHED` | `DUPLICATE_ACCEPTED` | Later complete exact reconciliation positively identifies more than one matching comment |
| `COMMENT_ATTEMPTED` | `UNKNOWN` | Any ambiguous POST or persistence outcome |
| `UNKNOWN` | `PUBLISHED` | Positive reconciliation identifies exactly one matching remote comment |
| `UNKNOWN` | `DUPLICATE_ACCEPTED` | Comment-stage positive reconciliation identifies more than one matching remote comment; model-stage UNKNOWN is ineligible |

No transition from `MODEL_ATTEMPTED`, `COMMENT_ATTEMPTED`, `UNKNOWN`, `PUBLISHED`, `ABORTED`, or `DUPLICATE_ACCEPTED` back to `CLAIMED` is permitted. A `MODEL_COMPLETED` row may receive a new continuation lease with a higher generation, but that lease authorizes only comment preparation/publication and cannot repeat inference. Lease expiry never authorizes a second model request or comment POST after the corresponding attempt boundary has been consumed.

### 5. Adapter interface and operation semantics

The storage-independent adapter MUST expose equivalent typed operations. Names below are normative for this design; implementation language syntax may differ.

- `claim(key, owner_id, owner_nonce, lease_duration, policy_digest, runtime_digest, marker_id, marker_key_id) -> CLAIMED | BUSY | EXISTING(record) | KEY_CONFLICT`; for an existing row, return its persisted marker ID/key ID and never replace them as a side effect of key rotation.
- `renew(key, owner_id, owner_nonce, generation, expected_record_version, lease_duration) -> RENEWED(new_record_version) | LOST_OWNERSHIP | EXPIRED`
- `abortBeforeModel(key, owner_id, owner_nonce, generation, expected_record_version, reason_code) -> ABORTED | CONFLICT`
- `resumeCompletedModel(key, owner_id, owner_nonce, expected_record_version, lease_duration) -> RESUMED(new_generation) | BUSY | TERMINAL`
- `closeWithoutPublish(key, owner_id, owner_nonce, generation, expected_record_version, reason_code) -> CLOSED_NO_PUBLISH | CONFLICT`
- `beginModelAttempt(key, owner_id, owner_nonce, generation, expected_record_version, attempt_id, request_digest, effect_ledger_intent_id, effect_ledger_sequence, effect_ledger_digest, attempt_timeout) -> MODEL_PERMIT | LOST_OWNERSHIP | ALREADY_CONSUMED | TERMINAL`; the backend computes and persists the deadline from server time in the same transaction.
- `completeModelAttempt(key, generation, attempt_id, expected_record_version, result_reference, result_digest, effect_ledger_outcome_id) -> MODEL_COMPLETED | CONFLICT | UNKNOWN`
- `beginCommentAttempt(key, owner_id, owner_nonce, generation, expected_record_version, attempt_id, marker_id, payload_digest, snapshot_validation_id, snapshot_validation_digest, effect_ledger_intent_id, effect_ledger_sequence, effect_ledger_digest, attempt_timeout) -> COMMENT_PERMIT | LOST_OWNERSHIP | ALREADY_CONSUMED | TERMINAL`; the backend computes and persists the deadline from server time in the same transaction.
- `completeCommentAttempt(key, generation, attempt_id, expected_record_version, remote_comment_id, validated_response_digest, effect_ledger_outcome_id) -> PUBLISHED | CONFLICT | UNKNOWN`; the caller must validate the HTTP status, exact issue URL/body, expected bot identity/type, marker signature, and payload digest before supplying this digest.
- `markUnknown(key, generation, attempt_id, expected_record_version, stage: MODEL | COMMENT, reason_code) -> UNKNOWN | CONFLICT`; the stage must match the consumed attempt ID and current state.
- `expireAmbiguousAttempt(key, attempt_id, stage) -> UNKNOWN | NOT_DUE | CONFLICT`; the backend evaluates the persisted deadline against its own authoritative server time inside the atomic transition.
- `readAuthoritative(key) -> RECORD | NOT_FOUND | UNAVAILABLE`
- `reconcileComment(key, expected_record_version, verified_positive_evidence[]) -> PUBLISHED | DUPLICATE_ACCEPTED | NO_CHANGE | CONFLICT`; the caller must supply only evidence already verified against the exact key, expected bot identity, marker ID, HMAC, payload digest, and issue URL. One exact match permits PUBLISHED; multiple exact matches permit DUPLICATE_ACCEPTED; zero matches or incomplete listing produce NO_CHANGE and never prove absence.

Every mutating operation is one atomic conditional transaction against the current record. It MUST check the expected state, generation, owner nonce where applicable, attempt ID, and record version. Completion calls are fenced by the generation and attempt ID captured before dispatch; recovery transitions are fenced by the attempt ID and stage. `readAuthoritative` MUST bypass stale replicas and provide a linearizable read for the key. Successful transitions and audit events commit atomically. A stale worker cannot mutate state by presenting an old generation or stale record version.

The marker ID is SHA-256-derived from the reservation key, policy digest, and runtime digest; it is not a per-worker random value and does not depend on the active HMAC key. HMAC key rotation changes only the signing-key ID/signature for newly created reservations; existing reservations retain their persisted marker identity and verification key ID. The signed marker contains the canonical key, policy digest, runtime digest, marker ID, payload digest, and signing-key ID. The signature is HMAC-SHA-256 over a versioned length-delimited UTF-8 canonical envelope. The payload digest is computed over the exact comment body bytes after removing the marker envelope, with UTF-8 and LF line endings; no locale-dependent normalization is permitted. Reconciliation validates the expected bot author ID, HMAC, and digest of the comment body after removing the marker envelope. This lets pre-model reconciliation recognize a previously published result without rerunning inference.

A `snapshot_validation_id` identifies an immutable audit record containing the live repository ID, PR number, head/base SHAs, fetch timestamp, and validation result. `snapshot_validation_digest` commits to that record. The adapter checks that the record is bound to the same reservation tuple; it does not independently authenticate GitHub, which remains the trusted caller's responsibility.

A returned `MODEL_PERMIT` or `COMMENT_PERMIT` is an in-memory authorization to make exactly one transport invocation. It is not a reusable bearer token and MUST NOT be serialized, logged, queued, or retried. The production caller MUST consume it once and call the transport once. The durable state transition prevents another worker from obtaining a second permit. This contract does not claim to defend against malicious application code that deliberately sends the same request multiple times; transport-call-count conformance tests and code review cover that boundary.

### 6. Atomic execution protocol

1. Obtain one live PR snapshot. Validate repository ID, repository full name, PR number, open/draft/locked policy, and full head/base SHAs.
2. Canonicalize the immutable key and atomically `claim`. A loser MUST return without model or comment transport calls. Before model dispatch, perform complete read-only marker reconciliation using the deterministic marker ID. Exactly one valid signed match transitions `CLAIMED -> PUBLISHED`; multiple matches transition to `DUPLICATE_ACCEPTED`; incomplete or unavailable listing blocks progress and does not authorize inference; retain `CLAIMED` until safe lease expiry or explicit pre-model abort.
3. Perform only local bounded preparation while in `CLAIMED`. Lease renewals are conditional CAS operations using server time.
4. Revalidate the live PR snapshot and confirm it still equals the reservation tuple before model dispatch.
5. Append the model attempt intent to the independent effect ledger and require a durable acknowledgement. Then atomically consume `beginModelAttempt` with that ledger receipt. Only after both acknowledgements may the caller issue one provider request. If the commit acknowledgement is lost, read the authoritative row; if the state cannot be established, do not call the provider.
6. Persist the model result durably, append a positive model outcome/result reference to the independent effect ledger, then atomically transition to `MODEL_COMPLETED` with the ledger outcome reference. If the process crashes or the result cannot be proven durable after the model boundary, mark or retain `UNKNOWN`; do not invoke the model again.
7. Revalidate the live PR snapshot again. Perform complete duplicate-marker reconciliation using the persisted marker ID, HMAC signature, expected bot author ID, snapshot tuple, and payload digest. If exactly one matching comment exists, transition `MODEL_COMPLETED -> PUBLISHED`; if more than one exists, transition to `DUPLICATE_ACCEPTED`. If listing is partial, paginated incompletely, stale, or unavailable, do not infer absence; remain blocked/UNKNOWN. A comment with a matching visible marker but invalid signature or wrong author is not accepted as publication evidence. If the listing is incomplete or unavailable at this pre-publication stage, retain `MODEL_COMPLETED` and do not consume the comment permit; a later continuation lease may retry only the read-only reconciliation. If the live PR snapshot has changed, transition to `CLOSED_NO_PUBLISH`.
8. Construct the final comment with an unambiguous marker bound to repository ID, PR number, head SHA, base SHA, policy digest, and payload digest. Persist only the required marker/payload digests in the reservation record.
9. Append the comment attempt intent to the independent effect ledger and require a durable acknowledgement. Then atomically consume `beginCommentAttempt` with that ledger receipt. Only after both acknowledgements may the caller issue one GitHub POST. Configure redirects to error and disable automatic retries in the HTTP client, SDK, proxy, and middleware. A retry at any layer violates this contract.
10. On a validated 201 response, verify a positive comment ID, exact issue URL, exact expected body, expected bot user ID/type, and the signed marker. Append the validated publication outcome to the independent effect ledger, then atomically persist the remote comment ID, response digest, ledger outcome reference, and `PUBLISHED`. Any missing/mismatched field is UNKNOWN, not success. If the response or storage acknowledgement is ambiguous, retain/mark `UNKNOWN` and reconcile read-only.
11. Comment-stage reconciliation may move `UNKNOWN` to `PUBLISHED` only on exactly one positive exact match. More than one match becomes `DUPLICATE_ACCEPTED`. Zero matches, incomplete pagination, API failure, eventual visibility uncertainty, or stale reads remain `UNKNOWN`; they never authorize a second POST. Model-stage `UNKNOWN` is not eligible for comment reconciliation and remains terminal for automatic execution. Provider-side evidence may be attached to the audit trail, but this contract defines no automatic transition out of model-stage UNKNOWN and MUST NOT issue another model request.

### 7. Fencing, clocks, and consistency

- The reservation authority MUST provide a unique constraint and linearizable single-record conditional writes or serializable transactions for the key.
- Generation allocation and row mutation occur in the same transaction. Generations are monotonically increasing and never reused.
- Lease expiry is evaluated using authoritative backend time inside the conditional transaction, not worker wall clocks.
- Every mutation before an irreversible effect requires the current generation, owner nonce, and expected record version.
- Once `MODEL_ATTEMPTED` or `COMMENT_ATTEMPTED` is committed, the lease is no longer a takeover mechanism. The row is pinned to its consumed attempt; recovery is reconciliation, not reassignment.
- Stale replicas, eventually consistent reads, last-write-wins updates, cache locks, workflow concurrency groups, and local mutexes are not reservation authorities.
- A lost commit acknowledgement is an ambiguous commit. The caller must read the authoritative key and reconcile the exact attempt ID. It must not optimistically repeat the mutation or external request.

### 7A. System-level restore gate

Per-reservation state alone cannot detect that a database restore erased rows created after the restore point. Therefore the service has a separate system mode, held outside the reservation store's backup/restore domain:

- `ACTIVE`: reservation operations may proceed subject to all per-key invariants.
- `RECOVERY_LOCKED`: no model-provider or GitHub comment transport call is permitted for any key.

A restore or rollback operation MUST follow this order:

1. Disable all effectful dispatch at the trusted Worker/workflow boundary.
2. Set the out-of-band monotonic recovery anchor to RECOVERY_LOCKED and increment its recovery epoch before restoring the reservation store.
3. Restore the database and keep all callers fail-closed.
4. Reconcile the restored database against a complete, independently durable, append-only inventory of all model/comment attempt intents and confirmed outcomes created after the restore point.
5. Reconstruct missing reservation tombstones and consumed attempt states. Any attempt intent without conclusive evidence that the external request was not sent is UNKNOWN; it MUST NOT be retried.
6. Verify the inventory's completeness, sequence continuity, integrity, and replay result. Only a separately approved recovery operation may set the out-of-band anchor back to ACTIVE.

The append-only inventory must be outside the restored store's backup/rollback domain, have durable acknowledged writes, unique attempt IDs, and complete ordered lookup by reservation key. Its minimal API is `appendIntent(key, stage, attempt_id, request_digest) -> ACK(sequence, digest) | UNKNOWN`, `appendOutcome(attempt_id, outcome_type, evidence_digest, evidence_reference) -> ACK | UNKNOWN`, and `readComplete(key) -> COMPLETE(events, watermark) | INCOMPLETE | UNAVAILABLE`. The ledger must be append-only; duplicate attempt IDs with different payloads are a hard integrity conflict. The design and provider for this inventory are NOT_SELECTED. A backup or PITR feature alone does not satisfy this requirement. If no independent complete inventory exists, or if any gap cannot be explained, the system remains RECOVERY_LOCKED; safety takes precedence over availability.

This protocol is deliberately fail-stop. It does not claim that restoring a database snapshot can preserve monotonic state without independent evidence. Candidate qualification MUST include a restore drill that attempts to roll back across both external-effect boundaries.

### 8. Snapshot race and external-service limitations

The PR head/base check and GitHub comment POST are not one cross-service transaction. A PR can change after the last live snapshot read but before the comment POST. The comment marker MUST therefore bind the exact repository/PR/head/base/policy/runtime tuple, and consumers must treat a comment for an older head as stale. The implementation should minimize this interval and recheck immediately before consuming the comment permit, but it cannot eliminate the cross-service time-of-check/time-of-use race without a GitHub-side conditional publication primitive.

GitHub comment listing must traverse every page and verify pagination completion within an explicit bounded page/response budget. If the bound is exceeded, a page fails, or pagination metadata is inconsistent, the listing is incomplete and the caller must fail closed. GitHub comment listing may not provide a transactional negative proof under every failure/visibility condition. Reconciliation is therefore positive-evidence oriented. A zero-result list is not proof that a POST was never accepted. If exactly-one positive evidence cannot be obtained, retain `UNKNOWN` and require a separately reviewed manual disposition; do not auto-retry.

A recovery worker may move an overdue `MODEL_ATTEMPTED` or `COMMENT_ATTEMPTED` row to stage-specific `UNKNOWN` using the persisted attempt deadline and authoritative server time. It cannot move the row back to a pre-effect state. `UNKNOWN` with `unknown_stage=MODEL` is terminal for automatic execution; comment reconciliation APIs must reject it. `UNKNOWN` with `unknown_stage=COMMENT` permits read-only positive reconciliation only.

The model provider may also lack a caller-supplied idempotency key or execution-status query. A recovery worker may move an overdue `MODEL_ATTEMPTED` row to `UNKNOWN` using the attempt ID and server time, but cannot infer whether the provider executed or billed the request. Model-stage `UNKNOWN` is distinct from comment-stage `UNKNOWN`; `reconcileComment` MUST reject a model-stage row.

### 9. Safety invariants

- **I1 — Key uniqueness:** at most one durable row per canonical immutable key.
- **I2 — Single pre-effect owner:** at most one current generation may mutate a `CLAIMED` row.
- **I3 — Stale fencing:** stale owner nonce, generation, or record version cannot mutate the row or obtain an effect permit.
- **I4 — Model single-attempt:** no provider request occurs before durable `MODEL_ATTEMPTED`; no second permit or automatic retry exists afterward.
- **I5 — Comment single-attempt:** no comment POST occurs before durable `COMMENT_ATTEMPTED`; no second permit or automatic retry exists afterward.
- **I6 — Irreversible ambiguity:** ambiguous effect outcomes remain `UNKNOWN`; timeouts and lease expiry never reset attempt state.
- **I7 — Snapshot binding:** every record and comment marker binds the same repository ID, PR number, head SHA, and base SHA.
- **I8 — Evidence-based publication:** `PUBLISHED` requires one validated remote comment ID, not merely a local intent or socket write.
- **I9 — Audit atomicity:** every committed state transition has a durable audit event in the same transaction.
- **I10 — Fail closed:** store outage, stale read, CAS conflict, schema mismatch, clock uncertainty, or incomplete reconciliation blocks the next external effect.
- **I11 — No hidden transport retries:** provider and GitHub redirects, SDK retries, proxy retries, and middleware retries are disabled or proven absent.
- **I12 — No silent key reuse:** retention/cleanup cannot delete or recycle a key while replay is possible.
- **I13 — Stage-scoped UNKNOWN:** model-stage UNKNOWN cannot be resolved through comment lookup; comment-stage UNKNOWN permits only positive read-only reconciliation.
- **I14 — Authenticated marker:** publication reconciliation requires the expected bot author, valid HMAC, exact reservation tuple, policy/runtime digests, marker ID, and body digest.
- **I15 — Generation-fenced completion:** asynchronous completion must match the consumed attempt ID and generation; stale owners cannot finalize another attempt.
- **I16 — No false abort semantics:** ABORTED is pre-model only; post-model suppression is recorded as CLOSED_NO_PUBLISH.
- **I17 — No inference on uncertain preflight:** incomplete or unavailable pre-model comment listing retains CLAIMED and blocks model dispatch.
- **I18 — No publication on uncertain post-model preflight:** incomplete or unavailable post-model listing retains MODEL_COMPLETED and blocks comment-attempt consumption.
- **I19 — Bounded reconciliation:** pagination must complete within an explicit page/response budget; exceeding it is UNKNOWN/incomplete, never negative proof.
- **I20 — Rotation-stable marker identity:** marker ID is independent of HMAC key rotation; existing rows retain their persisted signing-key ID.
- **I21 — Fenced reconciliation:** reconciliation mutations require expected record version and verified positive evidence tied to the exact reservation key.
- **I22 — Explicit terminal operations:** every normative transition to ABORTED or CLOSED_NO_PUBLISH has a typed, fenced adapter operation.
- **I23 — Continuation ownership:** comment-attempt authorization requires the current continuation owner ID, nonce, and generation.
- **I24 — Publication response evidence:** PUBLISHED requires a validated response digest committed with the remote comment ID.
- **I25 — Restore monotonicity:** point-in-time restore never silently re-enables model/comment effects; restore requires an independent monotonic recovery epoch and complete audit reconciliation.
- **I26 — Write-ahead effect inventory:** no external effect is issued unless both the independent ledger intent and the primary-store attempt transition are durably acknowledged.

### 10. Adversarial conformance matrix

Every test must run against the same adapter contract with at least two independent clients and worker instances. Production-grade evidence requires separate processes; a single-process fake mutex is insufficient. The fake adapter may be used for deterministic unit tests but cannot establish backend linearizability.

| ID | Adversarial schedule or fault | Required observation |
|---|---|---|
| A01 | 100 concurrent claims for one key | Exactly one current generation/owner; all others BUSY or observe existing state |
| A02 | Two clients read absence before simultaneous insert | Unique constraint/CAS admits one row only |
| A03 | Same digest with mismatched original tuple | KEY_CONFLICT; no overwrite or external call |
| A04 | Old owner pauses; lease expires; new owner claims | Generation increments atomically; stale owner cannot mutate |
| A05 | Old owner resumes after takeover | Renew, abort, beginModelAttempt, and beginCommentAttempt all reject |
| A06 | Claim commit succeeds but response acknowledgement is lost | Authoritative read recovers same owner/attempt or blocks; no duplicate claim side effect |
| A07 | Worker crashes after CLAIMED and before MODEL_ATTEMPTED | Expiry permits safe takeover |
| A08 | Two workers race to beginModelAttempt | One permit only; one provider transport invocation maximum |
| A09 | Crash after MODEL_ATTEMPTED commit but before provider socket write | No second model permit; row becomes/retains UNKNOWN |
| A10 | Provider accepts request but response times out | UNKNOWN; no model retry |
| A11 | Provider returns result but durable result write/ack is lost | No second model request; result recovered by digest or UNKNOWN |
| A12 | Model result is durable; worker crashes before comment attempt | Resume from durable result without repeating model request |
| A13 | Two workers race to beginCommentAttempt | One permit only; one physical POST maximum |
| A14 | Crash after COMMENT_ATTEMPTED commit but before socket write | No second POST; UNKNOWN/stranded reservation is accepted safety cost |
| A15 | GitHub accepts POST but client times out | UNKNOWN; no automatic retry |
| A16 | GitHub returns 201 but completion transaction acknowledgement is lost | Authoritative read/reconciliation records same remote ID or UNKNOWN; no POST retry |
| A17 | HTTP 307/308, 5xx, reset, cancellation, malformed response | No hidden retry; ambiguous outcomes remain UNKNOWN |
| A18 | Comment listing is partial, paginated incompletely, stale, or unavailable | Zero result cannot authorize POST or reset |
| A19 | Reconciliation finds exactly one exact marker/snapshot/payload match | PUBLISHED with remote comment ID |
| A20 | Reconciliation finds two matching comments | DUPLICATE_ACCEPTED and incident evidence; no further POST |
| A21 | PR head or base changes after reservation | Old key cannot authorize a new snapshot; marker remains bound to old snapshot |
| A22 | PR head changes after last GET but before POST | Marker identifies stale snapshot; no false claim that cross-service TOCTOU is eliminated |
| A23 | Repository rename with same repository ID | Same logical key |
| A24 | Backend failover, stale replica, split brain, or lost commit acknowledgement | No fallback to local lock; reject unless linearizability is preserved |
| A25 | Backend clock skew or lease comparison at exact expiry boundary | Server-side transactional time decides; no worker-clock takeover |
| A26 | Storage outage before claim or either effect transition | No model request or comment POST |
| A27 | Schema/policy digest mismatch | Fail closed; no implicit migration or second key |
| A28 | Retention cleanup races with replay | Tombstone/unique key remains; no duplicate reservation |
| A29 | HTTP client/SDK/proxy retry configured | Conformance test detects more than one transport invocation; candidate integration rejected |
| A30 | Process termination at every transition boundary | Recovery outcome matches the state table; no transition regresses across an irreversible boundary |
| A31 | Worker crashes in MODEL_COMPLETED before comment preparation | New continuation generation resumes from the durable result; model transport count remains one |
| A32 | Recovery worker sees overdue MODEL_ATTEMPTED or COMMENT_ATTEMPTED | Stage-specific UNKNOWN is recorded; no external retry is authorized |
| A33 | User forges marker text or copies marker without valid HMAC/bot identity | Reconciliation rejects it as publication evidence |
| A34 | Existing exact signed marker is present before model dispatch | `CLAIMED -> PUBLISHED`; model transport count remains zero |
| A35 | MODEL_COMPLETED owner crashes; continuation lease is reclaimed | Generation increments; old owner is fenced; persisted model result is reused |
| A36 | `reconcileComment` is called for model-stage UNKNOWN | Adapter rejects the operation; no state transition or external call |
| A37 | Pre-model marker listing is incomplete or unavailable | CLAIMED is retained; model transport count remains zero |
| A38 | Post-model marker listing is incomplete or unavailable | MODEL_COMPLETED is retained; comment POST count remains zero |
| A39 | Comment pagination exceeds its configured bound or returns inconsistent continuation metadata | Listing is classified incomplete; no inference/publication transition is authorized |
| A40 | Provider SDK or proxy silently retries one model request | More than one provider transport invocation is detected; integration is rejected |
| A41 | Authoritative store is restored to a point before one or more effect-boundary commits | Enter global RECOVERY_LOCKED mode; no model/comment transport is permitted until the independent monotonic recovery anchor and complete audit inventory are reconciled; if completeness cannot be proven, keep the store quarantined |

### 11. Adversarial design review — findings and disposition

The design was challenged against the reproduced interleaving, independent-host races, lease expiry, process termination, ambiguous provider/GitHub outcomes, stale reads, partial pagination, PR snapshot changes, and hidden transport retries. The following weaknesses were identified and incorporated into the normative contract above:

- **AR-01 — Model inference was not protected by an irreversible attempt boundary.** A lease takeover after a provider accepted a request could duplicate cost. Corrected by introducing `MODEL_ATTEMPTED` before the provider call and prohibiting takeover/retry afterward.
- **AR-02 — A single PUBLISHING state conflated intent with actual transport authorization.** Corrected by using `COMMENT_ATTEMPTED` as the one-time durable boundary immediately before one transport invocation. It remains possible to strand a reservation if the process dies between commit and socket write; that is explicitly accepted and cannot be repaired by retry without weakening the at-most-one guarantee.
- **AR-03 — “Exactly one publish permit” could be misread as exactly-once delivery.** Corrected by stating the guarantee as at-most-one authorized application-level attempt, contingent on no hidden retries; no exactly-once remote effect is claimed.
- **AR-04 — Ambiguous commit acknowledgement was underspecified.** Corrected by requiring authoritative read/reconciliation by immutable key and attempt ID; no speculative retry.
- **AR-05 — A lease could be mistaken for authority to reclaim an in-flight external call.** Corrected: leases are reclaimable only while in `CLAIMED`; both external-effect attempt states are non-reclaimable.
- **AR-06 — The PR snapshot check cannot be atomic with GitHub comment creation.** Recorded as an unavoidable TOCTOU limitation; bind the marker to the snapshot and require stale-comment detection.
- **AR-07 — Negative comment search could be mistaken for proof of non-publication.** Corrected: only positive exact evidence can reconcile to PUBLISHED; zero/incomplete results remain UNKNOWN.
- **AR-08 — Hidden retries below the application layer could violate the guarantee.** Added explicit transport/SDK/proxy retry prohibition and a transport-call-count test.
- **AR-09 — Policy/runtime changes could silently reuse an existing key.** Added policy/runtime digest binding and explicit conflict behavior.
- **AR-10 — Result loss after model completion could force duplicate inference.** Added durable result-reference/digest requirement before MODEL_COMPLETED and a resume-without-reinference test.
- **AR-11 — MODEL_COMPLETED had no explicit crash-resume ownership protocol.** Added `resumeCompletedModel`, which atomically increments generation and grants a continuation-only lease; it cannot reissue the model permit.
- **AR-12 — Recovery workers lacked a bounded rule for abandoned attempt states.** Added attempt deadlines and `expireAmbiguousAttempt`; expiry moves an attempt to UNKNOWN only and never authorizes retry.
- **AR-13 — A visible marker could be forged by a user or copied into an unrelated comment.** Added HMAC marker signature, key ID, exact snapshot/payload binding, and expected bot-author verification.
- **AR-14 — Existing-comment reconciliation had no explicit MODEL_COMPLETED transition.** Added positive-evidence transitions to PUBLISHED or DUPLICATE_ACCEPTED before a new POST; incomplete or untrusted evidence remains non-publishable.
- **AR-15 — The marker could not be checked before inference without a known output digest.** Made the marker ID deterministic per key/policy/runtime and the signed marker self-authenticating; its embedded payload digest is verified against the comment body, allowing trusted pre-model deduplication without rerunning inference.
- **AR-16 — MODEL_COMPLETED continuation had no precise lease-reclaim condition.** Restricted continuation takeover to absent/expired server-time leases and required a new generation, leaving the model attempt permanently consumed.
- **AR-17 — The original ABORTED definition conflicted with a post-model safe stop.** Restricted ABORTED to pre-model termination and introduced CLOSED_NO_PUBLISH for a completed model result that must not be published.
- **AR-18 — Completion and recovery mutations were not fully fenced.** Added generation/record-version conditions to comment completion and made expiry use backend time inside the transaction.
- **AR-19 — Later evidence of duplicate comments had no escalation path from PUBLISHED.** Added the explicit PUBLISHED -> DUPLICATE_ACCEPTED incident transition.
- **AR-20 — Preflight uncertainty did not distinguish safe pre-effect states.** Specified that incomplete pre-model listing retains CLAIMED and incomplete post-model listing retains MODEL_COMPLETED; neither permits the next external effect.
- **AR-21 — A successful HTTP status alone could be mistaken for publication proof.** Required exact response ID, issue URL, body, bot identity/type, and marker verification before PUBLISHED.
- **AR-22 — Pagination completion and provider-side retry layers were not fully bounded.** Added explicit pagination budgets and a provider transport-call-count test.
- **AR-23 — Marker identity was coupled to the HMAC key, so signing-key rotation could derive a second marker for the same reservation.** Decoupled marker ID from signing-key material: SHA-256 binds the canonical tuple/policy/runtime, while HMAC key ID and signature remain separate and persisted.
- **AR-24 — The interface omitted explicit operations for two normative terminal transitions.** Added `abortBeforeModel` and `closeWithoutPublish` so ABORTED/CLOSED_NO_PUBLISH are not undocumented state mutations.
- **AR-25 — A continuation lease holder was not explicitly required to prove owner nonce at the comment-attempt boundary.** Added owner ID and nonce to `beginCommentAttempt`.
- **AR-26 — PUBLISHED could be committed without a durable digest of the validated GitHub response.** Added `validated_response_digest` to the completion operation and snapshot-validation evidence fields.
- **AR-27 — Point-in-time restore could roll the reservation authority behind an already-consumed external-effect boundary.** Added a system-level `RECOVERY_LOCKED` mode and an independent monotonic recovery anchor requirement. A restored store cannot resume effectful operations until its audit inventory is proven complete; if that proof is unavailable, the store remains quarantined.
- **AR-28 — A backup restore cannot reconstruct external attempts from the database alone.** Added an independent append-only effect ledger with write-ahead intent acknowledgements and outcome evidence; the database remains the transactional reservation authority, while the ledger is the rollback-independent recovery inventory.

**Residual design limitations (not defects that this contract can eliminate):**

1. A crash after an attempt boundary but before the network call can leave an operation that never happened in UNKNOWN. This is the cost of refusing blind retry.
2. The store and external provider/GitHub API do not share a transaction. Remote acceptance cannot always be inferred from a lost response.
3. A PR may change between the final snapshot read and comment POST. The marker makes staleness detectable, not impossible.
4. At-most-one application attempt depends on the caller and transport honoring the single-use permit and disabling all retry layers. It is not a defense against a malicious or defective caller that deliberately duplicates requests.
5. Backend linearizability, durability, server-side time, failover, and cost remain unproven until candidate-specific conformance tests and documentation review are completed.
6. Point-in-time restore can roll state backward across an external-effect boundary. A backup feature alone is not a safety guarantee; restore must enter global RECOVERY_LOCKED mode until an independent monotonic anchor and complete event inventory prove that no consumed attempt was erased. Without that proof, the backend is not safe to resume.

### 12. Backend selection gate

No vendor is selected in this phase. At least two candidate backends must be assessed against the same contract and evidence checklist:

- atomic unique insert and conditional update semantics under independent concurrent clients;
- documented consistency and read-after-write behavior;
- generation/fencing and server-side lease-time implementation;
- transaction durability and acknowledgement-loss recovery;
- behavior under regional failover, stale replica, network partition, and split brain;
- least-privilege credentials, audit trail, encryption, backup, retention, and restore;
- data residency, operational burden, rate limits, and failure modes;
- actual total cost at forecast read/write volume, retention, backup, and egress, including free-tier ceilings and card requirements;
- executable A01–A41 conformance results on the candidate, not only vendor marketing claims.

A backend that cannot satisfy every mandatory safety property is rejected regardless of price or convenience. Workflow concurrency groups may be defense in depth only; they are not the authority.

### 12A. Evidence-based backend screening — 2026-11-25

This is a documentation-based screening, not a deployed benchmark or an account-specific cost quote. No provider is selected and no account resource was created or modified.

#### Candidate A — Cloudflare SQLite-backed Durable Objects

**Documented fit:** each Durable Object has private, transactional, strongly consistent storage. The SQLite-backed storage API wraps operations in transactions; Cloudflare recommends SQLite for new Durable Object namespaces. A deterministic object identity derived from the canonical reservation key can route all contenders for one key to the same logical object. The implementation must persist all state in SQLite and must not rely on isolate memory, because objects can be evicted or restarted.

**Proposed mapping:** one deterministic Durable Object identity per reservation key, with the full original tuple stored and compared inside the object. Use a SQL unique key plus conditional updates and monotonically increasing generation. Keep each transition and audit event in one local SQLite transaction. All callers route through a Worker RPC/HTTP boundary; no other Durable Object can directly access this object's private storage.

**Free-tier envelope documented by Cloudflare (current documentation reviewed 2026-11-25):** Workers Free supports SQLite-backed Durable Objects; documented included limits are 100,000 requests/day, 13,000 GB-s/day, 5 million SQL rows read/day, 100,000 SQL rows written/day, and 5 GB total SQLite stored data. Exceeding a free-tier limit causes further operations of that type to fail until the daily reset; this is fail-closed only if the caller treats every such error as unavailable and emits no external effect. Paid overage rates and current billing rules must be recalculated before any usage forecast. Free-plan availability is documented; account-specific payment-card requirements are NOT_VERIFIED.

**Critical caveats:** (1) point-in-time recovery can restore a Durable Object's SQLite contents to a point within the previous 30 days, which can roll back reservation/fencing history; the global RECOVERY_LOCKED protocol is mandatory. (2) Storage is private to each object, so global reporting, cross-key audit inventory, and independent monotonic restore anchoring require an additional design. (3) deterministic object routing and collision handling must be tested across independent clients and deployed versions. (4) free quota exhaustion is an availability failure, not a safe automatic retry signal.

Official evidence: [SQLite-backed Durable Object Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Access Durable Objects Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/), [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

#### Candidate A2 — Cloudflare R2 as the independent effect ledger

**Documented fit:** R2 is globally strongly consistent for object writes, reads, metadata, and listing. Its conditional write API evaluates If-None-Match atomically at commit; competing create-only writes to the same absent key are serialized, and at most one succeeds while the object exists. The Workers R2 binding supports conditional writes through its onlyIf option. Bucket Lock can prevent matching objects from being overwritten or deleted for a specified period or indefinitely, and rules apply to existing and newly uploaded objects.

**Proposed mapping:** write one immutable object per attempt intent and outcome, keyed by a versioned hash of the reservation key, stage, and attempt ID. Use create-only conditional PUT semantics (If-None-Match: *) and a bucket-lock rule with indefinite retention for the journal prefix. The object contains canonical identity, stage, attempt ID, request/evidence digest, and schema version. A duplicate attempt ID with identical bytes is reconciled as the same event; different bytes are an integrity conflict. Do not use cached custom-domain reads; use the Worker binding or S3 API directly. A complete inventory is read only after RECOVERY_LOCKED has stopped new writes.

**Free-tier envelope:** R2 Standard documents 10 GB-month storage, 1 million Class A operations, 10 million Class B operations, and free egress. Cloudflare's R2 product page advertises starting free without a credit card. Account-specific eligibility, payment configuration, and the effect of exceeding quotas remain NOT_VERIFIED. R2 operations are separately metered from Durable Objects.

**Critical caveats:** (1) R2 is a separate storage product and rollback domain from a Durable Object's SQLite PITR, but it remains in the same Cloudflare account/vendor failure domain; it is not independent protection against account compromise or account deletion. (2) Bucket-lock configuration is privileged and can be changed by an administrator; the runtime writer identity must not have bucket-configuration permissions. (3) R2 documents that a negative read during an earlier in-flight PUT does not prove that the write failed. The ledger adapter must use a stable unique attempt ID, create-only conditional writes, immutable retention, and positive reconciliation; it must never issue a model/comment effect until the ledger intent is positively acknowledged. (4) Bucket-lock enforcement, conditional write behavior through the Workers binding, ambiguous PUT recovery, and writer/admin permission separation require hosted conformance tests.

Official evidence: [R2 Consistency Model](https://developers.cloudflare.com/r2/reference/consistency/), [R2 Conditional Operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/), [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 Bucket Locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/), [R2 Pricing](https://developers.cloudflare.com/r2/pricing/).

#### Candidate B — Supabase-managed PostgreSQL

**Documented fit:** PostgreSQL offers unique constraints, conditional updates, transactions, and row-level concurrency control suitable for the reservation record and append-only transition journal. The candidate must expose each adapter operation as one server-side SQL transaction, preferably a narrowly scoped RPC/database function; application-side read-then-write sequences over separate HTTP requests are rejected. Database-side time must decide lease expiry. Authoritative reads must target the primary, not a potentially stale read replica.

**Runtime integration:** Supabase documents shared-pooler transaction mode for serverless/edge functions. That mode does not preserve session state and does not support prepared statements; the exact client and connection behavior must be tested. A Cloudflare Worker-style isolate cannot open a raw TCP PostgreSQL connection; use an HTTP Data API/RPC boundary or a different supported runtime, and verify the chosen path's transaction semantics rather than assuming a SQL driver is available.

**Free-tier envelope and durability caveats:** the Free plan currently lists 500 MB database size and 5 GB egress, but projects can pause after a week of low activity. The Free plan does not include automatic backups or PITR. Pro starts at $25/month and includes daily backups retained for 7 days; PITR is an additional paid feature. A paused or unavailable database can safely block new effects, but absence of automatic backup/PITR and project pausing make Free unsuitable as the sole production-grade authoritative reservation store unless a separately tested off-site backup/restore and monotonic recovery process is provided. Account-specific payment requirements are NOT_VERIFIED.

**Critical caveats:** (1) a database restore can erase committed reservation attempts and therefore requires the same global RECOVERY_LOCKED protocol. (2) transaction-pooler session limitations must be reflected in the adapter and tests. (3) connection exhaustion, project pausing, API gateway availability, RLS/function grants, and backup retention are operational dependencies. (4) Pro pricing and backup benefits do not by themselves prove linearizable application behavior or restore safety.

Official evidence: [Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres), [Free Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [Database Backups](https://supabase.com/docs/guides/platform/backups), [Supabase Pricing](https://supabase.com/pricing).

#### Preliminary disposition

| Criterion | Cloudflare SQLite Durable Objects | Supabase PostgreSQL |
|---|---|---|
| Atomic per-key state transition | Documented transactional/strongly consistent private storage; still requires implementation tests | Native SQL transactions/unique constraints; must be exposed as one atomic server-side operation |
| Natural per-key arbitration | Strong fit via deterministic object identity per reservation key | Strong fit via unique key and conditional row updates |
| Cross-key relational audit queries | Requires external index/journal or aggregation | Native relational queries |
| Worker runtime compatibility | Native Workers/DO model | HTTP Data API/RPC preferred for Workers; raw TCP unavailable in Workers-style isolates |
| Free plan availability | SQLite DO supported; finite hard quotas fail operations on exhaustion | Free DB available; pauses after low activity and lacks automatic backups/PITR |
| Recovery rollback risk | PITR can roll state back; global restore lock mandatory | Backups/PITR can roll state back; global restore lock mandatory |
| Payment-card requirement | NOT_VERIFIED for this account | NOT_VERIFIED for this account |
| Qualification status | DOCUMENTATION_SCREENED; CONFORMANCE_NOT_RUN | DOCUMENTATION_SCREENED; CONFORMANCE_NOT_RUN |

**Screening recommendation (not selection):** the leading architecture candidate is Cloudflare SQLite-backed Durable Objects as the per-key transactional reservation authority plus R2 as a rollback-independent, immutable write-ahead effect ledger. This pairing is supported by documented DO transactions/strong consistency and R2 strong consistency/create-only conditional writes/bucket locks. It is still one Cloudflare account/vendor failure domain, and must not be represented as multi-provider disaster recovery. It remains unqualified until hosted tests prove independent-client DO arbitration, R2 create-once semantics through the Worker binding, indefinite lock enforcement, writer/admin permission separation, ambiguous PUT reconciliation, quota-exhaustion fail-closed behavior, object-ID collision handling, restart/failover, and restore drills. Supabase PostgreSQL remains a technically viable relational alternative, but its Free plan's inactivity pause and lack of automatic backups/PITR are material mismatches for a sole authoritative production store; it would still require an independently durable effect ledger.

### 13. Verification and approval gates

Current evidence:

- `9R-ATOMIC-001` duplicate-publication race: **REPRODUCED / CONFIRMED FOR TESTED IN-PROCESS INTERLEAVING** by hosted run `45468257408`; expected physical POST count 1, observed 2.
- Independent-process / independent-host durable-store conformance: **NOT_RUN**.
- This document's A01–A41 matrix: **SPECIFIED, NOT_EXECUTED**.
- Backend comparison: **NOT_STARTED**.
- Production adapter implementation: **NOT_AUTHORIZED**.
- Reviewer activation, workflow registration on `main`, provider dispatch, merge, secret changes, Cloudflare deployment, and local-host changes: **NOT_AUTHORIZED**.

Approval sequence:

1. Review this integrated contract and adversarial findings.
2. Resolve any design objections and freeze the contract version.
3. Write backend-neutral A01–A41 conformance tests, validate the test harness against a non-production reference oracle, and prove the current reviewer path remains RED without weakening the existing regression.
4. Compare at least two backend candidates against those same tests and documented guarantees.
5. Obtain independent security review of the selected adapter and failure model.
6. Only then request separate authorization for implementation. Reviewer activation, default-branch workflow registration, provider dispatch, and merge remain distinct later approvals.

**Final design verdict:** the contract is internally integrated and its identified design weaknesses have explicit mitigations or bounded residual limitations. It is NOT yet experimentally validated, backend-qualified, independently approved, or implementation-authorized. PR #463 must remain Draft; the reviewer remains disabled.


### 14. Additional hostile findings and reference-oracle corrections — 2026-11-25

This section records the next adversarial tranche. All implementation changes below are confined to the non-production in-memory reference oracle and its contract tests. They do not establish candidate-provider or production behavior.

| Finding | Counterexample / failure mode | Reference-oracle correction | Evidence |
|---|---|---|---|
| AR-32 — Pagination overlap was counted as duplicate publication | The same remote comment ID appeared twice across overlapping pages and was counted as two comments | Deduplicate verified positive evidence by unique remote comment ID before applying duplicate escalation | T32 RED then GREEN |
| AR-33 — Recovery quarantine did not cover reconciliation | A positive comment observation mutated a record to PUBLISHED while the global recovery lock was active | Reject reconciliation state transitions with RECOVERY_LOCKED | T33 RED then GREEN |
| AR-34 — Recovery could be unlocked without an independent anchor | A COMPLETE inventory alone was sufficient to leave RECOVERY_LOCKED | Require a separately supplied trusted anchor and exact watermark/digest match | T34–T35 RED then GREEN |
| AR-35 — Recovery inventory was incorrectly key-scoped | A per-key event list was paired with a global watermark, omitting other reservations from restore validation | Read the full cross-key append-only event inventory and anchor the complete sequence | T36 |
| AR-36 — Restore validation did not verify inventory structure | Tampered payloads, sequence gaps, duplicate event IDs, and altered event digests could be accepted | Validate contiguous global sequence, unique immutable event IDs, per-event digest, and aggregate anchor digest before unlock | T37–T41 |
| AR-37 — Ordinary mode setter bypassed recovery authorization | setRecoveryMode(ACTIVE) directly cleared a lock without the trusted-anchor path | Deny direct ACTIVE transitions while locked; only unlockRecovery may release the quarantine after validation | T43 RED then GREEN |
| AR-38 — Recovery lock was not enforced at every mutation boundary | Renewal, completion, continuation, abort, expiry, UNKNOWN marking, and close operations could mutate state while recovery was locked | Add fail-closed recovery-mode guards to every reservation/ledger mutation path; read-only inventory inspection remains available | T44–T45 RED then GREEN |

#### New recovery and reconciliation invariants

- **I30 — Evidence identity:** duplicate observations of the same remote comment ID across overlapping pages count as one positive comment. DUPLICATE_ACCEPTED requires at least two distinct verified remote comment IDs.
- **I31 — Global quarantine:** while RECOVERY_LOCKED, no ordinary reservation or effect-ledger mutation is permitted. The only state-changing exit is anchor-verified unlockRecovery; a mode setter cannot bypass it.
- **I32 — Complete restore proof:** recovery unlock requires a complete cross-key event inventory with a contiguous global sequence, unique event IDs, valid per-event digests, and a matching independently supplied trusted anchor. A key-scoped subset is never a valid global recovery inventory.

#### Hosted verification checkpoint

- Verification branch: verify/9router-reservation-conformance-run7-2026-11-25.
- Exact verified revision: 47981029139fd7c15c52c71d1c9c16de5f0b5443.
- Contract reference tranche: **T01–T45, 45/45 PASS**, hosted run [45509849702](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45509849702).
- Full reviewer regression plus reference tranche: **181 passed / 1 failed**. The sole failure remains the preserved duplicate-publication concurrency regression: expected at most one physical POST, observed two. The failure is intentionally retained.
- These results qualify only the in-memory reference oracle. They do not prove multi-process linearizability, durable acknowledgement, provider failover, R2 conditional PUT semantics, Bucket Lock enforcement, quota behavior, or restore safety on Cloudflare Durable Objects/R2 or Supabase.
- The original P1 redirect-replay review thread remains unresolved pending a full green suite. No reviewer activation, merge, provider dispatch, or deployment is permitted.

#### Residual risk and next qualification boundary

The reference oracle is still a single-process executable specification. Its Map state and JavaScript scheduling cannot prove arbitration across independent isolates, hosts, or process crashes. The next backend-neutral tranche must explicitly test the adapter boundary with independently scheduled clients and injected lost acknowledgements; the candidate-specific tranche must then test real Durable Objects transactions and R2 conditional create-once behavior in an isolated, non-production environment. No such provider test has run, and no provider has been selected.


### 15. Stage-bound effect-ledger outcomes — 2026-11-25

**AR-39 — An outcome receipt could be appended under the wrong effect stage.** The reference ledger accepted `COMMENT_ACCEPTED` for a `MODEL` intent and `MODEL_RESULT_STORED` for a `COMMENT` intent. Although downstream reservation transitions separately checked their expected outcome type, accepting the mismatched append polluted the immutable audit stream and weakened the ledger's stage contract.

**Correction:** `appendOutcome` now derives the only permitted outcome type from the immutable intent stage: `MODEL` → `MODEL_RESULT_STORED`; `COMMENT` → `COMMENT_ACCEPTED`. A mismatch returns `INVALID_OUTCOME_STAGE` without appending an event or advancing the global sequence.

**I33 — Stage-bound outcome integrity:** an outcome event must have the same reservation key and attempt identity as its intent, and its outcome type must be the one permitted for that intent stage. Invalid cross-stage outcomes are rejected before append and cannot produce a receipt.

**TDD evidence:** T46 and T47 were observed RED on revision `ce456a927da09be3a50279140e30604b209e8692`: each test expected `INVALID_OUTCOME_STAGE` but received `ACK`. The minimal correction was applied at `27dcb0828e051adc09f81a914a9d9d641933c658`. The hosted GREEN result must be recorded only against the exact post-fix revision and complete workflow output.

This correction is confined to the in-memory reference oracle. It does not prove that a future durable ledger implementation enforces the same invariant; every candidate adapter must run T46–T47 unchanged.


#### AR-39 hosted RED/GREEN verification record

- RED revision `ce456a927da09be3a50279140e30604b209e8692`: T46 and T47 both failed for the expected reason (`INVALID_OUTCOME_STAGE` expected; `ACK` observed). The full suite also retained the independent duplicate-publication RED.
- GREEN code revision `27dcb0828e051adc09f81a914a9d9d641933c658`, with coverage/docs revision `0232ae321a8e856353c325dce928369a1113c198`.
- Hosted run [45511958154](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45511958154) completed: **T01–T47, 47/47 PASS**; full reviewer regression plus conformance: **183 passed / 1 failed**.
- The sole full-suite failure remains the preserved deterministic duplicate-publication race (2 POSTs observed; maximum allowed 1). No test assertion was weakened or removed.
- The green result qualifies only the in-memory reference implementation. Provider-backed linearizability and durable crash recovery remain NOT_EXECUTED.


### 16. Cross-store attempt-boundary authorization — 2026-11-25

**AR-40 — Outcome append is not cryptographically or transactionally bound to the committed reservation attempt boundary.**

#### Adversarial counterexample

The current reference-ledger API accepts:

`appendOutcome({ attemptId, outcomeType, evidenceDigest, evidenceReference })`

It verifies that an intent exists and that the outcome type matches the intent stage. It does not require evidence that the reservation authority has committed the corresponding `beginModelAttempt` or `beginCommentAttempt` transition. A caller can therefore append an immutable outcome after INTENT but before the reservation attempt boundary. The reservation adapter may later reject completion, but the audit ledger has already accepted a result event for an attempt that was never authorized at the authoritative state boundary.

This is a cross-store protocol defect. Stage matching (I33) does not prove attempt authorization or causal order.

#### Required contract correction — proposed, not yet implemented

The outcome append operation must require a verifiable **attempt-boundary receipt** issued only after the reservation authority has durably committed the single-use attempt transition. The receipt must bind at minimum:

- canonical reservation key and key schema version;
- stage (`MODEL` or `COMMENT`);
- attempt ID and immutable request/payload digest;
- generation and committed record version;
- reservation authority identity and protocol version;
- unique boundary event/nonce and issuance metadata.

The receipt must be integrity-protected and non-replayable across keys, stages, attempts, generations, or record versions. The ledger must verify it before appending OUTCOME. The caller must not be able to construct a valid receipt by copying caller-controlled fields. A signed capability or an equivalent independently verifiable proof is required; the final mechanism must account for key rotation, verifier availability, and compromise of the reservation authority.

The causal order becomes:

1. Append and positively acknowledge INTENT.
2. Atomically commit the one-time reservation attempt boundary.
3. Return a verifiable boundary receipt only after durable commit acknowledgement.
4. Perform the external effect once, with transport retries disabled.
5. Append OUTCOME with the boundary receipt and positive effect evidence.
6. Complete the reservation using the immutable ledger outcome receipt.

If step 2 has an ambiguous acknowledgement, no external effect is permitted. If step 5 is ambiguous, reconcile the same immutable attempt/event identity; do not create a new attempt or infer success from a negative read. If the boundary receipt cannot be verified, reject the outcome without advancing the ledger sequence.

#### Required test-first tranche

- **T48 — Outcome before boundary:** create INTENT, omit the boundary receipt, attempt OUTCOME; expect `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED`, no event append, and unchanged global sequence.
- **T49 — Boundary receipt binding:** reject receipts with a different reservation key, stage, attempt ID, request digest, generation, or committed record version; accept only the exact committed boundary receipt.
- **T50 — Lost boundary acknowledgement:** simulate a committed reservation transition with a lost response; prove the system can recover the same boundary receipt from authoritative durable state without reissuing the attempt permit or repeating the external effect.

T48 must be observed RED for the exact missing-boundary reason before implementation. T49 and T50 must be added before declaring the protocol corrected. These tests must run against the reference oracle first and later unchanged against each persistent candidate adapter.

#### Current disposition

- AR-40: **OPEN / DESIGN DEFECT IDENTIFIED**.
- I34 — Attempt-bound outcome authorization: **PROPOSED, NOT YET ENFORCED**.
- T48–T50: **SPECIFIED, NOT YET IMPLEMENTED OR EXECUTED**.
- Provider-backed receipt verification: **NOT_RUN**.
- Production adapter: **NOT_AUTHORIZED**.

The current T01–T47 GREEN result remains valid only for the existing reference-oracle contract. It does not cover AR-40 and must not be described as full protocol conformance. Preserve the duplicate-publication RED test unchanged. Keep PR #463 Draft, reviewer disabled, and all default-branch, secret, cloud-resource, deployment, and local-host boundaries unchanged.


#### 2026-11-25 execution checkpoint — T48 authored

- T48 has been added to `conformance/reservation-adapter.contract.test.mjs` on verification commit `32b01c2271765f45005bfcc0bcceaccfc1713376`.
- The test creates an acknowledged MODEL intent, calls `appendOutcome` without an attempt-boundary receipt, and asserts rejection plus unchanged event count and watermark.
- Static inspection of the current reference ledger shows `appendOutcome` does not read or validate `attemptBoundaryReceipt`; therefore the current implementation is expected to violate T48. This is a source-level predicted RED, **not an observed test execution**.
- The conformance workflow is configured for pushes to `verify/9router-reservation-conformance-*`. No workflow-run result has yet been retrieved for this exact commit; hosted execution is **NOT_VERIFIED**.
- No adapter implementation was changed. T48 must be observed failing before a minimal correction is made.
- T49/T50 remain design-only. AR-40 remains OPEN. The prior T01–T47 result is unchanged and does not include T48.


#### 2026-11-25 hosted execution checkpoint — T48 observed RED

- Exact revision tested: `80dab2c0502046e7e084f28c3dc36c90aef20e72` (conformance workflow run [45512814174](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45512814174), job `138864577949`).
- T48 was **OBSERVED RED for the expected missing-boundary defect**: the assertion expected `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED`, but `appendOutcome` returned `ACK`. This confirms the test reaches the protocol behavior rather than failing setup/import.
- The full reviewer + conformance job failed as expected; T48 is not green. The preserved publication-race regression also remains independently failing; no test was removed or weakened.
- The isolated conformance step also failed because T48 remains red. The exact run output was retrieved and inspected.
- On the same revision, the full-history secret scan workflow run [45512814177](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45512814177) failed with exit code 2 during the all-refs scan. The PR-diff scan step passed. The retrieved log did not expose finding details, so the finding count, locations, and whether any item is an actual secret versus a configured historical match remain **UNKNOWN**; do not add allowlist entries or suppressions without obtaining and validating the report.
- No implementation change followed the RED observation. AR-40 remains OPEN; T49/T50 are not yet authored or executed. This checkpoint is evidence-only.
- Scope remains isolated to this verification branch. No default-branch changes, merge, reviewer activation, provider dispatch, deployment, secrets/resource mutation, or local-host changes were performed.


#### 2026-11-25 hosted test-first checkpoint — T48–T50 observed RED

- Exact revision: `522166def70bf9b0cd7b286d01a33840761b50e5`.
- Conformance workflow run [45552193719](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45552193719), job `138995726784`, completed with failure in both reviewer regression and isolated reference-oracle tranche.
- T48 **OBSERVED RED**: `appendOutcome` returned `ACK` when the assertion required `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED`.
- T49 **OBSERVED RED**: `beginModelAttempt` returned a model permit without an `attemptBoundaryReceipt`; the test's explicit receipt-presence assertion failed. Binding mutation cases and exact-receipt acceptance remain unexercised until a receipt exists.
- T50 **OBSERVED RED**: the explicit capability assertion found `readAttemptBoundaryReceipt` absent. This is an assertion failure, not a runtime TypeError. Durable receipt recovery and no-second-permit behavior remain unexercised until the API exists.
- No production/reference adapter implementation was changed. The original duplicate-publication concurrency RED remains preserved and independently blocks full reviewer regression.
- Full-history Gitleaks run [45552193750](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45552193750) failed in the all-fetched-refs scan while PR-diff scan passed. No artifact was published; finding identity/count/location remain **UNKNOWN**. Do not add allowlist entries or suppressions without an inspectable report.
- Test contract for the next implementation cycle: (1) reservation authority issues an opaque/integrity-protected receipt only after durable one-time boundary commit; (2) receipt binds canonical reservation tuple, schema/protocol version, stage, attempt ID, request digest, generation, committed record version, and unique boundary event; (3) EffectLedger verifies receipt against trusted authority material and the exact durable INTENT before appending OUTCOME; (4) recovery reads the same committed receipt by immutable key/stage/attempt without creating a new permit; (5) no external effect is permitted when commit acknowledgement is ambiguous.
- Reference adapter receipts are test-oracle capabilities only; their mechanism must not be misrepresented as production cryptographic assurance. Production qualification still requires a real authority, key lifecycle, trust-root distribution, revocation/rotation, replay prevention, and cross-store failure tests.
- Scope remains isolated to the verification branch. No main/default branch changes, merge, reviewer activation, provider dispatch, deployment, secret/resource mutation, or local-host changes.


#### 2026-11-25 adversarial test refinement — T49 forgery dimensions

- Exact test revision: `1f976f0e30d3938e016e0bcd5e4ce6df60bf5654`.
- Hosted conformance run [45552306179](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45552306179), job `138996069364`, completed with failure.
- T49's negative mutation set now includes reservation key, stage, attempt ID, request digest, generation, committed record version, boundary event ID, schema version, authority identity, and signature. It also requires exact receipt acceptance and no ledger watermark movement for rejected receipts.
- Hosted execution again observed T48 RED, T49 RED at the missing receipt-presence assertion, and T50 RED at the explicit missing recovery API assertion. Because no receipt is issued, T49's individual tampering branches and exact-receipt positive path are not yet exercised. Because the recovery API is absent, T50's recovery/idempotence assertions are not yet exercised.
- This refinement improves the adversarial test specification; it does not prove receipt verification behavior. Adapter implementation remains untouched. No GREEN claim is made.


#### 2026-11-25 T50 simulation integrity correction

- A hostile review found the first T50 draft retained the simulated commit response and compared the recovered receipt against it; that did not actually model a lost acknowledgement.
- Corrected the test to discard the boundary-call response, recover by immutable key/stage/attempt, bind the recovered receipt's committed record version to authoritative state, verify repeated recovery is identical, and verify a repeated begin call returns `ALREADY_CONSUMED`.
- Exact corrected test revision: `fb3650530704fabc239ec8977bd39386de230422`; hosted run [45552431713](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45552431713), job `138996478209`.
- T48/T49/T50 again observed RED for their intended missing behaviors. T50 now fails the explicit missing recovery API assertion after a genuinely discarded response; recovery semantics remain unexercised until implementation.
- This correction repairs test validity only. No adapter implementation was changed; no GREEN or production-readiness claim is made.


#### 2026-11-25 hostile T49 canonical-binding correction

- Test revision: `f419216336a1c910362eb5cf68231608fcd93a42`.
- Corrected T49 to mutate the exact receipt-contract field names `reservation_key_digest` and `receipt_schema_version`; the prior draft used non-canonical names `reservation_key` and `schema_version`.
- Expanded the mutation set to include `protocol_version`, `authority_id`, `signing_key_id`, `issued_at`, and `purpose`, in addition to stage, attempt ID, request digest, generation, committed record version, boundary event ID, and signature.
- Added a cross-key replay attempt using a separately acknowledged MODEL INTENT under a different immutable reservation key. The expected disposition is `INVALID_ATTEMPT_BOUNDARY_RECEIPT`, with no OUTCOME append and unchanged inventory for that foreign key.
- This is a test-specification correction only. T49 still stops at the explicit assertion that `beginModelAttempt` must return an attempt-boundary receipt; none of the individual mutation assertions, exact-receipt acceptance, or cross-key replay assertion has executed because the reference adapter does not issue a receipt.
- The latest test-only change was pushed to the isolated verification branch. The connected GitHub workflow-run retrieval surface filters to pull-request-triggered runs and did not provide a push-run record for this commit; hosted execution of this exact revision is therefore **NOT_VERIFIED**. Do not infer RED/GREEN for the new mutation cases from the earlier T48–T50 RED run.
- No reference adapter implementation was changed. T48–T50 remain OPEN/RED based on the previously observed exact revision; the new T49 branches are **AUTHORED / NOT_EXECUTED**.
- The contract and T49 review remain design/test-only. No production signer, verifier, backend, or durable receipt store is implemented.
- Scope remains isolated to `verify/9router-reservation-conformance-run9-2026-11-25`. Do not merge this accumulated verification branch wholesale. No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host were made.


#### 2026-11-25 T49 cross-key assertion correction

- Test revision: `70c3eb6f86a1a59694bcd74294b3d7766402885d`.
- Hostile review of the newly added cross-key replay assertion found that `readComplete` returns the complete global ledger inventory, not a key-filtered event subset. The first assertion draft incorrectly expected exactly one event for the foreign key.
- Corrected the test to snapshot the global event count and watermark immediately before the cross-key replay, then require both to remain unchanged after rejection; it also asserts no OUTCOME exists for the foreign attempt ID.
- This is a test correctness correction. The branch still cannot exercise the replay assertion because `beginModelAttempt` does not issue `attemptBoundaryReceipt`, and T49 fails earlier at the explicit receipt-presence assertion.
- Exact hosted execution for this revision is **NOT_VERIFIED**. The connected workflow-run retrieval method only exposes pull-request-triggered runs; no authenticated push-run lookup/dispatch method is available in the connected GitHub action surface used here. No claim of local execution or hosted RED/GREEN is made.
- No executable adapter code was changed. T48–T50 retain their previously observed RED evidence; all newly corrected T49 mutation/replay paths remain **AUTHORED / NOT_EXECUTED**.
- All changes remain on the isolated verification branch. No PR #463, main, workflow registration, reviewer, provider, secret, cloud resource, deployment, repository policy, or local-host changes occurred.


#### 2026-11-25 hostile integration review — receipt propagation and COMMENT-stage gap

- Review scope: `ATTEMPT_BOUNDARY_RECEIPT_CONTRACT.md`, `reference-adapter.mjs`, and the T01–T50 contract harness on `verify/9router-reservation-conformance-run9-2026-11-25`.
- **AR-41 — Existing test-helper integration gap:** `completeModel()` and `commentAttempt()` currently call `ledger.appendOutcome()` without an attempt-boundary receipt. Once T48's required validation is implemented, these helpers and their dependent T01–T47 cases will fail unless the exact receipt returned by the corresponding `beginModelAttempt` / `beginCommentAttempt` is propagated into the matching `appendOutcome`. This must be a deliberate harness migration, not a bypass, optional fallback, or weakened assertion. Each outcome must bind to the exact stage, attempt ID, request digest, immutable key, generation, and committed record version.
- **AR-42 — COMMENT-stage receipt conformance gap:** T49 currently exercises MODEL receipt mutation and cross-key replay only. The contract explicitly requires COMMENT-stage receipt verification and cross-INTENT replay. A MODEL-only green result would therefore be insufficient. Add a focused COMMENT test that obtains the receipt only from a successful `beginCommentAttempt`, rejects missing/altered/wrong-stage/wrong-attempt/wrong-key receipts without ledger mutation, and accepts only the exact COMMENT receipt. Also test replay of a MODEL receipt against a distinct COMMENT INTENT and vice versa.
- **AR-43 — Reference-oracle trust-boundary limitation:** The contract requires independent ledger verification of authority-issued receipts. The current in-memory adapter has no signer, verifier, persisted boundary receipt, or recovery API. Any reference implementation must use an explicitly test-only opaque capability/in-memory authority registry (or equivalent), and documentation must continue to state that it is not cryptographic, crash-safe, durable, or production-qualified. Do not treat a caller-constructed JSON object or a caller-provided digest as proof of a committed boundary.
- **Ordering constraint:** preserve INTENT acknowledgement → one-time reservation transition and receipt persistence → receipt acknowledgement → external effect → OUTCOME append. A failed or ambiguous boundary transition must not authorize an external effect. Recovery must return the same stored receipt and must not increment the record version or mint a second permit.
- **Verification status:** this was a source-level hostile review. No code or tests were executed in this review step. The exact latest branch revision's hosted push run remains **NOT_VERIFIED** through the connected workflow-run retrieval surface. AR-41–AR-43 are **IDENTIFIED / OPEN**, not fixed. No GREEN claim is made.
- **Required next TDD sequence:** first add/adjust focused tests for helper receipt propagation and COMMENT-stage receipt binding; observe the expected RED; implement the smallest reference-oracle behavior; then run T48–T50, T01–T50, and the full reviewer regression. Preserve the original duplicate-publication concurrency RED unchanged.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 T51 COMMENT-stage receipt test authored — execution pending

- Test commit: `c77996aa267887aaa667dc184ed4b593e649cd9f`.
- Added T51 to `reservation-adapter.contract.test.mjs`. It requires `beginCommentAttempt` to return a boundary receipt; mutates stage, attempt ID, request digest, reservation key digest, generation, committed record version, boundary event ID, purpose, and signature; requires every invalid receipt to be rejected without changing ledger event count or watermark; tests replay of the receipt against a distinct COMMENT INTENT; and accepts the exact receipt.
- This test is **AUTHORED / NOT_EXECUTED**. No local or hosted RED/GREEN result is claimed. The current adapter is known not to return `attemptBoundaryReceipt` from `beginCommentAttempt`, so the expected first failure is the explicit receipt-presence assertion, but this prediction is not execution evidence.
- **Hostile review — helper dependency:** T51 uses `commentAttempt()`, which first calls `completeModel()`. That helper currently appends a MODEL OUTCOME without passing a boundary receipt. Once T48 enforcement is implemented, this setup path must be migrated to propagate the exact MODEL receipt; otherwise T51 will fail before reaching COMMENT assertions. This is part of AR-41 and must not be worked around by making receipt validation optional.
- **Hostile review — scope:** T51 covers COMMENT receipt mutation and cross-INTENT replay, but does not yet test MODEL-receipt-to-COMMENT-INTENT replay. Add that cross-stage/cross-INTENT case before claiming complete AR-42 coverage. T51's positive append validates ledger admission only; it does not simulate or authorize a GitHub POST.
- **No adapter implementation changed.** No tests were run. T48–T51 remain open; T01–T47 helper compatibility remains unresolved. Preserve the original duplicate-publication concurrency RED unchanged.
- Latest known branch update for this test is `c77996aa267887aaa667dc184ed4b593e649cd9f`; this is not yet the documentation checkpoint commit. Exact hosted push execution remains **NOT_VERIFIED**.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


- **T51 follow-up:** commit `8eecb9147ce03303903e8b8679d1c7ba328ecd33` adds the missing MODEL-receipt-to-distinct-COMMENT-INTENT replay rejection assertion. It requires the MODEL receipt from the completed model setup, submits it against a separate COMMENT INTENT, and verifies rejection leaves ledger event count and watermark unchanged. This assertion is **AUTHORED / NOT_EXECUTED** and depends on AR-41 helper receipt propagation. The earlier T51 hostile-review note describing this case as still missing is superseded by this follow-up; all other T51 limitations remain.


#### 2026-11-25 T52 helper-propagation test authored — hostile review AR-44

- Test commit: `74d0f2738a948b1738990b0f721fb514ae836435`.
- Added T52 to instrument the reference ledger's `appendOutcome` boundary during `completeModel()`. It requires the helper to receive a committed MODEL boundary receipt and forward that exact receipt with the matching attempt ID and request digest. It does not permit a receipt from another attempt or a caller-created substitute.
- T52 is **AUTHORED / NOT_EXECUTED**. The current reference adapter's `beginModelAttempt` does not expose `attemptBoundaryReceipt`, so the first expected failure is the explicit receipt-presence assertion. This is a prediction from source inspection, not an observed RED result.
- **AR-44 — Legacy successful-attempt callers bypass the future receipt contract:** source inspection found successful-attempt `appendOutcome` calls beyond `completeModel()`, including T44 and T45 recovery-lock paths. These callers currently omit `attemptBoundaryReceipt`. Once T48 enforcement is implemented, they will fail unless migrated to pass the exact receipt from the matching successful begin operation. Stage-mismatch negative tests (T46/T47) intentionally use bare outcomes to test stage rejection and must preserve their intended assertion ordering; do not blanket-add fabricated receipts to those negative cases.
- **Migration rule:** enumerate every `appendOutcome` call and classify it as (a) successful MODEL attempt, (b) successful COMMENT attempt, (c) negative/malformed test, or (d) receipt-replay test. Only categories (a) and (b) may receive the exact corresponding authority-issued receipt. Negative tests must remain negative and must still prove no ledger mutation.
- **Hostile integration review:** T51's COMMENT setup traverses `completeModel()`; therefore T52 is a prerequisite for reaching its COMMENT-specific assertions once ledger enforcement is active. T45 contains a second successful COMMENT outcome path that also needs the receipt from `comment.permit`. T44 needs the receipt from `started.permit`. These are concrete call-site migration targets, not permission to weaken T48.
- No adapter implementation or existing helper migration was performed in this step. No tests were executed. T48–T52 and AR-41–AR-44 remain **OPEN / NOT VERIFIED**. Preserve the original duplicate-publication concurrency RED unchanged.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 hostile inventory correction — AR-45

- **AR-45 — Earlier successful-outcome call-site inventory was incomplete.** A complete source scan of every `appendOutcome` invocation in `reservation-adapter.contract.test.mjs` found successful-attempt callers that were not listed in AR-44:
  - `completeModel()` (shared helper): successful MODEL outcome; must pass the exact receipt from `started.permit`.
  - T06: direct successful MODEL outcome; must pass the exact receipt from `started.permit`.
  - T13: direct successful COMMENT outcome; must pass the exact receipt from `started.permit`.
  - T44: direct successful MODEL outcome; must pass the exact receipt from `started.permit`.
  - T45: direct successful COMMENT outcome; must pass the exact receipt from `comment.permit`.
- T28 is a separate compatibility case: it currently creates a bare MODEL INTENT and appends two outcomes to test immutable outcome identity. It is not an authorized reservation attempt. It must be redesigned to obtain a real committed MODEL boundary receipt before the first append, then prove that an identical retry returns the original ACK and a changed payload returns `INTEGRITY_CONFLICT` without advancing the ledger. It must not be exempted from T48.
- Negative and adversarial calls must remain intentionally receipt-free or use the exact mutated/replayed receipt under test:
  - T46/T47: stage-mismatch rejection ordering; bare receipts remain intentional.
  - T48: missing-boundary rejection; explicit null receipt remains intentional.
  - T49/T51: malformed, mutated, foreign-key, foreign-intent, and cross-stage receipt rejection cases; preserve each tested receipt exactly.
  - T52: instrumentation only; it must observe the exact receipt propagated by the successful helper path.
- This inventory supersedes the narrower AR-44 list. The required migration set is now complete for the current file: T06, T13, T28, T44, T45, and `completeModel()`. `commentAttempt()` only obtains a COMMENT permit and currently has no successful COMMENT outcome append of its own; callers must use its exact permit receipt when they append one.
- **Hostile review conclusion:** do not implement receipt enforcement until every successful caller above is migrated in a test-first sequence and T28's semantics are preserved. Do not add a permissive fallback, synthesize a receipt in a test, or blanket-add receipts to negative tests.
- **Status:** AR-45 IDENTIFIED / OPEN. This was a source-level inventory and documentation correction; no test was executed and no adapter code changed. T48–T52 remain OPEN / NOT VERIFIED. The original duplicate-publication concurrency RED remains a separate required blocker.
- Scope remains the isolated verification branch. No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 T28 compatibility migration — AR-46

- Test commit: `46197c7a68aaa2adb4542ae9e1de205ec60cff11`.
- T28 no longer appends an outcome against a bare MODEL INTENT. It now obtains a real MODEL attempt through the shared `modelAttempt()` path, requires the permit's `attemptBoundaryReceipt`, and binds both the first OUTCOME and its identical retry to that same receipt and attempt ID.
- The test retains the immutable-outcome contract: identical retry must return the original acknowledgement; changed evidence payload must return `INTEGRITY_CONFLICT`; the conflict must not advance event count or watermark.
- This closes the T28 exception identified in AR-45 without adding a bypass or weakening the missing-boundary requirement. It also exposes the current adapter gap directly: `beginModelAttempt` does not yet return `attemptBoundaryReceipt`.
- **Status:** AUTHORED / NOT_EXECUTED. The expected first failing assertion is the explicit receipt-presence assertion, based on source inspection. This is a predicted RED, not an observed test result. No adapter implementation was changed.
- **Hostile review:** T28 now uses a reservation-authorized attempt instead of a standalone ledger-only intent; both idempotent and conflicting outcome calls use the exact same receipt; conflict immutability is checked against the ledger watermark; the test does not claim that a reference-oracle receipt is cryptographically secure. Remaining limitation: no local or hosted execution evidence was available in this step.
- AR-41–AR-46 remain OPEN. The other successful call sites (T06, T13, T44, T45, and `completeModel()`) are not yet migrated. T48–T52 remain OPEN / NOT VERIFIED. Preserve all intentional negative/replay cases and the original duplicate-publication concurrency RED.

#### 2026-11-25 MODEL receipt propagation — AR-47

- Test commit: `42cecdbde075aede66dedd309adb8d3b3563f48d`.
- The shared `completeModel()` helper now forwards `started.permit.attemptBoundaryReceipt` with its successful MODEL `appendOutcome`.
- T06's direct successful MODEL outcome path now forwards the same exact permit receipt. It instruments the ledger call and asserts one append, matching attempt ID, deep-equal receipt object, and `stage === MODEL`.
- T06's earlier negative `completeModelAttempt` call (`wrongAttempt`, null ledger receipt) remains unchanged and occurs before the instrumented successful append.
- T52 continues to exercise the shared helper and therefore now checks the receipt propagation introduced here. No receipt fallback or synthesized capability was added.
- **Status:** AUTHORED / NOT_EXECUTED. The reference adapter still does not issue `attemptBoundaryReceipt`; no RED/GREEN execution is claimed. T06/T52 and the full tranche remain NOT VERIFIED.
- **Hostile review:** inspected the exact commit diff. It changes only the shared helper's successful outcome arguments and T06's successful outcome path/assertions. The negative wrong-attempt check is preserved. At the time of AR-47, T13/T44/T45 were still unmigrated. T13 was migrated in AR-48 and T44/T45 in AR-49. Adapter receipt issuance/verification and durable recovery remain absent.
- AR-41–AR-47 remain OPEN. Preserve T46/T47 stage-mismatch negatives, T48 missing-boundary negative, T49/T51 replay and mutation cases, and the original duplicate-publication concurrency RED.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.

#### 2026-11-25 COMMENT receipt propagation — AR-48

- Test commit: `50072e48704efc5b91380aaf929eb84aeef5f832`.
- T13's successful `COMMENT_ACCEPTED` outcome now forwards the exact `started.permit.attemptBoundaryReceipt` returned by `beginCommentAttempt`.
- T13 instruments the ledger call and asserts one append, matching attempt ID, deep-equal receipt propagation, and `stage === COMMENT`.
- The preceding negative completion attempt with `effectLedgerReceipt: null` and its `LEDGER_NOT_ACKNOWLEDGED` assertion are preserved unchanged and occur before the successful append.
- The helper path obtains its COMMENT permit only after `completeModel()` and `resumeCompletedModel()`, so this test exercises the real prerequisite sequence without synthesizing a receipt.
- **Status:** AUTHORED / NOT_EXECUTED. The current reference adapter still does not issue boundary receipts. No RED/GREEN result is claimed; T13 and dependent tests remain NOT VERIFIED.
- **Hostile review:** inspected the exact commit diff. Only T13's successful outcome path and receipt-forwarding assertions changed; the negative no-outcome path and final publication checks remain intact. T13 covers the COMMENT helper path. T45's separate recovery-lock COMMENT outcome was subsequently migrated under AR-49.
- AR-41–AR-49 remain OPEN pending execution and adapter work. T44/T45 were subsequently migrated under AR-49. Preserve all negative/replay tests and the original duplicate-publication concurrency RED.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.
#### 2026-11-25 Recovery-lock receipt propagation — AR-49

- Test commit: `6b782af2cc18defd58ed4d6e2030551a0a1f2606`.
- T44's successful MODEL ledger outcome now carries `started.permit.attemptBoundaryReceipt`, the exact receipt associated with the `modelAttempt()` permit.
- T45's successful COMMENT ledger outcome now carries `comment.permit.attemptBoundaryReceipt`, the exact receipt associated with `commentAttempt()`'s `beginCommentAttempt` permit.
- Both paths instrument `appendOutcome` and assert exactly one append, matching attempt ID, deep-equal receipt propagation, and the correct stage (`MODEL` / `COMMENT`).
- The recovery lock is still set only after the ledger outcome is recorded; the test continues to exercise the intended locked completion/publication rejection rather than suppressing the prerequisite outcome.
- **Status:** AUTHORED / NOT_EXECUTED. The reference adapter still does not issue boundary receipts. No RED/GREEN result is claimed; T44/T45 and the full tranche remain NOT VERIFIED.
- **Hostile review:** exact commit diff inspected. Only the two successful outcome argument sets and local receipt-propagation assertions changed. T44 still tests `completeModelAttempt` rejection under `RECOVERY_LOCKED`; T45 still tests the COMMENT completion rejection and other locked mutation paths. No adapter implementation, receipt fabrication, fallback, or negative-test weakening was introduced.
- **Callsite inventory:** all intended successful MODEL/COMMENT outcomes in the current contract test now pass an explicit receipt (shared helper, T06, T13, T28, T44, T45, T49/T51 acceptance paths). Deliberately receipt-free stage-mismatch negatives T46/T47, missing-boundary T48, and mutated/replay cases remain intentionally negative. Re-scan is required after any future test edits.
- AR-41–AR-49 remain OPEN pending execution and adapter contract implementation. Keep the original duplicate-publication concurrency RED separate and unchanged.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.

#### 2026-11-25 hostile source audit — AR-50 and AR-51

- Audit scope: exact branch source for `reference-adapter.mjs`, `reservation-adapter.contract.test.mjs`, and `ATTEMPT_BOUNDARY_RECEIPT_CONTRACT.md` on `verify/9router-reservation-conformance-run9-2026-11-25`.
- **AR-50 — OUTCOME admission ignores the attempt-boundary receipt.** The current `appendOutcome` parameter destructuring accepts only `attemptId`, `outcomeType`, `evidenceDigest`, and `evidenceReference`; it neither receives nor validates `attemptBoundaryReceipt`. The function proceeds from INTENT lookup and outcome-stage/type validation directly to idempotency lookup or `appendLedgerEvent`. Therefore a caller can submit an OUTCOME with no boundary receipt, and the current implementation has no receipt-based gate before ledger mutation. This is a source-confirmed implementation defect, not a test prediction. T48 is the direct behavioral discriminator: for a valid MODEL intent and valid MODEL outcome, the required result is `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED` with unchanged event count and watermark. T49/T51 additionally require exact receipt admission and replay/mutation rejection. **Status: CONFIRMED BY SOURCE / RUNTIME NOT EXECUTED.**
- **AR-51 — Error-precedence compatibility must be preserved when enforcement is added.** T46/T47 deliberately submit stage-mismatched outcomes without a boundary receipt and expect `INVALID_OUTCOME_STAGE`. T48 submits a stage-correct outcome with a missing receipt and expects `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED`. A future implementation that validates receipt presence before validating the INTENT/outcome stage will change T46/T47's externally visible result and invalidate their intended stage-mismatch proof. Preserve the sequence: recovery-mode and INTENT existence checks; basic outcome-shape and stage/type validation; then committed boundary-receipt verification; only then idempotency handling or any append/sequence mutation. Confirm this ordering with focused tests; do not weaken or delete T46/T47. **Status: CONTRACTUAL CONSTRAINT / IMPLEMENTATION NOT VERIFIED.**
- **Fresh call-site inventory:** source scan found 15 textual `appendOutcome` call locations, including wrapper/instrumentation declarations. The successful paths in the shared MODEL helper, T06, T13, T28, T44, and T45 pass the exact permit receipt; T49/T51 include exact-receipt acceptance and deliberate invalid/replay cases. T46/T47 remain intentionally receipt-free stage-mismatch negatives; T48 remains the explicit missing-receipt negative; T49/T51 mutation and replay inputs remain deliberately altered. This source inventory does not establish runtime conformance.
- **Execution gate:** no test command was executed in this audit. The connected GitHub action surface available in this session exposes PR-filtered commit-run retrieval but no workflow-dispatch or general push-run listing action. No local checkout or local-host execution was attempted. Thus T48–T52 remain **NOT VERIFIED**; no RED/GREEN result is newly claimed. The prior duplicate-publication concurrency RED remains a separate, preserved blocker.
- **Required next atomic step:** obtain an observable focused RED for T48 (and preserve T46/T47 behavior) using the existing test-only conformance workflow; then implement only the in-memory reference-oracle receipt capability/verification and persisted-receipt recovery needed for T48–T52. Keep it explicitly non-cryptographic, in-memory, single-process, and non-production. Re-run focused T48–T52, the full T01–T52 tranche, and the full reviewer regression. Do not alter the original duplicate-publication RED.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 hosted execution evidence — AR-52 and AR-53

- Executed commit: `b0ce75ab0bdee7407fca7ca7e6ae60fd1e4b68ae`.
- Conformance workflow run: [45561794550](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45561794550), event `push`, conclusion `failure`; job `conformance` ID `139026995553`.
- Checkout and Node.js 22 setup completed; `npm ci --ignore-scripts --no-audit --no-fund` completed successfully. The full reviewer regression and isolated reference-oracle tranche both executed and failed on assertions, not dependency installation.
- **Full reviewer regression:** 189 tests, 178 passed, 11 failed. Failures:
  - T06 and T13: successful-path assertions observe `attemptBoundaryReceipt.stage === undefined` rather than MODEL/COMMENT.
  - T28: explicit committed MODEL receipt-presence assertion fails.
  - T44/T45: successful recovery-lock setup paths observe missing MODEL/COMMENT receipt stage.
  - T48: missing receipt incorrectly returns `ACK` instead of `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED`.
  - T49/T51: MODEL/COMMENT permit responses do not contain boundary receipts.
  - T50: `readAttemptBoundaryReceipt` is absent.
  - T52: shared MODEL helper receives no committed boundary receipt.
  - Preserved duplicate-publication test: observed 2 comment POSTs; expected at most 1. This is the original independent concurrency RED and remains unchanged.
- **Isolated reference-oracle tranche:** 52 tests, 42 passed, 10 failed. The failures are T06, T13, T28, T44, T45, and T48–T52. T46 and T47 both passed, confirming their stage-mismatch error precedence remains intact in this run.
- **AR-52 status:** RECEIPT-ISSUANCE / VERIFICATION / RECOVERY GAP CONFIRMED BY HOSTED EXECUTION. The test-first evidence now exists. No adapter implementation has yet been applied. This is a reference-oracle failure only and makes no statement about any deployed backend.
- **Gitleaks workflow:** run [45561794534](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45561794534), job `139026995857`, conclusion `failure`. The PR-diff scan passed with no leaks. The full fetched-ref history scan examined 5,261 commits and reported 13 `generic-api-key` findings across historical commits and paths (including `cloud-engineering-connector/worker.js`, `cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js`, `tools/9router-review/review.test.mjs`, and one historical documentation file). The log redacted values; no report artifact or exact secret values were available in this run.
- **AR-53 status:** HISTORICAL SECRET-SCAN FINDINGS / UNTRIAGED. These are scanner detections, not confirmation that 13 live credentials exist. Do not add broad allowlists, print values, rotate secrets, or rewrite history on the basis of this output alone. Required separate investigation: recover exact redacted-safe finding identities and verify whether each is a test fixture, revoked credential, or live secret using an authorized secret-handling process. PR-diff clearance does not clear historical exposure.
- **Hostile review:** failure accounting reconciles exactly: 10 receipt-related failures plus the independent duplicate-publication RED equals 11 full-suite failures; the isolated 52-test tranche has the 10 receipt-related failures. T46/T47 are explicitly preserved and observed PASS. Dependency installation succeeded, so the failures are not attributed to setup. The Gitleaks PR-diff pass and full-history failure are kept as separate scopes; no false claim of clean history or confirmed live secret is made.
- **Next atomic implementation boundary:** update only `reference-adapter.mjs` to issue/store test-only opaque in-memory boundary capabilities as part of the same in-memory state transition, expose read-only exact receipt recovery, and require exact capability matching in `appendOutcome`. Preserve T46/T47 error precedence and all negative/replay assertions. Do not describe this oracle as cryptographic, durable, distributed, or production-qualified. Then execute focused T48–T52, the full T01–T52 tranche, and full reviewer regression. The duplicate-publication RED and Gitleaks history finding remain separate blockers.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 reference-oracle receipt implementation — AR-54

- Implementation commit: `8b82a535a5b2dab67890645c355fa0119e887164`; scope: `tools/9router-review/conformance/reference-adapter.mjs` only.
- The in-memory oracle now issues a MODEL or COMMENT boundary receipt only after validating the corresponding acknowledged INTENT and current reservation owner/state. The receipt binds the immutable reservation-key digest, stage, attempt ID, request digest, generation, predicted committed record version, boundary event ID, issue time, protocol/schema identifiers, and fixed purpose.
- The same synchronous in-memory transition stores the receipt in the reservation record and the private authority registry. The permit returns a cloned receipt only after the record write. The registry is private to `createReferenceSystem`; `appendOutcome` accepts only an exact receipt issued for the same INTENT, and performs this check after stage/type validation but before idempotency lookup or ledger mutation.
- Missing receipt returns `ATTEMPT_BOUNDARY_NOT_ACKNOWLEDGED`; any non-exact, mutated, cross-key, cross-attempt, or cross-stage receipt returns `INVALID_ATTEMPT_BOUNDARY_RECEIPT`. Idempotent outcome retries still require the same valid receipt.
- `readAttemptBoundaryReceipt` is read-only, checks the requested immutable key/stage/attempt against both the authoritative in-memory record and private issued-receipt registry, returns the exact stored receipt, and fails closed on quarantine or registry/record mismatch. It does not mint a receipt or repeat the one-time attempt transition.
- **Explicit limitation:** the `signature` field is a deterministic `reference-only:` digest token, not a cryptographic signature or MAC. The private Map is an in-process test capability registry, not a durable trust root, independent ledger, transaction system, crash-safe store, or cross-process concurrency control. Passing this oracle suite does not qualify any production adapter.
- **Hosted verification:** workflow run [45562138920](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562138920), commit `8b82a535a5b2dab67890645c355fa0119e887164`.
  - Dependency installation succeeded.
  - Isolated reservation conformance: **52/52 PASS**, including T48–T52, T46/T47 precedence, T06/T13/T28/T44/T45 receipt propagation.
  - Full reviewer regression: **188/189 PASS**. The sole failure is the preserved deterministic duplicate-publication RED: 2 comment POSTs observed, maximum 1 expected. No other reviewer regression failed.
  - Workflow conclusion remains `failure` because the independent duplicate-publication test is intentionally preserved. Do not label the full suite GREEN.
- **AR-54 status:** REFERENCE-ORACLE RECEIPT PATH IMPLEMENTED / ISOLATED CONTRACT TRANCHE GREEN / PRODUCTION QUALIFICATION NOT ESTABLISHED.
- **Gitleaks follow-up:** run [45562138995](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562138995) again passed the PR-diff scan and failed the all-fetched-refs history scan with the same 13 `generic-api-key` detections across historical commits. The finding identities/commit locations are unchanged from AR-53; no new current-diff detection was reported. AR-53 remains OPEN / UNTRIAGED.
- **Hostile review:** checked that T46/T47 stage errors precede receipt checks; T48 rejects absent receipts without advancing the ledger; T49 mutation and cross-binding rejection leaves ledger state unchanged; T50 recovers the exact MODEL receipt after discarding the first response and refuses a second permit; T51 validates COMMENT receipt and rejects cross-intent/cross-stage replay; T52 confirms exact receipt propagation. Hosted evidence confirms all 52 isolated tests pass. The remaining full-suite failure is the separate original publication race and was not edited or masked.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 post-commit receipt binding hardening — AR-55

- Hardening commit: `b854849ab337280efb0c152c17eaa3d90894e574`; scope remains `tools/9router-review/conformance/reference-adapter.mjs` only.
- **Hostile finding:** the first reference implementation inserted the private receipt-registry entry before writing the reservation record, and `appendOutcome` checked the registry without also checking the receipt persisted on the authoritative in-memory record. Although the synchronous oracle exposed no external interleaving in the tested path, that ordering was weaker than the intended commit-before-capability contract and left an avoidable split-state failure mode if the record write threw.
- **Correction:** receipt construction is now side-effect-free; the reservation record is written with the receipt first; only after the write succeeds is the private registry entry registered, with no asynchronous boundary between those synchronous operations. `appendOutcome` now also verifies that the current authoritative record retains the same stage-specific attempt ID and exact persisted receipt, and that registry generation/committed-version metadata match the supplied receipt.
- **Hosted verification on the hardened commit:** workflow run [45562365938](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562365938).
  - Isolated conformance: **52/52 PASS**.
  - Full reviewer regression: **188/189 PASS**; sole failure remains the preserved duplicate-publication RED (2 POSTs vs expected 1).
  - Dependency installation and both test execution steps completed.
- Gitleaks run [45562365958](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562365958): PR-diff scan passed; all-fetched-refs scan still reports the same 13 historical generic-key detections. AR-53 remains OPEN / UNTRIAGED.
- **AR-55 status:** HOSTILE FINDING CORRECTED / HOSTED REFERENCE TESTS PASS / NO PRODUCTION SECURITY CLAIM.
- No changes to `main`, PR #463, reviewer activation, provider dispatch, secrets, Cloudflare resources/deployments, repository policy, or local host.


#### 2026-11-25 concurrency boundary revalidation — AR-56

- **Source audit:** `runReview()` still performs read-only `findMatchingReviewComments()` preflight, then model inference, then live PR revalidation, then GitHub comment POST. No reservation-store adapter or durable claim is called from this path. The reference-oracle receipt implementation is not integrated into `runReview()` and must not be represented as a concurrency fix.
- **Workflow audit:** `.github/workflows/9router-pr-review.yml` has no workflow/job `concurrency` group. Its reviewer job remains `if: false`; the bootstrap has not activated reviewer/provider execution. No workflow change is proposed in this finding.
- **Observed falsification:** the deterministic barrier test `deterministic concurrent duplicate-publication red test` runs two concurrent `runReview()` invocations against a shared fake transport. Hosted run [45562452160](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562452160), on documentation commit `4ea259f9896b54972b0190e4c6b8b3fa50573de0`, observed **2 comment POSTs where the invariant allows at most 1**. This is a confirmed duplicate-publication defect for the exact tested same-process interleaving.
- **Scope limitation:** the test uses two asynchronous invocations in one Node.js process and one shared fake transport. It does not simulate independent GitHub Actions runners, process death, or a distributed backend. Cross-process behavior remains untested; the source-level absence of a shared durable reservation means the test's failure is not evidence that a process-local lock would be sufficient.
- **AR-56 disposition:** CONFIRMED SAME-PROCESS INTERLEAVING / CROSS-PROCESS QUALIFICATION NOT RUN / REVIEWER REMAINS DISABLED. Do not add a process-local mutex and claim at-most-once semantics. A workflow concurrency group may be considered only as defense in depth, never as the correctness authority.
- **Next atomic gate:** define the production-facing reservation-store interface and its conformance semantics, then evaluate at least two backend candidates against unique-key arbitration, linearizable claim/lease/fencing, durable intent/outcome ordering, crash recovery, ambiguous POST reconciliation, backup/restore, least privilege, and cost. Do not integrate a vendor or activate the reviewer until one candidate satisfies the evidence gates. The existing reference oracle remains a test-only executable contract.
- **Latest verification:** run [45562452160](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562452160) reports 52/52 isolated conformance PASS and 188/189 full regression PASS; its sole failure is this unchanged duplicate-publication RED. Gitleaks run [45562451959](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45562451959) remains failed on the same 13 historical generic-key detections while the PR-diff scan passes. AR-53 remains OPEN / UNTRIAGED.
- **Isolation check:** PR #463 remains Draft / Open / Unmerged at head `59c84265b18fa121350a412902acd769900ceb1c`; `main` remains at `919b19ca3d3887352cdef06b03c668ead04fbce7`. No PR #463, `main`, production, secrets, Cloudflare, repository policy, or local-host changes were made.


#### 2026-11-25 provider-neutral ReservationStore contract — AR-57

- **Design commit:** `e12ce8233c8760b644b8953248e2ac4e44b71191`; added `tools/9router-review/conformance/RESERVATION_STORE_CONTRACT.md`. No executable source, workflow, package manifest, tests, or runtime configuration changed in this design commit.
- **Purpose:** define the production-facing provider-neutral contract required by AR-56 before any vendor adapter is implemented. The contract defines immutable reservation identity, trusted repository-ID validation, atomic claim/lease/fencing, one-time MODEL/COMMENT attempt boundaries, receipt persistence/recovery, typed failure outcomes, cross-store EffectLedger ordering, runReview integration order, backend qualification gates, and 22 fault-injection scenarios.
- **Identity rule:** reservation identity is `(repository_id, pull_request_number, head_sha, base_sha)`. The live PR's base/head repository IDs must both match the trusted immutable repository ID before key derivation. Both the canonical tuple and its digest are persisted; digest aliasing is an integrity conflict.
- **Integration rule:** a future `runReview()` implementation must claim immediately after live PR identity/snapshot validation and before patch retrieval/model inference. No provider or GitHub comment side effect may occur without a durably committed stage-specific boundary and independently verified receipt.
- **Cross-store qualification:** the document explicitly does not assume an atomic distributed transaction between ReservationStore and EffectLedger. It specifies write-ahead INTENT, durable reservation boundary/receipt, one external attempt, receipt-bound OUTCOME, and a final fenced reservation transition. Ambiguous acknowledgements remain UNKNOWN and fail closed.
- **Candidate A — Cloudflare SQLite-backed Durable Objects:** official documentation supports private per-object transactional/strongly consistent storage and SQLite PITR; a deterministic key-to-object mapping plus persisted full-tuple comparison is a plausible per-key arbitration design. Cross-object/global journal atomicity is not provided. PITR rollback requires RECOVERY_LOCKED reconciliation against independent evidence. R2 conditional create-once writes are useful for immutable ledger events but do not create a multi-object transaction; an in-flight write's negative HEAD is not proof of failure. R2 in the same Cloudflare account is not an independent vendor/account failure domain. Candidate only; not selected.
- **Candidate B — Supabase PostgreSQL:** PostgreSQL unique constraints and transactional row/CAS updates are a plausible reservation authority. The actual driver and transaction-pooler behavior must be tested; transaction mode does not preserve session state and has prepared-statement/session-lock limitations. Supabase Free may pause after seven days of low activity and has no automatic backups or PITR; therefore it is not accepted as the sole production authority under the current no-card/low-cost constraint without independent backup/restore qualification. Candidate only; not selected.
- **R2 disposition:** considered only as a possible immutable EffectLedger surface, not a ReservationStore. Conditional `If-None-Match: *` is atomic for create-once while the object exists; deletion can permit a later create, and ambiguous writes require unique write IDs and reconciliation.
- **Hostile review findings addressed in the contract:** (1) do not trust caller-supplied repository owner/name without matching immutable repository IDs; (2) do not use a process-local lock or workflow concurrency as the correctness authority; (3) do not reclaim leases after a stage attempt boundary; (4) do not mint a new receipt after lost acknowledgement; (5) do not imply atomicity across DO/Postgres and R2; (6) do not treat PITR restore as safe without independent monotonic evidence; (7) do not treat incomplete marker listings or negative reads during in-flight writes as proof of absence; (8) do not treat free-tier availability, billing, card eligibility, or account configuration as verified.
- **Remaining gaps:** no production TypeScript interface has been frozen; no provider adapter, schema, migration, runtime integration, independent-process test, crash/recovery drill, restore drill, or cost/billing inspection has been performed. The interface shown in the document is an abstract contract requiring reconciliation with existing `OPERATIONS.md` state transitions and conformance tests before implementation.
- **Verification:** GitHub branch ref was observed at `7b6b25df99c0a7b5b7f937ab95969cfb2e7c2b12` before this documentation change. The contract was committed to the existing isolated branch only. No test command was manually run during document authoring; the branch push did trigger hosted conformance and secret-scan workflows. Their exact-head results are reconciled in AR-59 below; do not infer test status from the documentation commit alone.
- **Isolation:** `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains untouched. Reviewer activation, provider dispatch, secret access/change, workflow registration, repository policy change, Cloudflare resource/deployment, Supabase resource, merge, and local desktop action were not performed.
- **Official sources reviewed:** Cloudflare SQLite-backed DO storage and limits; R2 conditional operations, consistency, and bucket locks; Supabase transaction pooling, Free project pausing, and backup policy. Source links are recorded in `RESERVATION_STORE_CONTRACT.md`. Documentation is not runtime proof.
- **Disposition:** AR-57 DESIGN RECORDED / HOSTILE SOURCE REVIEW RECORDED / PROVIDER NOT SELECTED / RUNTIME QUALIFICATION NOT RUN. Next gate is independent review of the contract and its state-machine alignment, followed by a test-only adapter conformance plan. No vendor implementation or reviewer activation is authorized by this record.


#### 2026-11-25 ReservationStore interface hostile refinement — AR-58

- **Corrective design commits:** `af7d78b8740d802fc1b6807da95338bb7626aab4` and `85e6c7fb6f81adabd724ff66a0430d6d3b3bf6f6`; both modify only `tools/9router-review/conformance/RESERVATION_STORE_CONTRACT.md`.
- **AR-58-1 — Generic transition method was under-specified.** Hostile review of AR-57 found that a generic `transition()` with optional stage/attempt/evidence fields did not make it structurally difficult to complete MODEL/COMMENT state without the exact boundary receipt and durable EffectLedger OUTCOME acknowledgement. It was replaced with explicit `completeModelAttempt()` and `completeCommentAttempt()` signatures requiring the exact receipt, matching attempt ID, outcome acknowledgement, expected version, and fence. Explicit `beginModelAttempt()` / `beginCommentAttempt()` signatures now encode the stage-specific prerequisites.
- **AR-58-2 — Recovery authority was not represented in the method signatures.** The first revision described recovery authorization in prose but omitted it from mutation inputs. Added a scoped, signed `RecoveryAuthorization` type and made continuation recovery, UNKNOWN marking, and comment reconciliation require it. `closeWithoutPublish()` requires a current fence and permits recovery authorization only as an explicit alternative path. The trust root remains out-of-band and must be independently verified.
- **AR-58-3 — Missing state/result types.** Added explicit `ReservationState`, `ReservationRecord`, and EffectLedger acknowledgement shapes; replaced the generic conflict result with typed `FENCED`, `INTEGRITY_CONFLICT`, and `INVALID_TRANSITION` outcomes. These types improve reviewability but do not constitute compiled or runtime-verified TypeScript.
- **Hostile disposition:** the first interface draft was not accepted as implementation-ready. The refined document now makes the critical receipt/outcome and recovery-authority preconditions visible in method signatures. Residual limitation remains explicit: signatures are design-level pseudocode, not a frozen API; they still require line-by-line mapping to every existing state transition, error precedence rule, and T01–T52 case before implementation.
- **Verification:** the two corrections are documentation-only; no executable source, type-check, provider adapter, migration, independent-client race, crash test, or restore drill was changed or run as part of authoring them. Hosted conformance and secret-scan workflows did execute on subsequent exact branch heads; their results are recorded in AR-59. Do not infer a clean full suite from the isolated reference-oracle tranche.
- **Isolation:** all changes remain on `verify/9router-reservation-conformance-run9-2026-11-25`; `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at `59c84265b18fa121350a412902acd769900ceb1c`. No workflow, secret, provider, Cloudflare/Supabase resource, production, or local desktop change was performed.
- **Disposition:** AR-58 DESIGN-LEVEL WEAKNESS IDENTIFIED AND CORRECTED / TYPE-CHECK NOT RUN / RUNTIME NOT RUN. The next gate remains independent review and an explicit mapping from this contract to the existing state machine and conformance suite before any implementation.


#### 2026-11-25 hosted verification accounting correction — AR-59

- **Reason:** hostile audit of the audit trail found two imprecise statements in AR-57/AR-58. The documentation commits themselves did not run local commands, but branch-push workflows did execute hosted tests. The prior wording could be read as claiming that no executable test ran at all. This entry supersedes that interpretation.
- **Exact-head conformance evidence:** run [45572090521](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45572090521) on head `ed3dbce38579eefd31199d21367d1e6c0a202d32` completed with failure. Dependency installation succeeded. The full reviewer regression reported **188/189 PASS, 1 FAIL**; the sole failure is the preserved `deterministic concurrent duplicate-publication red test` (test 124). The isolated reference-oracle tranche reported **52/52 PASS**. These results do not qualify a production backend and do not resolve the same-process concurrency defect.
- **Exact-head Gitleaks evidence:** run [45572090531](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45572090531) on the same head completed with failure. The PR-diff scan passed with zero findings; the all-fetched-ref history scan failed with the same **13 `generic-api-key` detections** across historical refs/commits. They remain historical scanner findings, not confirmed live credentials; no suppression, allowlist expansion, secret-value retrieval, or history rewrite was performed.
- **Workflow state:** the conformance and Gitleaks jobs completed on the exact branch head. A later documentation-only commit will trigger another run; the above IDs remain the evidence for the exact head stated here, not for future commits.
- **Corrected interpretation:** the documentation-authoring actions did not manually execute local test commands. Hosted CI did execute the repository's existing conformance and secret-scan workflows. Isolated reference conformance is GREEN; the full regression is NOT GREEN; the full-history secret scan is NOT GREEN.
- **Isolation:** branch remains separate from `main`; `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at `59c84265b18fa121350a412902acd769900ceb1c`. No runtime, provider, secret, Cloudflare/Supabase resource, workflow policy, or local desktop mutation was made.
- **Disposition:** AR-59 AUDIT-TRAIL WORDING CORRECTED / EXACT-HEAD HOSTED RESULTS RECORDED / KNOWN FAILURES PRESERVED.


#### 2026-11-25 ReservationStore traceability baseline — AR-60

- **Artifact commit:** `3f2dcc2d0e712e9bcd2ee2dfd8c2d308a1d215fe`; created `tools/9router-review/conformance/RESERVATION_STORE_TRACEABILITY.md`.
- **Scope:** mapped all 52 executable reference-oracle tests (T01–T52) against the production-facing abstract contract, its 22 fault-injection requirements (RS-01–RS-22), and each proposed ReservationStore method. Added explicit evidence grades (DIRECT / PARTIAL / GAP) and an ORACLE ONLY limitation.
- **Static inventory verification:** fetched the test source and contract source from the branch; programmatic source comparison found exactly 52 source test IDs and 52 unique matrix rows, with no missing or duplicate T IDs. It found 22 contract RS requirements and 22 unique matrix rows, with no missing or duplicate RS IDs.
- **Initial hostile-review correction:** commit `e7d37a59b51cf8ba3683d89aadfd155403eb3262` corrected false-positive mappings. T04 (missing INTENT), T48 (missing boundary receipt), and T52 (receipt propagation) do not simulate a transaction abort or a crash after durable INTENT. Their RS-07/RS-08 mappings were removed or explicitly downgraded to adjacent evidence. RS-07 and RS-08 remain GAP.
- **Blocking gaps identified:** RS-02 digest alias/full-tuple collision; RS-07 boundary transaction abort; RS-08 crash between ledger INTENT and reservation boundary; RS-10 provider success followed by crash before OUTCOME; RS-12 GitHub accepts POST then response is lost; RS-17 signing-key revocation/authority identity change; RS-18 quota/rate-limit exhaustion; RS-22 cross-vendor outage/partial restore. These are not covered by the current reference suite and must not be represented as supported.
- **Other partial areas:** independent-process claim arbitration, stale writes across all operations, server-clock/failover behavior, durable receipt recovery after process restart, comment reconciliation against real paginated API behavior, backup/restore, and operation-ID idempotency across every write.
- **API alignment finding:** the provider-neutral interface introduces operation IDs, typed durable acknowledgements, and signed recovery authorization not represented as an identical compiled interface in the reference adapter. Behaviorally related tests do not prove method-level conformance. This must be resolved before adapter implementation.
- **Evidence boundary:** this was a static source-to-test mapping. No test command was manually run as part of authoring the matrix; no backend adapter, migration, type-check, process-kill test, quota test, revocation test, independent-client test, or restore drill was performed. Hosted CI is triggered by branch pushes; its exact final-head results are recorded in a later checkpoint and must be read from that exact SHA.
- **Isolation:** branch remains `verify/9router-reservation-conformance-run9-2026-11-25`; `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at its previously verified head `59c84265b18fa121350a412902acd769900ceb1c`. No runtime, provider, secret, Cloudflare/Supabase resource, workflow policy, merge, deployment, or local desktop change was made.
- **Disposition:** TRACEABILITY MATRIX RECORDED / STATIC INVENTORY CHECK PASSED / HOSTILE MAPPING CORRECTION RECORDED / MULTIPLE BLOCKING GAPS OPEN / NO PROVIDER QUALIFIED.



#### 2026-11-25 exact-head traceability CI verification — AR-61

- **Tested source/documentation head:** `e6c1fdd5078aff120971f62f10846d0e1f2219eb`. This is the exact head that triggered both hosted workflows after the traceability matrix and audit record were committed.
- **Reservation conformance workflow:** [run 45572757069](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45572757069) completed with failure. Dependency installation and the isolated reference-oracle tranche succeeded. The isolated tranche reports **52 tests / 52 passed / 0 failed**. The full reviewer regression reports **189 tests / 188 passed / 1 failed**. The sole failure is test 124, `deterministic concurrent duplicate-publication red test`: expected at most one POST, observed `actual: 2`, `expected: 1`. This preserves the known duplicate-publication defect; it is not a regression introduced by the documentation-only traceability work.
- **Gitleaks workflow:** [run 45572756973](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45572756973) completed with failure. PR-diff scan: **no leaks found**. All-fetched-refs scan: **13 `generic-api-key` historical detections**, at the same historical locations already tracked in AR-59; no new finding in the current diff. The detections are not confirmed live credentials and remain OPEN / UNTRIAGED. No secret values were retrieved, allowlist widened, or history rewritten.
- **Interpretation:** isolated reference-oracle tranche GREEN; full reviewer regression NOT GREEN; PR-diff secret scan GREEN; all-history secret scan NOT GREEN. These results do not qualify a production ReservationStore or EffectLedger.
- **Scope comparison:** relative to prior tested head `445096ef585ae8c3f5235d9d6e4a84b4e52a0dd5`, the traceability work changed only `tools/9router-review/OPERATIONS.md` and added `tools/9router-review/conformance/RESERVATION_STORE_TRACEABILITY.md`. No executable source, workflow, package manifest, or runtime configuration changed in this tranche.
- **Isolation recheck:** `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at head `59c84265b18fa121350a412902acd769900ceb1c`. No reviewer activation, provider dispatch, resource provisioning, secret modification, deployment, merge, or local desktop action occurred.
- **Disposition:** EXACT-HEAD HOSTED RESULTS RECORDED / KNOWN CONCURRENCY RED PRESERVED / HISTORICAL GITLEAKS FINDINGS OPEN / PRODUCTION QUALIFICATION NOT ESTABLISHED.



#### 2026-11-25 full-tuple characterization and exact-head verification — AR-62

- **Scope:** added T53 to `tools/9router-review/conformance/reservation-adapter.contract.test.mjs`. It creates two reservations in the in-memory reference oracle whose immutable tuples differ only by `head_sha`, then verifies both claims are independent, each persisted record retains its exact tuple, and both begin at generation 1.
- **Why this is deliberately narrow:** the reference adapter indexes its in-memory map by the complete canonical JSON tuple; it does not implement the production SHA-256 key-digest index. T53 is a characterization test for full-tuple separation only. It does **not** force a digest collision, does not prove collision detection in a production digest index, and does not close RS-02. The RS-02 row remains GAP.
- **Hostile review of T53:** the initial draft asserted nonexistent top-level `repository_id` fields. Inspection of the actual record schema showed the tuple is persisted under `reservation_key`; assertions were corrected to compare both returned and authoritative persisted `reservation_key` objects with the exact input tuples. The final test does not assert absent fields or infer digest behavior.
- **Traceability update:** T53 was added to the T-test matrix and the `claim` method row. The matrix still contains all 22 RS requirements exactly once. RS-02 remains explicitly GAP and documents why T53 is adjacent evidence only. Source snapshot in the matrix identifies the pre-audit test/matrix commit `7e266cf4313b42bea7e66d5d7222218b6477e177`; matrix metadata was subsequently refreshed in `e79863212fb39bd70833762fd1dc248d577614c9`.
- **Static inventory verification:** fetched the exact branch files and compared IDs programmatically: **53 source tests / 53 unique matrix rows**, no missing or duplicate T IDs; **22 contract requirements / 22 unique matrix rows**, no missing or duplicate RS IDs.
- **Exact-head hosted conformance:** run [45573261733](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45573261733), head `7e266cf4313b42bea7e66d5d7222218b6477e177), completed with failure. Isolated reference-oracle tranche: **53/53 PASS**. Full reviewer regression: **189/190 PASS, 1 FAIL**. The sole failure remains the original deterministic duplicate-publication race: test 125 observed `actual: 2` where `expected: 1`. T53 passes; the known race remains unresolved.
- **Exact-head Gitleaks:** run [45573261732](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45573261732) completed with failure. PR-diff scan reports no leaks; all-fetched-refs scan reports the same **13 historical `generic-api-key` detections**. They remain OPEN / UNTRIAGED; no secret values were retrieved, no allowlist was widened, and no history was rewritten.
- **Diff boundary:** relative to `f9479c419ffb8a9a311c01dcfd7e46135337e36c`, the T53 tranche changes only the conformance test file and traceability matrix. No production adapter, reviewer runtime, workflow, package manifest, provider integration, or deployment configuration changed.
- **Isolation:** `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at head `59c84265b18fa121350a412902acd769900ceb1c`. Reviewer remains disabled. No secrets, Cloudflare/Supabase resources, repository policies, merge, deployment, or local desktop state changed.
- **Disposition:** T53 CHARACTERIZATION GREEN IN REFERENCE ORACLE / RS-02 STILL GAP / DUPLICATE-PUBLICATION RED STILL PRESENT / HISTORICAL GITLEAKS FINDINGS OPEN / NO PRODUCTION QUALIFICATION.


#### 2026-11-25 forced digest-collision conformance — AR-63

- **Requirement:** RS-02 — the same reservation digest presented with a different immutable full tuple must return `INTEGRITY_CONFLICT` without mutating reservation or ledger state.
- **RED evidence:** T54 was added on commit `e08b2554e02d32b8267c8a963cf828fc893d67bb`. Exact-head workflow [45573838657](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45573838657) observed the intended defect: expected `INTEGRITY_CONFLICT`, actual `CLAIMED`. The isolated tranche had 54 tests / 53 passed / 1 failed (T54); the full reviewer suite had 191 tests / 189 passed / 2 failed (T54 plus the preserved duplicate-publication race).
- **Minimal oracle fix:** commit `f2185dc7565ec0b4c5e122e26a180bd6c30b8b49` adds an injectable `reservationKeyDigest` seam and a reference-only digest index. Before a claim can create or reuse a record, the adapter compares the digest's indexed canonical full tuple. A different tuple under the same digest returns `INTEGRITY_CONFLICT`. The initial record and digest index are registered in the same synchronous, no-await in-memory operation. `readAuthoritative` applies the same collision check. This is a reference-oracle model only; it is not a cryptographic SHA-256 implementation, database transaction, or durable reservation store.
- **Initial GREEN evidence:** exact-head workflow [45573970974](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45573970974), head `f2185dc7565ec0b4c5e122e26a180bd6c30b8b49`, observed T54 PASS and **54/54 isolated reference-oracle tests PASS**. The full suite was **190/191 PASS**; the only remaining failure was the pre-existing deterministic concurrent duplicate-publication test (observed 2 POSTs, expected 1).
- **Hostile test review:** the first T54 version checked the alternate tuple while the forced digest collision was still active. That check alone could hide a wrongly persisted second row behind the collision guard. T54 was first hardened in commit `cfc9c9368bf88fc79cf9cddbcbea06e48335a7a7` to switch to a unique diagnostic namespace and expose a hidden alias record. A further hostile assertion in `d06fa73a5498c3a6494b9bfcc3948e0559fc89b6` now reads the original tuple while the forced collision is still active, confirming the original remains the digest-index owner and the alternate remains conflicted. It then switches to the unique diagnostic namespace and confirms the alternate returns `NOT_FOUND`. The original record and EffectLedger inventory remain deep-equal unchanged.
- **Final strengthened-test evidence:** exact-head workflow [45574913889](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45574913889), head `d06fa73a5498c3a6494b9bfcc3948e0559fc89b6`, observed T54 PASS and **54/54 isolated tests PASS**. Full reviewer suite remained **190/191 PASS**, with only the original duplicate-publication race failing (test 126: actual 2, expected 1). The RED-GREEN cycle and both collision-index and no-hidden-record assertions are verified for T54; the unrelated publication race is not addressed by this change.
- **Exact-head Gitleaks:** [45574913939](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45574913939) reports no PR-diff leaks and the same **13 historical `generic-api-key` detections** in fetched refs. They remain OPEN / UNTRIAGED; this change added no finding in the PR diff. No secret values were retrieved, no allowlist expanded, and no history rewritten.
- **Traceability:** T54 is added to the matrix and mapped directly to RS-02. RS-02 changes from GAP to **PARTIAL**: reference-oracle collision behavior has direct evidence, while production SHA-256, durable unique indexing, transactional atomicity, restart, and independent-client evidence remain absent. The matrix still lists all other open requirements and does not authorize a production adapter.
- **Hostile implementation review:** collision is checked before any claim mutation; no write path is reached for the colliding tuple; the original record remains unchanged; the original tuple still owns the forced digest index; switching to a unique diagnostic digest proves no second tuple record was stored; ledger watermark/events remain unchanged. The digest function is injected test scaffolding and intentionally non-cryptographic. The in-memory index is not crash-durable or cross-process linearizable.
- **Diff boundary:** the oracle-fix commit `f2185dc7565ec0b4c5e122e26a180bd6c30b8b49` changed only `reference-adapter.mjs`; the initial evidence-documentation commit `9442a0418cf7904cba01c103fbd7efafa2e8295e` changed only the traceability matrix and operations log; the final T54 hardening from `cfc9c9368bf88fc79cf9cddbcbea06e48335a7a7` to `d06fa73a5498c3a6494b9bfcc3948e0559fc89b6` changed only the T54 test file (5 additions / 0 deletions). No reviewer runtime, provider dispatch, workflow, package manifest, secret, backend resource, or deployment changed.
- **Isolation:** branch remains `verify/9router-reservation-conformance-run9-2026-11-25`; `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at head `59c84265b18fa121350a412902acd769900ceb1c`. Reviewer remains disabled. No local desktop state changed.
- **Disposition:** RS-02 REFERENCE-ORACLE COLLISION SEMANTICS VERIFIED / PRODUCTION QUALIFICATION STILL PARTIAL / ORIGINAL DUPLICATE-PUBLICATION RED PRESERVED / HISTORICAL GITLEAKS FINDINGS OPEN.



#### 2026-11-25 MODEL/COMMENT pre-commit boundary abort conformance — AR-64

- **Requirement:** RS-07 — a transaction abort at the attempt boundary must not expose a permit or receipt, consume the one-time boundary, or leave a partial reservation/ledger transition.
- **RED evidence:** T55/T56 were added on commit `608571b7d87a00852dc669363f07d6930ff6f91f`. Exact-head workflow [45575512878](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45575512878) observed the missing abort behavior: T55 expected `TRANSACTION_ABORTED`, actual `MODEL_PERMIT`; T56 expected `TRANSACTION_ABORTED`, actual `COMMENT_PERMIT`. The isolated tranche reported 56 tests / 54 passed / 2 failed; full reviewer regression reported 193 tests / 190 passed / 3 failed (T55, T56, and the preserved duplicate-publication race).
- **Reference-oracle implementation:** commit `27f76d52ce04009683e3c4c8fc33c13477448604` added a typed pre-commit fault-injection callback for MODEL and COMMENT boundaries. When the callback requests abort, the adapter returns `TRANSACTION_ABORTED` before `writeRecord`, before receipt registration, and before returning a permit. Receipt creation stages the next boundary event ID without incrementing the counter; the counter advances only after the receipt is registered. Commit `9ede278be515a90762303767d00f8ac28e964ec8` further moved counter advancement after successful receipt-map registration.
- **Hostile test-scope correction:** T55/T56 originally used broad “aborted transaction” wording. That overstated the tested fault model. Their names now say **pre-commit abort**. These tests do not inject failure after the first record write and do not prove storage-engine rollback or process-crash recovery. They must not be described as full database transaction conformance.
- **Final code/test revision:** `7a42adaecc4b56c7a4b3a4fc6f4f9dd00391b190`. It includes the post-registration sequence ordering and precise pre-commit test names.
- **Exact-head hosted conformance:** run [45576028244](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45576028244) on head `7a42adaecc4b56c7a4b3a4fc6f4f9dd00391b190` completed with T55 PASS and T56 PASS. Isolated reference-oracle tranche: **56/56 PASS**. Full reviewer regression: **192/193 PASS, 1 FAIL**; the sole failure remains test 128, deterministic concurrent duplicate-publication (actual 2, expected 1). No assertion was weakened; the existing RED was preserved.
- **Exact-head Gitleaks:** run [45576028279](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45576028279) reports no PR-diff leaks and the same **13 historical `generic-api-key` detections** in fetched refs. They remain OPEN / UNTRIAGED; no secret values were retrieved, no allowlist expanded, and no history rewritten.
- **Traceability:** T55/T56 map to RS-07. RS-07 moves from GAP to **PARTIAL** for reference-oracle pre-commit abort behavior only. Production transaction rollback, failure after partial writes, durable receipt absence, external-effect exclusion, crash/restart, and multi-client verification remain unproven. RS-08 remains GAP and is not conflated with RS-07.
- **Hostile implementation review:** abort hook executes after validation and staged receipt construction but before the first record write. On abort the function does not call `writeRecord` or `registerAttemptBoundaryReceipt`; the boundary sequence is not advanced, and `readAttemptBoundaryReceipt` returns `NOT_FOUND`. T55/T56 compare the authoritative record and EffectLedger inventory before/after, then retry the same attempt ID and INTENT and assert the next expected boundary event ID (MODEL sequence 1; COMMENT sequence 2 after the preceding committed MODEL boundary). The sequence counter is advanced only after in-memory receipt-map registration. This remains synchronous in-memory behavior, not a transactional storage implementation.
- **Diff boundary:** commit `27f76d52ce04009683e3c4c8fc33c13477448604` changed only `reference-adapter.mjs`; commit `9ede278be515a90762303767d00f8ac28e964ec8` changed only the same file to order the sequence increment after registration; commit `7a42adaecc4b56c7a4b3a4fc6f4f9dd00391b190` changed only the conformance test file to clarify the pre-commit fault scope. No reviewer runtime, provider dispatch, workflow, package manifest, secret, backend resource, or deployment changed.
- **Isolation:** branch remains `verify/9router-reservation-conformance-run9-2026-11-25`; `main` remains `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #463 remains Draft / Open / Unmerged at head `59c84265b18fa121350a412902acd769900ceb1c`. Reviewer remains disabled. No local desktop state changed.
- **Disposition:** RS-07 PRE-COMMIT ABORT SEMANTICS VERIFIED IN REFERENCE ORACLE / PRODUCTION TRANSACTION ROLLBACK NOT QUALIFIED / RS-08 STILL GAP / DUPLICATE-PUBLICATION RED PRESERVED / HISTORICAL GITLEAKS FINDINGS OPEN.



#### 2026-11-25 RS-08 crash-window contract gate — AR-65

- **Requirement:** RS-08 — process termination after durable EffectLedger INTENT acknowledgement and before the ReservationStore attempt-boundary call.
- **Current source observation:** `createReferenceSystem()` allocates `records`, `reservationKeyDigestIndex`, `intents`, `outcomes`, and `boundaryReceipts` as process-local `Map` instances. The reference system exposes no durable snapshot/reopen constructor, no shared persistent store injection, no orphan-INTENT recovery operation, and no cross-process recovery authority.
- **Hostile-review decision:** do not author a purported restart test by constructing a second in-memory system or by manually copying Maps. Either approach would test a test harness reconstruction, not durable recovery after process death. Do not label a missing method/type error as RED; that would not establish the required behavioral failure.
- **Required contract decisions before T57:** (1) define an immutable globally unique operation/attempt identity and its binding to reservation tuple, stage, and request digest; (2) define the authoritative query that distinguishes a definitely absent boundary from an ambiguous/lost boundary acknowledgement; (3) define whether an orphan INTENT is terminally abandoned or may be continued, and how that decision is append-only and idempotent; (4) require positive evidence that no permit was issued and no external effect was invoked before allowing continuation; (5) define behavior for unavailable, stale, or incomplete ReservationStore/EffectLedger reads; (6) define fencing against a concurrent recovery worker; (7) define restart persistence and read-after-write guarantees for both stores.
- **Safety invariant:** absence of a boundary receipt in a process-local cache, a timeout, or an unavailable store is not proof that the boundary did not commit. Unknown/ambiguous state must remain quarantined; no model/provider call or GitHub POST may be authorized by recovery.
- **T57 acceptance criteria (not yet implemented):** persist INTENT and receive its durable ACK; terminate the writer before boundary invocation; reopen both stores from durable backing state in an independent process; recover the same attempt identity; prove exactly one deterministic orphan disposition; prove no boundary receipt/permit/external-effect record exists; repeat recovery concurrently and after another restart; assert no duplicate terminal ledger event, no second permit, and no mutation on incomplete reads.
- **Evidence status:** RS-08 remains GAP. No T57 was authored, no RED/GREEN result is claimed, and no production backend is qualified by this checkpoint.
- **Isolation:** no reviewer runtime, provider dispatch, workflow, secret, backend resource, Cloudflare/Supabase configuration, deployment, merge, main-branch ref, or local desktop state was changed.
- **Disposition:** RS-08 CONTRACT GATE IDENTIFIED / IMPLEMENTATION DEFERRED TO A REAL DURABLE REOPEN SEAM / NO FALSE RESTART EVIDENCE.


#### 2026-11-25 Orphan-INTENT recovery protocol draft — AR-66

- **Scope:** authored `tools/9router-review/conformance/ORPHAN_INTENT_RECOVERY_CONTRACT.md` as a design-only protocol for RS-08. The document explicitly states PROPOSED DESIGN / NOT RATIFIED / NOT IMPLEMENTED.
- **Protocol coverage:** immutable operation identity; durable EffectLedger and ReservationStore evidence interfaces; explicit state model; read-only reconciliation; monotonic recovery fencing; idempotent append-only dispositions; fail-closed evidence lattice; failure matrix; T57 independent-process restart acceptance sequence; fault-injection matrix; unresolved ratification decisions.
- **Safety posture:** ambiguous, stale, incomplete, unavailable, or conflicting evidence remains quarantined. The proposal does not silently select automatic abort or automatic continuation. A definitively absent boundary still requires a ratified disposition policy. No provider call, permit, or GitHub POST is authorized by recovery.
- **Hostile review:** checked all 12 required sections; no TBD/TODO/FIXME placeholders; explicit unknown/incomplete-read quarantine; explicit no-auto-permit rule; distinct writer/recovery/second-recovery process sequence; explicit not-ratified status. The current in-memory oracle remains incapable of T57; no restart test or RED/GREEN claim is made.
- **Open decisions:** (1) terminal abort versus separately authorized continuation after definitive absence; (2) identity of continuation authorizer; (3) quarantine scope; (4) retention; (5) escalation/liveness policy; (6) recovery authority trust-root and key lifecycle. These remain open and are not inferred from the user's general instruction to continue.
- **Evidence:** documentation/static contract review only. No test, backend adapter, storage resource, migration, process-kill test, or CI result is claimed.
- **Isolation:** only documentation files on `verify/9router-reservation-conformance-run9-2026-11-25` were changed. No main-branch ref, PR #463, reviewer runtime, workflow policy, secret, provider, Cloudflare/Supabase resource, deployment, merge, or local desktop state was changed.
- **Disposition:** RS-08 CONTRACT DRAFT RECORDED / USER RATIFICATION REQUIRED FOR DISPOSITION POLICY / T57 NOT IMPLEMENTED / RS-08 REMAINS GAP.


#### 2026-11-25 RS-08 terminal orphan-INTENT abort decision — AR-67

- **Decision:** the user explicitly selected terminal abort of an orphan INTENT with a final ledger event. The decision is formalized as [ADR-001](conformance/ADR-001-ORPHAN-INTENT-TERMINAL-ABORT.md), status ACCEPTED.
- **Applicability:** abort only after an authoritative, complete, fresh read proves that the exact boundary, receipt, permit, and boundary event were never committed, and the immutable tuple/INTENT identity are consistent. A committed boundary must recover its exact receipt, not be aborted. Unknown, stale, unavailable, incomplete, or conflicting evidence remains quarantined.
- **Mandatory ordering:** acquire monotonic recovery fence → in one ReservationStore transaction re-check absence and persist a unique terminal tombstone that blocks this exact attempt ID from all future permits → after durable tombstone acknowledgement append the unique immutable ORPHAN_INTENT_ABORTED EffectLedger event → re-read both stores and reconcile. If the process dies between the tombstone and ledger event, the next recovery worker must append the same event idempotently. No cross-store atomic transaction is claimed.
- **No-retry invariant:** the aborted operation/attempt ID is terminal and MUST NOT be resumed or reused. Any future attempt, if separately allowed by higher-level policy, requires a distinct authorization and new operation identity.
- **Implementation status:** policy accepted and documented; durable ReservationStore tombstone, EffectLedger terminal append, process restart, multi-process fencing, late-permit rejection, and incomplete-read behavior are not yet implemented or verified. T57 remains in progress; RS-08 remains GAP.
- **T57 staging:** stage 1 will prove durable INTENT acknowledgement and writer-process termination/reopen; stage 2 will add ReservationStore tombstone and final ledger event; stage 3 will inject the inter-store crash window; stage 4 will test racing recovery workers/fencing; stage 5 will test incomplete reads and late permit rejection; stage 6 will repeat after another restart and record exact-head CI.
- **Isolation:** design and test work remains on the verification branch. No production adapter, reviewer runtime, provider dispatch, secrets, backend provisioning, workflow policy, deployment, merge, main, or local desktop state is changed.
- **Disposition:** POLICY ACCEPTED / PROTOCOL ORDER RECORDED / T57 NOT YET GREEN / NO PRODUCTION QUALIFICATION.


#### 2026-11-25 T57.1 durable INTENT process-reopen probe — AR-68

- **Test:** `tools/9router-review/conformance/orphan-intent-recovery.test.mjs`, test T57.1.
- **Mechanism:** two independent file-backed SQLite database files (EffectLedger and ReservationStore), WAL mode, `synchronous=FULL`; writer child process inserts and acknowledges an INTENT then exits with the injected termination code 73 before any attempt-boundary invocation; a distinct reader process reopens both files and verifies exact event ID, operation ID, immutable payload, SHA-256 payload digest, and zero boundary rows.
- **Exact source identity:** test blob `eb55f2ab523611711d30da96223c0427f59985c6`, committed at `4c8d94f7fa054ab1ab739b9205cf697343a947c2`. The source was checked byte-for-byte against the local execution copy using Git blob SHA. Node.js `v22.16.0` isolated execution: **1 test / 1 pass / 0 failures**.
- **Evidence boundary:** this confirms the stage-1 harness can preserve a committed SQLite record across a process exit and independent reopen on the same runner filesystem. It is not a production store, not a machine/power-loss or independent failure-domain test, and not evidence for tombstone/ledger convergence, recovery fencing, terminal-abort semantics, or late-permit denial.
- **Hosted CI:** exact-head Actions run/check result was not available via the fetched workflow-run and combined-status interfaces. No hosted PASS is claimed.
- **Disposition:** T57.1 ISOLATED PROCESS-REOPEN PROBE PASS / T57.2+ NOT EXECUTED / RS-08 REMAINS GAP / NO PRODUCTION QUALIFICATION.

 
#### 2026-11-25 T57 terminal orphan-INTENT harness execution and hostile correction — AR-69

- **Decision authority:** ADR-001 remains ACCEPTED. When complete authoritative evidence proves the exact attempt boundary was never committed, the operation is terminally aborted. The ReservationStore tombstone is written before the final EffectLedger event. Existing committed boundaries recover the same receipt; incomplete/ambiguous evidence remains quarantined.
- **Test-only files:** `conformance/sqlite-orphan-recovery-adapter.mjs`, `conformance/orphan-intent-recovery-worker.mjs`, `conformance/orphan-intent-recovery.test.mjs`, and `conformance/orphan-intent-terminal-abort.test.mjs`. The SQLite adapter contains an explicit TEST-ONLY boundary warning and is not integrated with `runReview()`.
- **T57.1–T57.9 coverage:** writer exit after durable INTENT ACK and independent reopen; tombstone plus final event; crash after tombstone before Ledger append; stale-fence takeover; incomplete ReservationStore and EffectLedger read quarantine; existing-boundary receipt recovery; repeated reopen and stable watermark; concurrent process race between attempt start and abort; forged tombstone ACK and immutable identity/request conflicts.
- **Observed RED evidence:** hostile executions of T57.8 discovered three defects: (1) the attempt-boundary race query omitted `receipt_json`, so a committed boundary could not be returned as a receipt; (2) repeated `PRAGMA journal_mode=WAL` on already-WAL databases could produce `database is locked` under parallel process startup; (3) boundary existence and permit counts were read in different autocommit snapshots, allowing a concurrent commit to be misclassified as `INTEGRITY_CONFLICT`. The test was not weakened or removed.
- **Corrective changes:** select `identity_json, receipt_json`; set `busy_timeout` before reading journal mode and configure WAL only if not already active; add a read transaction so boundary and permit/effect counts share one snapshot; read ledger events and high-water mark from one snapshot. The terminal ledger append additionally verifies the tombstone from the ReservationStore file and checks its exact INTENT and absence-evidence bindings in the shared test harness.
- **Fresh verification:** Node.js `v22.16.0`; `node --check` passed for all four T57 source files. The complete T57.1–T57.9 command was run three consecutive times: each **9 tests / 9 passed / 0 failed**. T57.8 also passed 10 consecutive focused race probes after the final snapshot correction. Node emitted the expected experimental `node:sqlite` warning; no test failed in the recorded final runs.
- **Exact source blobs executed:** T57.1 test `eb55f2ab523611711d30da96223c0427f59985c6`; SQLite adapter `c1d9a8d578ccecd91c044f39f6f4b73f32376d79`; worker `6ecf70cd46fad12fed95750d6278d3171d072b78`; terminal-abort test `1cdd41754a5800d823e45fccc2d0f2842bf441e6`. These values are Git blob IDs; the local execution copies matched the remote branch blobs byte-for-byte.
- **Hosted CI:** the connector's workflow-run interface exposed no push-run result for the tested commit; combined status returned no checks. Hosted CI is therefore **UNVERIFIED**, not PASS.
- **Evidence boundary:** both stores are local SQLite files on the same runner/filesystem. Hashes are integrity checks rather than signatures or independent authority proofs; fencing is a test generation-CAS model; `beginAttempt` writes a fake permit row and invokes no provider; no machine/power-loss, independent backup/restore, cross-vendor, production rate/quota, or real external-effect test is represented. The suite does not qualify the eventual backend.
- **Traceability update:** RS-08 moves from no direct crash-window test to **PARTIAL / TEST HARNESS ONLY**. It remains a **PRODUCTION QUALIFICATION GAP** pending deployment-shaped ReservationStore/EffectLedger implementations, trusted receipt/evidence verification, cross-store recovery fencing, independent failure-domain recovery, external-effect interlocks, and `runReview()` integration.
- **Known unrelated failure:** deterministic duplicate-publication regression remains RED as previously recorded. It was not modified, skipped, or weakened.
- **Isolation:** changes remain limited to test code and conformance/operations documentation on `verify/9router-reservation-conformance-run9-2026-11-25`; no `main`, PR #463, reviewer runtime, provider dispatch, secret, backend resource, workflow policy, deployment, merge, or local desktop state changed.
- **Disposition:** ADR-001 POLICY ACCEPTED / T57.1–T57.9 GREEN IN SQLITE TEST HARNESS ONLY / RS-08 PRODUCTION GAP OPEN / HOSTED CI UNVERIFIED / NO BACKEND QUALIFIED.


#### 2026-11-25 T57 isolated CI reporting — AR-70

- **Workflow:** `.github/workflows/9router-reservation-conformance.yml` now has a dedicated `if: always()` step that runs `npm run test:orphan-recovery` after the full reviewer regression and reference-oracle steps. This allows T57 to report separately even when the preserved duplicate-publication regression fails.
- **Scope controls:** the workflow remains a verification-only workflow, triggered by push to `verify/9router-reservation-conformance-*` or manual dispatch; workflow permissions remain `contents: read`; no secrets, provider credentials, or reviewer activation were added.
- **Evidence:** workflow source change was committed and fetched from the verification branch. No hosted Actions result for the new isolated step has been retrieved; hosted status remains UNVERIFIED.
- **Isolation:** reviewer workflow `.github/workflows/9router-pr-review.yml` was not edited or enabled; `main`, PR #463, provider/runtime configuration, secrets, cloud resources and local desktop state were not modified.
- **Disposition:** T57 FOCUSED CI STEP WIRED / HOSTED RESULT PENDING / REVIEWER WORKFLOW UNCHANGED.


#### 2026-11-25 Permit-boundary write-ahead and active recovery-fence hardening — AR-71

- **Scope:** hostile review of the test-only RS-08 SQLite adapter found that `beginAttempt` could create a permit without a matching EffectLedger INTENT and could issue a permit while a recovery fence was active.
- **Test-first RED:** tests T57.10 and T57.11 were added at commit `5c456c60b0583eaca056f2572c03ec0be7084594` before changing the adapter. Hosted focused execution observed:
  - T57.10: expected `LEDGER_NOT_ACKNOWLEDGED`, observed `PERMIT`.
  - T57.11: expected `RECOVERY_FENCED`, observed `PERMIT`.
  These were behavioral assertion failures. Existing T57.1–T57.9 tests remained green. The unrelated duplicate-publication regression also remained RED.
- **Minimal correction:** at commit `3ad3aa7bc2f2a9a24fba1117f38596db38e4278e`, `beginAttempt` now reads the durable INTENT and verifies full canonical operation equality before a permit can be considered. Inside the same ReservationStore `BEGIN IMMEDIATE` transaction it checks: (1) terminal tombstone → `ORPHAN_ABORTED`; (2) active recovery fence → `RECOVERY_FENCED`; (3) existing boundary → `ALREADY_CONSUMED`; only then may it create the test boundary/permit rows.
- **Why tombstone takes precedence:** an already-aborted attempt is terminal, not merely temporarily fenced. A live fence without a terminal tombstone blocks a new begin while recovery is in progress. This prevents a late caller from obtaining a permit after recovery has started evaluating the orphan.
- **Hosted verification:** GitHub Actions run [45583104765](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45583104765), exact head `3ad3aa7bc2f2a9a24fba1117f38596db38e4278e`. Focused T57 suite: **11/11 PASS**. Reference-oracle tranche: **56/56 PASS**. Full reviewer regression: **203/204 PASS**, with the only failure being the preserved duplicate-publication race (2 POSTs versus maximum 1 at `review.test.mjs:3587`). No assertion was removed or weakened.
- **Contract reconciliation:** `ADR-001` now explicitly requires begin-time verification of the matching durable INTENT and atomic rejection under an active recovery fence. `ORPHAN_INTENT_RECOVERY_CONTRACT.md` now specifies tombstone-first, then active-fence, then already-consumed precedence; it also requires fail-closed behavior for missing/mismatched INTENT.
- **Traceability:** RS-08 now maps T57.1–T57.11 as **PARTIAL / TEST-HARNESS ONLY**. Production qualification remains open because the harness is not wired into `runReview()`, uses local SQLite files and non-cryptographic digest checks, and does not establish an independent production trust root, provider-effect interlock, or machine/restore durability.
- **Hosted CI distinction:** unlike the AR-69/AR-70 checkpoint, hosted Actions evidence for this exact commit was retrieved. The focused T57 step is GREEN; the enclosing workflow remains failed because the full reviewer regression includes the known duplicate-publication RED.
- **Isolation:** all changes remain on `verify/9router-reservation-conformance-run9-2026-11-25`. No `main`, PR #463, reviewer activation, production adapter, provider dispatch, secret, backend provisioning, cloud resource, deployment, merge, or local desktop state was changed.
- **Disposition:** T57.10–T57.11 RED→GREEN VERIFIED / T57.1–T57.11 HOSTED FOCUSED PASS / FULL REVIEWER REGRESSION 203/204 WITH KNOWN DUPLICATE-PUBLICATION RED / RS-08 PRODUCTION GAP OPEN.


#### 2026-11-25 T57.8 transient recovery-fence interleaving — AR-72

- **Observed issue:** exact-head hosted conformance on the prior docs commit `ea16bbb874b7d75dc0d16fb1ce6019aed95c89a5` failed T57.8 because the racing begin returned `RECOVERY_FENCED` while the test expected `ORPHAN_ABORTED`.
- **Root cause:** after AR-71, `beginAttempt` correctly checks an active recovery fence before any permit. There is a legitimate interleaving where the recovery fence is committed but its terminal tombstone is not yet committed. The begin request is transiently fenced; the tombstone cannot be reported until it actually exists.
- **Test correction:** T57.8 now accepts `RECOVERY_FENCED` or `ORPHAN_ABORTED` for the racing begin in the abort-wins branch, waits for recovery to complete, then performs a separate late-begin probe and requires `ORPHAN_ABORTED`. The final-state invariant remains strict: one tombstone, one terminal Ledger event, zero boundary/permit. The permit-wins branch still requires exact receipt recovery and zero tombstone/event.
- **Scope:** only test expectation and corresponding conformance evidence documentation changed. Production adapter, reference oracle, original duplicate-publication regression, workflow permissions, reviewer workflow, secrets and cloud resources were not changed.
- **Status:** T57.8 EXPECTATION CORRECTED / EXACT-HEAD HOSTED VERIFICATION PENDING / PRIOR AR-71 T57.10–T57.11 11/11 HOSTED PASS REMAINS VALID FOR ITS EXACT COMMIT / RS-08 PRODUCTION GAP OPEN.

#### 2026-11-25 Exact-head T57, full-regression and Gitleaks verification — AR-73

- **Exact branch HEAD:** `f0b6233045bbe1a59b1a64982a03c105ff1722f6`; base `main` `919b19ca3d3887352cdef06b03c668ead04fbce7`; compare showed ahead 214 / behind 0.
- **Conformance run:** [45583936546](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45583936546). Focused T57: **11/11 pass**; reference oracle: **56/56 pass**; complete reviewer regression: **203/204 pass**. Sole failure is unchanged deterministic duplicate-publication race `review.test.mjs:3587`, where two POSTs were observed rather than the allowed maximum of one.
- **T57.8 hostile correction:** the exact-head run passes after the test distinguishes a transient `RECOVERY_FENCED` response (fence committed, tombstone not yet committed) from terminal `ORPHAN_ABORTED`. After recovery completion the explicit late-start probe must observe `ORPHAN_ABORTED`. The final abort invariant remains exactly one tombstone/event and no permit/boundary.
- **Security scan:** [45583936478](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45583936478). The PR change-range scan reported `no leaks found`. The independent full-history scan scanned 5,397 commits and reported 13 `generic-api-key` findings in older commits dated 2026-11-15 through 2026-11-24. These finding commits predate the present change range. The findings remain **UNTRIAGED**; they were not assumed false positives, redacted by allowlist, or otherwise suppressed.
- **Current source identities:** T57 terminal test blob `825d8dda4a568838cec5bb0e6d1e3b5bce2eeb5f`; SQLite harness adapter blob `ffef7d1c57abb78c5f997c2fdad478f7f50053d9`. ADR-001 blob `3a8f444c674e8475bdec24711d013f0fa459c3d4`; recovery contract blob `e05b87bd8f623f0703fd096859cfab48c2a57640`.
- **Isolation rechecked:** reviewer job remains disabled; PR #463 remains Draft/Open/Unmerged on its separate head `59c84265b18fa121350a412902acd769900ceb1c`; no main, reviewer runtime, provider, secret, cloud resource, deployment, merge, or local desktop changes.
- **Disposition:** T57.1–T57.11 HOSTED FOCUSED PASS / FULL REGRESSION 203/204 WITH KNOWN DUPLICATE-PUBLICATION RED / PR DIFF SECRET SCAN CLEAN / 13 HISTORICAL GITLEAKS FINDINGS UNTRIAGED / RS-08 PRODUCTION GAP OPEN.