# 9Router ABC Provenance Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the untrusted `workflow_run.pull_requests` PR-selection mechanism with an event-bound signal receipt, independent GitHub API reconciliation, and fail-closed handling.

**Architecture:** The trusted `pull_request_target` signal workflow emits a small JSON receipt derived only from its event payload and uploads it as a run- and attempt-specific artifact. The privileged `workflow_run` workflow first reads the authoritative run attempt from the workflow-runs API, downloads only the artifact belonging to that exact run and attempt, validates its source metadata and receipt, and independently re-fetches the workflow run and PR through GitHub's API. A separate resolver job exposes the verified PR number as a job output so the reviewer job can retain per-PR concurrency without using the ambiguous `workflow_run.pull_requests` array.

**Tech Stack:** GitHub Actions, Node.js 22, native Node.js APIs, existing Node test runner, pinned official GitHub Actions.

## Global Constraints

- Work only on `feature/9router-abc-provenance`, based on the reviewed PR #261 head `d28641c374615c56d85d07ddb8f487ff3f4798f1`.
- Never modify `main`, Production, repository settings, rulesets, branch protection, Actions policy, or repository secrets.
- Never invoke a live 9Router request or publish a PR review comment during tests.
- Never execute, source, or load code from the downloaded artifact. Treat it as untrusted data and parse only a bounded JSON document.
- Do not use `workflow_run.pull_requests` to select a PR, derive a concurrency key, or establish provenance.
- The signal workflow must remain on `pull_request_target`, with no checkout, no PR-code execution, no secrets, no external network requests, and no permissions beyond the minimum required for artifact upload. The artifact upload itself uses GitHub's artifact service.
- The privileged reviewer must check out only the trusted default branch and must not execute PR content.
- Missing, malformed, oversized, stale, mismatched, duplicate, or ambiguous signal data must stop before model inference and before comment publication.
- Preserve existing SHA revalidation, HMAC report-marker behavior, append-only publication, bounded API reads, and timeout limits.
- All code, identifiers, comments, documentation, workflow names, logs, and commit messages must be English.
- Use immutable full commit SHAs for third-party actions. Verified official release refs: `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9` (v7.0.2) and `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333` (v8.0.2).
- Artifact retention is one day; no external registry, paid service, or additional infrastructure is introduced.

---

### Task 1: Produce a run-bound signal receipt

**Files:**
- Modify: `.github/workflows/9router-pr-review-signal.yml`
- Modify: `tools/9router-review/review.test.mjs`

**Interfaces:**
- Signal receipt schema version 1:
  - `schemaVersion`: integer `1`
  - `repository`: `github.repository`
  - `repositoryId`: numeric `github.repository_id`
  - `runId`: numeric `github.run_id`
  - `runAttempt`: numeric `github.run_attempt`
  - `eventName`: literal `pull_request_target`
  - `action`: `github.event.action`
  - `pullRequestNumber`: `github.event.pull_request.number`
  - `headSha`, `baseSha`: event PR snapshot SHAs
  - `headRepository`, `baseRepository`: event PR snapshot repository full names
  - `baseRef`: event PR snapshot base ref
- Artifact name: `9router-pr-signal-<run_id>-<run_attempt>`.
- Artifact file: `signal.json`.

- [ ] **Step 1: Add the failing workflow contract test**

Assert the signal workflow serializes the PR number, head/base SHA, repository identities, run ID, run attempt, action, and base ref from the trusted `github.event.pull_request` context; uploads the exact run-specific artifact; uses the pinned upload action; has one-day retention; and contains no checkout, secrets, PR-code execution, or network calls.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: the new receipt-contract assertion fails because the current signal workflow only emits a fixed echo and uploads no artifact.

- [ ] **Step 3: Implement the minimum signal workflow behavior**

Use a Node.js inline script and environment variables populated from GitHub event fields to write exactly one JSON file under `$RUNNER_TEMP`. Validate no user-controlled value is interpolated into shell source. Upload only that file using the pinned upload-artifact SHA, exact run/attempt name, `if-no-files-found: error`, and `retention-days: 1`. Keep workflow/job permissions empty unless GitHub's artifact runtime requires a narrowly documented permission.

- [ ] **Step 4: Verify the focused pass**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: the receipt workflow contract passes, including the no-checkout/no-secret/no-PR-code assertions.

- [ ] **Step 5: Run the affected integration check**

Run: `git diff --check` and the full contract suite.

