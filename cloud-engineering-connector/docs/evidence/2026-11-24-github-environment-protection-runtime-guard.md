# GitHub Environment Protection Runtime Guard — Evidence Record

## Scope

This change adds a fail-closed, metadata-only guard to both connector release workflows. It does not configure GitHub Environments; it prevents a release job from reaching any credential-bearing step unless the live Environment metadata meets the release contract.

## Security contract

The guard checks only these GitHub REST resources:

- `GET /repos/{owner}/{repo}/environments/{environment_name}`
- `GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies`

The workflow token is restricted to `contents: read`, `pull-requests: read`, and `actions: read`. It never calls Environment Secrets or Variables endpoints.

The gate requires:

- Exact Environment identity: `staging` or `production`.
- `can_admins_bypass === false`.
- Exactly one required-reviewer rule, with at least one valid User or Team identity.
- `prevent_self_review === true`.
- `deployment_branch_policy.protected_branches === false`.
- `deployment_branch_policy.custom_branch_policies === true`.
- Exactly one branch policy: `integration/staging-release-*` for Staging or `integration/production-release-*` for Production.
- Complete pagination, valid response shapes, and successful HTTP responses. Missing, denied, malformed, or incomplete data blocks the release.

## Execution boundary

The guard runs after Node setup and before independent approval validation, MCP token validation, dependency installation, Cloudflare preflight, or any other step that maps an Environment Secret. Its step receives only `GITHUB_REPOSITORY`, fixed `RELEASE_ENV`, and the read-only `GITHUB_TOKEN`.

The existing release candidate SHA check remains in force. This guard complements, and does not replace, the immutable-candidate approval gate.

## Verification protocol

- Test-first RED commit: `b60fa073b369a050b0b8716707c92e95fbf20b75`.
- Corrected test registration and workflow test matcher: `496a7458cabb5694c9e30d31ce67521020167be6`.
- The initial run at the first RED commit is not accepted as TDD evidence because the new tests were not registered in `test:node`; the syntax checker failed on the intentionally absent module.
- The corrected RED run is recorded as expected failure only because the new behavior tests execute and fail on the absent verifier and absent workflow guard.
- GREEN evidence and exact-head test counts are added after final implementation CI.

## Live configuration facts at audit time (2026-11-24)

- The live `staging` Environment had no protection rules and no deployment branch policy.
- The live `production` Environment was absent.
- No Environment Secret names or values were read by this verification.
- The guard is expected to block both release workflows until the owner configures the required Environment settings.

## Safety

- Draft PR #427 is based on Draft PR #421.
- No GitHub Environment settings, Secrets, Variables, Cloudflare resources, Workers, Durable Object namespaces, Queues, deployments, or `main` content were changed.
- No merge or release was performed.