# 9Router PR Reconciler Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a bounded, resumable, report-only reconciler that re-reviews only same-repository pull requests whose exact head SHA has a valid historical signed report for an older base SHA and lacks a valid report for the current head/base pair.

**Architecture:** Keep the existing immutable reviewer as the only patch-construction, model-inference, sanitization, and publication implementation. Extract a shared HMAC marker verifier and bounded marker-history reader, add a cursor-based discovery/checkpoint engine, and invoke the existing reviewer through a least-privilege scheduled/manual workflow with one global run and per-PR serialization.

**Tech Stack:** Node.js 22, ECMAScript modules, Node built-in test runner, GitHub REST API, GitHub GraphQL API, GitHub Actions, pinned official Actions, existing `marked@17.0.1` dependency.

## Global Constraints

- Implement only on a new isolated branch based on the approved Finding 67 design commit; do not change `main` or Production.
- Preserve PR #261 and PR #262 as Open and Draft. Do not merge, close, retarget, approve, or convert them.
- The reconciler is a freshness-recovery mechanism, not a general review scheduler.
- A PR is eligible only when it is open, non-draft, same-repository, has complete valid head/base metadata, has at least one authentic signed marker for the exact current head and an older base, and has no valid marker for the exact current head/base pair.
- Never initiate reconciler inference for a PR without a valid historical signed report.
- Use the existing reviewer for immutable diff construction, model prompting, output sanitization, marker creation, duplicate suppression, and append-only publication. Do not fork or reimplement these behaviors.
- Workflow code must come from the trusted default branch. Never check out, execute, source, or interpret executable content from a PR head or PR-controlled artifact.
- All external PR data is untrusted input.
- Hard limits: 6-hour schedule; 200 PR records per discovery run; at most 3 new review attempts per run; one active reconciler workflow run; at most 10 comment pages and 4 MiB serialized comment data per PR.
- Preserve deterministic candidate ordering and resumable progress. Never claim full coverage when pagination or discovery is incomplete.
- Revalidate repository identity, PR state, head SHA, and base SHA before inference and immediately before publication.
- Any uncertain API, checkpoint, marker, or publication state fails closed. `UNKNOWN` is neither success nor failure.
- Keep report-only behavior. No approval, merge, source mutation, deployment, Production operation, secret mutation, repository setting change, Actions policy change, Ruleset change, or branch-protection change is in scope.
- Workflow activation requires a separate explicit approval to merge the workflow into the default branch. This plan does not authorize activation or merge.
- Engineering artifacts, identifiers, comments, logs, schemas, and commit messages remain English-only.

---

## Repository Baseline

The plan is grounded in the approved design branch and the inspected implementation branch.

**Observed existing files:**

- `tools/9router-review/review.js` — existing reviewer, HMAC marker creation, exact-pair marker validation, bounded comment pagination, PR SHA/state checks, immutable patch construction, 9Router request, sanitization, and append-only comment publication.
- `tools/9router-review/run-review.mjs` — environment-to-`runReview` adapter.
- `tools/9router-review/review.test.mjs` — Node test-runner contract suite and mock GitHub/9Router HTTP fixtures.
- `tools/9router-review/package.json` and `package-lock.json` — ESM package, Node >=22, pinned `marked@17.0.1`; no package scripts are currently defined.
- `.github/workflows/9router-pr-review.yml` — existing trusted-default-branch reviewer workflow and per-PR concurrency group.
- `.github/workflows/9router-pr-review-signal.yml` — unprivileged PR signal workflow.
- `tools/9router-review/README.md` — current threat model, activation boundary, tests, and findings.

**Observed current gaps relevant to implementation:**

1. `hasValidReviewMarker` is private and requires an exact expected head/base pair; the reconciler needs authenticated historical marker tuples for a given repository and PR.
2. `findMatchingReviewComments` is bounded but returns only exact-pair matches; it must be generalized without weakening its bot-identity, HMAC, pagination, byte-budget, malformed-record, or duplicate checks.
3. `assertReviewablePullRequest` currently validates open state, head SHA, base SHA, and draft state, but does not bind the live head/base repository identities to an expected repository ID.
4. The current reviewer entry point is reusable, but the existing runner does not pass an expected repository ID.
5. No reconciler module, checkpoint schema, scheduled workflow, or reconciler-specific tests currently exist on the inspected implementation branch.

## Task 1: Shared Signed-Marker Evidence and Repository Identity Gates

**Files:**
- Create: `tools/9router-review/review-marker.js`
- Modify: `tools/9router-review/review.js`
- Modify: `tools/9router-review/run-review.mjs`
- Test: `tools/9router-review/review.test.mjs`
- Test: `tools/9router-review/review-marker.test.mjs` (new)

**Interfaces:**
- `createReviewMarker({ repository, pullRequest, headSha, baseSha, key }) -> string`
- `verifyReviewMarker(marker, { repository, pullRequest, keys }) -> { headSha, baseSha } | null`
- `resolveReviewMarkerKeys({ reviewMarkerKey, previousReviewMarkerKey, previousReviewMarkerKeyValidUntil, now }) -> { keys, previousKeyAccepted }`
- `readAuthenticatedReviewMarkers({ fetchImpl, githubApiBase, repository, pullRequest, githubToken, reviewMarkerKeys, deadlineAt }) -> { markers, pagesRead, totalBytes }`
- Extend `runReview` with required `expectedRepositoryId` (positive safe integer).
- The existing `createReviewMarker` export from `review.js` remains available as a compatibility re-export.

