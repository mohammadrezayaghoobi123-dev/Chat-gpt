# Gate 2P R1-M — Unicode Control, Format, and Bidi Threat Audit

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15

## 1. Status and authorization boundary

**STATUS: RESEARCH / THREAT MODEL / PROPOSED TESTS — NOT AN OWNER POLICY DECISION — NOT A FREEZE**

This document continues the SR-02 Unicode path profile audit. It does not approve a policy for Control, Format, Bidi, Join_Control, or Default_Ignorable properties.

No source code was changed. No tests were executed. No implementation, PR, merge, deployment, or production action was performed or authorized.

Existing owner decisions remain:
- R1-F: strict UTF-8, NFC-only, preserve accepted path, reject non-NFC without rewriting.
- R1-I: reject Unicode 18.0.0 Age=Unassigned.
- R1-L: reject Unicode 18.0.0 Noncharacter_Code_Point=Yes.
- Private Use is not blanket-rejected by those decisions.
- SR-08 external GitHub write dispatch remains DENY / NOT AUTHORIZED.

## 2. Executive findings

1. `General_Category=Cc`, `General_Category=Cf`, `Bidi_Control`, `Join_Control`, and `Default_Ignorable_Code_Point` are not interchangeable sets.
2. Unicode 18.0.0 `PropList.txt` lists exactly 12 code points with `Bidi_Control=Yes`: U+061C, U+200E..U+200F, U+202A..U+202E, and U+2066..U+2069.
3. Unicode 18.0.0 `PropList.txt` lists exactly two `Join_Control` code points: U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH JOINER.
4. U+200C is materially used in Persian orthography; UTS #39 explicitly warns that blanket exclusion of join controls prevents correct forms of common words in some languages. UTS #39 describes limited contextual rules for retaining them.
5. `Default_Ignorable_Code_Point` contains 4,174 code points in Unicode 18.0.0 and its data file states that there are currently no general stability guarantees for DICP. It includes variation selectors, combining marks, fillers, and many format controls. Blanket rejection of the entire property would be a broad and potentially incompatible policy.
6. `General_Category=Cf` is broader than `Bidi_Control`. Some Cf characters have script, notation, or annotation functions; not every Cf is a bidi override or an invisible spoofing control.
7. Path admission and display safety are separate. A path may be accepted as data but must still be rendered safely in UI, logs, audit trails, diffs, and approval screens.
8. UTS #39 is an independent security standard. Unicode Standard conformance alone does not mean an implementation conforms to UTS #39.

## 3. Authoritative Unicode 18.0.0 data

### 3.1 Bidi_Control

Official source:
- https://www.unicode.org/Public/18.0.0/ucd/PropList.txt
- Header: `PropList-18.0.0.txt`
- Property count in the file: 12 code points.

Exact ranges:
- U+061C — ARABIC LETTER MARK
- U+200E..U+200F — LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK
- U+202A..U+202E — LRE, RLE, PDF, LRO, RLO
- U+2066..U+2069 — LRI, RLI, FSI, PDI

UAX #9 groups these as implicit directional marks, explicit embeddings/overrides, and explicit isolates. Embeddings and overrides can affect ordering beyond their immediate span; isolates are designed to limit effects to the isolated text. The distinction does not make a path-name control harmless: these code points can cause a displayed path to differ in visual ordering from its logical sequence.

### 3.2 Join_Control

Official source:
- https://www.unicode.org/Public/18.0.0/ucd/PropList.txt
- Property: `Join_Control`
- Exact members: U+200C and U+200D.

UTS #39 §3.1.1 says visible distinctions created by join controls are necessary in certain languages and that blanket exclusion makes correct forms of common words or phrases impossible. It describes contextual rules A1, A2, and B, with same-script and NFC conditions. Its Unicode 18.0.0 revision changed A1 to disallow Transparent characters after ZWNJ.

The Persian example in UTS #39 demonstrates that U+200C can distinguish two words. Therefore, a blanket rule rejecting U+200C is a real language-compatibility decision, not merely a harmless hardening step.

### 3.3 Default_Ignorable_Code_Point

Official source:
- https://www.unicode.org/Public/18.0.0/ucd/DerivedCoreProperties.txt
- Header: `DerivedCoreProperties-18.0.0.txt`
- Total: 4,174 code points.

