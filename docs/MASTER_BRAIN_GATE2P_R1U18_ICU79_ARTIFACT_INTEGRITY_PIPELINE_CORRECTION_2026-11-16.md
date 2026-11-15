# R1-U18 — ICU4J 79.1 Artifact-Integrity Pipeline Correction

Date: 2026-11-16
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Parent branch head before this document: 3082b80fbaf71685827ba63de882c3d93083b96f
Fixed main baseline: 919b19ca3d3887352cdef06b03c668ead04fbce7
Parent: R1-U17
Status: PARTIAL PASS — RELEASE WORKFLOW AND ASSET INVENTORY RECONCILED; BINARY SIGNATURE VERIFICATION BLOCKED / NOT RUN
Scope: read-only public-source inspection plus documentation-only report. No binary execution, no source/dependency/test/workflow changes, no PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Executive finding

R1-U17's proposed verification step 8 incorrectly required the ICU4J JAR's SHA-512 to appear in `SHASUM512.txt`. Inspection of the exact release-signing workflow at ICU release commit `ddc6b66926bfac6036144ca9902992a0d6d50af9` disproves that assumption.

The workflow creates:
- `SHASUM512.txt` from `sha512sum -b icu4c*` only;
- `icu4j-${github_rel_version}.md5` from `md5sum -b *.jar`;
- detached ASCII GPG signatures for every file in the release staging directory after these checksum files are created.

Therefore, `SHASUM512.txt` is not the JAR checksum manifest. For ICU4J 79.1, the relevant publisher-side verification chain is:
1. Verify `icu4j-79.1.jar.asc` against the exact JAR bytes and an independently authenticated signing key.
2. Verify `icu4j-79.1.md5.asc` against the exact `icu4j-79.1.md5` bytes.
3. Parse the signed MD5 manifest and compare its JAR entry with a locally computed MD5 (weak hash; use only as a publisher-manifest consistency check, never as the security trust anchor).
4. Independently compute SHA-256 for the JAR and compare it with the GitHub release API asset digest.
5. Compare Maven Central and GitHub JAR bytes.
6. Keep the artifact's authenticity decision dependent on the detached signature and authenticated signer, not MD5 or GitHub's API digest alone.

The `SHASUM512.txt` and `SHASUM512.txt.asc` remain useful to verify the ICU4C files covered by that manifest, but they do not establish the ICU4J JAR's SHA-512.

## 2. Exact workflow evidence

Pinned source:
- Repository: `unicode-org/icu`
- Release commit: `ddc6b66926bfac6036144ca9902992a0d6d50af9`
- Workflow: `.github/workflows/release-check-sign.yml`
- Workflow blob SHA: `5a17d5da0e309e5b49e6afaa4f941b1336a5693b`

The `Checksums and sign` step contains the operative commands:

```bash
sha512sum -b icu4c*              > SHASUM512.txt
md5sum -b *.jar                  > icu4j-${github_rel_version}.md5
md5sum -b icu4c-*-data-bin-*.zip > icu4c-${github_rel_version}-binary.md5
md5sum -b icu4c-*-sources.*      > icu4c-${github_rel_version}-sources.md5
find . -type f -exec gpg --no-tty --batch --pinentry-mode loopback --passphrase=$MAVEN_GPG_PASSPHRASE -a --output {}.asc --detach-sig {} \\;
```

The subsequent upload step uploads the generated `*.md5`, `*.asc`, and `SHASUM512.txt` files. The workflow uses the `release-env` environment, obtains the GPG private key through the `MAVEN_GPG_PRIVATE_KEY` secret in setup-java, and uses `MAVEN_GPG_PASSPHRASE` for signing. This is workflow configuration evidence; it does not expose or establish the value or custody of either secret.

## 3. Release asset metadata reconciliation

Pinned release:
- Release tag: `release-79.1`
- Release ID: `417728424`
- Published: `2026-10-22T15:46:21Z`
- API reports `immutable=false`.

GitHub release API asset metadata currently reports:

| Asset | Size | API SHA-256 |
|---|---:|---|
| `icu4j-79.1.jar` | 15,257,985 | `28b292e60d0d00c496bae88a15b2615f89f781be13670aeac9dc90f189570e07` |
| `icu4j-79.1.jar.asc` | 228 | `087a485aafe1337e040e70ff127ef4e7fbbe1fc5d3a6c2b7f64b7062840f2c5a` |
| `icu4j-79.1.md5` | 411 | `fcedce35e2cd6e5c250dfc92c4fff9a9d0cf0cae5df9c11b8825e962f696ae09` |
| `icu4j-79.1.md5.asc` | 228 | `46c9d8640561eedc80762bd57bcf1204425f5fcfa46a1398eb5ee73b84359fb8` |
| `SHASUM512.txt` | 1,726 | `8c7a56f1d0a77c2c18bd877d4f32acb33bcffdde9154b63156a80e9841eab565` |
| `SHASUM512.txt.asc` | 228 | `1baae16e1aa435a9a6d591da196ae6d076d93818c1da0e7138e97d6d67b47756` |

