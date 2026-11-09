# Repository PR Quality Gate

## Required check

The single required status-check context is:

`PR Quality Gate / required`

The workflow is `.github/workflows/pr-quality-gate.yml`. It runs for every pull request, without path or base-branch filters, and invokes the repository's deterministic test and security workflows against the pull-request merge candidate.

The final `required` job runs even when dependencies fail. It succeeds only when all 12 validation workflows conclude `success`; a failed, cancelled, or skipped workflow blocks the gate.

## Included validations

- Cloud Engineering Connector CI (Node tests, npm audit, syntax and Wrangler dry-runs)
- Cloud Agent CI (tests, npm audit, syntax and Wrangler dry-run)
- CTP Evidence Lab tests
- Dev Container security checks
- Lost BTC Scout tests and checks
- Master Brain MCP tests, npm audit and syntax
- Master Brain MVP unit and kernel-enforcement tests
- Orchestrator GitHub Intake contract tests
- Python pytest suite
- Full-history Gitleaks scan
- Ruff and Mypy static analysis
- Browser end-to-end and accessibility checks

Deployment workflows, post-deployment smoke tests, live third-party API probes, and diagnostic-only workflows are intentionally not invoked as PR build checks. They are separate release or operational acceptance controls and must not deploy as a side effect of a PR.

## Repository ruleset configuration still required

The repository Ruleset currently named `main` protects only `refs/heads/main` and has no required status-check rule. After this workflow is merged into each intended PR base lineage, a repository administrator must configure active rulesets for every PR destination branch that must be protected and require exactly `PR Quality Gate / required` as a status check. Keep the existing review and conversation-resolution requirements.

Do not claim repository-wide enforcement until the active ruleset configuration is read back and verified. The connected GitHub integration used to prepare this change supports ruleset reads but does not expose ruleset writes.

## Safety boundaries

- No workflow in this gate deploys to Staging, Production, GitHub Pages, or Cloudflare.
- No secrets are printed or read by this workflow.
- `main` is not modified by this change; the implementation is proposed through an isolated branch and pull request.


## Base refresh evidence — 2026-11-09

The Integration base advanced after PR #206 was merged at `fdc07922cf53fe64c7fa2323e35a09d0b89c79d1`. This PR must be revalidated against the refreshed Integration merge candidate; the earlier exact-head gate run is not evidence for the refreshed merge candidate. The PR remains Draft until all 12 validations pass on the refreshed candidate, independent review is approved, and the repository Ruleset is read back with the required status check enabled.
