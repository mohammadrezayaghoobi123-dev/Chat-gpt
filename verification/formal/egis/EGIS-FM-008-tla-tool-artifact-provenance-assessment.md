# EGIS-FM-008 — TLA+ Tool Artifact Provenance Assessment

**Status:** Source metadata verified; artifact bytes NOT_ACQUIRED; execution NOT_RUN
**Assessment date:** 2026-11-25
**Scope:** Official upstream release identity and artifact provenance for the EGIS SANY/TLC gate
**Parent:** PR #475 — EGIS Verification Gate v1.1.1

## Executive disposition

The official upstream repository is `tlaplus/tlaplus`. Its project documentation identifies this repository as the home of the TLA+ command-line tools and states that the tools require Java 11 or later. The upstream README documents invocation of SANY as `tla2sany.SANY` and TLC as `tlc2.TLC`.

The official GitHub release API currently exposes two relevant candidates:

| Release | Classification | `tla2tools.jar` SHA-256 metadata | Decision |
|---|---|---|---|
| `v1.8.0` | Pre-release; published 2026-11-19 | `fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713` | Preferred controlled-fixture candidate, not production-approved |
| `v1.7.4` | Stable release; published 2024-08-05 | No SHA-256 digest in the release asset API response; release notes publish SHA-1 only | Do not use SHA-1 as the gate's security pin |

For `v1.8.0`, the official release API identifies:
- Release ID: `25926686`
- Tag: `v1.8.0`
- Tag target commit: `bc1b506bdcad80bb518bf3776a9161c34ff0fc4c`
- Release asset ID: `768714348`
- Asset: `tla2tools.jar`
- Asset size: `4510915` bytes
- Asset API digest: `sha256:fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713`
- Official asset URL: `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar`
- Release API reports `prerelease=true` and `immutable=false`.

**Critical limitation:** the asset bytes were not downloaded into the controlled execution environment during this assessment. Therefore the published SHA-256 metadata has been recorded, but the digest has NOT been independently recomputed against downloaded bytes. No artifact authenticity claim or SANY/TLC execution claim is made.

## Source evidence

1. Upstream project repository: https://github.com/tlaplus/tlaplus
2. Upstream release page: https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0
3. Release metadata endpoint: https://api.github.com/repos/tlaplus/tlaplus/releases/25926686
4. Asset metadata endpoint: https://api.github.com/repos/tlaplus/tlaplus/releases/assets/768714348
5. Tag reference endpoint: https://api.github.com/repos/tlaplus/tlaplus/git/ref/tags/v1.8.0
6. Upstream README: https://github.com/tlaplus/tlaplus#use

The release metadata and asset digest were retrieved from GitHub's official API. GitHub's REST documentation defines the release asset `digest` field as a SHA-256 digest when present: https://docs.github.com/en/rest/releases/assets.

## Acceptance protocol before any real execution

1. Retrieve the exact asset by its official release asset ID or official browser download URL; do not use mirrors.
2. Record HTTP status, final URL, retrieval timestamp, byte count, and asset ID.
3. Compute SHA-256 locally over the downloaded bytes and require exact equality with the official API digest above.
4. Independently re-fetch the release and asset metadata and verify tag, release ID, asset ID, name, size, digest, and tag target commit have not changed.
5. Record Java vendor, full version, runtime build, executable path, OS/architecture, and relevant JVM options.
6. Record the exact model commit, module/config SHA-256, command line, working directory, timeout, exit code, stdout, stderr, and TLC trace artifacts.
7. Run SANY first. Run TLC only if SANY passes.
8. Compare real output and trace files against the validator. Any unknown output form, missing trace, mismatch, or ambiguous status must be BLOCKED/FAIL, never PASS.
9. Keep the release classified as a pre-release unless an authorized project decision explicitly accepts that risk. Prefer a stable release for promotion after a stable release exposes an independently verifiable SHA-256.
10. Preserve the raw metadata response and downloaded artifact digest in immutable/attested evidence before promotion.

## Hostile review

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-075 | High | Upstream `v1.7.4` release metadata exposes no SHA-256 for `tla2tools.jar`; published SHA-1 is insufficient for the gate's security pin. | Open; do not downgrade the gate to SHA-1. |
| FMH-076 | High | `v1.8.0` is a pre-release and the release API reports `immutable=false`; tag and asset mutability remain a supply-chain risk. | Open; use only for controlled fixture compatibility work, not promotion. |
| FMH-077 | Critical | The official `v1.8.0` asset digest is metadata-only until the actual JAR bytes are retrieved and independently hashed. | Open; artifact NOT_ACQUIRED and digest NOT_RECOMPUTED. |
| FMH-078 | High | No Java runtime identity or provenance has been captured for an actual execution. | Open; capture runtime evidence before SANY/TLC. |
| FMH-079 | High | No real TLC output or counterexample trace has been captured from the selected release. | Open; validator compatibility remains NOT_ESTABLISHED. |

## Falsification conditions

This assessment must be rejected or revised if any of the following occurs:
- The official API returns a different release/tag/asset identity or digest.
- The downloaded artifact's SHA-256 differs from the API digest.
- The tag resolves to a different commit during the controlled acquisition window.
- The JAR manifest or runtime behavior contradicts the declared release identity.
- SANY/TLC output differs from the parser's assumed grammar or a trace artifact is incomplete.

## Final status

- Official upstream source: VERIFIED.
- `v1.8.0` release and asset metadata: VERIFIED from official GitHub API.
- Asset bytes acquired: NO.
- Local SHA-256 recomputation: NOT_RUN.
- Java provenance: NOT_CAPTURED.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Real output/trace compatibility: NOT_ESTABLISHED.
- Promotion: NOT_APPROVED.

This assessment is documentation-only. It does not alter the gate implementation, model, configuration, runtime, secrets, bindings, deployment, or main branch.
