# Master Brain — Gate 2P / R1-O: FC-3 Unicode Format-Control and Default-Ignorable Research

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Document ID:** MB-G2P-R1O-FC3-RESEARCH-2026-11-15  
**Status:** RESEARCH / POLICY OPTIONS — OWNER DECISION REQUIRED — NOT FROZEN — NOT IMPLEMENTED — NOT TESTED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Baseline:** Unicode 18.0.0; UTS #39 Revision 34  
**Dependencies:** R1-F Option A; R1-I Age=Unassigned rejection; R1-L NC-2; R1-M threat audit; R1-N owner decisions CC-1, BC-1, JC-2, FC-3 direction, DISP-1.

## 1. Purpose and scope

This research narrows the unresolved FC-3 policy. It does not create an owner decision and does not authorize implementation.

The target is repository-relative Git paths, not arbitrary document text. The policy must minimize invisible/path-identity ambiguity while preserving legitimate writing-system behavior. It must not treat every invisible character as malicious or equate General_Category=Cf with Default_Ignorable_Code_Point.

## 2. Authoritative Unicode 18.0.0 findings

### 2.1 Default_Ignorable_Code_Point

The official `DerivedCoreProperties-18.0.0.txt` defines DICP as derived from:

- Other_Default_Ignorable_Code_Point;
- all General_Category=Cf format characters;
- Variation_Selector;
- minus White_Space;
- minus U+FFF9..U+FFFB interlinear annotation format characters;
- minus U+13430..U+13440 Egyptian hieroglyph format characters;
- minus Prepended_Concatenation_Mark.

The file reports **4,174 code points** in DICP and explicitly states that DICP currently has **no general stability guarantees**. This is a decisive reason not to bind a long-lived path protocol to an unqualified runtime DICP property without pinning the exact UCD version and generated membership manifest.

The set includes materially different categories: combining grapheme joiner; Hangul fillers; Khmer inherent vowel signs; Mongolian variation selectors; ordinary variation selectors; zero-width and bidi controls; word joiner and invisible mathematical operators; reserved future ranges; shorthand format controls; musical notation controls; language tags and tag characters.

### 2.2 General_Category=Cf

The official Unicode 18.0.0 `DerivedGeneralCategory.txt` reports **170 code points** with General_Category=Cf. This set includes, among others:

- Arabic number signs and marks: U+0600..U+0605, U+0890..U+0891, U+08E2;
- Arabic Letter Mark: U+061C (also covered by BC-1);
- Arabic End of Ayah: U+06DD;
- Syriac Abbreviation Mark: U+070F;
- Mongolian Vowel Separator: U+180E;
- zero-width, bidi, word-joining and invisible mathematical controls;
- interlinear annotation controls U+FFF9..U+FFFB;
- Kaithi number signs U+110BD and U+110CD;
- Egyptian hieroglyph format controls U+13430..U+1343F;
- shorthand format controls U+1BCA0..U+1BCA3;
- musical format controls U+1D173..U+1D17A;
- language tag and tag characters U+E0001 and U+E0020..U+E007F.

This diversity falsifies a blanket rule “reject every Cf” as an acceptable general Unicode policy: several Cf characters encode script-, notation-, or layout-specific semantics.

### 2.3 UTS #39 profile implications

UTS #39 Revision 34 is the stable Unicode 18.0.0 security specification. It states that UTS conformance is independent of Unicode Standard conformance. Its General Security Profile classifies DICP as a restricted category by default, but permits a modified profile when the implementation documents precise additions/removals. It separately explains that blanket exclusion of join controls can make correct common words impossible and recommends context-limited handling.

The SR-02 path policy is not an identifier profile in the full UTS #39 sense. It may borrow specific mechanisms, but must not claim full General Security Profile conformance unless all applicable requirements are implemented and tested.

## 3. Policy set relationships and exclusions

The following checks are separate and must remain separately represented in the policy manifest:

1. CC-1: reject all Unicode 18.0.0 General_Category=Cc.
2. BC-1: reject all Unicode 18.0.0 Bidi_Control=Yes.
3. JC-2: allow U+200C/U+200D only under pinned UTS #39 Revision 34 contexts A1/A2/B.
4. NC-2: reject Noncharacter_Code_Point=Yes.
5. Age policy: reject code points whose Unicode 18.0.0 Age is Unassigned.
6. FC-3: explicit additional high-risk subset, still unresolved.
7. DISP-1: safe escaped rendering, independent of admission.