- [ ] **Step 1: Add focused failing marker-verification tests**

Add tests proving:
- A marker signed for the supplied repository and PR returns the exact lower-case head/base SHA tuple.
- A marker signed for another repository or PR returns `null`.
- A wrong signature, malformed marker, invalid SHA, truncated marker, or unknown marker version returns `null`.
- Signature comparison remains constant-time after length validation.
- Active and unexpired previous keys are accepted according to the current rotation policy; an expired previous key is not accepted.
- The same historical marker can be verified without the caller knowing its base SHA in advance.

Run: `node --test tools/9router-review/review-marker.test.mjs`

Expected RED: the test fails because the shared historical tuple-verification interface does not yet exist.

- [ ] **Step 2: Extract the marker contract**

Move marker format, payload construction, validation, and HMAC verification into `review-marker.js`. Preserve the existing v2 marker bytes and payload exactly; do not introduce a marker-version migration. Validate key length and identity inputs as the current implementation does. Use `timingSafeEqual` only after confirming equal signature byte lengths.

Refactor `review.js` to import the shared implementation and re-export `createReviewMarker`. Replace the private exact-pair predicate with the shared verifier plus an explicit exact-pair comparison. Remove the duplicated inline active/previous-key parsing from `runReview` and call `resolveReviewMarkerKeys` instead.

- [ ] **Step 3: Generalize bounded comment-history evidence**

Replace the exact-pair-only comment reader with exported `readAuthenticatedReviewMarkers`. It must:
- Use the existing GitHub API request/deadline/response-byte safeguards.
- Read no more than 10 pages of 100 comments and no more than 4 MiB cumulative serialized comment data.
- Reject malformed pages and records; reject a full tenth page because completeness is unproven.
- Accept marker evidence only from the exact GitHub Actions bot login, numeric user ID, and Bot type already enforced by the reviewer.
- Parse only the first comment-body line as a marker.
- Return only HMAC-authenticated tuples and their comment IDs; never return keys, signatures as standalone data, or comment bodies.
- Detect duplicate valid comments for an identical tuple and expose that ambiguity explicitly rather than silently selecting one.
- Preserve current reviewer behavior: one exact-pair marker suppresses duplicate publication; multiple exact-pair markers fail closed.

- [ ] **Step 4: Bind the reviewer to repository identity**

Extend `runReview` and its runner contract with `expectedRepositoryId`. Update every live PR validation point to require:
- `pr.base.repo.id === expectedRepositoryId`
- `pr.head.repo.id === expectedRepositoryId`
- Exact expected head and base SHAs.
- Open and non-draft state, except the existing explicitly supported draft-skip path.

Pass the repository ID from the existing workflow using `github.repository_id`. Do not infer identity from repository names alone.

- [ ] **Step 5: Verify focused and existing reviewer contracts**

Run:
- `node --test tools/9router-review/review-marker.test.mjs`
- `node --test tools/9router-review/review.test.mjs`

Expected GREEN: new marker tuple tests and all existing reviewer contracts pass. Existing exact-pair duplicate suppression, previous-key expiry, immutable snapshot checks, and append-only publication behavior remain unchanged.

- [ ] **Step 6: Commit the independently passing deliverable**

```bash
git add tools/9router-review/review-marker.js tools/9router-review/review-marker.test.mjs tools/9router-review/review.js tools/9router-review/review.test.mjs tools/9router-review/run-review.mjs .github/workflows/9router-pr-review.yml
git commit -m "refactor: share signed review marker verification"
```

## Task 2: Cursor-Based Discovery and Authenticated Checkpoint State

**Files:**
- Create: `tools/9router-review/reconciler-state.js`
- Create: `tools/9router-review/reconciler-state.test.mjs`
- Create: `tools/9router-review/reconciler-github.js`
- Create: `tools/9router-review/reconciler-github.test.mjs`

**Interfaces:**
- `createInitialCheckpoint({ repositoryId, workflowId, workflowPath, workflowSha, highWaterPullRequestNumber, now }) -> checkpoint`
- `validateCheckpoint(checkpoint, expectedContext) -> { valid, reason }`
- `advanceCheckpoint(checkpoint, { afterCursor, afterPullRequestNumber }) -> checkpoint`
- `fetchPullRequestPage({ fetchImpl, githubGraphqlUrl, githubToken, owner, repositoryName, afterCursor, deadlineAt }) -> { edges, pageInfo }`
- `fetchHighWaterPullRequestNumber(...) -> positive safe integer`

**Checkpoint schema v1:**

```json
{
  "schemaVersion": 1,
  "repositoryId": 0,
  "workflowId": 0,
  "workflowPath": ".github/workflows/9router-pr-reconciler.yml",
  "workflowSha": "40-character-commit-sha",
  "generationId": 0,
  "policyVersion": 1,
  "retryLedger": [],
  "highWaterPullRequestNumber": 0,
  "afterCursor": null,
  "afterPullRequestNumber": 0,
  "createdAt": "canonical-UTC-timestamp"
}
```

Checkpoint fields and validation rules:

