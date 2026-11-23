# Hostile Design Review — 9Router PR Reconciler

**Review date:** 2026-11-23  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Reviewed design commit:** `ee3a80ccfe6d1e6c0d5f1b64ca2b9211200c92c1`  
**Design file:** `docs/specs/2026-11-23-9router-finding-67-reconciler-design.md`  
**Review branch:** `docs/9router-finding-67-reconciler-design`  
**Disposition:** **CONDITIONALLY ACCEPTABLE — IMPLEMENTATION BLOCKED**  
**Scope:** documentation-only; no source code, workflow, permission, secret, repository setting, default-branch, merge, or deployment change.

## 1. Executive result

The six-stage design correctly narrows the reconciler to base-only freshness recovery, reuses the existing reviewer, rejects PRs without an authentic prior report, and defines explicit fail-closed dispositions. The design is not yet implementation-ready.

Four design gaps must be closed before code is written:

1. Per-PR limits multiply into a large per-run and per-day resource envelope.
2. The per-run inference limit does not prevent repeated inference after an ambiguous request across later workflow runs.
3. Reconciler serialization is not explicitly shared with the existing event-driven reviewer.
4. The discovery checkpoint is described as a cursor/window, but the concrete pagination and page-drift contract is not specified tightly enough to prove fairness.

These are design-level gaps. No live exploit or billed duplicate request is claimed.

## 2. Finding R1 — per-PR limits do not bound total run cost tightly enough

### Evidence and bound

The design permits up to 200 PR records, up to 10 comment-history pages per PR, and up to 4 MiB of serialized comment history per PR.

The resulting theoretical ceilings are:

- `200 × 10 = 2,000` comment-history page requests per run.
- `200 × 4 MiB = 800 MiB` of comment-history response data per run.
- With a six-hour schedule, four scheduled runs can occur in 24 hours: up to `3,200 MiB = 3.125 GiB` of comment-history data per day, before discovery, revalidation, retries, or other API traffic.

The design also permits three inference attempts per run. A six-hour schedule therefore allows up to 12 scheduled attempts per day. Because manual dispatch is also described as supported, the document does not establish a finite daily inference ceiling for repeated manual runs.

These are mathematical upper bounds implied by the design's current limits, not observed consumption.

### Required correction

Define hard, cumulative run-wide budgets in addition to per-PR limits. Proposed initial ceilings for design review:

| Resource | Per-run hard ceiling |
|---|---:|
| PR records considered | 200 |
| GitHub API requests, including retries | 500 |
| Aggregate response bytes | 64 MiB |
| Aggregate comment-history bytes | 32 MiB |
| Comment-history pages per PR | 10 |
| Comment-history bytes per PR | 4 MiB |
| Maximum response body per API request | 1 MiB |
| New 9Router requests | 3 |
| Overall reconciler runtime | 45 minutes |

The numbers above are conservative initial engineering limits, not measured production requirements. They must be configurable only through reviewed constants or trusted workflow variables, never PR-controlled data.

Every request must reserve request/byte budget before dispatch and debit actual received bytes. Retries consume the same budget. Exceeding a hard budget yields `INCOMPLETE_SCAN` or `UNKNOWN`; it must not silently skip a PR or claim full coverage.

Before inference, reserve enough remaining request budget for the reviewer's own mandatory live-state and publication revalidation. If that reservation cannot be made, do not invoke 9Router.

Manual dispatch must be dry-run only in the initial release. A manual run that can invoke 9Router must consume the same approved cross-run quota as scheduled execution; otherwise the stated per-run limit is not a meaningful cost control.

## 3. Finding R2 — ambiguous inference outcomes can repeat across runs

### Failure sequence

1. A candidate passes discovery, evidence validation, and snapshot revalidation.
2. The reconciler sends a request to 9Router.
3. 9Router may accept/process the request, but the client times out or loses the response.
4. No report comment is published, so the next six-hour run sees no current-pair report.
5. The design's three-attempt limit has reset with the new workflow run.
6. The same exact `(repository, PR, head SHA, base SHA)` tuple can be inferred again, potentially duplicating model cost.

The design says an uncertain attempt consumes the current run's budget, but it does not define durable per-tuple state that survives the next run. The checkpoint described in Section 7 is discovery progress, not an inference-attempt ledger.

### Required correction

Add an append-only, authenticated reservation to a durable attempt ledger before the first 9Router request is sent. PR comments are report evidence only; they are not the authoritative reservation store.

The reservation must bind at least:

- repository ID and canonical full name;
- PR number;
- exact head SHA and base SHA;
- reservation schema/version;
- originating workflow ID, run ID, and run attempt;
- a unique reservation identifier and creation timestamp.

The reservation must use the existing HMAC marker primitives and a distinct, strictly parsed marker type. Do not create a second permissive signature parser.

