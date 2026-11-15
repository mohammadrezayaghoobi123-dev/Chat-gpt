# R1-U13 — ICU4J 79.1 Provenance Dossier and Unicode 18 Conformance Plan
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: PARTIAL PASS — RELEASE/SEMANTIC CANDIDATE VERIFIED — BINARY DIGEST NOT PINNED — NO IMPLEMENTATION
Parent: R1-U12
Scope: documentation-only provenance review and test-plan specification. No executable code, dependency file, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Decision summary

ICU4J 79.1 remains the lead candidate for a controlled Unicode 18 normalization and full default case-fold conformance spike. The official ICU download page identifies ICU 79.1 as the released ICU 79 version and explicitly states that ICU 79 updates to Unicode 18. The Unicode Consortium's 2026-10-27 announcement independently confirms the same release and version relationship. Maven Central's artifact page identifies `com.ibm.icu:icu4j:79.1`.

This establishes release identity and a plausible Unicode-data-version alignment. It does NOT establish:
- exact JAR/POM bytes or SHA-256;
- signature verification for the exact binary consumed;
- runtime Unicode data version from an executed 79.1 binary;
- byte-for-byte identity between ICU's embedded Unicode data and all nine R1-U7 files;
- conformance of the proposed path-key algorithm.

Therefore the candidate is not frozen, approved for implementation, or production-ready.

## 2. Evidence ledger

| Claim | Evidence | Result | Limitation |
|---|---|---|---|
| ICU 79.1 is a published release | Official ICU download page | VERIFIED | Page identifies version/release, not local binary bytes |
| ICU 79 updates to Unicode 18 | Official ICU download page | VERIFIED | Release-level statement; runtime assertion still required |
| Unicode Consortium announced ICU 79 | Official Unicode blog, 2026-10-27 | VERIFIED | Same publisher ecosystem; not independent implementation conformance |
| Maven coordinate exists | Maven Central artifact page: com.ibm.icu:icu4j:79.1 | VERIFIED | Metadata page is not an artifact digest |
| Release tag exists | unicode-org/icu GitHub release page, tag release-79.1, short commit shown as ddc6b66 | PARTIAL | Full immutable commit SHA and tag-signature verification not recorded |
| Exact JAR SHA-256 | Not acquired | UNKNOWN / BLOCKED | Direct checksum endpoint could not be read in this audit |
| Exact POM SHA-256 | Not acquired | UNKNOWN / BLOCKED | Direct checksum endpoint could not be read in this audit |
| PGP/Sigstore verification of consumed binary | Not performed | NOT RUN | Must be checked against official release signing material |
| Runtime Unicode version = 18.0.0 | No execution of the candidate JAR | NOT RUN | Required gate, not inferred from release notes |
| UCD file-level equivalence | No exhaustive differential run | NOT RUN | ICU may embed generated/derived data and needs exact tests |

## 3. Candidate dependency identity

Proposed coordinate for the conformance spike only:

```text
groupId:    com.ibm.icu
artifactId: icu4j
version:    79.1
```

Rules:
1. No version ranges, dynamic versions, snapshots, floating tags, or "latest".
2. No dependency may be added to the repository in this stage.
3. Before any future implementation, acquire the exact POM and JAR from the declared repository and record byte length + SHA-256 for each.
4. Verify available official checksum/signature material. Record signature key fingerprint, signer identity, verification command, verifier version, and result. A checksum published beside an artifact is useful for corruption detection but is not, by itself, an independent trust root.
5. Pin the resolved repository URL, artifact coordinates, checksums, transitive dependency graph (expected to be inspected, not assumed), JDK runtime/build version, and build-tool version.
6. Do not silently switch to a repackaged distribution, system ICU, shaded copy, or vendor-patched JAR.
7. If the exact official binary cannot be authenticated and pinned, stop the spike before executing it.

## 4. Runtime identity gate

A future isolated conformance runner must print and retain:
- package implementation version from the actual loaded ICU4J classes;
- package specification version, if present;
- `UCharacter.getUnicodeVersion()` result;
- code source location and SHA-256 of the loaded JAR;
- JDK vendor/version/build and OS/architecture;
- locale and default charset (even though the algorithm must be locale-independent);
- dependency lock/SBOM digest.

