# EGIS-FM-008 — TLA+ Tool Artifact Provenance Assessment

**Status:** Source identity verified; release channel rejected for pinning; artifact acquisition BLOCKED; execution NOT_RUN
**Assessment date:** 2026-11-25
**Scope:** Official upstream release identity and artifact provenance for the EGIS SANY/TLC gate
**Parent:** PR #475 — EGIS Verification Gate v1.1.1

## Executive disposition

The official upstream repository is `tlaplus/tlaplus`. Its project documentation identifies this repository as the home of the TLA+ command-line tools and states that the tools require Java 11 or later. The upstream README documents invocation of SANY as `tla2sany.SANY` and TLC as `tlc2.TLC`.

The official GitHub release API currently exposes two relevant candidates:

| Release | Classification | `tla2tools.jar` SHA-256 metadata | Decision |
|---|---|---|---|
| `v1.8.0` | Mutable rolling pre-release; publisher reports `immutable=false` | Publisher digest is mutable and has been superseded historically | REJECTED for artifact pinning or execution |
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

**Critical limitation:** the asset bytes were not downloaded and no digest was recomputed. More importantly, upstream issue #1399 documents that the `v1.8.0` release asset was replaced after publication and its SHA-256 changed. Upstream CI force-updates the `v1.8.0` tag on master builds. The release ID, asset ID, tag, and digest recorded below are therefore a time-bounded observation, not a durable artifact identity. Re-fetching metadata before and after download does not eliminate an ABA replacement window or establish immutability. `v1.8.0` is rejected as a security pin and this runbook must not acquire or execute it.

## Source evidence

1. Upstream project repository: https://github.com/tlaplus/tlaplus
2. Upstream release page: https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0
3. Release metadata endpoint: https://api.github.com/repos/tlaplus/tlaplus/releases/25926686
4. Asset metadata endpoint: https://api.github.com/repos/tlaplus/tlaplus/releases/assets/768714348
5. Tag reference endpoint: https://api.github.com/repos/tlaplus/tlaplus/git/ref/tags/v1.8.0
6. Upstream README: https://github.com/tlaplus/tlaplus#use

The release metadata and asset digest were retrieved from GitHub's official API. GitHub's REST documentation defines the release asset `digest` field as a SHA-256 digest when present: https://docs.github.com/en/rest/releases/assets.

## Acceptance protocol before any real execution

1. **Do not acquire `v1.8.0`**: upstream documents it as a rolling pre-release and its asset has a documented post-publication replacement history.
2. Do not treat a release ID, asset ID, tag name, or API digest as immutable identity unless the upstream release process supplies an enforceable immutable artifact and independent provenance.
3. Select a stable upstream release only after its artifact bytes, publisher checksum/signature, and source/build provenance can be independently reconciled. A SHA-1-only checksum is insufficient for this gate.
4. If no qualifying official artifact exists, leave acquisition BLOCKED. Do not silently substitute a mirror, rolling build, Maven artifact, or locally cached JAR.
5. Before any future acquisition, define a pinned source commit, immutable asset identifier, independent checksum/signature trust root, and a reproducible retrieval record.
6. Only after artifact provenance passes, capture Java vendor, full version, runtime build, executable path, binary digest, OS/architecture, and JVM options.
7. Record the exact model commit, module/config SHA-256, command line, working directory, timeout, exit code, stdout, stderr, and TLC trace artifacts.
8. Run SANY first. Run TLC only if SANY passes.
9. Compare real output and trace files against the validator. Unknown output, missing trace, mismatch, or ambiguous status must be BLOCKED/FAIL, never PASS.
10. Preserve raw metadata, signatures, checksums, execution transcript, and evidence in immutable/attested retention before promotion.

## Hostile review

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-075 | High | Upstream `v1.7.4` release metadata exposes no SHA-256 for `tla2tools.jar`; published SHA-1 is insufficient for the gate's security pin. | Open; do not downgrade the gate to SHA-1. |
| FMH-076 | High | `v1.8.0` is a pre-release and the release API reports `immutable=false`; tag and asset mutability remain a supply-chain risk. | Open; use only for controlled fixture compatibility work, not promotion. |
| FMH-077 | Critical | The official `v1.8.0` asset digest is metadata-only until the actual JAR bytes are retrieved and independently hashed. | Open; artifact NOT_ACQUIRED and digest NOT_RECOMPUTED. |
| FMH-078 | High | No Java runtime identity or provenance has been captured for an actual execution. | Open; capture runtime evidence before SANY/TLC. |
| FMH-079 | High | No real TLC output or counterexample trace has been captured from a qualified immutable release. | Open; validator compatibility remains NOT_ESTABLISHED. |
| FMH-086 | Critical | Official upstream issue #1399 reports that the `v1.8.0` JAR was replaced after publication and its SHA-256 changed; upstream CI force-updates the `v1.8.0` tag. A before/after metadata check cannot prove immutable artifact identity or eliminate an ABA replacement window. | Open; reject `v1.8.0` as a pin and block acquisition/execution pending a stable, independently verifiable artifact. |

## Falsification conditions

This assessment must be rejected or revised if any of the following occurs:
- The official API returns a different release/tag/asset identity or digest.
- The downloaded artifact's SHA-256 differs from the API digest.
- The tag resolves to a different commit during the controlled acquisition window.
- The upstream asset is mutable, replaced, or cannot be tied to immutable build provenance.
- The JAR manifest or runtime behavior contradicts the declared release identity.
- SANY/TLC output differs from the parser's assumed grammar or a trace artifact is incomplete.

## Final status

- Official upstream source: VERIFIED.
- `v1.8.0` release and asset metadata: OBSERVED from official GitHub API; rejected as a durable pin.
- Upstream mutability/replacement evidence: VERIFIED from official project sources.
- Artifact acquisition: BLOCKED; bytes acquired: NO.
- Local SHA-256 recomputation: NOT_RUN.
- Java provenance: NOT_CAPTURED.
- SANY: NOT_RUN.
- TLC: NOT_RUN.
- Real output/trace compatibility: NOT_ESTABLISHED.
- Promotion: NOT_APPROVED.

This assessment is documentation-only. It does not alter the gate implementation, model, configuration, runtime, secrets, bindings, deployment, or main branch.
