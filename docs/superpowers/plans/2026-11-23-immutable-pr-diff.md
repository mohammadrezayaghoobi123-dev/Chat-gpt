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
- Step 3: **PARTIAL / OPEN**. Added passing strict integration subtests for truncated trees, a forged returned blob SHA, and binary/NUL-containing content; also covered simultaneous content and executable-mode changes. Remaining negative cases include malformed base64, invalid UTF-8 without NUL, symlink/submodule modes, missing objects, individual/cumulative blob budgets, Git diff timeout/output exhaustion, and 300/301 changed-file/fallback boundaries. These remain UNKNOWN.
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

## Latest hostile coverage update — 2026-11-23

- Coverage-only commits: b66d1d688d979d40e8830c78d59b5ea965976e4b added fail-closed fixtures; 0d4a3439e25e068afec3e6dc9152b6558aa30193 added the exact-300 acceptance case; 24e1870c8193624f30243757c9f5a46a33083549 corrected a test regex syntax error using literal string assertions.
- Final test evidence for code/test head 24e1870c8193624f30243757c9f5a46a33083549: contract run 45082823175, job 137394588391, 80/80 PASS, zero failures, cancellations, or skips. npm ci --ignore-scripts and npm audit signatures succeeded.
- Gitleaks Push run 45082823155, job 137394588344, and PR run 45082828822, job 137394604877: both success; each scanned 4,103 fetched commits and reported no leaks.
- Covered cases now include truncated tree, mismatched returned blob SHA, malformed base64, non-NUL invalid UTF-8, binary/NUL data, symlink mode, submodule/gitlink type, missing blob, individual blob over 512 KiB, cumulative 4 MiB blob budget, Git diff output-buffer exhaustion, exactly 300 accepted fallback patches, and rejection of the 301st fallback. These are test-fixture proofs of fail-closed behavior, not live service guarantees.
- The first exact-300 test attempt failed because the test file contained an invalid regular-expression literal; the CI log identified a SyntaxError: Invalid regular expression flags. The assertions were changed to direct string inclusion. The subsequent full suite passed 80/80. No production implementation was changed in this correction.
- Still UNKNOWN: API blob size mismatch, canonical base64 that decodes to bytes with the wrong Git blob hash, Git process timeout distinct from output-buffer exhaustion, Compare API 300-file ceiling, 1,000 changed-path ceiling, 50,000 tree-entry ceiling, and immutable formatted-patch character-budget boundary.
- Hosted workflow_run / artifact roundtrip / live 9Router / comment publication remain UNKNOWN; push-triggered resolve-signal and review were skipped by design.
- Step 3 remains open until the remaining negative boundaries above are either covered or explicitly deferred under a documented engineering decision. No architecture, workflow, permission, secret, Actions policy, Ruleset, PR state, main, merge, deployment, or Production changes were made.

## Latest integrity-fixture verification — 2026-11-23

- Test commit 68306b267e8adbdf9d8c6d39f7abed480859b7b1 added two independent fixtures: canonical base64 whose decoded bytes do not match the requested Git blob SHA, and a Blob response size that disagrees with the immutable Tree entry.
- Contract run 45083063969, job 137395347527: **82/82 PASS**, zero failures, cancellations, or skips. Locked dependency installation and npm audit signatures succeeded.
- Gitleaks Push run 45083063982, job 137395347838, and PR run 45083069058, job 137395363523: both successful; each scanned 4,106 fetched commits and reported no leaks.
- The tested fail-closed matrix now includes malformed base64, canonical-but-corrupted base64 content, API blob-size mismatch, returned blob-SHA mismatch, non-NUL invalid UTF-8, binary/NUL content, truncated trees, symlink and gitlink modes/types, missing blob, individual blob over 512 KiB, cumulative blob budget over 4 MiB, Git diff output-buffer exhaustion, exact-300 fallback acceptance, and 301st fallback rejection. Every negative fixture asserts zero model calls and zero comment POSTs where applicable.
- Still UNKNOWN: Git process timeout distinct from output-buffer exhaustion; exact per-blob 512 KiB acceptance; exact cumulative 4 MiB acceptance; Compare API 300-file ceiling behavior; 1,000 changed-path ceiling; 50,000 tree-entry ceiling; and exact formatted-patch character-budget boundary.
- The tests remain characterization/fail-closed coverage for existing guards; no production code changed in this test-only extension. A prior malformed regex in the first exact-300 test attempt produced a syntax failure; it was corrected to direct string assertions before the green 80-test run.
- Push-triggered resolve-signal and review jobs skip by design. Hosted workflow_run, artifact transfer, live 9Router inference, and comment publication remain UNKNOWN.
- Step 3 remains PARTIAL / OPEN for the explicit boundaries above; do not mark the hybrid implementation production-ready on this evidence alone.

## Exact capacity-boundary verification — 2026-11-23

- Test commit b34f23cc7259c6f715fdcbda0064778a34d31d05 initially failed one new assertion: the fixture reused the same byte content across four paths, so the SHA-keyed immutable blob cache correctly fetched two unique blobs, not eight. This was a test-fixture defect, not a production defect. The observed failure was 82 passed / 1 failed; the failing assertion expected 8 blob fetches but observed 2.
- Corrected fixture commit bc71e3bb22cfe06b88dc74c7cfa6ded6bbe085fe adds a unique, fixed-length prefix per file while keeping every blob exactly 512 KiB. Four modified files then require eight unique blobs, totaling exactly 4 MiB; the diff remains small because only the final line differs.
- Contract run 45083428942, job 137396525773: **83/83 PASS**, zero failures, cancellations, or skips. Locked npm install and npm registry signature verification succeeded.
- Gitleaks Push run 45083428951, job 137396526263, and PR run 45083434237, job 137396543077: both successful; each scanned 4,110 fetched commits and reported no leaks.
- README updated in commit d9add29bbf734f89dcf43c003f72f220dbfe4cf3. Test-only scope: no production implementation changes.
- Exact per-blob 512 KiB and cumulative 4 MiB acceptance boundaries are now SUPPORTED by integration fixtures. Still UNKNOWN: Git process timeout distinct from output-buffer exhaustion; Compare API 300-file ceiling behavior; 1,000 changed-path and 50,000 tree-entry ceiling behavior; and exact formatted-patch character-budget boundary.
- The run's privileged review and receipt jobs skipped by design on push. No hosted workflow_run artifact roundtrip, live 9Router inference, or GitHub comment publication was tested.
