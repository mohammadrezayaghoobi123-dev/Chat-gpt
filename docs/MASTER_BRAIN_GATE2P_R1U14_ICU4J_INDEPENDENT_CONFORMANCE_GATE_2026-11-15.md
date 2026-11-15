# R1-U14 — ICU4J 79.1 Independent Conformance Gate and Evidence Matrix
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: DESIGN COMPLETE — EXECUTION NOT AUTHORIZED — ALL CONFORMANCE TESTS NOT RUN
Parent: R1-U13
Scope: documentation-only refinement of the independent conformance gate. No source code, tests, dependency changes, workflow edits, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Purpose and decision boundary

R1-U14 converts the R1-U13 candidate dossier into a falsifiable, evidence-producing test protocol. It separates four claims that must never be conflated:

A. Release identity: ICU4J 79.1 is the official published release.
B. Runtime identity: the actually loaded artifact is the exact pinned ICU4J 79.1 binary and reports Unicode data version 18.0.0.
C. Algorithm conformance: the candidate NFD → full default case fold → NFD output conforms to the pinned Unicode 18 data and the SR-02 path-key contract.
D. Operational suitability: the implementation is deterministic, bounded, reproducible, and safe under adversarial input.

A PASS at A does not imply B, C, or D. A release announcement is not a runtime attestation. A runtime version string is not a conformance test. A conformance test is not a production authorization.

## 2. Normative baseline and correction

The normative normalization baseline is Unicode 18.0.0 UAX #15 Revision 58, dated 2026-08-12, together with the exact R1-U7 pinned NormalizationTest.txt bytes.

UAX #15 conformance clause C3 requires a process that purports to transform text into a normalization form to produce the results specified by NormalizationTest.txt; Unicode 18 core specification C15 points to that test requirement. The future test harness MUST execute the complete applicable conformance test data, not a sample or a selected subset.

Important correction to test-plan wording: the conformance harness must implement the exact field relations and expected transformations specified in the header of the pinned NormalizationTest.txt. It must not invent an abbreviated “NFC/NFD subset” that accidentally omits required relations. All required normalization forms and all prescribed column relations must be evaluated as specified by the pinned file and UAX #15.

## 3. Artifact identity and trust chain

### 3.1 Required immutable artifact lock

Before execution, acquire and record:
- Maven coordinate: com.ibm.icu:icu4j:79.1
- canonical repository URL and resolved artifact URL;
- JAR byte length and SHA-256;
- POM byte length and SHA-256;
- all runtime/transitive artifacts actually resolved, each with coordinates, URL, length, and SHA-256;
- official checksum files and signature files, if published;
- signer key fingerprint and trust path;
- signature verifier name/version and exact command;
- immutable ICU release tag and full commit SHA;
- JDK distribution, exact version/build, architecture;
- build tool and dependency resolver versions;
- final lockfile/SBOM digest.

Do not treat a checksum fetched from the same artifact host as an independent trust root. Verify signed release/checksum material against a separately trusted signer key fingerprint. If the signature chain cannot be established, report ARTIFACT_AUTHENTICITY=UNKNOWN and do not execute the candidate.

### 3.2 Runtime anti-substitution controls

The test process must record:
- loaded class implementation version;
- loaded JAR code-source path;
- SHA-256 of the actual loaded JAR bytes;
- ICU Unicode data version from UCharacter.getUnicodeVersion();
- ICU data/customization source and whether external ICU data overrides are active;
- classpath/module path and duplicate ICU class detection;
- locale and default charset;
- complete process command line and environment allowlist.

Hard fail if:
- implementation version is not exactly 79.1;
- Unicode data version is not exactly 18.0.0;
- loaded JAR hash differs from the approved artifact lock;
- duplicate ICU classes, class shadowing, or unapproved external data are detected;
- any fallback to host Unicode APIs is observed.

## 4. Independent test oracle architecture

The candidate under test and the reference oracle MUST be separate implementations with separate data paths.

