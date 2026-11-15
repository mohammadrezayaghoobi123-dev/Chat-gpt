# R1-U17 — ICU4J 79.1 Signing-Identity Candidate Reconciliation
Date: 2026-11-16
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Audited branch head before this document: 5a68a4d47204afd37942d68902ec515efd125755
Fixed main baseline: 919b19ca3d3887352cdef06b03c668ead04fbce7
Parent: R1-U16
Status: PARTIAL PASS — A SECOND ICU SIGNING-KEY CANDIDATE IS IDENTIFIED AND CROSS-PUBLISHER FINGERPRINT-CORROBORATED — THE ACTUAL ICU4J 79.1 SIGNER REMAINS UNKNOWN
Scope: read-only public metadata reconciliation and documentation only. No binary download or execution, no GPG verification, no dependency/source/test/workflow change, no PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Executive finding

R1-U16 correctly refused to treat the legacy ICU Project key ID 825EA2CD as a sufficient trust anchor. However, its key inventory review was incomplete for signer discovery: the pinned ICU KEYS inventory also contains a distinct, newer identity:

- UID: ICU Release Robot <icu-robot@unicode.org>
- primary key short ID: D46C5610D06E7001
- signing-capable primary key designation in the key inventory: [SC]
- encryption subkey ID: 00E25FE3776F21F2
- key creation date: 2024-08-19

A separate Google AndroidX Gradle verification record explicitly trusts the full fingerprint
E52F07877A5805F9AF4AB0ACD46C5610D06E7001
for Maven group com.ibm.icu. This is independent downstream corroboration that the Release Robot key is used as a trusted signing identity for ICU Maven artifacts.

This does NOT prove that this key signed the ICU4J 79.1 JAR or SHASUM512.txt. The detached signatures were not retrieved or verified. The actual signer remains UNKNOWN.

## 2. Pinned ICU publisher key inventory

Read-only GitHub API observations:

- Repository: unicode-org/icu
- KEYS blob SHA: 9523c0beaf609fc2c276dd8b4478c9471a9bbdec
- Containing path's latest recorded commit: 9e68dceba9994dfc5b11d8e9c4987b0d323f6d46 (2024-10-02T16:14:52Z)
- Repository main branch head at retrieval: bf835bad36a09828051dd8cc6f58bb62bac93fde

The pinned KEYS content includes both:
1. ICU Project @IBM <icuintl@us.ibm.com>, key ID 825EA2CD, created 2010-11-02, subkey 1D06B1BF.
2. ICU Release Robot <icu-robot@unicode.org>, key ID D46C5610D06E7001, created 2024-08-19, subkey 00E25FE3776F21F2.

The existence of both keys means that a verification attempt restricted to 825EA2CD would be incomplete. It does not mean the legacy key is invalid or that the Release Robot key necessarily signed this release.

## 3. Independent downstream fingerprint corroboration

Google AndroidX public source provides two related records:

### 3.1 Public key inventory

At immutable AndroidX frameworks/support commit:
8ceef9ae8d30a9ab0e2e470e029e9ef460a457ae

File:
gradle/verification-keyring.keys

Blob SHA observed by the source page:
1500a8aea1cfba36ea737a117a449f3d121d2627

The file contains:
- pub D46C5610D06E7001
- uid ICU Release Robot <icu-robot@unicode.org>
- sub 00E25FE3776F21F2
- the corresponding armored public key block.

### 3.2 Artifact-group trust metadata

At AndroidX frameworks/support commit:
da5aa22c221977c0aceb1c9e4f2d1e22a90717d9

The change to gradle/verification-metadata.xml adds:

trusted-key id="E52F07877A5805F9AF4AB0ACD46C5610D06E7001" group="com.ibm.icu"

The 40-hex fingerprint suffix corresponds to the Release Robot key ID D46C5610D06E7001. This independently corroborates the full primary fingerprint and the fact that a downstream AndroidX build configured that key as trusted for the com.ibm.icu artifact group.

Trust-boundary limitation: Google AndroidX's verification metadata is an independent downstream consumer's trust configuration, not a second statement from ICU itself. It corroborates key identity and downstream trust configuration; it does not establish which key signed the specific 79.1 release assets.

## 4. Reconciliation with R1-U15 and R1-U16

R1-U15 observed the ICU4J 79.1 release inventory:
- release tag: release-79.1
- published: 2026-10-22T15:46:21Z
- GitHub release API immutable: false
- JAR asset: 15,257,985 bytes; API digest SHA-256 28b292e60d0d00c496bae88a15b2615f89f781be13670aeac9dc90f189570e07
- JAR detached signature asset: 228 bytes; API digest SHA-256 087a485aafe1337e040e70ff127ef4e7fbbe1fc5d3a6c2b7f64b7062840f2c5a
- SHASUM512.txt: 1,726 bytes; API digest SHA-256 8c7a56f1d0a77c2c18bd877d4f32acb33bcffdde9154b63156a80e9841eab565
- SHASUM512.txt.asc: 228 bytes; API digest SHA-256 1baae16e1aa435a9a6d591da196ae6d076d93818c1da0e7138e97d6d67b47756

