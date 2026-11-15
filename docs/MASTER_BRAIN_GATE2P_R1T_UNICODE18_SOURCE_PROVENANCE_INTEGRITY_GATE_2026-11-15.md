# Master Brain — Gate 2P / R1-T: Unicode 18.0.0 Source Provenance and Artifact Integrity Gate

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Document ID:** MB-G2P-R1T-UNICODE18-SOURCE-PROVENANCE-2026-11-15  
**Status:** SOURCE INVENTORY RECORDED — RAW ARTIFACT INTEGRITY BLOCKED — NOT VERIFIED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Policy input:** R1-R owner-approved FC-3 v1 manifest  
**Normative baseline:** Unicode 18.0.0  
**Security reference:** UTS #39 Revision 34

## 1. Objective

Establish an immutable, reproducible provenance chain for every Unicode data artifact that influences SR-02 path admission, normalization, case-fold collision comparison, assignedness, control classification, and FC-3 membership.

This gate distinguishes:
- official source identity and version;
- raw artifact bytes;
- cryptographic integrity;
- parser and derivation reproducibility;
- generated policy manifest identity.

A versioned URL or web directory listing is not a cryptographic checksum. A displayed approximate file size is not an exact byte length.

## 2. Official source inventory

All source URLs below are pinned to the Unicode 18.0.0 version path. The authoritative release page identifies Unicode 18.0.0 and its UCD as part of the release.

| Artifact | Exact official URL | Intended use | Required evidence |
|---|---|---|---|
| UCD ReadMe | `https://www.unicode.org/Public/18.0.0/ucd/ReadMe.txt` | Release/version and UCD guidance | raw bytes, length, SHA-256 |
| PropList | `https://www.unicode.org/Public/18.0.0/ucd/PropList.txt` | Noncharacter_Code_Point, Bidi_Control, Join_Control | raw bytes, length, SHA-256 |
| DerivedCoreProperties | `https://www.unicode.org/Public/18.0.0/ucd/DerivedCoreProperties.txt` | Default_Ignorable_Code_Point and related derived properties | raw bytes, length, SHA-256 |
| DerivedAge | `https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt` | Age=Unassigned decisions | raw bytes, length, SHA-256 |
| DerivedGeneralCategory | `https://www.unicode.org/Public/18.0.0/ucd/extracted/DerivedGeneralCategory.txt` | General_Category checks, including Cc/Cf/Mn | raw bytes, length, SHA-256 |
| UnicodeData | `https://www.unicode.org/Public/18.0.0/ucd/UnicodeData.txt` | Character names and base properties; parser cross-check | raw bytes, length, SHA-256 |
| CaseFolding | `https://www.unicode.org/Public/18.0.0/ucd/CaseFolding.txt` | Full default case folding C/F mappings | raw bytes, length, SHA-256 |
| DerivedNormalizationProps | `https://www.unicode.org/Public/18.0.0/ucd/DerivedNormalizationProps.txt` | NFC and normalization-related derived properties | raw bytes, length, SHA-256 |
| NormalizationTest | `https://www.unicode.org/Public/18.0.0/ucd/NormalizationTest.txt` | Normalization conformance vectors | raw bytes, length, SHA-256 |

Versioned release page: `https://www.unicode.org/versions/Unicode18.0.0/`  
Official UCD directory: `https://www.unicode.org/Public/18.0.0/ucd/`  
Official extracted-data directory: `https://www.unicode.org/Public/18.0.0/ucd/extracted/`

## 3. Acquisition attempt and result

The official Unicode 18.0.0 UCD directory was discoverable through web retrieval. The directory listing showed the expected versioned artifacts, including PropList, DerivedCoreProperties, DerivedAge, CaseFolding, UnicodeData, and extracted/DerivedGeneralCategory.

A direct raw download attempt for:

`https://www.unicode.org/Public/18.0.0/ucd/PropList.txt`

from the available container download path failed before bytes were obtained.

**Observed result:** download failed.  
**Not established:** HTTP status, response body, exact byte count, SHA-256, TLS transcript, or raw artifact content.  
**Do not infer:** a valid download, file integrity, or checksum from the web directory listing.

The failure is recorded as an environment/network acquisition limitation, not as a Unicode source defect.

## 4. Integrity status

| Artifact | Official versioned URL found | Raw bytes acquired | Exact byte length | SHA-256 | Status |
|---|---:|---:|---:|---:|---|
| ReadMe.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| PropList.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| DerivedCoreProperties.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| DerivedAge.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| extracted/DerivedGeneralCategory.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| UnicodeData.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| CaseFolding.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| DerivedNormalizationProps.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |
| NormalizationTest.txt | YES | NO | UNKNOWN | UNKNOWN | BLOCKED |

