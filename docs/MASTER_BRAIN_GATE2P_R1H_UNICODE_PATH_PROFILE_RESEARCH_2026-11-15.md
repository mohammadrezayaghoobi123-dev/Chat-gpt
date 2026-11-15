# Gate 2P R1-H — Unicode Path Profile Research and Candidate Recommendation
Date: 2026-11-15

## 1. Purpose and boundary
This document researches the remaining Unicode-specific profile decision required by SR-02 Option A. It is a source-backed engineering assessment, not an owner decision and not a contract freeze.

No source code, tests, PR, merge, deployment, secrets, Cloudflare, Supabase, or laptop state was changed. No Unicode conformance test was executed in this task.

## 2. Pinned sources inspected
The following official Unicode Consortium materials were consulted:

1. Unicode Standard Annex #15, Unicode Normalization Forms, versioned page for Unicode 18.0.0:
   https://www.unicode.org/reports/tr15/tr15-58.html
2. Unicode Standard Annex #44, Unicode Character Database, versioned page for Unicode 18.0.0:
   https://www.unicode.org/reports/tr44/tr44-38.html
3. Unicode 18.0.0 release history:
   https://www.unicode.org/history/publicationdates.html
4. Unicode 18.0.0 UCD directory:
   https://www.unicode.org/Public/18.0.0/ucd/
5. Unicode 18.0.0 CaseFolding data file:
   https://www.unicode.org/Public/18.0.0/ucd/CaseFolding.txt
6. Unicode 18.0.0 NormalizationTest data file:
   https://www.unicode.org/Public/18.0.0/ucd/NormalizationTest.txt
7. Unicode Core Specification, Chapter 3, Default Case Algorithms (Unicode 18.0.0):
   https://unicode.org/versions/Unicode18.0.0/core-spec/chapter-3/
8. Unicode Core Specification, Chapter 4, Case Mapping sources (Unicode 18.0.0):
   https://unicode.org/versions/Unicode18.0.0/core-spec/chapter-4/
9. Unicode FAQ, Character Properties, Case Mappings and Names:
   https://www.unicode.org/faq/casemap_charprop.html

## 3. Source-supported findings

### 3.1 NFC
- UAX #15 defines NFC as canonical decomposition followed by canonical composition.
- A conformant implementation that tests normalization must produce the same answer as normalization followed by binary identity comparison.
- UAX #15 identifies NormalizationTest.txt as the conformance test data.
- Unicode's normalization stability policy is conditional on the repertoire/version assumptions described by UAX #15; implementation still must pin a version and run the conformance corpus.

### 3.2 Versioned UCD
- UAX #44 documents that UCD releases are version-specific and archived at stable versioned URLs.
- UAX #44 states that released UCD versions are stable and are not changed in place; corrections are handled through errata and subsequent versions.
- The official release-history page records Unicode 18.0.0 on 2026-09-16.
- The official Unicode 18.0.0 UCD directory lists CaseFolding.txt and NormalizationTest.txt.
- Therefore, protocol implementation must reference a numbered release and exact file artifacts, never a moving `latest` URL.

### 3.3 Case folding
- Unicode Core Specification §3.13.3 defines Default Case Folding using Case_Folding mappings with status values C and F in CaseFolding.txt.
- Simple case folding is a different profile using C and S; it is not equivalent to full default case folding.
- Turkic-specific mappings are not the default profile and must not be silently mixed into the default profile.
- Case folding is intended for internal comparison, not for replacing or displaying the original string.
- Default Case Folding does not preserve normalization forms.
- Unicode canonical caseless matching D145 is defined as:
  `NFD(toCasefold(NFD(X)))`
  and the Unicode specification explains that normalization before and after folding is needed for correct canonical caseless matching.
- The UCD provides CaseFolding.txt as the data source; implementations must not substitute language-runtime lowercase or locale-sensitive casing.

## 4. Candidate v1 profile — recommendation, not approval
The evidence supports the following candidate for owner consideration:

**Candidate profile ID:** `MB-PATH-UNICODE-18.0.0-CANONICAL-CASEFOLD-FULL-v1`

1. Unicode data release: 18.0.0.
2. NFC acceptance check: use the Unicode 18.0.0 normalization data and algorithm specified by UAX #15; accept only if the decoded path is already NFC. Do not normalize accepted path bytes in place.
3. Input decoding: strict UTF-8; reject malformed sequences and any surrogate encoding.
4. Case-fold source: Unicode 18.0.0 `CaseFolding.txt`.
5. Folding mode: Default Full Case Folding, using C and F mappings as specified by Unicode Core Specification §3.13.3. Do not use S mappings as a fallback and do not apply Turkic T mappings.
6. Canonical collision key: `NFD(toCasefold(NFD(path)))`, exactly following Unicode canonical caseless matching D145. Encode the resulting scalar sequence as UTF-8 for deterministic key storage/comparison.
7. The collision key is an ephemeral/derived comparison key only. The actual Git tree path and content-manifest path remain the exact accepted NFC path representation.
8. Collision detection is over the complete submitted path set, before digest admission or any side effect.
9. The protocol stores the profile identifier with every relevant operation and tombstone. It does not infer the active profile from the host runtime's Unicode version.