| Field | Type and invariant |
|---|---|
| `schemaVersion` | Integer; exactly `1` for this implementation |
| `repositoryId` | Positive safe integer from trusted workflow context |
| `workflowId` | Positive safe integer from GitHub Actions workflow metadata |
| `workflowPath` | Exact path `.github/workflows/9router-pr-reconciler.yml` |
| `workflowSha` | Exact 40-character SHA of the trusted workflow source revision |
| `generationId` | Positive safe integer; the run ID that started the scan generation |
| `highWaterPullRequestNumber` | Positive safe integer captured at generation start |
| `afterCursor` | Null only before the first page; otherwise a non-empty opaque GraphQL edge cursor |
| `afterPullRequestNumber` | Non-negative safe integer for the last fully processed edge |
| `createdAt` | Canonical UTC ISO-8601 timestamp |
| `policyVersion` | Integer; exactly `1` for the retry-ledger contract |
| `retryLedger` | Deterministically ordered, bounded records keyed by repository ID, PR number, head SHA, and base SHA; includes attempt reservations and explicit state |

The checkpoint persists the retry ledger and also carries source-run provenance in its enclosing artifact receipt: source run ID, run attempt, repository ID, workflow ID/path, event, conclusion, branch, workflow SHA, artifact name, and GitHub artifact digest. Production values are derived from verified GitHub context and API metadata.

- [ ] **Step 1: Add failing checkpoint contract tests**

Test:
- Correct schema, repository ID, workflow ID/path, exact workflow SHA, policy version, and retry-ledger records are accepted.
- Unknown schema versions, wrong repository/workflow identity, wrong workflow SHA, malformed timestamps, invalid PR numbers, oversized cursor values, unexpected fields, and missing required fields are rejected.
- A missing, expired, malformed, or incompatible checkpoint causes a safe bootstrap decision.
- A completed scan generation resets the cursor and establishes a new high-water PR number.
- A partially completed generation preserves its high-water number and last fully processed edge cursor.

Run: `node --test tools/9router-review/reconciler-state.test.mjs`

Expected RED: checkpoint constructors and validators are absent.

- [ ] **Step 2: Implement a versioned, strict checkpoint contract**

Implement pure functions in `reconciler-state.js`. Keep parsing separate from GitHub I/O. Reject incompatible workflow SHA checkpoints so code changes do not silently reuse stale cursor state. Store no secrets, comment bodies, marker signatures, or model output in the checkpoint.

- [ ] **Step 3: Add cursor-based GitHub PR discovery tests**

Use mocked GraphQL responses to test:
- Pull requests are enumerated in `CREATED_AT ASC` order with an opaque GraphQL edge cursor.
- The query includes all PR states so a PR closing during pagination does not disappear from the connection and shift offset-based pages.
- The scan captures a high-water PR number at generation start and ignores newly created PR numbers above that boundary until the next generation.
- Open/non-draft/same-repository filtering is applied to returned records, not trusted to mutable connection membership.
- Exactly 200 PR records may be inspected per run; the 201st record is not consumed.
- A page with `hasNextPage=true` and a missing or malformed `endCursor` is incomplete and cannot advance the checkpoint.
- A transient API failure does not advance beyond the last fully processed edge.
- Cursor continuation and high-water handling do not skip PRs when other PRs close between pages.

Run: `node --test tools/9router-review/reconciler-github.test.mjs`

Expected RED: the GraphQL discovery client and cursor behavior are absent.

- [ ] **Step 4: Implement bounded GraphQL discovery**

Implement a Node built-in `fetch` GraphQL client with:
- HTTPS GitHub GraphQL endpoint validation.
- Explicit request deadline and response byte ceiling.
- Authorization only from the runtime secret environment.
- Exact repository owner/name binding.
- Query fields for PR number, creation time, state, draft state, head/base OIDs, head/base repository identity, edge cursor, and page info.
- A separate high-water query at generation start.
- No PR title/body/comment data in GraphQL outputs unless strictly needed; candidate logic needs only identity and state fields.

Use a connection over all PR states ordered by creation time ascending. Capture the highest existing PR number as the generation boundary. Persist the edge cursor after the last fully processed PR. New PR numbers above the boundary are handled in the next scan generation.

- [ ] **Step 5: Verify focused discovery and state tests**

Run:
- `node --test tools/9router-review/reconciler-state.test.mjs`
- `node --test tools/9router-review/reconciler-github.test.mjs`

Expected GREEN: checkpoint state and cursor pagination tests pass, including >200 PR continuation and concurrent close/open fixtures.

- [ ] **Step 6: Commit the independently passing deliverable**

```bash
git add tools/9router-review/reconciler-state.js tools/9router-review/reconciler-state.test.mjs tools/9router-review/reconciler-github.js tools/9router-review/reconciler-github.test.mjs
git commit -m "feat: add bounded cursor-based PR discovery"
```

## Task 3: Stale-Evidence Classification and Reconciler Orchestration

**Files:**
- Create: `tools/9router-review/reconciler.js`
- Create: `tools/9router-review/reconciler.test.mjs`
- Create: `tools/9router-review/run-reconciler-discovery.mjs`
- Modify: `tools/9router-review/run-review.mjs` only if the existing runner requires a narrowly scoped shared adapter; otherwise keep it unchanged after Task 1.

