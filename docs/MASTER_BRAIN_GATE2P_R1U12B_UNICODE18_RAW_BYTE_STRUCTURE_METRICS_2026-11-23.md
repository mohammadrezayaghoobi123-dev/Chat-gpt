# R1-U12-B — Unicode 18.0.0 Raw-Byte Structural Metrics

- Date: 2026-11-23
- Repository: mohammadrezayaghoobi123-dev/Chat-gpt
- Branch: work/r1u12b-raw-structure-metrics-2026-11-23
- Execution commit: 86ee4769884ae7fc85b36ddcac9000d7cbd3cab4
- Workflow run: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/45188169476
- Status: SUPPORTED — RAW-BYTE LAYOUT METRICS ONLY
- Parent gate: R1-U7 source lock and R1-U12 parser feasibility plan

## 1. Scope and decision boundary

This run measures the physical byte layout of the nine pinned Unicode 18.0.0 UCD files. The measurement uses immutable byte buffers and does not normalize, rewrite, or persist source data.

The run is deliberately not a semantic Unicode parser and does not:
- derive Unicode properties or FC-3 policy;
- execute a normalization engine;
- regenerate or modify the source manifest or source lock;
- run a generator or alter runtime code;
- approve SR-02 freeze, runtime integration, PR merge, or production deployment.

## 2. Source-lock preconditions

The workflow verifies, before structural measurement:
1. the exact nine-path inventory equals the allowlisted R1-U7 inventory;
2. each direct download has the pinned exact byte length;
3. each direct download has the pinned SHA-256;
4. each direct download equals its matching member in the official versioned UCD.zip;
5. the stable source-manifest digest equals the pinned R1-U7 digest.

Pinned stable source-manifest SHA-256:

965655de97a82e6efc751d4e5f5c577c9c484eaf798af9a90f1a0203516ac27c

The source manifest blob remained unchanged at:

009765c2dcfdd075c459dee19c39ceba0424a07a

## 3. Execution evidence

| Control | Result |
|---|---|
| GitHub Actions run | 45188169476 — SUCCESS |
| Python acquisition job | SUCCESS |
| Independent curl/unzip job | SUCCESS |
| Python safety tests | 23 / 23 passed |
| Files acquired and compared | 9 / 9 |
| Direct bytes vs ZIP member | Exact equality for all nine |
| Pinned length and SHA-256 | Exact match for all nine |
| SHA-256 before vs after metrics | Exact match for all nine |
| Raw file contents in logs | No |
| Raw file artifacts uploaded | No |
| Manifest/source lock modified | No |

Runner evidence:
- Python job: Azure eastus, ubuntu-24.04, image 20261116.376.1.
- Independent curl/unzip job: Azure southcentralus, ubuntu-24.04, image 20261116.376.1.

The jobs use different execution environments and different acquisition implementations, but both ran under the same GitHub Actions control plane and Azure cloud provider. This is not cross-cloud or independent-publisher corroboration.

Python metrics digest:

ab8ba59930d95b138767e865e23df85444a395a378d59663c7f1f52b59add955

This digest commits to the canonical per-file structural metrics payload, source manifest identity, and before/after source digests.

## 4. Measured results

Aggregate exact input size: **8,327,323 bytes**  
Aggregate physical line count: **102,317**  
Archive exact size: **5,657,953 bytes**  
Archive SHA-256: 7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8

