# Environment Deployment Review Actor Correlation — Design

## Intent

Strengthen the release authorization boundary so the same independent GitHub User must approve both the exact candidate pull request and the actual deployment to the target GitHub Environment for the current workflow run.

## Current gap

The release approval gate already binds the candidate PR approval to the immutable User IDs configured as required reviewers on the protected Environment. However, it did not yet prove that the actor who approved the Environment deployment was the same User who approved the PR.

## Selected approach

Use the read-only GitHub REST endpoint GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals. GitHub documents that this review-history endpoint returns each approval state, the Environment names, and the approving User identity, and requires Actions: read for fine-grained tokens.

The current release workflows already grant Actions: read. The exact workflow run ID is passed from github.run_id. The release verifier requires exactly one unambiguous approved review record for the fixed target Environment and compares its numeric user.id with the numeric user.id of the independent PR approval.

The verifier also excludes the PR author by numeric User ID rather than mutable login text.

## Alternatives considered

1. **GET workflow-run review history (selected):** Read-only, uses an existing least-privilege permission, returns the required Environment and actor identity, and can fail closed without introducing a new service.
2. **Custom GitHub App deployment protection rule:** Could provide additional policy control but adds a separate app installation, permission model, availability dependency, and operational lifecycle. It is disproportionate for this narrow identity-correlation gap.
3. **Keep the gap as unknown:** Safe only by leaving the existing limitation explicit; it does not satisfy the objective of binding both approvals to the same actor.

## Constraints

- Use GET only; do not approve or reject deployments through the API.
- Do not add repository, Environment, or organization secrets or variables.
- Do not widen permissions; retain the existing Actions: read permission.
- Require the exact fixed Environment name: staging or production.
- Require one matching approved review record; missing or ambiguous records fail closed.
- Require a positive safe-integer GitHub User ID and exact equality with the selected independent PR approver.
- Compare PR author identity numerically.
- Keep the change as a Draft child of PR #429; do not merge, deploy, or change live Environment settings.

## Non-goals

- Configure live GitHub Environments.
- Run a staging or production release.
- Prove that the Environment approval was made by a different user than the workflow initiator beyond GitHub's existing prevent-self-review rule.
- Support Team reviewers or organization team-membership resolution.