A character may match more than one property. The policy engine must preserve all matching reason codes in its decision evidence; it must not collapse them into one vague “invalid Unicode” result.

The following categories must not be implicitly swept into FC-3 without a separate owner decision:

- Join_Control U+200C/U+200D, already governed by JC-2;
- Bidi_Control, already rejected by BC-1;
- Noncharacters, already rejected by NC-2;
- Age=Unassigned code points, already rejected by R1-I;
- Variation_Selector ranges, because they can carry meaningful text/emoji presentation distinctions;
- script-specific Cf excluded from DICP by the derivation, including Arabic, Syriac, Kaithi and Egyptian hieroglyph controls;
- Private Use, whose policy remains separate and is not blanket-rejected by the earlier owner decision.

## 4. FC-3 candidate policy families

These are research options, not owner-approved decisions.

### Option FC3-A — Narrow path-ambiguity denylist (recommended for further evaluation)

Reject only explicitly enumerated invisible controls with direct path-boundary, display, or legacy-format ambiguity, selected from the Unicode 18.0.0 data. Candidate review set:

- U+00AD SOFT HYPHEN;
- U+034F COMBINING GRAPHEME JOINER;
- U+180E MONGOLIAN VOWEL SEPARATOR;
- U+200B ZERO WIDTH SPACE;
- U+2060 WORD JOINER;
- U+2061..U+2064 invisible mathematical operators;
- U+206A..U+206F deprecated directional formatting controls;
- U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM.

Important: this is a candidate review list only. It must not be applied until the owner decides each code point or group. In particular U+034F and U+180E have historical or script-specific behavior and require explicit compatibility evidence.

Advantages: small, auditable, limited collateral rejection.  
Risks: incomplete against specialized invisible format controls; requires a defensible threat model for each member.

### Option FC3-B — Narrow list plus specialized format-control families

Start with FC3-A and additionally evaluate:

- U+1BCA0..U+1BCA3 shorthand format controls;
- U+1D173..U+1D17A musical symbol format controls;
- U+E0001 and U+E0020..U+E007F language/tag characters;
- Hangul filler characters U+115F..U+1160, U+3164 and U+FFA0.

Advantages: covers more specialized invisible/control sequences in paths.  
Risks: may reject meaningful scholarly, musical, emoji tag-sequence, or script-specific material. Must not be selected solely because these code points are uncommon.

### Option FC3-C — Context-aware profile

Reject FC3-A candidates by default, but allow specific members only under a versioned, language/script-specific context validator with an explicit supported-script registry and safe-display rules.

Advantages: potentially preserves more legitimate filenames.  
Risks: larger attack surface; language identification and script-context errors; harder cross-runtime determinism; more expensive maintenance and test burden.

### Option FC3-D — DICP-based restriction with explicit exception registry

Treat DICP as restricted by default, then explicitly allow a curated exception set (including JC-2 and selected variation/script characters).

Advantages: strong conservative default and close conceptual relationship to UTS #39.
Risks: effectively broad DICP rejection; high compatibility cost; exception registry becomes a large and evolving language-support policy. This option may conflict with the owner's already approved direction not to blanket-reject all DICP and should not be selected without revisiting that decision.

## 5. Recommended evaluation direction

Recommend **FC3-A as the primary candidate for per-code-point owner review**, with FC3-B families considered separately rather than silently appended. This is a recommendation for evaluation only, not a policy decision.

Before owner approval, prepare a per-code-point decision table containing:

- code point/range and Unicode name;
- General_Category and all relevant binary properties;
- script/script extensions and joining/variation behavior where applicable;
- whether it is already rejected by CC-1, BC-1, NC-2 or Age policy;
- real-world filename use evidence;
- attack mechanism addressed;
- false-positive/collateral rejection risk;
- exact proposed outcome: reject / allow / context-allow / display-only warning;
- tests and falsification conditions.

## 6. Data provenance and checksum status

Official sources inspected:

- `https://www.unicode.org/Public/18.0.0/ucd/DerivedCoreProperties.txt`
  - Header identifies `DerivedCoreProperties-18.0.0.txt`, dated 2026-08-07.
  - DICP definition and total 4,174 appear in the file.