Reference oracle:
1. Parse the exact R1-U7 raw UCD bytes after SHA-256 precondition checks.
2. Build normalization reference data only from the pinned Unicode 18 UCD files and the formal algorithm in UAX #15.
3. Build the default full case-fold reference map from CaseFolding.txt statuses C and F according to the file's defined status semantics.
4. Use F full mappings where supplied; use C common mappings where no F full mapping supersedes them.
5. Treat S as simple-fold-only data and T as Turkic-specific data; neither may override the default full-fold result.
6. Retain source line number, byte offset, status, code point, and mapping sequence for every oracle entry.

Candidate:
- ICU4J 79.1 only, with runtime identity gates in Section 3.
- NFD(P) → UCharacter.foldCase(..., FOLD_CASE_DEFAULT) → NFD(result).
- Strict UTF-8 validation before Java String construction.
- No NFKC_Casefold, locale-sensitive lowercase, java.text.Normalizer, java.lang.Character folding, Python Unicode database, or host ICU fallback.

Independence caveat: a reference oracle derived from the same Unicode publisher's pinned data is independent in implementation, not independent in publisher provenance. Report these dimensions separately.

## 5. Required test suites and pass criteria

| ID | Suite | Required coverage | PASS criterion |
|---|---|---|---|
| A0 | Artifact authenticity | JAR/POM, signatures, signer key, full dependency graph | Exact bytes pinned; trusted signature verified |
| A1 | Runtime identity | Loaded JAR, runtime Unicode version, classpath, data overrides | All identity assertions exact; no shadowing |
| N1 | Normalization conformance | Every applicable record and every prescribed relation in pinned NormalizationTest.txt | Zero mismatches |
| F1 | Full default folding | Every C/F mapping; F/C selection semantics; adversarial multi-code-point strings | Exact code-point sequence equality |
| F2 | Negative fold controls | S-only and T-specific rows, Turkic-sensitive cases | No simple-only or Turkic override in default mode |
| O1 | Operation order | NFD before fold and NFD after fold; canonical reordering and decomposition edge cases | Exact reference equality |
| U1 | UTF-8 boundary | Overlong forms, truncated sequences, stray continuation bytes, surrogate encodings, >U+10FFFF, valid supplementary scalars | Invalid bytes rejected before string conversion; valid scalars preserved |
| P1 | Path identity | NFC acceptance, non-NFC rejection, original path preservation, collision key separation | No silent normalization; actual Git path unchanged |
| D1 | Determinism | Repeated process runs, locale changes, timezone changes, host default charset changes | Identical canonical output |
| R1 | Resource limits | Long combining runs, maximum path, expansion, malformed floods, repeated requests | Bounded memory/CPU/wall/output; deterministic fail-closed limit response |
| X1 | Cross-runner reproduction | Two independently provisioned environments with same artifact and source locks | Identical result manifest and test counts |

A test suite is not PASS because the process exits zero alone. It must emit counts, source digest, artifact digest, test-vector digest, failure count, and canonical result digest. Missing telemetry yields INCOMPLETE, not PASS.

## 6. Test vector and traceability schema

Every vector must have:
- vector_id (stable, unique);
- suite_id;
- source_file and source_line (or explicit synthetic origin);
- source_byte_offset where applicable;
- input UTF-8 bytes in hex, not only rendered glyphs;
- expected output scalar sequence and UTF-8 bytes;
- candidate output scalar sequence and UTF-8 bytes;
- expected rejection/acceptance;
- actual outcome;
- ICU runtime identity;
- source-manifest digest;
- oracle version/digest;
- failure classification;
- reproducible minimal case.

Never rely on visually rendered Unicode strings as the sole evidence. Logs and diagnostics must use escaped code-point notation and must be protected against bidi/control spoofing under DISP-1.

## 7. Falsification rules

Reject ICU4J 79.1 for this contract if any one of the following is true:
- artifact authenticity is unresolved or the loaded bytes do not match the approved lock;
- runtime Unicode data version is not exactly 18.0.0;
- any required normalization conformance vector fails;
- any C/F reference fold differs from ICU default full folding;
- an S-only or T-specific mapping is selected in default mode;
- normalization/folding output depends on locale, process environment, classpath, or external data;
- malformed UTF-8 is accepted or silently replaced;
- accepted NFC Git paths are modified instead of preserving the exact accepted path;
- collision keys differ across independent runs;
- resource limits are unbounded or failure behavior is nondeterministic.

