# R1-U10 — Unicode 18.0.0 Deterministic Parser and Test-Oracle Design

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: DESIGN ONLY — PROPOSED — NOT IMPLEMENTED — TESTS NOT RUN
Supersedes: R1-U2 design assumptions only where this document explicitly updates them using R1-U7/U8/U9 evidence.
Scope: parser architecture, source-lock contract, test oracle and independent reproduction plan. No parser code, application code, workflow modification, PR, merge, deployment, secrets, Cloudflare, Supabase, or laptop change.

## 1. Objective and decision boundary

Define an implementation-independent contract for parsing the exact Unicode 18.0.0 source files pinned by R1-U7 and deriving the property model required by SR-02.

This gate is intentionally design-only. It does not authorize implementation, test execution, policy freeze, or any runtime integration.

## 2. Evidence baseline and source-lock

### 2.1 Current pinned source facts

The R1-U7 manifest currently records exact raw-byte lengths and SHA-256 values for:
- ReadMe.txt
- PropList.txt
- DerivedCoreProperties.txt
- DerivedAge.txt
- extracted/DerivedGeneralCategory.txt
- UnicodeData.txt
- CaseFolding.txt
- DerivedNormalizationProps.txt
- NormalizationTest.txt

Current archive and file hashes were reproduced through Python urllib/zipfile and curl/unzip/cmp/sha256sum on two separate hosted runners. Current direct files matched current ZIP members byte-for-byte.

R1-U9 establishes that a July 2026 re-roll diff contains actual data changes in PropList.txt, DerivedCoreProperties.txt, DerivedAge.txt and UnicodeData.txt. Therefore the parser MUST consume only the exact R1-U7 per-file hashes, never an unqualified “Unicode 18.0.0” download or a historical archive digest alone.

### 2.2 Source-lock precondition

Before any parser invocation:
1. Load the source-lock manifest as data, not as executable instructions.
2. Require Unicode version exactly 18.0.0.
3. Require an exact allowlisted relative path for each required input.
4. Require expected byte length and SHA-256 for every input.
5. Acquire bytes into an isolated immutable input buffer.
6. Compute length and SHA-256 over the exact byte array.
7. Compare before decoding or parsing.
8. Reject the entire run if any required source is absent, duplicated, unexpected, mismatched, or unverified.
9. Record final URL, HTTP status, media type, TLS validation, retrieval time, runner identity, and source-lock digest as provenance metadata.
10. Do not parse data from a scraper's decoded text, a browser rendering, a GitHub diff, or a host runtime Unicode database.

The nine source files are pinned in R1-U7, but raw file bytes were not committed or retained as a repository artifact. A later implementation must either reacquire each versioned URL and verify the pinned digest before parsing, or obtain a separately authorized immutable evidence-store copy. Until then, independent third-party reproduction has a distribution limitation.

### 2.3 Raw-byte decoding boundary

- SHA-256 is always calculated over original bytes.
- Decode as strict UTF-8 only after digest validation.
- Invalid UTF-8 is a hard failure.
- NUL bytes are a hard failure.
- BOM presence, if any, must be explicitly detected and recorded; never strip it silently. The allowed BOM policy remains a pre-implementation decision after checking the pinned raw files.
- Record the exact line-ending profile per file. Do not normalize line endings before integrity verification.
- Reject mixed or malformed line endings unless the exact source-file profile is explicitly reviewed and permitted.
- Preserve original byte offsets and 1-based line numbers for diagnostics.

## 3. Parser architecture

Use four strictly separated components.

### P0 — Source verifier
- Verifies source-lock schema, path allowlist, version, byte length and SHA-256.
- Emits immutable verified-source handles.
- Does not parse or interpret UCD records.

### P1 — File-specific lexical parsers
- Each file has a dedicated grammar; do not use a permissive generic semicolon parser for every file.
- Comments are parsed separately from data fields.
- Whitespace is accepted only where the relevant UCD file format permits it.
- Hexadecimal code point syntax, scalar/range boundaries, field count and property vocabulary are validated.
- Unknown properties, malformed records and out-of-range values fail closed.
- Every accepted record retains source path, file digest, line number and raw-record byte span.

### P2 — Semantic model builder
- Converts parsed records to typed property intervals and mappings.
- Keeps properties independent; overlapping properties are expected and are not deduplicated across property names.
- Duplicate or overlapping intervals for the same property are rejected unless the specific file's normative format explicitly permits them.
- Retains all provenance edges and all applicable reason codes.
- Uses interval sets where practical; expansion to individual code points is bounded and deterministic.

