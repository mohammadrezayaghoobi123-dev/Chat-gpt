# Independent 9Router PR Review

This integration sends a pull-request diff to a configured 9Router OpenAI-compatible endpoint and posts a model-assisted report as an issue comment. It does not submit GitHub review approvals, merge, modify source files, deploy, or change repository settings.

## Required GitHub configuration

Add these repository Actions secrets only after a trusted 9Router instance and API key are available:

- `NINE_ROUTER_API_URL`: HTTPS API base URL, for example `https://9router.com/v1` or the HTTPS base URL of a separately hosted instance.
- `NINE_ROUTER_API_KEY`: dedicated 9Router API key with the minimum required access.

Add this repository Actions variable:

- `NINE_ROUTER_MODEL`: exact model identifier configured in 9Router.

Never commit these values or paste the API key into issues, pull requests, or chat.

## Security model

- Uses `pull_request_target` so the workflow and reviewer code are loaded from the trusted base branch.
- Checks out only the repository default branch; it never checks out or executes pull-request code.
- Uses the exact head SHA from the event and independently checks that the live PR head still matches before review.
- Sends only the PR file patches to the configured model endpoint. A missing patch or oversized diff stops the run instead of silently reviewing a partial diff.
- Treats patch content as untrusted prompt data.
- Posts or updates one report comment per exact head SHA.
- Uses `GITHUB_TOKEN` only for reading PR metadata/files and writing an issue comment. No contents write, review approval, merge, or deployment permission is requested.
- Suppresses API response bodies on errors to avoid leaking provider diagnostics or credentials into logs.

## Activation boundary

The `pull_request_target` automation becomes active only after this setup PR is reviewed and merged into the default branch. Until the secrets and model variable are configured, the workflow emits a notice and does not call 9Router. The setup branch's contract tests do not require a live 9Router account.

## Review interpretation

Each finding must use one of `SUPPORTED`, `DISPUTED`, `REJECTED`, or `UNKNOWN`. `UNKNOWN` is not a pass or fail. The model is not a human reviewer and its report is not proof of correctness; findings require independent verification.
