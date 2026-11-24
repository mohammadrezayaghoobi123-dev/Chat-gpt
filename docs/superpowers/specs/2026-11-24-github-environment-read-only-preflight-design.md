# GitHub Environment Read-Only Preflight — Design

## Intent

Obtain a current, auditable snapshot of the actual GitHub Staging and Production Environment protection settings without relying on the connected GitHub plugin's restricted Environment REST surface.

## Selected approach

Add a small Node.js audit script that calls the existing `verifyEnvironmentProtection` function for both fixed targets and records a per-target status. A dedicated GitHub Actions workflow runs the script on pushes to a narrow security branch prefix with only `contents: read` and `actions: read`.

The workflow deliberately has no job-level `environment:` key. This prevents the workflow from creating the missing Production Environment by referencing it. The script sends GET requests only, uses the standard read-only `GITHUB_TOKEN`, and never reads Environment Secrets or Variables.

## Result model

- `READY`: live metadata satisfies the exact existing release protection contract.
- `BLOCKED`: Environment exists and policy metadata was retrieved, but one or more security requirements are not satisfied.
- `MISSING`: GitHub returned HTTP 404 for the Environment.
- `UNKNOWN`: metadata could not be obtained or validated due to denied access, transport failure, malformed response, or incomplete pagination.

The audit always attempts both environments. It writes a sanitized summary containing environment name, status, reviewer count, branch pattern, and a safe reason. It does not print reviewer IDs or raw API responses.

## Alternatives considered

1. **Dedicated read-only Actions audit workflow (selected):** Executes the same verifier with the workflow's scoped read token and provides inspectable live evidence. No environment binding or deployment is required.
2. **Ask the user to copy settings from the GitHub UI:** avoids code changes but provides weaker reproducibility and is error-prone for pagination and exact policy matching.
3. **Add a deployment job to trigger Environment review:** not selected because it couples the audit to a deployment-capable path and risks creating or mutating an Environment.

## Constraints

- Fixed targets only: `staging` and `production`.
- GET requests only; no POST, PATCH, PUT, or DELETE.
- Token permissions: `actions: read`, `contents: read`.
- No job-level `environment:` declaration.
- No Secrets or Variables endpoints or values.
- No Cloudflare calls, deployment steps, or write operations.
- Workflow trigger restricted to the dedicated audit branch prefix.
- Keep the PR Draft, open, and unmerged; do not modify `main`.

## Non-goals

- Configure or create either GitHub Environment.
- Make the audit itself a release or deployment authorization.
- Relax the shared release verifier or any existing fail-closed checks.
- Remediate policy findings automatically.