Required behavior:

- A matching final report marker means the tuple is already completed.
- A valid reservation with no matching final report means `UNKNOWN` / attempt already consumed; automatic inference is forbidden.
- An ambiguous ledger reservation write must be reconciled by reading the exact tuple key. If reservation existence cannot be established exactly, stop before the model request.
- A 9Router timeout, lost response, process cancellation, or uncertain request acceptance leaves the tuple reserved. Do not automatically retry it in a later scheduled run.
- An operator-controlled recovery procedure may re-arm a tuple only after explicitly resolving the previous attempt; that procedure is outside the scheduled reconciler's automatic path.
- Ledger reservation records are append-only. PR report comments remain human-visible evidence and must not be edited or deleted to make a retry appear safe.

This provides at-most-once automatic attempts for a tuple within the marker-retention/trust boundary. It does **not** claim exactly-once model execution or protect against a repository writer deliberately deleting authenticated comments. Those limitations must remain explicit.

## 4. Finding R3 — concurrency is not shared with the existing reviewer

The current event-driven reviewer uses a PR-scoped GitHub Actions concurrency group:

`9router-pr-review-${PULL_REQUEST_NUMBER}`

The reconciler design only specifies one active reconciler run for the repository. That does not explicitly serialize a reconciler-triggered review against an event-driven review for the same PR.

A possible race is:

1. Event-driven reviewer and reconciler both read comment history before either publishes a current-pair marker.
2. Both independently conclude that the same tuple needs review.
3. Both invoke 9Router and may publish duplicate reports.

GitHub documents that concurrency groups can be shared across workflow runs in the same repository. Therefore the implementation should use the **same exact PR-scoped group** in both paths, not a separate reconciler-only group. Use non-cancelling serialization; specify the pending queue behavior explicitly and account for GitHub's queue cap. The durable reservation in R2 remains necessary because serialization alone does not resolve a lost model response.

### Required tests

- Event-driven review holds the PR group while reconciler becomes pending.
- Reconciler holds the PR group while event-driven review becomes pending.
- A queued run re-fetches PR metadata and marker history after acquiring the group; it must not reuse pre-queue evidence.
- A queued run cannot exceed the run-wide API or inference budget.
- A cancellation or queue overflow is reported as skipped/incomplete, not as a successful review.

## 5. Finding R4 — pagination/checkpoint semantics are underspecified

The design correctly warns that a fixed first-page scan can starve older PRs and that page drift can invalidate a numeric page offset. However, it then describes the checkpoint as a “last completed page/window position” and a cursor without specifying:

- the exact GitHub API and ordering;
- whether the cursor is opaque or a numeric page number;
- how new PRs appearing during a scan are bounded;
- how PRs closing or changing state during pagination affect the connection;
- how the checkpoint advances when the API or byte budget is exhausted mid-page;
- how a deleted/invalid cursor is detected and recovered.

### Required correction

Before implementation, specify and test one deterministic discovery protocol. Prefer an opaque cursor/keyset design with a fixed scan watermark and deterministic ordering; do not use offset pagination as a fairness guarantee.

A checkpoint may advance only through records whose required discovery/evidence work completed successfully. It must never advance past an unprocessed record merely because a later page was fetched. When page drift, cursor invalidation, incomplete pagination, or a budget stop prevents proving the scan window, emit `INCOMPLETE_SCAN` and preserve the earliest uncompleted position.

The design must distinguish:

- records enumerated;
- records fully inspected;
- records excluded as ineligible;
- records whose history is incomplete;
- candidates fully validated;
- unprocessed records remaining in the scan window.

A successful workflow run must not be presented as complete repository coverage unless the scan window was actually completed.

## 6. Required state-machine additions

Add explicit dispositions or equivalent structured fields:

| Disposition | Meaning | Automatic inference |
|---|---|---:|
| `ATTEMPT_RESERVED` | Authenticated reservation exists; model request may not yet be known to have completed | No |
| `ATTEMPT_UNKNOWN` | Prior request may have been accepted but no exact terminal report is established | No |
| `BUDGET_EXHAUSTED` | A run-wide request, byte, time, or model budget was reached | No new inference |
| `CHECKPOINT_INVALID` | Discovery cursor cannot be reconciled to the current scan generation | No claim of complete coverage |

The run summary must include budget counters and scan completeness without including secrets, HMAC material, raw PR comments, or model prompt contents.

## 7. Adversarial acceptance tests to add

