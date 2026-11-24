# Environment Deployment Review Actor Correlation — Evidence Record

## Scope

This change closes the same-actor gap left by PR #429. A release now requires the same immutable GitHub User ID to approve:
- The exact candidate PR head.
- The deployment to the exact target GitHub Environment for the current workflow run.

## Security contract

1. The release approval verifier validates GITHUB_RUN_ID as a positive safe integer.
2. It obtains the PR approval history and identifies the latest valid review state by numeric GitHub User ID.
3. It excludes the PR author by numeric GitHub User ID rather than login string.
4. It reads GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals with the existing Actions: read permission.
5. It requires exactly one unambiguous approval-history record naming exactly the fixed release Environment.
6. The Environment review state must be approved and its user.id must be a positive safe integer.
7. That deployment reviewer ID must equal the independent PR approval's user.id.
8. Missing, malformed, rejected, mismatched, wrong-environment, duplicate, or ambiguous data blocks release.
9. No deployment review or other mutating endpoint is called.

## TDD and CI evidence

### Valid RED

- Test-only commits: 1bb6de9c79c71a6aca9af328badaadbac00cc519 and 9b2a1fac2c4ac10ad36799c8dcb02ac86919a219.
- CI run 45373113236 executed 461 Node tests: 449 passed and 12 failed.
- The failures covered the missing workflow run ID wiring, absent deployment review lookup, failure to compare Environment approver with PR approver, no exact Environment matching, rejected/missing/ambiguous/malformed approval history, and mutable-login author exclusion.
- These failures were expected behavior assertions or workflow contracts; the test files loaded and ran normally.

### GREEN

- Implementation commits: e79f222704694c5fc4376bc7d7e48c0fe172c076, 3ecf63d2a3da86c6fc689f9d679370d2ceafbe3d, d44608f7f0b8e96dac8bb65bad88dc2384c270a6, d23271461759426cbc34bfb0ea62e4a327904eed, and b7f42069831748ed34998cc20c4d68e183986482.
- Final Cloud Engineering Connector CI: run 45373438907 on head b7f42069831748ed34998cc20c4d68e183986482.
  - Node tests: 461 passed, 0 failed.
  - Vitest: 227 passed across 11 files.
  - npm audit --audit-level=moderate: zero vulnerabilities.
  - JavaScript syntax checks passed.
  - Wrangler default and Staging dry-runs passed.
  - Post-deploy Staging smoke was skipped by design.

## API reference and connector probe

GitHub documents GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals as the workflow-run review history endpoint. Its response includes review state, Environment names, and approving User identity; fine-grained tokens require Actions: read.

A read-only GitHub connector probe against a non-release CI run returned an empty array, which is expected because that run had no Environment deployment approval. This demonstrates endpoint reachability for the selected GitHub connection but does not validate a real protected deployment approval record.

## Secret scanning

- Latest Gitleaks PR diff and fetched-ref run: 45373439069.
- The PR diff scan passed with no leaks.
- The full fetched-ref/reachable-history scan remained non-zero, consistent with the repository's previously observed historical findings. No fingerprints, candidate values, or finding payloads are reproduced.

## Residual limits and unknowns

- No Staging or Production release job was triggered. Real Environment review-history records have not yet been observed from an actual protected release job.
- The live Staging Environment was previously observed without required protection rules or a deployment branch policy; Production Environment was previously absent. The Environment REST endpoints remain unavailable through the current GitHub connector action in this session, so current live settings are not re-certified here.
- The connector probe against a non-release CI run returned an empty review-history array; it does not prove the approval API record shape for an actual deployment run.
- Required reviewer Team identities remain unsupported by the parent PR #429 design.
- No GitHub Environment setting, Secret, Variable, Cloudflare Worker, Durable Object namespace, Queue, deployment, or main content was changed.

## Decision

**Provisionally supported for code and CI validation; live protected-release integration remains unknown.** CI verifies same-actor correlation against deterministic API fixtures, but actual review-history records from a protected release job still require a safe release-preflight validation before production use.
