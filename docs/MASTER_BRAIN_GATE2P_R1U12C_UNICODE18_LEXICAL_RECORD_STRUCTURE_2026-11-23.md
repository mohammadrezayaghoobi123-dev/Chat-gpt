# R1-U12-C — Unicode 18.0.0 Lexical Record Structure Evidence

- Date: 2026-11-23
- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Branch: `work/r1u12c-lexical-structure-2026-11-23`
- Implementation commit: `e413e894bc169e93e765c2f2fb0798a462fee4d2`
- GitHub Actions run: [45191014934](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45191014934)
- Workflow status: **SUCCESS**
- Lexical subgate status: **SUPPORTED — SHAPE METRICS ONLY**
- Pinned source manifest SHA-256: `965655de97a82e6efc751d4e5f5c577c9c484eaf798af9a90f1a0203516ac27c`

## 1. Scope and non-goals

R1-U12-C adds bounded, read-only lexical record profiling for eight Unicode 18.0.0 data files whose raw bytes are pinned by the pre-existing R1-U7 source lock. `ReadMe.txt` remains a document and is explicitly excluded.

The scanner measures record framing, delimiter/cardinality shape, comments, blank lines, directives, trailing delimiters, empty fields, tab bytes, record and field byte lengths, and source-relative offsets. It does not normalize, decode into semantic values, derive Unicode properties, or modify source bytes.

This is not a complete UCD parser and does not establish:
- validity of code-point values or ranges across all formats;
- validity of property names, property values, statuses, or mappings;
- ordering, uniqueness, or cross-file consistency for all inputs;
- Unicode normalization algorithm conformance;
- ICU4J artifact identity, signatures, or runtime equivalence;
- SR-02 freeze, runtime integration, merge, or production readiness.

The inherited acquisition preflight still has its pre-existing narrow `UnicodeData.txt` check (15 fields and strictly increasing code-point field). R1-U12-C does not extend that check into a general semantic parser.

## 2. Format profiles

The scanner uses explicit exact-path allowlisting:
- Five UCD property-style files: `PropList.txt`, `DerivedCoreProperties.txt`, `DerivedAge.txt`, `extracted/DerivedGeneralCategory.txt`, and `DerivedNormalizationProps.txt`.
- `CaseFolding.txt`: three data fields; trailing delimiter is measured but not counted as a fourth field.
- `UnicodeData.txt`: 15 fields; `#` is not interpreted as a comment marker.
- `NormalizationTest.txt`: five data columns; `@PartN` directives are counted separately; trailing delimiter is not counted as a sixth field.

`ReadMe.txt` and unknown paths fail closed as unsupported lexical formats. The scanner requires immutable `bytes` input.

Format decisions were checked against [UAX #44, Unicode 18.0.0, version 38](https://www.unicode.org/reports/tr44/tr44-38.html), the [Unicode 18.0.0 UCD distribution](https://www.unicode.org/Public/18.0.0/ucd/), [CaseFolding.txt](https://www.unicode.org/Public/18.0.0/ucd/CaseFolding.txt), and [NormalizationTest.txt](https://www.unicode.org/Public/18.0.0/ucd/NormalizationTest.txt). Those documents describe formats; this report records only structural measurements, not semantic conformance.

## 3. Resource and fail-closed controls

| Control | Implemented behavior |
|---|---|
| Input type | immutable `bytes` only |
| Accepted paths | exact allowlist of eight data files |
| Document path | `ReadMe.txt` excluded |
| Maximum physical record line | 4,096 bytes; 4,096 accepted, 4,097 rejected |
| Maximum fields per record | 32; 32 accepted for measurement, 33 rejected |
| Shape profile | explicit per-format expected field counts |
| Shape gate | any unexpected field-cardinality record blocks the gate |
| Mutation boundary | malformed CaseFolding row must be rejected by the gate |
| Byte preservation | source SHA-256 before/after measurement unchanged |
| Cross-check | lexical physical-line count equals raw-byte physical-line count |

The 4,096-byte and 32-field limits are scanner resource ceilings, not new Unicode format requirements. They were selected as conservative bounded-work limits relative to the observed pinned source measurements.

## 4. TDD and adversarial evidence

The implementation was developed in recorded red-green increments:

| Stage | Commit / run | Evidence |
|---|---|---|
| Initial lexical tests (RED) | commit `ac380e2c9f2965beb4cca2f48893d22c2181bc54`; run [45189710689](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45189710689) | 34 tests ran; new tests failed because `measure_lexical_records` was absent |
| Scanner implementation | commit `1b233dc21a0ab01e87c8b8c41deb7aa16af35770` | Initial run exposed one incorrectly placed assertion in the test fixture; it was corrected without weakening production behavior |
| Corrected scanner run | commit `a00d6bf2429a43be3b6e99b291947a57b4fda545); run [45190587904](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45190587904) | 35/35 tests passed; lexical report supported |
| Additional mutation/boundary tests (RED) | commit `fb3c8b7205877ef8c15ac78d6c32b552855c0d16`; run [45190879754](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45190879754) | 39 tests ran; two guard tests failed because the gate function was absent |
| Fail-closed gate guard | commit `e413e894bc169e93e765c2f2fb0798a462fee4d2); run [45191014934](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45191014934) | 39/39 tests passed; both workflow jobs succeeded |

Final test output: `Ran 39 tests` / `OK`.

