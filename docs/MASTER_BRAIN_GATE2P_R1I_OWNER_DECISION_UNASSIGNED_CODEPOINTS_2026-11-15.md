# Gate 2P R1-I — Owner Decision: Reject Unicode-Unassigned Code Points
Date: 2026-11-15

## Decision
**APPROVED — reject code points whose Unicode 18.0.0 Age property is Unassigned in all v1 repository-relative path components.**

## Normative interpretation
1. The decision is defined by the Unicode 18.0.0 UCD Age property, not by a host runtime's current Unicode database.
2. A path component is rejected if any decoded Unicode scalar value has Age=Unassigned under the pinned Unicode 18.0.0 UCD profile.
3. Implementations MUST use the versioned Unicode 18.0.0 `DerivedAge.txt` data and its documented default value semantics. They MUST NOT infer this property from a local runtime or from a moving `latest` data source.
4. This rule is additional to strict UTF-8 validation, NFC-only acceptance, and exact path preservation under Option A.
5. This decision does not automatically reject every character with General_Category=Cn. The Age property is the controlling property for this decision; private-use and noncharacter code points have Age values according to the UCD and are not rejected merely because of this decision. Surrogate code points remain rejected by strict UTF-8 decoding.
6. No path is normalized or rewritten as part of this check.

## Rationale
UAX #44 defines Age as the first Unicode version in which a character was assigned and specifies Unassigned as the default Age value for unassigned/designated code points. The versioned DerivedAge data is the definitive listing. Using Age=Unassigned avoids conflating unassigned code points with all code points that may have General_Category=Cn, including categories with distinct semantics.

## Required conformance coverage
- Accept a valid UTF-8, NFC path containing only code points assigned by Unicode 18.0.0, subject to all other path rules.
- Reject a valid UTF-8 path containing at least one Age=Unassigned code point.
- Reject a path containing a code point assigned only in a later Unicode release, because it is Age=Unassigned under 18.0.0.
- Verify that private-use and noncharacter handling follows the pinned Age property and separate policy rules, not a blanket General_Category=Cn shortcut.
- Verify identical decisions across supported runtimes using the exact same UCD 18.0.0 data.

## Scope and authorization
- Owner decision: APPROVED.
- Unicode profile candidate: still PROPOSED; this decision alone does not approve the complete profile.
- Contract freeze: NOT APPROVED.
- Implementation: NOT AUTHORIZED.
- Tests: NOT RUN.
- PR / merge / deploy: NOT AUTHORIZED.
- SR-08 external GitHub write dispatch: DENY / NOT AUTHORIZED.