No checksum has been fabricated or inferred. No file length has been copied from a rounded directory-listing size and represented as exact.

## 5. Required acquisition protocol

When a trusted acquisition environment is available:

1. Download each exact versioned URL over HTTPS.
2. Save the response bytes without newline conversion, text decoding/re-encoding, decompression ambiguity, or editor modification.
3. Record final URL, retrieval timestamp in UTC, HTTP status, content type, content length header if present, and TLS validation result.
4. Independently calculate exact byte length from the saved byte array.
5. Calculate SHA-256 over the exact saved bytes.
6. Compare the independently acquired artifacts from a second network path or trusted mirror, while treating the official Unicode URL as the normative source.
7. Confirm the header/version markers inside each file.
8. Store the raw artifact outside the application source tree or in a controlled, immutable evidence location. Do not commit unverified large source artifacts merely to make the process appear complete.
9. Have a second reviewer reproduce the hashes and lengths independently.
10. Only then generate a signed or content-addressed source lock record.

A mirror may help detect corruption but must not silently replace the official source. Any mismatch is a hard stop requiring investigation.

## 6. Deterministic source-lock record requirements

After acquisition, create a source lock with one entry per file:

- logical artifact identifier;
- exact versioned URL;
- final URL after redirects;
- Unicode version;
- exact byte length as an integer;
- SHA-256 lowercase hexadecimal digest;
- raw response media type;
- retrieval timestamp;
- acquisition tool and version;
- TLS verification outcome;
- internal file header/version verification;
- independent reviewer identity/attestation;
- second acquisition comparison result.

The source-lock file itself must be canonicalized and hashed. Do not include volatile retrieval timestamps in the semantic identity of the generated FC-3 membership manifest; keep provenance metadata and semantic policy identity distinct.

## 7. Derivation and independent reproduction protocol

Once source hashes are verified:

1. Parse source files as strict UTF-8; reject malformed byte sequences.
2. Preserve raw source bytes as the integrity subject.
3. Parse comments and property ranges according to the exact UCD file syntax and version.
4. Generate a deterministic normalized internal representation.
5. Verify exact membership for FC-3 and explicit exclusions.
6. Generate a canonical machine-readable manifest with sorted code points and stable reason codes.
7. Generate a separate provenance record binding the manifest digest to all source artifact digests.
8. Re-run the generator independently using a second implementation or reviewer.
9. Compare generated outputs byte-for-byte.
10. Any mismatch blocks freeze; do not resolve mismatches by choosing the output that happens to match expectations.

The generator must not rely on the host runtime's Unicode database. It must use the pinned UCD source artifacts.

## 8. Required falsification checks

- A wrong-version file must fail header/version validation.
- A one-byte artifact mutation must change SHA-256.
- A file with same displayed rounded size but different bytes must fail digest equality.
- CRLF/LF conversion must change the raw-byte digest and be detected.
- A parser that silently ignores malformed or unknown property syntax must fail.
- A generator using latest/runtime Unicode tables instead of pinned 18.0.0 data must fail provenance validation.
- A second independent generator producing a different manifest must block approval.
- A manifest containing U+2065 as FC-3 or including U+2066..U+2069 in FC-3 must fail exact membership validation.
- A manifest that omits U+034F or accidentally includes U+180B..U+180D/U+180F must fail.
- U+200B must remain REJECT until DISP-1 is independently verified and a new explicit owner decision is recorded.

## 9. Evidence state

- Unicode 18.0.0 versioned release page: DISCOVERED.
- Official UCD versioned directory: DISCOVERED.
- Required artifact names and URLs: INVENTORIED.
- Raw UCD acquisition: BLOCKED.
- Exact byte lengths: UNKNOWN.
- SHA-256: UNKNOWN.
- Header/version verification: NOT RUN.
- Source parser: NOT IMPLEMENTED.
- Manifest regeneration: NOT RUN.
- Independent reproduction: NOT RUN.
- Independent R1-G review: NOT RECEIVED.
- SR-02 freeze: NOT APPROVED.
- Runtime implementation: NOT AUTHORIZED.

## 10. Gate decision

**R1-T result: BLOCKED — SOURCE ARTIFACT INTEGRITY NOT VERIFIED.**

The correct next operation is to acquire exact official Unicode 18.0.0 source bytes in a trusted network-enabled environment, compute and independently reproduce lengths and hashes, then proceed to R1-U deterministic manifest generation.

Do not use guessed hashes, third-party snippets, browser-rendered text, rounded file sizes, or the host runtime Unicode database as substitutes.

No code, PR, merge, deployment, Cloudflare, Supabase, secret, or laptop operation is authorized by this document.
