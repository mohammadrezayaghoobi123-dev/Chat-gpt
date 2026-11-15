# R1-U16 — ICU4J 79.1 Signing-Key Trust-Chain Audit
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: PARTIAL PASS — OFFICIAL SIGNING PROCESS AND KEY INVENTORY LOCATED — FULL FINGERPRINT/TRUST AND SIGNATURE VERIFICATION NOT ESTABLISHED
Parent: R1-U15
Scope: read-only documentation audit of the release-signing trust chain. No binary download or execution, no dependency/source/test/workflow changes, no PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Decision summary

R1-U16 narrows the next authenticity gate to the signer identity and trust chain for ICU4J 79.1.

The official ICU release documentation says that the post-publication workflow creates SHA-512 checksum files and detached GPG signature files. The official ICU repository KEYS inventory identifies an ICU Project @IBM key with short key ID 825EA2CD and UID icuintl@us.ibm.com. This is useful publisher-side identity evidence, but it is not a completed verification of the ICU4J 79.1 JAR signature.

No cryptographic signature was verified in this stage. No claim is made that the 2010 key is necessarily the signer of the 2026 artifact. The exact signing subkey, full primary-key fingerprint, signing timestamp, signature packet, and trust path remain unverified.

## 2. Evidence observed

### 2.1 Official release workflow

The ICU release-publishing guide (Since Version 76.1) says:
- the ICU4J Maven Central publishing action creates and publishes official Maven artifacts;
- Maven Central artifacts have checksums and are digitally signed;
- a final release action downloads release assets, creates SHASUM512.txt and MD5 files, and creates detached .asc signatures.

This establishes the documented process, not the successful execution or correctness of the signature for this particular JAR.

Source:
https://unicode-org.github.io/icu/processes/release/tasks/publish/release.html

### 2.2 Official repository key inventory

Read-only GitHub connector retrieval of unicode-org/icu:KEYS at ref main returned:
- blob SHA: 9523c0beaf609fc2c276dd8b4478c9471a9bbdec
- key inventory identifies pub 2048R/825EA2CD, dated 2010-11-02;
- UID: ICU Project @IBM (International Components for Unicode Development at IBM) <icuintl@us.ibm.com>;
- listed certifications include the key's self-signature and signatures by ICU-associated identities;
- encryption subkey ID shown as 1D06B1BF.

The file was read through the connected GitHub account. The blob SHA pins the retrieved file content, but ref main is mutable and no commit SHA for the KEYS snapshot was established in this stage. A future evidence lock must pin both the blob and the containing commit.

Important: 825EA2CD is a short key ID, not a full fingerprint. It is not sufficient as a trust anchor. The key block must be imported into an isolated GPG keyring and its full fingerprint computed from the exact pinned bytes. That fingerprint must then be independently confirmed through a second trusted channel.

Source:
https://github.com/unicode-org/icu/blob/main/KEYS

### 2.3 Official ICU verification guidance

The ICU download-verification page describes checking SHASUM512 and detached PGP signatures and points users to the ICU KEYS file. The ICU release-build page also identifies an ICU Project PGP key associated with icuintl@us.ibm.com and references the MIT key server.

These pages document the intended verification workflow. They do not independently prove the full fingerprint of the key used for ICU4J 79.1.

Sources:
https://icu.unicode.org/download/verification
https://icu.unicode.org/processes/release/tasks/release-build

## 3. Reconciliation with R1-U15

R1-U15 recorded these GitHub release API asset metadata values:
- icu4j-79.1.jar: 15,257,985 bytes; SHA-256 28b292e60d0d00c496bae88a15b2615f89f781be13670aeac9dc90f189570e07
- icu4j-79.1.jar.asc: 228 bytes; SHA-256 087a485aafe1337e040e70ff127ef4e7fbbe1fc5d3a6c2b7f64b7062840f2c5a
- SHASUM512.txt: 1,726 bytes; SHA-256 8c7a56f1d0a77c2c18bd877d4f32acb33bcffdde9154b63156a80e9841eab565
- SHASUM512.txt.asc: 228 bytes; SHA-256 1baae16e1aa435a9a6d591da196ae6d076d93818c1da0e7138e97d6d67b47756

These are GitHub release API digest metadata, not locally recomputed digests. The detached signature assets were not downloaded or cryptographically verified. R1-U16 does not upgrade those claims.

The release API's immutable=false state and the unsigned GitHub release commit noted in R1-U15 remain material limitations. A signed artifact may still be authentic even when the Git tag commit is unsigned, but only if the artifact signature and signer trust chain are independently validated.