**Interfaces:**
- `classifyStaleReviewEvidence({ currentHeadSha, currentBaseSha, authenticatedMarkers }) -> { status, reason, candidate }`
- `discoverReconcilerCandidates({ repository, repositoryId, githubToken, reviewMarkerKeys, checkpoint, maxRecords: 200, maxReviewAttempts: 3, retryPolicyVersion: 1, fetchImpl, now }) -> { candidates, nextCheckpoint, scanStatus, counters }`
- `validateCandidateSnapshot({ candidate, livePullRequest, repositoryId }) -> { valid, reason }`
- `runReconcilerReview({ candidate, reviewerEnvironment, runReviewImpl }) -> structured disposition`

- [ ] **Step 1: Add failing stale-evidence tests**

Test candidate classification for:
- One valid old-base marker with the exact current head and no current-pair marker => candidate.
- No valid historical marker => not a candidate.
- Marker head differs from current head => not a candidate.
- A valid current-pair marker exists => not a candidate.
- Invalid HMAC, wrong repository/PR, expired previous key, incomplete comment history, or malformed record => UNKNOWN/non-candidate.
- Duplicate marker evidence for the same historical tuple => ambiguous/UNKNOWN.
- Multiple distinct authentic older-base tuples for the same head => one candidate, with evidence references retained.
- Current PR is fork-originated, draft, closed, or missing a repository identity => excluded.

Run: `node --test tools/9router-review/reconciler.test.mjs`

Expected RED: candidate classification and orchestration interfaces are absent.

- [ ] **Step 2: Implement evidence classification**

Use only `readAuthenticatedReviewMarkers` from Task 1. Do not parse HMAC markers in a second place. The classification function must be pure and deterministic. Return explicit statuses and reason codes; never collapse incomplete evidence into “no prior report”.

- [ ] **Step 3: Add discovery-to-review integration tests**

Use mocked GitHub GraphQL and REST responses plus a stubbed `runReview` boundary to prove:
- At most 200 PR records are consumed.
- At most three dispatched inference attempts are returned per run; at most one may be a deferred retry and at least two slots remain reserved for new candidates.
- Candidate order is deterministic by the cursor scan order.
- Discovery stops before consuming the next candidate after the three-attempt budget is full and preserves the cursor before that unprocessed candidate.
- A PR with no historical signed report never calls `runReview`.
- An exact current-pair marker suppresses `runReview`.
- A stale head/base/repository snapshot suppresses `runReview`.
- A candidate's live repository ID, head repository ID, base repository ID, head SHA, base SHA, open state, and draft state are revalidated immediately before invoking `runReview`.
- `runReview` receives the exact candidate SHA pair and expected repository ID.
- The reviewer remains the only code path that can call 9Router or create comments.
- API rate limits, malformed pages, incomplete pagination, missing checkpoint, and timeout yield explicit safe dispositions.

- [ ] **Step 4: Implement orchestration and candidate output**

Implement `reconciler.js` as the coordinator. Resolve marker keys through `resolveReviewMarkerKeys`; the discovery job receives only the active and optional previous marker-key secrets plus the expiry variable, never the 9Router endpoint or API key.
1. Load/validate checkpoint or bootstrap.
2. Capture or validate scan-generation high-water boundary.
3. Enumerate no more than 200 PR records.
4. For each record, apply same-repository/open/non-draft checks and read bounded authenticated marker history.
5. Classify stale evidence.
6. Before accepting a candidate, fetch authoritative REST PR metadata and bind numeric repository IDs.
7. Stop after collecting at most three candidates, leaving the cursor immediately before the next unprocessed candidate.
8. Return a structured run disposition and counters.

The discovery runner writes a schema-validated candidate JSON output and a proposed checkpoint artifact file under `RUNNER_TEMP`. It must not call 9Router and must not publish comments. Validate all candidate fields before writing GitHub Actions outputs. The marker-key secrets are scoped only to the discovery process step; they must not appear in outputs, artifacts, logs, or error messages.

- [ ] **Step 5: Verify focused orchestration tests**

Run:
- `node --test tools/9router-review/reconciler.test.mjs`
- `node --test tools/9router-review/reconciler-state.test.mjs tools/9router-review/reconciler-github.test.mjs`

Expected GREEN: all negative cases prove that inference and publication stubs were not called; positive candidates carry exact verified identity and SHA tuples.

- [ ] **Step 6: Commit the independently passing deliverable**

```bash
git add tools/9router-review/reconciler.js tools/9router-review/reconciler.test.mjs tools/9router-review/run-reconciler-discovery.mjs
git commit -m "feat: classify stale signed PR review evidence"
```

## Task 4: Scheduled/Manual Workflow, Checkpoint Artifact, and Per-PR Isolation

**Files:**
- Create: `.github/workflows/9router-pr-reconciler.yml`
- Create: `tools/9router-review/reconciler-workflow.test.mjs`
- Create: `tools/9router-review/finalize-reconciler-checkpoint.mjs`
- Modify: `tools/9router-review/README.md`

**Interfaces:**
- Workflow discovery job output: validated JSON array of zero to three candidate records.
- Discovery artifact: `checkpoint-next.json` plus a versioned run metadata receipt.
- Review matrix: one job per candidate, with `strategy.max-parallel: 3`.
- Finalization: publish the next checkpoint artifact only after every candidate job is in a terminal safe disposition.
- Existing per-PR concurrency group remains exactly `9router-pr-review-${{ matrix.pull_request }}`, matching the event-driven reviewer.

