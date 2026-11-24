# Environment Branch Policy State Disambiguation — Evidence Record

## Objective

Correct the diagnostic ambiguity between an Environment with custom deployment branch policies disabled and a branch-policy API resource that cannot be verified. Keep the release verifier fail-closed and give the read-only preflight a stable machine-readable classification.

## Official API contract

GitHub documents that deployment branch-policy endpoints require `deployment_branch_policy.custom_branch_policies=true`; Environment metadata returns the `deployment_branch_policy` object with `protected_branches` and `custom_branch_policies` flags.

References:
- https://docs.github.com/en/rest/deployments/branch-policies?apiVersion=2026-03-10
- https://docs.github.com/en/rest/deployments/environments?apiVersion=2026-03-10

The verifier now checks Environment metadata before calling the dependent branch-policy list endpoint. It uses stable error codes:
- `ENVIRONMENT_NOT_FOUND`
- `POLICY_MISMATCH`
- `BRANCH_POLICY_ENDPOINT_NOT_FOUND`
- `API_REQUEST_FAILED`
- `API_UNAVAILABLE`
- `API_RESPONSE_INVALID`
- `API_STATE_INCONSISTENT`

The audit maps these codes to `MISSING`, `BLOCKED`, or `UNKNOWN`; unrecognized failures default to `UNKNOWN`. The release-facing verifier continues to reject every non-verified state.

## Valid RED

- Test-only SHA: `3edf38d352394db235461d6ef7d94264c1a71302`.
- CI run [45376571259](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45376571259): 474 Node tests, 471 passed and 3 failed as expected.
- The failures proved that the prior verifier made a branch-policy request even when `custom_branch_policies=false`, and that branch-policy HTTP 404 was incorrectly classified as `BLOCKED` after Environment metadata explicitly declared custom policies enabled.

## Additional trigger contract

- Added a narrow push trigger for `security/environment-branch-policy-state-disambiguation-*` so the same read-only live preflight can validate this diagnostic child branch.
- RED run [45377335389](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45377335389): 475 Node tests, 474 passed and 1 failed because the dedicated audit workflow did not yet include the diagnostic branch pattern.
- The workflow was updated to include only the explicit diagnostic branch prefix; token permissions remain `actions: read` and `contents: read`.

## Final GREEN verification

- Final implementation and evidence SHA before this record refresh: `7d0c037919b999a1a8a9fa3d52468745b44270f9`.
- Cloud Engineering Connector CI [45377732939](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45377732939):
  - Node tests: 475 passed, 0 failed.
  - Vitest: 227 passed across 11 files.
  - `npm audit --audit-level=moderate`: zero vulnerabilities.
  - JavaScript syntax checks passed.
  - Wrangler default and Staging dry-runs passed.
  - Post-deploy smoke was skipped by design.
- The verifier tests confirm:
  - Disabled custom deployment branch policies cause `BLOCKED` without calling the branch-policy endpoint.
  - Branch-policy endpoint 404 after `custom_branch_policies=true` is reported as `UNKNOWN`.
  - Environment metadata 404 remains `MISSING`.
  - Other Environment-level policy mismatches remain release-blocking.

## Live read-only results

GitHub Actions run [45377727301](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45377727301) ran the same read-only audit against the live repository metadata:

| Environment | Result | Finding |
|---|---|---|
| Staging | BLOCKED | `can_admins_bypass` is enabled; the shared verifier correctly stops the release before proceeding. |
| Production | MISSING | The Production Environment metadata endpoint returned HTTP 404. |

**Diagnostic limit:** Because Staging fails the administrator-bypass check first, this live run does not establish the Staging `deployment_branch_policy` flags. Their current live values remain **UNKNOWN**. The previous branch-policy-endpoint 404 observation is not reinterpreted as proof that custom policies are disabled. The unit tests prove the two possible classifications under controlled fixtures, but do not substitute for the live flag value.

The audit made no deployment attempt and performed no writes.

## Secret scanning

- Gitleaks run [45377732918](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45377732918): PR diff scan passed with no leaks.
- Full fetched-ref/reachable-history scan failed. The history result remains unresolved; no finding payload or fingerprint is reproduced.

## Additional workflow verification

- The dedicated preflight workflow is triggered on the original preflight branch family and the exact branch-policy diagnosis branch family.
- The trigger contract itself was exercised test-first: [RED run 45377335389](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45377335389) ran 475 Node tests, 474 passed and 1 expected failure before the branch pattern was added.
- Final CI run 45377732939 includes the trigger-contract test and passes all 475 Node tests.

## Safety and repository state

- No Environment configuration, Secrets, or Variables were changed or read.
- No Cloudflare resources or deployments were touched.
- The preflight uses GET-only Environment metadata routes and remains fail-closed.
- PR #433 remains Draft/open/unmerged, based on PR #432.
- PR #432 and its parent chain remain Draft/open/unmerged.
- `main` was not modified; last verified SHA remains `919b19ca3d3887352cdef06b03c668ead04fbce7`.

## Decision

**Code-level diagnostic behavior: provisionally supported by final CI. Live Staging: BLOCKED by administrator bypass. Live Production: MISSING. Staging Custom Branch Policy flags: UNKNOWN. No release is authorized.**
