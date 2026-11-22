# Independent 9Router PR Review

This integration sends a pull-request diff to a configured 9Router OpenAI-compatible endpoint and posts a model-assisted report as an issue comment. It does not submit GitHub review approvals, merge, modify source files, deploy, or change repository settings.

## Required GitHub configuration

Add these repository Actions secrets only after a trusted 9Router instance and API key are available:

- `NINE_ROUTER_API_URL`: HTTPS API base URL, for example `https://9router.example/v1`.
- `NINE_ROUTER_API_KEY`: dedicated 9Router API key with the minimum required access.

Add this repository Actions variable:

- `NINE_ROUTER_MODEL`: exact model identifier configured in 9Router.

Never commit these values or paste the API key into issues, pull requests, or chat. The configured 9Router provider receives the pull-request patch; configure only an endpoint approved to receive this repository's source.

## Workflow trust boundaries

- `9router-pr-review-signal.yml` runs on `pull_request_target`, whose workflow definition is taken from the base repository's default branch rather than the PR merge commit. Its workflow and job permissions are empty; it creates a strict event-bound `signal.json` receipt from trusted GitHub event context and uploads that single file as a run/attempt-specific, one-day artifact. It does not check out pull-request code, execute PR code, or reference secrets. A PR cannot replace this signal workflow definition through its own diff.
- `9router-pr-review.yml` runs later on `workflow_run`, using its copy from the trusted default branch. It accepts only successful `pull_request_target` runs from the exact signal workflow path and verifies that both the PR head and base repositories are this repository.
- The privileged workflow downloads only the artifact matching the triggering run ID and API-verified run attempt. It validates the receipt, then independently reconciles workflow-run metadata and live PR state through read-only GitHub API calls. It does not execute or check out artifact contents.
- Fork-originated PRs are intentionally skipped by checking the associated PR's `head.repo.full_name`, not merely the workflow-run repository metadata. This first version reviews same-repository branches only.
- The privileged job checks out only the trusted default branch; it never checks out or executes pull-request code.
- The reviewer does not use `workflow_run.pull_requests` to select the causal PR. The receipt captures `github.sha` separately as `workflowSha`; the resolver binds `workflow_run.head_sha` to that trusted workflow revision, while independently checking the receipt's PR head/base snapshots against the live PR API. The reviewer rechecks both live PR SHAs before sending the patch to 9Router, after model generation, and immediately before append-only comment publication. If either side changes during those stages, the stale review is rejected. A residual race remains between the final metadata read and comment creation because GitHub does not provide a transaction spanning PR metadata and issue-comment creation.
- Missing file patches, empty diffs, oversized patches, invalid event provenance, and stale head SHAs stop the review instead of producing a partial or stale report. The cumulative formatted patch budget is enforced as each file is received, so pagination stops immediately when the 45,000-character ceiling is crossed rather than fetching later pages.
- Patch content and filenames are untrusted prompt data. The complete patch is passed as a JSON-encoded string rather than sentinel-delimited raw text, preventing patch contents from forging the prompt's closing delimiter. This framing does not eliminate semantic prompt injection; the model must still treat the decoded patch as data only.
- Model-generated reports are parsed with the pinned `marked@17.0.1` GitHub-flavored Markdown lexer and rebuilt from an explicit AST allowlist. Headings, paragraphs, emphasis, strikethrough, inline/fenced code, blockquotes, lists, tables, and horizontal rules are preserved. Link and image nodes are converted to inert text placeholders; raw HTML and reference definitions are discarded; bare URL/autolink nodes are replaced; unknown AST node types fail closed. Rebuilt text is escaped before Markdown serialization and GitHub mentions are neutralized. This is an AST-based structural sanitizer; GitHub's hosted renderer remains a separate rendering boundary and requires continued hostile regression coverage.
- The parser dependency is pinned to `marked@17.0.1` in `package.json` and `package-lock.json`; CI installs only the lockfile-resolved package with `npm ci --ignore-scripts` and verifies its registry signature and provenance using `npm audit signatures`. The locked package has no runtime dependencies; the latest verified run reported zero package vulnerabilities.
- Every GitHub API JSON response body is streamed with a 1 MiB hard byte ceiling before parsing; oversized bodies are canceled and rejected before subsequent review stages. The 9Router HTTP response body is separately streamed with a 512 KiB hard byte ceiling before JSON parsing; oversized bodies are canceled and rejected before comment lookup or publication. The sanitized model report is separately capped at 30,000 UTF-16 code units. Oversized output is rejected rather than truncated, preserving report integrity and leaving a conservative margin below GitHub's 65,536-character issue-comment limit.
- **Read-only publication reconciliation (Finding 26):** After model generation, the reviewer reads issue comments sequentially with `per_page=100` and scans at most 10 pages (1,000 comments) and 4 MiB of cumulative serialized comment data. Each individual GitHub response remains subject to the existing 1 MiB streaming cap. A page must be a valid array of records with string bodies and author logins; malformed records, API errors, rate limits, byte-budget exhaustion, or a full tenth page fail closed and prevent publication. A report matches only when its first body line is the exact deterministic head/base marker and its author login is `github-actions[bot]`. One match suppresses a duplicate POST; more than one match is an ambiguity and stops publication. User-authored lookalike markers do not suppress publication. The reconciliation path is GET-only: no prior comment is PATCHed or deleted. See [List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments-for-an-issue) and [REST API pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).
- **Concurrency and recovery:** Review jobs are serialized per PR using a concurrency group keyed by PR number, with `queue: max`. GitHub permits at most 100 pending jobs in that group; additional jobs are canceled when the queue is full. GitHub processes queued jobs FIFO by the time they begin waiting, but does not guarantee ordering by workflow-dispatch time. Immutable head/base checks prevent stale jobs from publishing after the PR diff changes; they do not guarantee that every intermediate event is reviewed. If a comment POST succeeds remotely but its response is lost, a later rerun scans the bounded comment history and suppresses a duplicate when the exact bot-authored head/base marker is visible. If history cannot be scanned completely within the page/byte/deadline limits, the run fails closed. This reduces observable duplicates but does not provide exactly-once delivery or durable retry. This is best-effort delivery with bounded duplicate suppression, not exactly-once or guaranteed at-least-once delivery.
- **Comment provenance limitation:** A comment authored by `github-actions[bot]` is not cryptographic proof that this reviewer workflow created it. Another privileged workflow with comment-write permission could post a lookalike marker and cause this reviewer to suppress publication. This is a bounded denial-of-service / false-suppression risk, not a path to overwrite or mutate comments. Human readers must still treat comment authorship and report content as untrusted unless separately verified. A dedicated GitHub App identity or signed provenance would be needed for stronger attribution.
- Uses `GITHUB_TOKEN` only for reading repository contents and PR metadata/files and writing PR comments. No contents write, review approval, merge, or deployment permission is requested.
- Requires HTTPS for the 9Router endpoint and rejects embedded credentials, query parameters, and URL fragments.
- Suppresses API response bodies on errors to avoid leaking provider diagnostics or credentials into logs, and explicitly cancels unread non-success response streams to release transport resources.

## Activation boundary

The privileged `workflow_run` automation becomes active only after this setup PR is reviewed and merged into the default branch. Until the secrets and model variable are configured, the workflow emits a warning and does not call 9Router. The setup branch's contract tests do not require a live 9Router account.

## Review interpretation

Each finding must use one of `SUPPORTED`, `DISPUTED`, `REJECTED`, or `UNKNOWN`. `UNKNOWN` is not a pass or fail. The model is not a human reviewer and its report is not proof of correctness; findings require independent verification.


