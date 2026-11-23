# R1-U12-D1 — Unicode 18.0.0 UnicodeData Semantic Invariants Evidence

- Date: 2026-11-23
- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Branch: `work/r1u12d1-unicodedata-semantic-2026-11-23`
- Tested implementation commit: `d250dd07b955947ba30ad9e4b21c01bc7258b3c8`
- GitHub Actions run: [45193987156](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45193987156)
- Workflow result: **SUCCESS**
- Semantic subgate: **SUPPORTED — UNICODEDATA.TXT SINGLE-FILE INVARIANTS ONLY**
- R1-U7 stable source-manifest SHA-256: `965655de97a82e6efc751d4e5f5c577c9c484eaf798af9a90f1a0203516ac27c`

## 1. Scope

R1-U12-D1 introduces a bounded, read-only semantic validator for the pinned Unicode 18.0.0 `UnicodeData.txt` source. It validates the 15-field record contract, field-level value domains, code-point syntax and ordering, local numeric invariants, decomposition syntax, simple case-mapping syntax, and adjacent First/Last range records.

The validator is intentionally limited to one source file. It does not:
- prove that a referenced decomposition or case-mapping code point is assigned or exists in another source file;
- validate the complete character-name derivation algorithms for Hangul, CJK ideographs, or all other algorithmic names;
- establish cross-file equivalence with `DerivedGeneralCategory.txt`, `DerivedNormalizationProps.txt`, `CaseFolding.txt`, or other files;
- implement the Unicode normalization algorithm or execute `NormalizationTest.txt`;
- establish ICU4J artifact identity, signatures, or runtime equivalence;
- authorize an R1-U12-wide completion, SR-02 freeze, runtime integration, PR merge, or production release.

The parser retains strict UTF-8 decoding and the existing 4,096-byte physical-line ceiling. It processes one physical line at a time and retains only bounded state for ordering, First/Last pairing, decimal digit runs, and aggregate counters. The source buffer itself remains immutable.

## 2. Normative basis and explicit format decisions

