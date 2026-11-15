# R1-U15 — ICU4J 79.1 Release Artifact Provenance Reconciliation
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: PARTIAL PASS — RELEASE ASSET IDENTITY AND DIGEST METADATA VERIFIED — SIGNATURE VERIFICATION NOT RUN — NO ARTIFACT EXECUTION
Parent: R1-U14
Scope: read-only public release metadata reconciliation and documentation only. No binary download, execution, dependency change, source code, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Executive decision

R1-U15 improves the provenance evidence materially. The official GitHub release API for unicode-org/icu release-79.1 exposes:
- release tag `release-79.1`, title `ICU 79.1`, published 2026-10-22T15:46:21Z;
- tag reference resolving directly to commit `ddc6b66926bfac6036144ca9902992a0d6d50af9`;
- release asset `icu4j-79.1.jar`, 15,257,985 bytes, GitHub asset digest `sha256:28b292e60d0d00c496bae88a15b2615f89f781be13670aeac9dc90f189570e07`;
- detached signature asset `icu4j-79.1.jar.asc`, 228 bytes, GitHub asset digest `sha256:087a485aafe1337e040e70ff127ef4e7fbbe1fc5d3a6c2b7f64b7062840f2c5a`;
- `SHASUM512.txt`, 1,726 bytes, GitHub asset digest `sha256:8c7a56f1d0a77c2c18bd877d4f32acb33bcffdde9154b63156a80e9841eab565`;
- `SHASUM512.txt.asc`, 228 bytes, GitHub asset digest `sha256:1baae16e1aa435a9a6d591da196ae6d076d93818c1da0e7138e97d6d67b47756`;
- Maven Central artifact coordinate `com.ibm.icu:icu4j:79.1`.

Critical distinction: GitHub's asset `digest` metadata is useful integrity metadata for the release asset bytes, but it is not the detached PGP signature verification result. The signature files were not retrieved and verified in this stage. The release is explicitly marked `immutable=false`; do not assume the release/tag cannot be changed.

## 2. Immutable identity evidence

### 2.1 Release record

Source endpoint:
`https://api.github.com/repos/unicode-org/icu/releases/tags/release-79.1`

Observed:
- release id: 417728424
- tag: release-79.1
- name: ICU 79.1
- published_at: 2026-10-22T15:46:21Z
- target_commitish: maint/maint-79
- draft: false
- prerelease: false
- immutable: false

The `immutable=false` value is a material provenance limitation. Future evidence locks must record retrieval time and exact asset digests; a tag name alone is not a cryptographic immutable pin.

### 2.2 Git reference and commit

Source endpoint:
`https://api.github.com/repos/unicode-org/icu/git/ref/tags/release-79.1`

Observed:
- ref: refs/tags/release-79.1
- object type: commit
- object SHA: ddc6b66926bfac6036144ca9902992a0d6d50af9

The ref points directly to a commit, not an annotated tag object. Commit API verification metadata reports:
- verified: false
- reason: unsigned
- signature: null

Therefore the release Git commit is NOT cryptographically signed according to GitHub's commit-verification result. This does not invalidate the published release by itself, but it means the tag/commit signature cannot serve as the trust anchor. Artifact detached signatures must be independently verified against a trusted ICU project signing-key fingerprint.

### 2.3 Commit metadata

Commit message:
`ICU-23250 GitHub updated the images to maven 3.10, and the Sonatype publishing plugin fails`

Author timestamp: 2026-10-22T06:49:57Z.
Committer timestamp: 2026-10-22T07:56:31Z.
Full SHA above.

The tag reference and release record agree on the target commit. This proves the current public API mapping at retrieval time, not immutability of the release object.

## 3. Artifact ledger

| Asset | Size (bytes) | GitHub API SHA-256 digest | Status |
|---|---:|---|---|
| icu4j-79.1.jar | 15,257,985 | 28b292e60d0d00c496bae88a15b2615f89f781be13670aeac9dc90f189570e07 | Asset metadata VERIFIED |
| icu4j-79.1.jar.asc | 228 | 087a485aafe1337e040e70ff127ef4e7fbbe1fc5d3a6c2b7f64b7062840f2c5a | Signature asset metadata VERIFIED; signature NOT VERIFIED |
| SHASUM512.txt | 1,726 | 8c7a56f1d0a77c2c18bd877d4f32acb33bcffdde9154b63156a80e9841eab565 | Asset metadata VERIFIED; content not retrieved |
| SHASUM512.txt.asc | 228 | 1baae16e1aa435a9a6d591da196ae6d076d93818c1da0e7138e97d6d67b47756 | Signature asset metadata VERIFIED; signature NOT VERIFIED |

These digests are taken from the GitHub Releases API `assets[].digest` fields. They are not computed locally from downloaded bytes in this audit. They must be labelled publisher-platform metadata, not independently reproduced hashes.

Additional release assets:
- `icu4j-79.1-sources.jar`: 2,665,522 bytes; GitHub API SHA-256 `2e409e1e90b0f23a3921f87eca454131bf0bb9186371e8464b1fa506c3836c09`.
- `icu4j-79.1-javadoc.jar`: 4,221,239 bytes; GitHub API SHA-256 `a4d6b39a62317052060dad84575f4634ad86eccd9a22aafaf5b3f8db7cb25d83`.
- `icu4j-79.1-fulljavadoc.jar`: 4,385,136 bytes; GitHub API SHA-256 `eda9160e93d739f0e94bc9db4c27cd4507844ee002cc26c0f1eda29fa0cd676c`.

