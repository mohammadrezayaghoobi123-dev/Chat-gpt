# R1-U19 — ICU4J 79.1 GitHub Attestation and Release-Run Audit

Date: 2026-11-16
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Baseline main: 919b19ca3d3887352cdef06b03c668ead04fbce7
Previous audit: R1-U18
Scope: read-only inspection of public GitHub release metadata, workflow definition, workflow run/job status and decoded job logs; documentation-only change in the integration branch.
Verdict: PARTIAL PASS — SUCCESSFUL RELEASE EXECUTION AND SIGSTORE ATTESTATION EVENT OBSERVED; EXACT JAR SUBJECT MEMBERSHIP AND SIGNER IDENTITY NOT YET VERIFIED.

## 1. Executive summary

R1-U19 found a second publisher-side provenance channel in addition to detached GPG signatures: GitHub Artifact Attestations using Sigstore.

The official ICU release workflow run is:
- Repository: `unicode-org/icu`
- Run ID: `39799778434`
- Workflow: `Release - All ICU`
- Event: `workflow_dispatch`
- Branch: `maint/maint-79`
- Head commit: `ddc6b66926bfac6036144ca9902992a0d6d50af9`
- Created: `2026-10-22T14:54:04Z`
- Updated: `2026-10-22T15:14:31Z`
- Conclusion: `success`
- Inputs recorded in the job log: `runTests=true`, `deployToMaven=true`, `gitReleaseTag=release-79.1`.

The release run contains successful jobs for:
- `call-release-icu4j-maven / publish` — job ID `119896867097`;
- `call-release-check-sign / sign_and_checksums` — job ID `119906177634`.

The ICU4J publish job reports all relevant steps completed successfully, including tests, Maven deployment, release-folder preparation, release upload, and artifact attestation. The signing/checksum job also completed successfully.

## 2. Pinned workflow evidence

Workflow file:
- Path: `.github/workflows/release-icu4j-maven.yml`
- Source commit: `ddc6b66926bfac6036144ca9902992a0d6d50af9`
- Blob SHA: `56df374af999744799ef205e3043514318a1c75d`

The workflow:
1. Configures JDK 11 and imports the GPG private key from the release environment secret.
2. Runs Maven tests.
3. Executes Maven deploy with profile `with_sources,with_javadoc,with_signature,to_sonatype`.
4. Prepares release files by copying Maven artifacts from the local Maven repository into `releaseDist`.
5. Uploads the release folder as an Actions artifact.
6. Uploads the same release-folder files to the GitHub release.
7. Runs `actions/attest` against `releaseDist`.

The workflow's comment states that the JARs uploaded to GitHub are binary-identical to the JARs in Maven Central. This is an implementation intention and a workflow assertion; it is not a substitute for an independent byte-for-byte comparison of the two published JARs.

## 3. Run and job results

The Actions run metadata reports `success`. The job inventory reports:
- ICU4J publish job: completed / success.
- `Run tests`: completed / success.
- `Build and deploy to Maven Central`: completed / success.
- `Prepare release folder`: completed / success.
- `Upload build results`: completed / success.
- `Upload to release`: completed / success.
- `Generate artifact attestation`: completed / success.
- `sign_and_checksums`: completed / success.

The job log records:
- Maven deployment input was `true`.
- The GPG Maven plugin ran in the `icu4j` module and logged: `Signer 'gpg' is signing 4 files with key default`.
- The Actions artifact `icu4j-binaries.zip` was uploaded with SHA-256 `13c24f8053d7f805d217a1ca298d68039d29c16de1ebdeb69dee8c3aaab8d39d`.
- This SHA-256 is for the Actions ZIP artifact, not the standalone `icu4j-79.1.jar`.
- The attestation step logged `Attestation type: Build Provenance`, `Attestation created for 6 subjects`, signature using a certificate from the Public Good Sigstore instance, upload to the Rekor transparency log, and upload to the repository.
- The job log linked the resulting attestation page: `https://github.com/unicode-org/icu/attestations/58685810`.

The release-check-sign job separately completed the step `Checksums and sign` successfully. R1-U18 already established from the pinned workflow source that its `SHASUM512.txt` is scoped to `icu4c*`, while the ICU4J JAR is listed in the `*.md5` manifest.

## 4. What this proves — and what it does not

### Supported by retrieved evidence

- The official release workflow was dispatched against the pinned release commit.
- The run inputs enabled tests and Maven Central deployment.
- The ICU4J publish job and release checksum/sign job concluded successfully.
- The workflow executed the GPG signing plugin in the ICU4J module.
- The release folder was submitted to the GitHub Artifact Attestation action.
- The action reported six attested subjects and successful Sigstore/Rekor/repository publication.

### Not established