### P3 — Policy projection and manifest generator
- Consumes the semantic model plus the owner-approved policy decisions as separate inputs.
- Derives SR-02 path admission and collision properties.
- Does not alter the accepted path representation.
- Emits a deterministic machine-readable manifest only after every required test gate passes.
- Keeps source provenance metadata separate from semantic policy identity.

## 4. File-specific grammar and semantic requirements

| File | Required parsing model | Primary validation |
|---|---|---|
| ReadMe.txt | Version/provenance metadata only | Release marker, expected source path, no use as property oracle |
| PropList.txt | Code point or inclusive range; property; optional comment | Property vocabulary, ordered ranges, duplicate same-property intervals |
| DerivedCoreProperties.txt | Code point or inclusive range; derived property; optional comment | Derived property vocabulary and exact interval semantics |
| DerivedAge.txt | Code point or inclusive range; age value; optional comment | Age values, assigned coverage, default Unassigned semantics |
| extracted/DerivedGeneralCategory.txt | Code point or inclusive range; General_Category value | Category vocabulary and full-domain coverage semantics |
| UnicodeData.txt | Exactly 15 semicolon-separated fields per record; special First/Last range pairs | Field count, code point ordering, matching First/Last pairs, category and decomposition fields |
| CaseFolding.txt | Source code point; status; mapping sequence; optional comment | Status vocabulary C/F/S/T, mapping sequence and source uniqueness |
| DerivedNormalizationProps.txt | Code point or inclusive range; normalization property; optional value/comment | Property/value vocabulary and range semantics |
| NormalizationTest.txt | Five semicolon-separated code-point sequences plus comments | Valid code points, five-column conformance relations, complete test coverage |

### 4.1 Range handling

- Endpoints are inclusive.
- Start must be less than or equal to end.
- Both endpoints must be within U+0000..U+10FFFF.
- A range may not cross a forbidden structural boundary unless the source format explicitly defines that range.
- Preserve the original range record and a normalized interval representation.
- Never expand a range into an unbounded list before enforcing resource limits.
- Duplicate/overlap detection is per file and per property key, not global across different properties.

### 4.2 UnicodeData First/Last records

- A First record must be followed by its matching Last record according to the UnicodeData format.
- The pair must agree on required structural fields.
- Unpaired, nested, reversed, or mismatched pairs fail closed.
- Range expansion must preserve the category and other fields defined by the UnicodeData range semantics.
- Algorithmic Hangul decomposition/composition must not be mistaken for explicit ordinary records.

### 4.3 CaseFolding status selection

- Default full case folding uses status F where supplied and status C for common mappings.
- Status S is not a fallback for the default full mapping.
- Status T is excluded from default folding.
- Mapping sequences are preserved in exact order.
- Unlisted code points map to themselves as specified by the pinned file.
- Do not call host-language lower(), casefold(), or equivalent functions as normative behavior.
- Any impossible duplicate/conflicting mapping for one source code point is a hard failure unless the file specification explicitly defines its resolution.

### 4.4 Normalization and canonical caseless key

- Use pinned Unicode 18.0.0 data and a version-pinned normalization implementation.
- Use NormalizationTest.txt as the conformance oracle; do not rely only on a small hand-written sample.
- Verify NFC and NFD behavior before enabling collision-key derivation.
- Candidate canonical caseless collision key remains:
  UTF8(NFD(DefaultFullCaseFold(NFD(P))))
- The collision key is comparison-only. It must never rewrite or replace the accepted Git path.
- The exact normalization engine, implementation version and data provenance remain open until implementation design review.

## 5. Property derivation and cross-file consistency

### 5.1 Independent properties

Derive and retain separate interval sets for:
- Noncharacter_Code_Point
- Bidi_Control
- Join_Control
- Default_Ignorable_Code_Point
- General_Category=Cc
- General_Category=Cf
- General_Category=Mn
- Age=Unassigned
- FC-3 owner-approved singleton/range set

Never infer one property from another merely because the sets overlap.

### 5.2 Expected cross-check counts

The counts below are expected checks from the R1-U1/R1-U7 investigation; they are not substitutes for parsing:
- Noncharacter_Code_Point: 66 code points / 18 ranges.
- Bidi_Control: 12 code points / 4 ranges.
- Join_Control: 2 code points / 1 range.
- Default_Ignorable_Code_Point: 4,174 code points / 27 ranges.
- General_Category Cc: 65 code points.
- General_Category Cf: 170 code points.
- General_Category Mn: 2,090 code points.

Any mismatch blocks policy projection until explained by a verified source revision, parser defect, or earlier incorrect count. Never silently adjust the expected count to match parser output.

### 5.3 Age=Unassigned

