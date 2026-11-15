# R1-U11 — Parser Open Decisions and Resource Profile

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Status: PARTIAL DECISION CLOSURE — DESIGN ONLY — NOT IMPLEMENTED — NOT TESTED
Parent: R1-U10
Scope: close only those parser design decisions supported by verified evidence. No source code, workflow modification, PR, merge, deployment, secret, Cloudflare, Supabase, laptop, or main-branch operation.

## 1. Executive decision

R1-U11 closes the canonical JSON direction and narrows the runtime choice. It does **not** close byte-level BOM/line-ending policy, normalization engine selection, immutable artifact retention, or measured resource budgets.

Decision summary:
- **JCS-1: PROPOSED SELECT** RFC 8785 JSON Canonicalization Scheme for semantic-manifest digest bytes, with the restrictions in §3.
- **PY-1: PROPOSED SELECT** CPython 3.12.x for parser orchestration and file-specific lexical/semantic parsing only, with no reliance on host Unicode properties or normalization.
- **NORM-1: OPEN / BLOCKED** Unicode 18.0.0 normalization and full case-fold implementation must use pinned Unicode 18 data; Python 3.12's built-in UCD is unsuitable as normative source.
- **BOM-1: UNKNOWN / BLOCKED** actual BOM presence in the nine raw files was not recorded by R1-U7.
- **EOL-1: UNKNOWN / BLOCKED** exact CRLF/LF/CR and mixed-line-ending profile was not recorded by R1-U7.
- **RES-1: PROVISIONAL LIMITS ONLY** source-size ceilings can be proposed from the exact manifest; line, record, CPU and memory limits require measured baseline and adversarial benchmarks.
- No policy freeze or implementation authorization is created by this document.

## 2. Evidence inputs

### 2.1 R1-U7 exact source manifest

Machine-readable source-lock:
`docs/evidence/UNICODE18_UCD_RAW_BYTE_MANIFEST_2026-11-15.json`
Blob read during this gate: `009765c2dcfdd075c459dee19c39ceba0424a07a`.

The nine exact raw-byte lengths sum to **8,327,323 bytes** (7.94 MiB, using 1 MiB = 1,048,576 bytes).

| Path | Exact bytes |
|---|---:|
| ReadMe.txt | 729 |
| PropList.txt | 149,040 |
| DerivedCoreProperties.txt | 1,159,889 |
| DerivedAge.txt | 142,568 |
| extracted/DerivedGeneralCategory.txt | 282,143 |
| UnicodeData.txt | 2,243,593 |
| CaseFolding.txt | 88,776 |
| DerivedNormalizationProps.txt | 1,396,877 |
| NormalizationTest.txt | 2,863,708 |
| **Total** | **8,327,323** |

Largest input is NormalizationTest.txt at 2,863,708 bytes. These are verified byte lengths and hashes from R1-U7, not line counts or record counts.

### 2.2 Evidence limitation

R1-U7 verified the exact source lengths and SHA-256 digests and direct-file/archive-member equality. It did not record:
- initial UTF-8 BOM presence/absence per file;
- exact line-ending counts per file;
- maximum line length;
- total physical line count per file;
- per-file record count except UnicodeData.txt (41,341 records);
- parser peak memory or CPU.

The raw files are not retained in the repository evidence tree. A manifest digest cannot reveal these byte-level structural facts. No value is inferred from rendered text or scraper output.

## 3. JCS-1 — Canonical JSON profile

### 3.1 Candidate decision

Adopt RFC 8785 (JSON Canonicalization Scheme, JCS) as the canonical byte representation for the semantic policy manifest, subject to the following project profile:

1. Input must be valid I-JSON-compatible data.
2. Duplicate object property names are rejected during parsing, before canonicalization.
3. JSON values may be objects, arrays, strings, booleans, null, and integers only.
4. Floating-point, exponent-form, NaN and Infinity values are forbidden by the project schema.
5. Every integer must be within the exact safe-integer range of IEEE-754 binary64; for this profile, integer values are further constrained to non-negative values no greater than 9,007,199,254,740,991.
6. Unicode strings must be valid scalar-value sequences; lone surrogates are rejected.
7. JCS does not normalize Unicode strings. The serializer must preserve strings exactly; NFC validation belongs to the input/schema policy, not the serializer.
8. Object property ordering and primitive serialization follow RFC 8785 exactly. Arrays retain their input order; each array's order must therefore be explicitly deterministic before serialization.
9. Canonical digest input is UTF-8 JCS output, with no BOM and no trailing newline.
10. Human-readable pretty-printed JSON, if later emitted, is a separate presentation artifact and is never hashed as the semantic canonical form.

### 3.2 Rationale and limitations

RFC 8785 provides deterministic primitive serialization, recursive object-key sorting and duplicate-name constraints. It also defines UTF-16-code-unit ordering for property names and requires strings to remain unchanged rather than Unicode-normalized.

