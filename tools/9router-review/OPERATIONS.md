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
