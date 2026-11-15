# Master Brain — Gate 2P / R1-D

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
## Independent Review Package — Revised SR-02 Contract

**Package ID:** MB-G2P-R1D-SR02-REV-IND-REVIEW-2026-11-15  
**Date:** 2026-11-15  
**Status:** REVIEW REQUEST — NOT A CONTRACT APPROVAL — NOT IMPLEMENTATION AUTHORIZATION  
**Review mode:** Independent adversarial review of exact revised document blob

## 1. Exact target and provenance

Review the exact revised contract below. Do not substitute a prior version, a rendered preview, or a summary.

- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Branch: `integration/master-brain-unification-2026-11-15`
- Target path: `docs/MASTER_BRAIN_GATE2P_SR02_DIGEST_SEMANTICS_CANONICALIZATION_PROPOSAL_2026-11-15.md`
- Target commit: `b87a0f82954c4e6337af1bfd88817473a8e8f5de`
- Target Git Blob SHA: `b4dc90f4fb1972145e19930fb24ca27efc6f9f7c`
- Target URL: https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/blob/integration/master-brain-unification-2026-11-15/docs/MASTER_BRAIN_GATE2P_SR02_DIGEST_SEMANTICS_CANONICALIZATION_PROPOSAL_2026-11-15.md

Related owner decision records:
- F-01/F-02: `docs/MASTER_BRAIN_GATE2P_R1C_OWNER_DECISION_SR02_F01_F02_2026-11-15.md`
  - Blob: `b4d12c192331409db0f51319f9e941ce22121d6f`
- SR-08: `docs/MASTER_BRAIN_GATE2P_R1B_OWNER_DECISION_SR08_2026-11-15.md`
  - Blob: `ffc1c80e117d356b89577083fa902efd32e2c824`
- SR-03 hybrid retention: `docs/MASTER_BRAIN_GATE2P_R1B_OWNER_DECISION_SR03_HYBRID_RETENTION_2026-11-15.md`
  - Blob: `13fca32d63d589bc67c6f2a36f7a15125c62d750`

First verify the exact target Blob SHA against retrieved bytes. If exact content cannot be retrieved or verified, return `INCONCLUSIVE`; do not infer content from this package.

## 2. Independence and evidence declaration

Before analysis, state:
- whether this is an independent review;
- whether the full exact target document was retrieved;
- whether the Git Blob SHA was independently verified;
- whether prior reviewer reports or conclusions were seen;
- which source files and executable artifacts were actually inspected;
- which claims could not be verified.

Do not claim cryptographic verification unless you actually recomputed the digest from the retrieved bytes using a suitable implementation.

## 3. Owner decisions that are now normative

The owner has explicitly approved these two policy choices:

### F-01 — base branch is authorization-relevant

For the current `project.create_pr` action:
- canonical `base_branch` MUST be included in the server-derived authorization resource descriptor;
- changing base branch MUST change `authorization_resource_digest`;
- changing base branch MUST change `request_fingerprint`;
- `content_digest` may remain unchanged if the exact content manifest is unchanged;
- a previous authorization decision for one base branch MUST NOT be reused for another.

Assess whether the revised proposal actually enforces this consistently in its data model, digest matrix, replay protocol, tests, and open decisions.

### F-02 — reject case-fold path collisions in v1

The v1 policy rejects a request if two distinct repository-relative paths collide under the declared versioned Unicode case-fold comparison profile. Silent rename, merge, overwrite, or winner selection is forbidden.

Assess whether the revised proposal consistently applies this rule before digest admission, specifies the comparison key correctly, preserves validated path identity, and prevents cross-runtime divergence.

The exact Unicode normalization profile, Unicode data version, and case-fold algorithm remain required design details before implementation. Do not treat them as already selected.

## 4. Review objectives

Perform a fresh adversarial review of the complete revised contract, not merely a checklist confirmation.

At minimum:

1. Verify F-01 and F-02 are correctly and consistently incorporated.
2. Identify contradictions between sections, tables, test matrix, open decisions, and gate status.
3. Reassess all three digest boundaries:
   - `authorization_resource_digest`
   - `request_fingerprint`
   - `content_digest`
