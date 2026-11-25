# EGIS-FM-014 — Ant Target Graph and Input Closure Hostile Audit

**Status:** Static audit; source-build authorization NOT GRANTED  
**Date:** 2026-11-25  
**Parent:** EGIS-FM-013  
**Upstream repository:** `tlaplus/tlaplus`  
**Pinned source commit:** `5a47802b5c391f59ecdd44117981f4ff8c0656ba`  
**Pinned source tree:** `fb0d9481ef7f1c4dc4cf066812b90f38ac4b0ef1`  
**Pinned Ant file:** `tlatools/org.lamport.tlatools/customBuild.xml`  
**Pinned Ant blob:** `3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976`  
**Scope:** Static target graph, selected-profile inputs, test selection, execution properties and cleanup effects

## 1. Decision

The selected-profile dependency list in FM-013 is accurate for the **11 direct JAR/file references** observed in the selected Ant targets. It is not yet a complete input-closure or execution lock. The target graph also consumes source, test, resource, model-fixture and repository-metadata trees; execution behavior is affected by Ant properties and cleanup semantics that are not fully bound by the current lock.

**Disposition: BLOCKED.** No toolchain acquisition, dependency download, build, test execution, JAR creation, SANY/TLC execution or runtime change is authorized or was performed.

## 2. Reproducible source evidence

All observations below are tied to the pinned source commit and its Git tree, not to the moving upstream branch.

| Input | Git tree/blob identity | Entries/files | Consumption |
|---|---|---:|---|
| `src/` | Tree `a74de09ccfe0be7a750467f7940eebd8fe63e772` | 627 / 585 | `javac` source and resource-copy input |
| `test/` | Tree `f6aba48957fc3d94fea66a2774e8b32b124abc4c` | 490 / 461 | Test compilation and JUnit discovery |
| `test-model/` | Tree `2f62a421a6bc7cb4f5d41decbdb12b8826e21f51` | 747 / 721 | Test runtime classpath and model/config fixtures |
| `doc/License.txt` | Blob `c8f71de5d088dc159f4b482904901e938538598c` | 1,107 bytes | Packaged into the CLI JAR |
| `project.properties` | Blob `79c7a67a317446789c56012ebf573391d35dd26f` | 313 bytes | Loaded by the Ant build |

The counts are Git tree entries and blobs, not counts of discovered or executed tests. The pinned source root tree SHA commits to these inputs, but the selected-profile lock must still state which subtrees and effective test fixtures it consumes.

### Direct selected-profile JAR references

Static extraction of the pinned `customBuild.xml` confirms these 11 direct JAR/file references in the selected profile:

1. `lib/org.eclipse.jgit-2.3.1.201302201838-r.jar`
2. `lib/jgit-buildnumber-ant-task-1.2.10.jar`
3. `lib/javax.mail/mailapi-1.6.3.jar`
4. `lib/javax.mail/smtp-1.6.3.jar`
5. `lib/javax.mail/javax.activation_1.1.0.v201211130549.jar`
6. `lib/junit-4.12.jar`
7. `lib/hamcrest-core-1.3.jar`
8. `lib/cglib-nodep-3.1.jar`
9. `lib/objenesis-2.1.jar`
10. `lib/jacocoant.jar`
11. `test-model/UserModuleOverrideFromJar.jar`

These match the 11 direct entries in FM-013. The repository also contains other JARs, including EasyMock, JPF and JMH artifacts; the selected target graph does not directly reference EasyMock, while JPF/JMH belong to excluded target groups. Their presence in the repository is not by itself evidence that they belong in this selected-profile dependency set.

## 3. Target-graph reconstruction

The pinned build defines the following relevant behavior:

- `info` depends on `git-revision`.
- `default` depends on `info`, then invokes `compile`, `compile-test`, `test`, `git-revision`, `dist` and `test-dist` through `antcall`.
- `compile` depends on `clean`.
- `compile-test`, `test` and `test-dist` are guarded by `unless="test.skip"`.
- `dist` unpacks the three mail/activation JARs, touches a generated resource, and packages the standalone JAR.
- `test-dist` runs JUnit against the produced JAR inside the JaCoCo coverage task.
- `default-maven` omits the source `test` target and is not equivalent to the selected verification profile.

The effective invocation trace therefore includes the `git-revision` dependency of `info` and a second explicit `git-revision` call before `dist`. The single target-name list in FM-013 does not fully represent this invocation trace.