- `https://www.unicode.org/Public/18.0.0/ucd/extracted/DerivedGeneralCategory.txt`
  - Header identifies `DerivedGeneralCategory-18.0.0.txt`, dated 2026-06-29.
  - Cf total 170 appears in the file.
- `https://www.unicode.org/Public/18.0.0/ucd/PropList.txt`
  - Header identifies `PropList-18.0.0.txt`, dated 2026-08-07.
  - Bidi_Control total 12 and Join_Control total 2 are explicitly recorded.
- `https://www.unicode.org/reports/tr39/tr39-34.html`
  - UTS #39 Revision 34, Unicode 18.0.0, dated 2026-08-27.

The exact raw bytes were not downloaded into the working environment during this research step because direct network retrieval from the container was unavailable. Therefore exact byte lengths and SHA-256 checksums are **NOT VERIFIED**. Web-visible headers and excerpts are not cryptographic artifact verification. Do not substitute truncated checksums or checksums from a prerelease mirror.

Required next integrity step: retrieve the exact official release artifacts through a controlled, reproducible source path; verify their version headers; calculate full SHA-256 and byte length locally or in CI; independently reproduce those values; record retrieval URL, timestamp, file name, byte length, SHA-256, and verification tool/version.

## 7. Required test plan — NOT_RUN

- R1O-FC3-001: DICP set generated from exact pinned DerivedCoreProperties file equals 4,174 code points.
- R1O-FC3-002: Cf set generated from exact pinned DerivedGeneralCategory file equals 170 code points.
- R1O-FC3-003: property overlap report for Cf, DICP, Bidi_Control, Join_Control, Cc, Noncharacter_Code_Point and Age=Unassigned is deterministic.
- R1O-FC3-004: BC-1 and JC-2 precedence remains explicit and reason-coded.
- R1O-FC3-005: variation selectors are not rejected merely due to DICP membership.
- R1O-FC3-006: Arabic/Syriac/Kaithi/Egyptian script-specific Cf are not accidentally rejected by an overbroad Cf rule.
- R1O-FC3-007: candidate denylist membership is exact, version-pinned and deterministic.
- R1O-FC3-008: all candidate accepted/rejected path cases produce identical results across supported runtimes.
- R1O-FC3-009: safe escaped display preserves original evidence and prevents bidi reordering of trusted audit structure.
- R1O-FC3-010: missing or checksum-mismatched UCD artifacts fail closed.
- R1O-FC3-011: no candidate policy changes accepted Git path bytes or performs silent normalization.
- R1O-FC3-012: compatibility corpus includes Persian ZWNJ, Arabic, Syriac, Khmer, Hangul, Mongolian, emoji variation sequences, and representative scholarly/technical filenames.

All tests are **NOT_RUN**. Counts above are source-derived research findings, not test results.

## 8. Falsification criteria

The FC3-A recommendation must be rejected or revised if:

- any candidate code point is shown to be required for common, modern filename use in a supported language and no safe context rule is feasible;
- a supposedly high-risk candidate has no demonstrable path ambiguity or threat mechanism;
- an excluded character family permits a reproducible path spoofing or review-evasion attack not mitigated by DISP-1;
- two supported runtimes disagree on property membership or validation outcome;
- generated policy membership differs from the exact pinned source artifact;
- safe display does not preserve an auditable link to original code points/bytes.

## 9. Gate status and non-authorization

- FC-3 direction (explicit high-risk subset, not blanket Cf/DICP): OWNER-APPROVED by R1-N.
- FC-3 exact membership: OPEN / OWNER DECISION REQUIRED.
- FC3-A: RECOMMENDED FOR FURTHER EVALUATION, NOT APPROVED.
- FC3-B/FC3-C/FC3-D: ALTERNATIVES, NOT APPROVED.
- Unicode artifact SHA-256 and byte-length pinning: NOT VERIFIED.
- Tests: NOT_RUN.
- Independent review: NOT RECEIVED.
- SR-02 contract: NOT FROZEN.
- Implementation: NOT AUTHORIZED.
- External GitHub write dispatch under SR-08: DENY / NOT AUTHORIZED.
- PR, merge, deployment, secrets, Cloudflare, Supabase, and laptop changes: NOT AUTHORIZED.

**Conclusion:** The research narrows FC-3 to a small candidate set while preserving separate handling for script-specific format characters, variation selectors, joiners, bidi controls, noncharacters and unassigned code points. The next owner decision must be based on a per-code-point compatibility and threat table, not a blanket property rule.