Expected: no whitespace errors and all existing plus new tests pass.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add .github/workflows/9router-pr-review-signal.yml tools/9router-review/review.test.mjs
git commit -m "feat: emit run-bound 9router signal receipt"
```

### Task 2: Validate the receipt and independently reconcile GitHub state

**Files:**
- Create: `tools/9router-review/signal-receipt.js`
- Modify: `tools/9router-review/review.test.mjs`

**Interfaces:**
- `resolveWorkflowRunTarget({ eventName, workflowPath, triggerEvent, workflowConclusion, repository, repositoryId, headRepository, runId, runAttempt, runHeadSha, signalReceipt })` returns `{ pullRequest, expectedHeadSha, expectedBaseSha, baseRef }`.
- `verifySignalTargetWithGitHub({ target, repository, repositoryId, runId, runAttempt, runHeadSha, workflowId, githubToken, fetchImpl, githubApiBase })` resolves only after independent workflow-run and PR API checks succeed.
- The receipt is input data only; no field from it is trusted until all schema, identity, run, and snapshot checks pass.

- [ ] **Step 1: Add focused failing tests**

Add tests for:
  - valid receipt and matching trusted event metadata;
  - missing receipt, malformed JSON at the caller boundary, wrong schema version, wrong repository name/ID, wrong run ID, wrong attempt, wrong event, wrong action, invalid PR number, invalid SHA, and missing repository identities;
  - run metadata API mismatch for run ID, attempt, event, workflow path, conclusion, workflow ID, repository identity, and run SHA;
  - PR API mismatch for PR number, closed state, draft state, head SHA, base SHA, base ref, head repository, and base repository;
  - API 401/403/404/429/5xx, invalid JSON, and network failure;
  - no call to model inference or comment publication when any validation fails.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: tests fail because the receipt resolver and independent API verifier do not exist.

- [ ] **Step 3: Implement bounded, fail-closed validation**

Implement a strict allowlisted schema. Reject unknown schema versions and any mismatch between the artifact and `workflow_run` event metadata. Fetch `GET /repos/{owner}/{repo}/actions/runs/{run_id}` and `GET /repos/{owner}/{repo}/pulls/{pull_number}` using the read-only token. Verify run ID/attempt, event, workflow path, conclusion, workflow ID, repository identity, and run SHA; verify PR number, open/non-draft state, head/base SHA, base ref, and both repository identities. Do not inspect or consume the API's `pull_requests` array. Bound receipt file size to 16 KiB and reject duplicate JSON keys if the selected parser can detect them; otherwise document the parser limitation and use a strict schema with exact required keys and primitive types.

- [ ] **Step 4: Verify the focused pass**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: all receipt validation and API-reconciliation cases pass; each negative case stops before model/comment boundaries.

- [ ] **Step 5: Run the affected integration check**

Run: `node --test tools/9router-review/review.test.mjs` and `git diff --check`.

Expected: complete contract suite passes and no whitespace errors are present.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add tools/9router-review/signal-receipt.js tools/9router-review/review.test.mjs
git commit -m "feat: verify 9router signal receipt provenance"
```

### Task 3: Wire the privileged workflow through resolver and reviewer jobs

**Files:**
- Modify: `.github/workflows/9router-pr-review.yml`
- Modify: `tools/9router-review/run-review.mjs`
- Modify: `tools/9router-review/review.test.mjs`

**Interfaces:**
- Job `resolve-signal` outputs only validated `pull_request`, `head_sha`, `base_sha`, and `base_ref`.
- Job `review` uses `needs.resolve-signal.outputs.pull_request` for its per-PR concurrency group.
- Artifact download path is under `$RUNNER_TEMP`, never the checked-out workspace.
- The reviewer receives verified target values through environment variables and still revalidates the live PR at every existing review boundary.

- [ ] **Step 1: Add failing workflow and entry-point tests**

Assert the privileged workflow:
  - accepts only the exact signal workflow path, `pull_request_target` event, successful conclusion, and same-repository run before artifact download;
  - reads the run attempt from the authoritative workflow-runs API, then downloads only the artifact named for that exact run ID and API-derived attempt using the pinned download action;
  - grants the resolver job only `actions: read`, `contents: read`, and `pull-requests: read`;
  - checks out only the default branch with persisted credentials disabled;
  - derives per-PR concurrency only from the verified resolver job output;
  - does not reference `workflow_run.pull_requests` anywhere;
  - scopes router credentials and the marker key only to the existing configuration and final report steps;
  - preserves no-merge, no-deploy, report-only behavior.

- [ ] **Step 2: Verify the relevant failure**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: the new workflow contract fails because the current workflow derives target identity and concurrency from `workflow_run.pull_requests[0]`.

- [ ] **Step 3: Implement the two-job privileged chain**

Add a read-only `resolve-signal` job that checks source workflow metadata, queries the workflow-runs API for the authoritative `run_attempt`, checks out only the trusted default branch, downloads the exact run/attempt artifact to `$RUNNER_TEMP`, and invokes the receipt/API verifier. Do not rely on `workflow_run.run_attempt` from the event payload for artifact naming. Expose only validated outputs. Make the privileged `review` job depend on it and use the validated PR number in the concurrency group. Keep existing credential gating and final reviewer step boundaries. Update `run-review.mjs` to consume only verified outputs and remove parsing of `PULL_REQUESTS_JSON`.