Static inspection found no Ant `import`, `include`, `subant`, external `exec`, Ant `java`, or `get` task in this pinned build file. This does **not** mean that no child JVM is launched: the selected JUnit tasks explicitly use `fork="yes"` and `forkmode="perTest"`. The future controller must bind the forked JVM executable, JDK identity, arguments and inherited environment. The local `antcall` invocations do not by themselves establish that the complete build is network-independent; network denial remains mandatory.

## 4. New hostile findings

| ID | Severity | Finding | Required disposition |
|---|---|---|---|
| FMH-101 | High | The selected test classpath includes the entire `test-model/` directory, but the lock lists only `UserModuleOverrideFromJar.jar`. The pinned tree contains 747 entries (721 files), including TLA modules, CFG files, nested fixtures and binary assets. | Bind the `test-model` subtree tree SHA and entry counts; identify the effective fixture closure for the selected tests or explicitly declare the entire subtree as a locked input. Do not treat the single JAR as the complete test-model input set. |
| FMH-102 | High | The lock says test failure must halt execution, but the Ant build derives `test.skip` from `maven.test.skip` and derives `test.halt` from `maven.test.halt`. All three selected test targets use `unless="test.skip"`; an ambient skip property can silently suppress tests. | Pin `maven.test.skip=false`, require `test.skip` to be absent, and set `maven.test.halt=true` / `test.halt=true`. Preflight must inspect effective Ant properties and fail before execution if tests can be skipped or failure-halt is not true. |
| FMH-103 | High | `git-revision` is invoked as an `info` dependency and again before packaging. Its branch, tag, revision, short revision and commit-count values are embedded in the JAR Manifest. A detached exact commit plus full history does not, by itself, bind the visible ref/tag namespace or the metadata algorithm's selected values. | Lock the exact refs/tags and resulting metadata values, or use a reviewed patch that supplies fixed values. Verify the Manifest fields against the lock; do not infer determinism from the commit SHA alone. |
| FMH-104 | High | `compile` depends on `clean`; `clean` deletes class directories and recursively deletes every `states/**` match below `${basedir}` with `failonerror=false`. This is a potentially destructive workspace operation and its path/symlink boundary is not represented in the lock. | Run only in a disposable, isolated checkout with a canonical bounded `basedir`; reject unexpected symlinks and preserve a pre-build inventory of tracked/untracked files. Never point the build at a working project checkout. |
| FMH-105 | High | The `test` and `test-dist` targets have distinct include/exclude sets, batch counts and report destinations; one global exclusion digest cannot describe both. | Static selection ambiguity MITIGATED by separate FM-015 manifests (411 unique paths per target; symmetric difference zero). Keep execution-evidence portion OPEN until actual JUnit reports establish discovered/executed/passed/failed/skipped/excluded counts per target. |
| FMH-106 | High | The selected JUnit tasks launch child JVMs with `fork="yes"` and `forkmode="perTest"`, but the lock does not bind the effective Java executable, child-process arguments or inherited environment. | Pin the forked JVM executable/JDK identity, exact task arguments and an environment allowlist; verify the actual child-process invocation before accepting build evidence. |
| FMH-107 | Medium | Neither selected JUnit task explicitly sets `skipNonTests`; Apache Ant documents the default as `false`, so the fileset path count is not a discovered-test count and non-test classes are not filtered by Ant before invocation. | Pin the exact Ant/JUnit version and effective `skipNonTests=false` semantics; preserve upstream behavior or use an explicitly reviewed change, then inspect actual JUnit reports. |
| FMH-108 | High | The source-test target writes XML reports to `target/surefire-reports/`; two packaged-JAR batches also write to that directory. Ant's default XML report name is class-derived, so the same two test classes target identical output paths in both targets. | Give source-test and packaged-JAR targets distinct report roots; bind each report-set identity and fail preflight on any output-path overlap. |
| FMH-109 | Medium | The pinned clean target does not remove target/surefire-reports/ and is guarded by unless="noclean"; reports from a prior invocation can remain available to later evidence collection. | Require a fresh, absent, canonical, non-symlinked report root; reject noclean, unapproved test.reports overrides and concurrent builds sharing a checkout. Do not infer report freshness from the clean target. |
| FMH-110 | High | Ant/JVM launcher options and user hooks can inject executable code or alter execution semantics outside the report-root property snapshot. | Reject known JVM agents, bootclasspath/module/classpath overrides, Ant listeners/loggers/input handlers/libraries/proxy options, selected launcher environment variables and user rc hooks; keep the exact launcher contract under a trusted wrapper. |
| FMH-111 | High | The property map and launcher arguments passed to the helper are caller-supplied and are not bound to the later Ant process. A valid snapshot could be supplied while Ant is launched with different arguments, environment or working directory. | Derive effective properties and arguments inside a trusted wrapper, use the identical environment and absolute buildfile for preflight and Ant, and launch Ant only after a PASS from that same wrapper invocation. |
| FMH-112 | High | The preflight accepted arbitrary unreviewed -D project properties and did not constrain positional Ant target tokens; a caller could redirect test sources/output or request targets outside the locked default target graph while receiving PASS. | Allow exactly one target token, default; reject every unreviewed -D, missing/multiple/other targets and unrecognized launcher flags. Keep only exact-value overrides for locked properties. |
| FMH-113 | High | The preflight did not reject a non-empty CLASSPATH or a non-empty per-user Ant library directory; both can add Ant task implementations outside the pinned buildfile. | Require CLASSPATH empty and reject non-empty or unsafe per-user .ant/lib; keep ANT_HOME/JVM/JDK identity and later process-binding residuals OPEN under FMH-110/111. |

