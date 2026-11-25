# EGIS-FM-013 — Deterministic TLA+ CLI Build Profile and Lock Contract

**Status:** Design contract only; execution authorization NOT GRANTED  
**Date:** 2026-11-25  
**Parent:** EGIS-FM-012  
**Upstream source:** `tlaplus/tlaplus`  
**Source commit:** `5a47802b5c391f59ecdd44117981f4ff8c0656ba`  
**Build file:** `tlatools/org.lamport.tlatools/customBuild.xml`  
**Intended artifact:** `tlatools/org.lamport.tlatools/dist/tla2tools.jar`  
**Scope:** standalone TLA+ CLI artifact and its explicitly declared runtime companion(s)

## 1. Decision

This document defines the minimum lock and evidence contract for a future controlled source-build experiment. It does **not** authorize toolchain acquisition, dependency download, compilation, test execution, JAR creation, SANY/TLC execution, or runtime installation.

**Current disposition: BLOCKED.** The lock template below is intentionally incomplete and must fail closed until every required identity, digest, provenance item and review is populated and independently approved.

The source commit remains unsigned according to GitHub commit-verification metadata. A content hash is not an identity signature. This contract cannot manufacture missing upstream authorship assurance.

## 2. Scope and build-target separation

The inspected pinned Ant file defines materially different target paths:

| Target | Observed behavior | Contract treatment |
|---|---|---|
| `info` | Depends on `git-revision`; emits Ant/Java and Git metadata | Required before artifact production |
| `compile` | Depends on `clean`; compiles Java with source/target 1.8 and copies resources | Required |
| `compile-test` | Compiles tests and copies test resources | Required for the test profile |
| `test` | Runs JUnit with a substantial explicit exclusion list and separate batches | Required; exclusions must be reported |
| `dist` | Unpacks mail/activation classes, touches a resource, creates `dist/tla2tools.jar` and embeds a Manifest | Required |
| `test-dist` | Runs tests against the produced JAR under JaCoCo and also has exclusions | Required for the selected verification profile, with explicit coverage reporting |
| `default` | Chains info, compile, compile-test, test, Git revision, dist and test-dist | Do not use as an opaque success label; record every nested target and result |
| `default-maven` | Omits the normal `test` target | Prohibited as evidence of a full test run |

The pinned `DEVELOPING.md` has a build-path discrepancy already recorded in FMH-097. The actual Ant file is under `tlatools/org.lamport.tlatools/`; the command path must be resolved against the exact checkout before execution.

The contract distinguishes:
- **Build profile:** produces a CLI JAR from the pinned source.
- **Selected verification profile:** runs the explicitly selected source and packaged-JAR test targets and records all exclusions; it is not a claim that every upstream test target ran.
- **Extended test targets:** `test-verify` (NASA JPF-based verification), `test-dist-long` (long-running packaged-JAR tests) and `benchmark` are separate targets and are outside the selected profile. If later included, their JPF/JMH inputs must be added to a separate lock extension and their results reported independently.
- **Runtime profile:** validates the produced JAR with every required companion dependency, including the Manifest-declared `CommunityModules.jar` dependency.

A successful build is not a successful test run. A successful test run is not proof of EGIS model correctness or implementation conformance.

## 3. Newly identified hostile findings

| ID | Severity | Finding | Required disposition |
|---|---|---|---|
| FMH-098 | High | The Ant `<jar>` task in the pinned build does not set a deterministic ZIP-entry modification time or a deterministic entry-order policy. `SOURCE_DATE_EPOCH` controls Ant timestamp properties in supported Ant versions, but does not by itself normalize every JAR entry timestamp. | Open. Require a reviewed build-definition patch or a separately specified deterministic packaging step, fixed entry timestamps, stable ordering and independent digest equality. |
| FMH-099 | High | The generated Manifest declares `Class-Path: CommunityModules.jar`, but this companion artifact is not produced by the inspected TLA+ CLI target. Its exact source, release identity, digest and compatibility are not bound by the TLA+ source commit. | Open. Lock the companion artifact by immutable source/release identity and SHA-256, or prove it is not required for the exact EGIS execution profile. |
| FMH-100 | High | The CommunityModules repository's inspected current build recipe fetches a TLA+ tool JAR from the moving `v1.8.0` release tag. Building CommunityModules from its rolling branch would reintroduce the mutable-artifact risk rejected in FM-008/FMH-086. | Open. Do not build CommunityModules from an unpinned branch or rolling tag; independently pin and validate its source, toolchain, dependencies and output if it is needed. |

FMH-098 is grounded in the pinned Ant build's `<tstamp>`, `<touch>`, and `<jar>` operations. Apache Ant documents that fixed archive-entry timestamps require the JAR/ZIP `modificationtime` attribute (Ant 1.10.2+) and that `SOURCE_DATE_EPOCH` is honored by `tstamp` only from Ant 1.10.8+. These are separate controls; neither establishes deterministic file ordering by itself.

