# R1-U7 — Unicode 18.0.0 Raw-Byte Acquisition and Cross-Environment Reproduction
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Scope: record actual execution evidence for the approved, branch-scoped, no-secret Unicode UCD acquisition workflow.

## 1. Verdict

**PASS — nine raw source files were acquired from the official Unicode 18.0.0 versioned UCD endpoints, compared byte-for-byte with the matching members of the official UCD.zip archive, and independently reproduced in a second GitHub-hosted runner using a different implementation.**

This is a source-byte acquisition and same-publisher distribution-consistency result. It is not independent publisher corroboration, a signed provenance attestation, or a trusted timestamp.

## 2. Workflow implementation and trigger

Workflow path:
`.github/workflows/unicode18-raw-byte-acquisition.yml`

Final workflow commit:
`f8a0b75a16cb772c5ecb3d78adfecb579169e518`

Workflow blob:
`829a32ddd3ef55563d49bcfe478b229a72fd3008`

Read-only controls:
- Trigger restricted to push on `integration/master-brain-unification-2026-11-15` and path `.github/workflows/unicode18-raw-byte-acquisition.yml`.
- `permissions: {}` at workflow level and independent job level.
- No checkout, third-party action, package installation, repository write, PR, artifact, cache, secret reference, or deployment.
- Standard `ubuntu-24.04` runners; each job has a 10-minute timeout.
- Raw file contents are held only in ephemeral runner memory or temporary directories and are not printed or uploaded.
- Logs contain only source URLs, HTTP metadata, lengths, digests, and validation outcomes.

Runner logs show GitHub's automatically provisioned token metadata permission as `Metadata: read`; no repository contents permission was granted or used. The workflow does not reference `GITHUB_TOKEN` or any user-defined secret.

## 3. Execution evidence

### First execution

- Run ID: `43726852830`
- Result: `success`
- The Python acquisition job completed successfully.
- Six embedded safety tests passed.
- All nine direct-file downloads matched the corresponding UCD.zip members byte-for-byte.

Run: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/43726852830

### Cross-environment reproduction

- Run ID: `43726926544`
- Overall result: `success`
- Workflow commit: `f8a0b75a16cb772c5ecb3d78adfecb579169e518`

Two independent jobs ran in separate hosted runner environments:

| Job | Implementation | Runner / provider | Region | Result |
|---|---|---|---|---|
| `132850776436` | Python `urllib`, `zipfile`, SHA-256, six `unittest` safety checks | Ubuntu 24.04.5 / Azure | `westus` | SUCCESS |
| `132850776729` | `curl`, `unzip`, `cmp`, `sha256sum` | Ubuntu 24.04.5 / AWS | `us-west-2` | SUCCESS |

The second job independently reacquired the archive and nine direct files, verified the archive, required each allowlisted archive member exactly once, compared direct bytes with `unzip -p` output using `cmp`, and reproduced every file digest and byte length.

Run: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/43726926544

## 4. Archive integrity result

Official source:
`https://www.unicode.org/Public/18.0.0/ucd/UCD.zip`

- HTTP status: 200
- Content type: `application/zip`
- Content encoding: identity
- Exact byte length: **5,657,953**
- SHA-256: `7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8`

Both runner implementations independently reproduced the same archive length and SHA-256.

## 5. Nine-file raw-byte manifest

All lengths are exact byte counts, not character counts. Each file's direct-download SHA-256 equals the SHA-256 of its matching UCD.zip member. Every equality check returned true in both implementations.

