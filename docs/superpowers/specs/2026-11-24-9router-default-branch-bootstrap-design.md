# 9Router Default-Branch Bootstrap Design

**Status:** Revision 1.1 — hostile review incorporated; approval required before implementation  
**Date:** 2026-11-24  
**Scope:** Finding 67 / DCP-01V  
**Target repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`

> **Supersession notice (DCP-01V.1):** The previous recommendation to use an unprivileged `pull_request` signal followed by `workflow_run` is withdrawn. Do not implement the former Approach B, its signal workflow, or its commit-to-PR resolver as written. The reason and replacement architecture are recorded in the final section. The current preferred automatic path is a single trusted default-branch `pull_request_target` workflow, conditional on Actions event-policy verification; the safe fallback is a trusted default-branch manual trigger. No implementation or policy change is authorized by this document.

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

### B. Unprivileged `pull_request` signal plus trusted `workflow_run` resolver using commit-to-PR association — REJECTED

**Advantages:** avoids the `pull_request_target` event policy and makes the later `workflow_run` consumer execute trusted default-branch code. A tested workflow-run sample exposed a PR head SHA that matched one commit-to-PR API result.

**Critical defect:** GitHub documents that a `pull_request` workflow runs the workflow file from the PR merge commit. The PR author can therefore modify the signal workflow itself. The proposed `permissions: {}` and “no secrets” declarations are properties of the reviewed baseline YAML, not a security boundary against a PR that changes that YAML. GitHub's fork restrictions (read-only token and no secrets) specifically protect fork-originated PRs; this design rejects forks and accepts same-repository PRs. The same-repository source-workflow path is therefore not protected by those fork restrictions. If repository- or organization-scoped 9Router credentials are available to same-repository `pull_request` runs, a modified signal workflow could explicitly reference and exfiltrate them. The exact scope of `NINE_ROUTER_API_URL`, `NINE_ROUTER_API_KEY`, and the marker secrets has not been verified. The existing reviewer workflow references these secret names without an explicit `environment:` declaration; this is a material unresolved boundary, not evidence that the values were read.

**Additional semantic limitation:** GitHub documents the commit-to-PR endpoint as returning the merged PR that introduced a commit when the commit is present on the default branch; otherwise it returns merged and open PRs associated with that commit. It is not a universal enumeration API for every open PR that happens to use a commit already present on `main`. The exact-one rule is fail-closed and therefore prevents unsafe selection, but can create false-negative resolution for duplicate/reused commits. The endpoint's documented semantics are not equivalent to an authoritative event-to-PR identity primitive.

**Disposition:** **REJECTED for this same-repository-only privileged-review design.** Do not chain a PR-controlled `pull_request` workflow into a secret-bearing reviewer. The one positive API sample and two negative controls remain useful API observations, but do not repair the workflow-code trust defect.

### C. Manual `workflow_dispatch` with operator-supplied PR number and expected SHAs

**Advantages:** removes automatic event chaining and reduces background trigger paths.

**Costs:** requires manual operation for every review, and operator-supplied values still need full API reconciliation. It does not satisfy the intended automatic review flow.

**Disposition:** keep as a possible emergency/manual recovery path, not the primary architecture.

## Former recommended architecture — withdrawn by DCP-01V.1

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

## Superseded bootstrap file set — do not implement

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

## Superseded commit-association resolver contract — retained for audit only

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

## Superseded test matrix — retained as input to the corrected matrix

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

## Superseded rollout gates — replaced by DCP-01V.1

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

## Superseded failure semantics — replaced by DCP-01V.1

- No associated PR, multiple PRs, stale head, fork, closed/draft PR, invalid workflow identity, API error, pagination uncertainty, or conflicting metadata → **REJECTED/UNKNOWN**, never fallback.
- Missing required code, lockfile, test, or workflow path in the default branch → **BLOCKED**.
- Resolver failure → reviewer job skipped.
- Reviewer job disabled → no router call, no provider attempt, no PR comment.
- Ambiguous future model or comment request outcome → **UNKNOWN**; do not blind-retry.
- A PR comment marker is a reconciliation hint, not a transactional uniqueness constraint.
- A per-PR concurrency group serializes jobs but is not a durable cross-run idempotency ledger.
- A successful canary proves only the observed hosted event-resolution path for that exact run and SHA; it does not prove all event actions, all repositories, fork support, delivery completeness, or model exactly-once semantics.

## Superseded rollback — replaced by DCP-01V.1

If the canary fails, leave the reviewer job disabled. Do not add secrets or change repository settings to bypass the failure. Revert only the bootstrap through a separately reviewed revert PR if the new default-branch files themselves create an unacceptable risk. Preserve failed-run metadata and the exact candidate SHAs for diagnosis.

## Previous decision — withdrawn

Approach B is rejected by DCP-01V.1. The previous file set, resolver and rollout steps are not implementation authority.

**Safety boundary:** this document adds no code, workflow, branch, permission, secret, repository setting, merge, deployment, production, Cloudflare, or local-host change.


---

# DCP-01V.1 — Integrated hostile review and corrected architecture

**Review mode:** approval-first, architecture correction only  
**Review date:** 2026-11-24  
**Disposition:** the earlier Approach B is rejected; implementation remains unauthorized.

## 1. Threat model and trust assets

### Assets to protect

1. 9Router endpoint URL, API key, marker HMAC keys, and any other model/provider credentials.
2. GitHub write-capable token and PR-comment publication authority.
3. Model-inference budget, provider billing, and per-PR/global cost limits.
4. Integrity of the reviewed head/base snapshot and published review report.
5. Default-branch workflow source, workflow identity, and reviewer implementation.
6. Repository continuity: no accidental merge, retarget, deployment, or policy mutation.

### Adversaries and failure classes

- Fork contributor controlling the PR head, workflow YAML and artifacts.
- Same-repository branch author who can change PR workflow YAML.
- Compromised or over-privileged collaborator, including an insider.
- Duplicate, delayed, replayed, reordered, cancelled, or partially delivered events.
- Stale PR head/base, PR closure/draft transition, merge conflict, branch deletion, and reused commit SHA.
- GitHub API rate limit, authorization error, pagination truncation, inconsistent responses, and timeout after a request may have succeeded.
- Prompt injection in PR patches, filenames, comments, generated model output, and test fixtures.
- Workflow policy changes or missing default-branch registration.

### Evidence and assumptions

- Repository ID: `1398846697`; default branch: `main`; repository visibility: `public`.
- Main SHA at this review: `919b19ca3d3887352cdef06b03c668ead04fbce7`.
- The current reviewer workflow references `NINE_ROUTER_API_URL`, `NINE_ROUTER_API_KEY`, `NINE_ROUTER_REVIEW_MARKER_KEY`, and a previous marker key. The values were not read. Whether each secret is repository-, organization-, or environment-scoped remains **UNKNOWN**.
- The current workflow source has no explicit `environment:` declaration around its reviewer step. That is source evidence, not proof of secret storage scope.
- The effective repository Actions event policy cannot be read through the connected GitHub integration; its state is **UNKNOWN**.
- No live 9Router request, provider inference, secret-value read, or Actions-policy mutation was performed.

## 2. Confirmed hostile findings

### H-01 — PR-controlled workflow code in the proposed signal path

**Severity: P1 / BLOCKER**

GitHub documents that a `pull_request` workflow runs the workflow file from the PR merge commit. A PR can therefore alter the source signal's YAML, its permissions, its steps, and its environment references. The reviewed `permissions: {}` and no-secret baseline cannot constrain a malicious modification to that same workflow definition.

GitHub's read-only-token/no-secret restriction is specifically documented for fork-originated PRs. The rejected design intentionally accepts same-repository PRs and rejects forks. Therefore it cannot rely on fork protections to secure the accepted signal path. If any referenced 9Router secret is available at repository or organization scope to same-repository PR workflows, the modified signal workflow could explicitly reference it. Secret scope is UNKNOWN and must be inspected before any secret-bearing automation is enabled.

**Decision:** reject Approach B. A downstream trusted `workflow_run` consumer does not make the source workflow's execution safe retroactively.

### H-02 — workflow-run file registration and first-run bootstrap boundary

**Severity: P1 / BLOCKER**

GitHub documents that a `workflow_run` consumer only triggers if its workflow file exists on the default branch. Both 9Router workflows and the `tools/9router-review` runtime are absent from current `main`. A branch-local green contract suite cannot prove the hosted chain. The bootstrap PR itself cannot prove the post-merge workflow-run chain; a separate canary PR/event after default-branch registration is required.

**Decision:** no test result from the feature branch may be labelled hosted event-chain PASS.

### H-03 — pull_request SHA ambiguity

**Severity: P1 / MUST TEST**

For `pull_request`, GitHub documents that `GITHUB_SHA` is the merge commit on `refs/pull/<number>/merge`; it is not the PR head commit. The previous design used the Actions run API's `head_sha`, not `GITHUB_SHA`, and a single API sample showed that value matching the PR head. That sample is useful but does not justify substituting one field for the other or assuming all run types share the same semantics.

**Decision:** the corrected automatic path receives the PR number and original head/base snapshots directly from the trusted GitHub `pull_request_target` event payload, then re-fetches the live PR by number. Do not resolve PR identity by treating the PR merge SHA as a head SHA.

### H-04 — commit-to-PR association endpoint is not a universal current-PR index

**Severity: P2 / FALSE-NEGATIVE RISK**

GitHub documents that the commit-to-PR endpoint returns the merged PR that introduced a commit when that commit is present on the default branch; when it is not present on the default branch, it returns merged and open PRs associated with the commit. Therefore it is not a universal enumeration of all open PRs that may reuse an already-merged commit.

The exact-one rule fails closed and does not by itself create wrong-PR acceptance, but it can fail to resolve a valid open PR. This endpoint is removed from the corrected architecture because the trusted event already contains the PR number.

### H-05 — public-repository pull_request_target policy deadline

**Severity: P1 / POLICY GATE**

GitHub's current documentation states that the default policy blocks `pull_request_target` in affected public repositories without an applicable event policy and that enforcement is scheduled for **2026-12-02**. The repository is public. The repository-specific effective policy is UNKNOWN because the connected integration cannot read the Actions policy endpoints.

**Decision:** the automatic path is conditional on a read-only check of the actual Actions event policy. Do not attempt to bypass the policy, change it, or assume the main branch ruleset grants an event exception. If the event is not allowed, automatic PR-open/synchronize review remains disabled until a separately approved policy or external trusted webhook architecture exists.

### H-06 — scheduled event is not a strict delivery substitute

**Severity: P2 / COMPLETENESS RISK**

GitHub documents that scheduled workflows run only from the default branch, may be delayed during high load, and some queued runs may be dropped; scheduled workflows in public repositories can also be disabled after 60 days without repository activity. A polling scheduler can be a best-effort reconciliation mechanism, but cannot replace an event-delivery guarantee without explicit cursor, overlap, checkpoint, retry and recovery logic.

**Decision:** schedule polling is not selected as the primary trigger for this bootstrap.

## 3. Corrected architecture decision

### Preferred automatic architecture — one trusted default-branch workflow

Use one file:

`.github/workflows/9router-pr-review.yml`

The workflow is defined and executed from the default branch for `pull_request_target`. It contains two strictly separated jobs:

**Job A — resolve and validate**

- Trigger only after `pull_request_target` becomes policy-authorized.
- Consume the trusted event's PR number, head SHA, base SHA, base ref, head repository ID, and base repository ID.
- Re-fetch the PR from GitHub's Pull Requests API using the PR number.
- Require repository ID/name, base repository ID/name, and head repository ID/name to match the intended same-repository policy.
- Require the PR to be open and non-draft.
- Require the live PR head/base SHA and base ref to match the event snapshot; changed or stale snapshots are rejected and require a new event.
- Use only `contents: read` and `pull-requests: read` as required. No router secret, marker key, or model variable is passed to this job.
- Checkout only trusted default-branch code, with explicit default-branch ref and `persist-credentials: false`. Never checkout or execute PR-head code.
- Emit only the validated PR number, head SHA, base SHA, and base ref.

**Job B — review and publish**

- Depends on a successful Job A output.
- Has the minimum required repository read and PR-comment write permission.
- Receives router and marker secrets only in the final reviewer invocation step, never in the resolver.
- Uses the exact trusted default-branch reviewer source.
- Revalidates the same head/base pair immediately before inference, after model response, and immediately before comment publication.
- Preserves the PR #431 `redirect: "error"` change and its 307/308 regression tests.
- Forks, stale snapshots, draft/closed PRs, API errors, ambiguous state, and missing evidence stop before the reviewer job can access router credentials.
- Duplicate/ambiguous model or publication outcomes are not blindly retried. Durable cross-run dispatch reservation remains a separate mandatory activation gate.

This single-workflow design removes the untrusted source-workflow execution, the `workflow_run` chain, commit-to-PR inference, and the Signal Artifact/Receipt transport. It does **not** remove the public-repository `pull_request_target` policy gate.

### Safe manual fallback — default-branch-only events

If the Actions policy does not allow `pull_request_target`, the safe no-policy-change fallback is a trusted default-branch workflow triggered by:

- `issue_comment: created` with an exact command such as `/review-canary` or, after separate activation, `/review`.
- `workflow_dispatch`, guarded so the selected ref must be `refs/heads/main`.

For `issue_comment`:

- Require `github.event.issue.pull_request` to exist.
- Parse the first line using an exact command match; treat all remaining comment text as untrusted data and do not feed it into the reviewer prompt.
- Require an explicitly allowlisted actor. Initial bootstrap allowlist: repository owner ID `335530603`; any expansion requires a code-reviewed change.
- Re-fetch the PR by `issue.number`, then apply the same repository, state, head/base and stale-snapshot checks.
- The workflow definition and code run from the default branch; no PR source workflow or PR-head code is executed.

For `workflow_dispatch`:

- Require `github.ref == 'refs/heads/main'`.
- Require the dispatch actor to be the explicitly allowlisted repository owner for the initial bootstrap.
- Parse the PR number as a canonical positive decimal integer, then fetch the live PR by number; do not accept user-supplied SHA or repository identity as authoritative.
- Reject any run selected against a non-main ref.

GitHub's event documentation identifies `issue_comment` as using the last commit on the default branch and `workflow_dispatch` as an explicit operator-triggered event. These manual paths avoid the untrusted PR workflow-file boundary and do not depend on the `pull_request_target` event policy. They are not automatic PR-update delivery.

## 4. Corrected bootstrap scope and exact file set

The first implementation PR must be a new branch directly based on a freshly revalidated `main` SHA. It must not reuse or retarget PR #324 or #431.

Initial Bootstrap PR contains:

- `.github/workflows/9router-pr-review.yml` — trusted default-branch workflow with `issue_comment` and `workflow_dispatch` canary triggers only. Do **not** add `pull_request` as the signal event. Do **not** add `workflow_run` or `pull_request_target` until their respective gates are met.
- `tools/9router-review/package.json`
- `tools/9router-review/package-lock.json`
- `tools/9router-review/resolve-pr.mjs` — direct PR-number and live-snapshot resolver; no commit-to-PR endpoint.
- `tools/9router-review/resolve-pr.test.mjs`
- `tools/9router-review/review.js` — source from PR #431 exact candidate, including `redirect: "error"`.
- `tools/9router-review/review.test.mjs` — source from PR #431 exact candidate, including 307/308 regression coverage.
- `tools/9router-review/run-review.mjs`
- `tools/9router-review/OPERATIONS.md`

Do **not** add:

- `9router-pr-review-signal.yml`
- `workflow_run` consumer
- `signal.json`, `signal-receipt.js`, or its tests
- commit-to-PR identity resolution
- model secrets or marker secrets to the canary version
- `pull-requests: write` in the resolver
- source-run artifacts, caches, or workflow-generated code
- broad secret-history workflow changes
- the historical 232 KB README.

The canary version must contain a literal reviewer-job `if: false` gate and no router or marker secrets. The secret-bearing job is not activated by this bootstrap.

## 5. Corrected resolver contract

Inputs are accepted only from one of these trusted event classes:

1. `pull_request_target`: PR number and event head/base snapshot from the GitHub event payload.
2. `issue_comment`: PR number from the trusted issue event envelope after exact command and actor-allowlist validation.
3. `workflow_dispatch`: PR number from a validated decimal input, only when the run ref is main and actor is allowlisted.

Conceptual output:

```ts
type ResolvedPullRequest = {
  repositoryId: number;
  repository: string;
  pullRequest: number;
  headRepositoryId: number;
  baseRepositoryId: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
};

