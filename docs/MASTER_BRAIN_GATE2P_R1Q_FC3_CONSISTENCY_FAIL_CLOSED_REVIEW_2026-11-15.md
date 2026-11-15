# Master Brain — Gate 2P / R1-Q: FC-3 Recommendation Consistency and Fail-Closed Review

**Document ID:** MB-G2P-R1Q-FC3-CONSISTENCY-FAIL-CLOSED-REVIEW-2026-11-15  
**Status:** TECHNICAL CONSISTENCY REVIEW — OWNER DECISION REQUIRED — NOT FROZEN — NOT IMPLEMENTED — NOT TESTED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Baseline:** Unicode 18.0.0; UTS #39 Revision 34  
**Inputs:** R1-M, R1-N, R1-O, R1-P and official Unicode 18.0.0 Core Specification / UTS #39.

## 1. Purpose

This review challenges the R1-P recommendations before any owner decision or contract update. It checks for:
- overlapping policy ownership;
- false claims about Unicode semantics;
- acceptance paths that rely on unimplemented controls;
- hidden compatibility costs;
- incomplete test or provenance requirements.

It does not approve or freeze FC-3, change code, or authorize tests, PRs, merges or deployments.

## 2. Confirmed corrections and authoritative facts

### 2.1 U+2060..U+206F is not one semantic class

Unicode 18.0.0 Core Specification Chapter 5 explicitly treats U+2060..U+206F as a Default_Ignorable_Code_Point range, including unassigned code points in the range for fallback display. Chapter 23 and the character charts distinguish:
- U+2060 WORD JOINER;
- U+2061 FUNCTION APPLICATION;
- U+2062 INVISIBLE TIMES;
- U+2063 INVISIBLE SEPARATOR;
- U+2064 INVISIBLE PLUS;
- U+2065, unassigned in Unicode 18.0.0;
- U+2066..U+2069 bidi isolate controls, already covered by BC-1;
- U+206A..U+206F six deprecated format controls.

Therefore FC-3 must not encode a broad U+2060..U+206F range. It must use exact code-point membership and preserve distinct reason codes:
- U+2060 → FC3-WORD-JOINER;
- U+2061..U+2064 → FC3-INVISIBLE-MATH-OPERATOR;
- U+2065 → AGE-UNASSIGNED;
- U+2066..U+2069 → BIDI-CONTROL;
- U+206A..U+206F → FC3-DEPRECATED-FORMAT.

### 2.2 U+200B has real language-layout function

Unicode 18.0.0 Chapter 23 states that U+200B ZERO WIDTH SPACE indicates a word or line break opportunity despite having no intrinsic width, and is intended for writing systems without visible word spacing, including Thai, Myanmar, Khmer and Japanese.

This confirms that blanket rejection has nontrivial internationalization cost. It does not establish that every repository provider, browser, terminal, log pipeline, or copy/export path can safely display it.

### 2.3 U+2061..U+2064 are mathematical operators

Unicode 18.0.0 chart U+2000.pdf identifies U+2061..U+2064 as FUNCTION APPLICATION, INVISIBLE TIMES, INVISIBLE SEPARATOR and INVISIBLE PLUS. They are semantic mathematical operators, not generic direction controls. The namespace may reject them in paths, but must not ban them from file contents.

### 2.4 U+206A..U+206F are deprecated

Unicode 18.0.0 chart U+2000.pdf lists U+206A..U+206F as deprecated and states that use is strongly discouraged. This supports a path-specific rejection recommendation. It does not justify attributing these code points to BC-1.

### 2.5 U+FEFF and U+2060 are not interchangeable at the transport boundary

Unicode 18.0.0 Chapter 23 explains that U+FEFF has a byte-order-mark role and legacy zero-width no-break semantics, while U+2060 is preferred for new word-joining text. The protocol must distinguish:
- an encoding signature in an input byte stream;
- a literal U+FEFF code point inside the decoded path value.

