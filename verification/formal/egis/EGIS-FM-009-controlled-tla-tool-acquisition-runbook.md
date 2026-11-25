# EGIS-FM-009 — Controlled TLA+ Tool Acquisition Runbook

**Status:** BLOCKED / SUPERSEDED FOR v1.8.0; NOT_EXECUTED
**Date:** 2026-11-25
**Parent:** PR #475 — EGIS Verification Gate v1.1.1
**Scope:** Acquisition decision and stop-control for the official TLA+ Tools JAR; no download and no model execution

## 1. Purpose and safety boundary

This runbook is retained as an audit record but its original v1.8.0 acquisition procedure is withdrawn. Official upstream evidence establishes that v1.8.0 is a mutable rolling pre-release and that its JAR was replaced after publication. No download, installation, or execution is authorized by this runbook. It does not modify the repository runtime, install Java, write secrets, or alter any branch outside this candidate.

Use a disposable, isolated runner or workstation directory. Do not commit the JAR. Do not run the procedure from an untrusted pull-request workflow with write permissions or secrets.

## 2. Pinned publisher metadata

| Field | Required value |
|---|---|
| Upstream repository | `tlaplus/tlaplus` |
| Release ID | `25926686` |
| Tag | `v1.8.0` |
| Tag target commit recorded at assessment | `bc1b506bdcad80bb518bf3776a9161c34ff0fc4c` |
| Release classification | Pre-release |
| Release immutable flag | `false` |
| Asset ID | `768714348` |
| Asset name | `tla2tools.jar` |
| Expected byte count | `4510915` |
| Publisher-declared SHA-256 | `fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713` |
| Official asset URL | `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar` |

This is a mutable rolling pre-release with documented asset replacement. **Do not acquire or execute this release.** The pinned metadata below is retained solely to identify the rejected candidate and historical observation.

## 3. Acquisition control — BLOCKED

**Do not run the former PowerShell acquisition script for `v1.8.0`.** It has been withdrawn because its source is a mutable rolling release channel. A successful local hash comparison against the current API digest would prove only that the downloaded bytes matched that publisher-declared digest at one instant. It would not prove durable release identity, and the before/after metadata checks do not eliminate a replacement-and-restore (ABA) window.

Official upstream evidence:

- Release page: https://github.com/tlaplus/tlaplus/releases/tag/v1.8.0 — the project describes this pre-release as a rolling build channel.
- Upstream CI: https://github.com/tlaplus/tlaplus/blob/master/.github/workflows/main.yml — the workflow force-updates the `v1.8.0` tag.
- Upstream issue #1399: https://github.com/tlaplus/tlaplus/issues/1399 — maintainers/users reported that the published `tla2tools.jar` was replaced and its SHA-256 changed.

Acquisition remains BLOCKED until an official stable artifact can be tied to an immutable release/build identity and an independently trusted checksum, signature, or provenance statement. Do not substitute a mirror, rolling channel, SHA-1-only checksum, or cached local JAR.

## 4. Independent verification requirements


A successful local SHA-256 comparison establishes byte equality with the publisher-declared digest at retrieval time. It does not establish:
- that the publisher account or release process was uncompromised;
- that the release is immutable;
- that the Java runtime is trusted;
- that the TLA+ model is correct;
- that SANY/TLC execution is successful;
- that the EGIS implementation conforms to the model.

Preserve the raw release JSON, asset JSON, tag-ref response, command transcript, downloaded JAR digest, Java executable path/version, host OS/architecture, retrieval timestamp, and operator identity in the evidence bundle. Do not publish the JAR into Git.

## 5. Stop conditions

Acquisition is already BLOCKED for `v1.8.0`. For any future candidate, stop and classify acquisition as FAIL or BLOCKED if:
- release ID, tag, asset ID, asset name, URL, byte count, digest, or tag target differs;
- the upstream release is rolling, mutable, or has documented post-publication asset replacement;
- the API omits the digest;
- download fails or the downloaded size differs;
- locally computed SHA-256 differs;
- Java is absent or its version command fails;
- tag resolution is ambiguous;
- evidence capture is incomplete.

Do not substitute a mirror, a different release, SHA-1, an unpinned latest tag, or an undocumented local JAR.

## 6. Hostile review

| ID | Severity | Finding | Disposition |
|---|---|---|---|
| FMH-080 | High | Release is a mutable pre-release; publisher metadata can change. | Open; do not acquire or execute this release. |
| FMH-081 | High | Git tag API may return an annotated tag object rather than a commit SHA. | Explicit stop condition; require peeled commit verification; never silently accept a different SHA. |
| FMH-082 | High | Publisher digest and locally downloaded bytes share a publisher trust root; matching hashes are not independent publisher authenticity. | Open; seek independent signed checksum/provenance or trusted third-party attestation before production approval. |
| FMH-083 | Medium | PowerShell command transcript and host identity are not automatically sealed or signed by this runbook. | Open; capture and attest evidence separately. |
| FMH-084 | High | Java executable discovery alone does not establish vendor provenance or runtime integrity. | Open; capture vendor, full build, binary digest, and trusted distribution provenance. |
| FMH-086 | Critical | Official upstream issue #1399 documents post-publication replacement of the `v1.8.0` JAR and a changed SHA-256; upstream CI force-updates the release tag. | Open; withdraw the acquisition script and block `v1.8.0` pending immutable artifact provenance. |
| FMH-085 | High | A release tag reference could move between pre-download validation and post-download validation. | Partially mitigated by before/after checks, but those checks do not establish immutability or eliminate an ABA replacement window. |

## 7. Current execution status

- Runbook authored: YES.
- Acquisition executed: NO.
- Acquisition status for `v1.8.0`: BLOCKED / WITHDRAWN.
- JAR bytes acquired: NO.
- Local SHA-256 recomputation: NOT_RUN.
- Java runtime identity: NOT_CAPTURED.
- SANY/TLC: NOT_RUN.
- Model verification: NOT_ESTABLISHED.
- Production promotion: NOT_APPROVED.

This document is a procedure candidate only. No external artifact has been downloaded and no executable code has been run.
