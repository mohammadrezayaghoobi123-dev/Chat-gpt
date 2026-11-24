# Finding 67: Scheduled PR Review Reconciler Design

**Status:** Design decision updated; implementation blocked  
**Date:** 2026-11-23  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Design branch:** `docs/9router-finding-67-reconciler-design`  
**Related work:** PR #261 and PR #262; Finding 67 in `tools/9router-review/README.md`

## 1. Executive decision

Implement a bounded, default-branch-controlled reconciler that detects open pull requests whose previously published independent review has become stale solely because the target/base branch advanced while the PR head remained unchanged.

The reconciler is a freshness-recovery mechanism, not a general review scheduler. It must not initiate reviews for PRs that have never received a valid signed report, and it must not replace the existing event-driven signal, resolver, immutable-snapshot reviewer, or publication safeguards.

The approved initial operating envelope is:

| Control | Initial limit |
|---|---:|
| Scheduled interval | Every 6 hours |
| PR records inspected per run | At most 200 |
| New review/inference attempts per run | At most 3 |
| Concurrent reconciler runs | 1 |
| Comment-history pages per PR | At most 10 |
| Serialized comment-history bytes per PR | At most 4 MiB |
| Eligible PR state | Open, non-draft, same-repository |
| Side effects | Report-only comment publication; no approval or merge |

These are hard ceilings, not targets. A run may inspect fewer records or perform zero inferences.

## 2. Problem statement and invariant

GitHub's `pull_request.synchronize` activity is associated with changes to the PR head. Advancing the target branch does not, by itself, guarantee a PR synchronize event. Consequently, an earlier report can become superseded while no new review is scheduled.

The central invariant is:

> A reconciler-triggered review is permitted only when an authentic, valid prior report exists for the same repository, PR number, and exact head SHA, but for an older base SHA, and no valid report exists for the current head/base pair.

A PR with no valid prior signed report is not a reconciler candidate. New and head-updated PRs remain the responsibility of the existing event-driven workflow.

## 3. Goals and non-goals

### Goals

- Detect base-only freshness changes that the event-driven trigger graph does not cover.
- Reuse the existing reviewer and its immutable snapshot / fail-closed controls.
- Bound API work, comment-history reads, model inference, concurrency, and runtime.
- Preserve deterministic, auditable candidate selection.
- Prevent stale snapshots, duplicate reports, untrusted workflow code, and malformed state from causing publication.
- Make incomplete discovery and uncertain state explicit.

### Non-goals

- Reviewing every open PR on a schedule.
- Reviewing PRs without a previously valid signed report.
- Replacing the current PR signal/resolver pipeline.
- Running code, workflows, or scripts from PR heads.
- Approving, requesting changes, merging, rebasing, closing, or retargeting PRs.
- Deploying or changing Production.
- Modifying secrets, repository settings, Actions policies, branch protection, or Rulesets.
- Activating a schedule before the workflow is separately approved and present on the default branch.

## 4. Architecture and trust boundaries

The reconciler consists of six separately testable stages:

1. **Discovery** — enumerate a bounded, paginated window of open PR metadata.
2. **Evidence validation** — read bounded comment history and authenticate prior report markers.
3. **Staleness detection** — identify a valid old-base report for the exact current head and verify absence of a current-pair report.
4. **Snapshot and revalidation** — capture the candidate's exact repository/PR/head/base tuple and re-read it immediately before inference.
5. **Independent review** — invoke the existing report-only reviewer with the exact expected head and base SHAs.
6. **Publication and audit** — revalidate the tuple again before publication and record a machine-readable run disposition.

### Trust boundaries

- The scheduled workflow must execute only from the trusted default branch.
- Checkout must explicitly select the default branch; no PR head, merge ref, artifact-provided executable, or branch-controlled script may be executed.
- PR titles, bodies, comments, filenames, commit messages, and marker text are untrusted data.
- Only the existing HMAC marker verifier may decide whether a historical report marker is authentic. The reconciler must not implement a second, weaker marker parser.
- Workflow checkpoint artifacts are untrusted input until their workflow identity, run metadata, schema, version, and digest are validated.
- 9Router output remains untrusted model output and is subject to the existing report sanitization and publication contract.

## 5. Six-stage processing contract

### Stage A — Discovery