## 4. Required trust-chain procedure

The following sequence is mandatory before accepting artifact authenticity:

1. Pin the exact ICU KEYS file bytes and containing commit. Do not use an unpinned main branch as the final trust record.
2. Obtain the ICU Project key block from the pinned KEYS file and independently from a second channel.
3. Import into a fresh, isolated GPG keyring; compute and record the full 40-hex-character primary fingerprint and all signing-subkey fingerprints.
4. Confirm the full fingerprint through a second authenticated channel controlled by ICU/Unicode. A keyserver lookup by email or short key ID is discovery only, not identity proof.
5. Check key validity, revocation, expiration, subkey binding signatures, and whether the signing subkey was valid at the artifact-signing timestamp.
6. Retrieve the exact JAR, .asc, SHASUM512.txt, and SHASUM512.txt.asc bytes from official publication endpoints.
7. Verify SHASUM512.txt.asc using the independently trusted signer key.
8. Confirm that SHASUM512.txt names icu4j-79.1.jar and contains its SHA-512 digest; independently calculate SHA-512 over the downloaded JAR and compare.
9. Verify icu4j-79.1.jar.asc against the exact JAR bytes.
10. Independently calculate SHA-256 and compare with the R1-U15 GitHub asset digest metadata.
11. Compare Maven Central JAR bytes with the official GitHub release asset bytes. If they differ, stop and explain the difference before any runtime use.
12. Record retrieval timestamps, endpoint URLs, byte lengths, hashes, tool versions, GPG version, trustdb state, key fingerprints, signature status, and exit codes.

No TOFU, short-key-ID trust, name/email-only trust, unverified keyserver result, or unsigned mirror is acceptable.

## 5. Falsification conditions

Immediately stop and label ARTIFACT_AUTHENTICITY=FAIL or DISPUTED if any of these occur:
- full fingerprint differs between the pinned ICU KEYS artifact and the independent trusted channel;
- key is revoked, expired at signing time, or signing subkey binding is invalid;
- signature verification fails or reports a different signer than expected;
- signature timestamp is absent, implausible, or cannot be reconciled with key validity;
- SHA-512 checksum does not match the exact JAR bytes;
- SHA-256 differs from the R1-U15 release API metadata;
- Maven Central and GitHub release JAR bytes differ without a documented, independently verified explanation;
- required artifact or signature bytes cannot be retrieved from an official endpoint.

A successful checksum comparison alone proves byte consistency with the checksum file, not signer identity. A successful GPG verification against an untrusted key proves only internal consistency, not publisher authenticity.

## 6. Current evidence matrix

| Claim | Status |
|---|---|
| ICU documents detached signature and checksum release steps | PASS — documentation observed |
| Official KEYS inventory contains ICU Project @IBM key ID 825EA2CD | PASS — pinned blob observed |
| Full primary-key fingerprint independently established | UNKNOWN |
| Signing subkey for ICU4J 79.1 identified | UNKNOWN |
| Key validity/revocation at signing time established | NOT RUN |
| ICU4J 79.1 JAR bytes retrieved and rehashed locally | NOT RUN |
| SHASUM512.txt bytes retrieved and signature verified | NOT RUN |
| JAR detached signature cryptographically verified | NOT RUN |
| Signer identity authenticated through second channel | NOT RUN |
| Maven Central/GitHub JAR byte equality | NOT RUN |
| Artifact authenticity | UNKNOWN — BLOCKED |

## 7. Next atomic stage

R1-U17 should be a bounded, read-only acquisition and GPG verification feasibility stage:
- first resolve the exact pinned KEYS commit and fingerprint through a second trust channel;
- then test whether official release asset bytes are retrievable without credentials, paid compute, or unapproved storage;
- if retrieval is unavailable, stop and report the blocker rather than substituting an untrusted mirror;
- do not execute the JAR;
- do not add dependencies or change code/workflows;
- do not claim conformance or production readiness.

Only after artifact authenticity passes should the separately authorized runtime/conformance spike be considered.

## 8. Scope confirmation

This report is documentation-only. No source code, tests, dependency manifests, workflows, PRs, merges, deployments, secrets, Cloudflare, Supabase, laptop, or main branch were changed. No binary was downloaded or executed.

---
R1-U16 verdict: PARTIAL PASS. Official signing procedure and publisher key inventory were located and pinned at blob level. Full fingerprint trust, artifact bytes, and cryptographic signature verification remain UNKNOWN / NOT RUN.