FMH-099 is grounded in the pinned Manifest's `Class-Path` attribute. The pinned TLA+ Manifest refers to `CommunityModules.jar`, while the current CommunityModules README documents `CommunityModules-deps.jar` for the dependency bundle. Their equivalence is not established; do not silently substitute one for the other.

FMH-100 is a separate supply-chain boundary: the CommunityModules repository build script fetched `tla2tools.jar` from the mutable TLA+ `v1.8.0` release URL in the inspected version. Do not inherit that rolling input into this build.

## 4. Proposed fail-closed lock format

The following is a **schema example**, not a populated or approved lock. Any `null`, empty digest, floating version, `latest` URL, branch-only dependency reference, or missing provenance field must cause the future build controller to return BLOCKED before network access or execution.

```json
{
  "schema_version": "1.0",
  "lock_status": "INCOMPLETE_BLOCKED",
  "source": {
    "repository": "https://github.com/tlaplus/tlaplus",
    "commit": "5a47802b5c391f59ecdd44117981f4ff8c0656ba",
    "tree_sha": "fb0d9481ef7f1c4dc4cf066812b90f38ac4b0ef1",
    "signature_status": "UNSIGNED",
    "independent_origin_evidence": null
  },
  "toolchain": {
    "jdk": {
      "vendor": null,
      "version": null,
      "build": null,
      "archive_uri": null,
      "archive_sha256": null
    },
    "ant": {
      "version": null,
      "archive_uri": null,
      "archive_sha256": null
    }
  },
  "environment": {
    "source_date_epoch": null,
    "timezone": "UTC",
    "locale": "C.UTF-8",
    "user_name": "egis-reproducible-builder",
    "build_tag": "egis-source-build",
    "git_checkout": "full-history-detached-exact-commit",
    "network_during_build": "DENY"
  },
  "build_definition": {
    "upstream_path": "tlatools/org.lamport.tlatools/customBuild.xml",
    "upstream_blob_sha": "3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976",
    "reviewed_patch_sha256": null,
    "entry_order_policy": null,
    "zip_entry_timestamp_policy": null,
    "manifest_normalization_policy": null
  },
  "dependencies": [
    {
      "path": "lib/javax.mail/mailapi-1.6.3.jar",
      "git_blob_sha": "dec5ed8ffa782974f85c3ed791e258faa3452aea",
      "size_bytes": 298774,
      "sha256": null,
      "role": "compile-and-package"
    },
    {
      "path": "lib/javax.mail/smtp-1.6.3.jar",
      "git_blob_sha": "ea4dafb079d35a02eae8baf976ea79413bc43be7",
      "size_bytes": 62101,
      "sha256": null,
      "role": "package"
    },
    {
      "path": "lib/javax.mail/javax.activation_1.1.0.v201211130549.jar",
      "git_blob_sha": "fb4f69d92fa98abeff31c378428cbc2984be89e7",
      "size_bytes": 55065,
      "sha256": null,
      "role": "package"
    },
    {
      "path": "lib/org.eclipse.jgit-2.3.1.201302201838-r.jar",
      "git_blob_sha": "5c6aa301f5aaea5b31348b11ab2c0cd5c3fb9d3d",
      "size_bytes": 1648568,
      "sha256": null,
      "role": "git-revision-task"
    },
    {
      "path": "lib/jgit-buildnumber-ant-task-1.2.10.jar",
      "git_blob_sha": "cc8269bb088123f7c77e02786fd7b8398734df2f",
      "size_bytes": 8370,
      "sha256": null,
      "role": "git-revision-task"
    },
    {
      "path": "lib/junit-4.12.jar",
      "git_blob_sha": "3a7fc266c3e32283a2b21fe12166ebdcc33a1da1",
      "size_bytes": 314932,
      "sha256": null,
      "role": "test"
    },
    {
      "path": "lib/hamcrest-core-1.3.jar",
      "git_blob_sha": "9d5fe16e3dd37ebe79a36f61f5d0e1a69a653a8a",
      "size_bytes": 45024,
      "sha256": null,
      "role": "test"
    },
    {
      "path": "lib/cglib-nodep-3.1.jar",
      "git_blob_sha": "c0ac121455e5996262a3a80e42356b9a30b22c56",
      "size_bytes": 331202,
      "sha256": null,
      "role": "test"
    },
    {
      "path": "lib/objenesis-2.1.jar",
      "git_blob_sha": "92ab8ea74312ebf599a27e0cb452d754823c1205",
      "size_bytes": 41755,
      "sha256": null,
      "role": "test"
    },
    {
      "path": "lib/jacocoant.jar",
      "git_blob_sha": "09ac4a806f595e54eeb4623d20e134ebf2706b89",
      "size_bytes": 743031,
      "sha256": null,
      "role": "packaged-jar-test-coverage"
    },
    {
      "path": "test-model/UserModuleOverrideFromJar.jar",
      "git_blob_sha": "a410365e01d820d76a0065a5898975dc24712403",
      "size_bytes": 1006,
      "sha256": null,
      "role": "test-fixture"
    }
  ],
  "runtime_companions": [
    {
      "name": "CommunityModules.jar",
      "required": "UNRESOLVED",
      "repository": "https://github.com/tlaplus/CommunityModules",
      "immutable_source_or_release": null,
      "asset_sha256": null,
      "compatibility_evidence": null
    }
  ],
  "build": {
    "target_sequence": [
      "info",
      "compile",
      "compile-test",
      "test",
      "dist",
      "test-dist"
    ],
    "excluded_target_groups": [
      "test-verify",
      "test-dist-long",
      "benchmark"
    ],
    "test_halt_on_failure": true,
    "test_exclusions_inventory_sha256": null,
    "network_during_build": "DENY"
  },
  "outputs": [
    {
      "path": "tlatools/org.lamport.tlatools/dist/tla2tools.jar",
      "sha256_builder_a": null,
      "sha256_builder_b": null,
      "comparison_result": "NOT_RUN"
    }
  ],
  "attestation": {
    "builder_a_identity": null,
    "builder_b_identity": null,
    "independent_review": null,
    "logs_sha256": null,
    "decision": "BLOCKED"
  }
}
```