JCS is an Informational RFC, not an Internet Standards Track specification. Adoption is therefore a project-level normative choice, not a claim that JCS is an Internet Standard.

The policy manifest's integer domain (code points, byte lengths, counts and range endpoints) is well below the binary64 exact-integer ceiling. If a future schema needs larger integers, encode them as canonical decimal strings under a versioned schema change; do not silently exceed the safe-integer range.

### 3.3 Required JCS acceptance tests

- RFC 8785 Appendix B number vectors are included as negative/compatibility tests, while project schema rejects all floating-point values before canonicalization.
- RFC 8785 property sorting vectors, including non-ASCII property names, must match the RFC's UTF-16 ordering.
- Duplicate keys are rejected before object construction (including escaped-name equivalence such as `"a"` and `"\u0061"`).
- Lone surrogate input is rejected.
- Canonicalization preserves NFC and non-NFC string code-point sequences exactly; policy validation separately rejects disallowed path forms.
- Same semantic object yields byte-identical JCS output across two independent implementations.
- Array order is explicitly sorted by schema-defined keys before JCS; JCS itself must not reorder arrays.

Status: **PROPOSED SELECT — NOT IMPLEMENTED — NOT TESTED — NOT FROZEN.**

## 4. PY-1 — Parser runtime

### 4.1 Candidate

Use CPython 3.12.x for:
- strict byte decoding;
- file-specific lexical parsing;
- range and record validation;
- typed interval-model construction;
- source-lock verification;
- test orchestration and diagnostics.

Pin the exact patch release, executable/container image digest, dependency lock and build provenance before implementation. The phrase “3.12.x” is not itself a reproducible runtime pin.

### 4.2 Critical Unicode-data restriction

Python 3.12's standard `unicodedata` module documents UCD version 15.0.0. Therefore:
- Do not use `unicodedata.category`, `normalize`, `name`, `bidirectional`, or any other host Unicode database function as a Unicode 18.0.0 oracle.
- Do not use `str.casefold()`, `str.lower()`, regular-expression Unicode property classes, or locale-dependent comparisons as normative SR-02 behavior.
- Python is only the parser/control runtime. Unicode 18 semantics must come from the exact R1-U7 source-lock and a separately version-pinned normalization/case-fold engine.
- Any dependency that embeds a Unicode database must expose and verify its exact Unicode version and data provenance. A mismatch is a hard failure.

### 4.3 Runtime reproduction

Before implementation authorization:
- pin exact CPython patch version;
- pin a container image by immutable digest, not a mutable tag alone;
- record OS/architecture and locale;
- set locale-independent operation and deterministic hash/output behavior;
- run the same test corpus in two independent environments;
- compare canonical output bytes and digests.

Status: **PROPOSED SELECT for parser runtime only. Exact runtime/container pin OPEN.**

## 5. NORM-1 — Unicode 18 normalization and folding engine

This decision remains **OPEN / BLOCKED**.

Requirements:
1. NFC/NFD must be implemented from Unicode 18.0.0 data, not Python 3.12's UCD 15.0.0.
2. Default full case folding must implement the pinned Unicode 18.0.0 CaseFolding.txt rules: F mappings take precedence where present; C mappings provide common mappings; S is not a fallback; T is excluded.
3. Canonical caseless comparison remains the candidate sequence:
   `UTF8(NFD(DefaultFullCaseFold(NFD(P))))`.
4. NormalizationTest.txt must be run as the conformance corpus.
5. Engine version, data source hashes, build identity and exact algorithm version must be recorded.
6. Host OS, ICU, libc, language runtime or regex Unicode data must never silently substitute a different Unicode version.

No engine is selected in R1-U11. ICU or another mature engine may be evaluated only after exact Unicode 18 support and reproducible data provenance are demonstrated. A custom implementation is not preferred without a documented security and maintenance justification.

## 6. BOM-1 — Byte Order Mark

**Status: UNKNOWN / BLOCKED.**

Unicode specifies that a UTF-8 BOM is not required, but may be encountered; this general rule does not tell us whether any of the nine pinned R1-U7 files actually begins with EF BB BF.

Required experiment when raw-byte inspection is separately authorized:
- read exact bytes from each pinned source;
- record first three bytes and whether they equal EF BB BF;
- record byte offset and file hash before any decoding;
- do not strip or rewrite;
- compare direct download and ZIP member bytes;
- independently reproduce the nine-file BOM report.

Policy after measurement:
- If no pinned file has a BOM, define parser input policy as “reject unexpected BOM in all nine source files”.
- If any file has a BOM, stop and require an explicit per-file owner decision; do not silently strip or special-case.
- A transport-level BOM and an embedded U+FEFF inside file content are different cases and must not be conflated.

No claim about current BOM presence is made.

## 7. EOL-1 — Line-ending profile

**Status: UNKNOWN / BLOCKED.**