4. Determine whether the request descriptor is closed and includes every effect-changing field.
5. Evaluate canonical JSON serialization, duplicate-key rejection, numeric representation, null/absent/default semantics, Unicode, line endings, and array ordering.
6. Evaluate path validation, traversal, separators, normalization, case-fold collision, Unicode confusables, duplicate-after-normalization, symlink/submodule/mode handling.
7. Evaluate repository identity, rename/transfer, branch identity, and provider semantics.
8. Evaluate domain separation, algorithm/profile versioning, historical tombstone verification, migration, and archive integrity.
9. Evaluate replay, re-authorization, UNKNOWN, external-state reconciliation, and whether a digest could be misused as authorization or proof of side effect.
10. Check alignment with the SR-03 hybrid retention decision and the controlling SR-08 decision.

## 5. Required adversarial cases

Construct concrete counterexamples and tests for at least these cases:

- base branch changes while all other request fields remain identical;
- branch spelling/canonicalization ambiguities and invalid branch refs;
- case-fold collisions: `Readme` / `README`, nested paths, and Unicode case-fold equivalents;
- normalization-induced duplicate paths;
- backslash, mixed separators, absolute paths, traversal, NUL;
- invalid UTF-8 and unpaired surrogate values;
- NFC/NFD behavior in path and text fields;
- Unicode confusables that are not case-fold equivalents;
- duplicate JSON keys and key-order variation;
- absent/null/empty/default distinctions;
- line-ending differences in title, summary, and file bytes;
- omitted effect-changing fields and option mutation;
- repository rename/transfer and unavailable immutable ID;
- same idempotency key with changed base branch or changed content;
- replay after authorization revocation;
- upstream GitHub acceptance followed by response loss;
- digest/profile migration with archived tombstones;
- mismatch between stored content digest and observed GitHub tree.

For every finding, include exact section/line anchor, severity, reproducible counterexample, impact, correction, and required test.

## 6. Required conformance corpus

Provide at least 20 precise test vectors, including:
- input JSON or path set;
- expected validation result;
- canonical representation or reason no representation is produced;
- expected equality/inequality relationship for each applicable digest;
- profile/version assumptions;
- rationale.

Do not fabricate actual digest hex values. If no implementation is available, mark vectors `PROPOSED / NOT_RUN`.

At least 5 vectors must specifically test F-01 and F-02:
- base branch change changes authorization and request digests but not content digest when content is constant;
- invalid or ambiguous branch ref fails closed;
- ASCII case-fold collision is rejected;
- Unicode case-fold collision is rejected under the pinned test profile;
- normalization-induced path collision is rejected.

If the contract does not yet pin the necessary Unicode/branch profile, explicitly identify the missing owner/design decision and do not pretend these vectors are fully executable.

## 7. Test execution evidence

Separate all results into:
- `EXECUTED`
- `PASSED`
- `FAILED`
- `NOT_RUN`
- `PROPOSED`

For every executed test, state runtime, version, command or procedure, input, output, and reproducibility information. If you have not executed tests, say so plainly.

## 8. Gate and authorization constraints

The controlling owner decision SR-08 remains:

**External GitHub write dispatch = DENY / NOT AUTHORIZED.**

This review must not:
- authorize implementation;
- authorize GitHub writes;
- create or modify code, files, branches, PRs, or commits;
- merge or deploy;
- modify Cloudflare, Supabase, secrets, credentials, or local devices;
- authorize R2 experiments.

A positive SR-02 review cannot supersede SR-08.

## 9. Required report structure

A. Independence and access declaration  
B. Exact evidence/provenance and target blob verification  
C. Executive verdict: `ACCEPT`, `ACCEPT_WITH_BLOCKERS`, `REJECT`, or `INCONCLUSIVE`  
D. Findings table with severity and reproducible evidence  
E. F-01 and F-02 decision-conformance analysis  
F. Digest-semantics and trust-boundary analysis  
G. Canonicalization and path-security analysis  
H. At least 20 conformance vectors  
I. Replay/recovery/reconciliation analysis  
J. Test execution evidence  
K. Residual risks and unresolved owner decisions  
L. Required corrections, ordered by severity  
M. Final gate recommendation

## 10. Acceptance criteria for this review

The report is useful only if it:
- reviews the exact pinned blob;
- makes an honest independence/access declaration;
- checks internal consistency, not only the two approved decisions;
- provides concrete counterexamples;
- does not confuse proposed tests with executed tests;
- identifies unresolved Unicode/branch canonicalization choices;
- preserves SR-08 as DENY / NOT AUTHORIZED;
- does not claim contract freeze or implementation readiness without evidence.

**Final rule:** Treat missing evidence as `UNKNOWN`, not PASS or FAIL. The purpose is to falsify weak assumptions and expose unresolved risks, not to produce a favorable verdict.
