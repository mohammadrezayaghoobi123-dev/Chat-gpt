# 9Router Default-Branch Bootstrap Design

**Status:** Proposed design; approval required before implementation  
**Date:** 2026-11-24  
**Scope:** Finding 67 / DCP-01V  
**Target repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`

## Intent

Establish a safe, verifiable path for registering the 9Router PR-review workflow on the repository default branch without executing untrusted pull-request code in a privileged job, relying on `pull_request_target`, or treating an artifact as authoritative evidence.

The immediate objective is **bootstrap and prove event reachability only**. The first default-branch deployment must not call 9Router, access its secrets, write PR comments, merge code, or deploy anything. Model inference and publication remain separately gated until the event path, cost controls, and durable dispatch semantics have been independently accepted.

## Current-state evidence

Repository metadata identifies `main` as the default branch, repository ID `1398846697`, visibility `public`, and current main SHA `919b19ca3d3887352cdef06b03c668ead04fbce7`.

A direct GitHub API listing of `.github/workflows` at `main` returned exactly four files:

- `cloud-agent-ci.yml`
- `connector-ci.yml`
- `secret-history-scan.yml`
- `static.yml`

Neither `.github/workflows/9router-pr-review.yml` nor `.github/workflows/9router-pr-review-signal.yml` exists on `main`. The `tools/` directory is also absent from `main`.

The two 9Router workflows and their supporting code exist on feature base `813d4b6556e58aa9d8fd5fdfcfb87bc2df908a68`. The current design uses a `pull_request_target` signal workflow followed by a privileged `workflow_run` consumer. This is branch-local source evidence only; it does not register either workflow in the current default branch.

GitHub documents that a `workflow_run` consumer is triggered only when its workflow file exists on the default branch. GitHub also documents that `pull_request_target` executes the default-branch workflow definition and carries a privileged-token/secrets boundary. The target repository is public. GitHub's published change notice says the default policy for affected public repositories will block `pull_request_target` from 2026-12-02 unless an applicable Actions event policy already exists. The exact effective Actions policy for this repository is **UNKNOWN**: the connected GitHub read integration did not expose the required Actions policy endpoints. The main-branch ruleset is not evidence of an Actions event allowlist.

### Existing source implementation to preserve

The current feature implementation contains:

- `tools/9router-review/review.js`: immutable base/head review, live PR revalidation, bounded request handling, report sanitation, marker reconciliation, and comment publication.
- `tools/9router-review/run-review.mjs`: environment-to-review entrypoint.
- `tools/9router-review/package.json` and `package-lock.json`: private Node package, Node `>=22`, pinned `marked@17.0.1`.
- `tools/9router-review/review.test.mjs`: reviewer regression suite.
- `tools/9router-review/resolve-signal.mjs`, `signal-receipt.js`, and `signal-receipt.test.mjs`: the current artifact/receipt-based signal design.

PR #431 adds `redirect: "error"` to the 9Router Fetch POST and real local HTTP tests for 307/308 responses. Its implementation/test blobs are the required source for the bootstrap candidate; do not silently copy the pre-fix versions from the older feature base.

The present artifact-based design has good structural controls (run/attempt binding, strict receipt schema, digest mismatch failure, no PR checkout in the privileged jobs, and live PR SHA checks). It nevertheless requires a `pull_request_target` signal and a transport artifact. Its hosted event chain has not been exercised from the current default branch.

## Goals

1. Register the source signal and trusted consumer in the default branch through a separate, reviewable bootstrap PR.
2. Avoid `pull_request_target` entirely in the replacement design.
3. Use an ordinary unprivileged `pull_request` run only as a trigger signal; it must have no secrets, no repository write permission, no checkout, no artifact upload, and no PR-code execution.
4. Execute the resolver only from the trusted default-branch `workflow_run` workflow.
5. Determine the causal PR from GitHub's commit-to-associated-pull-requests API and independently re-fetch the live PR.
6. Fail closed for missing, ambiguous, stale, forked, malformed, or conflicting identity evidence.
7. Bootstrap with the final reviewer job statically disabled, so a successful canary proves event resolution without provider inference or publication.
8. Preserve current source review safeguards, including the PR #431 redirect-rejection fix.
9. Keep all changes isolated from current PRs #324 and #431, from other workstreams, and from production infrastructure.

## Non-goals and anti-goals

- No change to `main`, Actions settings/policies, rulesets, branch protection, repository permissions, Secrets, variables, Cloudflare, deployment, or local-machine configuration in this design step.
- No live 9Router inference, provider dispatch, billing event, PR comment, auto-merge, or production operation during bootstrap/canary.
- No fork-PR support in the first version. The resolver accepts same-repository PRs only.
- No claim of exactly-once model execution, exactly-once comment publication, or complete delivery of every PR update.
- No use of an artifact, PR comment, branch name, or caller-supplied JSON as the authority for causal PR identity.
- No broad Gitleaks workflow change in the bootstrap. PR #324's all-fetched-ref findings remain unresolved; PR #431's candidate-ancestry scan is a separate change and does not constitute global secret-history clearance.
- No copying of the 232 KB historical `tools/9router-review/README.md` into `main` merely to satisfy runtime dependencies. Historical audit notes stay in the documentation PR. A concise operations note may be added separately if needed.

## Approaches considered

### A. Retain `pull_request_target → workflow_run` plus an event-bound artifact

**Advantages:** the event payload directly supplies PR head/base snapshot fields; the existing receipt schema binds repository, run ID, attempt, event, action, PR number, head/base SHA, workflow SHA, and repo identities. The resolver already rejects malformed receipts and re-fetches the live PR.

**Costs and residual risk:** this requires the public-repository `pull_request_target` event policy to be effective and available; that policy is currently UNKNOWN and a GitHub policy change is scheduled for 2026-12-02. It also retains artifact lifecycle/digest/retention complexity and a second trust object to validate. The default-branch registration gap remains.

**Disposition:** technically defensible, but not the preferred bootstrap path for this public repository.

### B. Unprivileged `pull_request` signal plus trusted `workflow_run` resolver using commit-to-PR association

**Advantages:** removes `pull_request_target`, its public-repository policy dependency, and the receipt artifact. The source signal has an empty permission set and does not check out or execute PR code. The privileged consumer runs from the default branch and never checks out PR code or consumes source-run artifacts. It binds the workflow run's head SHA to the PR returned by GitHub's `GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls` endpoint, then re-fetches the live PR.

**Costs and residual risk:** the commit association may be empty or ambiguous; this must fail closed. A commit may be associated with multiple PRs; those events must not be guessed or ranked. The run's head SHA semantics must be proven by an actual post-bootstrap canary. Fork PRs remain unsupported. It does not solve cross-run model-dispatch uniqueness or the final PR-comment TOCTOU window.

**Disposition:** **Recommended.** It uses a normal PR event with no privileged token and moves all trust decisions to a default-branch workflow backed by authoritative GitHub API reads.

### C. Manual `workflow_dispatch` with operator-supplied PR number and expected SHAs

**Advantages:** removes automatic event chaining and reduces background trigger paths.

**Costs:** requires manual operation for every review, and operator-supplied values still need full API reconciliation. It does not satisfy the intended automatic review flow.

**Disposition:** keep as a possible emergency/manual recovery path, not the primary architecture.

## Recommended architecture

Use a two-workflow chain:

`pull_request` (unprivileged signal) → `workflow_run` (trusted default-branch resolver) → **review job disabled during bootstrap**

### 1. Signal workflow

Path: `.github/workflows/9router-pr-review-signal.yml`

- Trigger on the required `pull_request` actions: `opened`, `synchronize`, `reopened`, `ready_for_review`, and `edited`.
- Declare workflow-level and job-level `permissions: {}`.
- No `actions/checkout`, no package installation, no third-party Action, no secrets, no artifact upload/download, no cache, no environment protection bypass, and no write operation.
- Its sole job performs a bounded no-op marker and exits. The signal workflow is not a source of PR data or a trust anchor.
- Because an ordinary `pull_request` workflow can be modified by the PR being tested, treat its YAML and runner as untrusted. Its zero-permission/no-secret contract is mandatory. The downstream workflow must not run its code, download its artifacts, or trust values emitted by it.

### 2. Trusted workflow-run consumer

Path: `.github/workflows/9router-pr-review.yml`

- Trigger only on completion of the exact signal workflow name.
- In the resolver job, require: `workflow_run.event == "pull_request"`, successful conclusion, exact workflow path, correct workflow identity, target repository ID/name, same-repository head repository ID/name, positive run ID/attempt, and a valid 40-character head SHA.
- Query the authoritative Actions run endpoint by run ID and independently verify its repository, run ID, attempt, event, conclusion, workflow ID/path, head repository, and head SHA.
- Resolve the expected source workflow identity through GitHub's Actions workflow API and require its exact configured path and active state; do not use a display name alone as identity.
- Query `GET /repos/{owner}/{repo}/commits/{head_sha}/pulls?per_page=100`. Follow pagination to completion under a finite page/response budget. If pagination cannot be completed within the budget, identity is **UNKNOWN** and resolution stops.
- Require exactly one associated PR. Zero matches, multiple matches, wrong repository IDs, wrong head SHA, malformed records, or any disagreement are hard failures. Never choose the first result.
- Treat `workflow_run.pull_requests` only as an optional consistency cross-check. It is not the sole source of PR identity because observed run API records can contain an empty array. If non-empty, it must identify exactly the same PR and head SHA as the commit-association result; disagreement fails closed.
- Fetch the selected PR directly from the Pull Requests API. Require the selected number, open state, non-draft state, same-repository head and base, and exact head SHA equal to the workflow-run head SHA. Read the current base SHA and base ref from this live PR response and bind them into the review snapshot.
- Emit only validated PR number, head SHA, base SHA, and base ref as job outputs. No receipt artifact is required.
- Use only `actions: read`, `contents: read`, and `pull-requests: read` in this job. Checkout only the default branch, pinned to the event's repository default branch, with `persist-credentials: false`.
- Never checkout the PR head, evaluate PR scripts, execute files from the source run, or consume source-run artifacts.

### 3. Disabled reviewer gate during bootstrap

- Include a downstream reviewer job only as a staged placeholder, with a literal job-level `if: false` in the bootstrap version.
- Do not add 9Router secrets, marker secrets, model variables, or `pull-requests: write` to the bootstrap review job.
- The disabled job must not make a network call to 9Router or GitHub's comment endpoint.
- After the resolver canary passes, any decision to enable inference and publication requires a separate approval and a separate implementation step. It must first reconcile the unresolved durable-dispatch-ledger / cross-run replay issue.

### 4. Reviewer snapshot handoff

The resolver produces the exact values consumed by `run-review.mjs`:

- `PULL_REQUEST_NUMBER`
- `EXPECTED_HEAD_SHA`
- `EXPECTED_BASE_SHA`
- `REPOSITORY`

The existing reviewer must continue to validate the exact head/base pair before inference, after model response, and immediately before publication. The reviewer must keep the PR #431 Fetch `redirect: "error"` behavior and 307/308 regression tests.

A changed base with an unchanged head is resolved against the current live base at resolver time. This is a deliberate **latest-base-at-resolution** policy, not a claim that the base SHA was captured in the source-run event. The head SHA remains bound to the completed source run. The reviewer rejects any subsequent head or base change during its own execution.

## Exact bootstrap file set

The eventual bootstrap PR must target `main` from a new isolated branch whose base is exactly the freshly revalidated main SHA. It must not retarget or reuse PR #324 or PR #431.

Create:

- `.github/workflows/9router-pr-review-signal.yml` — unprivileged no-op `pull_request` signal.
- `.github/workflows/9router-pr-review.yml` — trusted `workflow_run` resolver, read-only resolver permissions, contract tests, and statically disabled reviewer job.
- `tools/9router-review/package.json`
- `tools/9router-review/package-lock.json`
- `tools/9router-review/resolve-signal.mjs`
- `tools/9router-review/workflow-run-pr.js` — strict run/commit/PR association and live-PR resolver functions.
- `tools/9router-review/workflow-run-pr.test.mjs`
- `tools/9router-review/review.js` — from PR #431 candidate, including redirect rejection.
- `tools/9router-review/review.test.mjs` — from PR #431 candidate, including 307/308 regression tests.
- `tools/9router-review/run-review.mjs`
- `tools/9router-review/OPERATIONS.md` — short runtime and trust-boundary guide.

Do not copy `signal-receipt.js` or `signal-receipt.test.mjs` into this no-artifact design. Do not copy the large historical README or the Gitleaks workflow from PR #431. Preserve their evidence in the documentation PRs.

## Resolver contract

Define a typed conceptual result:

```ts
type ResolvedPullRequest = {
  repository: string;
  pullRequest: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
};

