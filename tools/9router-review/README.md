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

- `9router-pr-review-signal.yml` runs on `pull_request_target`, whose workflow definition is taken from the base repository's default branch rather than the PR merge commit. Its workflow and job permissions are empty; it performs only a fixed echo and does not check out pull-request code, download artifacts, execute repository scripts, or reference secrets. A PR cannot replace this signal workflow definition through its own diff.
- `9router-pr-review.yml` runs later on `workflow_run`, using its copy from the trusted default branch. It accepts only successful `pull_request_target` runs from the exact signal workflow path and verifies that both the PR head and base repositories are this repository.
- The privileged workflow does not download or consume artifacts from the unprivileged run. It fetches PR metadata and patches directly from GitHub's API as data.
- Fork-originated PRs are intentionally skipped by checking the associated PR's `head.repo.full_name`, not merely the workflow-run repository metadata. This first version reviews same-repository branches only.
- The privileged job checks out only the trusted default branch; it never checks out or executes pull-request code.
- Uses immutable PR head and base SHA snapshots from `workflow_run.pull_requests[0].head.sha` and `.base.sha`; it does not mistake `workflow_run.head_sha` (which can represent the `pull_request` merge ref) for the PR branch head. It rechecks both live PR SHAs before sending the patch to 9Router, after model generation, and again immediately before append-only comment publication. If either side of the PR diff changes during those stages, the stale review is rejected. A residual race remains between the final GitHub metadata read and the subsequent comment write because GitHub does not provide a transaction spanning PR metadata and issue-comment creation.
- Missing file patches, empty diffs, oversized patches, invalid event provenance, and stale head SHAs stop the review instead of producing a partial or stale report. The cumulative formatted patch budget is enforced as each file is received, so pagination stops immediately when the 45,000-character ceiling is crossed rather than fetching later pages.
- Patch content and filenames are untrusted prompt data. The complete patch is passed as a JSON-encoded string rather than sentinel-delimited raw text, preventing patch contents from forging the prompt's closing delimiter. This framing does not eliminate semantic prompt injection; the model must still treat the decoded patch as data only.
- Model-generated reports are parsed with the pinned `marked@17.0.1` GitHub-flavored Markdown lexer and rebuilt from an explicit AST allowlist. Headings, paragraphs, emphasis, strikethrough, inline/fenced code, blockquotes, lists, tables, and horizontal rules are preserved. Link and image nodes are converted to inert text placeholders; raw HTML and reference definitions are discarded; bare URL/autolink nodes are replaced; unknown AST node types fail closed. Rebuilt text is escaped before Markdown serialization and GitHub mentions are neutralized. This is an AST-based structural sanitizer; GitHub's hosted renderer remains a separate rendering boundary and requires continued hostile regression coverage.
- The parser dependency is pinned to `marked@17.0.1` in `package.json` and `package-lock.json`; CI installs only the lockfile-resolved package with `npm ci --ignore-scripts` and verifies its registry signature and provenance using `npm audit signatures`. The locked package has no runtime dependencies; the latest verified run reported zero package vulnerabilities.
- Every GitHub API JSON response body is streamed with a 1 MiB hard byte ceiling before parsing; oversized bodies are canceled and rejected before subsequent review stages. The 9Router HTTP response body is separately streamed with a 512 KiB hard byte ceiling before JSON parsing; oversized bodies are canceled and rejected before comment lookup or publication. The sanitized model report is separately capped at 30,000 UTF-16 code units. Oversized output is rejected rather than truncated, preserving report integrity and leaving a conservative margin below GitHub's 65,536-character issue-comment limit.
- **Append-only publication:** Every successful execution POSTs a new issue comment containing the reviewed head and base SHAs. The reviewer never lists comment history, never searches for an existing marker, and never PATCHes or deletes a prior comment. A spoofed or duplicate marker therefore cannot overwrite a report or suppress a new report. This removes comment-history pagination and its cumulative 4 MiB budget from the publication path. The trade-off is at-least-once behavior: if GitHub creates a comment but the response is lost, a rerun may create a duplicate. Duplicate reports are accepted rather than reconciled through untrusted comment identity.
- **Concurrency and recovery:** Review jobs are serialized per PR using a concurrency group keyed by PR number, with `queue: max`. GitHub permits at most 100 pending jobs in that group; additional jobs are canceled when the queue is full. GitHub processes queued jobs FIFO by the time they begin waiting, but does not guarantee ordering by workflow-dispatch time. Immutable head/base checks prevent stale jobs from publishing after the PR diff changes; they do not guarantee that every intermediate event is reviewed. If a comment POST succeeds remotely but its response is lost, a later rerun may create a duplicate because it deliberately does not inspect or mutate prior comments. This is an explicit at-least-once delivery trade-off, not exactly-once delivery.
- **Comment provenance limitation:** A comment authored by `github-actions[bot]` is not cryptographic proof that this reviewer workflow created it. Another privileged workflow could still post a misleading lookalike report. However, append-only publication never reads comments as control input, so a spoofed marker cannot cause this reviewer to overwrite a comment, skip publication, or select an arbitrary comment. Human readers must still treat comment authorship and report content as untrusted unless separately verified.
- Uses `GITHUB_TOKEN` only for reading repository contents and PR metadata/files and writing PR comments. No contents write, review approval, merge, or deployment permission is requested.
- Requires HTTPS for the 9Router endpoint and rejects embedded credentials, query parameters, and URL fragments.
- Suppresses API response bodies on errors to avoid leaking provider diagnostics or credentials into logs, and explicitly cancels unread non-success response streams to release transport resources.

## Activation boundary

The privileged `workflow_run` automation becomes active only after this setup PR is reviewed and merged into the default branch. Until the secrets and model variable are configured, the workflow emits a warning and does not call 9Router. The setup branch's contract tests do not require a live 9Router account.

## Review interpretation

Each finding must use one of `SUPPORTED`, `DISPUTED`, `REJECTED`, or `UNKNOWN`. `UNKNOWN` is not a pass or fail. The model is not a human reviewer and its report is not proof of correctness; findings require independent verification.


### Finding 21: Existing bot-comment identity was not a trustworthy update target — remediated with append-only publication
- **Finding:** Matching `github-actions[bot]` plus a predictable head/base marker did not prove that a comment was created by this exact reviewer workflow. The reviewer could PATCH a forged or unrelated matching comment.
- **TDD RED:** run `45033942148`, 29 passed / 1 failed. A synthetic existing bot comment with the exact head/base marker caused a comment-history read, violating the required append-only contract.
- **Remediation:** Every successful run performs a fresh comment POST. The implementation has no comment-history GET, marker-based deduplication, comment PATCH, or delete path. The report marker remains trace metadata only.
- **TDD GREEN:** run `45034129815`, 30/30 contract tests passed. Tests verify that existing matching comments and duplicate matching comments are ignored, no history request or PATCH occurs, and a new report is POSTed.
- **Trade-off:** A POST whose response is lost may be duplicated by a rerun. This is accepted at-least-once behavior; no exactly-once guarantee is claimed.
- **Residual limitation:** A separate privileged workflow could still post a misleading lookalike comment as `github-actions[bot]`. The reviewer no longer consumes that comment as program state, so it cannot alter the reviewer's publication behavior; human attribution still requires independent verification.
