# Master Brain — Gate 2P / R1-R: Owner Decision — FC-3 v1 Exact Membership

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Decision ID:** MB-G2P-R1R-OWNER-DECISION-FC3-V1-2026-11-15  
**Decision date:** 2026-11-15  
**Decision authority:** Repository/project owner  
**Status:** OWNER-APPROVED POLICY DECISION — NOT FROZEN AS IMPLEMENTATION — NOT IMPLEMENTED — NOT TESTED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Baseline:** Unicode 18.0.0; UTS #39 Revision 34  
**Supersedes:** R1-P recommendations and R1-Q pending owner-decision status, only for FC-3 v1 policy choices recorded below.

## 1. Decision record

The owner approved the eight proposed FC-3 outcomes with the explicit condition that U+200B remains rejected until DISP-1 is independently verified across every supported security-sensitive display surface.

This is a policy decision for the v1 repository-path namespace. It is not a general prohibition on these characters in ordinary file contents, application text, scientific documents, source-code strings, or user data.

## 2. Exact v1 decision manifest

| Entry | Exact code point(s) | Name / scope | Owner decision | Stable reason code |
|---|---|---|---|---|
| FC3-01 | U+00AD | SOFT HYPHEN | REJECT | FC3-SOFT-HYPHEN |
| FC3-02 | U+034F | COMBINING GRAPHEME JOINER; General_Category=Mn | REJECT | FC3-COMBINING-GRAPHEME-JOINER |
| FC3-03 | U+180E | MONGOLIAN VOWEL SEPARATOR | REJECT | FC3-MONGOLIAN-VOWEL-SEPARATOR |
| FC3-04 | U+200B | ZERO WIDTH SPACE | REJECT until DISP-1 independent verification and a new explicit owner decision | FC3-ZERO-WIDTH-SPACE |
| FC3-05 | U+2060 | WORD JOINER | REJECT | FC3-WORD-JOINER |
| FC3-06 | U+2061, U+2062, U+2063, U+2064 | FUNCTION APPLICATION, INVISIBLE TIMES, INVISIBLE SEPARATOR, INVISIBLE PLUS | REJECT | FC3-INVISIBLE-MATH-OPERATOR |
| FC3-07 | U+206A, U+206B, U+206C, U+206D, U+206E, U+206F | Six deprecated format controls | REJECT | FC3-DEPRECATED-FORMAT |
| FC3-08 | U+FEFF | ZERO WIDTH NO-BREAK SPACE / BOM code point in decoded path value | REJECT | FC3-FEFF-IN-PATH |

The manifest is an exact finite list. Implementations must not expand it to entire Unicode blocks or infer membership from General_Category=Cf or Default_Ignorable_Code_Point alone.

## 3. Explicit exclusions and policy ownership

The following exclusions prevent overlap and accidental overblocking:

- U+2065 is not an FC-3 member. Unicode 18.0.0 marks it unassigned; reject it under the already-approved Age=Unassigned rule.
- U+2066..U+2069 are not FC-3 members. They are covered by the already-approved BC-1 Bidi_Control rule.
- U+200C and U+200D are not FC-3 members. They remain governed by the already-approved JC-2 contextual Join_Control rule pinned to UTS #39 Revision 34.
- U+180B..U+180D and U+180F are not captured by the U+180E decision.
- U+2061..U+2064 are rejected only in repository path values under FC-3; this decision does not prohibit their use in file contents.
- U+034F is explicitly included even though its General_Category is Mn rather than Cf.
- No broad U+2060..U+206F range check is permitted.

If more than one independent policy applies to a code point, the implementation must retain all applicable reason codes and their provenance. It must not collapse policy attribution into one arbitrary reason.

## 4. U+200B condition — explicit fail-closed rule

Owner decision:
- U+200B is REJECTED in v1 path admission now.
- This rejection remains in force until DISP-1 is implemented and independently verified across every supported surface.
- Passing DISP-1 tests alone does not automatically authorize U+200B.
- After evidence is produced, a separate explicit owner decision is required to change U+200B from REJECT to DISPLAY_ONLY/ALLOW.
- No automatic time-based or deployment-based relaxation is permitted.

Required DISP-1 surfaces:
1. audit logs and event records;
2. review and approval interfaces;
3. terminal/CLI diagnostics;
4. browser and desktop UI;
5. exports, downloads and generated reports;
6. clipboard/copy operations;
7. error messages and support bundles;
8. API responses and any machine-readable diagnostics consumed by a human-facing layer.