The dependency entries above identify direct files referenced by the selected CLI build/test target profile. Git blob identities and byte sizes were populated from the pinned upstream Git tree; SHA-256 values remain deliberately unset because the exact bytes were not materialized and hashed. This is not yet an approved dependency inventory: every additional file consumed by the selected target graph, nested directory, test fixture or runtime companion must be added before the lock can become valid.

Git blob SHA values bind the repository object but are not substitutes for SHA-256 of the extracted dependency bytes. Both identities must be recorded.

## 5. Deterministic build requirements

### 5.1 Toolchain

- Pin JDK vendor, exact version, build identifier, archive URI and archive SHA-256.
- Pin an exact Ant distribution and archive SHA-256.
- Ant must support the selected fixed timestamp mechanism. The documented `SOURCE_DATE_EPOCH` behavior requires Ant 1.10.8+; exact version remains unset pending independent compatibility review.
- Do not rely on the host PATH, ambient `JAVA_HOME`, user profile, global Ant libraries or mutable package manager state.
- Record OS/architecture, locale, timezone, filesystem and container/image digest.
- Build must run with network denied after all inputs are independently acquired and verified.

### 5.2 Archive and Manifest determinism

The pinned Ant file currently:
- sets `TODAY` using `<tstamp>`;
- creates `javamail.default.address.map` using `<touch>`;
- compiles classes and copies resources with filesystem modification times;
- writes `Built-By`, `Build-Tag`, `Implementation-Version` and Git metadata into the JAR Manifest;
- creates a JAR without an explicit `modificationtime` or reviewed deterministic entry-order rule.

A reviewed deterministic packaging design must define:
1. One fixed source epoch, derived from an independently authenticated source record and recorded as an integer.
2. One fixed ZIP/JAR entry timestamp policy applied to **every** entry, not only the Ant `TODAY` property.
3. A deterministic entry ordering policy, duplicate-entry rejection and stable compression settings.
4. Fixed Manifest values for builder identity, build tag, version/date and Git metadata; no ambient user or environment values.
5. A fixed treatment for `Build-Rev` and every other Manifest attribute, including absent/undefined values.
6. A controlled Git metadata state: full history, exact commit, no dirty files, deterministic branch/tag metadata, and no shallow clone.
7. A reviewed patch identity. Do not modify upstream build files silently or call a locally patched build an unmodified upstream build.

Ant's `SOURCE_DATE_EPOCH` support for `tstamp` does not normalize JAR ZIP entry times by itself. The Ant JAR task separately exposes `modificationtime`; the pinned build does not currently set it. A future patch must also prove stable entry order on two independent filesystems.

### 5.3 Dependency lock

For every consumed JAR and test fixture, require:
- repository-relative path;
- Git blob SHA and byte size;
- independently calculated SHA-256;
- upstream origin and license evidence;
- exact target(s) that consume it;
- verification result from a second clean checkout.

No `latest`, rolling release, mutable branch, unversioned URL, or unverified mirror is accepted. No dependency may be downloaded during the build phase.

### 5.4 CommunityModules runtime boundary

The generated TLA+ Manifest declares `Class-Path: CommunityModules.jar`. The TLA+ CLI build target does not create that companion.

