# Master Brain — Gate 2P / R1-U1: Unicode 18.0.0 UCD Content Acquisition and Property Consistency Audit

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Document ID:** MB-G2P-R1U1-UCD-CONTENT-ACQUISITION-AUDIT-2026-11-15  
**Status:** VERSIONED CONTENT RETRIEVED — SELECTED PROPERTY COUNTS REPRODUCED ON RETRIEVED REPRESENTATION — RAW BYTE INTEGRITY NOT VERIFIED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Baseline:** Unicode 18.0.0  
**Security standard:** UTS #39 Revision 34

## 1. Objective

Continue R1-T by acquiring the official version-pinned UCD text through an alternate retrieval path, checking version headers and content termination, and independently recounting selected properties relevant to SR-02.

This audit deliberately separates:
1. HTTP retrieval success;
2. version-header and content-structure checks;
3. property parsing and membership checks;
4. exact raw HTTP byte acquisition;
5. cryptographic integrity and independent reproduction.

Only the first three have partial evidence in this stage.

## 2. Retrieval method and limitations

The official Unicode text files were fetched through Firecrawl's live URL scraping interface with cache bypass requested. Returned metadata for the inspected files reported:
- HTTP status 200;
- `text/plain; charset=utf-8`;
- source URL matching the exact Unicode 18.0.0 versioned path;
- content text exposed as a returned text representation.

The retrieval service returns a text representation. Its contract does not establish that the returned string is byte-for-byte identical to the original HTTP entity body. It may decode, normalize, or otherwise represent content. Therefore:
- character counts below are representation character counts, not exact source byte lengths;
- no SHA-256 is claimed for the original UCD file;
- no cryptographic integrity gate is passed;
- no claim of byte-preserving acquisition is made.

## 3. Retrieved source inventory

| Artifact | Official version-pinned URL | HTTP | Header / structure check | Returned representation chars | Status |
|---|---|---:|---|---:|---|
| PropList.txt | `https://www.unicode.org/Public/18.0.0/ucd/PropList.txt` | 200 | `PropList-18.0.0.txt`; `# EOF` present | 149,038 | CONTENT RETRIEVED |
| DerivedAge.txt | `https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt` | 200 | `DerivedAge-18.0.0.txt`; `# EOF` present | 142,566 | CONTENT RETRIEVED |
| DerivedCoreProperties.txt | `https://www.unicode.org/Public/18.0.0/ucd/DerivedCoreProperties.txt` | 200 | `DerivedCoreProperties-18.0.0.txt`; `# EOF` present | 1,159,887 | CONTENT RETRIEVED |
| CaseFolding.txt | `https://www.unicode.org/Public/18.0.0/ucd/CaseFolding.txt` | 200 | `CaseFolding-18.0.0.txt`; `# EOF` present | 88,773 | CONTENT RETRIEVED |
| DerivedGeneralCategory.txt | `https://www.unicode.org/Public/18.0.0/ucd/extracted/DerivedGeneralCategory.txt` | 200 | `DerivedGeneralCategory-18.0.0.txt`; `# EOF` present | 282,141 | CONTENT RETRIEVED |
| DerivedNormalizationProps.txt | `https://www.unicode.org/Public/18.0.0/ucd/DerivedNormalizationProps.txt` | 200 | `DerivedNormalizationProps-18.0.0.txt`; `# EOF` present | 1,396,875 | CONTENT RETRIEVED |
| ReadMe.txt | `https://www.unicode.org/Public/18.0.0/ucd/ReadMe.txt` | 200 | UCD ReadMe header present; no `# EOF` marker expected/observed | 727 | CONTENT RETRIEVED |
| UnicodeData.txt | `https://www.unicode.org/Public/18.0.0/ucd/UnicodeData.txt` | 200 | Data records begin with UnicodeData record syntax; no `# EOF` marker expected/observed | 2,243,593 | CONTENT RETRIEVED |
| NormalizationTest.txt | `https://www.unicode.org/Public/18.0.0/ucd/NormalizationTest.txt` | 200 | `NormalizationTest-18.0.0.txt`; `# EOF` present | 2,447,016 | CONTENT RETRIEVED |

These counts describe the returned representation only. They must not be copied into a raw-source byte-length lock.

## 4. Recounted property totals

A separate parser pass over the returned text representation selected the target property rows, parsed hexadecimal singleton/range syntax, and summed inclusive code-point ranges.

| Property | Source | Ranges | Code points |
|---|---|---:|---:|
| Noncharacter_Code_Point | PropList.txt | 18 | 66 |
| Bidi_Control | PropList.txt | 4 | 12 |
| Join_Control | PropList.txt | 1 | 2 |
| Default_Ignorable_Code_Point | DerivedCoreProperties.txt | 27 | 4,174 |

The observed Bidi_Control ranges are:
- U+061C
- U+200E..U+200F
- U+202A..U+202E
- U+2066..U+2069

The observed Join_Control range is:
- U+200C..U+200D

The noncharacter property count is consistent with the previously documented 66 code points in 18 ranges.

## 5. General_Category recount

The extracted DerivedGeneralCategory data was parsed separately. Inclusive range totals for the requested categories were:

| General_Category | Code points |
|---|---:|
| Cc | 65 |
| Cf | 170 |
| Mn | 2,090 |