| Test | Adversarial condition | Required result |
|---|---|---|
| T27 | 200 PRs each approach the per-PR history limit | Run-wide byte/request ceiling stops work; no budget bypass |
| T28 | API retries occur near the request ceiling | Retries consume the same request budget |
| T29 | Aggregate response bytes exceed the run ceiling mid-page | `INCOMPLETE_SCAN`; checkpoint does not skip the unfinished record |
| T30 | 9Router accepts a request but the client loses the response | Durable reservation blocks automatic re-inference on the next run |
| T31 | Durable-ledger reservation response is lost after commit | Read-after-uncertain-write resolves the exact tuple; no duplicate reservation or inference |
| T32 | Event and reconciler workflows target the same PR concurrently | Shared PR concurrency group serializes them; second run revalidates |
| T33 | A queued run starts after head/base/report state changed | Old pre-queue evidence is discarded |
| T34 | More than 100 runs are queued for one concurrency group | Queue rejection is surfaced as non-success; no false coverage claim |
| T35 | A checkpoint cursor becomes invalid or its scan generation changes | Safe bootstrap with explicit fairness reset; no skipped range |
| T36 | New PRs appear during a scan | Fixed watermark prevents accidental unbounded extension of the current run |
| T37 | Manual dispatch is repeated | Dry-run only; no additional model calls |
| T38 | A valid reservation exists but its report marker is missing | `ATTEMPT_UNKNOWN`; no automatic model call |

Every negative test must assert zero model requests and zero report-comment writes where the contract requires fail-closed behavior.

## 8. Implementation gate

Implementation remains blocked until the design owner incorporates or explicitly rejects each R1–R4 correction with a reasoned decision and measurable acceptance criteria.

After that review:

1. Create a new isolated implementation branch based on the reviewed `feature/9router-abc-provenance` source head.
2. Write an implementation plan with file-level boundaries, resource accounting, retry semantics, permissions, and rollback/disable behavior.
3. Implement one invariant at a time using observed TDD RED → GREEN evidence.
4. Reuse the existing immutable reviewer and HMAC primitives; do not fork the diff/review/publication implementation.
5. Keep the schedule inactive and do not alter `main`, Production, secrets, repository settings, permissions, Rulesets, or branch protection.
6. Keep the PR Draft until independent review and exact-head CI are green.
7. Treat hosted `schedule → discovery → reservation → 9Router → publication` as **UNKNOWN** until an authorized end-to-end run is captured.

## 9. External evidence

- GitHub REST API — List pull requests, supported ordering and pagination: https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
- GitHub REST API — List issue comments and pagination: https://docs.github.com/en/rest/issues/comments#list-issue-comments
- GitHub Actions — concurrency groups and cross-workflow serialization: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
- GitHub Actions — concurrency queue limits: https://docs.github.com/en/actions/reference/limits

## 10. Audit conclusion

The current design is directionally sound but does not yet prove bounded total cost, bounded duplicate inference risk, or mutual exclusion with the event-driven reviewer. **Do not implement or activate the scheduled reconciler until R1–R4 are closed.**

No main or Production state was changed during this review.


## 11. Finding R5 — GitHub-native comment reservations do not prove durable uniqueness

### Decision

**NO-GO: PR issue comments are not accepted as the authoritative cross-run attempt ledger under the current permission model.** The signed report marker remains valid as report evidence, but a second signed comment marker cannot be promoted into a durable uniqueness primitive.

### Evidence

- GitHub exposes create, update, and delete operations for issue comments. HMAC authenticates the content of a surviving marker; it cannot establish that a missing marker was never created or was not later removed. The create endpoint does not expose a caller-supplied idempotency key or unique-key constraint for the tuple.
- A Git-ref ledger with optimistic compare-and-swap is a possible GitHub-native alternative, but it would require `contents: write` and dedicated ref governance. The current reconciler design explicitly prohibits `contents: write`; silently adding that permission would violate the approved least-privilege boundary.
- GitHub Actions artifacts/checkpoints are not accepted as the attempt ledger because no atomic cross-run compare-and-set or durable uniqueness contract has been established for them.

Official API references: create issue comment (<https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10>), update issue comment (<https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10>), and GitHub's fine-grained permission matrix (<https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>).

### Required disposition

1. Keep report comments as human-visible evidence only.
2. Do not claim at-most-once cross-run dispatch from comment HMAC markers.
3. Keep scheduled inference blocked; permit discovery-only/dry-run operation only.
4. Evaluate an external durable ledger with atomic insert-if-absent/CAS, read-after-uncertain-write reconciliation, authenticated append-only history, explicit retention, and fail-closed outage behavior.
5. Do not provision a vendor, add credentials, change permissions, or implement the integration until a separate option comparison and approval.

### Explicit limit

Even an external reservation ledger cannot guarantee exactly-once model execution across a distributed network boundary. The safe achievable policy is at-most-once automatic dispatch: reserve durably before the request; if the request outcome becomes ambiguous, retain `ATTEMPT_UNKNOWN` and require controlled operator recovery. No automatic retry.

This closes the GitHub-native feasibility question but does not close R1–R4, choose an external provider, or authorize implementation.