A transport BOM may be consumed only by a documented decoder boundary before path parsing. Once a path value is defined, U+FEFF in that value must not be silently stripped or rewritten.

### 2.6 UTS #39 revision pin

UTS #39 Revision 34 is the stable Unicode 18.0.0 revision. It changed the ZWNJ A1 context rule to disallow Transparent characters after ZWNJ. Any JC-2 implementation must pin Revision 34 and its UCD dependencies. The SR-02 path profile must not claim full UTS #39 General Security Profile conformance unless all relevant conformance requirements are met.

## 3. R1-P recommendation consistency findings

### Q-01 — U+200B conditional acceptance is not currently satisfiable

R1-P proposes DISPLAY_ONLY for U+200B, but requires escaped display on every security-sensitive surface. No such implementation or cross-surface test evidence exists.

**Finding:** It is invalid to treat U+200B as currently ALLOWED.  
**Required interim status:** `CONDITIONAL / NOT PROVEN`.  
**Fail-closed rule:** Until DISP-1 is implemented and verified on every supported surface, U+200B must be rejected by the admission profile or the entire path admission operation must fail closed. The owner must explicitly choose which interim behavior applies.  
**No test result is implied.**

### Q-02 — DISP-1 is a system-wide requirement, not an FC-3 exception

Safe escaped rendering is required for every path candidate and untrusted path value, not only U+200B or rejected FC-3 members. It must apply to:
- audit logs and event records;
- review and approval interfaces;
- terminal/CLI diagnostics;
- browser and desktop UI;
- exports, downloads and generated reports;
- clipboard/copy operations;
- error messages and support bundles.

**Finding:** DISP-1 must be a shared security display contract with independent verification, not a conditional clause attached only to one code point.

### Q-03 — U+034F must be treated as an explicit non-Cf exception

U+034F COMBINING GRAPHEME JOINER has General_Category=Mn, not Cf. If it is rejected, the FC-3 manifest must enumerate it explicitly and tests must prove the policy is not implemented as a Cf-only filter. Its collation/canonical-order role is a legitimate text use; path rejection is a namespace policy decision, not a Unicode-wide prohibition.

### Q-04 — U+180E needs exact versioned data and Mongolian compatibility evidence

U+180E has historical Mongolian use and Unicode 18.0.0 classifies it as a format character. Do not reject adjacent Mongolian free variation selectors U+180B..U+180D or U+180F by an accidental range expansion. R1-P's rejection recommendation remains provisional until the compatibility corpus is reviewed.

### Q-05 — U+00AD and U+2060 share invisibility but not semantics

U+00AD is a discretionary intraword break/hyphenation point; U+2060 prevents line breaks. Both may create visually ambiguous path values, but their semantics and compatibility costs must remain separate in the manifest and reason codes.

### Q-06 — The eight groups require an exact finite manifest

The phrase “eight candidate groups” is not an executable specification. The final FC-3 policy must enumerate exact code points or exact version-pinned source-derived ranges, plus explicit exclusions and ownership:
- U+00AD;
- U+034F;
- U+180E;
- U+200B (pending owner decision and DISP-1 proof);
- U+2060;
- U+2061..U+2064;
- U+206A..U+206F;
- U+FEFF.

Do not use broad blocks such as U+2060..U+206F.

## 4. Recommended policy posture before owner decision

| Group | Technical recommendation | Confidence | Remaining condition |
|---|---|---|---|
| U+00AD | REJECT in path namespace | Medium-high | Verify no product-specific filename dependency |
| U+034F | REJECT in path namespace | Medium | Record scholarly/collation compatibility cost |
| U+180E | REJECT in v1 path namespace | Medium | Mongolian filename corpus review |
| U+200B | REJECT until DISP-1 verified; then owner may choose DISPLAY_ONLY | High for fail-closed interim | All surfaces must pass DISP-1 |
| U+2060 | REJECT in path namespace | High | Confirm no provider-specific exception |
| U+2061..U+2064 | REJECT in path namespace | High | Keep allowed in file contents |
| U+206A..U+206F | REJECT in path namespace | High | Exact code-point list; no broad range shortcut |
| U+FEFF | REJECT in decoded path value | High | Specify byte-stream BOM handling separately |