- [ ] **Step 1: Add failing workflow-contract tests**

Test the workflow source to assert:
- Only `schedule` (six-hour UTC cron) and `workflow_dispatch` triggers exist.
- No `pull_request`, `pull_request_target`, `push`, or `workflow_run` trigger is added.
- Workflow-level permissions default to none.
- Discovery has only `contents: read`, `pull-requests: read`, `issues: read`, and `actions: read` where required.
- The review job has only the existing reviewer permissions needed for trusted checkout and report-only comment publication.
- Every checkout explicitly selects the default branch and disables persisted credentials.
- Third-party actions are pinned to immutable commit SHAs.
- Global reconciler concurrency is one group per repository with bounded queue semantics.
- Matrix parallelism is at most three.
- Every candidate review uses the same per-PR concurrency group as the event-driven reviewer.
- No step checks out, runs, sources, or downloads executable PR content.
- The workflow never grants contents write, administration, or repository-settings permissions.
- Checkpoint artifact upload is bounded and has a finite retention period.
- The schedule is documented as UTC and subject to GitHub scheduling delay.

Run: `node --test tools/9router-review/reconciler-workflow.test.mjs`

Expected RED: the reconciler workflow and its static security assertions are absent.

- [ ] **Step 2: Implement checkpoint discovery from prior trusted runs**

The discovery job must:
- Identify the exact reconciler workflow by path/ID.
- Find a prior successful run from the same repository, default branch, and approved trigger class (`schedule` or `workflow_dispatch`).
- Exclude the current run.
- Verify prior run ID, attempt, repository ID/name, branch, workflow ID/path, event, conclusion, and workflow SHA against the expected context.
- Accept only the named checkpoint artifact from that verified run.
- Download it with digest mismatch treated as an error.
- Validate checkpoint schema and provenance before use.
- Bootstrap from the beginning if no usable checkpoint exists; report that fairness coverage is being re-established.
- Search a bounded number of recent prior runs and stop safely if API pagination or artifact state is incomplete.

The recommended initial artifact retention is seven days, sufficient for normal six-hour cadence while bounding stale checkpoint retention.

- [ ] **Step 3: Implement the least-privilege workflow jobs**

Create a three-part workflow:
1. **Discover:** checkout trusted default-branch code, validate prior checkpoint, enumerate candidates, and upload the proposed checkpoint/metadata artifact. This job has read-only permissions and receives only the HMAC marker-key secrets required to authenticate prior reports; it receives no 9Router endpoint or API-key secret.
2. **Review matrix:** one candidate per job, maximum three parallel jobs, per-PR concurrency group shared with the existing reviewer. This job checks out only trusted default-branch code and invokes `run-review.mjs` with exact candidate values and the expected repository ID. Only this job receives the 9Router and marker secrets.
3. **Finalize:** run only after discovery and candidate review jobs reach safe terminal outcomes. Download the same-run proposed checkpoint artifact, validate its schema and run metadata, and publish a checkpoint artifact for the next run. If any candidate outcome is uncertain, do not advance past that candidate.

Use the existing pinned official checkout/setup-node/download-artifact/upload-artifact action SHAs already present in the repository where their behavior is suitable. Any new action must be pinned to an immutable SHA and independently reviewed.

- [ ] **Step 4: Add workflow-level negative-path tests**

Test:
- No candidate => no review matrix inference and a safe checkpoint may be finalized.
- Three candidates => exactly three matrix entries and no fourth inference.
- Any malformed candidate JSON => no review job.
- Any failed or UNKNOWN candidate => checkpoint does not advance beyond the earliest uncompleted candidate.
- Missing, expired, wrong-workflow, wrong-branch, wrong-repository, wrong-SHA, or digest-mismatched checkpoint => safe bootstrap or UNKNOWN, never trusted reuse.
- Missing secrets => no 9Router invocation.
- A PR head or base change before review => existing reviewer refuses the snapshot.
- A concurrent signal-driven review and reconciler review for the same PR share one concurrency group.
- No workflow permission or trigger is broadened beyond the approved design.

- [ ] **Step 5: Verify workflow and full contract suite**

Run:
- `node --test tools/9router-review/reconciler-workflow.test.mjs`
- `node --test tools/9router-review/*.test.mjs`

Expected GREEN: static workflow policy tests and all Node contract tests pass. Hosted schedule activation remains untested and must be labelled UNKNOWN until separately authorized and activated.

- [ ] **Step 6: Commit the independently passing deliverable**

```bash
git add .github/workflows/9router-pr-reconciler.yml tools/9router-review/reconciler-workflow.test.mjs tools/9router-review/finalize-reconciler-checkpoint.mjs tools/9router-review/README.md
git commit -m "feat: add bounded scheduled PR reconciler workflow"
```

## Task 5: End-to-End Contract, Security Audit, and Handoff Evidence

**Files:**
- Modify: `tools/9router-review/reconciler.test.mjs`
- Modify: `tools/9router-review/reconciler-workflow.test.mjs`
- Modify: `tools/9router-review/README.md`
- Modify: `docs/specs/2026-11-23-9router-finding-67-reconciler-design.md` only if the implementation reveals a necessary, separately documented design correction; do not silently weaken an approved invariant.

