# R1-U20 — ICU4J 79.1 Attestation Subject and Artifact Availability Audit

Date: 2026-11-16
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Baseline main: 919b19ca3d3887352cdef06b03c668ead04fbce7
Previous audit: R1-U19
Scope: read-only GitHub Actions run/artifact metadata and connector retrieval attempts; documentation-only addition.
Verdict: PARTIAL PASS — RUN ARTIFACT INVENTORY RECONCILED; ICU4J BUILD ZIP IS NOT CURRENTLY RETRIEVABLE; ATTESTATION SUBJECT DETAILS REMAIN UNKNOWN.

## 1. Objective

Determine whether the ICU4J release-build artifact and the Sigstore attestation subject data observed in R1-U19 can be retrieved from the original GitHub Actions run, rather than inferring subject membership from a successful attestation log line.

## 2. Pinned run identity

- Repository: `unicode-org/icu`
- Run ID: `39799778434`
- Workflow: `Release - All ICU`
- Head commit: `ddc6b66926bfac6036144ca9902992a0d6d50af9`
- Branch: `maint/maint-79`
- Run conclusion: `success`
- Run created: `2026-10-22T14:54:04Z`
- Run updated: `2026-10-22T15:14:31Z`

## 3. Artifact upload log versus current artifact inventory

The ICU4J publish job log (job ID `119896867097`) records:
- Upload of Actions artifact `icu4j-binaries.zip`.
- Uploaded size: 24,390,238 bytes.
- Actions artifact SHA-256: `13c24f8053d7f805d217a1ca298d68039d29c16de1ebdeb69dee8c3aaab8d39d`.
- Artifact ID: `12434814884`.
- Artifact download URL recorded in the log: `https://github.com/unicode-org/icu/actions/runs/39799778434/artifacts/12434814884`.

A fresh query of the run's current artifact inventory endpoint:
`GET /repos/unicode-org/icu/actions/runs/39799778434/artifacts`
returned `total_count=4`, containing only:
- `icu4c.WinARM64.run_#7` — ID `12436371721`, digest `sha256:057516deb1ecf609d7f70416d0c76e8a0e7c20cb2328e8ac7102f5c352f6497e`;
- `icuexportdata_output` — ID `12435287414`, digest `sha256:ce6f63cce6b329f83876bd090c7aa0da79200ebaaec53da6674ca107cbc4b331`;
- `icu4c.Win32.run_#7` — ID `12435183509`, digest `sha256:5235e351267967adb25ff94acdbd6f2bdf115daca1d0e10fb55919fd3ddf78bb`;
- `icu4c.Win64.run_#7` — ID `12435148806`, digest `sha256:852a632baf7e05499f7e7198e7171184a1ee392f8dc56ba1c868bc23e976e6fb`.

The listed artifacts report `expired=false` and expiry `2027-01-20T14:54:06Z`. The ICU4J artifact ID `12434814884` is absent from the current run inventory.

A direct attempt through the GitHub connector's workflow-artifact download action for ID `12434814884` returned HTTP 404 Not Found. The direct metadata lookup for that artifact ID was not accepted by the connector's public-endpoint allowlist. These results establish that this connector cannot currently retrieve the artifact by its logged ID; they do not establish why the artifact is absent from the current inventory.

## 4. Sigstore attestation retrieval

R1-U19's ICU4J publish job log records:
- `Attestation type: Build Provenance`;
- `Attestation created for 6 subjects`;
- signing certificate from the Sigstore Public Good instance;
- upload to Rekor transparency log;
- upload to the GitHub repository;
- attestation page ID `58685810`.

Attempts in this audit:
- GitHub connector fetch of the repository attestation subject-digest endpoint was rejected by its public endpoint allowlist.
- Opening the GitHub attestation page through the available web retrieval path returned DisabledError.
- No attestation bundle bytes or decoded predicate were obtained.

Therefore the exact six subject names/digests, subject-to-jar membership, certificate identity, workflow identity claims, and transparency-log proof remain unverified.

## 5. Important distinction

The logged Actions artifact digest `13c24f8053d7f805d217a1ca298d68039d29c16de1ebdeb69dee8c3aaab8d39d` belongs to the uploaded `icu4j-binaries.zip` archive, not directly to `icu4j-79.1.jar`.

It must not be compared as if it were the JAR SHA-256. Even if the ZIP were recovered, it would still be necessary to extract the JAR without executing it, compute the JAR's own digest, and verify whether the attestation includes that digest as a subject or otherwise cryptographically binds the JAR content.

The current GitHub Actions artifact inventory does not expose the ICU4J ZIP. The logged successful upload is historical evidence of a successful upload step, not proof of current retrievability.

## 6. Verification procedure and constraints

Next valid routes:
1. Retrieve the GitHub attestation bundle by the documented repository/subject-digest endpoint using a client that supports that endpoint, then validate its signature, transparency-log inclusion, certificate identity and SLSA provenance predicate.
2. Obtain the JAR directly from the official GitHub release and Maven Central; compute SHA-256 locally for each and compare exact bytes.
3. Obtain the detached GPG signature and exact publisher KEYS material; verify in a fresh isolated GPG home and record primary/subkey fingerprints.
4. If the GitHub Actions ZIP becomes available through a supported route, verify its archive digest, extract only the JAR/signature/checksum files, and compare the extracted JAR byte-for-byte with both distribution sources.
5. Do not infer that an absent artifact was deleted, expired, or malicious without evidence identifying the cause.

The official GitHub documentation states that an attestation's signature, timestamp and signer identity must be cryptographically verified; the GitHub CLI `gh attestation verify` is the supported verification path. A successful attestation-generation step alone is insufficient.

## 7. Evidence matrix

| Claim | State |
|---|---|
| Original release run completed successfully | SUPPORTED |
| Job log recorded successful upload of `icu4j-binaries.zip` | SUPPORTED |
| Logged ZIP artifact digest is the JAR digest | FALSE — different artifact |
| Logged ICU4J ZIP ID appears in current run artifact inventory | FALSE — absent |
| Download of logged ICU4J ZIP ID through connector | BLOCKED — HTTP 404 |
| Current run inventory lists four other artifacts | SUPPORTED |
| Exact cause of ICU4J artifact absence | UNKNOWN |
| Attestation event for six subjects recorded in job log | SUPPORTED |
| Exact six attestation subjects decoded | NOT RUN |
| JAR digest confirmed among attestation subjects | UNKNOWN |
| Sigstore signature/certificate/predicate verified | NOT RUN |
| JAR bytes acquired and hashed locally | NOT RUN |
| GPG detached signature verified | NOT RUN |
| Maven Central and GitHub bytes compared | NOT RUN |
| ICU4J 79.1 artifact authenticity | UNKNOWN / BLOCKED |

## 8. Scope protection

- No artifact bytes downloaded or executed.
- No secrets or private keys accessed.
- No code, dependency, policy, test or workflow changes.
- Documentation-only addition to the existing integration branch.
- No PR creation/update, merge, deployment, Cloudflare, Supabase, or laptop operation.
- Main remains protected at fixed baseline.

R1-U20 verdict: PARTIAL PASS. A meaningful discrepancy between historical artifact-upload logs and the current Actions artifact inventory was detected and documented. The discrepancy blocks recovery through that run's artifact ID but does not imply artifact corruption or signature failure. The Sigstore subject-level and GPG byte-level verifications remain UNKNOWN / NOT RUN. ICU4J 79.1 remains unapproved as an authenticated runtime dependency.
