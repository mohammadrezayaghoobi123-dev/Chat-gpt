# Environment Branch Policy State Disambiguation — Plan

> **Execution:** Isolated child branch `security/environment-branch-policy-state-disambiguation-2026-11-24`, based on Draft PR #432. Keep all work Draft and unmerged.

**Goal:** Correctly distinguish a disabled custom branch-policy configuration from an unavailable or inconsistent branch-policy API response.

**Architecture:** Refactor the existing shared Environment verifier into metadata validation followed by branch-policy retrieval. Add a typed `EnvironmentProtectionError` with stable error codes; update the read-only audit classifier to consume those codes instead of parsing message prefixes.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, GitHub REST API, GitHub Actions.

**Design:** `docs/superpowers/specs/2026-11-24-environment-branch-policy-state-disambiguation-design.md`

## Safety invariants

- Environment metadata is fetched using GET only.
- Branch-policy metadata is fetched only after Environment metadata confirms `custom_branch_policies === true` and `protected_branches === false`.
- Environment-level 404 is `MISSING`.
- Disabled or malformed policy flags are `BLOCKED`.
- Branch-policy endpoint 404 after metadata confirms custom policies are enabled is `UNKNOWN`.
- Transport, permission, schema, and pagination uncertainty is `UNKNOWN`.
- Every non-READY result continues to block releases.
- Do not access Secrets or Variables, mutate GitHub settings, call Cloudflare, or deploy.
- Do not modify `main`.

## Task 1 — TDD for the discriminator

- [x] Add verifier test: custom policies disabled blocks before any branch-policy request.
- [x] Add audit test: explicit custom policies disabled is BLOCKED with a useful reason.
- [x] Add audit test: branch-policy endpoint 404 after custom-policy=true is UNKNOWN.
- [x] Verify current implementation fails those tests for the intended reasons: 474 Node tests, 471 passed and 3 expected failures.

## Task 2 — Shared verifier implementation

- [x] Add typed errors with stable codes.
- [x] Validate Environment metadata before branch-policy retrieval.
- [x] Classify Environment 404, branch-policy 404, and API uncertainty separately.
- [x] Preserve successful result fields and all existing fail-closed invariants.
- [x] Pass the RED tests.

## Task 3 — Audit integration and regression

- [x] Remove regex-based classification for known verifier failures.
- [x] Use typed error codes and an UNKNOWN fallback for unexpected errors.
- [x] Run the complete Node and Vitest suites: final run 45377444528, 475 Node and 227 Vitest tests passed.
- [x] Run npm audit (zero vulnerabilities), JavaScript checks, and both Wrangler dry-runs.

## Task 4 — Evidence and PR verification

- [x] Record valid RED and GREEN run IDs.
- [x] Re-run the read-only Staging/Production audit.
- [x] Record exact live statuses and retain the unresolved Custom Branch Policy state because Administrator Bypass blocks metadata validation first.
- [x] Run Gitleaks and distinguish PR diff from full-history results.
- [x] Verify PR #433 remains Draft/open/unmerged and `main` is unchanged.