**Interfaces:**
- End-to-end harness drives discovery, marker validation, candidate selection, exact snapshot revalidation, reviewer invocation, publication outcome, and checkpoint advancement through mocked HTTP boundaries.
- Audit record distinguishes `PASS`, `FAIL`, `UNKNOWN`, and `NOT TESTED` per scenario.

- [ ] **Step 1: Add end-to-end adversarial fixtures**

Cover the approved design's T01–T26 matrix, including:
- Base advances with unchanged head and one valid historical marker.
- No prior signed report.
- Wrong repository/PR/head marker binding.
- Invalid HMAC and expired previous key.
- Existing current-pair report.
- Duplicate historical/current markers.
- Comment page/byte budget exhaustion.
- Fork, draft, closed, or deleted-head repository.
- Head/base/repository identity changes after discovery and immediately before publication.
- More than 200 PR records and cursor resume.
- New PR creation and PR closure during pagination.
- Checkpoint artifact tampering, wrong workflow provenance, incompatible workflow SHA, expiration, and loss.
- Concurrent scheduled/manual runs.
- Event-driven reviewer and reconciler contention for one PR.
- GitHub primary/secondary rate limit and 5xx.
- 9Router timeout and malformed output.
- Ambiguous comment POST outcome.
- Cancellation before checkpoint finalization.
- Secret leakage attempts in API errors and model output.

Every negative case must assert that the relevant inference or publication boundary was not called.

- [ ] **Step 2: Verify the exact TDD record**

For each new behavior, retain the focused RED command and decisive assertion, then the identical GREEN command and output. A test that passed only after implementation is not recorded as a RED-GREEN cycle. Do not delete or weaken assertions to obtain green.

- [ ] **Step 3: Run complete repository-local verification**

Run:
- `npm ci --ignore-scripts --prefix tools/9router-review`
- `npm audit signatures --prefix tools/9router-review`
- `node --test tools/9router-review/*.test.mjs`
- `git diff --check`

Expected: dependency installation and signature verification succeed, the full contract suite reports zero failures, and diff whitespace validation exits zero. Report exact counts and command exit codes.

- [ ] **Step 4: Run independent security and provenance checks**

Run the repository's existing Gitleaks Push and PR checks on the exact final commit. Independently inspect:
- Workflow trigger graph and every permission block.
- All checkout refs and action pin SHAs.
- Secret exposure paths and job scoping.
- Checkpoint artifact provenance and digest validation.
- GraphQL/REST pagination completeness.
- All code paths to 9Router and comment POST.
- Duplicate suppression and ambiguous publication recovery.
- Per-PR concurrency-group equality with the existing reviewer.

A successful secret scan is not evidence of runtime correctness or hosted workflow execution.

- [ ] **Step 5: Record audit disposition and limitations**

Update the README with:
- Exact final commit SHA and test run identifiers.
- Test totals and zero-failure/skip/cancellation counts.
- Per-scenario PASS/FAIL/UNKNOWN/NOT TESTED dispositions.
- The exact API, pagination, and checkpoint limits.
- Residual race between final PR metadata read and GitHub comment creation.
- Whether the hosted workflow chain was actually exercised; do not claim it was if schedule activation is still blocked by the default-branch boundary.
- Confirmation that no approval, merge, deployment, Production, repository setting, secret, branch protection, or Ruleset change occurred.

- [ ] **Step 6: Commit the audit evidence**

```bash
git add tools/9router-review/reconciler.test.mjs tools/9router-review/reconciler-workflow.test.mjs tools/9router-review/README.md
git commit -m "test: audit scheduled PR reconciler failure boundaries"
```

## Execution Order and Review Gates

Tasks are sequential because the reconciler must reuse the marker contract and repository identity checks before discovery and orchestration can safely depend on them.

1. Task 1 — shared marker verification and repository identity.
2. Task 2 — cursor discovery and checkpoint state.
3. Task 3 — stale-evidence classification and orchestration.
4. Task 4 — scheduled/manual workflow and per-PR isolation.
5. Task 5 — end-to-end adversarial verification and audit record.

Each task is independently reviewable and must be green before the next task begins. No task merges into `main`. A single Draft PR may be prepared from the implementation branch only after all five task commits are verified. The Draft PR is not authorization to merge or activate the schedule.

## Operational Retry, Recovery, and Fairness Policy

This policy is the required implementation contract for retry accounting, checkpoint progression, and uncertain external side effects. It replaces the former consecutive-run counter proposal. The per-run ceiling of three inference attempts remains unchanged.

### 1. Immutable work identity and policy version

A retry record is keyed by the exact tuple:

`(repositoryId, pullRequestNumber, headSha, baseSha)`

- `repositoryId` is the numeric GitHub repository ID, not an owner/name string.
- `pullRequestNumber` is a positive integer scoped to that repository ID.
- `headSha` and `baseSha` are full, lower-case 40-character commit SHAs.
- The record also stores `policyVersion: 1`; a policy-version mismatch is not silently migrated and yields `UNKNOWN` pending a controlled checkpoint migration.
- A changed head SHA or base SHA creates a new work identity. It does not inherit the prior tuple's inference count.
- A valid authenticated marker for the exact current tuple resolves the work item and suppresses further inference.