- Treat DerivedAge as an Age property with the file-defined default value for code points not explicitly listed.
- Define the complement domain explicitly as the Unicode code-point range U+0000..U+10FFFF.
- Keep scalar-value validity, surrogate exclusion and Noncharacter_Code_Point as independent dimensions.
- Confirm U+2065 through the exact pinned DerivedAge input, not through DICP or General_Category.
- If the parser cannot prove full-domain coverage and default semantics, assignedness is UNKNOWN and path admission fails closed.

### 5.4 FC-3 projection

Consume the exact R1-R owner decision and R1-S machine-readable policy as separately versioned inputs.

Approved FC-3 v1 outcomes:
- U+00AD REJECT
- U+034F REJECT
- U+180E REJECT
- U+200B REJECT pending independently verified DISP-1 and a new owner decision
- U+2060 REJECT
- U+2061..U+2064 REJECT in repository paths only
- U+206A..U+206F REJECT
- U+FEFF REJECT in decoded path values; transport BOM handling remains a separate decoder-boundary rule

Explicit exclusions:
- U+2065: Age=Unassigned
- U+2066..U+2069: BC-1
- U+200C/U+200D: JC-2
- U+180B..U+180D and U+180F: not included by the U+180E decision

No broad U+2060..U+206F range may be emitted. Preserve all overlapping policy reason codes and their source provenance.

## 6. Canonical output and determinism

The manifest generator must define:
- UTF-8 output encoding and BOM policy;
- LF output line endings and final newline behavior;
- canonical JSON serialization algorithm and version;
- object-key ordering;
- deterministic array ordering;
- duplicate-key rejection;
- integer representation and prohibition of floating-point values where not required;
- canonical code point notation in human-readable fields;
- stable schema and policy version identifiers;
- separation of volatile retrieval metadata from semantic policy identity.

The exact serializer remains OPEN. RFC 8785 and a tightly specified project-local canonical JSON profile must be compared before selecting one. No serializer is silently approved by this design.

Required determinism invariant:
same verified source-lock bytes + same owner-decision blobs + same parser/generator version + same canonicalization profile = byte-identical semantic manifest and digest.

A provenance envelope may contain retrieval timestamps and runner metadata, but those volatile values must not contaminate the semantic policy digest.

## 7. Test-oracle design

### 7.1 Oracle independence

A test oracle must not be generated by the same parser code under test. Use:
- manually reviewed, pinned fixtures for boundary and adversarial cases;
- independently derived property totals and interval boundaries;
- Unicode NormalizationTest.txt for normalization conformance;
- a second implementation or independent reviewer for byte-level output reproduction;
- mutation tests that alter source bytes and expected records.

A test that merely compares the parser output to a fixture generated by that parser is circular and invalid.

### 7.2 Required test layers

1. Source-lock and byte-integrity tests.
2. Strict decoding and line-ending tests.
3. Per-file lexical grammar tests.
4. Range, duplicate, overlap and ordering tests.
5. UnicodeData First/Last pair tests.
6. CaseFolding C/F/S/T selection tests.
7. Normalization conformance tests.
8. Property-set cross-file consistency tests.
9. FC-3 owner-decision projection tests.
10. Canonical serialization and reproducibility tests.
11. Resource-exhaustion and denial-of-service tests.
12. Independent differential reproduction.

### 7.3 Required adversarial vectors