No averaging, percentage threshold, or performance trade-off can waive a semantic mismatch. A single reproducible mismatch is a candidate rejection pending root-cause analysis.

## 8. Evidence package format

The future execution report must contain:
1. signed artifact verification transcript (secrets/private key material excluded);
2. artifact lock and SBOM;
3. raw UCD manifest digest and per-file digest rechecks;
4. runtime identity attestation;
5. complete suite counts and pass/fail totals;
6. bounded failure vectors with source locations;
7. cross-runner comparison;
8. resource benchmark results and environment metadata;
9. independent reviewer findings;
10. explicit verdict for each of A/B/C/D.

Verdict vocabulary:
- PASS: all criteria for the named claim demonstrated;
- PARTIAL PASS: some criteria demonstrated, remaining named blockers;
- FAIL: falsified by reproducible counter-evidence;
- UNKNOWN: evidence unavailable or insufficient;
- NOT RUN: test was not executed;
- BLOCKED: execution precondition unavailable;
- DISPUTED: conflicting evidence remains unresolved.

UNKNOWN and NOT RUN are not PASS or FAIL.

## 9. Current state and authorization boundary

| Work item | State |
|---|---|
| ICU 79.1 official release and Unicode 18 relationship | VERIFIED AT RELEASE-CLAIM LEVEL |
| Exact JAR/POM hashes and signature validation | UNKNOWN / NOT RUN |
| Runtime ICU data version assertion | NOT RUN |
| Full NormalizationTest conformance | NOT RUN |
| Independent C/F fold differential | NOT RUN |
| UTF-8/path adversarial tests | NOT RUN |
| Cross-runner reproducibility | NOT RUN |
| Raw UCD BOM/EOL/line metrics | UNKNOWN / BLOCKED |
| Independent R1-G review | OUTSTANDING |
| Implementation authorization | NOT GRANTED |
| Dependency/workflow/code changes | NOT AUTHORIZED |

This document is a test protocol, not a test result. No tests were run in R1-U14.

## 10. Next atomic step

R1-U15 should be a strictly read-only acquisition/provenance attempt for the ICU4J 79.1 JAR, POM, official checksum/signature files, release tag full commit, and signer-key fingerprint. It must not execute the artifact or add it to the repository. If trusted signature verification or a no-cost ephemeral environment cannot be established, preserve the status as UNKNOWN/BLOCKED and stop before execution.

Separately, R1-U12-B raw UCD structure measurement remains blocked until a confirmed zero-cost ephemeral byte-processing channel is available. Do not change the existing GitHub Actions workflow or add artifact-upload permissions without separate explicit approval.

## 11. Normative and provenance references

- Unicode 18 UAX #15 Revision 58: https://www.unicode.org/reports/tr15/tr15-58.html
- Unicode 18 Core Specification, normalization conformance C13–C15: https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-3/
- Unicode 18 versioned UCD release inventory: https://www.unicode.org/versions/Unicode18.0.0/
- ICU official release page: https://unicode-org.github.io/icu/download/
- ICU 79 announcement: https://blog.unicode.org/2026/10/icu-79-released.html
- Maven Central ICU4J 79.1 artifact page: https://central.sonatype.com/artifact/com.ibm.icu/icu4j
- ICU release publication process (checksums and digitally signed Maven artifacts): https://unicode-org.github.io/icu/processes/release/tasks/publish/release.html
- ICU release build/signing process: https://icu.unicode.org/processes/release/tasks/release-build
- Pinned UCD manifest: docs/evidence/UNICODE18_UCD_RAW_BYTE_MANIFEST_2026-11-15.json
- Parent candidate dossier: docs/MASTER_BRAIN_GATE2P_R1U13_ICU4J_79_1_PROVENANCE_AND_CONFORMANCE_PLAN_2026-11-15.md

---
No code, tests, dependency, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation was performed in R1-U14.