Repository identity, PR number, head SHA, and base SHA must be revalidated from authoritative GitHub metadata immediately before an inference dispatch and immediately before publication.

### 2. Separate attempt classes and accounting

The implementation MUST maintain separate counters and dispositions for:

1. **Discovery / metadata reads** — do not consume inference budget.
2. **Pre-dispatch transport attempts** — do not consume inference budget if the system can prove the model request was never dispatched.
3. **Dispatched inference attempts** — consume one inference attempt as soon as a request may have reached the 9Router service. A timeout, connection loss, malformed response, process cancellation, or lost response after dispatch is counted conservatively because billing and execution may have occurred.
4. **Publication attempts** — are tracked independently from inference attempts. They are never blindly repeated after an ambiguous outcome.

A transport retry is permitted only for a provably pre-dispatch transient failure (network connection failure before request transmission, HTTP 429, or HTTP 5xx). It is limited to one retry per operation, must honor a valid `Retry-After` value, and must remain within the run deadline. Authentication/authorization failures, malformed requests, schema violations, 4xx responses other than 429, and exhausted deadlines are not retried automatically.

### 3. Per-tuple inference budget and cooldown

- Maximum dispatched inference attempts for one exact tuple: **3 total**, across all scheduled and manually dispatched runs.
- Attempt 1 is the initial eligible review.
- Attempt 2 is eligible no earlier than **6 hours** after attempt 1 was dispatched.
- Attempt 3 is eligible no earlier than **24 hours** after attempt 2 was dispatched.
- A retry is eligible only if the prior outcome is explicitly classified as retryable, the tuple is still current, the PR remains open/non-draft/same-repository, no valid current-pair marker exists, and the cooldown has elapsed.
- Deterministic invalidity (wrong repository, fork, draft/closed PR, invalid marker, incomplete evidence, invalid candidate schema, or failed identity revalidation) is not an inference retry. It is excluded or recorded as `BLOCKED_UNKNOWN` until a new authoritative state permits reclassification.
- After the third dispatched attempt has a retryable or uncertain failure, the tuple enters terminal `QUARANTINED_UNKNOWN`. It is not automatically re-queued by a new scan generation. Recovery requires a changed head/base tuple, authenticated evidence that resolves the work, or a separately authorized and auditable operator reset. No operator-reset mechanism is added by this plan.

The cooldown is a minimum delay, not a guarantee that a retry will run at the exact boundary. Global run budgets, rate limits, and candidate fairness still apply.

### 4. Per-run budget and fairness

The approved global ceiling remains **3 dispatched inference attempts per reconciler run**.

- At most **1 slot** may be allocated to an eligible deferred retry.
- At least **2 slots** remain reserved for first-time candidates discovered in the current scan.
- If no eligible deferred retry exists, the reserved retry slot remains unused; it is not converted into a second deferred retry slot.
- If fewer than two new candidates exist, unused new-candidate capacity may remain idle; it is not used to exceed the one-retry ceiling.
- Deferred retries are selected deterministically by earliest `nextEligibleAt`, then repository ID, PR number, head SHA, and base SHA.
- New candidates retain deterministic discovery order.
- A candidate that cannot be processed within the remaining run budget is not consumed from the discovery cursor. The checkpoint remains immediately before that candidate so a later run can reconsider it.
- A single repeatedly failing PR therefore cannot consume more than one inference slot in any run or starve all newly discovered candidates.

### 5. Write-ahead attempt reservation and crash recovery

Before dispatching an inference request, the runner MUST durably reserve the attempt in the run's authenticated checkpoint state:

- Generate a unique `attemptId` and record the tuple, ordinal (1–3), run ID, run attempt, dispatch intent timestamp, and state `DISPATCH_RESERVED`.
- Persist and validate that reservation before sending the external request.
- Transition to `DISPATCHED` only at the dispatch boundary; persist a terminal result when known.
- If a process or workflow terminates with a reservation whose dispatch outcome cannot be proven, treat it as `UNKNOWN` and do not automatically dispatch the same ordinal again.
- A workflow rerun must not replay an existing `DISPATCH_RESERVED` or `DISPATCHED` attempt. It must reconcile the attempt record and enter a safe terminal disposition or quarantine it.
- Checkpoint cursor advancement and retry-ledger updates must be committed as one logical checkpoint artifact. Never advance the cursor while losing the retry record for a candidate that was consumed.

The artifact is not a transactional database. If the artifact cannot be durably written or its provenance/digest cannot be verified, do not dispatch inference and do not advance the cursor.

### 6. Publication ambiguity and duplicate prevention

- A publication request with a definitive successful response is recorded as `PUBLISHED`; the authenticated current-pair marker must subsequently be verified before the work item is considered `RESOLVED`.
- A definitive pre-send failure may be retried only under the single transport retry rule above.
- A timeout, connection loss, cancellation, or malformed response after a comment POST may have been sent is `PUBLICATION_UNKNOWN`.
- For `PUBLICATION_UNKNOWN`, do not issue another comment POST and do not start another inference for the tuple. Later runs may perform bounded, read-only marker-history reconciliation.
- If a complete, authenticated history read finds the exact current-pair marker, mark `RESOLVED`.
- If history is incomplete, over budget, malformed, or contradictory, preserve `PUBLICATION_UNKNOWN`; do not infer absence.
- If complete history does not establish whether the earlier POST took effect, retain `QUARANTINED_UNKNOWN`. This plan makes no exactly-once publication claim and does not invent a provider idempotency guarantee.

