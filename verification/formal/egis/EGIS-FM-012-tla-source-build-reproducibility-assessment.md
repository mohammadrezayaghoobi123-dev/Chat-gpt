# EGIS-FM-012 — TLA+ Source Build Reproducibility and Provenance Assessment

**Status:** Candidate assessment; source-build approval BLOCKED  
**Date:** 2026-11-25  
**Parent assessment:** EGIS-FM-011  
**Target upstream repository:** https://github.com/tlaplus/tlaplus  
**Target source commit:** `5a47802b5c391f59ecdd44117981f4ff8c0656ba`  
**Target output:** standalone `tla2tools.jar` for SANY/TLC  
**Scope:** CLI build path only; the full Toolbox/Maven product build is out of scope

## 1. Executive disposition

The pinned source tree is a plausible engineering route for producing a project-built TLA+ CLI artifact, but the available evidence does not establish a reproducible or independently trusted binary.

**Decision: BLOCKED — do not build, download, execute, or approve an artifact under this assessment.**

The upstream source commit is fixed, and the CLI build inputs include a substantial set of vendored JARs committed in the same source tree. However:

- the documented JDK and Ant requirements are minimum versions, not exact toolchain pins;
- the vendored JARs have Git blob identities in the source tree, but no reviewed independent SHA-256 lock manifest was found in the inspected build inputs;
- the build embeds wall-clock date, user, environment, branch/tag/revision and commit-count metadata in the output manifest;
- the default build/test path excludes multiple test classes and separates long-running tests;
- the exact source build has not been executed, and no independent rebuild comparison or provenance attestation exists.

A source-built JAR, if later approved, must be named and described as a **project-built artifact from the pinned source commit**, not as the official upstream v1.7.4 release JAR.

## 2. Evidence inspected

The following upstream files were inspected at commit `5a47802b5c391f59ecdd44117981f4ff8c0656ba`:

| Path | Observed identity | Relevant evidence |
|---|---|---|
| `DEVELOPING.md` | Pinned source path | Documents JDK 11+ and Apache Ant 1.9.8+ for TLA+ Tools; describes Ant build and test commands |
| `tlatools/org.lamport.tlatools/customBuild.xml` | Git blob `3ee52fe5bc36e8e559e6a13f8c967cd8b67f9976` | CLI compile, distribution, test, manifest and Git revision behavior |
| `tlatools/org.lamport.tlatools/project.properties` | Git blob `79c7a67a317446789c56012ebf573391d35dd26f` | Build output paths and version property |
| `tlatools/org.lamport.tlatools/pom.xml` | Git blob `4cf0f219dfc62ed0e8a44478b3dc735e392223d0` | Maven wrapper around Ant and Toolbox/OSGi integration |
| root `pom.xml` | Pinned source path | Multi-module Toolbox build and Tycho configuration |
| `tlatools/org.lamport.tlatools/lib/` | Git tree `c5998ecb39e51e1d6c750548db532bb4f11733aa` | Vendored JAR inventory and Git blob identities |

The inspected vendored library tree contains JARs for JUnit, Hamcrest, CGLIB, Objenesis, JaCoCo, JGit/build-number support, JavaMail/activation, JPF and JMH. The build script references selected subsets for compile, test, coverage and auxiliary targets. The Git object identifiers are source-tree identities, not independent SHA-256 digests of the JAR bytes.

The upstream development guide describes the CLI path as:

```sh
cd tlatools/org.lamport.tlatools
ant -f customBuild.xml info compile compile-test dist
ant -f customBuild.xml test
```

This command sequence is recorded as documentation evidence only. It was not executed.

## 3. Dependency and toolchain assessment

### 3.1 Toolchain pins

| Component | Upstream documentation/build evidence | Assessment |
|---|---|---|
| JDK | JDK 11 or newer | **Not pinned** to vendor, exact release, patch level or digest |
| Apache Ant | 1.9.8 or newer | **Not pinned** to exact release or distribution digest |
| Git metadata | Ant target invokes a vendored JGit build-number task | Full and correctly identified source metadata must be available; shallow-history behavior is not approved |
| Maven/Tycho | Used by the broader Toolbox build; Tycho version property is 1.5.0 in root POM | Not required for the narrow standalone CLI Ant path; do not silently substitute the full Toolbox build |
| Vendored JARs | Checked into the pinned source tree | Content is commit-bound, but no independent SHA-256 inventory or external provenance was established in this review |

The minimum-version declarations are compatibility floors, not reproducible toolchain specifications. A future controlled build must pin the JDK vendor and exact build, Ant distribution and exact version, and the digest of each downloaded toolchain archive. The build environment must be isolated and recorded.

### 3.2 Vendored dependencies

The source tree contains vendored JARs, which reduces reliance on live dependency resolution for the Ant CLI build. This is a positive property, but it does not close the supply-chain question.

Required before approval:

1. Enumerate every JAR actually consumed by the selected Ant targets.
2. Compute SHA-256 from the exact bytes in a clean checkout.
3. Record file path, size, SHA-256, upstream origin/license where available, and Git blob identity.
4. Independently validate the resulting inventory against a second clean checkout of the same commit.
5. Fail the build if any file is absent, unexpected, or digest-mismatched.

No JAR bytes were downloaded or extracted for this assessment; no SHA-256 values were calculated.

## 4. Build determinism and provenance

The inspected Ant build creates a timestamp property and writes build metadata into the output JAR manifest, including values derived from:

- current date (`TODAY`);
- build user (`user.name`);
- environment variable `BUILD_TAG`;
- Git branch, tag, revision, short revision and commit count.

These fields can differ between clean builders even when the source commit is identical. Therefore, byte-for-byte reproducibility cannot be assumed from a pinned source commit alone.

The assessment does not claim that all JAR entries are inherently nondeterministic or that a normalized build is impossible. It establishes that the current build definition has not demonstrated deterministic output.

A future reproducibility protocol must define, before execution:

- a controlled and recorded environment;
- deterministic timestamp, locale, timezone, filesystem ordering and archive metadata policy;
- a documented treatment of user/environment/Git manifest fields;
- whether the comparison target is the complete JAR or a precisely defined normalized artifact;
- two independent clean builds with no shared build cache;
- exact SHA-256 equality of the approved comparison target;
- retained logs, toolchain digests, source commit, dependency inventory and build attestations.

If normalization changes the upstream build output, the result must be classified as a locally modified build procedure and separately reviewed. It must not be represented as an unmodified upstream build.

## 5. Test coverage and semantic limits

The default Ant build invokes compile, compile-test, test, distribution and test-dist targets. The inspected test target explicitly excludes numerous classes, including known-failure and long-running cases; long-running tests are separated into another target.

Consequently, a successful default build would not, by itself, prove that every upstream test suite ran. A later build record must list the exact targets, exclusions, test counts, failures, skipped tests and report digests. Tests that are excluded by upstream defaults must not be silently counted as passing.

Even a fully successful upstream test suite would establish only the tested properties of that TLA+ tool build. It would not establish that the EGIS models are correct, that the gate's output parser is sound, or that a particular application implementation conforms to a formal model.

## 6. Hostile findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-088 | High | JDK and Ant are specified by minimum versions rather than exact immutable toolchain identities. | Open; block source-build approval until exact vendor/version/build and archive digests are fixed. |
| FMH-089 | High | Build manifest embeds date, user, environment and Git metadata, so identical source does not imply identical JAR bytes. | Open; define deterministic build/normalization and independently reproduce it. |
| FMH-090 | High | Vendored JARs are commit-bound but no independent SHA-256 dependency inventory was established. | Open; hash and independently verify every consumed JAR before build. |
| FMH-091 | Medium | CLI Ant build and full Toolbox Maven/Tycho build are distinct paths; conflating them expands dependency scope and obscures the artifact actually produced. | Mitigated by this assessment's CLI-only scope; future commands must name the exact target and output. |
| FMH-092 | High | Default test targets exclude known-failure, auxiliary and long-running test classes. | Open; record exact test coverage and separately assess excluded suites. |
| FMH-093 | High | No source build, clean-room rebuild, artifact comparison or provenance attestation has been performed. | Open; execution remains prohibited until FMH-088..092 have approved controls. |
| FMH-094 | Medium | Build-number metadata depends on Git repository state; incomplete or altered history may change embedded provenance. | Open; require verified full source history and assert the exact source revision before building. |

## 7. Falsification and acceptance criteria

The source-build route must be rejected or remain BLOCKED if any of the following occurs:

- the source checkout does not resolve to the exact approved commit;
- any consumed vendored dependency lacks an independently verified digest;
- JDK or Ant differs from the approved exact toolchain;
- build scripts resolve unpinned external dependencies;
- the build writes unreviewed environment-dependent content into the artifact;
- two independent clean builds produce different approved comparison digests without a fully explained and accepted normalization;
- test reports are missing, incomplete, or misrepresent excluded tests as passed;
- the artifact cannot be bound to source, toolchain, dependencies and build logs through independently reviewable evidence.

Approval requires all acceptance criteria to pass and a separate authorization for controlled build execution. This document itself grants no execution authorization.

## 8. Current evidence state

| Activity | Status |
|---|---|
| Source commit selected and inspected | OBSERVED |
| Build instructions and Ant build logic inspected | OBSERVED |
| Vendored dependency tree enumerated | OBSERVED |
| Exact JDK/Ant toolchain pinned | NOT_ESTABLISHED |
| Independent SHA-256 inventory of consumed JARs | NOT_RUN |
| Source build | NOT_RUN |
| Upstream tests | NOT_RUN |
| Independent clean rebuild | NOT_RUN |
| Reproducibility comparison | NOT_RUN |
| Artifact provenance attestation | NOT_ESTABLISHED |
| SANY/TLC execution using a source-built artifact | NOT_RUN |

## 9. Decision and next atomic gate

**Decision: source-build candidate remains BLOCKED.** The source commit and build recipe are useful inputs for a future controlled experiment, but they do not currently justify trust in a resulting binary.

The next permitted work is documentation/design only: define a deterministic, minimal CLI build profile and a machine-readable dependency/toolchain lock contract. Do not download JDK/Ant/dependencies, build the JAR, execute SANY/TLC, or change runtime configuration until that contract has been independently reviewed and separately authorized.

## 10. References

- Upstream development guide: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/DEVELOPING.md
- Upstream Ant build: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/customBuild.xml
- Upstream CLI Maven wrapper: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/pom.xml
- Upstream root Maven build: https://github.com/tlaplus/tlaplus/blob/5a47802b5c391f59ecdd44117981f4ff8c0656ba/pom.xml
- Upstream vendored dependency tree: https://github.com/tlaplus/tlaplus/tree/5a47802b5c391f59ecdd44117981f4ff8c0656ba/tlatools/org.lamport.tlatools/lib
- Stable release metadata and published SHA-1: https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4