type Resolution =
  | { status: "RESOLVED"; target: ResolvedPullRequest }
  | { status: "REJECTED"; reasonCode: string }
  | { status: "UNKNOWN"; reasonCode: string };
```

For automatic PR events, required invariant:

`event.repository.id == live.repository.id == live.base.repo.id == live.head.repo.id`

and

`event.pull_request.head.sha == live.head.sha`

and

`event.pull_request.base.sha == live.base.sha`

For manual events, the event does not claim a head/base snapshot. The resolver obtains the current snapshot directly from the live PR API and treats it as the review's initial binding.

Fail closed on:

- missing PR object, issue-only comment, or wrong event class;
- unrecognized command or actor not allowlisted;
- non-main workflow-dispatch ref;
- invalid, zero, negative, non-decimal, or out-of-range PR number;
- repository ID/name mismatch;
- fork head or foreign base repository;
- closed, draft, locked if unsupported, or otherwise non-reviewable state;
- event/live head/base SHA mismatch;
- missing head/base repository;
- malformed response, API 401/403/404/409/422/429/5xx, rate limit, timeout, or incomplete response;
- missing trusted source, lockfile, required test, or expected workflow identity.

## 6. Corrected atomic hostile-test matrix

### Event provenance and workflow source

- Prove the workflow definition used by `pull_request_target`, `issue_comment`, and `workflow_dispatch` is the trusted default-branch file.
- Add a malicious PR that changes the workflow file and prove no `pull_request`-triggered path executes that modified file with router secrets.
- Reject workflow dispatch from a PR branch, tag, or any non-main ref.
- Reject a non-owner actor for the initial manual canary.
- Reject an issue comment on a normal issue, an edited/deleted comment, a quoted command, a command with extra arguments, or a command embedded later in the body.
- Reject fork PRs before any secret-bearing job can start.

### Live PR identity and race behavior

- Reject PR number mismatch, target repository mismatch, head repository mismatch, base repository mismatch, closed/draft PR, missing repo object, malformed SHA, and empty SHA.
- Mutate head SHA between event receipt and PR API fetch; require rejection.
- Mutate base SHA/ref between event receipt and PR API fetch; require rejection.
- Mutate the live PR after resolver and before reviewer start; require the reviewer to revalidate and stop before inference.
- Mutate head/base after model response; require zero comment writes.
- Exercise PR closure, conversion to draft, branch deletion, force-push, merge conflict, and PR-number reuse assumptions (PR numbers are not reusable; still verify exact PR URL/repository identity).

### Privilege separation and secrets

- Assert resolver job has no router/marker secrets in job- or step-level env.
- Assert reviewer secrets are referenced only in the final invocation step.
- Assert reviewer job uses trusted default-branch source and `persist-credentials: false`.
- Assert no checkout of PR head, no execution of PR scripts, no dependency install from PR content, no PR artifact consumption, no caches shared with untrusted runs.
- Assert resolver permissions do not include write operations.
- Assert canary reviewer is statically disabled and produces zero network calls to 9Router, zero provider dispatches, zero secret reads, and zero PR comment POSTs.
- Inspect actual secret storage scope before activating any reviewer job. Never log secret values or hashes.

### API failure and idempotency

- Test GitHub 401, 403, 404, 409, 422, 429, 500, 502, 503, malformed JSON, response truncation, timeout and rate-limit reset behavior.
- A GET can be retried only within an explicit remaining deadline and safe retry budget.
- A POST with ambiguous outcome must not be blindly retried.
- Exercise duplicate workflow event delivery and concurrent same-PR executions.
- Verify per-PR concurrency does not get mistaken for durable cross-run uniqueness.
- Require durable dispatch reservation before any future model request; `ATTEMPT_UNKNOWN` blocks automatic replay.
- Keep provider/billing attempts, model execution, response receipt, and comment publication as separate observed facts.
- Retain RED/GREEN 307/308 redirect regression evidence from PR #431; it is transport replay hardening only, not provider exactly-once proof.

## 7. Corrected rollout and acceptance gates

### Gate 0 — read-only policy and secret-scope assessment

- Confirm the exact repository Actions event policy and whether `pull_request_target` will be blocked on or after 2026-12-02.
- Confirm the storage scope of the named 9Router and marker secrets: repository, organization, or environment. Read status only; never inspect values.
- Confirm branch ruleset and required-review status from GitHub.
- Do not change any settings, rulesets, policies, or secret scopes during this gate.
- If Actions policy remains UNKNOWN, automatic trigger acceptance remains UNKNOWN.

### Gate 1 — design approval

Approve DCP-01V.1 and its exact file set. No implementation, branch creation, or settings action is included in this review step.

### Gate 2 — isolated manual-canary PR

- Create a new branch from a freshly re-fetched exact main SHA.
- Add only the corrected file set above.
- Keep the PR Draft during review.
- The workflow has `issue_comment` and `workflow_dispatch` canary triggers only, no automatic PR trigger.
- The resolver is read-only and the reviewer job contains literal `if: false`.
- Run unit, static YAML security-contract, and hostile resolver tests; no provider credentials are supplied to the canary.
- Do not use a same-PR `pull_request` source workflow as a trust signal.

### Gate 3 — separate default-branch registration

- A dedicated human-reviewed PR must register the trusted workflow and runtime on main.
- The merge itself requires its own approval and is not authorized here.
- Re-fetch main after merge and verify exact file paths, commit SHA, Workflow ID, default-branch workflow source, and active state.

### Gate 4 — trusted manual canary

- Use an owner-authored exact `/review-canary` PR comment or `workflow_dispatch` explicitly targeting main.
- Prove trusted main workflow execution, actor allowlist, live PR reconciliation, and reviewer skip.
- Prove zero router requests, provider dispatches, secret reads, comment writes, and deployment operations.
- A pass establishes only the manual trigger and resolver path for the exact run and PR snapshot.

### Gate 5 — automatic event decision

- If and only if the Actions event policy is verified to allow the exact `pull_request_target` workflow, add that trigger in a separate reviewed PR.
- If policy is blocked or remains UNKNOWN, keep automatic PR-open/synchronize review disabled. Continue with trusted manual invocation or design a separately approved GitHub App/webhook architecture.
- Do not switch to a PR-controlled `pull_request` signal as a workaround.
- After enabling the automatic trigger, run a same-repository canary and a fork negative-control; prove fork rejection before secret-bearing job start.

### Gate 6 — reviewer activation

Do not enable inference/publication until separately accepted:

1. durable cross-run dispatch reservation and ambiguous-outcome recovery;
2. per-PR and aggregate API/inference budgets;
3. duplicate/replay/concurrency behavior;
4. provider/billing retry semantics and limits of exactly-once claims;
5. exact secret scope and least-privilege permissions;
6. a fresh hosted red/green run on exact final candidate SHA;
7. runtime 9Router deployment identity, which remains UNKNOWN.

## 8. Corrected rollback

- If manual canary fails, keep reviewer disabled; preserve exact run and event metadata.
- If default-branch registration is later approved and causes unacceptable behavior, use a separately reviewed revert PR.
- Do not reactively change Actions policy or expose credentials to bypass a failed trigger.
- If `pull_request_target` is blocked, use the trusted manual route; do not downgrade the trust boundary to a PR-controlled workflow.
- Any ambiguous model or comment outcome remains UNKNOWN and blocks blind replay.

## 9. DCP-01V.1 final disposition

| Question | Result |
|---|---|
| Former Approach B (`pull_request` signal → `workflow_run`) | **REJECTED** |
| Single trusted `pull_request_target` workflow | **PREFERRED AUTOMATIC PATH, POLICY-GATED** |
| `issue_comment` + owner-only `workflow_dispatch` | **PREFERRED SAFE BOOTSTRAP / MANUAL FALLBACK** |
| Commit-to-PR association endpoint as primary identity | **REMOVED** |
| Workflow-run Artifact/Receipt chain | **REMOVED FROM CORRECTED DESIGN** |
| Effective Actions event policy | **UNKNOWN** |
| Secret storage scope | **UNKNOWN** |
| Default-branch hosted canary | **NOT_RUN** |
| Durable cross-run dispatch ledger | **NOT_ESTABLISHED** |
| Exactly-once provider/model execution | **NOT_ESTABLISHED** |

**Readiness:** DCP-01V.1 is a corrected design candidate for hostile review. It is not yet approved for implementation.

**Non-negotiable boundary:** No source code, workflow, new branch, main ref, Actions policy, repository setting, permission, secret, Cloudflare resource, deployment, production service, or local machine has been modified in this review. The only permitted repository write is this documentation update on the existing docs PR branch.