Confidence refers to strength of the path-namespace recommendation, not measured exploit probability.

## 5. Required decision and evidence separation

Three decisions must not be conflated:

1. **Owner policy decision:** which exact code points are rejected in v1.
2. **Implementation readiness:** whether the exact policy manifest, UCD artifacts, path validator, and safe-display implementation exist.
3. **Verification evidence:** whether the required tests and independent review passed.

An owner decision does not establish implementation. An implementation does not establish test success. Test success in one runtime does not establish cross-platform/provider portability.

## 6. Required tests — NOT_RUN

- R1Q-001: no policy range includes U+2065, U+2066..U+2069, or any unrelated U+2060..U+206F code point under FC-3.
- R1Q-002: reason-code precedence and multi-reason preservation for every overlapping property.
- R1Q-003: U+200B cannot be accepted while DISP-1 is absent or unverified.
- R1Q-004: all display surfaces expose U+200B and every other invisible/control candidate.
- R1Q-005: transport BOM handling is separate from literal U+FEFF path handling and never silently mutates path data.
- R1Q-006: U+034F is explicitly represented despite General_Category=Mn.
- R1Q-007: U+180E policy does not capture U+180B..U+180D or U+180F.
- R1Q-008: U+2061..U+2064 remain permitted in ordinary file contents unless a separate content policy applies.
- R1Q-009: accepted path bytes and code points are preserved exactly; no normalization/stripping/replacement.
- R1Q-010: same inputs yield identical decisions and reason codes across all supported runtimes.
- R1Q-011: provider, Git client, UI, terminal, log, export and clipboard round-trip tests cover each candidate.
- R1Q-012: exact UCD source files and generated manifest match pinned SHA-256 and byte lengths.

All tests are **NOT_RUN**.

## 7. Provenance and limitations

Authoritative sources:
- Unicode 18.0.0 Core Specification, Chapter 5: `https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-5/`
- Unicode 18.0.0 Core Specification, Chapter 23: `https://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-23/`
- Unicode 18.0.0 U+2000 chart: `https://www.unicode.org/Public/18.0.0/charts/PDF/U2000.pdf`
- Unicode 18.0.0 UTS #39 Revision 34: `https://www.unicode.org/reports/tr39/tr39-34.html`
- Unicode 18.0.0 UCD index: `https://www.unicode.org/versions/Unicode18.0.0/`

These sources establish Unicode semantics. They do not establish actual behavior of this repository's Git provider, filesystem adapters, UI, terminal, clipboard or logs. Those require executable integration tests.

Exact UCD artifact byte lengths and SHA-256 checksums remain **NOT VERIFIED**. Web page access is not cryptographic artifact verification.

## 8. Gate and authorization status

- R1-P per-code-point review: RECORDED.
- R1-Q consistency review: RECORDED.
- FC-3 exact owner decision: PENDING.
- U+200B current admission: NOT PROVEN; fail-closed until DISP-1 evidence.
- DISP-1 implementation: NOT IMPLEMENTED.
- UCD checksums: NOT VERIFIED.
- Tests: NOT_RUN.
- Independent R1-G review: NOT RECEIVED.
- SR-02: NOT FROZEN.
- Implementation authorization: NOT GRANTED.
- External GitHub write dispatch under SR-08: DENY / NOT AUTHORIZED.
- PR, merge, deployment, secrets, Cloudflare, Supabase, and laptop changes: NOT AUTHORIZED.

**Conclusion:** R1-P's recommendations are useful but cannot be treated as a complete or executable policy. The principal unresolved contradiction is conditional acceptance of U+200B without proven DISP-1. This review resolves the engineering posture by requiring fail-closed admission until display safety is verified, while preserving the owner decision for the final policy.