These are GitHub API-provided asset metadata digests, not locally recomputed hashes. They must not be represented as independent byte-level verification.

## 4. Correction to R1-U17 verification plan

Supersede R1-U17 item 8 with:
- Verify the exact `icu4j-79.1.md5.asc` detached signature over `icu4j-79.1.md5`.
- Confirm the signed manifest names `icu4j-79.1.jar` and its MD5 matches a locally computed MD5.
- Verify `icu4j-79.1.jar.asc` directly against the exact JAR bytes.
- Independently compute SHA-256 and compare with the release API digest.
- Compare exact JAR bytes from GitHub release and Maven Central.
- Do not use MD5 as an authenticity primitive or substitute it for the direct JAR signature.

The JAR's detached signature is the direct cryptographic evidence. The signed MD5 sidecar is an additional publisher-process consistency check. The GitHub API digest is an additional independent transport/release-metadata comparison, but the release is not immutable and the digest is supplied by the same GitHub release service.

## 5. Binary acquisition and verification status

The release asset inventory and exact download URLs were obtained through GitHub's public release API. In this execution environment, the GitHub connector's fetch endpoint returns UTF-8 text only and does not support binary asset downloads. Web open attempts for the binary/signature endpoints returned DisabledError. Consequently:
- exact JAR bytes: NOT ACQUIRED;
- exact `.asc` signature bytes: NOT ACQUIRED;
- exact MD5 sidecar bytes: NOT ACQUIRED;
- exact `SHASUM512.txt` bytes: NOT ACQUIRED;
- local SHA-256/MD5/SHA-512 recomputation: NOT RUN;
- GPG signature verification: NOT RUN;
- Maven Central byte comparison: NOT RUN.

This is a tooling/acquisition blocker, not evidence of a bad signature or a corrupt artifact. No authenticity PASS or FAIL is inferred.

## 6. Falsification and decision rules

Set `ARTIFACT_AUTHENTICITY=FAIL` or `DISPUTED` if:
- the direct JAR detached signature fails;
- the signer key/subkey fingerprint is not independently authenticated;
- key binding, revocation, expiry, or validity at signing time fails;
- the signed MD5 sidecar signature fails;
- the signed sidecar does not name the expected JAR or its MD5 differs from the locally computed JAR MD5;
- the JAR's local SHA-256 differs from the release API digest without an independently verified explanation;
- Maven Central and GitHub release JAR bytes differ without an approved explanation.

A mismatch between the JAR and `SHASUM512.txt` is not a valid failure condition because the pinned workflow does not put JARs in that file.

## 7. Evidence matrix

| Claim | Result |
|---|---|
| Pinned workflow generates SHA-512 manifest from `icu4c*` only | SUPPORTED |
| Pinned workflow generates MD5 manifest from `*.jar` | SUPPORTED |
| Pinned workflow detached-signs every file in staging directory | SUPPORTED |
| Release API lists JAR and direct detached signature | SUPPORTED |
| Release API lists ICU4J MD5 sidecar and detached signature | SUPPORTED |
| JAR bytes locally acquired | NOT RUN |
| Direct JAR detached signature verified | NOT RUN |
| Signed MD5 sidecar verified | NOT RUN |
| JAR SHA-256 independently recomputed | NOT RUN |
| Maven Central and GitHub bytes compared | NOT RUN |
| Actual signer of ICU4J 79.1 established | UNKNOWN |
| Artifact authenticity | UNKNOWN / BLOCKED |

## 8. Scope and branch protection

- Documentation-only report.
- No workflow or executable code changed.
- No artifact executed.
- No secrets accessed.
- No PR created or updated.
- No merge or deployment.
- No main-branch change.
- The existing integration branch is the only target.

R1-U18 verdict: PARTIAL PASS. The publisher's actual artifact-integrity workflow has been inspected and a material false assumption in R1-U17 has been corrected. Binary acquisition and cryptographic verification remain BLOCKED / NOT RUN. ICU4J 79.1 must not yet be approved as an authenticated runtime dependency.