The file documents its derivation:
- Other_Default_Ignorable_Code_Point
- plus Cf (Format characters)
- plus Variation_Selector
- minus White_Space
- minus U+FFF9..U+FFFB
- minus U+13430..U+13440
- minus Prepended_Concatenation_Mark.

The same file states: “There are currently no stability guarantees for DICP.”

The set includes:
- U+200B..U+200F, including ZWSP, ZWNJ, ZWJ, LRM, RLM;
- U+202A..U+202E and U+2066..U+206F;
- variation selectors U+FE00..U+FE0F and U+E0100..U+E01EF;
- Hangul fillers and other script-specific items;
- tag characters and reserved ranges.

Unicode 18 core specification explains that variation selectors and many format controls are invisible in ordinary rendering, but may affect neighboring characters. It recommends that misplaced format controls and variation selectors be visibly exposed in fallback rendering rather than silently ignored. This supports a safe-display requirement; it does not justify treating all DICP members as one universal reject set.

### 3.4 General_Category=Cc and Cf

- Cc is the Control category. It includes C0 and C1 controls. It is not identical to Bidi_Control.
- Cf is the Format category. It includes bidi controls, join controls, and other format characters.
- Bidi_Control is a binary property and the exact 12-code-point list above is more precise than rejecting every Cf.
- Join_Control is a separate binary property and must be evaluated separately from Bidi_Control.
- Default_Ignorable_Code_Point is a derived binary property, not a synonym for Cf.

Do not use `General_Category=Cf` as a shortcut for “bidi spoofing controls.” Do not use DICP as a shortcut for “all unsafe filename characters.”

## 4. Threat model

| Threat ID | Threat | Mechanism | Potential impact | Primary control |
|---|---|---|---|---|
| R1M-T-01 | Visual path spoofing | Bidi marks/embeddings/overrides reorder displayed name | Reviewer approves or deletes wrong-looking resource | Reject Bidi_Control or prove a narrowly justified exception; safe rendering |
| R1M-T-02 | Hidden path differentiation | Invisible format characters create visually identical names | Confusion, mistaken overwrite, misleading audit | Explicit property policy; visible escaped rendering; collision review |
| R1M-T-03 | Language corruption | Blanket rejection/removal of ZWNJ/ZWJ | Incorrect Persian/Arabic/Indic/Sinhala text | Contextual Join_Control policy; never silently strip |
| R1M-T-04 | Display/parser differential | UI hides a character that API/path layer preserves | Operator sees a different name from the actual path | Render code points/escaped form in security-sensitive views |
| R1M-T-05 | Log injection / line splitting | C0/C1 controls or separators enter logs and terminals | Forged log lines, broken parsing, misleading audit | Reject path controls; structured logs and escaping |
| R1M-T-06 | Default-ignorable overblocking | Reject all DICP | Breaks variation sequences and valid language/script forms | Do not blanket-reject DICP absent product-specific policy |
| R1M-T-07 | Runtime drift | Runtime property tables change by Unicode version | Different admission result across services | Pinned UCD data and checksums |
| R1M-T-08 | Renderer dependency | Browser/font/terminal render same path differently | Inconsistent human review | Canonical escaped audit representation plus display tests |

## 5. Policy alternatives — no option selected

### 5.1 Cc (Control category)

- **CC-1 — Reject all Cc in every path component.** Simple and defensible for path/log/terminal safety; may be stricter than Git's byte-level object capability but avoids control-driven ambiguity.
- **CC-2 — Reject only NUL and path separators; escape remaining Cc.** Higher compatibility, but creates operational risk in logs, terminals, and UI; requires every consumer to escape perfectly.
- **CC-3 — Reject C0, C1, and line/paragraph separators through an explicit versioned set.** More precise than broad Cc but more complex and needs exact normative list.

Evaluation-only recommendation: CC-1 for a portable, auditable path namespace. This is NOT an owner decision.

### 5.2 Bidi_Control

- **BC-1 — Reject all 12 Bidi_Control code points.** Strongest simple path-name policy; Arabic/Hebrew letters remain allowed, but explicit direction-control characters cannot be embedded in the path.
- **BC-2 — Allow bidi controls but escape them in every security-sensitive display.** Better input compatibility, but the system must guarantee that no UI, log, diff, notification, or terminal path displays them unsafely.
- **BC-3 — Allow only selected controls/contexts.** More nuanced, but requires a formally specified context grammar and a security review.