### 7. State machine and allowed transitions

The retry ledger uses these explicit states:

| State | Meaning | Automatic action |
|---|---|---|
| `ELIGIBLE_NEW` | Current tuple has no prior dispatched attempt and passes all evidence gates | May reserve one new-candidate slot |
| `RETRY_WAIT` | A retryable dispatched attempt is known and cooldown has not elapsed | Read-only checks; no inference |
| `ELIGIBLE_RETRY` | Retryable prior attempt, cooldown elapsed, tuple still valid, budget remains | May reserve the single deferred-retry slot |
| `DISPATCH_RESERVED` | Write-ahead attempt reservation exists; dispatch outcome not yet established | Never replay; reconcile or quarantine |
| `DISPATCHED` | Request may have reached 9Router; terminal outcome not yet established | Never replay same attempt ordinal |
| `PUBLICATION_UNKNOWN` | Comment POST may have succeeded but outcome is ambiguous | Read-only marker reconciliation only |
| `RESOLVED` | Exact current-pair authenticated marker is verified | No further inference |
| `BLOCKED_UNKNOWN` | Required evidence/state is incomplete, contradictory, or invalid | No inference; re-evaluate only after authoritative state changes |
| `QUARANTINED_UNKNOWN` | Attempt budget exhausted or external side effect cannot be safely reconciled | No automatic inference or publication |
| `NOT_ELIGIBLE` | PR is closed, draft, fork-originated, or otherwise outside the approved scope | No inference |

All transitions must be explicit, deterministic, and covered by tests. Illegal or unrecognized transitions fail closed. `UNKNOWN` is never coerced into success or failure.

### 8. Checkpoint persistence, fairness, and generation boundaries

The checkpoint MUST persist the retry ledger alongside the cursor and generation boundary. The schema must include `generationId`, `policyVersion`, and a bounded `retryLedger`; the schema example and validator must use the same field names.

- Retry records are sorted and serialized deterministically.
- Enforce explicit maximum record count and serialized-byte limits. If either limit is exceeded, stop safely with `UNKNOWN`; never silently drop old retry records.
- A scan generation completes only after every record through its captured high-water boundary has a durable disposition.
- A failed or uncertain candidate may be passed by the discovery cursor only after its retry record and disposition are durably included in the same verified checkpoint artifact.
- If the run stops before checkpoint finalization, the previous checkpoint remains authoritative; the next run replays from the last fully committed cursor and deduplicates by immutable tuple and attempt ID.
- A new generation does not reset a tuple's attempt count or quarantine state.
- Checkpoint loss or invalid provenance triggers a safe bootstrap, but does not authorize resetting a retry budget from untrusted or incomplete state. If prior retry history cannot be recovered, mark affected work `UNKNOWN` and require controlled recovery rather than assuming zero attempts.

### 9. Required adversarial tests and acceptance criteria

The implementation is not acceptable until tests prove all of the following:

- The same tuple never exceeds three dispatched inference attempts across multiple workflow runs.
- Attempt 2 and 3 cannot dispatch before their respective 6-hour and 24-hour cooldowns.
- One deferred retry maximum is enforced per run, while at least two new-candidate slots remain reserved.
- A retryable failure does not block cursor progress after its ledger entry is durably committed.
- A candidate beyond the per-run budget is not consumed from the cursor.
- A changed head or base SHA creates a new tuple; an unchanged tuple does not reset its count on a new scan generation or workflow rerun.
- A workflow crash after reservation cannot cause the same attempt ordinal to be dispatched again.
- A request that may have reached 9Router consumes the attempt budget conservatively.
- An ambiguous comment POST never triggers a second POST or another inference for the same tuple.
- Complete authenticated current-pair marker evidence resolves the tuple; incomplete or contradictory history does not.
- Missing, tampered, oversized, incompatible, or provenance-invalid checkpoint state prevents inference and cursor advancement.
- Rate limits, 5xx, timeouts, cancellations, malformed model output, and process restarts produce the exact state transitions specified above.
- No test treats `UNKNOWN` as success or failure.

Required deterministic test fixtures must cover state-transition legality, cooldown boundaries, cross-run accounting, fairness, crash recovery, checkpoint atomicity, and publication ambiguity. The test suite must report each disposition as `PASS`, `FAIL`, `UNKNOWN`, or `NOT TESTED`.

### Approval boundary

This rewritten policy is a proposed operational contract for the implementation plan. It does not authorize code implementation, workflow activation, secret changes, repository settings changes, PR merge, or Production operations. Implementation remains blocked until this policy and the revised plan are explicitly approved.

## Explicitly Out of Scope

- Merging any PR or changing the default branch.
- Activating the schedule or manual workflow from the default branch.
- Changing GitHub secrets, variables, permissions outside the new workflow's least-privilege job declarations, branch protection, Rulesets, Actions policies, or repository settings.
- Modifying PR #261 or PR #262 state.
- Running live 9Router inference during implementation tests.
- Claiming exactly-once publication; GitHub PR metadata and issue-comment creation do not share a transaction.
- Treating UNKNOWN or incomplete scans as success or failure.