| Relative path | Exact bytes | SHA-256 |
|---|---:|---|
| `ReadMe.txt` | 729 | `b0ea442f29dee90584aacd3665a6e1ce87ffc917a4d31f34e1916d2d6f7f9205` |
| `PropList.txt` | 149,040 | `f438f532e8737bb8a2702126cdf9c4af5e357c58c7acf9d9eb2fc7c1a1d955d6` |
| `DerivedCoreProperties.txt` | 1,159,889 | `09c928886a178fcafd93c29e4bd59073a058e5a100b716d425cb563ab50f68c9` |
| `DerivedAge.txt` | 142,568 | `58b04334e3a31f9612694bbc3f6bff4a302b7d424565bca9c47e30aa74f8dbac` |
| `extracted/DerivedGeneralCategory.txt` | 282,143 | `d6b151d2d40ee9b1876d26f417980f45ffae47b6055ccf7203cb31f07a030f94` |
| `UnicodeData.txt` | 2,243,593 | `0736451de439ae7baf1425136617da495e09ee5afbe6e394374db7009ea08950` |
| `CaseFolding.txt` | 88,776 | `a004797658a457bec4dc11683e39f69249ea3b595b752dbea6721c4c9f587b0d` |
| `DerivedNormalizationProps.txt` | 1,396,877 | `98ac7f67d985fe781e317f6182e885e94cabb0c314769e6dd73e48b226931ccd` |
| `NormalizationTest.txt` | 2,863,708 | `25a50d816764b04abfb4a646d3eb2b2a803284c3873d9a06757b94fe4513dde3` |

The `UnicodeData.txt` structural check found 41,341 records; each record had 15 fields and code points were strictly increasing. The other eight text files contained the Unicode 18.0.0 version marker within the first 32,768 bytes.

## 6. Stable manifest digest

The Python job emitted:
`965655de97a82e6efc751d4e5f5c577c9c484eaf798af9a90f1a0203516ac27c`

This is SHA-256 over canonical ASCII JSON using sorted keys and compact separators, over the pinned release, archive digest/length, and ordered file metadata (including header-validation result and direct-vs-ZIP equality).

The digest was independently recomputed from the captured metadata in a separate local verification step and matched exactly. This is a digest of the metadata manifest, not a signature over the Unicode publisher's bytes.

Machine-readable evidence:
`docs/evidence/UNICODE18_UCD_RAW_BYTE_MANIFEST_2026-11-15.json`

## 7. Safety-test evidence

The Python job ran six embedded tests before network acquisition:
1. Accept the expected relative path.
2. Reject parent traversal.
3. Reject absolute and backslash paths.
4. Reject duplicate ZIP member paths.
5. Reject case-fold-colliding ZIP member paths.
6. Confirm canonical manifest serialization stability.

Result: **6 tests / 6 passed**.

The shell job separately verified:
- ZIP archive integrity with `unzip -tqq`;
- exact one-time occurrence of each of the nine required member paths;
- direct-download versus archive-member byte equality with `cmp`;
- matching byte lengths and SHA-256 values.

These were execution-time safety and integrity checks. They were not a recorded red-green-refactor TDD cycle.

## 8. What is proven and what is not

### Proven by current evidence
- Exact raw byte lengths and SHA-256 values for all nine files.
- Exact raw byte length and SHA-256 for `UCD.zip`.
- Direct-file and ZIP-member byte equality for all nine files.
- Reproduction by two different implementations on two separate hosted runners, one in Azure westus and one in AWS us-west-2.
- Six Python safety tests passed.
- The workflow completed successfully with no repository write permission.

### Still not proven
- Independent publisher corroboration: both distributions are published by the Unicode Consortium.
- Signed publisher checksum or cryptographic signature for the retrieved source bytes.
- Trusted timestamp or signed runner attestation.
- Independent reviewer R1-G completion.
- Deterministic parser and property-manifest regeneration.
- Full Unicode 18 profile freeze.
- SR-02 freeze, implementation, product integration, or production readiness.

A successful acquisition does not authorize implementation or deployment.

## 9. Repository safety

- `main` baseline SHA remains `919b19ca3d3887352cdef06b03c668ead04fbce7`.
- All work is on `integration/master-brain-unification-2026-11-15`.
- No merge, PR, deployment, Cloudflare, Supabase, secret, or laptop change was performed.
- Only the approved workflow and audit/evidence files were added or updated.

## 10. Next atomic gate

Proceed to R1-U8: independently validate the nine source digests against a second provenance channel where an immutable upstream mapping can be established; if no trustworthy independent publisher channel exists, record that limitation and do not substitute an unproven mirror. Then implement the deterministic UCD parser/manifest generator in an isolated test harness only after a separate scope approval. Parser tests must cover the UCD formats and property counts, not merely JSON serialization.

**R1-U7 final status: PASS for raw-byte acquisition and dual-path cross-environment reproduction; PARTIAL for end-to-end source provenance; NOT READY for SR-02 freeze or implementation.**
