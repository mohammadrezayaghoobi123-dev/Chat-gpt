# R1-U12 — Unicode 18 Raw Structure and Normalization Engine Feasibility
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: PARTIAL PASS — ENGINE CANDIDATE IDENTIFIED — RAW STRUCTURAL METRICS BLOCKED — NO IMPLEMENTATION
Parent: R1-U11
Scope: source-backed feasibility review and acquisition-gate reconciliation only. No executable code, workflow change, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Executive result

R1-U12 establishes ICU 79.1 / ICU4J 79 as the first credible implementation candidate for the Unicode 18 normalization and full default case-folding layer. The Unicode Consortium's ICU release material says ICU 79 updates to Unicode 18; the release is dated 2026-10-22 on the ICU download page and the Unicode blog records the release announcement on 2026-10-27.

This is a candidate selection for controlled conformance evaluation, not an implementation approval and not proof that ICU's internal data exactly matches the nine pinned R1-U7 source files. Runtime Unicode-version assertion and exhaustive conformance against the pinned Unicode 18 NormalizationTest.txt remain mandatory.

Raw-byte structural measurements were not run in this stage. The current repository manifest records exact source lengths and digests but does not record BOM, EOL, EOF terminator, maximum line length, physical line count, or detailed record/mapping sequence maxima. These properties remain UNKNOWN. They must not be inferred from Firecrawl text, parsed text, archive headers, or file-size metadata.

## 2. Preconditions and source lock

The source of truth for any future raw-byte run is:
- Manifest: docs/evidence/UNICODE18_UCD_RAW_BYTE_MANIFEST_2026-11-15.json
- Manifest blob at inspection: 009765c2dcfdd075c459dee19c39ceba0424a07a
- Archive: UCD.zip, 5,657,953 bytes, SHA-256 7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8
- Nine files: exact byte lengths and SHA-256 values are pinned in that manifest; direct-download bytes and archive-member bytes matched for all nine in R1-U7.
- Aggregate file bytes: 8,327,323 bytes (7.94 MiB).

Before any byte-level measurement, the runner MUST:
1. Fetch the exact archive or the exact nine files from the pinned Unicode 18.0.0 source URL.
2. Verify archive and/or individual file byte lengths and SHA-256 against the manifest before parsing.
3. Abort closed on any mismatch; do not silently refresh hashes or accept a different archive roll.
4. Work in ephemeral storage; do not commit or upload raw UCD files.
5. Record toolchain, runner image digest, architecture, locale, clock source, command, exit status, and measurement-code digest.

## 3. Normalization and case-fold engine candidate

### 3.1 Candidate

Candidate: ICU4J 79.1, with ICU Unicode data version checked at runtime using UCharacter.getUnicodeVersion(). The release-level documentation says ICU 79 updates to Unicode 18. ICU documentation states each ICU release supports the latest Unicode version available at that release. UCharacter exposes getUnicodeVersion() specifically to return the Unicode data version in use.

Required runtime gate:
- ICU library release must be exactly 79.1 (or a separately reviewed patch release with the same Unicode-data version).
- UCharacter.getUnicodeVersion() must return exactly 18.0.0.
- Record both the ICU library version and Unicode data version in every build/test attestation.
- If either assertion fails, abort; never fall back to java.lang.Character, java.text.Normalizer, Python unicodedata, host locale, or a system ICU discovered through PATH.

### 3.2 API composition for the candidate path key

The R1-U10/R1-U11 candidate algorithm is:

K(P) = UTF8(NFD(DefaultFullCaseFold(NFD(P))))

Candidate ICU4J composition:
1. Strictly decode UTF-8 at the byte boundary; reject malformed sequences and surrogate scalar encodings before constructing a Java String.
2. Use ICU Normalizer2 NFD instance to obtain NFD(P).
3. Use UCharacter.foldCase(String, UCharacter.FOLD_CASE_DEFAULT) for full string case folding.
4. Apply ICU Normalizer2 NFD again.
5. Encode the resulting Unicode scalar sequence as strict UTF-8.
6. Preserve the original accepted NFC path as the actual Git path; K(P) is only the collision key.

ICU4J API documentation states that UCharacter.foldCase(String, options) returns full, potentially multi-code-point mappings. FOLD_CASE_DEFAULT selects default mappings from CaseFolding.txt; the Turkic-special-I option is distinct. This appears compatible with the project's C/F-only policy and exclusion of T mappings. It still requires differential testing against a small independently implemented reference derived directly from the pinned CaseFolding.txt, including proof that no S-only or T mapping is accidentally selected.

### 3.3 Important separation

Do not use ICU's NFKC_Casefold operation for K(P). It removes default-ignorable characters and uses compatibility normalization semantics; that is not the specified NFD → full default case fold → NFD sequence. The project separately rejects the pinned FC-3 subset and has explicit treatment for join controls; a broad ignorable-removal transform would silently change policy semantics.

## 4. Falsification and conformance gates

ICU 79.1 remains only a candidate until all gates pass:

