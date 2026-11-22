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

- `9router-pr-review-signal.yml` runs on the unprivileged `pull_request` event with an empty permission set. It does not check out pull-request code, download artifacts, or execute repository scripts.
- `9router-pr-review.yml` runs later on `workflow_run`, using its copy from the trusted default branch. It accepts only successful runs from the exact signal workflow path and only when the PR head repository is this repository.
- The privileged workflow does not download or consume artifacts from the unprivileged run. It fetches PR metadata and patches directly from GitHub's API as data.
- Fork-originated PRs are intentionally skipped. This first version reviews same-repository branches only.
- The privileged job checks out only the trusted default branch; it never checks out or executes pull-request code.
- Uses the immutable head SHA attached to the completed signal workflow run (not the mutable PR association metadata), then rechecks the live PR head before sending the patch to 9Router and again before publishing the report. If the PR advanced after the signal run, the stale review is rejected.
- Missing file patches, empty diffs, oversized patches, invalid event provenance, and stale head SHAs stop the review instead of producing a partial or stale report.
- Patch content and filenames are untrusted prompt data.
- Posts or updates a single report comment per exact head SHA. It updates only comments authored by `github-actions[bot]`, and scans at most 1000 comments before failing closed.
- Uses `GITHUB_TOKEN` only for reading repository contents and PR metadata/files and writing PR comments. No contents write, review approval, merge, or deployment permission is requested.
- Requires HTTPS for the 9Router endpoint and rejects embedded credentials, query parameters, and URL fragments.
- Suppresses API response bodies on errors to avoid leaking provider diagnostics or credentials into logs.

## Activation boundary

The privileged `workflow_run` automation becomes active only after this setup PR is reviewed and merged into the default branch. Until the secrets and model variable are configured, the workflow emits a warning and does not call 9Router. The setup branch's contract tests do not require a live 9Router account.

## Review interpretation

Each finding must use one of `SUPPORTED`, `DISPUTED`, `REJECTED`, or `UNKNOWN`. `UNKNOWN` is not a pass or fail. The model is not a human reviewer and its report is not proof of correctness; findings require independent verification.