## 5. Corrective lock requirements

FM-013 must be amended before the lock can advance beyond `INCOMPLETE_BLOCKED`:

1. Add explicit `src/`, `test/`, `test-model/`, `doc/License.txt` and `project.properties` input identities.
2. Add the `test-model` subtree SHA `2f62a421a6bc7cb4f5d41decbdb12b8826e21f51` and its observed 747-entry / 721-file inventory.
3. Replace an ambiguous target list with the effective invocation trace, including both `git-revision` calls.
4. Bind the effective test properties: `maven.test.skip=false`, `test.skip` absent, `maven.test.halt=true`, and `test.halt=true`.
5. Split test selection/exclusion manifests by source-test and packaged-JAR test target.
6. Pin the forked JUnit JVM executable, JDK identity, arguments and inherited environment allowlist.
7. Define a disposable-checkout policy and bounded cleanup path before any future build.
8. Preserve the existing 11 direct JAR identities; do not add unrelated repository JARs without target-graph evidence.
9. Preserve source/JAR selection manifests while assigning disjoint report roots through a separately reviewed candidate overlay.
10. Require the report root to be absent before execution; reject noclean, report-path overrides, symlink components, path escapes and same-checkout concurrent builds.
11. Record explicit skipNonTests=false on selected source/JAR batches only after exact Ant pinning and attribute compatibility verification.
12. Run report preflight only from a trusted wrapper that owns the exact effective Ant property map, launcher arguments and environment used for the subsequent process.
13. Pin and verify the customBuild.xml content identity against FM-013 before execution; path identity alone is insufficient.
14. Restrict Ant argv to one locked buildfile, exactly one default target, and controlled property overrides only; reject all unreviewed -D and unknown options.
15. Reject non-empty CLASSPATH and any non-empty or symlinked/reparse-point per-user .ant/lib directory before accepting preflight.

## 6. Falsification tests for a future authorized controller

The controller must be shown to BLOCK before process execution when any of the following is injected:

- Remove one file or alter the tree identity under `test-model/`.
- Set `maven.test.skip=true` or define `test.skip` to any value.
- Set `maven.test.halt=false` or otherwise make effective `test.halt` non-true.
- Add, remove or retarget a Git tag/ref that changes JGit build metadata.
- Point `basedir` outside the disposable checkout or introduce a symlinked `states` path.
- Alter one source-test or packaged-JAR include/exclude rule without changing its corresponding selection-manifest digest.
- Enable network access during the build phase.
- Seed stale XML beneath the proposed report root; preflight must BLOCK before Ant starts.
- Set noclean, test.skip or an unapproved test.reports override; preflight must BLOCK.
- Introduce a symlinked report root, path traversal, canonical-root alias or a second Ant process in the same checkout; preflight must BLOCK.
- Make source and packaged-JAR report roots overlap after canonical resolution; preflight must BLOCK.
- Inject a JVM agent, bootclasspath/module patch, Ant listener/logger/input handler/library/proxy option through CLI or launcher environment; preflight must BLOCK.
- Supply a caller property map that differs from the real Ant process properties, or change cwd/argv/environment after preflight; the wrapper must refuse to launch Ant.
- Pass -Dtest.dir, -Dclass.dir, -Ddist.file or an unknown -D property; preflight must BLOCK without echoing the value.
- Omit the target, request clean/test-dist-long, or append a second target; preflight must BLOCK.
- Set non-empty CLASSPATH, create a file beneath user-home/.ant/lib, or replace a component of that path with a symlink/reparse point; preflight must BLOCK.
- Mutate customBuild.xml while preserving its pathname; the pinned Git blob identity check must BLOCK.

