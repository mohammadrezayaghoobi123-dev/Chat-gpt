# Master Brain — Gate 2P / R1-P: FC3-A Per-Code-Point Security and Compatibility Review

**Document ID:** MB-G2P-R1P-FC3A-PER-CODEPOINT-REVIEW-2026-11-15  
**Status:** TECHNICAL REVIEW — OWNER DECISION REQUIRED — NOT FROZEN — NOT IMPLEMENTED — NOT TESTED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Unicode baseline:** 18.0.0  
**Security reference:** UTS #39 Revision 34  
**Scope:** Evaluate the eight FC3-A candidate groups item-by-item for repository-relative Git path admission. This document does not make owner decisions.

## 1. Decision semantics

Each candidate is assessed against four independent dimensions:

1. **Security:** whether invisible or context-changing content can create a misleading path presentation or audit ambiguity.
2. **Legitimate use:** whether Unicode defines a real script, collation, text-layout, mathematical, or compatibility function.
3. **Mitigation:** whether exact-byte identity, escaped display, collision detection, and safe review UI sufficiently mitigate the risk without rejection.
4. **Recommendation:** a proposed outcome for owner decision, not an implemented rule.

Outcomes:
- `REJECT`: disallow in repository path input.
- `ALLOW`: allow, with DISP-1 still mandatory.
- `CONTEXTUAL`: allow only under an exact, version-pinned context validator.
- `DISPLAY_ONLY`: do not reject solely on this basis; require visible escaped representation and audit warning.

No candidate is rejected merely because it is DICP or invisible. No transformation, stripping, replacement, or normalization is allowed.

## 2. Critical range corrections

The former shorthand candidate “U+206A..U+206F deprecated directional controls” must be narrowed:

- U+2066..U+2069 are Bidi_Control characters and are already rejected by BC-1.
- U+206A..U+206F are six deprecated format characters, specifically the symmetric swapping, Arabic form shaping, and digit-shape selectors.
- U+2065 is unassigned in Unicode 18.0.0 and is already rejected by the Age=Unassigned rule.
- U+2060 is WORD JOINER.
- U+2061..U+2064 are mathematical invisible operators.

This prevents duplicate policy membership and makes each rejection reason auditable.

## 3. Per-code-point assessment

### 3.1 U+00AD SOFT HYPHEN

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- Unicode 18.0.0 describes it as an intraword discretionary break point. A visible hyphen may appear when a line is broken; rendering depends on script, language and context.
- It can be used with any script, although usage is generally limited to cases where a user overrides automatic hyphenation.

**Threat**
- In many path viewers it has no visible glyph, allowing two distinct path strings to appear identical.
- It is not a filesystem separator and is not needed for Git path structure.
- Its rendering can differ across viewers, creating inconsistent review evidence.

**Compatibility**
- It has legitimate text-layout semantics, but repository path components are identifiers, not flowing prose. The expected filename use case is narrower than ordinary text use.

**Recommendation:** `REJECT` for repository path components. Preserve the original code point in rejection evidence and show it escaped. Do not silently delete it.

**Falsification condition:** evidence of material, established repository filename use that cannot be represented safely with visible hyphen or another filename convention would require revisiting the policy.

### 3.2 U+034F COMBINING GRAPHEME JOINER

**Unicode facts**
- General_Category=Mn, not Cf.
- Default_Ignorable_Code_Point=Yes.
- Canonical_Combining_Class=0.
- It does not visibly join graphemes or affect cursive joining. It can affect language-sensitive collation and prevent canonical reordering of combining marks; Unicode documents examples involving Hebrew points and bibliographic distinctions.

**Threat**
- It is invisible yet can distinguish strings and preserve distinctions that normalization would otherwise erase.
- It can create visually identical but byte/code-point-distinct repository paths.
- The SR-02 protocol must not normalize away or erase this distinction.

**Compatibility**
- It has genuine collation and scholarly/bibliographic uses. It is not safe to characterize it as an obsolete or meaningless control.
- Because the path identity contract is exact-byte identity, allowing it is technically possible, but it increases the burden on every review and file-list surface.

**Recommendation:** `REJECT` for repository path components as a narrow namespace policy, while explicitly documenting that this is not a general Unicode text prohibition. The risk is invisible path aliasing; the cost is that specialized collation distinctions cannot be encoded directly in filenames.

