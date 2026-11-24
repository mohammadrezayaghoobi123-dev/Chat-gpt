# Environment Branch Policy State Disambiguation — Design

## Intent

Distinguish a known unsafe GitHub Environment configuration from an API state that cannot be verified when GitHub returns HTTP 404 for the deployment-branch-policy list endpoint.

## Current evidence

The read-only preflight for PR #432 observed:
- Staging Environment metadata request succeeded.
- Staging deployment-branch-policy list request returned HTTP 404.
- Production Environment metadata request returned HTTP 404.

The current shared verifier requests the branch-policy endpoint before validating `environment.deployment_branch_policy`. It therefore loses the most useful causal discriminator: whether GitHub's Environment metadata reports `custom_branch_policies: true`.

## Official API contract

GitHub documents that the deployment-branch-policy endpoints require `deployment_branch_policy.custom_branch_policies` to be `true`. The Environment representation includes both `protected_branches` and `custom_branch_policies` booleans, which are mutually exclusive in a valid policy configuration.

A 404 from the branch-policy endpoint is therefore not sufficient by itself to infer the Environment's branch-policy mode. The Environment metadata must be validated first.

## Selected approach

Refactor the existing shared verifier into two ordered validation phases:

1. Validate Environment metadata, reviewer protection, administrator bypass, and explicit custom deployment-branch-policy flags.
2. Only after phase 1 succeeds, list and validate the exact single branch policy.

Introduce typed, stable verifier error codes so the preflight classifier no longer parses human-readable message prefixes:
- `ENVIRONMENT_NOT_FOUND` → `MISSING`
- `POLICY_MISMATCH` → `BLOCKED`
- `BRANCH_POLICY_ENDPOINT_NOT_FOUND` after metadata confirms custom policies are enabled → `UNKNOWN`
- API transport, permission, malformed response, and pagination uncertainty → `UNKNOWN`

The normal release gate continues to fail closed for every non-verified condition. The change improves diagnostic classification; it does not weaken release authorization.

## Approaches considered

1. **Ordered metadata-first validation with typed errors (selected):** uses the existing API response as the independent discriminator, avoids unnecessary calls when custom policies are disabled, and gives the audit a stable machine-readable result.
2. **Keep message-regex classification:** smaller change but couples policy logic to log wording and cannot distinguish policy-disabled from endpoint-unavailable cases.
3. **Add a second diagnostic Environment API client:** duplicates authentication, request, pagination, and policy parsing and risks divergence from the release gate.

## Goals

- Validate the Environment's branch-policy flags before requesting its branch-policy list.
- Avoid calling the branch-policy endpoint when custom branch policies are disabled or malformed.
- Classify an Environment-level 404 as `MISSING`.
- Classify a branch-policy endpoint 404 after an explicit custom-policy=true metadata result as `UNKNOWN`, not as proven misconfiguration.
- Classify a valid Environment metadata record with custom policies disabled as `BLOCKED`.
- Keep all release paths fail-closed.
- Keep error details sanitized and avoid raw API response bodies.

## Non-goals

- Change live GitHub Environment settings.
- Create or update Staging or Production.
- Add write permissions, Secrets, Variables, Cloudflare operations, or deployment actions.
- Change the expected Staging or Production branch pattern.
- Relax required reviewer, self-review, or administrator-bypass conditions.

## Compatibility

The shared verifier's successful result retains its existing fields. The new error class and codes are additive. The audit consumes error codes with a fail-closed fallback to `UNKNOWN` for unrecognized errors.