## 4. Signature and key verification status

The official ICU release process documentation states that official Maven artifacts are checksummed and digitally signed, and describes the later release step that creates checksum and detached signature files. The ICU release-build documentation identifies an ICU Project PGP key associated with `icuintl@us.ibm.com` and says the key is published to a MIT key server.

However, this stage did NOT:
- retrieve `icu4j-79.1.jar.asc` bytes;
- retrieve `SHASUM512.txt` bytes;
- retrieve `SHASUM512.txt.asc` bytes;
- retrieve the public key from a trusted key source;
- independently validate the key fingerprint with a second trust channel;
- execute GPG verification;
- independently hash the JAR bytes.

Accordingly:
- release asset metadata: VERIFIED;
- detached signature existence in release inventory: VERIFIED;
- signature cryptographic validity: NOT RUN;
- signer identity and key fingerprint: UNKNOWN;
- local artifact SHA-256: NOT RUN;
- Maven Central POM and JAR byte equality with GitHub release assets: NOT RUN.

A 228-byte `.asc` asset must not be treated as verified merely because it exists or has a GitHub digest.

## 5. Retrieval limitations

The GitHub Releases API returned asset names, sizes, and SHA-256 digest metadata. Attempts to retrieve the release-download URLs through the available read-only GitHub connector returned HTTP 404; the web retrieval path returned cache-miss errors. No fallback to unverified mirrors, insecure TLS, or third-party binary mirrors was used.

No binary was downloaded or executed. No paid compute was started. No user secrets or credentials were accessed.

## 6. Falsification and next checks

Before ICU4J can pass artifact authenticity:
1. Retrieve exact JAR, POM, checksum, and detached signature bytes from official publication endpoints.
2. Recompute local SHA-256 and compare with the release API digest and official checksum.
3. Obtain ICU project public key from the published key source; record full fingerprint.
4. Independently confirm fingerprint through a second trusted channel (e.g., official ICU release documentation plus a separately authenticated project key publication).
5. Verify `SHASUM512.txt.asc` and `icu4j-79.1.jar.asc` using GPG in a clean ephemeral environment.
6. Confirm checksum file contains the exact JAR filename and SHA-512; compute SHA-512 from the downloaded JAR and compare.
7. Compare Maven Central JAR bytes to the official release JAR; any mismatch requires explanation and separate approval.
8. Pin all observed bytes by SHA-256 and byte length; do not rely on tag name or mutable release URL alone.

If the tag changes, asset digest changes, signature fails, signer fingerprint is inconsistent, or checksum mismatch occurs, stop and mark ARTIFACT_AUTHENTICITY=FAIL or DISPUTED as appropriate.

## 7. Updated verdict

| Claim | Verdict |
|---|---|
| ICU 79.1 release exists | PASS |
| Release identifies Unicode 18 update | PASS at release-claim level |
| Release tag resolves to full commit SHA | PASS at retrieval time |
| Release commit cryptographically verified | FAIL for GitHub commit signature (reported unsigned) |
| Release object immutable | FAIL / false (immutable=false) |
| ICU4J JAR asset size and API digest metadata | PASS at metadata level |
| Detached signature asset exists | PASS at inventory level |
| Detached signature verifies | NOT RUN |
| Signer key fingerprint independently trusted | UNKNOWN |
| Actual JAR bytes locally rehashed | NOT RUN |
| POM/JAR equivalence across Maven Central and GitHub | NOT RUN |
| Runtime Unicode data version | NOT RUN |
| Algorithm conformance | NOT RUN |

Overall: PARTIAL PASS. This is a stronger release inventory and hash-metadata lock, not a completed cryptographic chain of custody.

## 8. Scope and authorization

No source code, test, dependency, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation was performed. No binary artifact was downloaded or executed. This is documentation-only.

## 9. Evidence references

- ICU official download/release page: https://unicode-org.github.io/icu/download/
- Unicode announcement of ICU 79: https://blog.unicode.org/2026/10/icu-79-released.html
- ICU release API record: https://api.github.com/repos/unicode-org/icu/releases/417728424
- ICU tag ref API: https://api.github.com/repos/unicode-org/icu/git/ref/tags/release-79.1
- ICU release commit: https://github.com/unicode-org/icu/commit/ddc6b66926bfac6036144ca9902992a0d6d50af9
- ICU official release publishing/signing process: https://unicode-org.github.io/icu/processes/release/tasks/publish/release.html
- ICU release build/key information: https://unicode-org.github.io/icu/processes/release/tasks/release-build
- Maven Central coordinate: https://central.sonatype.com/artifact/com.ibm.icu/icu4j
- R1-U13 candidate provenance dossier: docs/MASTER_BRAIN_GATE2P_R1U13_ICU4J_79_1_PROVENANCE_AND_CONFORMANCE_PLAN_2026-11-15.md
- R1-U14 independent conformance gate: docs/MASTER_BRAIN_GATE2P_R1U14_ICU4J_INDEPENDENT_CONFORMANCE_GATE_2026-11-15.md

---
No source code, tests, dependency manifest, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation was performed in R1-U15.
