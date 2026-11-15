# Master Brain — Gate 2P / R1-U2: Deterministic UCD Parser and Manifest Reproduction Contract

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Document ID:** MB-G2P-R1U2-UCD-PARSER-MANIFEST-REPRODUCTION-CONTRACT-2026-11-15  
**Status:** DESIGN SPECIFICATION — PROPOSED — NOT IMPLEMENTED — TESTS NOT RUN  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Inputs:** R1-R owner decision; R1-S FC-3 JSON manifest; R1-T provenance gate; R1-U1 content acquisition audit

## 1. Objective and boundary

Define the deterministic parser, source-lock, and manifest-reproduction requirements that must be met after exact raw Unicode 18.0.0 UCD bytes are acquired and verified.

This document does not implement a parser, alter the current manifest, authorize source code changes, or pass the raw-byte provenance gate.

## 2. Normative input set

The parser may consume only files whose exact raw bytes have a verified source-lock entry:
- PropList.txt
- DerivedCoreProperties.txt
- DerivedAge.txt
- extracted/DerivedGeneralCategory.txt
- UnicodeData.txt
- CaseFolding.txt
- DerivedNormalizationProps.txt
- NormalizationTest.txt

Each file must be pinned to the official Unicode 18.0.0 version path. A file missing from the source lock, with a mismatched digest, invalid header, or mismatched Unicode version MUST cause a hard failure.

UTS #39 Revision 34 is a separate stable security reference and must be pinned independently. It must not be silently conflated with UCD file provenance.

## 3. Raw source acquisition contract

The source acquisition stage must:
1. preserve exact HTTP entity-body bytes;
2. reject implicit text decoding/re-encoding as the integrity input;
3. record the exact URL, final URL, HTTP status, media type, retrieval timestamp, and TLS validation;
4. calculate exact byte length from the acquired byte array;
5. calculate SHA-256 over those exact bytes;
6. compare a second independent acquisition;
7. validate the file's internal version header and expected syntax;
8. store the bytes and source-lock record in a controlled immutable evidence location.

A scraper's Markdown, HTML, decoded string, browser rendering, character count, or rounded directory size is not an acceptable raw-byte integrity input.

## 4. Parser architecture

Use a two-stage parser:

### Stage A — lexical and structural validation

- Input is raw bytes from the verified source lock.
- Decode strict UTF-8 only after byte-level verification.
- Reject malformed UTF-8, unexpected BOMs where not permitted, and malformed line structure.
- Parse comments separately from data records.
- Parse semicolon-delimited fields without silently trimming or rewriting code point values.
- Validate hexadecimal syntax, field count, property name, range ordering, and scalar/code point bounds.
- Reject duplicate or overlapping records where the file format and property semantics do not explicitly permit them.
- Reject unknown property values rather than silently ignoring them.
- Preserve source line number and source artifact identity for every parsed record.

### Stage B — semantic property model

Create an immutable internal representation keyed by:
- source artifact digest;
- Unicode version;
- property name;
- inclusive code-point range;
- source line number;
- source record digest or stable record identity.

All derived decisions must retain provenance to the source record(s). Overlapping policy reasons must be retained as a set, not collapsed to a single winner.

## 5. Property derivation rules

### 5.1 Noncharacter_Code_Point

- Read from PropList.txt.
- Expand ranges inclusively.
- Verify 18 source ranges and 66 code points against the expected Unicode 18.0.0 result.
- The expected total is a cross-check, not a hard-coded replacement for parsing.

### 5.2 Bidi_Control and Join_Control

- Read from PropList.txt.
- Verify Bidi_Control has 12 code points in 4 ranges.
- Verify Join_Control has 2 code points in 1 range.
- Do not infer either property from General_Category=Cf.

### 5.3 Default_Ignorable_Code_Point

- Read from DerivedCoreProperties.txt.
- Verify 4,174 code points in 27 ranges.
- Treat as an independent property, not an assignedness or General_Category proxy.
- Do not blanket-reject all DICP as a consequence of this count.

