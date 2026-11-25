# EGIS-FM-009 — Controlled TLA+ Tool Acquisition Runbook

**Status:** Procedure candidate; NOT_EXECUTED
**Date:** 2026-11-25
**Parent:** PR #475 — EGIS Verification Gate v1.1.1
**Scope:** Controlled acquisition and independent byte verification of the official TLA+ Tools JAR; no model execution

## 1. Purpose and safety boundary

This runbook defines a reproducible acquisition procedure for the official TLA+ Tools release asset. It does not execute SANY/TLC, modify the repository runtime, install Java, write secrets, or alter any branch outside this candidate.

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

This is a pre-release. Acquisition is for controlled compatibility testing only; it is not production approval.

## 3. PowerShell acquisition and verification

Run in a new disposable PowerShell session. The commands intentionally fail closed on any metadata or digest mismatch.

```powershell
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$releaseId = 25926686
$assetId = 768714348
$expectedTag = 'v1.8.0'
$expectedCommit = 'bc1b506bdcad80bb518bf3776a9161c34ff0fc4c'
$expectedName = 'tla2tools.jar'
$expectedSize = 4510915L
$expectedSha256 = 'fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713'

$releaseUri = "https://api.github.com/repos/tlaplus/tlaplus/releases/$releaseId"
$assetUri = "https://api.github.com/repos/tlaplus/tlaplus/releases/assets/$assetId"
$headers = @{ 'Accept' = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }

$release = Invoke-RestMethod -Uri $releaseUri -Headers $headers
$asset = Invoke-RestMethod -Uri $assetUri -Headers $headers

if ($release.id -ne $releaseId -or $release.tag_name -ne $expectedTag) { throw 'Release identity mismatch' }
if ($release.prerelease -ne $true) { throw 'Release classification changed' }
if ($release.immutable -ne $false) { throw 'Release immutability metadata changed; reassess before continuing' }
if ($asset.id -ne $assetId -or $asset.name -ne $expectedName) { throw 'Asset identity mismatch' }
if ([int64]$asset.size -ne $expectedSize) { throw 'Publisher asset size mismatch' }
if ($asset.digest -ne "sha256:$expectedSha256") { throw 'Publisher digest metadata mismatch' }
if ($asset.browser_download_url -ne 'https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar') { throw 'Asset URL mismatch' }

$tagRef = Invoke-RestMethod -Uri 'https://api.github.com/repos/tlaplus/tlaplus/git/ref/tags/v1.8.0' -Headers $headers
if ($tagRef.object.sha -ne $expectedCommit) {
    throw "Tag ref object changed or is annotated; resolve and verify the peeled commit independently before proceeding"
}

$workDir = Join-Path $env:TEMP ('egis-tla-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null
$jarPath = Join-Path $workDir 'tla2tools.jar'
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $jarPath

$file = Get-Item -LiteralPath $jarPath
if ([int64]$file.Length -ne $expectedSize) { throw 'Downloaded byte count mismatch' }
$actualSha256 = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) { throw 'Downloaded artifact SHA-256 mismatch' }

# Re-fetch publisher metadata after download to detect release/asset mutation during acquisition.
$releaseAfter = Invoke-RestMethod -Uri $releaseUri -Headers $headers
$assetAfter = Invoke-RestMethod -Uri $assetUri -Headers $headers
$tagRefAfter = Invoke-RestMethod -Uri 'https://api.github.com/repos/tlaplus/tlaplus/git/ref/tags/v1.8.0' -Headers $headers
if ($tagRefAfter.object.sha -ne $tagRef.object.sha -or $tagRefAfter.object.type -ne $tagRef.object.type) { throw 'Post-download tag reference changed' }
if ($releaseAfter.id -ne $releaseId -or $releaseAfter.tag_name -ne $expectedTag) { throw 'Post-download release identity changed' }
if ($releaseAfter.prerelease -ne $true -or $releaseAfter.immutable -ne $false) { throw 'Post-download release classification changed' }
if ($assetAfter.id -ne $assetId -or $assetAfter.name -ne $expectedName) { throw 'Post-download asset identity changed' }
if ([int64]$assetAfter.size -ne $expectedSize -or $assetAfter.digest -ne "sha256:$expectedSha256") { throw 'Post-download publisher digest metadata changed' }
if ($assetAfter.browser_download_url -ne $asset.browser_download_url) { throw 'Post-download asset URL changed' }

$javaCommand = Get-Command java -ErrorAction Stop
$javaVersion = (& $javaCommand.Source -version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Java version command failed' }

[pscustomobject]@{
    ReleaseId = $release.id
    Tag = $release.tag_name
    TagObjectSha = $tagRef.object.sha
    AssetId = $asset.id
    AssetName = $file.Name
    ByteCount = $file.Length
    ExpectedSha256 = $expectedSha256
    ActualSha256 = $actualSha256
    JavaExecutable = $javaCommand.Source
    JavaVersion = $javaVersion
    RetrievedUtc = (Get-Date).ToUniversalTime().ToString('o')
    ArtifactPath = $jarPath
} | ConvertTo-Json -Depth 5
```

**Important tag check:** the script above deliberately stops if the Git ref object SHA is not the recorded commit. If GitHub returns an annotated tag object, do not weaken or remove the check; resolve the tag object through the official Git database API, verify its peeled commit equals the pinned commit, then rerun with an independently reviewed adaptation.

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

Stop and classify acquisition as FAIL or BLOCKED if:
- release ID, tag, asset ID, asset name, URL, byte count, digest, or tag target differs;
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
| FMH-080 | High | Release is a mutable pre-release; publisher metadata can change. | Open; re-fetch metadata immediately before and after download; do not promote this release. |
| FMH-081 | High | Git tag API may return an annotated tag object rather than a commit SHA. | Explicit stop condition; require peeled commit verification; never silently accept a different SHA. |
| FMH-082 | High | Publisher digest and locally downloaded bytes share a publisher trust root; matching hashes are not independent publisher authenticity. | Open; seek independent signed checksum/provenance or trusted third-party attestation before production approval. |
| FMH-083 | Medium | PowerShell command transcript and host identity are not automatically sealed or signed by this runbook. | Open; capture and attest evidence separately. |
| FMH-084 | High | Java executable discovery alone does not establish vendor provenance or runtime integrity. | Open; capture vendor, full build, binary digest, and trusted distribution provenance. |
| FMH-085 | High | A release tag reference could move between pre-download validation and post-download validation. | Fixed in procedure: compare tag-ref object SHA and type before and after acquisition; annotated-tag ambiguity remains a stop condition. |

## 7. Current execution status

- Runbook authored: YES.
- Acquisition executed: NO.
- JAR bytes acquired: NO.
- Local SHA-256 recomputation: NOT_RUN.
- Java runtime identity: NOT_CAPTURED.
- SANY/TLC: NOT_RUN.
- Model verification: NOT_ESTABLISHED.
- Production promotion: NOT_APPROVED.

This document is a procedure candidate only. No external artifact has been downloaded and no executable code has been run.