Required outcome:
- ICU4J implementation version exactly 79.1;
- Unicode data version exactly 18.0.0;
- loaded JAR digest exactly matches the separately approved artifact lock.

Any mismatch is a hard stop. The version string alone is insufficient because classpath shadowing, duplicate ICU classes, shaded dependencies, or data overrides could alter the runtime.

## 5. Normative algorithm under test

The only candidate collision-key transformation remains:

`K(P) = UTF8(NFD(DefaultFullCaseFold(NFD(P))))`

Proposed ICU4J operations:
1. Validate the original input as strict UTF-8 before Java String construction; reject malformed sequences and surrogate encodings at the byte boundary.
2. Obtain the ICU NFD Normalizer2 instance.
3. Normalize input to NFD.
4. Apply `UCharacter.foldCase(String, UCharacter.FOLD_CASE_DEFAULT)`.
5. Normalize the result to NFD again.
6. Encode strict UTF-8.
7. Preserve the original accepted NFC path as the actual Git path; the transformed bytes are only the collision key.

Forbidden substitutions:
- `NFKC_Casefold`;
- `java.lang.Character` case APIs;
- `java.text.Normalizer` as the normative Unicode 18 engine;
- default-locale lowercasing;
- Python `unicodedata`, `str.casefold`, `.lower()`, or regex Unicode properties;
- host/system ICU without exact binary and data pinning.

The API documentation describes the String overload as full case folding, including multi-code-point mappings, and describes `FOLD_CASE_DEFAULT` as using default mappings from CaseFolding.txt. This is a compatibility indication, not a substitute for the differential oracle below.

## 6. Conformance plan — required test suites

### C0 — Artifact and runtime attestation
- Verify JAR/POM lengths and digests.
- Verify signature/checksum provenance.
- Verify loaded code source and runtime versions.
- Detect duplicate ICU classes and external data overrides.
- Expected: exact pinned identity; otherwise ABORT.

### C1 — NormalizationTest.txt
- Parse the pinned R1-U7 raw file with a strict, independent parser.
- Exercise all applicable conformance relations in every row, not a sampled subset.
- Check canonical decomposition/composition relations and NFD/NFC idempotence required by Unicode normalization conformance.
- Retain failing row number, source byte offset, input column, expected sequence, actual sequence, and first differing code point.
- Expected: zero failures.

### C2 — Full default case-fold differential
- Build a reference mapping from pinned CaseFolding.txt using only statuses C and F, with F taking precedence where specified by the file's semantics.
- Explicitly test S and T rows as negative controls: simple-only S must not replace the full mapping; Turkic T must not be selected by default.
- Compare ICU full-string output against the reference for every code point with a C/F mapping and an adversarial string corpus.
- Include multi-code-point mappings, combining marks, supplementary code points, dotted/dotless I, Greek sigma variants, and strings where folding changes length.
- Expected: exact code-point sequence equality; no locale dependence.

### C3 — Transformation ordering
- Construct vectors where NFD before folding and NFD after folding are independently observable.
- Compare the candidate result against a reference implementation built from pinned UCD data.
- Expected: exact equality with NFD → full default fold → NFD; reject reordered or single-pass approximations.

### C4 — Path boundary and scalar validity
- Test strict UTF-8 shortest-form rules, truncation, isolated continuation bytes, overlong encodings, surrogate encodings, values above U+10FFFF, and valid supplementary scalars.
- Confirm rejection happens before Java String APIs can replace or reinterpret malformed input.
- Expected: malformed byte strings rejected; valid scalars preserved.

### C5 — Collision-key invariants
- Idempotence of canonical NFD stage.
- Deterministic output across JVM process, locale, and runner.
- Distinguish actual Git path bytes from collision-key bytes.
- Verify no silent input normalization and no accidental compatibility folding.
- Expected: stable output; original accepted NFC path unchanged.