### 5.4 General_Category

- Read from the version-pinned DerivedGeneralCategory and cross-check against UnicodeData where applicable.
- Independently derive Cc, Cf and Mn sets.
- Expected Unicode 18.0.0 counts from the retrieved text representation: Cc=65, Cf=170, Mn=2,090.
- Preserve the distinction between Cc, Cf, Mn and property sets such as Bidi_Control, Join_Control and DICP.

### 5.5 Age=Unassigned

- DerivedAge lists assigned code points and their age values; it is not a row-by-row explicit list of all unassigned code points.
- Parse and validate the entire DerivedAge data set.
- Derive the unassigned set only as the complement of the correctly parsed assigned coverage over the defined Unicode code-point domain.
- Explicitly handle surrogates and noncharacters according to the source semantics; strict UTF-8 admission independently rejects surrogate encodings.
- U+2065 must be confirmed as absent from assigned coverage in the exact pinned source set. Do not infer it from DICP or General_Category alone.

### 5.6 Full default case folding

- Read CaseFolding.txt.
- Apply C and F mappings for default full case folding.
- Do not use S mappings as a fallback.
- Exclude T mappings from default folding.
- Confirm all code points not listed map to themselves as specified by the file.
- Preserve the exact mapping sequence; do not use host runtime case conversion.

### 5.7 Normalization

- Pin DerivedNormalizationProps and NormalizationTest to Unicode 18.0.0.
- Implement or consume a normalization engine whose Unicode data dependency is the same pinned source set.
- Do not call the host runtime's unpinned normalize/casefold functions as the normative implementation.
- Verify all applicable NormalizationTest vectors before the profile can claim NFC/NFD correctness.
- The proposed canonical caseless collision key remains:
  `UTF8(NFD(DefaultFullCaseFold(NFD(P))))`
- This expression is a collision comparison key only; it must never rewrite the accepted Git path.

## 6. FC-3 v1 derivation

The generator must consume the R1-R owner decision and R1-S manifest as separate inputs.

Exact owner-approved outcomes remain:
- U+00AD REJECT
- U+034F REJECT
- U+180E REJECT
- U+200B REJECT until DISP-1 is independently verified and a new owner decision is recorded
- U+2060 REJECT
- U+2061..U+2064 REJECT in repository paths only
- U+206A..U+206F REJECT
- U+FEFF REJECT in decoded path values; transport BOM handling remains a separate decoder-boundary concern

Explicit exclusions remain:
- U+2065: Age=Unassigned handling
- U+2066..U+2069: BC-1
- U+200C/U+200D: JC-2
- U+180B..U+180D and U+180F: not included by the U+180E decision

No broad U+2060..U+206F range may be emitted. Every code point must be an explicit singleton or part of a semantically exact range with complete provenance. FC-3 applies to repository path values only.

## 7. Deterministic manifest serialization

The generator must:
- use a documented canonical JSON profile;
- define UTF-8 encoding, no BOM, LF line endings, and final newline behavior;
- define object-key ordering;
- define array ordering (ascending numeric code point, then stable reason-code order);
- forbid duplicate JSON keys;
- reject non-finite numbers;
- use exact integer code point values and canonical uppercase U+ notation in human-readable fields;
- preserve stable schema and policy version fields;
- exclude volatile retrieval timestamps from semantic policy identity;
- place acquisition metadata and source digests in a separate provenance lock;
- generate the same bytes and digest from identical verified inputs.

The selected canonical JSON algorithm and exact serializer version remain a pre-freeze decision. This document does not silently choose RFC 8785 or another serializer.

## 8. Adversarial test catalogue

All cases below are REQUIRED future tests. They are NOT RUN.

