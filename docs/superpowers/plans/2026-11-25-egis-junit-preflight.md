# EGIS JUnit Report Preflight Implementation Plan

**Goal:** Add a read-only, fail-closed preflight for source/JAR JUnit report roots and bind its test evidence into PR #475.

## Constraints
- Keep upstream `customBuild.xml` unchanged.
- Preserve FM-015 selection manifests and both target batch sets.
- Do not create/delete report roots; do not launch Ant.
- Treat the property snapshot as untrusted until a trusted launcher wrapper owns both preflight and process launch.
- No build, JUnit execution, JAR creation, SANY/TLC, deployment, merge or main-branch change.

## Tasks

### 1. Behavior-first implementation
- [x] Create hostile tests before the helper; confirm RED due to missing API.
- [x] Implement read-only checks for fresh report root, canonical checkout/basedir, absolute pinned buildfile, required properties, prohibited properties and disjoint report subroots.
- [x] Block selected Ant/JVM launcher flags, external property files, environment overrides, Ant extension flags and user rc hooks.
- [x] Run focused suite: 12/12 PASS on Python 3.13.5.
- [x] Run compileall: PASS.
- [x] Run six mutation checks; each was caught by its corresponding assertion.

### 2. Evidence and workflow integration
- [x] Register module and tests under verification/formal/egis.
- [x] Add both file paths to the existing Python 3.11 workflow path filters.
- [x] Add compile and unit-test steps without broadening workflow permissions.
- [x] Update FM-013, FM-014 and FM-016 with FMH-110/111 and explicit residuals.
- [x] Add FM-017 hostile implementation review.

### 3. Verify and register
- [ ] Exact-head Python 3.11 workflow pending after commit.
- [x] Read-only hostile review; lock remains INCOMPLETE_BLOCKED.
- [x] One atomic commit on the existing PR branch with expected-head lease check.
- [x] Verify file blobs and PR state after commit; keep PR OPEN/DRAFT/UNMERGED.

**Residual acceptance gate:** no helper PASS may be treated as actual Ant launch attestation until a trusted wrapper supplies the exact effective property map, arguments, working directory and environment to both preflight and Ant.
