# EGIS JUnit Report Preflight Hardening Plan

> **For agentic workers:** Execute this plan natively in the current session, task-by-task, preserving the existing PR branch and recording each verification result. Do not merge.

**Goal:** Close concrete hostile-review gaps in the read-only JUnit preflight without claiming trusted Ant invocation attestation.

**Architecture:** Keep the helper read-only and fail-closed. Restrict Ant invocation to the locked buildfile and single default target, reject unreviewed project-property overrides, block classpath injection via environment/user Ant libraries, and verify the pinned customBuild.xml Git blob identity. A trusted wrapper and toolchain provenance remain separate gates.

**Tech Stack:** Python 3.11 standard library, unittest, GitHub Actions.

**Spec:** EGIS-FM-017 and EGIS-FM-016.

## Global Constraints

- Keep upstream TLA+ customBuild.xml unchanged.
- Preserve FM-015 target selection manifests and all 411 selected source paths.
- Never create or delete report roots inside the helper.
- Never launch Ant, acquire JDK/Ant, build, run JUnit, create/execute JAR, or execute SANY/TLC.
- Do not modify main, secrets, bindings, permissions, deployment or local desktop state.
- Keep PR #475 OPEN/DRAFT/UNMERGED.

## Review Focus

- A build property such as test.dir, class.dir or dist.file must not be overridable through arbitrary -D arguments.
- An extra Ant target such as clean or test-dist-long must not pass preflight.
- CLASSPATH or a non-empty per-user Ant library directory must not inject task implementations.
- The exact Ant buildfile bytes must match the locked Git blob identity.
- A helper PASS remains point-in-time only and must not be mistaken for a mutex, trusted wrapper or later process attestation.

---

### Task 1: Add hostile regression tests

**Files:**
- Modify: `verification/formal/egis/tests/test_junit_report_preflight.py`
- Modify: `docs/superpowers/plans/2026-11-25-egis-junit-preflight.md`

**Interfaces:**
- The test invokes the public `preflight_report_roots` API.
- The synthetic buildfile fixture supplies a test-scoped expected Git blob SHA-1 through a patch; production pin remains fixed in the helper.

- [x] Add tests for unreviewed `-D` properties and non-default/multiple targets.
- [x] Add tests for non-empty `CLASSPATH` and `<home>/.ant/lib`.
- [x] Add a test that mutating `customBuild.xml` bytes causes BLOCKED.
- [x] Run the focused suite and record expected RED failures before production changes.

### Task 2: Harden the preflight

**Files:**
- Modify: `verification/formal/egis/tools/egis_junit_report_preflight.py`

**Interfaces:**
- Add `LOCKED_CUSTOM_BUILD_BLOB_SHA1`.
- Preserve `preflight_report_roots(root, *, ant_properties, ant_arguments=(), environment=None) -> dict`.
- Keep all failures as BLOCKED with non-sensitive reason identifiers.

- [x] Allow exactly one target token: `default`.
- [x] Reject every unreviewed `-D` project property; retain exact-value redundant overrides only for already locked properties.
- [x] Reject a non-empty `CLASSPATH`.
- [x] Reject non-empty user Ant library directories and any symlink/reparse-point in their path components.
- [x] Verify the exact Git blob SHA-1 of `customBuild.xml` before returning PASS.
- [x] Run focused suite to GREEN, then the full EGIS unit suite.

### Task 3: Hostile review and evidence registration

**Files:**
- Create: `verification/formal/egis/EGIS-FM-018-junit-preflight-argument-and-classloader-hardening.md`
- Modify: `verification/formal/egis/EGIS-FM-017-junit-preflight-hostile-implementation-review.md`
- Modify: `verification/formal/egis/EGIS-FM-013-deterministic-cli-build-profile-and-lock-contract.md`
- Modify: `verification/formal/egis/EGIS-FM-014-ant-target-graph-and-input-closure-hostile-audit.md`
- Modify: `verification/formal/egis/EGIS-FM-016-junit-report-isolation-and-discovery-contract.md`

- [x] Register FMH-112 and FMH-113 with severity and falsification conditions.
- [x] Preserve FMH-109..111 as OPEN until wrapper integration and platform-level proof.
- [x] Recompute/verify the unchanged FM-015 file identity references.
- [x] Run exact-head Python 3.11 CI and inspect all relevant job logs.
- [x] Run current-head Gitleaks diff scan; keep historical full-history findings visible.
- [x] Re-fetch all modified file blobs and PR metadata, assert base and main are unchanged.

**Verification evidence:** Test-first red run 45579053065 failed 14 assertions as expected; hardened Python 3.11 run 45579457292 passed 30/30 gate tests and 17/17 preflight tests. Gitleaks run 45579457298 passed the PR change-range scan but failed full history with 13 historical findings.

## Completion Gate

Only claim code hardening tested after exact-head CI returns success. Do not call preflight an Ant invocation attestation. Promotion remains BLOCKED.