| ID | Adversarial input or mutation | Expected result |
|---|---|---|
| U2-001 | One-byte source mutation | Source SHA-256 mismatch; hard fail |
| U2-002 | Correct filename, wrong Unicode header | Hard fail |
| U2-003 | UTF-8 malformed sequence | Hard fail |
| U2-004 | Duplicate property record | Hard fail unless explicitly permitted by format semantics |
| U2-005 | Reversed range endpoint | Hard fail |
| U2-006 | Range exceeds U+10FFFF | Hard fail |
| U2-007 | Unknown property value | Hard fail |
| U2-008 | CRLF conversion of raw source | Raw digest mismatch |
| U2-009 | Rounded directory size used as byte length | Reject evidence |
| U2-010 | U+2065 treated as assigned because DICP=Yes | Fail; assignedness must be derived independently |
| U2-011 | U+2066..U+2069 emitted in FC-3 | Fail; BC-1 owns these |
| U2-012 | U+200C/U+200D blanket-rejected without JC-2 distinction | Fail against owner decision |
| U2-013 | U+180B..U+180D or U+180F included due to broad range | Fail |
| U2-014 | U+2065 included in FC-3 | Fail |
| U2-015 | U+200B changed to ALLOW without new owner decision | Fail |
| U2-016 | S mapping used when F mapping exists | Fail |
| U2-017 | T mapping applied to default full fold | Fail |
| U2-018 | Host runtime Unicode database used | Fail provenance |
| U2-019 | Non-NFC path silently normalized | Fail |
| U2-020 | Accepted path representation rewritten | Fail |
| U2-021 | JSON duplicate keys | Hard fail |
| U2-022 | Unstable object/array ordering | Reproducibility fail |
| U2-023 | Two independent generators differ byte-for-byte | Freeze blocked |
| U2-024 | Same verified source lock yields different manifest digest | Freeze blocked |
| U2-025 | DICP treated as equivalent to Cf or Age | Fail property-model validation |
| U2-026 | Multi-policy match drops one reason code | Fail provenance completeness |

## 9. Independent reproduction requirements

An independent reviewer must receive:
- exact raw source artifacts;
- source-lock file and verification procedure;
- parser contract and generator source;
- exact R1-R owner decision blob;
- exact R1-S manifest blob;
- all test vectors and expected outcomes;
- generated manifest and provenance lock.

The reviewer must independently:
1. verify every raw source hash and byte length;
2. run or independently implement the parser;
3. reproduce property counts and FC-3 membership;
4. verify all exclusions and overlap reason codes;
5. regenerate canonical JSON;
6. compare outputs byte-for-byte;
7. attempt to falsify the profile with the adversarial catalogue;
8. report unresolved, disputed, and unknown results separately.

A reviewer who only reads the prose or confirms the expected counts is not an independent reproduction.

## 10. Current gate state

- Official Unicode 18.0.0 release: SUPPORTED.
- UTS #39 Revision 34 status: stable and approved for publication.
- Version-pinned source text retrieval through Firecrawl: PARTIAL PASS.
- Selected property totals on returned representation: PASS.
- Exact raw source bytes: NOT ACQUIRED.
- SHA-256 and exact byte lengths: NOT VERIFIED.
- Parser implementation: NOT IMPLEMENTED.
- Test catalogue: SPECIFIED, NOT RUN.
- Manifest regeneration: NOT RUN.
- Independent R1-G review: NOT RECEIVED.
- SR-02 freeze: NOT APPROVED.
- Runtime implementation: NOT AUTHORIZED.

## 11. Gate decision

**R1-U2: DESIGN CONTRACT RECORDED; EXECUTION BLOCKED ON RAW SOURCE INTEGRITY.**

The next valid action is not to generate or freeze the manifest. It is to acquire exact raw source bytes, establish the source lock, and independently verify the artifact digests. Once that prerequisite passes, the parser and generator may be implemented only under a separate explicit authorization.

No code, tests, PR, merge, deployment, Cloudflare, Supabase, secret, laptop, or main-branch operation is authorized.