type Resolution =
  | { status: "RESOLVED"; target: ResolvedPullRequest }
  | { status: "REJECTED"; reasonCode: string }
  | { status: "UNKNOWN"; reasonCode: string };
```

Production caller behavior is fail-closed for both `REJECTED` and `UNKNOWN`: no inference, no comment, no automatic retry. A later, independent event may cause a fresh resolution. Do not persist a guessed PR number or select the first matching PR.

Required identity tuple:

`repository_id + workflow_id + workflow_path + run_id + run_attempt + run_event + run_conclusion + head_repository_id + head_sha + associated_pr_number + associated_pr_head_sha + live_pr_state + live_pr_head_sha + live_pr_base_sha + live_pr_base_ref`

Required invariant:

`resolved_head_sha == workflow_run.head_sha == associated_pr.head.sha == live_pr.head.sha`

and both PR head/base repositories must match the target repository ID and full name.

## Atomic adversarial test matrix

### Workflow and provenance

- Reject wrong event, source workflow name/path/ID, run ID, attempt, conclusion, repository ID/name, head repository ID/name, malformed SHA, and inactive workflow identity.
- Reject fork head repository even if the workflow-run repository is the target repository.
- Reject a zero-result commit-to-PR association.
- Reject multiple associated PRs; no first-match or branch-name fallback.
- Reject pagination overflow, missing/malformed pagination metadata, incomplete API results, malformed JSON, and API authorization/rate-limit/server errors.
- If optional `workflow_run.pull_requests` is non-empty, reject a missing, multiple, or conflicting PR/head association. If empty, proceed only from the independently resolved commit association and live PR API.

### Live PR and state

- Reject closed, draft, wrong-number, wrong-head, wrong-repository, wrong-base-repository, or invalid-base-ref PR records.
- Reject when associated PR head SHA differs from the source run head SHA.
- Verify current base SHA is bound into resolver outputs.
- Mutate the fake live PR between resolver and reviewer calls and prove the reviewer stops before inference or publication.

### Privileged boundary and negative controls

- Parse workflow YAML and assert signal workflow has empty permissions and no checkout, secrets, artifacts, external actions, package installation, or write API call.
- Assert trusted workflow checks out only default-branch code with `persist-credentials: false`.
- Assert resolver permissions contain only `actions: read`, `contents: read`, and `pull-requests: read`.
- Assert resolver does not download or consume source-run artifacts and does not execute any PR-derived file.
- Assert the bootstrap reviewer job is statically disabled and does not define router secrets or `pull-requests: write`.
- Assert a successful resolver canary yields no 9Router Fetch calls and no issue-comment POST.
- Exercise duplicate workflow-run delivery and concurrent resolution. Record the result; do not infer cross-run at-most-once behavior from a per-PR concurrency group.
- Retain RED/GREEN regression evidence for HTTP 307 and 308 rejection.

## Rollout and acceptance gates

### Gate 0 — design approval

Approve this design and the exact file set before any implementation. No main changes occur in this design stage.

### Gate 1 — isolated bootstrap PR

- Create a new branch directly from the freshly fetched `main` SHA.
- Add only the file set above.
- Keep all PRs Draft until independent static review and hosted contract tests have completed.
- Run tests with no 9Router secrets and no provider access.
- Keep the reviewer job statically disabled.

### Gate 2 — default-branch registration

- A separate PR review/merge process is required to place both workflow files and the resolver runtime into `main`.
- The merge itself is not part of this design approval and is not authorized here.
- Re-fetch `main` after merge and verify exact workflow paths, trusted code, and workflow IDs.

### Gate 3 — hosted canary, no inference

- Open or use a same-repository canary PR with no sensitive payload.
- Observe the ordinary `pull_request` signal run complete.
- Observe the trusted default-branch `workflow_run` consumer execute.
- Verify authoritative run metadata, workflow identity, commit-associated PR result, and live PR reconciliation.
- Verify the reviewer job is skipped by the literal disabled gate.
- Verify zero 9Router requests, zero provider dispatches, zero comment writes, and zero secret reads.
- If any identity or job boundary differs, classify the result as **FAIL** or **UNKNOWN** and do not activate the reviewer.

### Gate 4 — separate activation decision

Do not enable the reviewer job until a separate review closes or explicitly accepts:

1. durable cross-run dispatch reservation and ambiguous-outcome recovery;
2. explicit per-PR and aggregate inference/API budgets;
3. duplicate/replay and concurrency behavior;
4. provider/billing retry semantics and the limits of exactly-once claims;
5. GitHub Actions policy and permissions required for the eventual writer job;
6. a fresh hosted red/green run against the exact candidate SHA.

## Failure semantics and stop conditions

- No associated PR, multiple PRs, stale head, fork, closed/draft PR, invalid workflow identity, API error, pagination uncertainty, or conflicting metadata → **REJECTED/UNKNOWN**, never fallback.
- Missing required code, lockfile, test, or workflow path in the default branch → **BLOCKED**.
- Resolver failure → reviewer job skipped.
- Reviewer job disabled → no router call, no provider attempt, no PR comment.
- Ambiguous future model or comment request outcome → **UNKNOWN**; do not blind-retry.
- A PR comment marker is a reconciliation hint, not a transactional uniqueness constraint.
- A per-PR concurrency group serializes jobs but is not a durable cross-run idempotency ledger.
- A successful canary proves only the observed hosted event-resolution path for that exact run and SHA; it does not prove all event actions, all repositories, fork support, delivery completeness, or model exactly-once semantics.

## Rollback

If the canary fails, leave the reviewer job disabled. Do not add secrets or change repository settings to bypass the failure. Revert only the bootstrap through a separately reviewed revert PR if the new default-branch files themselves create an unacceptable risk. Preserve failed-run metadata and the exact candidate SHAs for diagnosis.

## Decision

**Recommended:** Approach B — unprivileged `pull_request` signal, trusted default-branch `workflow_run` resolver, GitHub commit-to-PR association, and live PR reconciliation, with the reviewer job statically disabled through bootstrap and canary.

**Current readiness:** design proposed; implementation not authorized; hosted end-to-end proof not run.

**Safety boundary:** this document adds no code, workflow, branch, permission, secret, repository setting, merge, deployment, production, Cloudflare, or local-host change.
