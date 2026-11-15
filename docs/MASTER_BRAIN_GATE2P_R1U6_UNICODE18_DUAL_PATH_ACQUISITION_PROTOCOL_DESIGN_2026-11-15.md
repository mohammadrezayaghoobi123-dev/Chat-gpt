# R1-U6 — Unicode 18.0.0 Dual-Path Acquisition Protocol (Design Only)

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Scope: normative acquisition design only; no workflow YAML, scripts, tests, downloads, or execution.

## 1. Purpose

Define a reproducible and fail-closed method to acquire the nine required Unicode 18.0.0 UCD source files as exact byte sequences, then verify each direct-file download against the corresponding entry in the official versioned UCD archive.

This document is a design proposal. It does not claim acquisition, source integrity, or test completion.

## 2. New authoritative distribution evidence

Official Unicode sources establish:
- The Unicode 18.0.0 versioned UCD directory is `https://www.unicode.org/Public/18.0.0/ucd/`.
- The directory contains a versioned `UCD.zip` archive.
- The Unicode Standard's UAX #44 states that version-numbered release directories are stable, archived permanently, and unchanged after publication.
- The official Unicode 18.0.0 release page lists the component files that form the release.

Official references:
- UCD directory index: https://www.unicode.org/Public/18.0.0/ucd/
- UCD.zip directory listing: https://www.unicode.org/Public/18.0.0/ucd/?C=N%3BO%3DD
- Unicode 18.0.0 release page: https://www.unicode.org/versions/Unicode18.0.0/
- UAX #44: https://www.unicode.org/reports/tr44/

The official archive creates a second distribution representation (individual file endpoint versus ZIP member). Both are served by the Unicode Consortium and therefore are not independent organizational trust anchors. Their byte-for-byte agreement is useful for detecting transfer, path, truncation, and packaging discrepancies, but it must not be described as independent publisher corroboration.

## 3. Fixed nine-file inventory

The acquisition manifest must contain exactly these paths relative to the UCD root:

1. `ReadMe.txt`
2. `PropList.txt`
3. `DerivedCoreProperties.txt`
4. `DerivedAge.txt`
5. `extracted/DerivedGeneralCategory.txt`
6. `UnicodeData.txt`
7. `CaseFolding.txt`
8. `DerivedNormalizationProps.txt`
9. `NormalizationTest.txt`

Do not add or remove a file silently. Any inventory change requires a versioned manifest revision and owner approval.

## 4. Proposed acquisition algorithm

For each file:
1. Construct only the fixed versioned HTTPS URL; do not use `latest`, redirects to a different release, or user-supplied URLs.
2. Require successful TLS validation and HTTP 200.
3. Record the requested URL, final URL after redirects, HTTP status, content type, response headers relevant to caching/encoding, and acquisition timestamp.
4. Read the response entity body as bytes. Do not decode and re-encode before calculating integrity values.
5. Enforce per-file and aggregate size ceilings before accepting the body.
6. Calculate SHA-256 and exact byte length over the exact response bytes.
7. Validate the expected file header/version marker where the file format provides one.
8. Preserve a temporary immutable byte buffer for comparison; do not publish raw contents in workflow logs.
9. Extract the same relative path from the official `UCD.zip` archive.
10. Compare direct-download bytes and ZIP-member bytes exactly; reject any mismatch.
11. Recalculate the SHA-256 over the ZIP member and require equality with the direct-file digest.
12. Emit a deterministic manifest sorted by normalized relative path, containing path, release, exact byte length, SHA-256, URL, HTTP metadata, and cross-representation equality result.

No digest is accepted if the download was decoded, newline-normalized, Unicode-normalized, truncated, or otherwise transformed before hashing.

## 5. ZIP validation requirements

Before extracting any member:
- Validate ZIP central directory structure.
- Reject absolute paths, drive prefixes, backslashes, parent traversal segments, duplicate member paths, case-fold collisions, and unexpected symlink entries.
- Select only the nine exact allowlisted relative paths.
- Reject missing or duplicate required members.
- Do not extract arbitrary archive members to a filesystem path.
- Enforce compressed and uncompressed size ceilings and compression-ratio limits.
- Compare bytes in memory or through safely created temporary files under a dedicated ephemeral directory.

