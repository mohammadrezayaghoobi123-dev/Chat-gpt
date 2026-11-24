# GitHub Environment Full Posture Census — Design

## Intent

Collect all independently readable GitHub Environment protection facts for Staging and Production in one read-only audit, even when an earlier control is misconfigured. The current release verifier intentionally stops at the first violation; that is correct for authorization but incomplete for diagnosis.

## Current evidence

The latest live audit found:
- Staging: `can_admins_bypass=true`; release correctly blocked.
- Production: Environment metadata endpoint returned HTTP 404.
- Because the shared verifier stopped at the bypass violation, the Staging required-reviewer and deployment-branch-policy state was not established.

## Selected architecture

Add `inspectEnvironmentProtection({ repository, releaseEnvironment, token, fetchImpl })` to the existing shared verifier module. It performs the Environment GET once, evaluates all independent metadata controls, and attempts the deployment-branch-policy list when the metadata explicitly reports `custom_branch_policies=true`, independent of unrelated violations such as administrator bypass or self-review.

The inspector returns a sanitized, immutable posture record:
- Environment identity and overall state.
- Administrator bypass flag.
- Required-reviewer rule count, reviewer count, and self-review flag.
- Deployment branch-policy flags.
- Branch-policy retrieval state and exact expected-pattern match.
- A complete list of typed findings with stable codes and severity.

Reviewer User IDs remain available only to the existing release-verification return path, not in the audit report, summary, or logs.

The existing `verifyEnvironmentProtection` becomes a thin enforcement wrapper over the inspector. It returns the same successful fields as before and throws a typed fail-closed error if any finding exists. The audit consumes the same inspector result and reports all findings rather than stopping at the first one. This avoids duplicating policy logic.

## Status semantics

- `READY`: all required controls are positively verified.
- `BLOCKED`: at least one definite policy violation is established.
- `UNKNOWN`: no definite policy violation is established, but required evidence is unavailable, malformed, or inconsistent.
- `MISSING`: the Environment metadata endpoint returned HTTP 404.

If both BLOCKED and UNKNOWN findings exist, the overall status is BLOCKED and both findings remain visible. An UNKNOWN branch-policy result never erases a separately proven BLOCKED administrator-bypass finding.

## API decision rules

- Environment metadata is fetched using GET.
- Branch-policy metadata is fetched only when `custom_branch_policies === true`.
- The branch-policy GET is attempted even if other independent controls are invalid, so the census can collect the remaining evidence.
- A branch-policy endpoint 404 after explicit custom-policy enablement is UNKNOWN.
- Invalid/missing branch-policy mode flags are UNKNOWN unless a definite policy mismatch is explicitly established.
- Environment-level 404 is MISSING; permission, transport, malformed payload, and pagination failures are UNKNOWN.
- Both fixed targets are always audited independently.

## Alternatives considered

1. **Shared complete inspector + fail-closed verifier wrapper (selected):** one policy source, complete diagnostics, and no change to release authorization semantics.
2. **Second independent audit parser:** simpler local implementation but duplicates policy logic and risks drift between audit and release gates.
3. **Keep first-failure verifier and add extra API calls in the audit:** duplicates request ordering and parsing, makes the audit a second verifier, and is less reliable.

## Security and non-goals

- GET-only API access using existing `Actions: read` and `Contents: read` permissions.
- No Environment binding in the audit Job.
- No Secrets or Variables endpoints or values.
- No reviewer identifiers or raw API payloads in reports or logs.
- No GitHub configuration mutation, Cloudflare operation, or deployment.
- No changes to the required Staging or Production branch patterns.
- Every non-READY status continues to block release.
- No `main` changes; PR remains Draft and unmerged.
