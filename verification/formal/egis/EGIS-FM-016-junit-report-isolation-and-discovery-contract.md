# EGIS-FM-016 — JUnit Report Isolation, Discovery Semantics, and Clean-Run Evidence Contract

**Status:** Static remediation proposal; read-only preflight IMPLEMENTED_UNIT_TESTED_NOT_INTEGRATED; upstream build patch NOT_APPLIED; execution authorization NOT_GRANTED  
**Date:** 2026-11-25  
**Parent evidence:** EGIS-FM-013, EGIS-FM-014, EGIS-FM-015  
**Upstream repository:** tlaplus/tlaplus  
**Pinned source commit:** 5a47802b5c391f59ecdd44117981f4ff8c0656ba  
**Pinned Ant build blob:** 3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976  
**Pinned project properties blob:** 79c7a67a317446789c56012ebf573391d35dd26f  
**Selection manifest:** EGIS-FM-015-junit-static-selection-manifests.json

## 1. Decision

This proposal addresses three evidence-integrity findings:

- **FMH-107 (Medium):** Selected JUnit batchtest elements omit skipNonTests. Apache Ant documents the default as false; source-file selection counts are not discovered test counts.
- **FMH-108 (High):** Two test-dist batches write XML reports into the same directory as source-test reports, creating two exact class-derived path collisions.
- **FMH-109 (Medium):** The Ant clean target does not delete the JUnit report tree and is guarded by unless="noclean"; old XML can survive a later invocation.

**Decision:** Keep source/JAR file-selection rules unchanged; give the two target families disjoint report roots; make existing skipNonTests=false behavior explicit; and require an external fail-closed freshness/path preflight before Ant starts.

**This is a design proposal, not an applied upstream patch.** No Ant/JDK was acquired or invoked. No build, JUnit execution, JAR creation, SANY/TLC execution or runtime modification is claimed.

## 2. Pinned observations

At the exact source commit and Ant blob above:

| Observation | Static result |
|---|---|
| project.properties report root | target/surefire-reports/ |
| Source test batches | 8 |
| Packaged-JAR test-dist batches | 7 |
| Source batch report destinations | 8 use target/surefire-reports/ |
| Packaged-JAR batch destinations | 5 use target/surefire-reports/onJar/; 2 use the base report root |
| Explicit skipNonTests attributes on selected batches | 0 of 15 |
| Default target order | test precedes git-revision, dist, then test-dist |
| junitreport task in this pinned Ant file | Not present |
| clean report-tree deletion | Not present |
| clean guard | unless="noclean" |

The two base-root test-dist batches select:

- tlc2.tool.UserModuleOverrideAnnotationTest
- tlc2.tool.UserModuleOverrideFromJarTest

The source test target selects those same classes. With the default XML formatter naming convention, both target families address the same two XML paths unless their output roots differ.

The selection manifest records 411 unique source paths for test and 411 for test-dist; the selected path sets are equal. These are static path selections, not discovered or executed JUnit tests.

## 3. Minimal candidate build-definition overlay

The following target-scoped transformations define the proposed overlay. They are not changes to the pinned upstream file and must be applied only as a separately reviewed patch if later authorized.

### 3.1 Source test target

1. Change the target's report-directory creation from:
   <mkdir dir="${test.reports}" />
   to:
   <mkdir dir="${test.reports}/source" />

2. In exactly the eight batchtest elements inside target test, change the destination:
   todir="${test.reports}"
   to:
   todir="${test.reports}/source"

3. Add skipNonTests="false" to each of those eight batchtest start tags.

### 3.2 Packaged-JAR test-dist target

1. Keep the existing creation of <mkdir dir="${test.reports}/onJar" />.
2. In exactly the two batchtest elements inside target test-dist that currently use todir="${test.reports}", change the destination to todir="${test.reports}/onJar".
3. Add skipNonTests="false" to all seven batchtest start tags in target test-dist, including the five that already use the onJar directory.

### 3.3 Expected result and semantic preservation

The candidate overlay yields two disjoint output roots:

- Source compilation/test reports: target/surefire-reports/source/
- Packaged-JAR test reports: target/surefire-reports/onJar/

Exactly 15 selected-profile batch tags receive an explicit skipNonTests="false" value (8 source + 7 packaged-JAR). This matches the documented Ant default; it is not a proposal to enable non-test filtering.

The overlay must not change any fileset, include/exclude rule, batch membership, target dependency/order, classpath, JUnit fork mode, JVM argument, JaCoCo configuration, failure/halt property or target invocation. test-single, test-dist-long and test-verify remain outside this overlay.

The exact Ant distribution remains unpinned. Before applying or executing the overlay, the selected Ant/ant-junit version must be pinned and its support for the explicit batchtest skipNonTests attribute verified. FMH-107 remains open until runtime discovery/report evidence exists.

## 4. Freshness and path preflight contract

The pinned clean target removes the class and test-class output trees and recursively removes states/**; it does not remove target/surefire-reports/. Its unless="noclean" guard means even those clean operations may be skipped. Therefore, a successful clean target is not proof that JUnit report roots are fresh.

Before any future authorized execution, an independent controller must:

1. Use a new disposable checkout/worktree dedicated to one build attempt. Do not reuse a workspace with prior report outputs.
2. Require noclean to be absent and require existing test skip/halt properties to match the FM-013 lock.
3. Require test.reports to resolve to the locked report root. Permit only a redundant command-line override with the exact locked value; reject conflicting, duplicate or unreviewed property overrides.
4. Require the canonical report root to be absent before execution. Do not silently delete an existing report tree.
5. Resolve the root and both target subdirectories canonically; reject symlinks, path traversal, absolute-path escapes and any canonical path outside the checkout.
6. Require canonical source and onJar roots to be distinct and non-overlapping.
7. Allow only one Ant invocation per checkout. Builder A and Builder B must use separate worktrees; do not run competing builds against the same report tree.
8. After the run, enumerate report files and compare the actual relative-path set with the target-specific expected path manifest. Reject missing, unexpected, duplicate or cross-root paths before interpreting XML.
9. Hash every report file and the report-path manifest, then parse the XML to obtain actual suite/class/method counts and outcome counts. Keep source and packaged-JAR evidence separate.

An unconditional Ant delete of the report directory is deliberately not proposed. The report property can be overridden, and deleting through an unchecked path or symlink could remove data outside the build tree or race with another process. Freshness is an external precondition until a bounded, symlink-safe deletion mechanism is independently specified and tested.

## 5. Report aggregation boundary

No junitreport task is present in the inspected pinned customBuild.xml. This observation is limited to that file; it does not exclude external CI/reporting systems.

If a later controller uses Ant junitreport or another aggregator, it must provide a distinct, explicit fileset for source/ and onJar/. A recursive fileset over the common parent must not erase target attribution or ingest stale files. Aggregated summaries, if produced, must retain the two source identities and their separate per-file digests.

## 6. Hostile review

| Attack or failure mode | Candidate control | Residual status |
|---|---|---|
| Same-class XML overwrite across targets | Separate source/ and onJar/ roots | Static design only; FMH-108 OPEN until applied and validated |
| Test omission or accidental selection change | No fileset/include/exclude edits; FM-015 digests remain the baseline | Static proposal; actual discovery NOT_RUN |
| Non-test filtering changes semantics | Explicit skipNonTests="false" on all 15 selected batches | Ant version/parser support and runtime effect NOT_RUN |
| Stale XML from previous invocation | Require absent report root in fresh checkout | Preflight NOT_RUN; FMH-109 OPEN |
| noclean or test.skip silently weakens execution | Reject prohibited/effective properties before Ant starts | Preflight NOT_RUN |
| test.reports override or path traversal | Pin property; canonicalize and enforce checkout containment | Helper unit-tested; caller property map is not yet authenticated by a trusted wrapper |
| Symlink aliases make nominal roots overlap | Reject symlink components and compare canonical paths | Preflight NOT_RUN |
| Concurrent builds delete or overwrite reports | One build per checkout; separate Builder A/B worktrees | Controller enforcement NOT_RUN |
| External aggregator combines source and JAR XML | Separate, exact filesets and identities | No aggregator in pinned file; external pipeline NOT_AUDITED |
| A file count is misrepresented as a test count | Label all 411 values as static source-path counts | Corrective documentation recorded; actual counts NOT_RUN |

## 7. Falsification and acceptance tests for a later authorized patch

A future patch/controller is unacceptable unless all of the following can be demonstrated in a disposable environment:

- The candidate XML parses and Ant accepts every explicit skipNonTests attribute using the exact pinned Ant distribution.
- Static before/after selection manifests are byte-for-byte equivalent in selected paths and batch assignments.
- Every source-test report path is rooted under canonical source/; every packaged-JAR report path is rooted under canonical onJar/; the two path sets are disjoint.
- Injecting an identical/canonicalized report root causes BLOCKED before Ant execution.
- Seeding a stale XML file, setting noclean, setting test.skip, overriding test.reports, or introducing a symlink causes BLOCKED before Ant execution.
- Missing or extra report files, malformed XML, duplicate class report names or a digest mismatch prevent evidence acceptance.
- Per-target class, method, executed, passed, failed, skipped and excluded counts are derived from actual XML/log evidence, not from the 411 selected paths.
- A separate external aggregation test proves that source and packaged-JAR inputs remain distinguishable.

A successful static diff review does not prove Ant accepts the patch. A successful Ant invocation does not prove all tests passed. Neither establishes EGIS model correctness or implementation conformance.

## 8. Current disposition

| Item | State |
|---|---|
| FMH-107 — explicit discovery semantics | OPEN; explicit false is proposed only; exact Ant version and actual discovery are NOT_RUN |
| FMH-108 — source/JAR output collision | OPEN; candidate report-root isolation is NOT_APPLIED |
| FMH-109 — stale report-root retention | OPEN; helper implemented/unit-tested but not integrated with a trusted launcher |
| Candidate build-definition overlay | PROPOSED_NOT_APPLIED |
| FM-015 source selection baseline | Preserved; no include/exclude or batch selection change |
| Ant/JDK acquisition, build and JUnit execution | NOT_RUN |
| JAR creation or execution | NOT_RUN |
| SANY/TLC execution | NOT_RUN |
| Promotion | BLOCKED |

Do not apply this overlay to upstream source, acquire tools, build, run tests, create/execute a JAR, execute SANY/TLC, modify runtime configuration, deploy or merge without a separate explicit authorization.

## 9. References

- Pinned upstream Ant build: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/customBuild.xml
- Pinned upstream project properties: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/project.properties
- Static selection manifest: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/verification/egis-verification-gate-v1.1.1-2026-11-25/verification/formal/egis/EGIS-FM-015-junit-static-selection-manifests.json
- Apache Ant JUnit task, batchtest, report naming and skipNonTests: https://ant.apache.org/manual/Tasks/junit.html
- Apache Ant JUnitReport task and explicit XML filesets: https://ant.apache.org/manual/Tasks/junitreport.html


## 10. Read-only preflight implementation status (EGIS-FM-017)

The helper `egis_junit_report_preflight.py` checks the absent canonical report root, locked report/basedir paths, required test skip/halt properties, exact absolute `customBuild.xml` argument, selected JVM/Ant launcher injection options, environment variables and Ant user rc hooks. It is read-only and does not create or delete report directories.

Local evidence: 12/12 tests PASS, compileall PASS, six targeted mutation checks caught; Python 3.13.5. The checked-in workflow uses Python 3.11 and the new exact-head CI result is pending. The helper accepts a caller-provided property snapshot and is **not yet connected to a trusted wrapper** that guarantees the later Ant process uses the identical properties, argv, working directory and environment. It is not a concurrency lock or invocation attestation.

FMH-110 (launcher injection) and FMH-111 (unauthenticated property snapshot/missing invocation binding) remain OPEN. FMH-109 remains OPEN until wrapper integration and CI pass. The upstream `customBuild.xml` and all report-selection rules remain unchanged; no Ant/JUnit execution is claimed.
