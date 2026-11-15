# Gate 2P R1-L — Owner Decision: Reject Unicode Noncharacters (NC-2)

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15

## 1. Decision

**OWNER DECISION: APPROVED — NC-2**

The owner approves explicit rejection of every code point whose Unicode Character Database property `Noncharacter_Code_Point` is `Yes` from SR-02 path components.

This decision is additive to, and does not replace or weaken, the prior R1-I decision:

- Unicode 18.0.0 `Age=Unassigned` remains REJECT.
- `Noncharacter_Code_Point=Yes` is independently REJECT.
- Private Use code points are NOT rejected merely because their General_Category is `Co` or because they are Private Use.
- Strict UTF-8 decoding remains mandatory; surrogate code points cannot be encoded as valid UTF-8 scalar values and malformed encodings are rejected.
- Non-NFC input remains rejected; no silent normalization is permitted.
- Accepted path representation remains preserved exactly.

## 2. Normative property source

Use the explicit Unicode 18.0.0 UCD property listing:

- File: `PropList.txt`
- Versioned URL: https://www.unicode.org/Public/18.0.0/ucd/PropList.txt
- Header: `PropList-18.0.0.txt`
- Property: `Noncharacter_Code_Point`
- Unicode 18.0.0 listing: 66 code points across 18 ranges.

The Unicode 18.0.0 UCD lists:
- `FDD0..FDEF`;
- `FFFE..FFFF`;
- each plane's `FFFE..FFFF` pair from U+1FFFE through U+10FFFF.

The implementation MUST consume the explicit property listing or an independently generated, checksum-pinned equivalent. It MUST NOT infer Noncharacter status from `General_Category=Cn`, a hand-maintained incomplete list, a runtime's unpinned Unicode tables, or the Age property.

UAX #44 identifies `Noncharacter_Code_Point` as an immutable property (not assignable to new code points). Nevertheless, SR-02 MUST pin the Unicode 18.0.0 source artifact and its hash for reproducibility and provenance.

## 3. Admission semantics

For each decoded Unicode scalar value in every path component:

1. Strictly decode UTF-8. Reject malformed, overlong, surrogate, or otherwise invalid encodings.
2. Apply the approved Unicode 18.0.0 Age rule: reject `Age=Unassigned`.
3. Apply this owner decision: reject `Noncharacter_Code_Point=Yes`.
4. Enforce the approved NFC-only policy: reject non-NFC; never rewrite.
5. Apply the separately specified path syntax, collision-key, provider, portability, and resource-limit policies.

The exact ordering of pure validation predicates may be optimized only if the observable result and error classification remain deterministic and side-effect-free. No external write, GitHub dispatch, digest admission, or other state mutation may occur before all admission checks complete.

## 4. Explicit non-decisions

This approval does NOT decide:
- whether Private Use characters should be allowed by all providers or checkout targets;
- Control, Format, Bidi_Control, Default_Ignorable, Join_Control, or other invisible-character policy;
- Windows/macOS/Linux portability semantics;
- reserved provider names or resource limits;
- Unicode 18.0.0 as the complete frozen Unicode profile;
- Full Default Case Folding C/F or the K4 collision algorithm;
- UCD artifact hashes (not yet verified);
- implementation, test execution, PR, merge, deployment, or production release.

Private Use remains allowed by this specific Unicode admission predicate only. A separately approved provider/portability/security rule may still reject a path for an independently stated reason; it must not mislabel that rejection as a Private Use prohibition under this decision.

## 5. Required test vectors — NOT RUN

| ID | Input code point | Expected Age check | Expected Noncharacter check | Overall result at these two gates |
|---|---|---|---|---|
| R1L-NC-001 | U+FDD0 | Assigned Age | Yes | REJECT |
| R1L-NC-002 | U+FDEF | Assigned Age | Yes | REJECT |
| R1L-NC-003 | U+FFFE | Assigned Age | Yes | REJECT |
| R1L-NC-004 | U+FFFF | Assigned Age | Yes | REJECT |
| R1L-NC-005 | U+1FFFE | Assigned Age | Yes | REJECT |
| R1L-NC-006 | U+10FFFF | Assigned Age | Yes | REJECT |
| R1L-NC-007 | U+E000 | Assigned Age | No | PASS these two gates; other policies still apply |
| R1L-NC-008 | U+F0000 | Assigned Age | No | PASS these two gates; other policies still apply |
| R1L-NC-009 | U+0378 | Unassigned | No | REJECT by R1-I |
| R1L-NC-010 | UTF-8 encoding of a surrogate | Not applicable | Not applicable | REJECT at strict decoder |

Additional corpus assertions:
- the parsed Unicode 18.0.0 `Noncharacter_Code_Point` property contains exactly 66 code points;
- all 66 listed code points are rejected;
- no code point outside the explicit property set is rejected by this predicate;
- Private Use ranges are not accidentally included in the Noncharacter set;
- independent parsers produce identical sets from the pinned artifact.

All vectors above are specifications only. No execution is claimed.

## 6. Falsification criteria

Reject the implementation or revise this decision's technical realization if:
- the parser does not produce exactly 66 code points from the pinned Unicode 18.0.0 property file;
- any listed Noncharacter is admitted;
- any non-Noncharacter is rejected solely by this predicate;
- Private Use code points are classified as Noncharacters;
- the implementation silently substitutes General_Category=Cn or Age=Unassigned for the Noncharacter property;
- independent implementations disagree on membership;
- the property artifact hash differs from the approved pinned hash once established.

## 7. Gate status after this decision

- Option A strict UTF-8 / NFC / preserve accepted path: OWNER-APPROVED (R1-F).
- Reject Unicode 18.0.0 Age=Unassigned: OWNER-APPROVED (R1-I).
- Reject Unicode 18.0.0 Noncharacter_Code_Point=Yes: OWNER-APPROVED (R1-L, NC-2).
- Private Use blanket rejection: NOT APPROVED; remains OPEN.
- Control / Format / Bidi policy: OPEN.
- Unicode 18.0.0 complete profile: PROPOSED, NOT FROZEN.
- Full Default Case Folding C/F: PROPOSED.
- K4 collision key: PROPOSED.
- UCD raw artifact SHA-256 pinning: NOT VERIFIED.
- Tests: NOT RUN.
- Independent R1-G review: NOT RECEIVED.
- SR-02 freeze: NOT APPROVED.
- Implementation: NOT AUTHORIZED.
- PR / merge / deploy: NOT AUTHORIZED.
- SR-08 external GitHub write dispatch: DENY / NOT AUTHORIZED.

**Conclusion:** NC-2 is an approved, narrowly scoped path-admission policy. It independently rejects the immutable Unicode Noncharacter_Code_Point property while preserving the prior Age=Unassigned rule and leaving Private Use, other invisible/control properties, platform portability, and implementation authorization unresolved.