These remain GitHub release API asset metadata, not independently recomputed hashes.

R1-U15 also recorded that the GitHub release commit ddc6b66926bfac6036144ca9902992a0d6d50af9 was reported unsigned by GitHub's commit verification. An unsigned Git commit does not invalidate a separately signed release artifact, but it cannot authenticate the release by itself.

R1-U16 reviewed the legacy ICU Project key ID 825EA2CD and its documented release process. R1-U17 adds the Release Robot candidate and independent downstream fingerprint evidence. Neither report has verified the actual detached signature.

## 5. Required next verification sequence

Do not assume either candidate key signed ICU4J 79.1. The next stage must identify the signer from the signature packet and then verify it:

1. Acquire exact bytes for icu4j-79.1.jar, icu4j-79.1.jar.asc, SHASUM512.txt, and SHASUM512.txt.asc from official release endpoints.
2. Independently recompute local SHA-256 and SHA-512 from those exact bytes.
3. Pin the exact ICU KEYS blob and containing commit; also pin the AndroidX keyring and verification-metadata source commits.
4. Import the exact candidate key blocks into a fresh isolated GPG keyring. Compute primary and signing-subkey fingerprints from the imported bytes.
5. Compare the computed Release Robot primary fingerprint with the downstream 40-hex fingerprint above; separately authenticate any legacy ICU Project key if the signature identifies it.
6. Verify SHASUM512.txt.asc and icu4j-79.1.jar.asc. Record the exact signing key/subkey fingerprint, signature creation time, digest algorithm, GPG version, trustdb state, exit code, and full status output.
7. Validate key creation, binding, expiration and revocation status at the signature timestamp. Do not rely on the current validity display alone.
8. Confirm SHASUM512.txt contains the expected JAR filename and that its SHA-512 matches the downloaded JAR.
9. Compare the JAR's recomputed SHA-256 with the GitHub release API digest metadata.
10. Compare Maven Central JAR bytes with the official GitHub release JAR bytes.
11. If the signature identifies neither candidate, stop and establish the actual signer through a separate authenticated channel. Do not broaden trust automatically.
12. Do not execute the JAR as part of this provenance stage.

## 6. Falsification conditions

Set ARTIFACT_AUTHENTICITY=FAIL or DISPUTED if:
- the signature does not verify against the actual signer key;
- the signature identifies a key whose full fingerprint cannot be authenticated independently;
- key/subkey binding or validity at signing time fails;
- the JAR checksum differs from the signed checksum file;
- the locally computed JAR SHA-256 differs from the GitHub release API digest without an independently verified explanation;
- Maven Central and GitHub release bytes differ without an approved explanation;
- the signature packet is malformed, absent, or cannot be retrieved from an official endpoint.

A matching fingerprint in downstream Gradle metadata is corroboration, not proof that a particular artifact was signed by that key.

## 7. Evidence matrix

| Claim | Result |
|---|---|
| ICU KEYS inventory contains legacy ICU Project key 825EA2CD | SUPPORTED |
| ICU KEYS inventory contains ICU Release Robot key D46C5610D06E7001 | SUPPORTED |
| Release Robot full primary fingerprint is independently listed by AndroidX | SUPPORTED |
| AndroidX config trusts that fingerprint for group com.ibm.icu | SUPPORTED |
| Release Robot key is the signer of ICU4J 79.1 JAR | UNKNOWN |
| Legacy ICU Project key is the signer of ICU4J 79.1 JAR | UNKNOWN |
| JAR and signature bytes locally acquired | NOT RUN |
| Detached signature cryptographically verified | NOT RUN |
| Signed SHA-512 checksum verified | NOT RUN |
| Runtime Unicode data version | NOT RUN |
| ICU normalization/case-fold conformance | NOT RUN |
| Artifact authenticity | UNKNOWN / BLOCKED |

## 8. Authorization and scope

- Documentation-only change: this report only.
- No binary downloaded or executed.
- No GPG verification executed.
- No dependency, source, test, or workflow modified.
- No PR created or updated.
- No merge or deployment.
- No secrets, Cloudflare, Supabase, laptop, or main-branch operation.

R1-U17 verdict: PARTIAL PASS. The signer search has been improved by identifying and independently corroborating a second, newer ICU signing-key candidate. The specific signer of ICU4J 79.1 and the cryptographic validity of its release signatures remain UNKNOWN / NOT RUN.
