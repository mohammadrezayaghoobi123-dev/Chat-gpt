# EGIS-FM-010 — Mutable Release Channel Hostile Reassessment

**Status:** Critical supply-chain finding OPEN; acquisition BLOCKED
**Date:** 2026-11-25
**Parent:** PR #475 — EGIS Verification Gate v1.1.1
**Scope:** Independent reassessment of the proposed TLA+ Tools v1.8.0 artifact acquisition path

## 1. Decision

Reject the upstream `v1.8.0` rolling pre-release as a durable artifact pin. Withdraw the acquisition procedure for this candidate. Do not download, execute, or use its current publisher digest as an approved security pin.

The previous runbook's pre-download and post-download metadata comparison is insufficient against an artifact replacement-and-restore (ABA) race and cannot convert a mutable channel into an immutable release.

## 2. Evidence

1. Official upstream repository: https://github.com/tlaplus/tlaplus
   - The project README describes every commit to the master branch as being built and uploaded to the `1.8.0` Clarke pre-release.
   - The README documents Java 11+ and the SANY/TLC entry points, but does not claim the rolling pre-release is immutable.
2. Official upstream workflow: https://github.com/tlaplus/tlaplus/blob/master/.github/workflows/main.yml
   - The release workflow force-updates the `v1.8.0` tag.
3. Official upstream issue #1399: https://github.com/tlaplus/tlaplus/issues/1399
   - The issue reports that the released `tla2tools.jar` bytes changed after publication and that the SHA-256 used by a downstream Bazel integrity pin consequently changed.
   - The expected invariant that a released artifact remains immutable was not upheld for this channel.
4. Official release page: https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0
   - The channel is explicitly presented as a pre-release / rolling build.

## 3. Hostile analysis

### FMH-086 — Mutable release artifact identity

| Attribute | Assessment |
|---|---|
| Severity | Critical |
| Threat | A publisher-side workflow or release mutation replaces bytes behind a stable release/tag/asset URL or identifier |
| Security property at risk | Reproducible artifact identity and trustworthy tool provenance |
| Existing mitigation | Fetch metadata before and after download; compare asset ID, size, digest, URL, and tag reference |
| Why mitigation is insufficient | Two endpoint observations do not prove that bytes remained constant between observations; a transient replacement followed by restoration can evade the check |
| Additional risk | The publisher's API digest and downloaded bytes share a publisher trust root; hash equality is not independent provenance |
| Disposition | OPEN; reject v1.8.0 and block acquisition |

### Counterexample sequence

1. The client reads metadata M0 and observes asset digest H0.
2. The client begins downloading the asset.
3. The publisher-side release workflow replaces the asset with bytes B1 and digest H1.
4. The client may receive B1 while the release metadata is subsequently restored or changed again.
5. A later metadata read can observe M0/H0 even though the downloaded bytes were served during the mutation window, depending on endpoint and cache behavior.

The exact exploitability of this sequence against GitHub's current asset delivery/cache behavior is **UNKNOWN**. The documented replacement history is sufficient to reject immutability assumptions; no claim is made that a specific attack occurred.

## 4. Falsification and distinguishing tests

The finding may be downgraded only if all of the following are independently established:

- A stable upstream release or build-specific artifact exists with a non-moving source/build identity.
- The publisher provides signed provenance or a checksum/signature whose trust root is independent of the mutable release metadata path.
- The exact downloaded bytes verify against that provenance.
- The source commit and build identity are independently reconciled with the artifact.
- The artifact remains retrievable under an immutable identifier and repeated independent retrievals produce the same digest.
- Java runtime vendor, build, executable digest, and provenance are separately recorded.

A repeated successful download from the current `v1.8.0` URL, a matching API digest, or a before/after metadata comparison alone does **not** falsify this finding.

## 5. Corrective actions registered

- EGIS-FM-008 now classifies `v1.8.0` as rejected for artifact pinning.
- EGIS-FM-009 now withdraws the former PowerShell acquisition procedure and explicitly blocks download/execution of `v1.8.0`.
- The former release metadata values are retained only as a historical observation, not as an approved pin.
- No mirror, cached JAR, rolling build, or SHA-1-only checksum is substituted.
- The next acquisition attempt requires a stable official artifact and independently verifiable provenance.

## 6. Current evidence and non-claims

- Official upstream source identity: VERIFIED.
- Mutable rolling-channel behavior: VERIFIED from official project sources.
- Post-publication asset replacement: REPORTED in official upstream issue #1399.
- Exact historical byte sequence / old and new JAR bytes: NOT_ACQUIRED.
- Independent reproduction of the replacement: NOT_RUN.
- Current `v1.8.0` artifact bytes: NOT_ACQUIRED.
- Local SHA-256 recomputation: NOT_RUN.
- Java provenance: NOT_CAPTURED.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Real TLC output/trace compatibility: NOT_ESTABLISHED.
- Model verification: NOT_ESTABLISHED.
- Production promotion: NOT_APPROVED.

## 7. Safety boundary

Documentation-only correction on the existing PR #475 candidate branch. No merge, deployment, runtime modification, secret/binding/permission change, laptop operation, release download, or model execution was performed.