A successful controller preflight is not a successful build. A successful build is not a successful test run. Neither is evidence of EGIS correctness or implementation conformance.

## 7. Evidence and limitations

| Check | Result |
|---|---|
| Pinned source commit/tree identity | OBSERVED |
| Ant target names and local invocation graph | STATICALLY_INSPECTED |
| Direct selected-profile JAR references | 11/11 MATCH FM-013 |
| Source/test/test-model subtree identities | OBSERVED |
| Effective test fixture closure by individual test | NOT_ESTABLISHED |
| Exact Ant property values at execution | NOT_RUN |
| Git ref/tag metadata reproducibility | NOT_ESTABLISHED |
| Cleanup path/symlink behavior in isolated builder | NOT_RUN |
| Static source-test file selection | OBSERVED; 411 unique paths across 8 batches |
| Static packaged-JAR file selection | OBSERVED; 411 unique paths across 7 batches |
| Equality of selected source-path sets | OBSERVED; symmetric difference = 0 |
| Actual JUnit test discovery and report counts | NOT_RUN |
| JUnit `skipNonTests` effective runtime semantics | NOT_RUN; upstream attribute omitted, documented default false |
| JUnit report output path isolation | FAIL; two cross-target XML output collisions statically identified |

| Forked JUnit JVM executable and process environment | NOT_ESTABLISHED |
| Build, JAR creation, SANY/TLC | NOT_RUN |

## 8. Safety boundary

This is a static audit only. No JDK, Ant distribution, dependency or JAR was downloaded. No source build, test, artifact creation, JAR execution, SANY/TLC run, runtime modification, deployment, merge or main-branch mutation was performed.

## 9. Source references

- Pinned Ant build: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/customBuild.xml
- Pinned project properties: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/project.properties
- Pinned source tree: https://api.github.com/repos/tlaplus/tlaplus/git/trees/fb0d9481ef7f1c4dc4cf066812b90f38ac4b0ef1?recursive=1
- TLA+ build and test instructions: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/DEVELOPING.md


## 10. Static JUnit selection reconstruction (EGIS-FM-015)

The pinned `project.properties` sets `test.dir=test`. The recursive source tree contains 461 files in that directory, including 455 Java source files. The broad `**/*Test*.java` pattern matches 439 candidate source paths.

The exact Ant `test` and `test-dist` batch patterns were evaluated against that pinned tree and recorded in:

`verification/formal/egis/EGIS-FM-015-junit-static-selection-manifests.json`

| Metric | `test` | `test-dist` |
|---|---:|---:|
| Broad pattern candidates | 439 | 439 |
| Primary batch selected | 403 | 404 |
| Later explicit batch selections | 8 | 7 |
| Batch assignments | 411 | 411 |
| Unique selected paths | 411 | 411 |
| Permanently unselected broad candidates | 28 | 28 |
| Batch count | 8 | 7 |

The final unique selected path sets are identical (zero symmetric difference). This does not mean that the two targets execute the same test configuration: their primary exclusions, explicit batches and report directories differ. The source target reselects eight paths excluded from its first batch; the packaged-JAR target reselects seven.

Per-target selection digests:

- `test`: `8d28a2a1a759b6ba06c9dafadc9cbe06f45db32216dadeac42a6ad7ec45ed7a8`
- `test-dist`: `023647bc904ff7c20af1fd85a02a4b5c96b2c1f5dd1f090968fb86036bebf46c`
- Manifest SHA-256: `1bc377150f82f3db41142ba89d35c2f1da2ea7ef93adb8a03f0a539b2e826832`

**Hostile interpretation:** 411 is the number of source paths selected by the static fileset model. It is not a count of JUnit test classes, test methods, test invocations or successful tests.

The upstream JUnit tasks omit `skipNonTests`. Apache Ant's JUnit task documentation specifies a default of `false`, meaning Ant does not filter out non-test classes before passing matched files to the JUnit runner. Exact Ant version and actual discovery behavior are still unpinned/unexecuted. FMH-107 remains open.

### FMH-108 — Report path collision

