# EGIS-FM-011 — Stable TLA+ Release Candidate Assessment

**Status:** Candidate identified; artifact trust gate NOT PASSED
**Date:** 2026-11-25
**Parent:** PR #475 — EGIS Verification Gate v1.1.1
**Candidate:** Official upstream TLA+ Tools v1.7.4 (Xenophanes)
**Scope:** Read-only assessment of official release metadata; no artifact download or execution

## 1. Decision

Identify upstream v1.7.4 as a stable-release candidate for further provenance work, but do not approve it as a trusted toolchain artifact yet.

The release is not marked immutable by GitHub's release metadata. Its asset record has no GitHub SHA-256 digest. The release body publishes only a SHA-1 checksum for `tla2tools.jar`. The source tag resolves to a fixed commit in the current observation, but that alone does not prove the release asset bytes are immutable or independently authenticated.

## 2. Exact observed upstream metadata

Source: GitHub REST API for the official `tlaplus/tlaplus` repository.

- Release URL: https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4
- Release ID: `168523867`
- Release name: `The Xenophanes release`
- Published at: `2024-08-05T20:16:41Z`
- `prerelease`: `false`
- `draft`: `false`
- `immutable`: `false`
- Tag ref: `refs/tags/v1.7.4`
- Tag object type: `commit`
- Tag target commit: `5a47802b5c391f59ecdd44117981f4ff8c0656ba`
- JAR asset ID: `184694200`
- Asset name: `tla2tools.jar`
- Asset size: `2,274,532` bytes
- Asset state: `uploaded`
- Asset uploader: `github-actions[bot]`
- Asset created/updated: `2024-08-08T13:30:39Z` / `2024-08-08T13:30:40Z`
- Asset API digest: `null`
- Release-published checksum: SHA-1 `bee4a54f3ee3d4afc347c3240ec2d9e93b075104`

These values are a point-in-time observation from the official API. They are not a cryptographic attestation of the downloaded bytes.

## 3. Hostile assessment

### FMH-087 — Stable label does not imply immutable asset

| Attribute | Assessment |
|---|---|
| Severity | High |
| Threat | Asset bytes or release metadata can be changed despite the stable/non-prerelease label |
| Evidence | GitHub release API reports `immutable=false`; asset digest is null; release body provides SHA-1 only |
| Mitigations | Fixed tag target commit; stable upstream release; official GitHub HTTPS delivery |
| Residual gap | Tag identity does not bind the uploaded asset bytes; SHA-1 is not accepted as the sole modern integrity control; no independent signed provenance or SHA-256 was exposed in the release metadata |
| Disposition | OPEN; candidate only, not approved for acquisition or execution |

The tag commit `5a47802b5c391f59ecdd44117981f4ff8c0656ba` is useful for source provenance and a possible source-build path. It does not by itself prove that the prebuilt JAR was generated from that exact source or that the JAR remains unchanged.

## 4. Candidate paths and acceptance tests

### Path A — Official prebuilt JAR

Remain BLOCKED until all of the following are met:

1. Acquire bytes only through the official release asset endpoint.
2. Independently compute SHA-256 and preserve byte count.
3. Obtain a trusted SHA-256 or signature/provenance binding the bytes to the release/build; do not treat a locally computed digest alone as publisher authenticity.
4. Establish an immutable artifact identity or independently trusted archival provenance.
5. Reconcile the artifact's embedded build/revision metadata with the pinned source commit.
6. Capture Java runtime vendor, full version, executable digest, and provenance.
7. Run SANY first, then TLC only after SANY passes; preserve raw output and traces.

### Path B — Reproducible source build

This may be a stronger candidate if the upstream source commit and every build input can be pinned:

1. Checkout exact source commit `5a47802b5c391f59ecdd44117981f4ff8c0656ba`.
2. Pin JDK vendor/version and binary digest.
3. Pin Apache Ant version and all build dependencies, including dependency checksums.
4. Build using the official documented Ant target from `tlatools/org.lamport.tlatools`.
5. Run upstream unit tests and preserve full logs.
6. Build twice in independent clean environments and compare artifact digests; if not reproducible, document the exact nondeterministic inputs and do not claim reproducible build.
7. Record build provenance, source tree digest, dependency lock, environment, commands, outputs, and resulting JAR SHA-256.
8. Treat the locally built JAR as a separately identified project-built artifact, not as the official upstream release JAR.

The upstream build instructions are documented at https://github.com/tlaplus/tlaplus/blob/master/DEVELOPING.md, but the instructions alone do not pin all dependencies or establish reproducibility.

## 5. Falsification conditions

FMH-087 can be downgraded only if trusted evidence binds the exact asset bytes to an immutable release/build identity, or if an independently reproducible source build establishes a new project-controlled artifact identity. A tag resolving consistently, a successful HTTPS download, a high download count, or a locally computed SHA-256 alone does not falsify the finding.

## 6. Evidence state

- Official release metadata fetched: YES.
- Stable/non-prerelease flag: VERIFIED.
- GitHub release immutable flag: FALSE.
- Tag target commit observed: VERIFIED.
- JAR asset ID and size observed: VERIFIED.
- GitHub asset SHA-256 digest: NOT PROVIDED.
- SHA-1 checksum in release body: OBSERVED; not accepted as sole trust control.
- Artifact bytes acquired: NO.
- Independent SHA-256 recomputation: NOT_RUN.
- Publisher signature / build provenance: NOT_ESTABLISHED.
- Source build: NOT_RUN.
- Reproducibility test: NOT_RUN.
- Java provenance: NOT_CAPTURED.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Formal model verification: NOT_ESTABLISHED.

## 7. Safety boundary

This is a documentation-only assessment on the existing PR #475 branch. No download, execution, merge, deployment, runtime modification, secret/binding/permission change, laptop operation, or change to `main` was performed.