### Why this candidate is preferred
- It uses a named, released, archived Unicode version.
- It uses the Unicode-defined full default folding rather than ad hoc lowercase conversion.
- It follows canonical caseless matching rather than assuming case folding preserves NFC.
- It preserves Option A's original-path invariant.
- It is reproducible across runtimes when all implementations consume the same versioned data and conformance vectors.

## 5. Important limitations and falsification conditions
The candidate is not yet executable or approved because the following evidence is still required:

- Verify the exact release artifact bytes for UCD 18.0.0 `CaseFolding.txt`, `NormalizationTest.txt`, and any required normalization property data; record cryptographic SHA-256 checksums and byte lengths from the downloaded official files.
- Confirm the exact Unicode 18.0.0 publication status and applicable errata/corrigenda at implementation freeze. Some version landing pages may retain draft-status boilerplate; reconcile that page status with the release-history and versioned UAX pages.
- Define whether code points unassigned in Unicode 18.0.0 are rejected in path components. Recommended: reject unassigned code points under the pinned release for deterministic cross-runtime semantics, subject to compatibility analysis.
- Define treatment of Unicode noncharacters, control characters, format controls, bidi controls, and platform-reserved path characters. NFC and case folding alone do not make a path safe for every filesystem or Git hosting provider.
- Define maximum path bytes, maximum code points, maximum path depth, and component length. These are separate from Unicode normalization.
- Prove the chosen Git provider's path semantics and case-sensitivity assumptions against the actual target repository/provider contract; do not assume all clients or filesystems have identical behavior.
- Supply vectors for full-fold expansions and canonical caseless edge cases, including sharp S, Greek sigma variants, dotted/dotless I (default vs Turkic distinction), and combining-mark sequences.
- Implementations in each runtime must pass the same pinned Unicode 18.0.0 normalization and case-fold corpus and cross-runtime differential tests.

## 6. Threats, rival hypotheses, and falsification
### H1 — Runtime-dependent Unicode behavior
Rival: all participating runtimes happen to implement identical Unicode data and folding behavior.
Falsification: run identical adversarial corpus on each supported runtime and compare exact NFC decisions and collision-key UTF-8 bytes. Any mismatch falsifies the rival and blocks release.

### H2 — Simple folding is sufficient
Rival: one-to-one C+S mapping catches all path collisions relevant to this protocol.
Falsification: test known multi-character full-fold mappings and compare collision classes. If full folding creates collisions not found by simple folding, simple folding is insufficient. Unicode defines distinct full and simple algorithms; this proposal selects full.

### H3 — NFC before folding is sufficient
Rival: because input paths are already NFC, folding preserves a form suitable for binary collision comparison.
Falsification: use Unicode's canonical-caseless examples and normalization corpus to show whether post-fold outputs can be canonically equivalent but byte-distinct. The Unicode specification explicitly states that case folding does not preserve normalization forms; D145 is the normative comparison model.

### H4 — New Unicode releases can be adopted transparently
Rival: upgrading UCD data does not affect path collision behavior.
Falsification: differential-run the complete path corpus under old and new UCD versions. Any changed collision class requires an explicit profile migration and cannot silently change existing operation identity.

## 7. Proposed acceptance tests — NOT RUN
- U18-NFC-01: every row in Unicode 18.0.0 NormalizationTest.txt satisfies the published NFC invariants.
- U18-NFC-02: valid already-NFC path is accepted without byte substitution.
- U18-NFC-03: canonically equivalent but non-NFC input is rejected rather than rewritten.
- U18-UTF8-01: malformed UTF-8 and encoded surrogate values are rejected.
- U18-FOLD-01: all CaseFolding.txt C/F mappings are implemented exactly.
- U18-FOLD-02: S-only and T mappings are not applied by the default profile.
- U18-FOLD-03: full-fold expansion cases produce exact expected scalar sequences.
- U18-CANON-01: collision key equals NFD(toCasefold(NFD(path))) for the pinned corpus.
- U18-CANON-02: canonically caseless strings produce identical collision-key bytes.
- U18-PATH-01: collision key never replaces the preserved Git path.
- U18-XRUNTIME-01: at least two independent runtime implementations produce byte-identical keys for the full shared corpus.
- U18-MIGRATION-01: profile version is explicit in operation and tombstone records; no profile upgrade occurs implicitly.

## 8. Decision request and gate status
Owner decision requested:
- Approve or reject the candidate profile `MB-PATH-UNICODE-18.0.0-CANONICAL-CASEFOLD-FULL-v1`.
- Separately decide whether unassigned code points in the pinned Unicode version are rejected. Recommendation: reject for v1, pending compatibility assessment.

Current status:
- Option A path identity policy: APPROVED (R1-F).
- Unicode profile recommendation: PROPOSED, NOT APPROVED.
- Exact source-file checksums: NOT VERIFIED.
- Unicode conformance tests: NOT RUN.
- Cross-runtime tests: NOT RUN.
- SR-02 contract: NOT FROZEN.
- Implementation: NOT AUTHORIZED.
- External GitHub write dispatch: DENY / NOT AUTHORIZED under SR-08.
- PR / merge / deploy: NOT AUTHORIZED.

## 9. No implementation or execution claim
This document records research and a candidate engineering profile only. It does not claim that a Unicode library, runtime, or Master Brain implementation conforms. It does not authorize implementation, external side effects, or release.