| Gate | Test | Required result | Current state |
|---|---|---|---|
| E1 | Assert ICU library version and UCharacter.getUnicodeVersion() | Exact ICU 79.1 and Unicode 18.0.0 | NOT RUN |
| E2 | Run all applicable rows in pinned NormalizationTest.txt | 100% pass for required NFC/NFD relations | NOT RUN |
| E3 | Differentially compare full default fold output against a reference generated from pinned CaseFolding.txt C/F mappings | Exact equality for every mapping and adversarial string corpus | NOT RUN |
| E4 | Verify NFD → fold → NFD ordering with known composition/reordering edge cases | Exact expected output | NOT RUN |
| E5 | Test supplementary code points, combining sequences, Hangul, singleton decompositions, multi-code-point folds, and malformed UTF-8 boundary cases | Exact expected behavior; malformed input rejected before ICU | NOT RUN |
| E6 | Confirm no accidental use of Turkic T mappings, simple-only S mappings, locale-sensitive lowercasing, or NFKC_Casefold | Zero forbidden paths | NOT RUN |
| E7 | Repeat on a second independent runner with pinned artifact and package digests | Byte-identical result manifest | NOT RUN |
| E8 | Benchmark resource ceilings under normal and adversarial inputs | Within approved limits, with measured headroom | NOT RUN |

A failure in any gate rejects the candidate for this contract; it must not be waived by performance or convenience.

## 5. Raw-byte structural measurement protocol

The next raw-byte run must calculate, per file:
- BOM signature and byte offset (including UTF-8 EF BB BF detection);
- counts of LF, CRLF, and lone CR terminators, without double-counting CRLF as lone CR;
- whether line-ending styles are mixed;
- whether the file ends in a line terminator;
- maximum physical line length in bytes and its 1-based line number;
- physical line count and exact byte offsets for each exceptional line;
- parser record count and malformed/blank/comment counts under the file-specific grammar;
- maximum mapping output length in CaseFolding.txt, split by status C/F/S/T;
- maximum code-point sequence length in each NormalizationTest.txt column, and maximum encoded byte length;
- exact per-file SHA-256 and byte length rechecked immediately before and after analysis.

The scanner must operate on bytes first. It must not normalize line endings, strip BOMs, decode with replacement, or rewrite files. The report must include a reproducible measurement algorithm and bounded diagnostic output.

## 6. Execution channel and cost gate

A Hugging Face remote Jobs execution path was inspected. Its documented interface launches a compute job with a selected hardware flavor and does not establish that the user's current account has free execution or that the run would be zero-cost. Therefore no job was launched and no charge-bearing compute was initiated.

The prior Hugging Face sandbox attempt returned 402 Payment Required (R1-U4). The existing GitHub Actions workflow is deliberately metadata-only and does not persist raw UCD artifacts; modifying it or adding artifact-upload permissions is outside this stage's authorization. No Cloudflare Worker or laptop execution was used.

Accordingly, raw-byte metrics are BLOCKED pending a confirmed zero-cost execution channel or separate explicit authorization for a bounded compute run. No claim is made that this stage measured the raw files.

## 7. Open decisions retained

- BOM-1: UNKNOWN / BLOCKED.
- EOL-1: UNKNOWN / BLOCKED.
- Maximum line length and physical line counts: UNKNOWN / NOT MEASURED.
- Detailed record counts (except the previously validated 41,341 UnicodeData records): NOT MEASURED.
- CaseFolding maximum mapping length and NormalizationTest sequence maxima: NOT MEASURED.
- ICU 79.1 candidate conformance: NOT RUN.
- ICU runtime/data provenance pin: CANDIDATE ONLY; exact package and binary/data digests not recorded.
- CPython 3.12 remains parser orchestration only; its Unicode 15.0 standard library data must not be used for normative Unicode 18 behavior.
- UTS #39 Rev 34 join-control contextual validation remains a separate profile dependency and is not solved by ICU's Unicode 18 core version alone.
- R1-G independent review remains outstanding.

## 8. Decision and next atomic step

Decision:
- ACCEPT ICU4J 79.1 as the lead candidate for a controlled conformance spike only.
- REJECT any claim that the normalization engine is selected/frozen/production-ready.
- KEEP BOM/EOL and raw structural metrics UNKNOWN.
- KEEP parser implementation unauthorized and all tests NOT RUN.

Next step R1-U13 should be a no-code, independently specified conformance test plan and pinned dependency provenance dossier for ICU4J 79.1, followed—only after a zero-cost raw-byte execution channel is verified—by R1-U12-B raw structural measurement. Do not modify the existing GitHub workflow or introduce artifact uploads without separate approval.

## 9. Evidence references

- ICU 79 release and Unicode 18 update: https://unicode-org.github.io/icu/download/
- Unicode announcement of ICU 79: https://blog.unicode.org/2026/10/icu-79-released.html
- ICU4J 79 UCharacter API (Unicode version, default full fold): https://unicode-org.github.io/icu-docs/apidoc/dev/icu4j/com/ibm/icu/lang/UCharacter.html
- ICU Normalizer2 / normalization documentation: https://unicode-org.github.io/icu/userguide/transforms/normalization/
- ICU data provenance and embedded/custom data: https://unicode-org.github.io/icu/userguide/icu_data/
- Pinned raw UCD manifest: docs/evidence/UNICODE18_UCD_RAW_BYTE_MANIFEST_2026-11-15.json
- Parent parser design: docs/MASTER_BRAIN_GATE2P_R1U10_UNICODE18_DETERMINISTIC_PARSER_TEST_ORACLE_DESIGN_2026-11-15.md
- Parent open decisions: docs/MASTER_BRAIN_GATE2P_R1U11_PARSER_OPEN_DECISIONS_AND_RESOURCE_PROFILE_2026-11-15.md

---
No source code, tests, workflow, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation was performed in R1-U12.