The `test` target writes all JUnit XML reports to `${test.reports}`, which resolves to `target/surefire-reports/`. In `test-dist`, two explicit batches also write to that same directory rather than `target/surefire-reports/onJar/`:

- Batch 1: `tlc2.tool.UserModuleOverrideAnnotationTest`
- Batch 2: `tlc2.tool.UserModuleOverrideFromJarTest`

The source-test target writes reports for those same classes to the same directory. The pinned `default` target invokes `test` before `git-revision`, `dist` and `test-dist`; therefore the packaged-JAR target runs later. Apache Ant documents the default report filename as `TEST-<test-class-name>.xml`; therefore the exact output paths collide and the later target is expected to replace the earlier files:

- `target/surefire-reports/TEST-tlc2.tool.UserModuleOverrideAnnotationTest.xml`
- `target/surefire-reports/TEST-tlc2.tool.UserModuleOverrideFromJarTest.xml`

This is a statically established path collision and ordered overwrite risk, not an observed filesystem overwrite: no test was executed. The packaged-JAR target's two special batches are not isolated under the `onJar` report root. Until report roots are separated, the resulting XML cannot be safely attributed to the source-test or packaged-JAR run. The manifest records both collisions and the target order; FMH-108 remains OPEN.

FMH-105's static manifest ambiguity is mitigated, but the actual execution/report requirement remains open. FMH-108 separately blocks test evidence acceptance until report output collisions are removed. No test was run and no JUnit report was generated in this audit.

### FMH-109 — Stale report-root retention