A ZIP archive is an untrusted container until these structural checks pass, even though the URL is official.

## 6. Minimal workflow design constraints

If separately authorized, the workflow should:
- use only `ubuntu-24.04` standard GitHub-hosted runner;
- have a strict timeout (10 minutes target);
- use `permissions: {}` because no repository API operation is required;
- avoid checkout, third-party actions, package installation, caches, and artifacts;
- use Python standard library only;
- never reference `secrets`, `GITHUB_TOKEN`, Cloudflare, or Supabase;
- never write to the repository or create a PR;
- print only bounded integrity metadata, never file contents or environment variables;
- use a fixed branch trigger on the integration branch, with a narrow path filter;
- set concurrency to avoid accidental overlapping runs;
- fail closed on any transport, parsing, header, path, size, digest, or byte-equality discrepancy.

A new branch-only workflow with `workflow_dispatch` must not be assumed manually dispatchable: GitHub requires the workflow file to exist on the default branch for that event. Do not change `main` to enable manual dispatch. A branch-specific push trigger is the only candidate considered here, and adding it requires explicit owner authorization because it creates executable automation and an automatic run.

## 7. Evidence output contract

A successful run may emit a manifest with:
- `unicode_version`
- `source_root`
- `archive_url`
- `acquired_at_utc`
- `files[]`: `relative_path`, `requested_url`, `final_url`, `http_status`, `content_type`, `byte_length`, `sha256`, `direct_vs_zip_equal`, `header_validation`
- `overall_status`

No raw source bytes should be committed to Git or placed in public artifacts. The public repository and its logs are visible to anyone. The manifest is integrity metadata, not a signed publisher attestation.

## 8. Independent verification boundary

Direct-file versus UCD.zip equality is a same-publisher cross-representation check, not an independent source-of-truth check.

For stronger corroboration, a second reviewer or independently operated acquisition environment should:
- download the same versioned official release independently;
- recompute all nine SHA-256 values and byte lengths;
- compare the manifest without trusting the first runner's output;
- document its environment, acquisition path, timestamp, and tool versions.

A community mirror may be used only as corroborating evidence after its exact upstream provenance and immutable revision are established. A mirror must never silently replace the official Unicode Consortium source.

## 9. Falsification and rejection conditions

Reject the acquisition if:
- the requested URL or final URL is not within the exact versioned Unicode 18.0.0 source root;
- HTTP status is not 200 or TLS validation fails;
- any expected version header is absent or contradictory;
- a file is empty, truncated, exceeds its size ceiling, or has an unexpected content type;
- direct-file bytes differ from the matching ZIP member;
- ZIP structure includes unsafe or ambiguous paths or duplicate members;
- repeated independent acquisition yields a different digest or byte length;
- the generated manifest is nondeterministic for identical source bytes.

A mismatch is a failure requiring investigation, not a reason to choose whichever source is convenient.

## 10. Current status and required authorization

**R1-U6 status: DESIGN PROPOSED — NOT IMPLEMENTED / NOT RUN.**

Known:
- GitHub Actions is enabled on the public repository.
- Standard GitHub-hosted runners on public repositories are eligible for free use.
- The latest R1-U5 documentation commit's existing Full History Secret Scan completed successfully.
- The official versioned UCD directory and UCD.zip are discoverable.

Unknown / not established:
- exact raw bytes, byte lengths, and SHA-256 values for the nine files;
- byte-for-byte equality between individual downloads and ZIP members;
- any independent second-environment reproduction;
- parser/manifest generation tests;
- R1-G independent review;
- complete SR-02 profile freeze.

No workflow, script, code, secret, PR, merge, deployment, or main-branch change is authorized by this design document. The next action that changes behavior is creation of a branch-scoped workflow; it requires a separate explicit owner authorization.
