# Immutable PR Diff Retrieval Design

## Intent

Ensure every source fragment sent to the 9Router reviewer is derived from the exact immutable pull-request base/head commit pair captured by the trusted signal receipt. The current mutable PR-files endpoint cannot prove that separately paginated responses share one snapshot, and the exact-SHA Compare API can omit a file patch.

## Goals

- Bind the changed-file set to exact base and head Git trees.
- Use GitHub Compare API patches when they are present and consistent with the exact commit pair.
- Recover missing Compare patches from exact base/head Git tree and blob objects.
- Preserve complete changed-file coverage; never silently omit a changed path.
- Fail closed before model inference or comment publication on truncated trees, malformed objects, unsupported file types, invalid UTF-8, resource-budget exhaustion, or incomplete path coverage.
- Preserve the existing report-only behavior and all existing API, patch-character, and execution-deadline safeguards.

## Non-goals

- No workflow trigger, token permission, Actions policy, secret, Ruleset, branch protection, main, Production, deployment, PR state, merge, or reviewer approval changes.
- No live 9Router request or live PR comment as a validation mechanism.
- No automatic npm audit threshold change.
- No binary, symlink, or submodule content interpretation.

## Approaches considered

1. Compare API only. Uses exact base/head SHA references and is simple, but does not return patches for every changed file and is capped at 300 changed-file records.
2. Git objects only. Uses exact commits, trees, and blobs for all files. It gives complete immutable object identity but needs a bounded diff generator for every file.
3. Hybrid exact-snapshot retrieval (selected). Use exact-SHA Compare API patches as an optimization; derive the authoritative changed-path set from both exact, non-truncated Git trees; retrieve verified blobs and generate a local bounded diff only where a Compare patch is missing or unavailable. Treat rename records as a delete plus add unless a safe pair can be proven. This is the smallest design that uses Compare where reliable while preserving immutable fallback.

## Architecture

The reviewer first reads live PR metadata and verifies the expected head/base SHAs. It calls Compare using those exact SHAs, then obtains both exact commit objects and recursive trees. Tree traversal is the source of truth for the changed path set. For each changed regular UTF-8 text blob, a returned Compare patch may be reused; otherwise the reviewer retrieves the exact before/after blob objects, verifies their Git object SHA-1 and size, and generates a unified textual diff using the runner's Git executable with shell disabled and external diff/textconv disabled.

Every API response remains under the existing response byte cap. Add explicit changed-file, aggregate blob-byte, individual blob-byte, and generated patch-character limits. The final PR head/base read still occurs before model inference and before publication. No partial patch is sent to the model.

## Security and correctness invariants

- Exact base/head commit SHAs must be valid and match the expected pair.
- Both commit objects and tree objects must return the requested SHA.
- Recursive trees must be complete (truncated === false) and structurally valid.
- Every changed path is represented exactly once in the review input.
- Any Compare patch used must map to a changed path in the exact tree difference.
- Missing Compare patches are recovered only from exact immutable tree/blob identities.
- Blob responses must have canonical base64, expected size, valid UTF-8, no NUL byte, and a computed Git blob SHA matching the requested SHA.
- Binary files, symlinks, submodules, invalid paths, missing objects, unsupported modes, and exceeded budgets stop the review before inference.
- No shell is used; untrusted paths are never passed to a command or used as temporary filesystem paths.
- No mutable /pulls/{number}/files endpoint is used for review input.
- No 9Router call or GitHub comment is permitted for an incomplete snapshot.

## Review focus

- Exact SHA mismatch or malformed commit/tree/blob response.
- More than 300 changed files and a tree response marked truncated.
- Renames, additions, deletions, executable-mode changes, symlinks, submodules, binary content, invalid UTF-8, and newline-containing paths.
- Duplicate or unexpected Compare file entries.
- Blob and generated-diff byte/character budgets.
- Git process failure, deadline exhaustion, or output that reports binary content.

## Acceptance evidence

- A test where Compare returns a changed file without patch must demonstrate exact Git-object fallback and a correct diff in the model input.
- Tests must prove incomplete trees, corrupt blobs, unsupported file types, and budget overruns cause zero model calls and zero comment writes.
- The full Node contract suite, locked installation, npm signature verification, and Gitleaks push/PR scans must pass on the final branch head.
- Hosted workflow_run / artifact / 9Router E2E remains UNKNOWN until the receiver workflow is authorized and exists on the default branch.