- Enumerate open PRs through the GitHub API with explicit pagination.
- Consider at most 200 PR records per run.
- Filter to same-repository, open, non-draft PRs with complete head/base repository identities and valid 40-character commit SHAs.
- Reject or skip malformed, deleted-head-repository, cross-repository, closed, merged, or draft records.
- Do not infer completeness from a partial page sequence.
- Record pages, records, cursor/checkpoint state, and any API truncation.

**Output:** a bounded ordered set of candidate PR metadata plus a discovery-completeness status.

### Stage B — Evidence validation

For each eligible PR:

- Read issue-comment history using the existing hard limits: no more than 10 pages and no more than 4 MiB serialized response data.
- Require complete pagination. If the page limit is reached while another page may exist, classify the PR's evidence state as incomplete and do not infer.
- Recognize only comments authored by the expected GitHub Actions bot identity and carrying the exact existing marker format.
- Validate marker HMAC using the existing verifier and currently permitted key-rotation rules.
- Bind the marker to the exact repository identity, PR number, head SHA, and base SHA.
- Reject duplicate valid markers for the same head/base pair as ambiguous.
- Treat missing, malformed, expired, invalidly signed, or incomplete evidence as non-candidate / UNKNOWN; never reinterpret it as evidence that a review is absent.

**Output:** authenticated report tuples for that PR, or an explicit evidence failure classification.

### Stage C — Staleness detection

A PR becomes a candidate only when all conditions hold:

1. The PR is still open and non-draft.
2. The head repository is the same repository as the target repository.
3. At least one valid historical marker matches the current PR number and exact current head SHA.
4. The historical marker's base SHA differs from the current base SHA.
5. No valid marker exists for the exact current head/base pair.
6. Comment history and API pagination are complete.
7. No conflicting or duplicate valid current-pair marker exists.

If multiple old-base markers exist for the same head, the PR is still one candidate; the audit record must preserve the marker evidence needed to explain the decision. No inference is allowed when marker evidence is ambiguous.

### Stage D — Snapshot and revalidation

Construct an immutable candidate tuple:

`(repository_id, repository_full_name, pull_request_number, head_repository_id, head_sha, base_sha)`

Before inference:

- Fetch the PR again from GitHub.
- Require exact equality of repository identity, PR number, head repository identity, head SHA, base SHA, open state, and non-draft state.
- Revalidate that the candidate still has a qualifying historical marker and lacks a current-pair marker, or use an explicitly versioned evidence snapshot whose provenance is verified and whose age is within the run deadline.
- If any field changed, stop processing that candidate as `STALE_SNAPSHOT`; do not infer.

The reviewer must independently repeat its existing live-state checks. The reconciler's preflight check is not a substitute for reviewer validation.

### Stage E — Independent review

- Invoke the existing reviewer entry point with the exact expected head and base SHAs.
- Do not create a second implementation of diff construction, marker signing, model prompting, report sanitization, or comment publication.
- Do not invoke inference for candidates that failed any prior stage.
- Enforce no more than three new review attempts per run.
- A timeout, API error, invalid configuration, rate limit, model error, or uncertain reviewer result consumes the attempt budget if inference may have started; it must not be retried repeatedly within the same run.
- The reviewer remains report-only.

### Stage F — Publication and audit

Immediately before publication:

- Re-fetch the PR and require exact equality with the candidate tuple.
- Recheck that the PR remains open and non-draft and that the head repository remains the same repository.
- Recheck current-pair report uniqueness.
- If head or base changed, or another current-pair report appeared, abort publication.
- Publish at most one report for the exact tuple. Duplicate or conflicting publication state is an error/UNKNOWN, not success.
- Record the final disposition and evidence references in the run summary without secrets, tokens, raw HMAC keys, or unnecessary comment contents.

## 6. State machine and dispositions

The reconciler must expose explicit machine-readable states:

| State | Meaning | May infer? | May publish? |
|---|---|---:|---:|
| `DISCOVERED` | PR metadata passed basic shape checks | No | No |
| `EVIDENCE_VALID` | Complete history and authentic markers verified | No | No |
| `NOT_STALE` | No qualifying old-base/current-head marker relationship | No | No |
| `CANDIDATE` | All stale-report predicates satisfied | Not yet | No |
| `SNAPSHOT_VALID` | Exact live tuple revalidated | Yes | No |
| `REVIEW_IN_PROGRESS` | Existing reviewer invoked | In progress | No |
| `PUBLISHED` | Exact tuple revalidated and one report published | Complete | Yes |
| `SKIPPED` | Ineligible or no candidate | No | No |
| `STALE_SNAPSHOT` | Head/base/repository/state changed | No further work | No |
| `INCOMPLETE_SCAN` | Discovery pagination or scan budget incomplete | Only for already validated candidates | No claim of full coverage |
| `UNKNOWN` | Evidence or external state cannot be established | No further work for affected candidate | No |
| `FAILED` | Deterministic internal or contract failure | No further work for affected candidate | No |

