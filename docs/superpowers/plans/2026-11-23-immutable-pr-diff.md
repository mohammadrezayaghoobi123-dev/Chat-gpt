# Immutable PR Diff Retrieval Implementation Plan

> For agentic workers: Execute task-by-task with test-driven development. No production change may precede its failing regression test.

**Goal:** Review every changed path from the exact immutable PR base/head pair, using Compare API patches with bounded Git-object fallback where patches are missing.

**Architecture:** Exact commit and recursive Git tree objects define the changed-path set. Compare API patches are reused when available; verified before/after Git blobs are locally diffed when the API omits a patch. Incomplete or unsupported inputs fail closed before inference.

**Tech Stack:** Node.js 22 ESM, GitHub REST API, Node built-ins, runner Git executable, Node test runner.

**Spec:** docs/superpowers/specs/2026-11-23-immutable-pr-diff-design.md

## Global Constraints

- Only edit feature/9router-abc-provenance.
- Do not modify main, Production, workflows, secrets, permissions, Rulesets, branch protection, PR state, or deployment.
- No shell interpolation; Git invocation must use argument arrays and disable external diff/textconv.
- Keep the existing 45,000-character patch ceiling, 1 MiB per-response ceiling, and 8-minute review deadline.
- New object and file limits must fail closed and be documented.
- Do not drop files, trust Compare pagination past its supported file ceiling, or fall back to mutable PR-files pagination.
- Keep binary, symlink, and submodule changes unsupported and explicitly fail closed.

## Review Focus

- Exact commit/tree/blob SHA mismatches and truncated trees.
- Added/deleted/modified/renamed paths and executable-mode-only changes.
- Binary, invalid UTF-8, symlink, and submodule content.
- Malformed base64, incorrect blob size/hash, duplicate tree paths, and malformed Compare metadata.
- More than 300 changed files and tree/object response budget exhaustion.
- Git process failure or diff output exceeding the remaining patch budget.

---

### Task 1: Hybrid immutable snapshot patch retrieval

**Files:**
- Modify: tools/9router-review/review.js
- Test: tools/9router-review/review.test.mjs
- Update: tools/9router-review/README.md

**Interfaces:**
- Consumes: runReview({ repository, pullRequest, expectedHeadSha, expectedBaseSha, ... })
- Produces: a complete formatted patch derived only from the exact expected base/head trees; throws before model inference when completeness cannot be proved.

- [x] Step 1: Add a failing runReview regression fixture where exact-SHA Compare returns a changed file without patch, while commit/tree/blob APIs return valid exact Git objects; assert the model input contains the reconstructed unified diff and publication occurs only after full snapshot validation.
- [x] Step 2: Run the focused test and verify RED because current code still calls mutable /pulls/{number}/files and rejects the missing patch without object fallback.
- [ ] Step 3: Add fail-closed regression cases for truncated trees, bad blob SHA/base64/size, binary or invalid UTF-8 content, unsupported mode/type, and cumulative blob/patch budget exhaustion; assert zero model calls and zero comment POSTs.
- [x] Step 4: Implement exact-SHA Compare lookup, exact commit/tree enumeration, complete path-set derivation, verified blob retrieval, and bounded no-shell Git diff fallback.
- [x] Step 5: Run focused tests; verify the missing-patch case is GREEN and all fail-closed cases stop before inference/publication.
- [x] Step 6: Run the complete Node contract suite and verify zero failures.
- [x] Step 7: Update README with actual limits, exact-snapshot behavior, unsupported file types, and evidence references; do not claim hosted E2E.
- [x] Step 8: Commit the atomic implementation and documentation change on the feature branch.

**Expected verification:** focused regression RED before implementation; focused and full Node suites GREEN after implementation; final-head GitHub Actions contract workflow and Gitleaks runs successful. The signal/reviewer jobs are expected to skip on push and must not be reported as E2E.


## Execution Status — 2026-11-23

- Steps 1 and 2: completed. The strict immutable-snapshot test was observed failing for the old implementation (64/65 tests passed; the new missing-patch regression failed before inference).
- Step 3: **OPEN**. Targeted negative tests for truncated trees, malformed/corrupt Git blobs, binary and invalid-UTF-8 blobs, mode-only changes, and 300/301 fallback boundaries have not yet been added. Source guards exist, but these guard behaviors are not independently proven by the current test suite.
- Steps 4–8: completed. Hybrid retrieval is implemented; focused integration test and full contract suite pass; audit documentation updated; work remains confined to this feature branch.
- Final GREEN evidence before this plan-status update: contract run 45081384862, job 137390092179, 65/65 PASS; Gitleaks Push run 45081384863 and PR run 45081391096 both succeeded.
- Hosted workflow_run / artifact / live 9Router E2E remains UNKNOWN. Push runs skip resolve-signal and review by design.
- This plan is not fully closed until Step 3's negative regression coverage is complete and reverified on the latest head.


## Latest verification after negative-coverage extension

- Current PR #262 head at verification: 2888c6d1b3c8a0929625a778179ab0de4b3002b8.
- Contract run 45081750372, job 137391242560: 69/69 PASS; locked install and npm signature verification passed.
- Gitleaks Push run 45081750496, job 137391242934: no leaks; 4,097 fetched commits scanned.
- Gitleaks PR run 45081755361, job 137391257196: no leaks; 30 PR commits and 4,097 fetched commits scanned.
- push-triggered resolve-signal/review jobs skipped by design; hosted workflow_run and live 9Router E2E remain UNKNOWN.
- Step 3 remains open for the remaining negative boundary classes above.