**Falsification condition:** if the product requires scholarly/bibliographic filenames with CGJ as an identity-bearing character, consider a separate domain-specific namespace rather than weakening the global repository path policy.

### 3.3 U+180E MONGOLIAN VOWEL SEPARATOR

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- Unicode 18.0.0 classifies it as a format character.
- It is historically associated with Mongolian text behavior. It must not be confused with Mongolian free variation selectors U+180B..U+180D and U+180F, which are Mn characters.

**Threat**
- It is visually non-obvious and can distinguish a path while escaping ordinary review.
- It is not a path separator and does not contribute to the structural Git path grammar.

**Compatibility**
- Historical Mongolian text may contain it. A blanket statement that it has no legitimate language history would be incorrect.
- The current repository-path use case has not established a requirement for it.

**Recommendation:** `REJECT` for v1 repository paths, subject to explicit compatibility corpus review for Mongolian filenames. Do not extend the rejection to U+180B..U+180D or U+180F by range accident.

**Falsification condition:** supported Mongolian filename corpus demonstrates a material need for U+180E that cannot be handled by a domain-specific naming convention.

### 3.4 U+200B ZERO WIDTH SPACE

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- Unicode 18.0.0 defines it as a word/line break opportunity with no intrinsic width.
- It is intended for languages that do not use visible word spacing, including Thai, Myanmar, Khmer and Japanese.

**Threat**
- It can create two visually identical path strings.
- It can disrupt tightly defined combining sequences when inserted in the middle of such sequences.
- Many ordinary path viewers do not show its presence.

**Compatibility**
- Unlike several other candidates, it has a documented language-layout function in multiple writing systems.
- It is not appropriate to reject it merely because it is invisible.

**Recommendation:** `CONTEXTUAL` is not recommended for v1 because reliable language detection and script-context validation would introduce a new, difficult-to-audit policy surface. Preferred v1 decision is `DISPLAY_ONLY`: allow exact code point identity but mandate escaped rendering, a warning in security-sensitive UI, and collision checks. If a stricter namespace is required, a separate owner decision may choose rejection with an explicit language-compatibility cost.

**Falsification condition:** if any supported provider, UI, Git integration, or audit surface cannot reliably preserve and visibly escape U+200B, the allow recommendation is unsafe and must change to REJECT.

### 3.5 U+2060 WORD JOINER

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- It is invisible and prevents line breaks between adjacent characters.
- Unicode 18.0.0 strongly prefers U+2060 over U+FEFF when word-joining semantics are intended in new text.

**Threat**
- It can distinguish path strings without visible evidence.
- It can alter text segmentation/line wrapping in review surfaces.
- It can be inserted into tightly defined sequences and disrupt their rendering.

**Compatibility**
- It has a legitimate word-layout role in text, but no structural role in repository paths.
- Unlike ZWSP, its primary effect is to prohibit a break, not to provide a needed break opportunity.

**Recommendation:** `REJECT` for repository path components. Preserve exact rejected input in escaped audit evidence.

**Falsification condition:** a concrete supported repository filename use case demonstrates a requirement that cannot be represented with visible characters and is not safely served by DISP-1.

### 3.6 U+2061..U+2064 INVISIBLE MATHEMATICAL OPERATORS

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- Unicode 18.0.0 assigns them mathematical semantics: FUNCTION APPLICATION, INVISIBLE TIMES, INVISIBLE SEPARATOR, and INVISIBLE PLUS.
- The Unicode Core Specification describes U+2061 FUNCTION APPLICATION as having no text-display effect and being used in internal mathematical expression processing.

**Threat**
- Their mathematical semantics are not visually represented in ordinary path listings.
- A path containing them can be visually indistinguishable from another path while having different mathematical interpretation in a specialized parser.
- They may be used to evade visual review.

**Compatibility**
- They are meaningful in mathematical expression processing. However, a repository path is not itself a mathematical expression stream.
- Scientific repositories may contain mathematical artifacts, but filenames can generally use visible separators or descriptive text instead.

**Recommendation:** `REJECT` all four code points in repository path components. This is a namespace-specific rule, not a ban on their use in mathematical content files.

**Falsification condition:** an established file-naming convention requires these code points as identity-bearing path characters and no safe visible representation exists.