A run-level success must not imply that every open PR was examined. Partial coverage must remain visible.

## 7. Fairness, bounded discovery, and checkpoint design

A fixed first-page scan can starve older PRs when the repository has more than 200 open PRs. The implementation must therefore use a resumable, bounded discovery cursor rather than repeatedly scanning only the newest page range.

The proposed checkpoint is an immutable artifact emitted by the trusted reconciler workflow and consumed by a later run. It contains only versioned discovery state, such as the last completed page/window position and the scan generation. It must not contain secrets or PR comment bodies.

Checkpoint acceptance requires all of the following:

- The artifact belongs to the exact reconciler workflow ID and expected workflow path.
- The source run belongs to this repository, was executed from the default branch, and was triggered by the expected schedule or manual dispatch.
- The source run completed successfully and the artifact digest matches GitHub's artifact metadata.
- The checkpoint schema version is supported and all fields are range-checked.
- The checkpoint is compatible with the current default-branch workflow version.
- The checkpoint age is within a bounded retention window.

If a checkpoint is missing, expired, malformed, incompatible, or unverifiable, the reconciler must bootstrap from the beginning and report that fairness coverage is being re-established. It must not silently claim full coverage.

Discovery ordering must be deterministic. The implementation must account for page drift caused by PRs opening or closing during pagination. A cursor is an optimization, not proof of complete enumeration. The run must record its scan window and report `INCOMPLETE_SCAN` when it cannot establish complete traversal of that window.

The exact checkpoint artifact lookup, pagination semantics, and recovery behavior must be covered by contract tests before implementation is accepted.

## 8. Scheduling, concurrency, and resource budgets

- Schedule: every six hours.
- Manual dispatch: supported for controlled diagnostics and recovery; it obeys identical limits.
- Concurrency: one active reconciler run for the repository; a newer scheduled run must not create parallel inference.
- Discovery cap: 200 PR records per run.
- Inference cap: three attempts per run.
- Comment history: 10 pages / 4 MiB per PR.
- Runtime: explicit workflow and request deadlines; no unbounded retries.
- API rate limits: honor GitHub retry metadata only within the run deadline; otherwise stop and report UNKNOWN.
- Cancellation: cancelled or timed-out runs must not publish from incomplete work. A later run resumes from the last verified checkpoint, not from partially written mutable state.
- Budget accounting: distinguish PRs enumerated, PRs evidence-validated, candidates, inference attempts, publications, skips, and unknowns.

## 9. Permissions and workflow hardening

The implementation must begin with least-privilege permissions and justify every permission in the implementation plan.

Expected permission categories:

- `contents: read` for trusted default-branch code.
- `pull-requests: read` for PR metadata.
- `issues: read` only if required by the selected comment-history API path.
- `pull-requests: write` or the narrowly required issue-comment write permission only in the publication job.
- `actions: read` only if required to validate and retrieve the previous trusted checkpoint artifact.

No `contents: write`, administration, repository settings, Actions policy, branch-protection, or Ruleset permission is authorized by this design.

Separate discovery/evidence work from publication where practical. The job that receives write permission must not execute PR-controlled code or consume unvalidated executable artifacts. Pin third-party actions to immutable commit SHAs and keep Node/runtime/dependency installation aligned with the existing reviewer contract.

The workflow must fail closed if required marker keys are absent, invalid, or outside their allowed rotation window. Secrets must never be printed, copied into artifacts, or included in failure summaries.

## 10. Error handling and recovery