### Finding 21: Existing bot-comment identity was not a trustworthy update target — historical remediation superseded by Finding 26
- **Original finding:** Matching `github-actions[bot]` plus a predictable head/base marker did not prove that a comment was created by this exact reviewer workflow. Updating a matching comment could therefore mutate a forged or unrelated comment.
- **Historical TDD evidence:** run `45033942148`, 29 passed / 1 failed; run `45034129815`, 30/30 passed. At that stage, the selected mitigation was strict append-only publication with no history reads, PATCH, or deletion.
- **Superseding decision:** Finding 26 later approved bounded read-only reconciliation to suppress duplicates after ambiguous POST outcomes. The current implementation may GET comment history and use an exact bot-authored head/base marker only as a duplicate-suppression signal. It still never PATCHes or deletes existing comments.
- **Current residual risk:** `github-actions[bot]` is not cryptographic provenance. Another privileged workflow with comment-write permission could forge a matching marker and suppress publication. See Finding 26 for current limits and failure behavior.


### Finding 22: Per-PR concurrency is bounded serialization, not guaranteed delivery — residual operational risk
- **Classification:** **SUPPORTED** — GitHub documents that `queue: max` permits at most 100 pending jobs or workflow runs per concurrency group; further arrivals are canceled when the group is full. GitHub also documents that FIFO order is based on when a job begins waiting, not workflow dispatch time, so dispatch order is not guaranteed. References: [GitHub concurrency controls](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) and [Actions limits](https://docs.github.com/en/actions/reference/limits).
- **Existing safeguards:** The review job is serialized per PR. The resolver accepts exactly one same-repository PR and captures immutable head/base SHAs. The reviewer rechecks both SHAs after patch retrieval, after model generation, and immediately before comment publication. A stale queued run therefore fails closed rather than intentionally publishing a report for an obsolete diff.
- **Failure mode:** If more than 100 jobs are pending for the same PR, an additional signal's review job can be canceled. Earlier queued jobs may then reject themselves because their immutable SHA snapshots are stale. The system has no durable retry queue or automatic reconciliation pass, so a burst can leave the current PR head without a report until another qualifying event or a manual rerun occurs.
- **Ordering:** GitHub's queue order is not guaranteed to match event dispatch order. The immutable SHA checks protect report correctness for changed diffs, but they do not guarantee that every event is reviewed. Repeated events for the same head/base pair can still create duplicate append-only comments.
- **API recovery:** GitHub non-success responses are canceled and fail closed with a generic status error. The current client does not interpret `Retry-After` or rate-limit reset headers and does not retry 403/429/5xx responses. This avoids unsafe blind retries but means transient rate limiting or service errors stop that execution without a report. A later rerun is an operational recovery path, not an automatic guarantee.
- **Stale-work cost:** The 9Router request has a 120-second request timeout. If the PR changes after the pre-model SHA check, the in-flight model request is not actively canceled; the reviewer detects the changed SHA after the response and refuses publication. This preserves correctness but can spend up to the request timeout and delay the next serialized job.
- **UNKNOWN:** No real queue-saturation, out-of-order dispatch, GitHub rate-limit, or privileged workflow end-to-end test has been run. The workflow files are still absent from the default branch, and GitHub documents that `workflow_run`-triggered workflows run only when the workflow file exists on the default branch. The branch-only contract suite cannot prove hosted queue behavior.
- **Disposition:** No code change is made in this finding. Replacing immutable event snapshots with latest-state reconciliation, adding durable retries, or introducing idempotent report state changes the workflow's delivery semantics and needs a separate design decision. Current behavior is bounded and fail-closed, but it is not an at-least-once guarantee for every PR update.
### Finding 23: Independent request timeouts did not bound total review execution — remediated with an overall deadline
- **Classification:** **SUPPORTED** — the previous implementation applied a separate 120-second timeout to each GitHub request and the 9Router request, while the privileged Actions job had a 10-minute job timeout. Multiple sequential requests could therefore consume the entire job budget without an application-level execution deadline.
- **Worst-case request path:** one initial PR read, up to ten file-page reads, one pre-model SHA revalidation, one post-model SHA revalidation, one final pre-publication SHA revalidation, and one comment POST: up to 15 GitHub API requests, plus one 9Router completion request. The sum of independent 120-second ceilings was 32 minutes; this is a sum of per-request maxima, not a predicted normal runtime. The outer Actions job timeout remained the final hard stop.
- **Remediation:** runReview now starts one wall-clock deadline (8 minutes by default; accepted configuration is bounded to 1 ms–8 minutes). Every GitHub request and the 9Router request receives an abort signal capped by the lesser of the remaining overall budget and the existing 120-second per-request limit. The same signal remains attached while response bodies are consumed. When the deadline expires, the in-flight request is aborted; subsequent requests are rejected before network activity. The 10-minute Actions job timeout remains an outer safety boundary and includes checkout/dependency setup outside runReview.
- **TDD:** the new regression test simulates an in-flight GitHub request and verifies that the overall deadline aborts it. An initial hosted run exposed three compatibility/test-fixture failures: two existing tests lost their expected underlying error details, and the deadline fixture did not keep the event loop alive for Node's unreferenced timeout. The implementation now preserves original non-deadline errors, preserves response-size rejection details, and the fixture uses a bounded keep-alive timer. This failure evidence was used to refine the change rather than suppressing the tests.
- **GREEN evidence:** GitHub Actions run 45035554224, contract-tests job 137248396521: **31 passed, 0 failed, 0 cancelled**. Locked dependency installation and npm registry signature verification also completed successfully. Gitleaks PR-diff scans completed successfully on the resulting head.
- **Failure recovery policy:** GitHub non-success responses remain fail-closed; this change does not add automatic retries or interpret Retry-After/rate-limit reset headers. GET retries may be considered separately with bounded backoff and remaining-deadline checks. The append-only comment POST is deliberately not retried after ambiguous transport failure because GitHub may already have created the comment; blind retry can duplicate it.
- **Residual stale-work cost:** a PR change during model generation is still detected by the post-model SHA revalidation, not by actively polling/canceling on PR changes. The 9Router request is now bounded by the lesser of 120 seconds and the remaining overall deadline, which bounds this exposure but does not eliminate wasted inference.
- **UNKNOWN:** no live 9Router integration, privileged workflow_run end-to-end execution, hosted API rate-limit exercise, or queue/load test has been performed. The branch contract tests prove deadline propagation and cancellation behavior with a controlled fetch implementation, not all hosted transport semantics.
- **Disposition:** application-level execution is now bounded and fail-closed. Automatic recovery from transient GitHub failures remains intentionally deferred; no claim of exactly-once publication or guaranteed review delivery is made.

### Finding 24: GitHub API rate limits and authorization failures were collapsed into generic HTTP errors — remediated
- **Finding:** The API client previously discarded response headers and reported only a generic HTTP status. Operators could not distinguish a primary rate limit, a secondary rate limit, an authentication failure, a permission/rate-limit ambiguity, or a provider-side 5xx failure. Rate-limit recovery metadata was unavailable.
- **TDD RED:** run `45038428798`, contract-tests job `137257259937`: **35 passed, 1 failed**. The malformed-header regression demonstrated that fractional `Retry-After` and scientific-notation reset values were incorrectly accepted by permissive numeric/date parsing.
- **Remediation:** The client now classifies primary rate limits when a 403/429 response reports `x-ratelimit-remaining: 0`; classifies secondary rate limits when a 403/429 includes a valid `Retry-After`; keeps a bare 403 explicitly ambiguous as `forbidden-or-secondary-rate-limit`; classifies bare 429, 401, 5xx, and other HTTP failures separately. `Retry-After` accepts integer delta-seconds or an IMF-fixdate HTTP date; reset metadata accepts only digit-only values that are safe integers. The error message exposes only the whitelisted status, classification, and parsed wait/reset metadata. Response bodies are canceled and never parsed or logged.
- **TDD GREEN:** run `45038487813`, contract-tests job `137257443186`: **36 passed, 0 failed, 0 cancelled, 0 skipped**. Added deterministic coverage for primary and secondary rate-limit headers, ambiguous 403 handling, malformed numeric header rejection, HTTP-date parsing, and the no-automatic-retry fail-closed path.
- **Recovery decision:** No automatic retry or sleep was added. A blind retry of the append-only comment POST after an ambiguous transport outcome can create duplicate reports. The current behavior stops the run and exposes safe retry/reset metadata for operator-directed recovery; it does not implement automated backoff, durable retry, or reconciliation.
- **Residual UNKNOWN:** No hosted GitHub rate-limit event or live 9Router/privileged workflow execution has been exercised. Contract tests use controlled synthetic responses and prove classifier behavior, not GitHub's live rate-limit policy or delivery guarantees.
- **Disposition:** The error taxonomy and safe diagnostic metadata are **SUPPORTED** by contract tests. Automated recovery and hosted rate-limit behavior remain **UNKNOWN**.

### Finding 25: Comment publication has ambiguous-commit and non-idempotent retry semantics — residual delivery risk
- **Evidence in production path:** `runReview` performs one append-only `POST /issues/{pull_request}/comments` and returns success only after `requestJson` has consumed and parsed the successful response. There is no idempotency key supported by this call path, no durable publication ledger, and no reconciliation after an ambiguous network outcome.
- **Hostile reproduction:** contract test `an ambiguous POST timeout may produce a duplicate on append-only rerun` simulates GitHub creating the remote comment before the connection resets. The first invocation rejects despite the remote side effect; a rerun posts again. Assertions prove two remote comments, zero history reads, and zero PATCH operations. This is a deterministic demonstration of duplicate publication, not a live GitHub incident.
- **Queue boundary:** the workflow serializes valid reviews by PR and uses `queue: max`, but GitHub documents a maximum of 100 pending jobs per concurrency group; additional jobs are canceled. Queue order is based on when jobs begin waiting, not event-dispatch time. The workflow has no durable retry/reconciliation mechanism for canceled or stale runs.
- **Corrected delivery terminology:** the system is **best-effort, non-idempotent append-only publication with ambiguous commit outcomes**. A retry can duplicate a comment, while a canceled, stale, rate-limited, or otherwise failed run may leave the latest PR head without a report. It is neither exactly-once nor a guaranteed at-least-once delivery system.
- **Disposition:** **SUPPORTED** as a current architectural limitation by source inspection, existing contract tests, and GitHub Actions documentation. No production behavior was changed in this finding.
- **Design decision required before remediation:** (A) retain strict append-only behavior and accept/document duplicates and missed delivery; (B) perform read-only reconciliation using the deterministic head/base marker before POST, accepting history pagination, rate-limit, and race considerations; or (C) add a durable idempotency ledger/outbox, which introduces a stateful external dependency and operational cost. No option is selected by this audit.
- **Verification boundary:** no live queue-saturation, ambiguous hosted POST, or recovery E2E was run. The contract test validates the modeled failure mode, not a guarantee about every GitHub transport failure.

### Finding 26: Ambiguous publication reruns could duplicate reports — bounded reconciliation with authenticated provenance
- **Finding:** A comment POST can succeed remotely while the client loses the response. A rerun must reconcile the exact report before posting again, but the shared `github-actions[bot]` login and a public head/base marker are forgeable by another privileged workflow.
- **TDD RED — duplicate delivery:** run `45039307101`, contract-tests job `137259950593`: **35 passed, 1 failed** because the rerun made zero comment-history reads.
- **TDD RED — forged provenance:** run `45040563024`, contract-tests job `137263834391`: **39 passed, 1 failed**. A synthetic comment authored as `github-actions[bot]` with the exact unsigned head/base marker suppressed the new POST (`0 !== 1`), reproducing the trust flaw.
- **Remediation:** Reconciliation now accepts only a version-2 HMAC-SHA-256 marker. The signature binds the repository, pull-request number, exact head SHA, and exact base SHA; comparison uses constant-time byte comparison. A matching bot login without a valid signature, including the legacy unsigned marker, is ignored and cannot suppress publication. Existing comments remain append-only and are never edited or deleted.
- **Secret requirement:** The privileged workflow requires the repository secret `NINE_ROUTER_REVIEW_MARKER_KEY` with at least 32 bytes of high-entropy key material. Generate it outside the repository (for example, `openssl rand -hex 32`) and add it as a GitHub Actions repository secret. The value must never be committed, placed in a variable, printed, or pasted into chat. If it is absent, every privileged reviewer step is skipped; the reviewer does not silently fall back to unsigned reconciliation.
- **Trust boundary:** The HMAC prevents a different workflow that lacks this dedicated secret from forging a suppressing marker. It does not protect against repository administrators or a compromised trusted workflow that can read the secret. Keep this secret referenced only by the trusted reviewer workflow and audit workflow changes.
- **Bounded scan:** Sequential GET-only scan of at most 10 pages × 100 comments and 4 MiB cumulative serialized data, with the existing 1 MiB per-response cap and 8-minute overall deadline. Incomplete history, malformed records, API errors, multiple valid matches, or exhausted limits fail closed.
- **Residual delivery risk:** A race remains between reconciliation and POST; a newly posted comment may not yet be visible after an ambiguous transport outcome. This is not exactly-once delivery, a durable outbox, or guaranteed delivery.
- **Disposition:** HMAC-authenticated bounded reconciliation is implemented in the feature branch. Hosted contract tests and secret scans must pass on the final documentation head. Live privileged workflow / 9Router E2E and a real ambiguous hosted POST remain `UNKNOWN`.



### Finding 27: Marker-signing secret was exposed to every job step — scoped to two steps
- **Finding:** The dedicated HMAC key was defined in the privileged job-level environment, making it available to setup and dependency-installation steps that do not need it. This unnecessarily expanded the secret exposure surface.
- **TDD RED:** run `45041484659`, contract-tests job `137266692745`: **40 passed, 1 failed**. The workflow contract expected two scoped declarations (configuration validation and final review) but found one job-level declaration.
- **Remediation:** Removed all credentials and router secrets from the job-level environment. The configuration-validation step receives only the values needed to check readiness and exports a boolean output. Checkout, Node setup, dependency installation, and signature verification receive no marker key or router credentials. Only the final report step receives `GITHUB_TOKEN`, router credentials, and `NINE_ROUTER_REVIEW_MARKER_KEY`. All five privileged steps after configuration validation are gated on the readiness output.
- **TDD GREEN:** run `45041593586`, contract-tests job `137267029196`: **41/41 PASS**, zero failures, cancellations, or skips.
- **Residual trust boundary:** The configuration-validation step must read the marker secret to establish readiness, but it does not print or persist the value. The final report step is the only step that needs the key to sign and verify report markers.


### Finding 28: Privileged workflow bootstrap and repository policy are not yet proven
- **Default-branch activation gap:** The repository default branch is `main` at `919b19ca3d3887352cdef06b03c668ead04fbce7`. Its `.github/workflows/` directory contains only `cloud-agent-ci.yml`, `connector-ci.yml`, `secret-history-scan.yml`, and `static.yml`. Both `9router-pr-review.yml` and `9router-pr-review-signal.yml` are absent from `main`; they exist only on this feature branch. GitHub documents that a `workflow_run` workflow is triggered only if its workflow file exists on the default branch. Therefore, the current branch cannot prove or activate the privileged signal-to-review chain. No merge is performed.
- **Privilege boundary review:** On the feature branch, the signal workflow has empty permissions and performs no checkout, artifact download, or untrusted code execution. The privileged reviewer checks the exact workflow path, trigger event, successful conclusion, same-repository origin, and PR metadata; it checks out only the default-branch reviewer code and does not consume artifacts from the signal run. This is consistent with GitHub's guidance to keep untrusted PR code out of privileged `pull_request_target` / `workflow_run` jobs.
- **Writer inventory:** Among the six workflows present on the feature branch, only `9router-pr-review.yml` declares `pull-requests: write`. The CI and secret-scan workflows are read-only for repository contents. `static.yml` has Pages deployment permissions (`pages: write`, `id-token: write`) but no PR-comment write permission. This is a source-level inventory, not a runtime proof of every possible repository/organization integration.
- **Main ruleset:** Active repository ruleset `26740429` applies to `refs/heads/main`, requires one approving review and resolved review threads, blocks deletion and non-fast-forward updates, and has no bypass actors. It does not declare required status checks, CODEOWNERS review, or approval of the most recent push. No ruleset changes were made.
- **Public-repository event-policy risk:** GitHub's current documentation describes a default `pull_request_target` event policy for public repositories and says enforcement for affected repositories is scheduled for **2026-12-02**. Whether this repository is covered by that default policy, or already has an explicit applicable policy, could not be verified because the connected GitHub integration denied access to Actions permission/policy endpoints. Treat future `pull_request_target` execution as `UNKNOWN` until checked in repository Actions settings.
- **Decision:** No repository settings, branch rules, secrets, main-branch files, or production resources were changed. Keep PR #261 Draft until the default-branch bootstrap, policy applicability, and privileged E2E are separately authorized and verified.
- **Evidence:** GitHub REST read of default-branch workflow directory and ruleset `26740429`; GitHub documentation: <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows> and <https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target>.

## Latest verification — workflow bootstrap and trust-boundary audit
- Verified audit/documentation head: `e935ccb5c5f888e663b54ba1e9325cfe9414f561`.
- Contract tests on this exact head: **41/41 PASS**, run `45042191981`, job `137268882624`; zero failures, cancellations, or skips.
- Full-history secret scans on this exact head: PASS, runs `45042192082` and `45042198111`.
- The privileged review job was skipped on push by design. The default branch lacks both required 9Router workflow files; live `workflow_run` / 9Router E2E remains UNKNOWN.
- Main remains at `919b19ca3d3887352cdef06b03c668ead04fbce7`; PR #261 remains Draft/Open/Unmerged.


## Final trust-boundary contract verification — 2026-11-22

- Verified PR head: `a6d5ae9d1231266e26561a3334dca75312c29770`; base: `919b19ca3d3887352cdef06b03c668ead04fbce7`.
- Added static workflow-contract tests for the `pull_request_target` signal and privileged `workflow_run` boundary. The tests assert empty signal permissions, no signal checkout/artifact/secret use, exact trusted workflow provenance gates, least-privilege reviewer permissions, default-branch-only checkout, disabled persisted checkout credentials, and no artifact consumption.
- The first test run on intermediate head `d5f44903394b2ef58fc181e08ed466cf261d6f78` failed at JavaScript module parsing because the new regular-expression literals were over-escaped. This was a test-source syntax error, not a product-behavior failure. The literals were corrected; no production workflow or reviewer code was changed in that correction.
- Final contract test run `45043676869`, job `137273440355`: **43/43 PASS**, zero failures, cancellations, or skips.
- Full-history secret scan on push: run `45043676892`, job `137273440747`: PASS.
- Full-history secret scan on pull request: run `45043681136`, job `137273454020`: PASS.
- The privileged review job was skipped on push by design. These results do not prove a live `workflow_run`, 9Router request, report publication, or hosted ambiguous-POST recovery.
- PR #261 remains Draft/Open/Unmerged. The default branch remains at `919b19ca3d3887352cdef06b03c668ead04fbce7`; no repository settings, secrets, `main`, or Production resources were changed.
## Finding 29 — pull request base-branch edits did not emit a review signal

- **Finding:** The unprivileged `pull_request_target` signal workflow listened for `opened`, `synchronize`, `reopened`, and `ready_for_review`, but omitted the `edited` activity. GitHub documents `edited` as a supported `pull_request_target` activity; changing the PR base branch emits this activity. A base-branch change could therefore leave the reviewer without a fresh workflow signal even though the diff identity changes.
- **TDD RED:** Commit `3d43c31f4195e0c3d8071da20587985d586662df` added a workflow-contract assertion requiring `edited`. Run `45044265306`, job `137275287357`: **42 passed / 1 failed**. The failure was the expected missing activity in the signal workflow, not a test setup or syntax failure.
- **Remediation:** Added `edited` to the existing `pull_request_target.types` list. No permissions, secrets, checkout behavior, or privileged workflow logic changed.
- **TDD GREEN:** Commit `ccc20b6d6e1984d488aac0db1ee44bd83d98c7fa`. Run `45044313106`, job `137275439163`: **43/43 PASS**, zero failures, cancellations, or skips.
- **Secret scan:** Full-history Gitleaks push scan run `45044313030`, job `137275438766`: PASS.
- **Residual behavior:** The added event is covered by a static workflow contract and hosted test suite. A live base-branch-edit event flowing through the privileged `workflow_run` reviewer remains UNKNOWN until the workflow definition is present on the default branch and the required event policy permits execution.
- **Safety boundary:** No changes to `main`, repository Actions policies, secrets, branch rules, or Production resources. PR #261 remains Draft/Open/Unmerged.
## Finding 30 — edited-event cost amplification

- **Finding:** Adding the broad `edited` activity alone would also enqueue reviews for title/body edits. The reviewer currently generates the model report before bounded duplicate reconciliation, so repeated metadata-only edits could incur repeated 9Router calls even when the head/base SHA pair is unchanged.
- **TDD RED:** Commit `179d304bd46ff2655412622ec7df4f05c9136681` added a contract assertion requiring the signal job to gate `edited` events on `github.event.changes.base`. Run `45044479415`, job `137275956062`: **42 passed / 1 failed**. The expected failure showed that the signal job had no base-change gate.
- **Remediation:** The signal job now runs for all existing non-`edited` activities, but for `edited` only when `github.event.changes.base != null`. Title/body-only edits therefore produce a skipped signal job; the privileged reviewer already rejects non-success workflow conclusions. A base-branch edit still emits a successful signal. No secrets or permissions were added.
- **TDD GREEN:** Commit `1273a81e07cae6d9ab6ad24e691b767add7f470e`. Run `45044512717`, job `137276064599`: **43/43 PASS**, zero failures, cancellations, or skips.
- **Secret scans:** Full-history Gitleaks push scan run `45044512703`, job `137276064779`: PASS; PR scan run `45044517686`, job `137276079624`: PASS.
- **Residual limitation:** The workflow contract verifies the gate expression, but a real GitHub `edited` payload with `changes.base` has not been observed through the activated privileged chain. Live end-to-end behavior remains UNKNOWN until the trusted workflow exists on `main` and event policy allows it.
- **Safety boundary:** No `main`, repository policy, secrets, branch rules, or Production changes.


### Finding 31: Duplicate authenticated reports triggered unnecessary model inference — remediated

- **Finding:** The reviewer previously generated a 9Router report before checking whether an exact HMAC-authenticated report already existed for the same repository, PR, head SHA, and base SHA. A rerun or repeated signal for an unchanged diff could therefore incur another model request even though publication would later be suppressed.
- **TDD RED:** Commit `8541045f696b7a93b5bc16572d6e4e5eb7531a79` added an assertion that a matching signed report must short-circuit before model inference. Run `45045637365`, contract-tests job `137279518084`: **42 passed / 1 failed**. The failure was the expected `routerCalls: 1` versus `0`, proving the unnecessary inference path.
- **Remediation:** The reviewer now performs the existing bounded, read-only HMAC reconciliation after fetching and validating the complete patch and rechecking the live head/base SHAs, but before calling 9Router. If exactly one valid report exists, it revalidates both SHAs once more and returns `already-published` without model inference, comment mutation, or a new POST. If no report exists, it proceeds to inference and retains the final head/base revalidation immediately before append-only publication.
- **Concurrency assumption:** The reviewer workflow serializes jobs by PR number using its bounded GitHub Actions concurrency group. This prevents two instances of this reviewer workflow from racing through the pre-model reconciliation and publication path. It does not protect against a separate trusted writer that has access to the HMAC key.
- **TDD GREEN:** Exact final head `e73a890f71daa85e7ba140adc0071803d027d5aa`. Run `45045889016`, contract-tests job: **43/43 PASS**, zero failures, cancellations, or skips.
- **Secret scans:** Full-history Gitleaks push scan run `45045889018`: PASS; pull-request scan run `45045896452`: PASS.
- **Trade-off:** The bounded comment-history read now occurs before inference. Oversized or invalid patch inputs still fail before that read; oversized model responses still fail before publication. The change does not add retries, edit/delete existing comments, or claim exactly-once delivery.
- **Residual limitations:** A comment that is not yet visible during reconciliation can still lead to a duplicate after an ambiguous POST outcome. The final SHA read and comment POST are not transactional. Live 9Router execution, hosted `workflow_run` activation, and real ambiguous-POST recovery remain `UNKNOWN`.
- **Safety boundary:** No changes to `main`, repository Actions policies, secrets, branch rules, or Production resources.


### Finding 32: Literal angle brackets in report prose were not entity-encoded — defense-in-depth remediation

- **Finding classification:** Defensive hardening / parser-differential risk. The prior renderer escaped Markdown punctuation and removed recognized HTML AST nodes, but ordinary text tokens could still preserve literal `<` and `>` characters. This was not demonstrated to be an exploitable XSS path under the pinned Marked parser; it left avoidable raw delimiters at the boundary between Marked and GitHub's Markdown renderer.
- **TDD RED:** Test-only commit `3494222f3e359c6c94b8a4eb44b958ca272251ba` added a real `runReview` publication-path assertion for the prose `Comparison: a < b and c > d`. Run `45046831125`, contract-tests job `137283181324`: **42 passed / 1 failed**. The decisive failure was the expected missing `&lt;` / `&gt;` encoding assertion; setup and dependency-signature verification succeeded.
- **Remediation:** `escapeMarkdownText` now converts literal angle brackets in text-bearing tokens to `&lt;` and `&gt;` before Markdown punctuation escaping. This applies to ordinary prose, HTML-stripped text, and image alt text. Fenced and inline code remain code-formatted and are not rewritten by this text-token path.
- **TDD GREEN:** Final implementation commit `911f686f7da35896e9b2ae4d27b856cbf90fd7f6`. Run `45046891175`, contract-tests job `137283369971`: **43/43 PASS**, zero failures, cancellations, or skips.
- **Secret scans:** Full-history Gitleaks push scan run `45046891179`: PASS; pull-request scan run `45046896130`: PASS.
- **Security conclusion:** The change reduces raw HTML delimiter exposure and parser-differential ambiguity. It is defense in depth, not evidence that the previous implementation allowed executable HTML or XSS.
- **Safety boundary:** No changes to `main`, repository Actions policies, secrets, branch rules, or Production resources. Live 9Router and privileged `workflow_run` E2E remain UNKNOWN.


### Finding 33: Escaped-pipe table corruption hypothesis — not reproduced

- **Hypothesis:** The renderer's Markdown table-cell escaping might double-escape a literal pipe and change the table's column structure.
- **Initial test failures:** Runs `45047168065`, `45047234960`, and `45047353755` failed because the test fixture placed a table immediately after a blockquote without a blank line. The Markdown parser correctly treated the table lines as part of the blockquote; the test incorrectly expected a top-level table. These failures were test-fixture errors, not evidence of a production defect.
- **Corrected experiment:** The fixture now ends the blockquote explicitly, then includes a GFM table row containing an escaped literal pipe. It reparses the sanitized publication and asserts that the table remains present with exactly two header columns and two cells in the escaped-pipe row.
- **Result:** The corrected test passes against the original renderer implementation. A temporary alternative escaping helper was reverted; no production code change is retained for this hypothesis.
- **Classification:** `REJECTED` as a demonstrated defect under the pinned Marked 17.0.1 parser and this test case. This does not establish equivalence with every downstream Markdown renderer.
- **Validation:** Contract run `45047469769`, job `137285096336`: **43/43 PASS**. Full-history Gitleaks push scan `45047469771` and PR scan `45047473303`: PASS.
- **Safety boundary:** No changes to `main`, repository Actions policies, secrets, branch rules, or Production resources. Live 9Router and privileged `workflow_run` E2E remain UNKNOWN.


### Finding 34 — workflow-run SHA was format-checked but not bound to the PR base snapshot
- **Classification:** SUPPORTED as a provenance-validation defect in the resolver; exploitability against a hosted `pull_request_target` delivery remains unproven because no such signal run exists in this repository's available run history.
- **Finding:** `resolveWorkflowRunTarget` validated that `workflow_run.head_sha` was a 40-character SHA but did not require it to equal the associated PR's `base.sha`. The previous positive fixture explicitly accepted three unrelated values: run SHA `b…b`, PR head SHA `a…a`, and PR base SHA `c…c`. Thus the resolver could accept an associated PR record without proving that the PR base snapshot corresponded to the triggering `pull_request_target` run.
- **Platform contract:** GitHub documents that `pull_request_target` runs against the base repository's default-branch context and that its `GITHUB_SHA` is the last commit on the base branch. The privileged `workflow_run` event is dispatched after the signal run and exposes that run's SHA. The resolver now requires the run SHA to equal the associated PR base SHA; mismatches fail closed before the reviewer uses the PR number.
- **TDD RED:** test-only commit `21ae4b9b9674059e456615b7c6e9b38d1bf90dbd`; run `45050518174`, contract-tests job `137294381334`: **43 passed / 1 failed**. The new test supplied a different run SHA and expected rejection; the resolver accepted it.
- **TDD GREEN:** implementation head `0c17db41ef905b80cc935e8d93bbcde4ee94c355`; run `45050631606`, contract-tests job `137294735458`: **44/44 PASS**, zero failures, cancellations, or skips.
- **Secret scans:** push run `45050631599` and PR run `45050636379`: PASS.
- **Fixture correction:** all positive resolver fixtures now use `runHeadSha === pullRequests[0].base.sha`; the negative regression explicitly tests a mismatch. No test was weakened.
- **Residual UNKNOWN:** no `pull_request_target` signal run is available in the repository's current Actions history (query returned zero runs), so the exact hosted `workflow_run.head_sha` / PR base snapshot equality has not been validated against a real delivery. This implementation intentionally fails closed if GitHub supplies inconsistent metadata. No live 9Router call or privileged E2E is claimed.
- **Disposition:** the previously accepted mismatch is rejected by code and contract tests. Keep the privileged workflow inactive until a trusted default-branch bootstrap and hosted E2E can verify the payload contract.


## Finding 35 — `workflow_run.pull_requests` is not causal PR provenance

**Disposition:** The ambiguous PR-selection path is removed from the runtime and replaced by the ABC provenance chain. Hosted end-to-end activation remains **UNKNOWN** until the workflows are present on the default branch and a real `pull_request_target` → `workflow_run` round trip is observed.

### A — Event-bound signal receipt

The trusted `pull_request_target` signal workflow writes a fixed-schema `signal.json` using only values from the trusted GitHub event context. The receipt binds:

- repository name and numeric repository ID;
- workflow run ID and run attempt;
- event name and action;
- exact PR number;
- PR head and base SHAs;
- head/base repository names and base ref.

The workflow uploads only this file as `9router-pr-signal-<run_id>-<run_attempt>`, with one-day retention. The signal workflow has no checkout, no PR-code execution, no secrets, no router access, and no external network calls other than the GitHub artifact upload.

### B — Independent GitHub API reconciliation

Before downloading the artifact, the privileged workflow reads the authoritative `run_attempt` from `GET /repos/{owner}/{repo}/actions/runs/{run_id}` and checks run identity, event, workflow path, conclusion, repository identity, workflow ID, and head SHA. It downloads only the artifact belonging to that exact run ID and API-verified attempt.

The resolver then parses the bounded receipt and independently re-fetches both the workflow run and the PR. It checks the receipt against run ID/attempt, repository identity, workflow metadata, run SHA, PR number, open/non-draft state, head/base SHAs, base ref, and repository identities. It never reads or selects from the API's `pull_requests` array. The verified PR number becomes the downstream job output and is the only source for per-PR concurrency.

The resolver job has read-only `actions`, `contents`, and `pull-requests` permissions. Router credentials and the review-marker key are not available to it.

### C — Fail-closed execution gate

The reviewer job depends on successful receipt verification. Missing or malformed receipts, wrong run/attempt, wrong workflow, repository mismatch, stale PR snapshots, closed/draft PRs, API errors, or any SHA mismatch stop the chain before model inference and comment publication. The downloaded artifact is parsed as data only; it is never executed or checked out.

### Implementation and verification evidence

- Work branch: `feature/9router-abc-provenance`.
- Implementation HEAD at this checkpoint: `af7f529477cde0d8ce6f20ce17fc4ef7fbb11def`.
- Contract workflow run `45053100603`: `contract-tests` passed, **47/47**, zero failures, cancellations, or skips.
- Secret scan run `45053100500`: Gitleaks scanned **3,949 commits** / approximately **12.37 MB**; no leaks found.
- The `resolve-signal` and `review` jobs were skipped on the push event by design. These results prove the contract suite and secret scan only; they do not prove artifact round-trip behavior, privileged workflow activation, or a live 9Router request.

### Residual limitations and explicit UNKNOWNs

1. The signal and privileged workflow files are not yet on the default branch. GitHub's `workflow_run` trigger requires the referenced workflow to exist on the default branch; no default-branch change is made in this work.
2. The exact hosted relationship between the signal event's `github.sha` (`workflowSha`) and `workflow_run.head_sha` has not yet been observed for this repository. The resolver binds those two values; the PR `baseSha` is a separate event snapshot and is independently reconciled against the live PR API. A hosted artifact round trip is still required to verify the platform payload contract.
3. A real artifact upload/download round trip and privileged `workflow_run` execution remain **UNKNOWN** until a separately approved default-branch bootstrap.
4. The receipt is not independently cryptographically signed. Its provenance depends on the trusted default-branch signal workflow, exact run/attempt artifact retrieval, GitHub artifact integrity, and independent API reconciliation.
5. JavaScript `JSON.parse` does not report duplicate object keys; duplicate keys therefore follow its last-key-wins behavior. The exact-key schema, trusted producer, and independent GitHub API checks reduce exposure, but this parser limitation remains documented.
6. Fork PRs are intentionally rejected by the same-repository identity checks. Supporting fork PRs requires a separate threat-model and permission review.
7. B is implemented as independent read-only GitHub API reconciliation, not a durable external registry. No paid service, database, or additional infrastructure is introduced.

No merge, deployment, repository setting, ruleset, Actions policy, or secret was changed.


### Final ABC branch verification — 2026-11-22
- Implementation head: `eabe0ddffa2af964b65147740572546f1651274c`.
- Targeted TDD RED: run `45053551213`, job `137303723388`; the new regression test failed because `ftp://localhost` passed the prior origin guard and reached the fetch layer.
- Targeted TDD GREEN: run `45053620593`, job `137303934725`: **48/48 PASS**, zero failures, cancellations, or skips. The guard now permits HTTPS origins and HTTP only for explicit loopback test hosts, rejecting FTP, external HTTP, credentials, path, query, and fragment.
- Full-history Gitleaks run `45053210347`: **3,949 commits scanned**, approximately **12.37 MB**, no leaks found. Final Gitleaks run `45053620560` passed on the implementation head.
- The `resolve-signal` and `review` jobs were skipped on Push by design. No hosted signal artifact round trip or privileged reviewer E2E is claimed.
- The main branch remains at `919b19ca3d3887352cdef06b03c668ead04fbce7`. PR #261 remains Draft/Open/Unmerged. PR #262 is Draft/Open/Mergeable and targets the work branch underlying PR #261. No merge, deploy, secret, policy, ruleset, or Production change.


### Finding 36 — workflow-run SHA is distinct from the PR base snapshot

- **Defect:** The first ABC resolver version required `workflow_run.head_sha === receipt.baseSha`. This conflated the commit associated with the trusted default-branch workflow execution and the independently captured PR target-branch snapshot. GitHub documents that `pull_request_target` runs in the base repository's default-branch context, while `workflow_run` executes from the default branch. A PR targeting a non-default base branch can therefore have a valid `baseSha` distinct from the workflow revision SHA.
- **Impact:** The old equality could reject a legitimate signal before PR reconciliation. This is a fail-closed availability defect, not evidence of provenance bypass.
- **TDD RED:** Test-only commit `2af1e536272ff52826d859fbbb2fb99750cfac42`; run `45054489016`; contract suite: **48 passed / 1 failed**. The new test failed because the receipt schema did not carry a distinct workflow revision SHA.
- **Remediation:** The signal receipt now captures `github.sha` as `workflowSha`. The resolver binds `workflow_run.head_sha` to this workflow revision SHA. The PR's `baseSha` remains a separate immutable event snapshot and is independently compared with the live PR API response.
- **TDD GREEN:** run `45054598879`, contract job `137306920053`: **49/49 PASS**, zero failures, cancellations, or skips. Dependency installation and `npm audit signatures` also succeeded.
- **Residual UNKNOWN:** No hosted `pull_request_target → workflow_run` execution or artifact round trip has been run because both workflows remain absent from `main`. The exact `github.sha` / `workflow_run.head_sha` relationship remains to be confirmed by that future hosted run.
- **Scope:** Only `feature/9router-abc-provenance` was changed. No main, secrets, Actions policy, rulesets, merge, deployment, or Production resources were modified.

- **Additional regression:** the non-default-base scenario now exercises the complete resolver plus live-PR API reconciliation with `baseRef: release/1.x`, while the workflow revision SHA remains distinct. Fresh contract run `45054732371`, job `137307325057`: **49/49 PASS**, zero failures/cancellations/skips.


### Finding 37 — artifact lifecycle and filesystem boundary

- **Threat model:** The privileged resolver consumes a run-specific artifact produced by the trusted `pull_request_target` signal workflow. The review considered cross-run replay, stale-attempt replay, duplicate artifact replacement, digest mismatch, unexpected files, symlinks, non-regular files, oversized receipts, and path indirection.
- **Run/attempt binding:** The resolver obtains the current `run_attempt` from the GitHub Actions REST API, then downloads by the exact triggering `run_id`, repository, and artifact name containing that API-verified attempt. The receipt parser independently requires the same run ID and attempt. The runtime does not use `workflow_run.pull_requests`.
- **Artifact immutability:** The signal workflow now explicitly sets `overwrite: false`. GitHub's upload-artifact v7 creates immutable artifacts; a duplicate name in the same run fails rather than silently replacing the first artifact. The one-day retention and unique run/attempt name remain.
- **Digest integrity:** The privileged workflow explicitly sets `digest-mismatch: error` on the pinned `download-artifact@v8.0.2` action. The action's v8 contract defaults digest mismatches to errors; the workflow now makes that fail-closed policy explicit.
- **Filesystem hardening:** The resolver no longer performs a separate `lstat` followed by an unguarded path read. `readSignalReceiptFile` requires the expected basename `signal.json`, a canonical non-symlink directory containing exactly one entry, opens the file with `O_NOFOLLOW`, checks the opened descriptor is a regular file within the 16 KiB bound, and only then parses the strict receipt schema. It rejects missing files, extra files, symlinks, directories, non-canonical directories, malformed JSON, and oversized content.
- **TDD RED:** Test-only commit `0242495d20a823d0e7ee43f7b68cb77252920535`; run `45054953205`, contract job `137308005508`: **49 passed / 1 failed**. The new filesystem-boundary test failed because no dedicated safe artifact reader existed.
- **TDD RED (workflow policy):** Test-only commit `360af47cd0e047e8fefe7e5cfa2c0e6425d6d809`; run `45055048715`, contract job `137308297617`: **49 passed / 1 failed**. The new assertion required explicit digest-mismatch failure behavior.
- **TDD GREEN:** Run `45055102935`, contract job `137308463747`: **50/50 PASS**, zero failures, cancellations, or skips. Locked dependency installation and npm registry signature verification succeeded.
- **Secret scans:** Push run `45055102967` and PR run `45055109149` both passed. The PR Gitleaks job scanned 3,973 commits (approximately 12.39 MB) with no leaks found.
- **Residual UNKNOWN:** No real hosted artifact upload/download round trip or privileged `workflow_run` execution has occurred because both workflows remain absent from `main`. The unit/contract tests establish the local filesystem policy and workflow configuration, not GitHub-hosted artifact behavior. An actor with sufficient repository write/admin permissions can still delete artifacts or alter trusted workflow configuration; those actors remain inside the repository trust boundary.
- **Disposition:** No cross-run or stale-attempt replay path was found in the configured run-ID/name/attempt binding. Artifact tampering is additionally checked by GitHub's artifact digest validation. This is not a claim of protection against a compromised GitHub control plane or trusted repository maintainer.
- **Safety boundary:** Only `feature/9router-abc-provenance` changed. No default-branch, secret, ruleset, Actions policy, merge, deployment, or Production change.


### Finding 38 — PR state and snapshot revalidation across queued review execution

- **Queue semantics:** the reviewer job uses a PR-scoped concurrency group with `queue: max`. GitHub documents that queued jobs can wait and that ordering is based on when they started waiting, not dispatch time. Therefore queue order is not treated as proof that a receipt still represents the current PR.
- **Existing SHA gates retained:** the reviewer independently reads the live PR before work, after patch retrieval and before model inference, after model generation, and immediately before comment creation. Each gate compares both live head and base SHA to the receipt's expected snapshot. A queued stale run therefore fails before model inference when the live SHA no longer matches.
- **Finding:** those later gates previously checked only head/base SHA. If a PR was closed or converted to draft after the initial check, the model could still run or a report could still be published even though the PR was no longer reviewable.
- **Fix:** `assertReviewablePullRequest` now requires `state === "open"`, `draft === false`, and exact head/base SHA equality at every post-initial gate. The initial gate preserves the established behavior: a valid open Draft PR is skipped without model inference; closed PRs and mismatched snapshots are rejected. Missing/ambiguous draft state fails closed.
- **TDD RED:** test-only commit `f3fdd3e50da80577c31e3eac07470979d3c94c2d`; run `45055519680`, contract job `137309758904`: **50 passed / 2 failed**. Both new tests failed with `Missing expected rejection`: a PR closed after patch retrieval and a PR converted to Draft during model review were not rejected.
- **Regression caught during GREEN:** first implementation run `45055588010`, job `137309969232`: **51 passed / 1 failed**. Existing behavior for an initially Draft PR (skip without inference) had been changed unintentionally. The helper was corrected to preserve initial Draft skipping while enforcing strict Draft rejection at later gates.
- **TDD GREEN:** final code head `72ff97cbdcb0c00ca3d7757e350ac511cced427e`; run `45055632698`, contract job `137310106149`: **52/52 PASS**, zero failures, cancellations, or skips. Locked dependency installation and npm registry signature verification succeeded.
- **Secret scans:** Push run `45055632798` and PR run `45055638736` both PASS. The final PR scan covered 3,978 commits / approximately 12.40 MB with no leaks found.
- **Residual TOCTOU limitation:** GitHub's REST API documentation states conditional requests for unsafe methods such as POST are unsupported unless an endpoint explicitly documents otherwise. The issue-comment creation endpoint does not document a compare-and-swap precondition. Consequently a very small race remains between the final PR-state/SHA GET and the subsequent comment POST. The comment is explicitly bound to the reviewed head/base SHAs and the final check is adjacent to publication, but absolute atomicity cannot be claimed with this endpoint. Eliminating that residual requires a separately approved publication design, such as a commit-scoped check/status surface rather than an issue timeline comment.
- **Disposition:** stale queued snapshots are rejected by the existing live SHA gate; closed/Draft transitions are now rejected at all later gates. No claim of atomic compare-and-publish is made.
- **Execution boundary:** the push CI run skipped `resolve-signal` and `review` by design. No hosted `workflow_run` E2E, live 9Router inference, or comment publication was performed. No main/Production, secret, repository setting, ruleset, or Actions policy changes.


## Finding 39 — report snapshot validity and stale-report interpretation

- **Finding:** an append-only issue comment remains visible after the PR changes. Recorded head/base SHAs identify the reviewed snapshot, but readers need an explicit validity rule to avoid treating an older report as current.
- **Change:** every generated report now states that it applies only to its exact reviewed head/base SHAs. Treat it as `SUPERSEDED` if either SHA changes, and as `UNKNOWN` if live PR SHAs cannot be verified. Re-review the new snapshot before relying on it. Existing comments remain append-only; none are edited or deleted.
- **Scope limitation:** this is an explicit interpretation rule, not an automatic live status updater. The system does not continuously poll the PR or mutate historical comments.
- **Regression test:** added a test asserting that the published report contains the exact head/base SHAs and both the superseded and unverifiable-state rules. The test name was narrowed after hostile review because its assertions do not simulate a later SHA transition.
- **TDD evidence:** the test commit precedes the matching production wording, but no executable RED run was available through the connected GitHub interface. This is not a demonstrated RED/GREEN cycle.
- **Verification update (Windows Node 24.22.0, isolated temporary snapshot):** the focused `review.test.mjs` suite passed **44/44** on commit `333516d8919174c622da49ae72dc1a26f4dc11f8`. The complete `node --test tools/9router-review/*.test.mjs` suite passed **54/55**; the sole failure is the explicit `O_NOFOLLOW` platform-capability test because Windows does not expose the required no-follow receipt open flag. This is not evidence of a Linux production defect or a Linux pass. The hosted `ubuntu-24.04` `contract-tests` result for this exact commit was not available through the connected workflow-run query. `npm ci --ignore-scripts` succeeded; `npm audit signatures` could not complete because registry metadata retrieval failed in the environment. Gitleaks on the final test-only commit passed (run `45062291955`, job `137330676006`).
- **Residuals:** no automatic detection or annotation of stale historical comments; no compare-and-swap publication; the previously documented TOCTOU race remains unchanged.


### Finding 40 — signed historical marker snapshot isolation

- **Classification:** test-coverage gap; no production defect demonstrated.
- **Existing contract:** a bot comment suppresses a duplicate only when its HMAC marker matches the exact repository, PR number, current head SHA, and current base SHA. A correctly signed marker for an older snapshot must not suppress a report for a changed snapshot.
- **Coverage added:** two independent `runReview` contract tests create a valid historical HMAC marker with `createReviewMarker`, change only the head SHA or only the base SHA, return the historical marker from the comment-history API, and verify that the current review still reaches the model and publishes a new report. They also assert that the historical comment is not patched and the new report carries the current marker.
- **Production behavior:** unchanged. The tests exercise the existing exact-snapshot marker validation; no code fix or TDD RED/GREEN cycle is claimed.
- **Verification:** focused reviewer suite **44/44 PASS** on Windows Node 24.22.0 for exact commit `333516d8919174c622da49ae72dc1a26f4dc11f8`. Full suite **54/55 PASS** on Windows; the one failure is the expected platform capability guard for `O_NOFOLLOW`. Hosted `ubuntu-24.04` contract job result for this exact commit remains **UNKNOWN** through the connected run query. The Gitleaks PR scan on the same commit passed (run `45062291955`, job `137330676006`).
- **Disposition:** coverage gap addressed; production logic supported by focused tests and source inspection. Linux-hosted full-suite verification remains UNKNOWN.
- **Safety boundary:** test and documentation changes only on `feature/9router-abc-provenance`. No production code, workflow, secrets, repository settings, rulesets, `main`, merge, or deployment changes.


## Latest verification checkpoint — Linux contract suite (2026-11-22)

- Exact audited commit: `e56829a7fdea85e4de91c152b16c36f50da3e61b` on `feature/9router-abc-provenance`.
- GitHub Actions push run `45063177066`, job `137333418069` (`contract-tests`): **55/55 PASS**, zero failures, cancellations, or skips. This is the complete Linux `ubuntu-24.04` suite, including both reviewer and signal-receipt tests. It resolves the earlier Windows-only `O_NOFOLLOW` limitation for this exact commit; the Windows 54/55 result remains a platform-specific observation, not a Linux failure.
- The same job completed `npm ci --ignore-scripts` and `npm audit signatures`; one locked package registry signature was verified.
- Full-history Gitleaks push run `45063177089` and PR run `45063182308`: both completed successfully.
- The `resolve-signal` and `review` jobs were skipped on the push event by design. These results prove the Linux contract suite and secret scans only; they do **not** prove a hosted `pull_request_target → workflow_run` artifact round trip, privileged review execution, live 9Router inference, or report publication.
- PR #262 remains Draft/Open/Unmerged and targets `feature/independent-9router-pr-review`. `main` remains at `919b19ca3d3887352cdef06b03c668ead04fbce7`. No merge, deployment, secret, repository setting, ruleset, Actions policy, or Production change was made.


## Finding 42 — duplicate JSON object keys (2026-11-22)

- **Observed defect:** `parseSignalReceipt` used `JSON.parse` without rejecting duplicate object property names. JavaScript parsing silently keeps the last value for duplicate names; this creates ambiguous receipt bytes even when the resulting object passes the exact schema check.
- **False-positive test rejected:** the first negative fixture contained only three fields and failed because of missing schema fields, not because duplicate keys were detected. It did not establish the hypothesis.
- **Valid RED evidence:** a complete otherwise-valid v1 receipt with a duplicated `schemaVersion` was used. Linux contract run `45063512576`, job `137334461403`, failed exactly one test (54/55) at the receipt parser contract. The failure was the expected missing rejection.
- **Fix:** `parseSignalReceipt` now scans JSON string tokens, decodes candidate property names with `JSON.parse`, tracks keys independently for each object scope, and rejects repeated decoded names before ordinary JSON parsing. This also rejects escaped-equivalent names such as `schemaVersion` and `schema\\u0056ersion`.
- **Explicit regression:** test `receipt parser rejects duplicate and escaped-equivalent JSON object keys` asserts the duplicate-key-specific error for both forms.
- **GREEN evidence:** Linux push run `45063671592`, job `137334965145`: **56/56 PASS**, zero failures/cancellations/skips. `npm ci --ignore-scripts` and `npm audit signatures` completed; one locked package registry signature was verified.
- **Secret scans:** full-history Gitleaks push run `45063671599` and PR run `45063730040` both completed successfully for the implementation checkpoint. Follow-up test-only commits were also scanned successfully: PR run `45063945309`, and final PR/push runs `45064044470` / `45064038423`.
- **Adversarial parser-boundary coverage:** test-only commits added explicit nested-object duplicate detection, sibling-object scope isolation, arrays containing objects, JSON-looking text inside string values, and exact UTF-8 byte-limit behavior. The final Linux contract run `45064038362`, job `137336090626`, passed **58/58** with zero failures, cancellations, or skips. The test also verifies a multibyte UTF-8 receipt at exactly 16 KiB is accepted and one additional byte is rejected.
- **Scope and limits:** these follow-up commits add tests only; the parser implementation did not change after the 56/56 GREEN checkpoint. The 58-test result supports the bounded scanner's exercised behavior, not a formal proof of all JSON parser behavior.
- **Scope:** parser and tests only; no workflow, secret, repository setting, ruleset, Actions policy, merge, deployment, or Production change. Hosted `pull_request_target → workflow_run` artifact E2E remains unverified.


### Finding 43 — strict UTF-8 decoding for artifact receipts (2026-11-22)

- **Threat:** artifact receipt files are bytes. Node's `readFileSync(path, 'utf8')` uses replacement decoding for malformed UTF-8, which can turn invalid byte sequences into U+FFFD and still produce a syntactically valid JSON string. The parser must reject malformed UTF-8 rather than silently normalize it.
- **TDD RED:** test-only commit `adddebbde49351f989e82d4ddfc0260ff7bc1f13`; Linux contract run `45064434801`, job `137337306724`: **58 passed / 1 failed**. The new invalid-byte fixture was accepted by the prior reader; the assertion failed with `Missing expected exception`.
- **Fix:** `readSignalReceiptFile` now reads the bounded file as bytes and decodes with `TextDecoder('utf-8', { fatal: true })`. Invalid UTF-8 is rejected with a fixed, non-sensitive error before JSON parsing.
- **TDD GREEN:** implementation commit `0a449db871a7566c82758b5ce01c49ea074b5437`; Linux contract run `45064486440`, job `137337466058`: **59/59 PASS**, zero failures, cancellations, or skips. `npm ci --ignore-scripts` and `npm audit signatures` completed; one locked package registry signature was verified.
- **Secret scans:** full-history Gitleaks push run `45064486461` and PR run `45064492152` both completed successfully.
- **Scope:** one production parser file and one regression test file changed for the fix; documentation records the evidence. No workflow, secret, repository setting, ruleset, Actions policy, merge, deployment, or Production change.
- **Disposition:** malformed UTF-8 acceptance is a reproduced input-validation defect and is now rejected. This does not establish a hosted artifact round trip or prove resistance to a compromised GitHub control plane.