- The six-subject attestation's exact subject list was not retrieved in this audit.
- It is therefore not yet established that the standalone JAR SHA-256 `28b292e60d0d00c496bae88a15b2615f89f781be13670aeac9dc90f189570e07` is one of those six subjects.
- The Sigstore certificate identity, issuer, workflow identity claims and exact predicate for the JAR subject were not independently decoded or validated.
- The GPG plugin log says it signed four files in the ICU4J module, but does not identify those four filenames or expose the key fingerprint.
- The GPG signer identity/subkey and its validity/revocation state at signing time remain unknown.
- No detached signature was cryptographically verified against local JAR bytes.
- No Maven Central versus GitHub byte-for-byte comparison was performed.

A successful workflow and attestation action are not equivalent to independently verifying a specific artifact's provenance. The exact subject digest and authenticated workflow identity must be checked.

## 5. Revised R1-U20 verification path

Use both provenance channels without conflating them:

### Channel A — Sigstore/GitHub Artifact Attestation
1. Acquire the exact GitHub release JAR bytes and compute SHA-256 locally.
2. Verify that the digest equals the release API digest already recorded in R1-U18.
3. Run GitHub CLI attestation verification against the exact JAR and repository `unicode-org/icu`, pinned to the release workflow identity.
4. Confirm the subject digest equals the local JAR digest.
5. Inspect the signed SLSA provenance predicate: source repository, source ref/commit, workflow path and immutable workflow revision.
6. Verify the certificate issuer and identity claims against the expected GitHub Actions workflow.
7. Confirm the attestation's transparency-log inclusion/verification.
8. Do not accept a valid attestation for the ZIP container as a substitute for a JAR subject attestation unless the ZIP is independently unpacked and the JAR digest is tied to the verified subject contents.

### Channel B — GPG detached signature
1. Acquire the exact `icu4j-79.1.jar.asc` and JAR bytes.
2. Acquire the exact release `KEYS` blob and candidate public keys.
3. Verify the detached signature in an isolated temporary GPG home.
4. Record the actual signing primary-key and signing-subkey fingerprints from machine output.
5. Check key binding, revocation, expiry and validity at the signing timestamp.
6. Compare the actual signer against independently corroborated key fingerprints; do not expand the trust set based only on the signature's key ID.
7. Independently verify the signed `icu4j-79.1.md5` sidecar as a publisher consistency check; MD5 is not a security trust anchor.

### Cross-channel and distribution comparison
1. Independently download from GitHub release and Maven Central.
2. Compute SHA-256 locally for both.
3. Require byte identity (same SHA-256 and preferably byte comparison).
4. Compare the local GitHub JAR SHA-256 with the GitHub API digest.
5. Record each source URL, retrieval timestamp, byte length, SHA-256, and verification command/output.

## 6. Falsification rules

Mark the artifact `DISPUTED` or `FAIL` if:
- a JAR attestation is absent, invalid, or has a subject digest different from the local JAR;
- the attestation's source/workflow identity does not match the expected ICU release workflow and pinned source revision;
- the GPG detached signature fails;
- the signer fingerprint is not independently authenticated or key validity fails;
- Maven Central and GitHub release JAR bytes differ without an independently established explanation;
- local SHA-256 differs from the GitHub API digest without an independently verified explanation.

If the attestation page is valid but only attests a ZIP subject, do not claim that the JAR itself has a direct attestation. A separate reproducible extraction-and-subject-binding procedure is required.

## 7. Evidence state

| Claim | State |
|---|---|
| Release run exists and targets pinned commit | SUPPORTED |
| runTests=true and deployToMaven=true | SUPPORTED |
| ICU4J publish job succeeded | SUPPORTED |
| release checksum/sign job succeeded | SUPPORTED |
| GPG plugin ran in ICU4J module | SUPPORTED |
| Sigstore attestation action succeeded | SUPPORTED |
| Six attestation subjects reported | SUPPORTED |
| Exact JAR digest is among the six subjects | UNKNOWN |
| Sigstore identity/predicate independently verified | NOT RUN |
| GPG signing fingerprint established | UNKNOWN |
| JAR detached GPG signature verified | NOT RUN |
| Local JAR bytes acquired and hashed | NOT RUN |
| Maven Central/GitHub byte comparison | NOT RUN |
| Artifact authenticity | UNKNOWN / BLOCKED |

## 8. Scope protection

- No binary downloaded or executed.
- No GPG keys imported or secrets accessed.
- No repository code, dependencies, workflows, policies or tests changed.
- Documentation-only addition to the existing integration branch.
- No PR creation/update, merge, deployment, Cloudflare, Supabase, or laptop operation.
- Main remains protected at its fixed baseline.

R1-U19 verdict: PARTIAL PASS. A successful release workflow and a Sigstore provenance event have been independently observed in public job metadata/logs. Exact JAR-subject membership, signer identities, direct cryptographic verification, and distribution byte equality remain UNKNOWN / NOT RUN. ICU4J 79.1 is not yet approved as an authenticated runtime dependency.
