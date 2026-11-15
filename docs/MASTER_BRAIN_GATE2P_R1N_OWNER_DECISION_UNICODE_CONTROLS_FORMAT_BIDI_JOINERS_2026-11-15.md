# Master Brain — Gate 2P / R1-N Owner Decision: Unicode Control, Format, Bidi and Joiner Policy

**Document ID:** MB-G2P-R1N-OWNER-DECISION-UNICODE-CONTROLS-2026-11-15  
**Status:** OWNER DECISIONS RECORDED — PARTIAL PROFILE ONLY — NOT FROZEN — NOT IMPLEMENTED — NOT TESTED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Decision basis:** User approval in the current conversation, following R1-M audit.  
**Normative Unicode baseline candidate:** Unicode 18.0.0 and UTS #39 Revision 34 (2026-08-27).  
**Scope:** Record the approved policy choices for Cc, Bidi_Control, Join_Control, selected Cf/DICP controls, and security-sensitive display. This document does not approve the complete Unicode path profile or implementation.

## 1. Owner decisions

The owner approves the following policy directions for SR-02 v1:

| ID | Approved policy | Normative intent | Status |
|---|---|---|---|
| CC-1 | Reject every code point with General_Category=Cc | No Cc code point may occur in an admitted repository-relative path | OWNER-APPROVED |
| BC-1 | Reject every code point with Bidi_Control=Yes | Reject the complete version-pinned Bidi_Control property set, not a hand-maintained partial subset | OWNER-APPROVED |
| JC-2 | Permit U+200C ZWNJ and U+200D ZWJ only in UTS #39 limited contexts | Apply A1 and A2 to ZWNJ; apply B to ZWJ; enforce global script and NFC conditions | OWNER-APPROVED |
| FC-3 | Reject an explicit, version-pinned high-risk subset of Cf/DICP | Do not blanket-reject all Cf or all Default_Ignorable_Code_Point values; exact subset remains to be enumerated and approved | POLICY DIRECTION APPROVED; EXACT SET OPEN |
| DISP-1 | Require safe escaped rendering in security-sensitive surfaces | Logs, audit records, review UI, diagnostics and path previews must not render untrusted control/invisible characters ambiguously | OWNER-APPROVED |

These decisions are cumulative with earlier owner decisions R1-F (Option A path identity), R1-I (reject Unicode 18.0.0 Age=Unassigned), and R1-L (NC-2: reject Noncharacter_Code_Point=Yes).

## 2. Exact Join_Control profile reference

The versioned reference is **UTS #39 Revision 34**, corresponding to Unicode 18.0.0, dated 2026-08-27. The implementation must pin this exact revision, not a moving “latest” URL.

The approved JC-2 policy is:

- U+200C ZERO WIDTH NON-JOINER is accepted only under UTS #39 §3.1.1.1 conditions A1 or A2.
- U+200D ZERO WIDTH JOINER is accepted only under UTS #39 §3.1.1.1 condition B.
- The global script restriction applies: the specified sequence must consist of one script after ignoring Common and Inherited script characters.
- The global normalization condition applies. This SR-02 path profile independently requires NFC-only admission and rejects non-NFC input; it must not normalize a rejected path to make it pass.
- A1 uses Joining_Type properties: Left_Joining or Dual_Joining, followed by zero or more Transparent characters, then ZWNJ, then Right_Joining or Dual_Joining. No Transparent character is permitted after ZWNJ under Revision 34.
- A2 uses a Letter, optional Mn marks, a Virama, optional Mn marks with nonzero canonical combining class, ZWNJ, optional Mn marks with nonzero canonical combining class, then a Letter.
- B uses a Letter, optional Mn marks, a Virama, optional Mn marks with nonzero canonical combining class, then ZWJ, and the following code point must not have Indic_Syllabic_Category=Vowel_Dependent.
- All property lookups must use version-pinned Unicode 18.0.0 data. Host-runtime Unicode properties, locale behavior, and an unversioned regex engine are not authoritative.

The implementation must not claim full UTS #39 General Security Profile conformance merely because it applies the joiner contexts. The system is defining a narrower repository-path admission profile with explicit additions/removals and separate path rules.

## 3. Cc and Bidi_Control semantics

- CC-1 means every code point whose Unicode 18.0.0 General_Category is Cc is rejected in repository-relative paths. It is not limited to NUL, ASCII controls, or a hand-selected subset.
- BC-1 means every code point whose Unicode 18.0.0 Bidi_Control property is Yes is rejected. The property data, not a copied list in application code, is the source of truth.
- These are independent checks even where property sets overlap or where another policy already rejects a code point.
- Rejection must happen before canonical digest construction, collision-key comparison, persistence, or any external operation.
- No stripping, replacement, normalization, or silent repair is permitted.

## 4. FC-3 remains deliberately incomplete

The owner approved the FC-3 policy direction, not its exact membership list. Before contract freeze, a follow-up decision must enumerate the exact rejected code points or property-derived set using pinned Unicode 18.0.0 source data and record:

1. The exact property/file and version used for each subset.
2. Inclusion and exclusion rationale for each category.
3. Treatment of variation selectors, script-specific format controls, annotation controls, tag characters, and other default-ignorable characters.
4. Any overlap with Cc, Bidi_Control, Join_Control, and Noncharacter_Code_Point.
5. A reproducible generated manifest, source checksums, and tests proving exact membership.

The implementation must fail closed if the configured policy manifest is missing, mismatched, or cannot be verified. It must not silently substitute a newer Unicode database.

## 5. Safe display requirements

DISP-1 is separate from admission. A character rejected from a path may still appear in forensic input, error reports, or attack samples. Those surfaces must render untrusted input unambiguously.

Minimum requirements:

- Security-sensitive displays must expose code points for invisible, control, format, bidi, and otherwise policy-relevant characters, using an explicit notation such as `\\u{XXXX}` or a fixed-width equivalent.
- Rendering must not execute bidi controls or allow them to reorder trusted labels, metadata, delimiters, or adjacent records.
- Trusted labels and untrusted values must be structurally separated; no string concatenation may allow an input value to impersonate a label or field boundary.
- Logs and audit records must preserve the original byte/code-point evidence separately from the escaped presentation.
- Escaping must be deterministic, reversible for the represented input, and versioned. Truncation must be explicit and must not remove the only indication that content was truncated.
- A normal visual rendering may be offered only as a secondary view with a clear warning and a safe fallback. It is not the authoritative audit representation.

Exact escape grammar, terminal-specific behavior, HTML/UI encoding, copy/export behavior, and accessibility requirements remain open for a separate display-profile decision.

## 6. Required tests — NOT RUN

- R1N-CC-001: every Unicode 18.0.0 Cc code point is rejected.
- R1N-BC-001: every Unicode 18.0.0 Bidi_Control=Yes code point is rejected.
- R1N-JC-001: valid A1 ZWNJ sequence is accepted.
- R1N-JC-002: A1 sequence with Transparent after ZWNJ is rejected under Revision 34.
- R1N-JC-003: valid A2 ZWNJ conjunct sequence is accepted.
- R1N-JC-004: valid B ZWJ conjunct sequence is accepted.
- R1N-JC-005: ZWNJ outside A1/A2 is rejected.
- R1N-JC-006: ZWJ outside B is rejected.
- R1N-JC-007: mixed-script sequence fails the global script restriction.
- R1N-JC-008: non-NFC sequence is rejected before any normalization attempt.
- R1N-JC-009: property evaluation is identical across supported runtimes using the same pinned UCD artifacts.
- R1N-FC-001: exact FC-3 membership manifest is deterministic and checksum-verified (blocked until membership is approved).
- R1N-DISP-001: bidi controls cannot reorder trusted audit labels or adjacent records.
- R1N-DISP-002: invisible controls are represented explicitly in logs and review UI.
- R1N-DISP-003: escaping is deterministic and reversible; truncation is visible.
- R1N-DISP-004: original evidence and escaped display are separately retained and linked.

All tests above are **NOT_RUN**. Proposed test definitions are not test evidence.

## 7. Open blockers and falsification conditions

The following remain blockers to a frozen, executable Unicode path profile:

- Exact FC-3 membership list and owner approval.
- Exact Unicode 18.0.0 UCD artifact byte lengths and SHA-256 checksums.
- Version-pinned property extraction/generation process and independent verification.
- Exact DISP-1 escape grammar and behavior across terminal, browser, API, export, and copy surfaces.
- Cross-runtime implementation parity and supported-platform/provider path portability.
- Exact UTS #39 Revision 34 data dependencies and executable test corpus.
- Independent R1-G review of the exact revised SR-02 contract blob remains outstanding.

Falsification conditions include any accepted Cc or Bidi_Control path; any joiner accepted outside the pinned context rules; any cross-runtime disagreement; any display that allows an untrusted bidi control to alter trusted audit structure; or any UCD artifact whose bytes do not match the recorded checksum.

## 8. Gate and authorization status

- Owner decisions CC-1, BC-1, JC-2, DISP-1: RECORDED.
- FC-3 policy direction: RECORDED; exact membership: OPEN.
- Complete Unicode profile: NOT FROZEN.
- UCD artifact checksum pinning: NOT VERIFIED.
- Conformance tests: NOT_RUN.
- Independent R1-G review: NOT RECEIVED.
- Implementation: NOT AUTHORIZED.
- External GitHub write dispatch under SR-08: DENY / NOT AUTHORIZED.
- PR, merge, deployment, Cloudflare, Supabase, secrets, and laptop changes: NOT AUTHORIZED.

**Conclusion:** This record captures the approved policy decisions and preserves unresolved items as blockers. It does not claim implementation, test success, complete UTS #39 conformance, or readiness to freeze SR-02.