The pinned clean target at lines 96–108 deletes the class and test-class output contents and recursively deletes states/** below ${basedir}. It does not delete ${test.reports} or target/surefire-reports/. The target declaration is <target name="clean" unless="noclean">, so the clean operation can be bypassed by defining noclean.

The test and test-dist targets create report directories with mkdir, but the inspected build file contains no report-root reset or stale-file rejection. Therefore, prior XML may remain in a reused workspace and be consumed by an external report collector. This is a stale-evidence risk; no stale report was observed or consumed during this static audit.

The safe candidate control is not an unconditional Ant delete. A future controller must require a new disposable checkout and an absent report root, pin test.reports, canonicalize both output roots, reject symlinks/path escapes and prevent two builds from sharing one workspace. FMH-109 remains OPEN until those preconditions are implemented and falsification-tested.

### Candidate remediation record (EGIS-FM-016)

FM-016 documents the minimal overlay: eight source-test batches write under target/surefire-reports/source/; all seven packaged-JAR batches write under target/surefire-reports/onJar/; all 15 selected-profile batches explicitly set skipNonTests="false". No fileset or include/exclude rule changes are proposed. Exact Ant version, runtime attribute support, report-root preflight and actual JUnit reports remain NOT_RUN. The overlay is PROPOSED_NOT_APPLIED; FMH-107, FMH-108 and FMH-109 remain OPEN.

The copied FM-015 manifest file digest in this audit is aligned with the current FM-013 lock value: 1bc377150f82f3db41142ba89d35c2f1da2ea7ef93adb8a03f0a539b2e826832. The FM-015 file itself is unchanged by this proposal; the hash is a reference-integrity correction only.

### FMH-110 — Ant/JVM launcher option injection

Ant/JVM launcher arguments and environment options can inject executable code or change class/module loading before the JUnit tasks start. A malicious `ANT_ARGS`, `ANT_OPTS`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` or `_JAVA_OPTIONS` value may weaken the report/build contract. Ant user rc files can also add launcher options.

The helper rejects known JVM agent, bootclasspath, module/classpath patching and selected security-property flags; Ant `-lib`, `-listener`, `-logger`, `-inputhandler`, `-main`, `-autoproxy`; external `-propertyfile`; buildfile search; relative or alternate buildfiles; and prohibited/conflicting property overrides. It inspects selected launcher environment variables and checks for `.antrc`, `antrc_pre.bat` and `antrc_post.bat` in the relevant home directory.

These are targeted deny controls, not universal proof that all host, JVM, PATH, Ant installation, classpath or native-library injection vectors are absent. FMH-110 remains OPEN until the exact launcher contract is implemented in a trusted wrapper and verified on target operating systems.

### FMH-111 — Unauthenticated property snapshot and missing invocation binding

The helper receives an `ant_properties` mapping and `ant_arguments` sequence from its caller. It does not query Ant's effective property table, bind its process environment to a later child process, or acquire a lock preventing arguments, working directory or environment from changing after the check. A caller can therefore present a valid snapshot while launching Ant with different state. A PASS from this helper is not proof of the subsequent Ant invocation.

The required future architecture is one trusted launcher wrapper that constructs the final property map and argument vector, rejects unreviewed environment and user hooks, passes those exact values to preflight, and then invokes Ant with the same canonical checkout working directory, exact absolute buildfile, environment and arguments without intervening mutation. The wrapper must verify the pinned `customBuild.xml` content digest against FM-013 before launch. Wrapper integration is NOT_IMPLEMENTED; FMH-111 remains OPEN.

### FM-017 implementation and verification record

The read-only helper and 17-test hostile suite are registered under the EGIS verification tree. Test-first Python 3.11 run 45579053065 failed 14 expected assertions before hardening. Exact-code-head Python 3.11 run 45579457292 passed compileall, 30/30 mocked gate tests and 17/17 JUnit preflight tests. No Ant process or JUnit test was run; the helper is not connected to a trusted launcher wrapper. Gitleaks PR change-range scan passed on 45579457298; the full-history stage reported 13 historical generic-api-key findings.

### FMH-112 — Ant target and project-property injection

The original argument parser silently ignored unreviewed -Dname=value tokens and did not classify positional tokens as target names. The hardened parser accepts exactly one positional target token, default; blocks missing, multiple or non-default target lists; rejects every unreviewed -D property and rejects unknown option tokens. Exact-head Python 3.11 CI exercises foreign test.dir, class.dir, dist.file, secret-like properties and missing/extra targets. FMH-112 is MITIGATED IN THE HELPER SCOPE; actual Ant launch still requires the trusted wrapper under FMH-111.

### FMH-113 — Ant classloader injection through CLASSPATH and user library directory

Apache Ant documents that non-empty CLASSPATH is passed to Ant as a -lib entry and that the per-user home/.ant/lib directory can be scanned for additional libraries. The hardened helper requires CLASSPATH empty and rejects non-empty per-user .ant/lib, non-directory paths, symlink/reparse components and inspection failures. Exact-head Python 3.11 tests cover the first two attack paths. ANT_HOME/lib, the Ant installation, JDK, Java executable, native libraries and PATH remain unpinned under FMH-110. FMH-113 is MITIGATED IN THE HELPER SCOPE, not a universal classloader isolation proof.

### FM-018 implementation and verification record

- Pinned buildfile Git blob SHA-1: 3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976; the helper recomputes the Git blob identity from on-disk bytes before PASS.
- Exact-code-head commit 78020c75cee7767ab2a892a03bb9e085e41b1606; workflow 45579457292, Python 3.11.
- Compile PASS; mocked gate tests 30/30 PASS; JUnit preflight tests 17/17 PASS.
- Gitleaks 45579457298: PR change-range PASS (30 commits / ~53.73 KB); fetched-ref/history FAIL with 13 historical generic-api-key findings across 5,345 commits / ~16.43 MB. No suppression, rewrite or credential rotation.
- No Ant/JUnit execution, build, JAR creation, SANY/TLC or runtime change.

## 11. Safety boundary and source references

This selection reconstruction is static. No Ant/JDK runtime was acquired or invoked. No build, test, JAR creation, SANY/TLC run, deployment, merge or main-branch mutation occurred.

- Static selection manifest: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/verification/egis-verification-gate-v1.1.1-2026-11-25/verification/formal/egis/EGIS-FM-015-junit-static-selection-manifests.json
- Apache Ant FileSet semantics: https://ant.apache.org/manual/Types/fileset.html
- Apache Ant JUnit `batchtest`, XML report naming and `skipNonTests`: https://ant.apache.org/manual/Tasks/junit.html
- Apache Ant JUnitReport aggregation and explicit filesets: https://ant.apache.org/manual/Tasks/junitreport.html
- Apache Ant launcher arguments, environment variables and rc hooks: https://ant.apache.org/manual/running
- Python Windows symbolic-link and reparse-point behavior: https://docs.python.org/3.13/library/os.html
- EGIS-FM-017 preflight hostile implementation review: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/verification/egis-verification-gate-v1.1.1-2026-11-25/verification/formal/egis/EGIS-FM-017-junit-preflight-hostile-implementation-review.md
- EGIS-FM-016 JUnit report isolation proposal: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/verification/egis-verification-gate-v1.1.1-2026-11-25/verification/formal/egis/EGIS-FM-016-junit-report-isolation-and-discovery-contract.md
