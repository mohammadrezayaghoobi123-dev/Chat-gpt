# 9Router Trusted Manual Review Bootstrap

## Status and scope

This bootstrap provides a trusted-default-branch manual resolver and a disabled reviewer job. It is intentionally not an automatic PR reviewer. The workflow file must first be registered on `main` by a separately reviewed and separately approved change before GitHub can dispatch its `issue_comment` or `workflow_dispatch` events.

The initial workflow exposes only two events:

- `issue_comment: created`, accepted only when the entire comment body is exactly `/review-canary`, the issue is a pull request, and the actor ID is `335530603`.
- `workflow_dispatch`, accepted only when the run ref is exactly `refs/heads/main`, the actor ID is `335530603`, and `pull_request_number` is a canonical positive decimal string.

The resolver obtains the live pull request directly through `GET /repos/{owner}/{repo}/pulls/{number}`. It requires the same repository ID and full name for the base and head repositories, an open non-draft and unlocked PR, valid immutable head/base SHAs, and a valid base ref. API errors, timeouts, malformed or oversized responses, and transport failures are `UNKNOWN` and fail closed. For a future `pull_request_target` integration, event head/base SHAs and base ref must exactly match the live API snapshot; that event is not enabled by this bootstrap.

## Trust and privilege boundaries

- The workflow checks out only `${{ github.workflow_sha }}` with `persist-credentials: false`; it never checks out a PR head.
- The resolver job receives only `contents: read` and `pull-requests: read` permissions and uses only the job-scoped `github.token` for the read-only PR lookup.
- The workflow has no `pull_request`, `pull_request_target`, `workflow_run`, `push`, or `schedule` trigger.
- The reviewer job has a literal `if: false`, an empty permissions map, and no router, marker, model, provider, or other secret references.
- The canary does not call 9Router, dispatch a provider/model request, read router/marker secrets, post PR comments, create artifacts, or deploy services.
- Comment text after the exact command is not passed to the resolver output or reviewer prompt. The current job condition requires the whole body to equal the command, providing a stricter gate than first-line parsing alone.

## Bootstrap validation

From `tools/9router-review` on Node.js 22 or later:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The test suite includes the pinned reviewer transport regression tests and resolver adversarial tests. The workflow repeats this test command before making the read-only API call. The initial PR branch does not register this workflow on the default branch, so no claim of hosted manual-event execution is made from branch-local tests.

## Manual canary procedure after separate default-branch registration

1. Confirm the workflow file is present on `main` at the expected reviewed commit.
2. Use an owner-authored PR conversation comment whose entire body is `/review-canary`, or dispatch the workflow against `main` with a canonical PR number.
3. Confirm the `resolve` job runs the pinned tests, performs one read-only live PR lookup, and emits only the validated repository/PR snapshot identifiers.
4. Confirm the `reviewer` job is skipped because its condition is statically false.
5. Inspect the run for zero 9Router requests, provider dispatches, router/marker secret reads, PR comment writes, artifacts, and deployments.
6. Preserve the exact workflow run ID, workflow SHA, event payload identity, resolved PR snapshot, and job conclusions as the canary evidence record.

A successful canary proves only the manual trigger and live resolver path for that exact run and PR snapshot. It does not prove automatic event delivery, secret storage scope, durable cross-run dispatch uniqueness, provider billing semantics, runtime deployment identity, or exactly-once model execution.

## Rollback

If validation fails, keep the reviewer disabled and do not retry uncertain API or future model/publication operations automatically. Once registered on `main`, remove or revert the workflow only through a separately reviewed revert PR. Do not change Actions policies, repository settings, permissions, secrets, Cloudflare resources, deployments, or local runtime configuration to bypass a failure.

## Source provenance

The reviewer runtime and redirect regression suite are carried forward without modification from PR #431 head `59c71d9451b04fe13f53c6cb9283039cfe456f60`:

- `review.js`: blob `498e92e3ab8daec12c7ee61cc9fc0892e1d3ff46`
- `review.test.mjs`: blob `989d77da4d7ab3c146fe2be66a7a327fcb0096c4`
- `package.json`: dependency contract `marked@17.0.1`
- `package-lock.json`: lockfile version 3, exact `marked@17.0.1` integrity pin
- `run-review.mjs`: retained as inert runtime entry point; the bootstrap workflow never invokes it

The source workflow's automatic triggers and signal/receipt components are deliberately not copied. The original PR #431 remains unchanged and unmerged.