| Failure | Required behavior |
|---|---|
| GitHub API 401/403/429/5xx | Stop affected work; honor bounded retry metadata; classify UNKNOWN if state cannot be established |
| Incomplete PR pagination | Mark run INCOMPLETE_SCAN; do not claim full coverage |
| Incomplete comment pagination | Mark PR UNKNOWN; do not infer |
| Invalid or expired HMAC | Reject marker evidence; do not treat it as a valid prior report |
| Multiple valid markers for same tuple | Stop affected PR as ambiguous |
| Missing/invalid checkpoint | Bootstrap safely; disclose coverage reset |
| Head/base changed before inference | STALE_SNAPSHOT; no inference |
| Head/base changed before publication | Abort publication |
| Existing current-pair marker appears | Suppress duplicate publication |
| 9Router timeout or malformed response | No publication; record UNKNOWN/FAILED as appropriate |
| Concurrent workflow attempt | Serialize; do not exceed inference budget |
| Cancellation | No partial-success claim; resume from last verified checkpoint |

Retries must be idempotent with respect to the exact `(repository, PR, head SHA, base SHA)` tuple. An uncertain publication result must be reconciled against GitHub before any retry.

## 11. Adversarial verification matrix

The following cases are mandatory before implementation can be considered ready:

| Test | Adversarial condition | Expected result |
|---|---|---|
| T01 | Base advances; head is unchanged; valid old-base report exists | Candidate discovered |
| T02 | No prior valid signed report | No inference |
| T03 | Prior marker has wrong PR number or repository | Evidence rejected |
| T04 | Prior marker has wrong head SHA | No candidate |
| T05 | Prior marker HMAC is invalid | No inference |
| T06 | Previous key is within approved rotation window | Marker accepted only under existing rotation policy |
| T07 | Previous key is expired | Marker rejected |
| T08 | Current head/base marker already exists | No duplicate inference/publication |
| T09 | Duplicate valid current-pair markers exist | Ambiguous; fail closed |
| T10 | Comment history exceeds page or byte limit | UNKNOWN; no inference |
| T11 | PR is draft, closed, merged, or from a fork | Excluded |
| T12 | Head changes after discovery | STALE_SNAPSHOT |
| T13 | Base changes after discovery | STALE_SNAPSHOT |
| T14 | Head or base changes during inference | No publication |
| T15 | Current-pair report appears before publication | Publication suppressed |
| T16 | PR count exceeds 200 | Bounded scan; checkpoint advances; no full-coverage claim |
| T17 | Checkpoint artifact is tampered, malformed, stale, or from another workflow | Reject checkpoint and bootstrap safely |
| T18 | PRs open/close between paginated requests | No false completeness claim; cursor recovery tested |
| T19 | Two scheduled/manual runs overlap | Single active run; budget not multiplied |
| T20 | GitHub rate limit or transient 5xx | Bounded stop/retry; UNKNOWN if unresolved |
| T21 | 9Router timeout or invalid output | No publication |
| T22 | Publication succeeds remotely but response is lost | Reconcile exact marker before retry |
| T23 | PR-controlled artifact attempts to influence execution | No PR artifact execution |
| T24 | Secrets appear in error text or model response | Sanitized; no secret in logs/artifacts |
| T25 | Checkpoint is lost after successful inference | Later run safely rediscovers; duplicate guard prevents second report |
| T26 | Workflow source changes on default branch | Incompatible checkpoint invalidated or explicitly migrated |

Tests must include deterministic fixtures and explicit assertions that inference and publication were not called on all negative paths. Passing related tests does not establish untested API, event, or hosted workflow behavior.

## 12. Acceptance gates

### Design Gate — this document

- Six-stage contract is defined.
- Trust boundaries, state machine, budgets, fairness, failure handling, and adversarial tests are explicit.
- No implementation or live workflow activation is implied.

### Implementation Gate — separately authorized after spec review

- Implement only on a new isolated branch based on the reviewed source branch.
- Reuse the existing marker verifier and reviewer entry point.
- Add deterministic unit, contract, integration, and negative-path tests.
- Do not alter `main`, Production, secrets, repository settings, permissions, Rulesets, or branch protection.
- Do not activate schedule or dispatch from the default branch.

### Verification Gate — before any PR is called ready

- TDD RED evidence for at least one representative base-advance regression.
- GREEN results for the full contract suite on the exact final commit.
- Secret scanning and dependency-signature verification.
- Independent adversarial review of the diff and workflow permissions.
- Explicit list of PASS, FAIL, UNKNOWN, and untested hosted behaviors.
- PR remains Draft until separately instructed; no merge or deployment.

## 13. Activation boundary

GitHub scheduled workflows are evaluated from the default branch. A workflow file added only to a feature branch does not activate the schedule for the repository's default branch.