Adversarial cases include:
- a malformed CaseFolding row with one field missing increments the unexpected-shape count and is rejected by the fail-closed gate;
- a conforming CaseFolding row passes the same gate;
- a 4,096-byte line is accepted while a 4,097-byte line is rejected;
- a 32-field line is measurable while a 33-field line is rejected before splitting;
- UnicodeData fields containing the literal byte `#` are not stripped as comments;
- `@PartN` is a directive only for NormalizationTest, not property-style files;
- trailing delimiters in CaseFolding and NormalizationTest do not inflate field counts;
- unknown/document paths and mutable input buffers are rejected;
- source bytes remain unchanged.

## 5. Results

The final report was emitted by workflow run `45191014934`, commit `e413e894bc169e93e765c2f2fb0798a462fee4d2`.

- Raw source-lock and archive equality: supported for all nine source files.
- Lexically scanned data files: **8**.
- Total data records: **100,984**.
- Unexpected field-cardinality records: **0**.
- Lexical metrics SHA-256: `cab3b17d342b1132e2e53b0c1c6b52c429d5894c5cc9a3411faab058b330c552`.
- R1-U12-B raw-byte metrics SHA-256: `ab8ba59930d95b138767e865e23df85444a395a378d59663c7f1f52b59add955`.

| File | Physical lines | Data records | Field-count histogram | Blank | Comment-only | Directives | Trailing delimiter rows | Unexpected shapes |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| `PropList.txt` | 1,979 | 1,779 | 2: 1,779 | 115 | 85 | 0 | 0 | 0 |
| `DerivedCoreProperties.txt` | 13,857 | 13,601 | 2: 13,086; 3: 515 | 93 | 163 | 0 | 0 | 0 |
| `DerivedAge.txt` | 2,179 | 1,866 | 2: 1,866 | 150 | 163 | 0 | 0 | 0 |
| `extracted/DerivedGeneralCategory.txt` | 4,426 | 4,202 | 2: 4,202 | 123 | 101 | 0 | 0 | 0 |
| `UnicodeData.txt` | 41,341 | 41,341 | 15: 41,341 | 0 | 0 | 0 | 0 | 0 |
| `CaseFolding.txt` | 1,704 | 1,640 | 3: 1,640 | 3 | 61 | 0 | 1,640 | 0 |
| `DerivedNormalizationProps.txt` | 16,580 | 16,384 | 2: 1,823; 3: 14,561 | 79 | 117 | 0 | 0 | 0 |
| `NormalizationTest.txt` | 20,232 | 20,171 | 5: 20,171 | 0 | 55 | 6 | 20,171 | 0 |

`ReadMe.txt` has 19 physical lines and is not included in the eight-file lexical record total.

Additional measured boundaries:
- Maximum physical line: 586 bytes in `NormalizationTest.txt` (raw R1-U12-B metric).
- Maximum lexical record payload: 208 bytes in `UnicodeData.txt`.
- Maximum field payload: 100 bytes in `UnicodeData.txt`.
- Empty fields observed: 355,616 in `UnicodeData.txt` and 54 in `DerivedNormalizationProps.txt`; these are counted, not classified as invalid. Their semantics require a later field-specific parser.
- No shape anomalies were observed in the pinned source bytes.

The per-file field counts above are lexical cardinalities only. For example, a 15-field UnicodeData row is not thereby proven semantically valid, and empty optional fields are not an error under this gate.

## 6. Independent acquisition and provenance limits

The second job, `Independent curl and unzip reproduction`, succeeded. It re-downloaded the official archive and files through a separate shell/curl/unzip implementation and verified direct-file versus ZIP-member byte equality for all nine inputs.

This is implementation/job-environment separation, not an independent recalculation of the lexical metrics digest. Both jobs use the GitHub Actions control plane and the same Unicode publisher. Cross-cloud lexical-digest reproduction and independent-publisher attestation were not performed in R1-U12-C.

## 7. Security scan

For commit `e413e894bc169e93e765c2f2fb0798a462fee4d2`:
- Current-commit diff scan: **no leaks detected**.
- Full-history scan: **FAILED** after scanning 4,299 commits and finding nine historical `Generic API Key` detections in three existing paths:
  - `cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js` (six detections across lines 397 and 516);
  - `tools/9router-review/review.test.mjs` (one detection at line 1805);
  - `docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md` (two detections at lines 32 and 70).

Those detections remain unclassified. This report does not assert that they are live credentials or false positives. No secret values are reproduced here, and no credential rotation or historical rewrite was performed. This repository-level issue remains separate from the successful Unicode lexical job.

## 8. Gate disposition

| Gate | State |
|---|---|
| R1-U7 pinned source-lock checks | SUPPORTED |
| Direct source vs official UCD.zip byte equality | SUPPORTED |
| R1-U12-B raw-byte metrics | SUPPORTED |
| R1-U12-C lexical record metrics | SUPPORTED |
| Fail-closed field-cardinality gate | SUPPORTED |
| Cross-cloud lexical digest reproduction | NOT RUN |
| Independent publisher corroboration in this run | NOT ESTABLISHED |
| Full semantic UCD parser | NOT RUN |
| Cross-file semantic consistency | NOT RUN |
| Unicode normalization conformance execution | NOT RUN |
| ICU4J artifact trust/signing and runtime identity | NOT VERIFIED |
| SR-02 freeze | NOT APPROVED |
| Runtime/production approval | NOT APPROVED |

R1-U12-C disposition: **SUPPORTED as a bounded lexical structure subgate only**. This does not complete R1-U12 overall or authorize the next semantic/parser stage automatically.

## 9. Protected scope

The feature branch contains only the branch-scoped workflow implementation and this evidence document. No PR was opened, no merge or deployment was performed, and `main`, Production, the source manifest/source lock, generators, Cloudflare, Supabase, secrets, and the user's laptop were not modified.