Evaluation-only recommendation: BC-1 for path components, while UI text containing arbitrary prose must use proper bidi isolation rather than reusing path rendering. This is NOT an owner decision.

### 5.3 Join_Control

- **JC-1 — Reject both U+200C and U+200D.** Simplest attack surface; material loss of orthographic correctness and some emoji/script behavior.
- **JC-2 — Allow U+200C/U+200D only under UTS #39 contextual rules.** Better language support; adds script, joining-type, virama, and NFC-context logic. UTS #39 notes that its constraints reduce but do not eliminate visual confusability.
- **JC-3 — Allow both everywhere, but escape and annotate in security views.** Maximum compatibility; larger spoofing and review burden.
- **JC-4 — Allow U+200C under contextual rules; treat U+200D separately with language and emoji-sequence rules.** More targeted, but needs a complete sequence grammar and versioned emoji data.

Evaluation-only recommendation: do not blanket-reject U+200C without an explicit product decision about Persian and other scripts. JC-2 is a defensible baseline if the system needs multilingual path names; however, it should not be implemented without independent vectors and exact UTS #39 version pinning. This is NOT an owner decision.

### 5.4 Other Cf and DICP

- **FC-1 — Reject all Cf.** Strong reduction in invisible formatting, but also rejects Join_Control, script-specific and annotation/notation format characters.
- **FC-2 — Reject all DICP.** Broad and easy to state, but overblocks variation selectors and other characters; DICP has no general stability guarantees.
- **FC-3 — Reject a pinned explicit list of high-risk format controls; separately handle join controls and variation selectors.** Most precise, but requires a complete threat model, exact UCD files, and tests.
- **FC-4 — Allow all except Bidi_Control and Cc; require safe display.** Highest compatibility among these choices, but does not prevent every invisible-character ambiguity.

Evaluation-only recommendation: FC-3. Do not use blanket Cf or DICP rejection as a proxy for security.

## 6. Safe display is a separate mandatory design concern

Regardless of admission policy, every security-sensitive UI surface should:
- retain the exact logical path bytes and code-point sequence;
- provide a deterministic escaped representation, e.g. `\\u{202E}`, without relying on font rendering;
- show the raw path and escaped path together in review/audit contexts;
- isolate the displayed path from surrounding UI text using UI-level direction isolation;
- never apply Unicode normalization, case folding, stripping, or bidi reordering to the stored path;
- ensure copy/export actions preserve exact path bytes or clearly label any transformed display representation;
- escape controls in logs and terminal output;
- distinguish a display-only escaped representation from the authoritative Git path.

This is a design requirement proposal, not an implementation claim.

## 7. Proposed test vectors — NOT RUN

### 7.1 Control and Bidi vectors

| ID | Code point / input | Expected observation |
|---|---|---|
| R1M-T-001 | U+0000 | Strict path admission must reject; NUL is not valid in Git path components |
| R1M-T-002 | U+000A | Verify Cc policy and ensure no log-line injection |
| R1M-T-003 | U+000D | Verify Cc policy and ensure no log-line injection |
| R1M-T-004 | U+0085 | Verify C1 control policy |
| R1M-T-005 | U+061C | Bidi_Control membership; apply owner-selected BC policy |
| R1M-T-006 | U+200E / U+200F | Bidi_Control membership; apply owner-selected BC policy |
| R1M-T-007 | U+202A..U+202E | All must be detected as Bidi_Control |
| R1M-T-008 | U+2066..U+2069 | All must be detected as Bidi_Control |
| R1M-T-009 | Mixed LTR/RTL filename with RLO | Display must not conceal actual logical code-point order |
| R1M-T-010 | Unbalanced isolate / embedding controls | Must be rejected under BC-1 or rendered visibly and safely under another approved policy |

### 7.2 Join-control vectors

| ID | Input | Expected observation |
|---|---|---|
| R1M-J-001 | Persian word without ZWNJ | Preserve exact input |
| R1M-J-002 | Same Persian word with U+200C in correct orthographic position | Must not silently remove; outcome depends on JC decision |
| R1M-J-003 | U+200C in arbitrary invalid context | Reject if JC-2; otherwise visible/escaped warning under JC-3 |
| R1M-J-004 | U+200D in valid emoji ZWJ sequence | Do not assume it is equivalent to arbitrary invisible control |
| R1M-J-005 | U+200D outside recognized context | Apply selected JC policy deterministically |
| R1M-J-006 | ZWJ/ZWNJ in mixed-script sequence | Verify UTS #39 script restriction if JC-2 selected |