| ID | Input / mutation | Expected outcome |
|---|---|---|
| U10-001 | One byte changed in any source | SHA mismatch; abort before parsing |
| U10-002 | Correct path, wrong source version header | Hard fail |
| U10-003 | Invalid UTF-8 sequence | Hard fail |
| U10-004 | Unexpected BOM | Hard fail unless explicit per-file policy permits it |
| U10-005 | NUL or lone CR | Hard fail |
| U10-006 | Mixed line endings | Hard fail unless reviewed profile explicitly permits |
| U10-007 | Unknown property name/value | Hard fail |
| U10-008 | Reversed or out-of-domain range | Hard fail |
| U10-009 | Duplicate same-property interval | Hard fail |
| U10-010 | Overlap across distinct properties | Preserve both; do not collapse |
| U10-011 | Unpaired UnicodeData First/Last | Hard fail |
| U10-012 | UnicodeData field count not 15 | Hard fail |
| U10-013 | Invalid CaseFolding status | Hard fail |
| U10-014 | S mapping used instead of F/C | Fail |
| U10-015 | T mapping applied to default folding | Fail |
| U10-016 | Host runtime casefold/normalize used | Fail provenance |
| U10-017 | U+2065 inferred from DICP rather than Age | Fail |
| U10-018 | Cc/Cf/Mn conflated | Fail property-model validation |
| U10-019 | Bidi_Control inferred from all Cf | Fail |
| U10-020 | Join_Control conflated with DICP | Fail |
| U10-021 | One property count differs from expected | Block pending explanation |
| U10-022 | FC-3 emits U+2066..U+2069 | Fail; BC-1 owns them |
| U10-023 | FC-3 includes U+180B..U+180D or U+180F | Fail |
| U10-024 | U+200B automatically changes to allow | Fail; new owner decision required |
| U10-025 | U+200C/U+200D rejected without JC-2 evaluation | Fail |
| U10-026 | Non-NFC input silently normalized | Fail |
| U10-027 | Accepted path rewritten to collision key | Fail |
| U10-028 | A policy overlap loses one reason code | Fail provenance completeness |
| U10-029 | Same source lock generates different manifest bytes | Reproducibility fail |
| U10-030 | Two independent implementations disagree | Freeze blocked |
| U10-031 | Extremely large range causes unbounded allocation | Must fail within resource limits |
| U10-032 | Truncated file or missing final record | Hard fail |
| U10-033 | Source path traversal or duplicate source path in lock | Hard fail |
| U10-034 | Unknown owner-decision blob/version | Hard fail |
| U10-035 | Serializer emits duplicate JSON keys | Hard fail |
| U10-036 | Volatile timestamp changes semantic policy digest | Fail determinism |

All vectors are SPECIFIED, NOT RUN.

## 8. Resource limits and failure semantics

Before implementation, define explicit maximums for:
- raw bytes per file and total source set;
- line length and record count;
- range width and total expanded code points;
- maximum mapping length;
- maximum parser memory and CPU budget;
- maximum diagnostic output;
- maximum generated manifest size.

Limits must be derived from pinned file measurements plus a documented safety margin. They must not be guessed or tuned after observing adversarial failures without a versioned decision.

Failure semantics:
- Source integrity failure: abort all parsing.
- Structural parse failure: abort semantic model construction.
- Semantic inconsistency: preserve diagnostic evidence, block policy projection.
- Unknown property or owner policy: fail closed.
- Test failure or independent disagreement: freeze blocked.
- Missing external evidence: UNKNOWN, not PASS or FAIL.

## 9. TDD and implementation readiness gates

If implementation is later authorized, use a recorded red-green-refactor sequence:
1. Write one failing test for one normative rule.
2. Record the failing output as RED.
3. Implement the smallest behavior to satisfy the test.
4. Record GREEN with exact command, runtime and output.
5. Refactor without changing behavior and rerun the relevant suite.
6. Run the complete adversarial suite and cross-platform deterministic reproduction.
7. Preserve raw logs, source lock, generated manifest and test results as evidence.

No implementation may begin until all are true:
- exact source-lock manifest reviewed;
- raw artifact retention/reacquisition strategy approved;
- BOM and line-ending policy decided from raw bytes;
- serializer profile selected;
- resource limits approved;
- parser language/runtime and Unicode-data dependencies pinned;
- test oracle and independent reviewer path defined;
- separate explicit implementation authorization recorded.

## 10. Open decisions and blockers

| ID | Open item | Why it matters |
|---|---|---|
| U10-O1 | BOM policy for each pinned input | Avoid silent byte/text transformation |
| U10-O2 | Exact line-ending profile | Deterministic lexical parsing |
| U10-O3 | Canonical JSON profile | Stable manifest digest |
| U10-O4 | Parser language/runtime | Reproducibility and security support |
| U10-O5 | Normalization engine and data source | NFC/NFD and casefold correctness |
| U10-O6 | Immutable raw artifact retention | Independent reviewer reproduction |
| U10-O7 | Explicit maximum resource budgets | Denial-of-service resistance |
| U10-O8 | Independent implementation/reviewer identity | Avoid self-confirmation |
| U10-O9 | Exact R1-G independent review result | SR-02 path-profile assurance remains incomplete |

## 11. Gate decision

**R1-U10: DESIGN CANDIDATE RECORDED — NOT IMPLEMENTED — NOT TESTED — NOT FROZEN.**

R1-U7 supplies a verified per-file digest baseline. R1-U9 demonstrates that historical Unicode 18.0.0 snapshots can differ in data-bearing files, making per-file hash binding mandatory. The next engineering action, after this design is reviewed, is to close the open implementation prerequisites and obtain explicit implementation authorization.

No source code, workflow, policy manifest, runtime behavior, PR, merge, deployment, Cloudflare, Supabase, secret, laptop, or main-branch operation is authorized.
