# GitHub Environment Read-Only Preflight — Evidence Record

## Scope

This change adds a dedicated read-only GitHub Actions workflow to inspect the live Staging and Production Environment protection contracts from inside GitHub Actions. It does not declare a job-level `environment:` property, deploy a Worker, or modify GitHub configuration.

The implementation reuses `verifyEnvironmentProtection` from the release path. No second, divergent policy implementation was introduced.

## Security properties

- The workflow triggers only on push to `security/environment-read-only-preflight-*`.
- Its only repository token permissions are `actions: read` and `contents: read`.
- It has no job-level `environment:` property; an absent Production Environment is not created by this audit.
- The audit accesses only the existing Environment metadata and deployment-branch-policy GET endpoints.
- It never requests Environment Secrets or Variables.
- It never calls Cloudflare or any deployment endpoint.
- The report includes only Environment name, readiness status, reviewer count, expected branch pattern, and a sanitized reason. It does not print reviewer IDs, token values, or raw API response bodies.
- Both targets are audited independently; one target failing does not suppress inspection of the other.

## Status model

- `READY`: the existing Environment verifier accepted the full release protection contract.
- `BLOCKED`: Environment metadata is available but a required policy is invalid, or the deployment branch-policy resource is unavailable for the existing Environment.
- `MISSING`: the Environment metadata endpoint itself returned HTTP 404.
- `UNKNOWN`: permission, transport, malformed response, or incomplete pagination prevents a trustworthy determination.

The workflow exits non-zero if either target is not READY. A failed audit is an expected and meaningful live-configuration result; it is not a software CI test failure.

## Valid RED

- Test-only head: `f370b4f2dd559d70af53994f71bce8a4439f15a9`.
- Cloud Engineering Connector CI [45374709890](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45374709890) ran 471 Node tests: 461 passed and 10 failed on the intentionally absent audit script and workflow. The test files loaded and produced the expected assertions; dependency audit passed.

## GREEN verification

- Final code head before evidence documentation: `edf648fc1459e88b43500fe038fff26aea42ad31`.
- Cloud Engineering Connector CI [45375058540](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45375058540):
  - Node tests: 471 passed, 0 failed.
  - Vitest: 227 passed across 11 files.
  - `npm audit --audit-level=moderate`: zero vulnerabilities.
  - JavaScript syntax checks passed.
  - Wrangler default and Staging dry-runs passed.
  - Post-deploy Staging smoke was skipped by design.
- Orchestrator GitHub Intake workflow [45375058495](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45375058495): success.

## Live read-only Environment results

GitHub Actions run [45375047610](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45375047610) executed the audit against the repository's actual GitHub API state:

| Environment | Observed result | Evidence |
|---|---|---|
| Staging | BLOCKED | Environment metadata retrieval succeeded far enough to request deployment branch policies; that branch-policy endpoint returned HTTP 404. The existing verifier therefore refused to treat the branch policy as verified. |
| Production | MISSING | The Production Environment metadata endpoint itself returned HTTP 404. |

The workflow failed closed and made no deployment attempt. The Staging result does not, by itself, distinguish whether custom branch policies are disabled or another reason makes that endpoint unavailable; it proves only that the required branch-policy resource could not be verified. The Production result proves the Environment was not found at the time of this audit.

This audit is the first current-run read-only observation in this branch and supersedes reliance on the connected GitHub plugin for these two endpoints. It does not configure or repair either Environment.

## Secret scanning

- Latest Gitleaks scan [45375058402](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45375058402): PR diff scan passed with no leaks.
- The full fetched-ref/reachable-history scan failed. No fingerprint, secret-shaped value, or finding payload is reproduced. A clean PR diff is not evidence that the repository's full history is clean.

## Residual limits

- No live Environment protection settings were changed.
- No Environment Secret or Variable was read, written, or created.
- No Cloudflare Worker, Durable Object namespace, Queue, or deployment was touched.
- The Staging branch-policy endpoint remains unavailable and Production remains absent; release workflows must continue to fail closed.
- This workflow is an audit, not a release authorization and not a remediation action.
- The audit was executed before this evidence document was added; a fresh CI run on the final documentation head is required and will be recorded in the PR checks.

## Decision

**Live operational finding: Staging BLOCKED; Production MISSING. Code-level audit implementation: provisionally supported by passing CI. No release is authorized by this result.**