Therefore this design permits documentation and branch-local implementation/testing only. Activation requires a separate explicit approval to merge the reviewed workflow into the default branch. That approval is not included here.

## 14. Evidence and decision record

Finding 67 is currently classified as a design/availability gap: the existing signal list does not provide a guaranteed new review when only the base branch advances. The current reviewer snapshot checks reduce stale-publication risk but do not guarantee freshness.

The prior Finding 67 record in `tools/9router-review/README.md` remains the evidence record for the original observation and cited GitHub event semantics. This design does not claim that a live scheduled workflow, live 9Router inference, or hosted publication has been tested.

**Approved scope:** write and review this design document on an isolated documentation branch only. Implementation, workflow activation, PR merge, and Production changes remain separate decisions.


## 15. Durable attempt-ledger decision — GitHub-native feasibility gate

### Decision

**GitHub-native PR comments are rejected as the authoritative cross-run attempt ledger.** They may remain human-visible audit evidence, but they cannot prove the required durable reservation invariant under the currently approved permission boundary.

This is a design decision, not an implementation failure. No live duplicate inference or comment deletion is alleged.

### Evidence and falsification

1. The existing reviewer publishes report markers through PR issue comments. GitHub exposes separate create, update, and delete operations for issue comments. A signed comment body can therefore be edited or removed by an actor with sufficient repository permissions; HMAC authenticity detects modification of a surviving marker but cannot prove that a missing marker was never created. The create-comment endpoint also does not provide a caller-supplied idempotency key or an atomic unique constraint on the reservation tuple.
2. The current design explicitly prohibits `contents: write` and repository administration permissions. A dedicated Git ref with compare-and-swap/force-with-lease semantics is a plausible GitHub-native ledger candidate, but it requires permission and workflow changes outside the approved boundary. It is not authorized by this decision.
3. Workflow artifacts/checkpoints are useful for discovery progress, but the current design does not establish them as a durable, atomic, cross-run uniqueness primitive. Artifact presence, retention, and deletion do not provide the required compare-and-set contract.

### Consequence

- Do not represent a PR comment reservation as durable at-most-once state.
- Do not claim cross-run duplicate-inference prevention from HMAC authenticity alone.
- Keep the existing report marker as report evidence only.
- Keep scheduled inference blocked until an external ledger (or a separately approved GitHub ref design with revised permissions and threat model) passes the ledger acceptance contract.
- If no durable ledger can be reached or verified, the reconciler must not invoke 9Router. It may run in dry-run/discovery-only mode and report `LEDGER_UNAVAILABLE`.

### Required external-ledger contract

The next design candidate must provide:

- atomic insert-if-absent or compare-and-set keyed by the canonical tuple `(repository_id, pull_request_number, head_sha, base_sha)`;
- durable reservation persistence across workflow runs and process restarts;
- a unique reservation ID and authenticated binding to workflow ID, run ID, run attempt, schema version, and creation time;
- append-only or tamper-evident transition history, with explicit retention and recovery semantics;
- an idempotent reservation API whose ambiguous response can be reconciled by reading the exact key;
- least-privilege credentials isolated from PR-controlled inputs;
- bounded latency, request quotas, data size, and operational cost;
- a tested outage mode that fails closed before inference.

The ledger reservation must be committed before the 9Router request. A timeout after reservation remains `ATTEMPT_UNKNOWN` and is never automatically re-armed. This is an at-most-once automatic dispatch policy, not an exactly-once execution guarantee.

### Acceptance tests

- Two concurrent reservations for the same tuple: exactly one succeeds; the other reads the existing reservation.
- Same PR with a different head or base SHA: distinct tuple, no collision.
- Client loses reservation response after server commit: read-after-uncertain-write resolves the exact reservation; no second reservation is created.
- Ledger unavailable, stale, or authentication-invalid: zero 9Router requests and zero report writes.
- Reservation committed, then process crashes before inference: subsequent run treats the tuple as reserved/unknown; no automatic retry.
- Inference accepted but response lost: subsequent run observes the reservation and does not dispatch again.
- Reservation state tampering or rollback: detected or classified unknown; never treated as an unreserved tuple.

### Approval boundary

This decision does not select or provision a vendor, create an account, add secrets, alter workflow permissions, or authorize implementation. A separate design review must compare available external ledger options against the contract above before any integration work.