Before runtime approval, choose exactly one evidence-backed disposition:
- lock an immutable CommunityModules release/source commit and its required artifact(s), with SHA-256 and compatibility evidence; or
- demonstrate through a controlled runtime test that the EGIS profile does not require the companion and explicitly record the resulting classpath behavior.

Do not use the current rolling `v1.8.0` TLA+ download URL found in the CommunityModules build recipe. Do not substitute `CommunityModules-deps.jar` for `CommunityModules.jar` without proving that the Manifest and runtime semantics support it.

## 6. Test and evidence contract

The verification record must include:
- exact target invocation and Ant exit code;
- compile/test target outcomes separately;
- number of tests discovered, executed, passed, failed, skipped and excluded;
- exact exclusion inventory and reason for each exclusion;
- source-test and packaged-JAR test reports;
- JaCoCo report identity, if used;
- SHA-256 for every log and report;
- SANY and TLC version/help output from the final artifact;
- a small controlled SANY parse fixture and TLC model-check fixture with expected results;
- explicit statement that these checks validate tool operation only, not EGIS model correctness or implementation conformance.

No test may be reported PASS if it was excluded, skipped, timed out, or not run.

## 7. Independent reproducibility protocol

Only after the lock is complete and separately authorized:

1. Builder A and Builder B independently acquire the exact source and all locked inputs.
2. Verify source, toolchain and every dependency digest before build.
3. Build in isolated clean environments with network disabled.
4. Preserve unmodified and normalized artifact digests separately if normalization is required.
5. Compare the complete output JAR SHA-256 values.
6. If they differ, compare ZIP entry lists, per-entry hashes, timestamps, Manifest bytes, compression metadata and build logs; classify the result UNKNOWN or FAIL, never PASS by assumption.
7. Re-run from fresh clean checkouts after any build-definition or lock change.
8. Have an independent reviewer validate provenance, lock completeness, test coverage and both build records.

A reproducible build proves repeatability under the recorded conditions. It does not, by itself, prove that the source is benign or that its authorship is authentic.

## 8. Hostile acceptance and falsification rules

The build controller must return BLOCKED before network or process execution if:
- any required lock field is null, blank, mutable or unresolved;
- source identity/authorship evidence is below the approved trust policy;
- a dependency digest differs or a dependency is not listed;
- the selected Ant target graph consumes an unlisted file;
- runtime companion identity or necessity is unresolved;
- build-time network access is possible;
- build timestamps, entry order, Manifest values or Git metadata are not fully controlled;
- the build uses an unreviewed patch;
- tests silently omit or mislabel excluded tests;
- independent builders produce different output digests without an accepted, documented normalization.

No override may convert missing evidence to PASS. The only permissible states are PASS, FAIL, UNKNOWN, NOT_RUN and BLOCKED, with BLOCKED required for incomplete preconditions.

## 9. Current evidence state

| Control | Status |
|---|---|
| Exact upstream source commit | OBSERVED |
| Source commit signer authentication | NOT_ESTABLISHED |
| Pinned Ant build target graph inspected | OBSERVED |
| Direct dependencies for selected target profile identified | PARTIAL; SHA-256 values NOT_RUN |
| Extended target dependencies (JPF/JMH) | OUT_OF_SCOPE; separate lock extension required |
| Exact JDK vendor/version/build/digest | NOT_SET |
| Exact Ant version/archive digest | NOT_SET |
| SHA-256 dependency lock | NOT_RUN |
| Deterministic JAR entry timestamp policy | NOT_IMPLEMENTED |
| Deterministic entry ordering | NOT_ESTABLISHED |
| Manifest normalization | NOT_IMPLEMENTED |
| CommunityModules companion identity | UNRESOLVED |
| Full build and tests | NOT_RUN |
| Independent builds | NOT_RUN |
| Artifact digest comparison | NOT_RUN |
| SANY/TLC execution | NOT_RUN |

## 10. Next gate

Next work is restricted to a second independent review of this lock contract and a completeness audit of the exact Ant target graph and dependency inventory. Do not populate speculative version/digest values, download any toolchain or dependency, patch the upstream build, compile, create a JAR, execute SANY/TLC, or alter runtime configuration without a separate explicit authorization.

## 11. References

- Pinned TLA+ Ant build: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/customBuild.xml
- Pinned TLA+ project properties: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/project.properties
- Pinned TLA+ vendored libraries: https://github.com/tlaplus/tlaplus/tree/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/lib
- Current CommunityModules README: https://github.com/tlaplus/CommunityModules/blob/master/README.md
- Current CommunityModules build recipe: https://github.com/tlaplus/CommunityModules/blob/master/build.xml
- Apache Ant TStamp task: https://ant.apache.org/manual/Tasks/tstamp.html
- Apache Ant JAR task: https://ant.apache.org/manual/Tasks/jar.html
- Apache Ant ZIP task: https://ant.apache.org/manual/Tasks/zip.html