### 3.7 U+206A..U+206F DEPRECATED FORMAT CHARACTERS

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- Unicode 18.0.0 identifies six characters: INHIBIT/ACTIVATE SYMMETRIC SWAPPING, INHIBIT/ACTIVATE ARABIC FORM SHAPING, NATIONAL DIGIT SHAPES and NOMINAL DIGIT SHAPES.
- Unicode strongly discourages their use and recommends explicit character codes/default behavior instead.

**Threat**
- They are invisible stateful controls that can affect interpretation or presentation of following characters.
- Their state can extend until a paired selector appears; they do not nest.
- This makes review and rendering behavior harder to reason about.

**Compatibility**
- They are deprecated. Equivalent intended content can generally use explicit characters or modern shaping behavior.
- U+2066..U+2069 must not be included here: those are Bidi_Control and are already rejected by BC-1.
- U+2065 is unassigned and is already rejected by the Age policy.

**Recommendation:** `REJECT` U+206A..U+206F. Record the reason as FC-3 deprecated stateful format controls, not BC-1.

**Falsification condition:** a supported legacy interchange requirement demonstrates that these code points must occur in repository path names rather than file contents.

### 3.8 U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM

**Unicode facts**
- General_Category=Cf; Default_Ignorable_Code_Point=Yes.
- Unicode 18.0.0 states that its most important current use is as a byte-order/encoding signature at the beginning of a serialized stream.
- Its legacy word-joining semantics remain for backward compatibility; U+2060 is preferred for new word-joining text.
- In UTF-8, BOM bytes are EF BB BF. A stream processor may consume an initial BOM as a signature, but in other contexts U+FEFF is a character and cannot be freely deleted.

**Threat**
- It is visually invisible and can make a path component appear to have an unexpected prefix or internal character.
- Confusion between byte-stream BOM handling and path-string content risks inconsistent decoding or silent stripping.
- Different adapters may treat an initial U+FEFF differently unless the path protocol explicitly forbids it.

**Compatibility**
- A BOM is a stream signature, not a meaningful repository path character.
- A literal U+FEFF used for legacy word joining is superseded by U+2060 for new text.

**Recommendation:** `REJECT` U+FEFF anywhere in a repository path. A UTF-8 BOM at the beginning of an input transport must be handled by the transport/parser contract, never silently stripped from a path value. If the path value itself begins with U+FEFF, reject it with explicit evidence.

**Falsification condition:** a supported protocol requires literal U+FEFF as path data. No such requirement is currently established.

## 4. Consolidated recommendation matrix

| Candidate | Unicode category / key semantics | Main risk | Legitimate-use cost | Proposed v1 outcome |
|---|---|---|---|---|
| U+00AD | Cf; discretionary hyphenation | invisible path distinction | low for paths; real text-layout use | REJECT |
| U+034F | Mn; collation/canonical-order distinction | invisible identity distinction | medium/high for specialized scholarly collation | REJECT |
| U+180E | Cf; historical Mongolian separator | invisible path distinction | medium; requires Mongolian corpus check | REJECT, corpus gate |
| U+200B | Cf; word/line break opportunity | invisible path distinction | high for Thai/Myanmar/Khmer/Japanese text processing | DISPLAY_ONLY |
| U+2060 | Cf; no-break control | invisible path distinction and wrapping ambiguity | low for paths | REJECT |
| U+2061..2064 | Cf; invisible mathematical operators | invisible semantic distinction | low for path namespace; meaningful in math streams | REJECT |
| U+206A..206F | Cf; deprecated stateful controls | stateful presentation ambiguity | very low; Unicode strongly discourages | REJECT |
| U+FEFF | Cf; BOM / legacy no-break | parser/transport ambiguity and invisible prefix | low for path names | REJECT |

These are recommendations, not owner-approved final outcomes. FC-3 membership must be represented as an explicit enumerated manifest, not a vague property expression.

## 5. Required policy-engine behavior

- Every rejected code point must produce a stable reason code and code-point offset.
- If multiple policies match, preserve all matching reason codes; do not erase provenance by choosing one arbitrary reason.
- Rejection occurs before digest calculation, collision comparison, persistence, or external write.
- Accepted U+200B must remain byte-for-byte/code-point-for-code-point unchanged; no stripping or normalization.
- DISP-1 escaped rendering applies to every candidate, including rejected values, and is independent from admission.
- The authoritative path identity remains the exact accepted UTF-8 NFC representation established by R1-F.
- Collision-key generation remains a comparison-only operation and must not rewrite the Git path.
- No policy decision may depend on host runtime Unicode tables or locale.

