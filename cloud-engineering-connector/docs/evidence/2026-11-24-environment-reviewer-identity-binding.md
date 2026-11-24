# Environment Reviewer Identity Binding — Evidence Record

## Scope

This change closes the identity gap between two existing release controls:
- GitHub Environment protection requires one or more configured reviewers.
- The candidate PR approval verifier previously accepted any non-author reviewer with an approval on the exact candidate SHA.

The verifier now binds those controls by numeric GitHub User ID. A PR review from an otherwise valid but unrelated account no longer satisfies the independent approval gate.

## Security contract

1. The Environment verifier reads the existing GitHub Environment metadata and its complete deployment-branch-policy collection using GET requests only.
2. It validates the existing Environment contract: fixed target name, exactly one required-reviewer rule, self-review prevention enabled, administrator bypass disabled, and exactly one exact release branch pattern.
3. It accepts only User reviewer entries with positive safe-integer GitHub IDs. Team entries fail closed because the repository is owned by a personal account and this release gate has no verified Team-membership-to-PR-user mapping.
4. It returns the sorted, immutable authorizedReviewerUserIds array and writes only the comma-separated numeric IDs to the current GitHub Actions step output reviewer_user_ids.
5. Both Staging and Production release workflows expose the Environment guard's step output to the subsequent approval step as RELEASE_ALLOWED_REVIEWER_IDS.
6. The approval CLI strictly parses one to six unique positive numeric IDs. The core verifier independently validates the typed array again, so malformed, absent, empty, duplicate, or unsafe IDs fail closed.
7. Latest PR review state is keyed by numeric GitHub User ID. A release requires a non-author APPROVED review by one of the configured Environment User IDs, with commit_id equal to the exact candidate PR head SHA.
8. An outstanding non-author CHANGES_REQUESTED review for the exact candidate head continues to block release, including when the change request was made by a reviewer outside the allowlist.

No additional GitHub permission, Environment variable, repository variable, secret, or reviewer identity is introduced.

## Files changed

- cloud-engineering-connector/scripts/verify-environment-protection.mjs
- cloud-engineering-connector/release-approval.js
- cloud-engineering-connector/scripts/verify-release-approval.mjs
- cloud-engineering-connector/test/environment-protection.test.js
- cloud-engineering-connector/test/release-approval.test.js
- cloud-engineering-connector/test/environment-protection-contract.test.js
- .github/workflows/connector-staging-release.yml
- .github/workflows/connector-production-release.yml
- cloud-engineering-connector/docs/evidence/2026-11-24-environment-reviewer-identity-binding.md
- docs/superpowers/plans/2026-11-24-environment-reviewer-identity-binding.md

## TDD and CI evidence

### Valid RED

- Test-only commits: 34b2ba426f36d36a7647605e541d326dda82bc6d, 69ffa3dc2b097b49c4b67c3e3729407369cf8575, and afe32b20cff965d47532314d58ba2ce3fbb6746b.
- CI run [45370758533](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45370758533) executed 451 Node tests: 445 passed and 6 failed.
- The six failures were expected and specific to the missing behavior: two workflow output-contract cases, missing Environment reviewer-ID output, Team reviewer fail-closed behavior, unrelated PR reviewer rejection, and empty reviewer-set rejection.
- Dependency installation and npm audit completed before the expected test failures; no implementation code was present in these test-only commits.

### GREEN

- Implementation commits: 2a923066aa0b603296f9806ac4e43b8e540b083f, 23ef3b2fdaa50837ac395582586e8ee6e9bc739c, 326f07a04a0fcbfdc3c5a3143694866807af1579, df5a3c7cb8691b9e8e5df5d4c1b572a49cc69f5b, and 38547ebf5190827b090d34e013b1edc96f71d6ec.
- Cloud Engineering Connector CI [45370980657](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45370980657): success.
- After removing a later invalid test-only import experiment, the final code/test head 52321db1b41dee4f42f3340d05228aa786c69e6e passed Cloud Engineering Connector CI [45371275578](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45371275578):
  - Node tests: 451 passed, 0 failed.
  - Vitest: 227 passed across 11 files.
  - npm audit --audit-level=moderate: zero vulnerabilities.
  - JavaScript syntax checks passed.
  - Wrangler default and Staging dry-runs passed.
  - The post-deploy Staging smoke job was skipped by design; no live deployment was attempted.

### Excluded invalid experiment

- A follow-up parser test commit 5e3cacdc927fb81a1223b77ae176e804eb0e404e statically imported a not-yet-exported helper. CI runs [45371183657](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45371183657) and [45371196549](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45371196549) failed while loading that test module, not on a behavioral assertion. This is explicitly excluded from valid RED evidence.
- The invalid test/import was removed by commit 52321db1b41dee4f42f3340d05228aa786c69e6e; the final code/test head then passed the full CI run above.

## Residual limits and unknowns

- The live staging Environment was previously observed without protection rules or a deployment branch policy; the live production Environment was absent. Both release workflows therefore remain expected to block until their Environments are configured with the existing required protections.
- No live release job was triggered. The GITHUB_OUTPUT hand-off and real Environment API access have not been exercised in a release job against an actually protected Environment; current CI verifies the pure validation, approval matching, workflow contract, syntax, and dry-run behavior using deterministic test fixtures.
- This binding proves that the candidate PR has an approval from a User who is in the Environment's configured reviewer set. It does not prove that the same individual also clicked the subsequent Environment deployment approval; the current workflow/API path does not capture the identity of that environment-approval actor for comparison.
- Team reviewers remain unsupported by this binding. If the repository moves to an organization and uses Team reviewers, add and verify a separate organization/team-membership resolution design before relaxing the fail-closed check.
- No live Environment configuration, Secret, Variable, Cloudflare resource, Worker, Durable Object namespace, Queue, deployment, or main content was modified. No merge was performed.

## Decision

**Provisionally supported for code-level validation; live release integration remains unknown.** The identity comparison and workflow hand-off are covered by passing CI, but real protected-Environment execution and same-actor correlation remain unverified.
