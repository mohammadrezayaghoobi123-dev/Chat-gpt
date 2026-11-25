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

## 6. Falsification tests for a future authorized controller

The controller must be shown to BLOCK before process execution when any of the following is injected:

- Remove one file or alter the tree identity under `test-model/`.
- Set `maven.test.skip=true` or define `test.skip` to any value.
- Set `maven.test.halt=false` or otherwise make effective `test.halt` non-true.
- Add, remove or retarget a Git tag/ref that changes JGit build metadata.
- Point `basedir` outside the disposable checkout or introduce a symlinked `states` path.
- Alter one source-test or packaged-JAR include/exclude rule without changing its corresponding selection-manifest digest.
- Enable network access during the build phase.

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
- Manifest SHA-256: `702154f5a83cfb50132d7db36ba295eeb9c708b71bf93eb5751aced6b5ca01c0`

**Hostile interpretation:** 411 is the number of source paths selected by the static fileset model. It is not a count of JUnit test classes, test methods, test invocations or successful tests.

The upstream JUnit tasks omit `skipNonTests`. Apache Ant's JUnit task documentation specifies a default of `false`, meaning Ant does not filter out non-test classes before passing matched files to the JUnit runner. Exact Ant version and actual discovery behavior are still unpinned/unexecuted. FMH-107 remains open.

FMH-105's static manifest ambiguity is mitigated, but the actual execution/report requirement remains open. No test was run and no JUnit report was generated in this audit.

## 11. Safety boundary and source references

This selection reconstruction is static. No Ant/JDK runtime was acquired or invoked. No build, test, JAR creation, SANY/TLC run, deployment, merge or main-branch mutation occurred.

- Static selection manifest: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/verification/egis-verification-gate-v1.1.1-2026-11-25/verification/formal/egis/EGIS-FM-015-junit-static-selection-manifests.json
- Apache Ant FileSet semantics: https://ant.apache.org/manual/Types/fileset.html
- Apache Ant JUnit `batchtest` and `skipNonTests`: https://ant.apache.org/manual/Tasks/junit.html