### 7.3 DICP / variation-selector vectors

| ID | Input | Expected observation |
|---|---|---|
| R1M-D-001 | U+00AD SOFT HYPHEN | DICP membership; no blanket policy inferred |
| R1M-D-002 | U+034F COMBINING GRAPHEME JOINER | DICP membership; verify script/text impact |
| R1M-D-003 | U+FE0F variation selector-16 after emoji base | Verify standardized emoji variation sequence behavior |
| R1M-D-004 | U+E0100 variation selector-17 after valid ideographic base | Verify standardized ideographic variation sequence behavior |
| R1M-D-005 | Isolated/misplaced variation selector | UI must visibly expose or safely flag it; do not silently erase |
| R1M-D-006 | U+E0020..U+E007F tag sequence | Verify exact sequence policy and safe display |
| R1M-D-007 | Egyptian Hieroglyph format controls U+13430..U+1343F | Confirm not all Cf are DICP and fallback display is visible |

### 7.4 Property and implementation invariants

- Parse Unicode 18.0.0 `Bidi_Control` from the pinned `PropList.txt`; expected set size is exactly 12.
- Parse `Join_Control`; expected set size is exactly 2.
- Parse `Default_Ignorable_Code_Point` from the pinned `DerivedCoreProperties.txt`; expected set size is 4,174 for this exact version.
- Verify Bidi_Control is a subset of Cf in the same pinned UCD.
- Verify Join_Control is a subset of Cf and overlaps the DICP set as specified by the data.
- Verify no policy predicate silently strips or rewrites any accepted code point.
- Verify UI/log escaped rendering is reversible and unambiguous.
- Verify all admission decisions are independent of host runtime Unicode tables.

All vectors are specifications only. No execution is claimed.

## 8. Falsification criteria

Reject or revise a candidate policy if:
- the exact Unicode 18.0.0 property set differs from the expected parsed set;
- a Bidi_Control character is admitted under a selected reject policy;
- a valid Persian/Indic/Sinhala orthographic example is silently changed or corrupted;
- a renderer can show a misleading path while the escaped audit view does not expose the differing code points;
- any log/terminal/UI surface interprets a control character rather than escaping it;
- a variation sequence is silently stripped or transformed;
- host runtime Unicode version changes an admission result;
- the policy claims full UTS #39 conformance without implementing its normative requirements and declared modifications.

## 9. Remaining owner decisions

The following are deliberately left open:
- CC-1 / CC-2 / CC-3: Control category policy.
- BC-1 / BC-2 / BC-3: Bidi_Control policy.
- JC-1 / JC-2 / JC-3 / JC-4: Join_Control policy.
- FC-1 / FC-2 / FC-3 / FC-4: Other Cf and DICP policy.
- Whether to require safe escaped rendering as a release gate across UI, logs, diffs, notifications, and exports.
- Whether file names are treated as security identifiers for the purpose of adopting a tailored UTS #39 profile.

No default choice is implied by the ordering of the options.

## 10. Gate status

- R1-F strict UTF-8/NFC/preserve accepted path: OWNER-APPROVED.
- R1-I Age=Unassigned rejection: OWNER-APPROVED.
- R1-L Noncharacter_Code_Point rejection: OWNER-APPROVED.
- Control policy: OPEN.
- Bidi_Control policy: OPEN.
- Join_Control policy: OPEN.
- Other Cf policy: OPEN.
- DICP policy: OPEN.
- Safe display requirement: PROPOSED.
- Unicode UCD artifact hashes: NOT VERIFIED.
- Cross-runtime/platform tests: NOT RUN.
- Independent R1-G review: NOT RECEIVED.
- SR-02 freeze: NOT APPROVED.
- Implementation / PR / merge / deploy: NOT AUTHORIZED.
- SR-08 external GitHub write dispatch: DENY / NOT AUTHORIZED.

**Conclusion:** the Unicode data supports a property-specific policy, not a blanket “reject all Cf/DICP” rule. Bidi_Control is a narrow 12-code-point set; Join_Control is a two-code-point set with documented orthographic importance; DICP is a much broader, non-stability-guaranteed set. The next owner decision should be made separately for Cc, Bidi_Control, Join_Control, and remaining Cf/DICP, with safe rendering treated as an independent control.