Every such surface must display an unambiguous escaped representation, preserve the original underlying value without mutation, and prevent untrusted text from visually reordering trusted labels or records.

## 5. Admission and identity invariants

- FC-3 rejection occurs before request/content digest calculation, collision comparison, persistence, or external write.
- No rejected code point may be stripped, substituted, normalized, or silently rewritten.
- The original rejected input may be retained only under the applicable secure rejection-evidence/retention policy, and must be safely escaped on display.
- Accepted path values continue to follow R1-F: strict UTF-8, NFC-only, reject non-NFC, preserve exact accepted path representation.
- Collision-key generation remains comparison-only and cannot rewrite the Git path.
- FC-3 does not alter the already-approved NC-2 Noncharacter rule, Age=Unassigned rule, CC-1, BC-1, or JC-2.
- The Unicode version and source artifacts must be pinned; host runtime Unicode tables and locale must not control admission.

## 6. Compatibility costs accepted by the owner

The owner accepts the following limited v1 namespace costs:
- U+034F may be useful in specialized collation and scholarly/bibliographic text.
- U+180E has historical Mongolian text associations.
- U+200B has legitimate word/line-break semantics in Thai, Myanmar, Khmer, Japanese and other layout contexts.
- U+2061..U+2064 have mathematical-expression semantics.
- U+00AD, U+2060 and U+FEFF have legitimate text-layout or legacy stream semantics.

These semantics remain valid in Unicode text and file contents. The rejection applies only to repository path identity, where invisible distinctions create a high review and portability burden.

A later compatibility requirement may justify a separate domain-specific namespace or a new owner decision. It does not silently amend this v1 decision.

## 7. Verification requirements — NOT_RUN

Required test groups:
- exact positive/negative membership tests for all entries and exclusions;
- multi-policy reason-code preservation and deterministic ordering;
- path admission ordering: reject before digest/collision/persistence/write;
- proof that no normalization, stripping, or substitution occurs;
- Unicode 18.0.0 pinned data and reproducible artifact hashes/byte lengths;
- cross-runtime and cross-platform determinism;
- provider/Git-client/filesystem path round-trip;
- DISP-1 full-surface tests, including U+200B, before any future reconsideration;
- compatibility regression corpus for Persian ZWNJ, Arabic, Thai, Myanmar, Khmer, Japanese, Mongolian, Hebrew collation, mathematical/scientific repositories and mixed-script names.

All tests remain **NOT_RUN**. This document contains no test execution evidence.

## 8. Evidence and independent review gates

Before implementation authorization:
1. Produce a machine-readable exact FC-3 manifest from this decision, with a deterministic schema and version.
2. Download the exact Unicode 18.0.0 UCD source artifacts and verify byte lengths and SHA-256 independently.
3. Generate the manifest from pinned source inputs and independently reproduce it.
4. Add reason-code ownership and precedence rules without weakening prior owner decisions.
5. Prepare a new independent review package containing the exact SR-02 target blob, exact manifest digest, threat model, exclusions, compatibility impacts and adversarial vectors.
6. Obtain independent review results; R1-G remains NOT RECEIVED until actual review evidence is returned.
7. Run the required tests only after a separate implementation/test authorization.

## 9. Authorization boundary

- FC-3 v1 owner policy decision: **APPROVED**.
- Exact manifest documentation: **APPROVED**.
- Manifest machine artifact: **NOT CREATED**.
- Unicode source hashes/byte lengths: **NOT VERIFIED**.
- DISP-1: **NOT IMPLEMENTED / NOT VERIFIED**.
- Tests: **NOT_RUN**.
- Independent review: **NOT RECEIVED**.
- SR-02 full profile freeze: **NOT APPROVED**.
- Implementation: **NOT AUTHORIZED**.
- External GitHub write dispatch under SR-08: **DENY / NOT AUTHORIZED**.
- PR creation, merge, deployment, Cloudflare, Supabase, secrets, and laptop changes: **NOT AUTHORIZED**.

**Final decision:** The owner has approved the exact eight FC-3 v1 path-rejection outcomes listed in Section 2. U+200B remains rejected until DISP-1 is independently verified and a further explicit owner decision changes its status. This approval does not authorize implementation, tests, PR, merge or deployment.