Required raw-byte scan per file:
- count LF bytes;
- count CRLF pairs;
- count lone CR bytes;
- count LF bytes not preceded by CR;
- detect mixed conventions;
- record whether the file ends with LF, CRLF, CR or no terminator;
- preserve original byte offsets and line numbers.

Candidate policy:
- accept only the exact per-file profile measured from the pinned raw bytes;
- reject malformed/lone CR unless the source file explicitly requires it;
- reject mixed line endings unless evidence establishes that the source intentionally uses them;
- never normalize before source hash verification;
- parser may tokenize CRLF or LF according to the pinned per-file profile but must preserve original byte offsets.

A general Unicode encoding statement or a rendered text view is not evidence of the actual UCD file line endings.

## 8. RES-1 — Provisional resource envelope

### 8.1 Evidence-based baseline

Verified source set: 8,327,323 bytes total.
Largest file: 2,863,708 bytes.
Unicode code-point domain: U+0000..U+10FFFF (1,114,112 possible code points).
UnicodeData.txt: 41,341 validated records in R1-U7.

### 8.2 Provisional ceilings for test-harness planning only

These are conservative engineering proposals, not measured safe limits and not production-approved:

| Resource | Provisional ceiling | Basis / caveat |
|---|---:|---|
| Total raw input | 16 MiB | About 2x the verified 7.94 MiB source set |
| Single raw file | 6 MiB | About 2.1x the largest pinned file |
| Expanded code-point domain | 1,114,112 | Hard Unicode code-point domain; do not allocate one object per point by default |
| Parser process memory | 256 MiB | Provisional; must be benchmarked with worst-case interval and normalization fixtures |
| CPU budget | 30 seconds | Provisional; must be measured on pinned runner class |
| Wall-clock budget | 60 seconds | Includes startup and I/O; provisional |
| Diagnostic output | 1 MiB | Prevent log amplification; truncation must preserve a structured overflow marker |
| Canonical manifest | 16 MiB | Provisional; reject rather than truncate |

Do not materialize every code point in a range. Use sorted, non-overlapping interval structures and bounded iteration only for explicit tests.

### 8.3 Limits that cannot yet be responsibly fixed

- Maximum physical line length: baseline not measured.
- Maximum physical line count and record count for each file: baseline not measured (except UnicodeData record count).
- Maximum mapping sequence length: must be derived from exact pinned CaseFolding data.
- Maximum interval count and semantic-model memory: must be measured.
- Maximum normalization test-case length: must be derived from exact pinned NormalizationTest data.

These remain OPEN. Before implementation, a raw-byte metrics scan and adversarial stress benchmark must record baseline, proposed margin, observed peak and test environment.

## 9. Decision ledger

| ID | Decision | Status |
|---|---|---|
| JCS-1 | RFC 8785 plus restricted project schema | PROPOSED SELECT |
| PY-1 | CPython 3.12.x for parsing/control only | PROPOSED SELECT |
| NORM-1 | Unicode 18 normalization/folding engine | OPEN / BLOCKED |
| BOM-1 | Per-file BOM policy | UNKNOWN / BLOCKED |
| EOL-1 | Per-file line-ending profile | UNKNOWN / BLOCKED |
| RES-1a | Total input and per-file provisional ceilings | PROVISIONAL |
| RES-1b | Line/record/mapping/interval limits | OPEN |
| RES-1c | Memory/CPU/wall-clock budgets | PROVISIONAL; benchmark required |
| ART-1 | Immutable source artifact retention/reacquisition | OPEN |
| REV-1 | Independent reviewer and R1-G evidence | NOT RECEIVED |

## 10. Required next gate

**R1-U12 — Raw-byte structural metrics and normalization-engine feasibility review**, design/measurement only, subject to separately approved bounded execution scope.

R1-U12 should:
1. use the exact R1-U7 source hashes as preconditions;
2. acquire raw bytes into ephemeral, read-only storage;
3. measure BOM and EOL profiles, line lengths, line counts, record counts and mapping lengths;
4. verify all raw lengths and SHA-256 values again before parsing;
5. evaluate available Unicode 18 normalization engines and prove version/data identity;
6. benchmark bounded interval parsing and normalization against the proposed resource ceilings;
7. produce a second-runner reproduction report;
8. retain no source bytes unless separately authorized.

No workflow modification is implied by this recommendation. Any new workflow or code requires a separate scope approval.

## 11. Final gate status

**R1-U11: PARTIAL DECISION CLOSURE.**
- JCS direction: PROPOSED SELECT.
- Parser runtime direction: PROPOSED SELECT, exact build pin open.
- Unicode normalization engine: OPEN.
- BOM and EOL: UNKNOWN / BLOCKED pending raw-byte metrics.
- Resource limits: provisional ceilings only; measured caps open.
- Implementation: NOT AUTHORIZED.
- Tests: NOT RUN.
- SR-02 freeze: NOT APPROVED.
- PR / merge / deploy: NOT AUTHORIZED.

This record does not alter any runtime behavior or owner-approved Unicode policy.
