# GitHub Environment Protection Runtime Guard — Evidence Record

## Scope

This change adds a fail-closed, metadata-only guard to both connector release workflows. It does not configure GitHub Environments; it prevents a release job from reaching any credential-bearing step unless the live Environment metadata meets the release contract.

## Security contract

The guard checks only these GitHub REST resources:

- `GET /repos/{owner}/{repo}/environments/{environment_name}`
- `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies`

The workflow token is restricted to `contents: read`, `pull-requests: read`, and `actions: read`. The guard performs GET requests only and never calls Environment Secrets or Variables endpoints.

The gate requires:

- Exact Environment identity: `staging` or `production`.
- `can_admins_bypass === false`.
- Exactly one required-reviewer rule, with between one and six valid User or Team identities.
- `prevent_self_review === true`.
- `deployment_branch_policy.protected_branches === false`.
- `deployment_branch_policy.custom_branch_policies === true`.
- Exactly one branch policy: `integration/staging-release-*` for Staging or `integration/production-release-*` for Production.
- Complete pagination, stable pagination totals, valid response shapes, and successful HTTP responses.
- Missing, denied, malformed, incomplete, or widened policy metadata blocks the release.

## Execution boundary

The guard runs immediately after Node setup and before independent approval validation, MCP token validation, dependency installation, Cloudflare preflight, or any other step that maps an Environment Secret. Its step receives only `GITHUB_REPOSITORY`, the fixed `RELEASE_ENV`, and `GITHUB_TOKEN`.

A workflow contract test scans every `${{ secrets.* }}` reference in both release workflows and requires the runtime guard to precede every one of them. It does not depend on the names of today's credentials.

The existing immutable release-branch SHA check and independent candidate approval remain in force. This guard complements, and does not replace, the candidate approval gate.

## TDD and verification evidence

### RED

- Test-first commit: `b60fa073b369a050b0b8716707c92e95fbf20b75`.
- That first attempt is **not accepted as valid RED evidence**: the new tests were not registered in `test:node`, so the test command did not execute them; the syntax check then failed because the not-yet-created module was absent.
- Corrected test-registration commit: `496a7458cabb5694c9e30d31ce67521020167be6`.
- Corrected RED CI run [45367188436](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45367188436): 446 Node tests; 431 passed and 15 failed. The 15 expected failures were the two workflow-guard contract tests and 13 verifier behavior tests, because the verifier and workflow guard had not yet been implemented. Dependency audit passed.

### GREEN

- Final code/test head: `4bdda22d3f7854dbc432270dd6e23064ff57bba2`.
- Cloud Engineering Connector CI [45368369073](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45368369073): success.
  - Node: 446 passed, 0 failed.
  - Vitest: 227 passed across 11 files.
  - `npm audit --audit-level=moderate`: zero vulnerabilities.
  - JavaScript syntax checks passed.
  - Wrangler default and Staging dry-runs passed.
- Orchestrator GitHub Intake Contract [45368369014](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45368369014): success.
- The `post-deploy-staging-smoke` job was skipped by design. No live Staging or Production deployment or smoke test was run.

### Secret scanning

- Full History Secret Scan [45368369103](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45368369103): the PR diff scan found no leaks.
- The full reachable-history scan remained non-zero with 14 historical findings. These findings are not attributed to this PR. No secret values, fingerprints, or finding payloads are reproduced.

## Live Environment facts and operational consequence (2026-11-24)

A public, read-only GitHub REST audit found:

- The live `staging` Environment had no protection rules and no deployment branch policy.
- The `production` Environment was absent.
- A separate Environment named `MCP_AUTH_TOKEN` existed but is not the name consumed by the workflow's `secrets.MCP_AUTH_TOKEN` reference.

Consequently, until the owner configures the required protections, the Staging release guard will fail closed. A first Production workflow reference may cause GitHub to create the missing Environment; the new guard rejects its unprotected default state before any Environment Secret is mapped.

No Environment Secret names or values were read by this verification.

## Safety

- Draft PR #427 is based on Draft PR #421.
- No GitHub Environment settings, Secrets, Variables, Cloudflare resources, Workers, Durable Object namespaces, Queues, deployments, or `main` content were changed.
- No merge or release was performed.