### C6 — Independent execution
- Run the same pinned inputs and test oracle in two separately provisioned runners.
- Compare artifact digests, runtime attestation, test counts, and canonical result manifest.
- Different cloud providers are useful but do not alone prove independence if they share the same binary publisher or artifact mirror.
- Expected: byte-identical canonical results and matching source/artifact identities.

### C7 — Resource and adversarial limits
- Measure peak resident memory, CPU time, wall time, allocation pressure, and output size.
- Include maximum-size accepted path, long combining sequences, pathological normalization inputs, maximum mapping expansion, malformed-input floods, and repeated collision-key computations.
- Compare with R1-U11 provisional ceilings; do not convert provisional ceilings into approved production limits without owner decision and benchmark evidence.
- Expected: no unbounded growth; deterministic fail-closed behavior at every limit.

## 7. Falsification conditions

Reject ICU4J 79.1 for this contract if any of the following occurs:
- runtime Unicode data version is not exactly 18.0.0;
- full normalization conformance has any failure;
- full default case-fold differs from the independent C/F reference;
- a T mapping is applied or an S-only mapping is used in place of the full default result;
- output depends on locale, host ICU, classpath order, or external data;
- the implementation uses NFKC_Casefold or otherwise removes characters outside the explicit path policy;
- two pinned runners produce different canonical results;
- resource limits cannot be enforced predictably;
- exact consumed binary identity cannot be established.

No failure may be waived on performance grounds. A replacement candidate requires a new evidence dossier and the same conformance gates.

## 8. Current blockers and next atomic sequence

1. **B1 — artifact provenance:** obtain exact ICU4J 79.1 JAR/POM bytes, SHA-256 and verifiable signing/checksum provenance. UNKNOWN.
2. **B2 — raw UCD structure:** BOM, EOL, EOF, maximum line, line counts and record/mapping maxima remain UNKNOWN/BLOCKED from R1-U12.
3. **B3 — zero-cost runner:** HF Jobs returned 402 Payment Required; local container DNS resolution failed. No charge-bearing job was launched. Existing GitHub workflow is metadata-only and must not be modified under this authorization.
4. **B4 — test oracle:** design only; no parser or test harness implemented.
5. **B5 — independent reviewer:** R1-G review remains outstanding.

Next safe atomic step: obtain a no-cost, authorized, ephemeral execution channel that can fetch the exact pinned artifacts and emit only digests, measurements, and bounded diagnostics. Until then, keep all runtime and raw-byte test results NOT RUN/UNKNOWN. Do not add dependencies, code, or workflows.

## 9. Evidence references

- Official ICU download/release page: https://unicode-org.github.io/icu/download/
- Unicode Consortium ICU 79 announcement (2026-10-27): https://blog.unicode.org/2026/10/icu-79-released.html
- Maven Central artifact identity: https://central.sonatype.com/artifact/com.ibm.icu/icu4j
- ICU4J UCharacter API documentation: https://unicode-org.github.io/icu-docs/apidoc/dev/icu4j/com/ibm/icu/lang/UCharacter.html
- ICU4J 79.1 API reference mirror used for method semantics: https://fossies.org/dox/icu-release-79.1/classcom_1_1ibm_1_1icu_1_1lang_1_1UCharacter.html
- ICU 79.1 release tag: https://github.com/unicode-org/icu/releases/tag/release-79.1
- R1-U7 raw UCD manifest: docs/evidence/UNICODE18_UCD_RAW_BYTE_MANIFEST_2026-11-15.json
- R1-U10 parser oracle design: docs/MASTER_BRAIN_GATE2P_R1U10_UNICODE18_DETERMINISTIC_PARSER_TEST_ORACLE_DESIGN_2026-11-15.md
- R1-U11 open decisions: docs/MASTER_BRAIN_GATE2P_R1U11_PARSER_OPEN_DECISIONS_AND_RESOURCE_PROFILE_2026-11-15.md
- R1-U12 raw structure and engine feasibility: docs/MASTER_BRAIN_GATE2P_R1U12_UNICODE18_RAW_STRUCTURE_AND_ENGINE_FEASIBILITY_2026-11-15.md

---
No source code, tests, dependency manifest, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation was performed in R1-U13.