- [ ] **Step 4: Verify the focused pass**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: workflow contract and entry-point tests pass; no reference to `workflow_run.pull_requests` remains in either workflow or runtime source.

- [ ] **Step 5: Run the affected integration check**

Run: `npm ci --ignore-scripts --prefix tools/9router-review && npm audit signatures --prefix tools/9router-review && node --test tools/9router-review/review.test.mjs`

Expected: dependency signatures verify and the full contract suite passes with zero failures, cancellations, or skips.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add .github/workflows/9router-pr-review.yml tools/9router-review/run-review.mjs tools/9router-review/review.test.mjs
git commit -m "feat: gate 9router review on verified signal receipt"
```

### Task 4: Document trust boundaries and hostile-test evidence

**Files:**
- Modify: `tools/9router-review/README.md`

**Interfaces:**
- Record Finding 35 as a provenance defect in the old resolver.
- Distinguish source-level tests from hosted `workflow_run` end-to-end evidence.
- Record exact test/CI run IDs and final branch SHA only after those results exist.

- [ ] **Step 1: Add documentation assertions if existing README tests cover findings**

If the contract suite contains README structure assertions, add the Finding 35 headings and required disposition assertion first; otherwise keep this task documentation-only after implementation verification.

- [ ] **Step 2: Verify documentation assertion behavior**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: any new README assertion fails before the finding is documented.

- [ ] **Step 3: Document the implemented ABC controls and residual UNKNOWNs**

Record the exact artifact schema, run/attempt binding, API reconciliation, fail-closed cases, action commit SHAs, and remaining limitations. Explicitly state that a branch-only workflow cannot prove hosted activation while the workflow files are absent from `main`; do not claim a live 9Router or privileged E2E run.

- [ ] **Step 4: Verify the focused pass**

Run: `node --test tools/9router-review/review.test.mjs`

Expected: all documentation and contract assertions pass.

- [ ] **Step 5: Run the affected integration check**

Run the full dependency-signature and contract-test command from Task 3.

Expected: all checks pass on the exact documentation commit.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add tools/9router-review/README.md
git commit -m "docs: record 9router abc provenance controls"
```

## Unresolved external verification

- Whether the repository's public-repository Actions event policy permits `pull_request_target` remains UNKNOWN until checked in repository Actions settings; no settings are changed here.
- Whether the signal-to-review chain activates on GitHub-hosted runners remains UNKNOWN until the workflow files are present on the default branch through a separately approved merge.
- Whether the live `workflow_run.head_sha` equals the receipt's PR base SHA for all supported base-branch configurations must be confirmed by a hosted, non-privileged signal run before enabling the privileged reviewer. The implementation fails closed on mismatch. The implementation fails closed on mismatch.
- Artifact retention, availability, and cross-workflow download behavior are tested statically and through mocked API contracts here; a real hosted artifact round trip remains UNKNOWN until an authorized default-branch run exists.
- No merge, deployment, secret change, or repository-policy change is authorized by this plan.


## Execution record — 2026-11-22

**Implemented on** `feature/9router-abc-provenance` (no changes to `main` or Production).

- A: The signal workflow emits the fixed-schema receipt and uploads a run/attempt-specific artifact using the pinned upload-artifact action.
- B: The resolver obtains `run_attempt` from the read-only workflow-runs API before artifact download, then independently verifies the run and live PR through GitHub API reads. It does not use `workflow_run.pull_requests`.
- C: Resolver failure prevents the dependent reviewer job from starting. Artifact data is bounded, parsed only as JSON, and never executed.
- Per-PR concurrency is derived from the validated resolver output.
- The old `resolveWorkflowRunTarget` implementation in `review.js` was removed; `run-review.mjs` now consumes only the validated outputs.
- GitHub contract run `45053100603`: **47/47 passed**, zero failures/cancellations/skips.
- Gitleaks run `45053100500`: **3,949 commits**, approximately **12.37 MB**, no leaks found.
- The contract workflow run was a branch Push: `resolve-signal` and `review` were skipped by their event guards. No live artifact round trip, privileged `workflow_run` execution, or 9Router call has been demonstrated.
- The formal failing-test (RED) phase was not captured as a separate hosted run before implementation. Negative regression cases are present and pass, but a complete recorded RED/GREEN cycle must not be claimed.
- `git diff --check` was not independently run in a full local checkout; this remains unverified.

**Current code checkpoint:** `af7f529477cde0d8ce6f20ce17fc4ef7fbb11def`. Documentation is updated in the subsequent branch commit.