| File | Exact bytes | Physical lines | LF | CRLF | CR | Max line bytes | Max line (1-based) |
|---|---:|---:|---:|---:|---:|---:|---:|
| ReadMe.txt | 729 | 19 | 19 | 0 | 0 | 106 | 3 |
| PropList.txt | 149,040 | 1,979 | 1,979 | 0 | 0 | 167 | 1,376 |
| DerivedCoreProperties.txt | 1,159,889 | 13,857 | 13,857 | 0 | 0 | 181 | 4,042 |
| DerivedAge.txt | 142,568 | 2,179 | 2,179 | 0 | 0 | 139 | 2,164 |
| extracted/DerivedGeneralCategory.txt | 282,143 | 4,426 | 4,426 | 0 | 0 | 157 | 2,131 |
| UnicodeData.txt | 2,243,593 | 41,341 | 41,341 | 0 | 0 | 208 | 16,529 |
| CaseFolding.txt | 88,776 | 1,704 | 1,704 | 0 | 0 | 115 | 40 |
| DerivedNormalizationProps.txt | 1,396,877 | 16,580 | 16,580 | 0 | 0 | 219 | 12,387 |
| NormalizationTest.txt | 2,863,708 | 20,232 | 20,232 | 0 | 0 | 586 | 65 |

For every file:
- leading UTF-8 BOM: absent;
- embedded UTF-8 BOM: zero occurrences;
- NUL bytes: zero;
- strict UTF-8 decoding: valid;
- mixed line endings: absent;
- final line terminator: LF.

Maximum physical-line length excludes its line terminator. Byte offsets are zero-based; line numbers are one-based.

## 5. Interpretation

The pinned source set has a uniform physical line-ending profile: LF only, with each file ending in LF. No BOM, embedded BOM, NUL, mixed EOL, or strict UTF-8 failure was observed.

The largest physical line is 586 bytes in NormalizationTest.txt, line 65, at byte offset 5,063. The largest file is also NormalizationTest.txt at 2,863,708 bytes. UnicodeData.txt contains 41,341 physical lines.

These are measurements of the retrieved pinned source bytes. They do not establish that a future parser is correct, that all record grammars are valid, or that the proposed resource ceilings are adequate under adversarial parser inputs.

## 6. Adversarial review and tooling

- GitHub connector: used to inspect the exact branch, commit, source-lock file, workflow runs, job states, and raw job logs.
- Code Tytor Python expert review: used on the Python acquisition/measurement implementation. Its single medium performance suggestion was to materialize a loop as a list comprehension. That suggestion was rejected because the workflow intentionally streams physical lines to retain bounded memory use and byte offsets.
- TDD validation: the final committed workflow ran 23 tests successfully, including hostile cases for malformed ZIP member paths, duplicate/case-fold-colliding entries, content-length mismatch, TLS verification, CRLF/LF/lone-CR handling, phantom EOF lines, BOM offsets, invalid UTF-8, NUL bytes, and source-lock length/digest mismatch.

## 7. Separate security finding

The Full History Secret Scan failed on nine Generic API Key detections in pre-existing commits and paths outside the Unicode workflow. The current commit diff scan reported no new leaks. The nine historical detections remain unclassified; they are not asserted to be valid credentials or false positives.

This is a separate repository security gate and does not change the successful outcome of the Unicode acquisition/metrics jobs.

## 8. Gate disposition

| Gate | State |
|---|---|
| Raw-byte acquisition | SUPPORTED |
| R1-U7 per-file source-lock enforcement | SUPPORTED |
| Stable source-manifest digest match | SUPPORTED |
| Direct-file vs official UCD.zip byte equality | SUPPORTED |
| BOM/EOL/NUL/UTF-8/line-length measurements | SUPPORTED |
| Cross-cloud metrics-digest reproduction | NOT RUN |
| Lexical record metrics for every format | NOT RUN |
| Semantic Unicode parsing | NOT RUN |
| Unicode normalization conformance | NOT RUN |
| Independent publisher corroboration | NOT ESTABLISHED |
| SR-02 freeze | NOT APPROVED |
| Production/runtime approval | NOT APPROVED |

R1-U12-B disposition: PARTIAL. The raw-byte layout measurement subgate is supported and source-locked. Full record-grammar validation, parser conformance, normalization-engine identity, and independent metric-digest reproduction remain open.

## 9. Protected scope

Only the branch-scoped acquisition workflow and this evidence document were changed on the feature branch. No PR was opened, no merge or deployment was performed, and main, the manifest, source lock, generator, Cloudflare, Supabase, secrets, and the user's laptop were not modified.
