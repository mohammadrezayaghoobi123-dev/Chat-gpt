# Gate 2P R1-J — Unicode Path Profile: Normative Candidate Specification
Date: 2026-11-15

## 1. Status
This is a technical candidate specification, not an approved contract amendment and not a freeze authorization.

- Option A strict path identity: OWNER-APPROVED.
- Unicode 18.0.0 full default case-fold profile: PROPOSED.
- Reject Age=Unassigned: OWNER-APPROVED.
- Exact UCD artifact checksums: NOT VERIFIED.
- Conformance tests: NOT RUN.
- Cross-runtime tests: NOT RUN.
- Contract freeze: NOT APPROVED.
- Implementation: NOT AUTHORIZED.

## 2. Normative candidate profile identifier
`MB-PATH-UNICODE-18.0.0-CANONICAL-CASEFOLD-FULL-v1`

## 3. Pinned Unicode release
Candidate Unicode release: **18.0.0**.

Official release resources:
- UCD root: https://www.unicode.org/Public/18.0.0/ucd/
- CaseFolding.txt: https://www.unicode.org/Public/18.0.0/ucd/CaseFolding.txt
- NormalizationTest.txt: https://www.unicode.org/Public/18.0.0/ucd/NormalizationTest.txt
- DerivedAge.txt: https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt
- UAX #15 (Unicode 18.0.0): https://www.unicode.org/reports/tr15/tr15-58.html
- UAX #44 (Unicode 18.0.0): https://www.unicode.org/reports/tr44/tr44-38.html
- Core Specification §3 (Unicode 18.0.0): https://unicode.org/versions/Unicode18.0.0/core-spec/chapter-3/

The official versioned UCD index exposes the three data artifacts above. Exact bytes, byte lengths, and SHA-256 checksums have not yet been acquired and independently verified in this workflow. No checksum is asserted here.

## 4. Candidate input validation pipeline
For each submitted repository-relative path, in the following order:

1. Strictly decode UTF-8. Reject malformed byte sequences and surrogate encodings.
2. Reject NUL and all path syntax violations already specified by SR-02 Option A: empty path, absolute path, empty segment, `.`, `..`, path escape, and backslash separator.
3. Validate each decoded Unicode scalar value against Unicode 18.0.0 Age. Reject if any scalar has Age=Unassigned.
4. Validate that the decoded string is already NFC under Unicode 18.0.0 normalization data. Reject non-NFC; do not normalize or rewrite.
5. Preserve the exact accepted UTF-8 path representation as the Git tree path and content-manifest path.
6. Compute a separate collision key using the algorithm in §5.
7. Reject exact duplicates and any duplicate collision key across the complete submitted path set before digest admission or side effects.

All implementations MUST follow this exact validation order and return deterministic error classes once the contract defines their identifiers.

## 5. Candidate collision-key algorithm
For a path string P that has passed §4:

1. Compute NFD(P) using Unicode 18.0.0 normalization data.
2. Apply Unicode Default Full Case Folding using mappings with status C and F from Unicode 18.0.0 CaseFolding.txt. Do not apply S-only mappings as fallback and do not apply T (Turkic) mappings.
3. Compute NFD again over the folded result.
4. Encode the resulting scalar sequence as UTF-8; this byte sequence is the collision key.

In compact form:
`UTF8(NFD(DefaultFullCaseFold(NFD(P))))`

The collision key is for equality/collision detection only. It MUST NOT replace the original accepted path, content manifest path, or Git tree path.

## 6. Unassigned-code-point rule
The owner-approved rule is:
- Reject a path if any scalar has Age=Unassigned in Unicode 18.0.0.
- Use the versioned DerivedAge.txt artifact and its specified default value semantics.
- Do not approximate this with the host runtime's Unicode version or a generic regular-expression property whose Unicode version is not pinned.
- Do not replace Age=Unassigned with a blanket General_Category=Cn rejection. Private-use and noncharacter code points have explicit Age values in the UCD; their acceptance/rejection must follow the Age property and separate path-security rules.
- UTF-8 decoding still rejects surrogate scalar encodings.

