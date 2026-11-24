# GitHub Environment Full Posture Census — Evidence Record

## Objective

Collect every independently verifiable Staging and Production GitHub Environment protection control in one read-only execution, even when an earlier control already blocks release. Preserve one shared policy implementation and keep the release verifier fail-closed.

## Architecture

- `inspectEnvironmentProtection` reads Environment metadata once and collects typed findings across independent controls.
- If `custom_branch_policies=true`, it attempts the branch-policy list even when administrator bypass or reviewer controls already fail.
- `verifyEnvironmentProtection` delegates to the same inspector and blocks any non-READY result.
- The read-only audit consumes the inspection and emits all findings for both environments.
- Reviewer User IDs are kept only in the internal release-verification data path. They are not present in audit report objects, summaries, or log output.

## API contract

GitHub documents that:
- `deployment_branch_policy.custom_branch_policies` must be true to use branch-policy list endpoints.
- `deployment_branch_policy: null` means all branches are allowed.
- Environment protection can include up to six required reviewers, with an optional prevent-self-review rule, and an explicit administrator-bypass setting.

References:
- https://docs.github.com/en/rest/deployments/environments?apiVersion=2026-03-10
- https://docs.github.com/en/rest/deployments/branch-policies?apiVersion=2026-03-10
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments

## TDD evidence

- Initial census RED: [run 45379670341](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45379670341) — 481 Node tests, 475 passed / 6 expected failures proving the missing inspector and first-error audit behavior.
- Full posture branch trigger RED: [run 45380481971](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45380481971) — 482 Node tests, 481 passed / 1 expected failure because the read-only preflight did not yet include the census branch.
- Unrestricted policy-state RED: [run 45380737968](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45380737968) — 483 Node tests, 482 passed / 1 expected failure because `deployment_branch_policy=null` was not represented as UNRESTRICTED and the absent reviewer count was not zero.

## Final GREEN verification

- Final implementation commit: `c956fcd3642eb52be5b04d5c95794c9921f1f5d4` (subsequent commits only updated plans and evidence documentation).
- PR CI: [run 45381418193](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381418193).
- Push CI: [run 45381406989](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381406989).

Results:
- Node tests: 483 passed, 0 failed.
- Vitest: 227 passed across 11 files.
- `npm audit --audit-level=moderate`: zero vulnerabilities.
- JavaScript syntax checks passed.
- Wrangler default and Staging dry-runs passed.
- Post-deploy smoke skipped by design.

## Final live read-only census

GitHub Actions [run 45381406983](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381406983) used the existing read-only Actions token permissions and performed GET-only metadata requests.

| Control | Staging | Production |
|---|---|---|
| Environment existence | Present | Missing (HTTP 404) |
| Administrator bypass | Enabled — BLOCKED | Unknown — no Environment |
| Required reviewer rules | 0 — BLOCKED | Unknown — no Environment |
| Required reviewers | 0 | Unknown |
| Prevent self-review | Unknown — no reviewer rule | Unknown |
| Deployment branch policy mode | ALL_BRANCHES | Unknown |
| Custom branch policies | Not configured | Unknown |
| Branch-policy state | UNRESTRICTED | Unknown |
| Overall | BLOCKED | MISSING |

Staging findings:
- `ADMIN_BYPASS_ENABLED`
- `REQUIRED_REVIEWER_RULE_COUNT_MISMATCH`
- `ALL_BRANCHES_ALLOWED`

GitHub's Environment API uses `deployment_branch_policy: null` to represent no branch restrictions; therefore this census correctly records Staging as ALL_BRANCHES / UNRESTRICTED instead of misclassifying it as an unavailable branch-policy endpoint. Because no reviewer rule exists, the configured reviewer count is zero; the self-review setting is not applicable and remains unknown rather than being inferred.

Production findings:
- `ENVIRONMENT_NOT_FOUND`

The audit completed both target inspections, wrote the sanitized step summary, exited non-zero because the environments are not release-ready, and made no deployment attempt.

## Gitleaks

- PR diff scan: [run 45381418198](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381418198) — passed, no leaks found.
- Full fetched refs/reachable history — failed. Repository history cleanliness is not established. No secret fingerprints, payloads, or sensitive match values are reproduced.

## Final-head verification

- Final-head CI and live audit were rerun after the evidence document was added.
- PR CI [45381196959](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381196959): 483/483 Node tests, 227/227 Vitest tests, zero npm audit vulnerabilities, syntax and Wrangler dry-runs passed.
- Live preflight [45381186523](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381186523): reproduced Staging BLOCKED on the three findings above and Production MISSING.
- Gitleaks PR scan [45381197042](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45381197042): PR diff clean; full reachable-history scan failed.

## Safety and repository state

- The read-only audit workflow uses only `actions: read` and `contents: read`.
- No job-level Environment binding is used by the audit.
- No Environment Secrets or Variables were read.
- No Environment configuration was changed.
- No Cloudflare resource or deployment was touched.
- PR #436 remains Draft/open/unmerged and is based on Draft PR #433.
- `main` last verified unchanged at `919b19ca3d3887352cdef06b03c668ead04fbce7`.

## Decision

**Code-level full posture census: provisionally supported by final CI. Live Staging: BLOCKED on three independent controls. Live Production: MISSING. No release is authorized.**
