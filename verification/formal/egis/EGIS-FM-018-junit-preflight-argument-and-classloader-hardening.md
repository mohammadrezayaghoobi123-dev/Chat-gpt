# EGIS-FM-018 — JUnit Preflight Argument and Classloader Hardening

**Status:** Helper-scope hardening implemented and Python 3.11 CI verified; trusted wrapper integration NOT_IMPLEMENTED  
**Date:** 2026-11-25  
**Parent:** EGIS-FM-013, EGIS-FM-014, EGIS-FM-016 and EGIS-FM-017  
**Scope:** Fail-closed argument/target allowlisting, Ant classloader inputs and exact buildfile content identity

## 1. Decision

FM-017 hostile review found that the original helper could return PASS while accepting arbitrary Ant project properties, unreviewed target tokens, a non-empty CLASSPATH or a non-empty per-user Ant library directory. It also did not verify that on-disk customBuild.xml matched the pinned upstream source object.

This increment hardens only the read-only preflight. It does not invoke Ant or modify the pinned upstream build. FMH-112 and FMH-113 are mitigated within the helper boundary. FMH-109, FMH-110 and FMH-111 remain OPEN because no trusted wrapper binds the snapshot to a later process and the host toolchain boundary remains incomplete.

## 2. Pinned identity and implementation

- Source commit: 5a47802b5c391f59ecdd44117981f4ff8c0656ba
- Build file: tlatools/org.lamport.tlatools/customBuild.xml
- Pinned Git blob SHA-1: 3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976
- Helper: verification/formal/egis/tools/egis_junit_report_preflight.py
- Tests: verification/formal/egis/tests/test_junit_report_preflight.py

Before PASS, the helper calculates the Git blob identity from on-disk customBuild.xml bytes and compares it with the pinned blob SHA-1. Path identity alone is insufficient.

## 3. Argument and target contract

- Exactly one explicit absolute buildfile argument must resolve to the checkout's customBuild.xml.
- Exactly one positional Ant target token is allowed: default.
- Missing target, clean, test-single, test-dist-long, a second target or any other target is BLOCKED.
- Arbitrary/unreviewed -D properties are BLOCKED, including source, class, distribution and unknown property names.
- Existing controlled properties remain checked; forbidden properties remain denied; redundant controlled values are permitted only when exactly equal to the lock.
- Unknown launcher options are rejected rather than silently ignored.
- Rejected property values are not copied into failure details.

This is not a general-purpose Ant preflight; another target profile requires its own reviewed lock.

## 4. Classloader input boundary

The helper requires CLASSPATH empty, rejects a non-empty per-user home/.ant/lib, rejects symlink/reparse-point components or inspection failures, and retains denial of explicit Ant -lib/listener/logger/input-handler/main/proxy injection.

Apache Ant documents that CLASSPATH is passed to Ant as a -lib entry and that a per-user .ant/lib directory can be scanned for additional libraries. The helper guards these two inputs. It does not prove the integrity of ANT_HOME/lib, Ant installation, JDK, Java executable, PATH, native libraries or OS account configuration. Those remain under FMH-110 and require a trusted toolchain/launcher boundary.

## 5. Test-first evidence

- Test-first commit: 918325bf80ed6c2a5536f9309498e886a5c071e5.
- Pre-hardening Python 3.11 run: workflow 45579053065; compileall and 30 gate tests passed; expanded 17-case preflight suite failed 14 assertions for the intended missing behaviors. This is the recorded RED state.
- Hardened code commit: 78020c75cee7767ab2a892a03bb9e085e41b1606.
- Exact-code-head Python 3.11 workflow: 45579457292.
- Results: compileall PASS; mocked gate tests 30/30 PASS; JUnit preflight tests 17/17 PASS.
- No Ant, JUnit, build, JAR or SANY/TLC execution.

## 6. Hostile findings and disposition

| Finding | Severity | Disposition |
|---|---|---|
| FMH-109 — stale report-root retention | Medium | OPEN; absent-root check not integrated with trusted wrapper |
| FMH-110 — launcher/host/toolchain injection | High | OPEN; ANT_HOME/lib, executable identity, PATH and native boundary unpinned |
| FMH-111 — caller-supplied properties/argv not bound to later process | High | OPEN; trusted wrapper required |
| FMH-112 — unreviewed Ant properties and targets | High | MITIGATED IN HELPER SCOPE; allowlist and exact target tested |
| FMH-113 — CLASSPATH and per-user Ant library injection | High | MITIGATED IN HELPER SCOPE; empty/absent policy and buildfile pin tested |

## 7. Residual risks and non-claims

- Filesystem preflight is point-in-time; it is not a mutex and does not remove TOCTOU races.
- The helper receives caller-supplied properties, arguments and environment. It cannot prove that a later Ant process uses those same inputs.
- It does not authenticate the host OS, Ant distribution, ANT_HOME/lib, JDK, Java executable or PATH.
- Git blob SHA-1 equality verifies the pinned Git object identity; it does not authenticate upstream authorship or create a signature.
- Windows reparse behavior is represented by a synthetic test; native Windows verification remains NOT_RUN.
- Upstream customBuild.xml and FM-015 remain unchanged.
- Lock remains INCOMPLETE_BLOCKED. No build, JUnit, JAR, SANY/TLC, runtime operation or promotion is claimed.

## 8. Security scan

Gitleaks run 45579457298: PR change-range PASS, 30 commits / approximately 53.73 KB, no findings. Full fetched-ref/history scan FAIL, 13 historical generic-api-key findings across 5,345 commits / approximately 16.43 MB. Findings remain unclassified; no suppression, history rewrite or credential rotation.

## 9. References

- Apache Ant launcher and classpath behavior: https://ant.apache.org/manual/running
- Apache Ant installation and ANT_HOME / JAVA_HOME / PATH: https://ant.apache.org/manual/install.html
- Pinned upstream build file: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/customBuild.xml
- FM-017 review: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/verification/egis-verification-gate-v1.1.1-2026-11-25/verification/formal/egis/EGIS-FM-017-junit-preflight-hostile-implementation-review.md