## 7. Security boundary and compatibility
NFC + full default case folding + Age=Unassigned rejection does not by itself guarantee safety on every filesystem or hosting provider. The implementation still needs explicit policy for:
- controls and format controls;
- bidi controls and invisible characters;
- noncharacters and private-use code points;
- provider-specific reserved names and path restrictions;
- maximum path byte length, component length, depth, and total manifest size;
- platform case-sensitivity and normalization behavior.

These are not silently decided by the Unicode profile. They remain separate SR-02 or provider-compatibility decisions and must be resolved before implementation/freeze.

## 8. Required artifact integrity work
Before contract freeze:
1. Download the official versioned artifacts over HTTPS.
2. Record exact URL, retrieval date, byte length, SHA-256, and file format for CaseFolding.txt, NormalizationTest.txt, and DerivedAge.txt.
3. Verify file headers identify Unicode 18.0.0.
4. Compare independent retrievals or a second trusted mirror against the official bytes.
5. Preserve the artifacts in a versioned, immutable test fixture or reproducible build input.
6. Make implementation builds fail if artifact hashes differ.
7. Document licensing/terms and provenance for redistribution or vendoring.

No implementation may proceed on unverified or moving data artifacts.

## 9. Required test vectors — NOT RUN
- U18-AGE-01: assigned code point under Unicode 18.0.0 passes the Age check.
- U18-AGE-02: code point with Age=Unassigned is rejected.
- U18-AGE-03: code point introduced after Unicode 18.0.0 is rejected under the pinned profile.
- U18-AGE-04: private-use code point follows its explicit Age value; no blanket Cn inference.
- U18-AGE-05: noncharacter code point follows its explicit Age value and separate noncharacter policy.
- U18-AGE-06: surrogate encodings fail at strict UTF-8 decoding before Age lookup.
- U18-NFC-01: complete Unicode 18.0.0 NormalizationTest.txt conformance invariants pass.
- U18-NFC-02: already-NFC input is preserved byte-for-byte.
- U18-NFC-03: non-NFC input is rejected, never rewritten.
- U18-FOLD-01: all C/F mappings from CaseFolding.txt are applied exactly.
- U18-FOLD-02: S and T mappings are not used in the default profile.
- U18-COLLISION-01: collision key equals UTF8(NFD(DefaultFullCaseFold(NFD(P)))).
- U18-COLLISION-02: collision key never becomes the Git tree path.
- U18-XRUNTIME-01: supported runtimes emit byte-identical keys for the same corpus.
- U18-ARTIFACT-01: altered UCD file fails build-time integrity verification.

## 10. Open blockers and falsification
### B1 — UCD artifact integrity (BLOCKER)
Rival: official versioned URLs and release labels alone are sufficient.
Falsification: download the files twice and compare byte lengths and SHA-256; any mismatch or non-18.0.0 header blocks pinning.

### B2 — Cross-runtime determinism (BLOCKER)
Rival: each runtime's built-in Unicode implementation is equivalent.
Falsification: run the same pinned corpus and compare normalization decisions and collision-key bytes. Any difference blocks release.

### B3 — Path security beyond Unicode (HIGH)
Rival: Unicode normalization and folding adequately prevent path confusion.
Falsification: provider-specific reserved names, control/bidi characters, or filesystem semantics demonstrate unsafe acceptance.

### B4 — Compatibility of Age=Unassigned rejection (HIGH)
Rival: rejecting all code points unassigned in 18.0.0 has no meaningful compatibility impact.
Falsification: enumerate actual repository path inventory and test for affected paths before enabling the rule; any legitimate existing path is a migration blocker, not an exception to silently permit.

## 11. Owner decisions still required
The owner has approved rejection of Age=Unassigned. The complete Unicode profile remains PROPOSED pending explicit approval of:
- Unicode 18.0.0 as the pinned release;
- full default case folding using C/F only, excluding T;
- exact canonical collision key algorithm;
- acceptance policy for private-use and noncharacter code points;
- separate controls/format/bidi character policy;
- provider-specific reserved path semantics and resource limits.

## 12. No execution claim
This document is a candidate specification only. No tests, implementation, PR, merge, deployment, or external write dispatch were performed or authorized. SR-08 remains DENY / NOT AUTHORIZED.
