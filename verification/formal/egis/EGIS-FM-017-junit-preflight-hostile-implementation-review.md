# EGIS-FM-017 — JUnit Report Preflight Hostile Implementation Review

**Status:** Implemented and locally unit-tested; trusted wrapper integration NOT_IMPLEMENTED; exact-head CI PENDING  
**Date:** 2026-11-25  
**Parent:** EGIS-FM-013, EGIS-FM-014 and EGIS-FM-016  
**Scope:** Read-only fail-closed preflight for JUnit report-root freshness and launcher integrity

## 1. Decision

A standard-library Python helper and hostile unit suite are added to verify report-root preconditions before a future trusted wrapper starts Ant. The helper is deliberately read-only: it does not create or delete report directories, mutate files, launch processes, run Ant, or claim a concurrency lock.

**Current disposition: IMPLEMENTED_UNIT_TESTED_NOT_INTEGRATED.** The helper's effective Ant property map and arguments are caller-supplied. It is not yet wired to a trusted wrapper that proves those values are the exact inputs of the subsequent Ant process. No build, Ant invocation, JUnit execution, JAR creation, SANY/TLC execution or promotion is authorized or claimed.

## 2. Interface and locked contract

Module: `verification/formal/egis/tools/egis_junit_report_preflight.py`

API:

```python
preflight_report_roots(
    root,
    *,
    ant_properties,
    ant_arguments=(),
    environment=None,
) -> dict
```

CLI:
- `--root`
- required `--properties-json`
- repeatable `--ant-arg`
- Exit code 0 for PASS; exit code 2 for BLOCKED.

The helper requires:
- exact report root `target/surefire-reports/` and an absent root before execution;
- canonical checkout and `basedir` equality;
- exact absolute `<root>/customBuild.xml` through one explicit `-f` / `-file` / `-buildfile` argument;
- `maven.test.skip=false`, `maven.test.halt=true`, `test.halt=true`;
- no `noclean` or `test.skip` property;
- disjoint canonical `source/` and `onJar/` report subroots;
- no symlink or Windows reparse-point path component, path escape, non-directory ancestor or stale report root.

A redundant `-Dtest.reports` is accepted only when its value is the exact locked report path. Conflicting or duplicate controlled overrides are blocked.

## 3. Launcher and wrapper attack surface

The helper inspects selected values in `ANT_ARGS`, `ANT_OPTS`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS`, plus Ant rc hooks `.antrc`, `antrc_pre.bat` and `antrc_post.bat`.

It rejects known JVM agent, bootclasspath, module/classpath patching and selected security-property options; Ant `-lib`, `-listener`, `-logger`, `-inputhandler`, `-main` and `-autoproxy`; external `-propertyfile`; buildfile search; relative or alternate buildfiles; and prohibited/conflicting property overrides.

These checks are targeted deny controls. They are not a universal proof against every possible host, JVM, PATH, Ant installation, classpath, native library or toolchain injection vector. The pinned Ant build content must still be hashed and matched against FM-013 by the future build controller.

## 4. TDD and verification evidence

Local environment: Python 3.13.5.

- Initial API-availability suite was RED because the public preflight function did not exist.
- Implementation was added only after the behavior suite existed.
- Final focused suite: **12/12 PASS**.
- `compileall`: PASS.
- Six targeted mutation checks were each detected by their corresponding tests: stale report-root guard, external property-file guard, Windows reparse-point guard, JVM-agent guard, Ant extension/listener guard, and weakened absolute-buildfile identity.
- Original implementation was restored after each mutation, then the entire 12-test suite was rerun successfully.

The checked-in workflow is configured for Python 3.11 and now compiles/runs the preflight suite. Exact-head Python 3.11 CI is PENDING at registration time.

## 5. Hostile findings and residual risks

| ID | Severity | Finding | Status |
|---|---|---|---|
| FMH-109 | Medium | Upstream `clean` does not clear JUnit report roots and may be skipped with `noclean`; old reports can contaminate reused workspaces. | OPEN; helper checks absence but is not integrated |
| FMH-110 | High | JVM/Ant launcher arguments, environment flags and user hooks can inject code or alter execution outside the property map. | OPEN; known vectors are denied by helper, but wrapper/host boundary remains |
| FMH-111 | High | Caller-supplied properties/arguments are not authenticated or bound to the later Ant process; a valid preflight snapshot may differ from actual launch inputs. | OPEN; trusted wrapper required |

Additional limitations:
- Point-in-time filesystem inspection is subject to TOCTOU; it is not a mutex or atomic filesystem transaction.
- A separate fresh disposable checkout and one build per checkout remain required.
- The helper does not acquire/pin Ant or JDK, prove `ANT_HOME` / `JAVA_HOME` / `JAVACMD` / `PATH` identity, or independently verify the locked buildfile content digest.
- Windows reparse behavior is represented by a synthetic unit test; native Windows execution is NOT_RUN.
- External `junitreport` or CI/reporting aggregation is not inspected by this helper.
- No real Ant/JUnit/SANY/TLC operation was performed.

## 6. Required next gate

A future trusted launcher wrapper must:
1. derive the effective Ant property map from its own controlled configuration;
2. build the final argument vector and environment once;
3. resolve the checkout, working directory and exact absolute buildfile;
4. verify the pinned `customBuild.xml` digest and source/toolchain lock;
5. call the preflight helper with those exact values;
6. launch Ant only on PASS, with the same working directory, argv and environment, without an intervening mutation;
7. record wrapper identity, preflight output and process identity as separate evidence.

The exact-head Python 3.11 workflow must pass before this helper is accepted as a verified project component. Even then, the result validates preflight code only; it does not prove JUnit execution, TLA+ model correctness or implementation conformance.

## 7. References

- Apache Ant launcher arguments, environment variables and rc hooks: https://ant.apache.org/manual/running
- Python Windows symbolic-link and reparse-point behavior: https://docs.python.org/3.13/library/os.html
- EGIS-FM-013 build/toolchain lock
- EGIS-FM-014 target graph and hostile audit
- EGIS-FM-016 JUnit report isolation contract