This is a parser-derived count from the returned text representation. It is not a substitute for independent raw-source verification.

## 6. FC-3 cross-property membership checks

The returned property data was checked for the exact FC-3 candidate code points and important exclusions.

| Code point | DICP | Bidi_Control | Join_Control | FC-3 / other policy note |
|---|---:|---:|---:|---|
| U+00AD | YES | NO | NO | FC-3 reject |
| U+034F | YES | NO | NO | FC-3 reject; General_Category Mn |
| U+180E | YES | NO | NO | FC-3 reject |
| U+200B | YES | NO | NO | FC-3 reject pending DISP-1 and new owner decision |
| U+2060 | YES | NO | NO | FC-3 reject |
| U+2061..U+2064 | YES | NO | NO | FC-3 reject in repository paths only |
| U+206A..U+206F | YES | NO | NO | FC-3 reject |
| U+FEFF | YES | NO | NO | FC-3 reject in decoded path value |
| U+2066..U+2069 | YES | YES | NO | Rejected by BC-1, not FC-3 membership |
| U+200C..U+200D | YES | NO | YES | JC-2 contextual admission only |
| U+2065 | YES in returned DICP data | NO | NO | No explicit DerivedAge record found; Age-based unassignedness remains the controlling separate check |

### Important interpretation

Property sets overlap. In particular, Default_Ignorable_Code_Point is not an assignedness property and must not be used as a proxy for Age or General_Category. U+2065 illustrates why policy evaluation must preserve separate property provenance and reason codes.

The absence of a U+2065 record in the returned DerivedAge data is consistent with the existing Age=Unassigned policy, but a full version-pinned parser and independent verification are still required before freezing that rule.

## 7. CaseFolding status distribution

The returned CaseFolding text was parsed by status field. Observed record counts:

| Status | Records |
|---|---:|
| C | 1,501 |
| F | 105 |
| S | 32 |
| T | 2 |

The proposed SR-02 collision-key operation continues to require full default case folding using C and F mappings only. S-only mappings are not substituted for full mappings; T mappings are excluded from default folding.

These counts are content-parser observations, not a conformance test or proof that a future implementation consumes the correct mapping set.

## 8. UTS #39 Revision 34 status reconciliation

The official UTS #39 Revision 34 page identifies:
- Version 18.0.0;
- Revision 34;
- date 2026-08-27;
- status: reviewed, approved for publication, stable;
- modification: reissued for Unicode 18.0.0;
- A1 joining-control context changed so that a Transparent character is not allowed after ZWNJ.

The Unicode 18.0.0 release page lists UTS #39 among the synchronized standards updated to Version 18.0.

This supports using UTS #39 Revision 34 as the version-matched security reference. It does not mean SR-02 conforms to all of UTS #39; the repository-path profile is a distinct application-specific policy.

Official references:
- `https://www.unicode.org/reports/tr39/tr39-34.html`
- `https://www.unicode.org/versions/Unicode18.0.0/`

## 9. Checks not passed

| Check | Result |
|---|---|
| Version-pinned URLs | VERIFIED |
| HTTP 200 retrieval metadata | VERIFIED for listed retrievals |
| Version headers | VERIFIED for files with versioned headers |
| EOF markers | VERIFIED where applicable |
| Selected property parser counts | REPRODUCED on returned representation |
| Exact raw HTTP body bytes | NOT ACQUIRED |
| Exact byte lengths | NOT VERIFIED |
| SHA-256 of official raw artifacts | NOT VERIFIED |
| Independent second-source raw-byte reproduction | NOT RUN |
| Unicode normalization conformance tests | NOT RUN |
| Cross-runtime Unicode 18.0.0 behavior | NOT RUN |
| Deterministic FC-3 manifest regeneration | NOT RUN |
| Independent R1-G review | NOT RECEIVED |

## 10. Falsification requirements

Before R1-U can pass:
1. Obtain exact raw bytes through a byte-preserving acquisition method.
2. Independently calculate SHA-256 and exact byte length for each source file.
3. Compare with a second independent acquisition.
4. Verify all file headers, parser assumptions, range syntax, and property totals from the raw bytes.
5. Confirm the U+2065 Age result using a complete DerivedAge parser and the full Unicode code-point domain.
6. Reproduce the FC-3 manifest from pinned sources in a deterministic generator.
7. Have an independent reviewer reproduce the outputs byte-for-byte.

Any mismatch in property counts, file identity, or generated manifest is a hard stop.

## 11. Gate decision

**R1-U1: PARTIAL PASS FOR CONTENT ACCESS AND SELECTED PROPERTY CONSISTENCY; RAW ARTIFACT INTEGRITY BLOCKED.**

The official UCD source text is now accessible through an alternate retrieval path and selected property counts match the previously recorded expectations. This does not pass the cryptographic provenance gate.

- FC-3 owner policy: APPROVED.
- UCD content retrieval: PARTIAL PASS.
- Property count checks on returned representation: PASS.
- Raw byte integrity: NOT VERIFIED.
- Manifest regeneration: NOT RUN.
- SR-02 freeze: NOT APPROVED.
- Implementation and tests: NOT AUTHORIZED.
- PR/merge/deploy: NOT AUTHORIZED.

No source code, Cloudflare, Supabase, secrets, local laptop, or main-branch changes are included in this stage.