The checks were aligned to Unicode Standard Annex #44, Unicode 18.0.0, Revision 38:
- [UAX #44, current released revision](https://www.unicode.org/reports/tr44/) — Unicode 18.0.0, dated 2026-09-02, Revision 38;
- [Unicode 18.0.0 release components](https://www.unicode.org/versions/Unicode18.0.0/);
- [Versioned Unicode 18.0.0 UCD directory](https://www.unicode.org/Public/18.0.0/).

The relevant UAX #44 rules include:
- exactly 15 fixed fields for `UnicodeData.txt`, with no leading or trailing spaces in its fields;
- code-point syntax of four to six uppercase hexadecimal digits, without a `U+` prefix;
- First/Last paired range representation;
- the General_Category subtypes used in `UnicodeData.txt`; grouped aliases and `Cn` do not occur in this file;
- Bidi_Class enumerated values;
- Canonical_Combining_Class values from 0 through 254, with 133 reserved and 255 reserved for implementation use;
- Numeric_Type extraction from fields 6 through 8, including the contiguous ascending decimal digits 0 through 9 and the co-extensiveness of General_Category=Nd with Numeric_Type=Decimal;
- Numeric_Value integer or rational syntax for Numeric_Type=Numeric;
- compatibility decomposition tags, canonical mappings no longer than two code points, and compatibility mappings guaranteed no longer than 18 code points;
- single-code-point results for the simple uppercase, lowercase, and titlecase mapping fields.

These are version-pinned rules and value tables for the Unicode 18.0.0 source inventory; the hardcoded value sets are not claimed to be forward-compatible with a later Unicode release without review.

## 3. Semantic contract implemented

| Field(s) | Validation |
|---|---|
| 0 — Code_Point | Four to six uppercase hex digits; U+0000 through U+10FFFF; strictly increasing and unique |
| 1 — Name | Nonempty; First/Last range identifiers must pair by exact identifier and immediate adjacency |
| 2 — General_Category | Exact Unicode 18.0.0 subtype allowlist; grouped values and Cn rejected |
| 3 — Canonical_Combining_Class | Unsigned decimal integer 0..254; reserved value 133 rejected |
| 4 — Bidi_Class | Exact Unicode 18.0.0 Bidi_Class value allowlist |
| 5 — Decomposition_Mapping | Optional sequence of valid code points; optional known compatibility tag; canonical length <= 2; compatibility length <= 18 |
| 6–8 — Numeric fields | Valid field combinations and values; Decimal fields agree; Digit/ Numeric combinations conform to field semantics |
| 9 — Bidi_Mirrored | Exactly Y or N |
| 10–11 — Unicode_1_Name / ISO_Comment | Field boundaries and original bytes preserved; field-specific string semantics are not independently validated in this subgate |
| 12–14 — Simple case mappings | Each nonempty mapping is exactly one valid code point |

Additional record-level invariants:
- `General_Category=Nd` if and only if the derived Numeric_Type is Decimal.
- Decimal digit records form contiguous ascending code-point sequences with values 0 through 9, in order.
- A First range row must be followed immediately by a Last row with the same range identifier, a greater endpoint, and identical fields 2 through 14.
- Orphan Last rows, unmatched First rows, nonadjacent range endpoints, and mismatched endpoint properties fail closed.

## 4. TDD and adversarial evidence

The behavior was developed using recorded red-green cycles:

| Stage | Commit / run | Evidence |
|---|---|---|
| Semantic tests added before parser (RED) | commit `64fdb9fa6847624d4e73ad2fd75771162262f495`; run [45193074968](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45193074968) | 65 tests ran; new tests failed because `validate_unicode_data_semantics` was absent |
| First parser implementation | commit `c346192cbe6f2aada49521692cb576a01c132d26`; run [45193488423](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45193488423) | 24 of 25 new semantic test cases passed; decimal stream state bug exposed |
| State isolation correction | commit `a9870bd5f6aeea00dbf24311a24527bb71979593`; run [45193679214](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45193679214) | Follow-up exposed stale EOF reference to the former variable name |
| EOF and source-lock-label correction | commit `d250dd07b955947ba30ad9e4b21c01bc7258b3c8`; run [45193987156](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45193987156) | **65/65 tests passed**; both workflow jobs succeeded |

The final test output was `Ran 65 tests` / `OK`.

The 25 new semantic test cases exercise:
- valid 15-field records, empty input, blank records, wrong field counts, and invalid hexadecimal syntax;
- out-of-range, duplicate, and descending code points;
- unknown, grouped, and unassigned General_Category values;
- CCC boundary values and reserved 133;
- invalid Bidi_Class values;
- valid and invalid compatibility tags, canonical and compatibility mapping lengths;
- all Numeric_Type field combinations, equal numeric representations, signed rational values, and zero denominators;
- binary Bidi_Mirrored values and one-code-point simple case mappings;
- valid First/Last ranges, orphan endpoints, identifier mismatches, nonadjacency, and endpoint-property mismatch;
- leading and trailing whitespace;
- incomplete and nonascending decimal digit groups.

The two implementation defects were retained as recorded failures and corrected in subsequent commits. No test assertion was weakened to obtain a green result.

## 5. Results against the pinned Unicode 18.0.0 source

Final evidence was emitted by workflow run `45193987156`, commit `d250dd07b955947ba30ad9e4b21c01bc7258b3c8`.

Source identity:
- `UnicodeData.txt` exact byte length: **2,243,593**
- `UnicodeData.txt` SHA-256: `0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950`
- stable R1-U7 manifest digest reproduced: `965655de97a82e6efc751d4e5f5c577c9c484eaf798af9a90f1a0203516ac27c`
- raw-byte metrics SHA-256 unchanged from R1-U12-B: `ab8ba59930d95b138767e865e23df85444a395a378d59663c7f1f52b59add955`
- lexical metrics SHA-256 unchanged from R1-U12-C: `cab3b17d342b1132e2e53b0c1c6b52c429d5894c5cc9a3411faab058b330c552`

Semantic metrics SHA-256:

`23db756c461df67f7c96c24490d2affc70d707a8d4cd11dc86fb7011debfccca`

| Metric | Observed value |
|---|---:|
| Records validated | 41,341 |
| First/Last range pairs | 22 |
| Complete decimal digit sets | 77 |
| Maximum decomposition mapping length | 18 |
| Maximum Canonical_Combining_Class | 240 |
| Unexpected semantic invariant failures | 0 |

Numeric_Type distribution:

| Numeric_Type | Records |
|---|---:|
| Decimal | 770 |
| Digit | 128 |
| Numeric | 1,365 |
| None | 39,078 |
| **Total** | **41,341** |

General_Category distribution:

| Category | Count | Category | Count |
|---|---:|---|---:|
| Cc | 65 | Cf | 170 |
| Co | 6 | Cs | 6 |
| Ll | 2,366 | Lm | 473 |
| Lo | 21,852 | Lt | 31 |
| Lu | 1,906 | Mc | 477 |
| Me | 13 | Mn | 2,090 |
| Nd | 770 | Nl | 562 |
| No | 915 | Pc | 10 |
| Pd | 27 | Pe | 78 |
| Pf | 10 | Pi | 12 |
| Po | 643 | Ps | 80 |
| Sc | 67 | Sk | 127 |
| Sm | 1,005 | So | 7,561 |
| Zl | 1 | Zp | 1 |
| Zs | 17 | | |

The General_Category counts sum to 41,341, matching the record count. The Numeric_Type counts also sum to 41,341. The complete metrics are emitted in the Actions report; raw Unicode source rows are not written to logs or uploaded as artifacts.

## 6. Review and independent acquisition

- GitHub connector: inspected the exact feature branch, pinned source manifest, workflow commits, job states, and CI logs; used compare-and-swap updates when moving the branch reference.
- Code Tytor Python expert review: reviewed the extracted semantic validator for security, performance, bugs, complexity, style, and tests. It returned one low-severity style suggestion about lowercase function naming. That suggestion is disputed as not applicable: `unicode_data_error`, `parse_unicode_code_point`, `parse_unicode_numeric`, and `validate_unicode_data_semantics` already follow lowercase snake_case. It was not converted into an unnecessary code change.
- Independent curl/unzip job: **SUCCESS**. It reacquired the archive and compared all nine direct source files to their UCD.zip members.
- The shell job does not independently reimplement or reproduce the semantic parser or its digest. Cross-cloud semantic digest reproduction was not run. Both jobs execute under the GitHub Actions control plane; this is not independent-publisher corroboration.

## 7. Separate repository security finding

For the implementation commit:
- Current commit diff scan: **no leaks detected**.
- Full-history Gitleaks scan: **FAILED** after scanning 4,309 commits and finding nine historical `Generic API Key` detections in three pre-existing paths:
  - `cloud-engineering-connector/cloudflare-test/orchestrator-owner-command.test.js` (six detections, lines 397 and 516);
  - `tools/9router-review/review.test.mjs` (one detection, line 1805);
  - `docs/MASTER_BRAIN_GATE2P_R1U17_ICU79_SIGNING_IDENTITY_CANDIDATE_RECONCILIATION_2026-11-16.md` (two detections, lines 32 and 70).

The nine historical detections remain unclassified. This report does not assert that they are real credentials or false positives. No values are reproduced, no credential was rotated, and no historical rewrite was performed. This repository-level security issue is separate from the successful Unicode workflow.

## 8. Gate disposition

| Gate | State |
|---|---|
| R1-U7 pinned source lock | SUPPORTED |
| R1-U12-B raw-byte metrics | SUPPORTED |
| R1-U12-C lexical structure metrics | SUPPORTED |
| R1-U12-D1 UnicodeData single-file semantic invariants | SUPPORTED |
| TDD and adversarial semantic tests | SUPPORTED — 65/65 |
| Direct-file versus UCD.zip byte equality | SUPPORTED — nine of nine |
| Cross-cloud semantic digest reproduction | NOT RUN |
| Independent-publisher corroboration | NOT ESTABLISHED |
| Cross-file semantic consistency | NOT RUN |
| Full Unicode UCD parser | NOT COMPLETE |
| Unicode normalization conformance | NOT RUN |
| ICU4J artifact trust/signing and runtime identity | NOT VERIFIED |
| SR-02 freeze | NOT APPROVED |
| Runtime/production approval | NOT APPROVED |

R1-U12-D1 disposition: **SUPPORTED for the pinned Unicode 18.0.0 `UnicodeData.txt` local semantic invariants only**. This is not a general parser or a release approval.

## 9. Protected scope

Only the branch-scoped workflow and this evidence document are changed on the D1 branch. No PR was opened, no merge or deployment was performed, and `main`, Production, the source manifest/source lock, generator, runtime, Cloudflare, Supabase, secrets, and the user's laptop were not modified.