## 6. Required tests — NOT_RUN

- R1P-FC3-001: U+00AD rejected with exact reason and code-point offset.
- R1P-FC3-002: U+034F rejected even though General_Category=Mn, proving FC-3 is not a Cf-only filter.
- R1P-FC3-003: U+180E rejected while U+180B..U+180D and U+180F are not accidentally rejected by range expansion.
- R1P-FC3-004: U+200B accepted only if DISP-1 is active and every supported security-sensitive surface renders it escaped; otherwise fail closed.
- R1P-FC3-005: U+2060 rejected.
- R1P-FC3-006: U+2061..U+2064 rejected with exact code-point identity and no broad 2060..206F policy shortcut.
- R1P-FC3-007: U+206A..U+206F rejected; U+2066..U+2069 are attributed to BC-1; U+2065 attributed to Age=Unassigned.
- R1P-FC3-008: U+FEFF rejected in all path positions; transport BOM behavior is separately tested and cannot mutate a supplied path.
- R1P-FC3-009: no accepted path is silently normalized, stripped, or replaced.
- R1P-FC3-010: all reason codes remain deterministic across supported runtimes.
- R1P-FC3-011: escaped display is unambiguous in browser, terminal, exported report, logs and copy operations.
- R1P-FC3-012: compatibility corpus includes Persian ZWNJ, Arabic, Thai, Myanmar, Khmer, Japanese, Mongolian, Hebrew collation, mathematical/scientific repositories and mixed-script filenames.

All tests are **NOT_RUN**. Test definitions are not test evidence.

## 7. Sources and provenance

Primary sources:
- Unicode 18.0.0 DerivedCoreProperties: `https://www.unicode.org/Public/18.0.0/ucd/DerivedCoreProperties.txt`
- Unicode 18.0.0 DerivedGeneralCategory: `https://www.unicode.org/Public/18.0.0/ucd/extracted/DerivedGeneralCategory.txt`
- Unicode 18.0.0 Core Specification, Chapter 23: `https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-23/`
- Unicode 18.0.0 Core Specification, Chapter 5: `https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-5/`
- Unicode FAQ: Characters and Combining Marks: `https://unicode.org/faq/char_combmark.html`
- UTS #39 Revision 34: `https://www.unicode.org/reports/tr39/tr39-34.html`

The official sources establish semantics and property membership. They do not establish that any candidate is a real attack in this particular repository. That requires path-provider, Git client, UI, and audit-surface testing.

Exact raw UCD artifact byte lengths and SHA-256 checksums remain **NOT VERIFIED**. Web-rendered source content is not a cryptographic integrity check.

## 8. Open evidence and decision gates

1. Owner decision on each proposed FC-3 outcome.
2. Mongolian filename compatibility corpus for U+180E.
3. Thai/Myanmar/Khmer/Japanese path corpus and proof that DISP-1 can reliably expose U+200B in every supported surface.
4. Scholarly/bibliographic corpus assessment for U+034F.
5. Mathematical/scientific filename corpus for U+2061..U+2064.
6. Exact UCD artifact download, byte-length and SHA-256 pinning, with independent reproduction.
7. Independent R1-G review of the exact revised SR-02 contract blob.
8. Executable tests and cross-runtime/provider portability evidence.

## 9. Gate and authorization status

- FC3-A per-code-point review: DOCUMENTED.
- Proposed outcomes: RECOMMENDATIONS ONLY.
- Owner approval of exact FC-3 membership: PENDING.
- UCD artifact checksums: NOT VERIFIED.
- Tests: NOT_RUN.
- Independent review: NOT RECEIVED.
- SR-02: NOT FROZEN.
- Implementation: NOT AUTHORIZED.
- External GitHub write dispatch under SR-08: DENY / NOT AUTHORIZED.
- PR, merge, deployment, Cloudflare, Supabase, secrets, and laptop changes: NOT AUTHORIZED.

**Conclusion:** The candidate range has been decomposed into exact code points and policy-owned groups. The strongest current recommendation is to reject invisible, non-language-essential path controls; preserve U+200B only if escaped display is proven reliable; and explicitly recognize that U+034F and U+180E carry legitimate historical or specialized semantics. Owner approval and compatibility evidence remain mandatory before FC-3 can be frozen.
