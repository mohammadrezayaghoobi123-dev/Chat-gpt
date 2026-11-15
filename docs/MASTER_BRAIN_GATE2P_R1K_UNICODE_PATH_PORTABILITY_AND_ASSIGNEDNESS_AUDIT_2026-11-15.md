# Gate 2P R1-K — Unicode Path Portability and Assignedness Audit
Date: 2026-11-15

## 1. Status and scope

**Status: RESEARCH / ENGINEERING AUDIT — NOT AN OWNER DECISION — NOT A CONTRACT FREEZE**

This document records a read-only standards and platform audit following the owner's approval to deepen comparison of the Unicode path profile.

- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Branch: `integration/master-brain-unification-2026-11-15`
- Scope: Unicode path identity, Git path conventions, Windows/macOS/Linux portability, and the semantic difference between Age and General_Category.
- No source code was changed.
- No tests were executed.
- No implementation, PR, merge, deployment, or external GitHub write dispatch was performed or authorized.
- `main` remains outside the scope of this work.

## 2. Executive findings

1. Git's documentation states that path names are encoded in UTF-8 NFC, while also explaining that Git core treats path names as non-NUL byte sequences and performs platform-specific conversions on macOS and Windows. The protocol's accepted path identity and a working tree's representability must therefore be separate concerns.
2. The approved `Age=Unassigned` rule does not reject Noncharacters or Private Use characters merely because of their Unicode category. Unicode 18.0.0 DerivedAge data assigns historical Age values to these code points.
3. UAX #15's Normalization Process for Stabilized Strings (NPSS) rejects `General_Category=Unassigned`, not `Age=Unassigned`. NPSS therefore has a different rejection set, including Noncharacters. The current SR-02 profile MUST NOT claim full NPSS conformance.
4. Windows, macOS, and Linux filesystems do not share one filename equivalence or portability model. Git configuration itself documents platform-specific case and normalization workarounds.
5. The Unicode collision key (K4) is not a substitute for provider/filesystem validation. A path can pass Unicode validation and still be uncheckoutable, aliased, or unsafe on a target platform.
6. Exact UCD file headers and version identifiers were inspected through the official versioned Unicode URLs. Exact downloaded byte lengths and SHA-256 checksums remain NOT VERIFIED in this workflow.

## 3. Normative evidence: Git path semantics

The current Git commit documentation states:
- path names are encoded in UTF-8 normalization form C (NFC), including tree objects and the index;
- Git core treats path names as sequences of non-NUL bytes;
- there are no path-name encoding conversions at core level except on macOS and Windows;
- repositories created using legacy extended ASCII encodings may not work properly on UTF-8-based systems.

Source:
- https://git-scm.com/docs/git-commit.html (Discussion section)

Git's configuration documentation further specifies:
- `core.ignoreCase` enables workarounds for filesystems that are not case-sensitive, including APFS, HFS+, FAT, and NTFS;
- Git probes and may set this value at repository initialization;
- `core.precomposeUnicode` is a macOS-specific option that reverses Unicode decomposition performed by macOS;
- `core.protectHFS` protects against paths equivalent to `.git` on HFS+;
- `core.protectNTFS` protects against paths that cause NTFS problems, including 8.3 short-name conflicts.

Source:
- https://git-scm.com/docs/git-config

### Engineering consequence

The protocol MUST keep three different representations/decisions separate:

A. **Canonical protocol path** — valid UTF-8, NFC, preserved exactly as accepted, and used as the logical Git tree path.

B. **Unicode collision key** — versioned, deterministic comparison-only key. It MUST NOT replace the path.

C. **Target portability result** — validation against the selected Git provider, checkout platform, filesystem, and API behavior.

Do not infer C from A or B.

## 4. Platform compatibility matrix

| Platform / layer | Documented behavior | Implication for SR-02 | Evidence status |
|---|---|---|---|
| Git core | Pathnames are specified as UTF-8 NFC; core operates on non-NUL bytes, with macOS/Windows conversions | Enforce the protocol's UTF-8/NFC rule before Git dispatch; test actual provider behavior | Official Git documentation inspected |
| Git on case-insensitive filesystems | `core.ignoreCase` provides workarounds; behavior is filesystem-dependent | Never rely on host case behavior to enforce protocol collision policy | Official Git documentation inspected |
| Git on macOS | `core.precomposeUnicode` addresses filesystem Unicode decomposition; HFS protection is distinct | Test macOS Git configuration and checkout separately from Unicode collision-key tests | Official Git documentation inspected |
| Windows / Win32 | Do not assume case sensitivity; reserved characters and device names; trailing ASCII space/period restrictions; filesystem-specific rules | A Unicode-valid path may still be invalid or aliased on Windows | Microsoft documentation inspected |
| macOS / APFS | APFS may be case-sensitive or case-insensitive; current Apple guidance recommends treating names as case-sensitive for portability | Target-volume behavior must be tested; do not infer all APFS volumes behave alike | Current Apple guidance inspected; normalization details remain incomplete |
| macOS / historical APFS | Archived APFS guide describes normalization-insensitive behavior and Unicode 9.0-era semantics | Historical evidence only; MUST NOT be treated as a current APFS guarantee | Archived Apple documentation; not a current normative specification |
| Linux / ext4 default | Case-insensitive lookup is an optional per-directory feature; ordinary case-sensitive behavior remains possible | Linux is not one universal filename model | Current kernel documentation inspected |
| Linux / ext4 casefold | Uses filesystem encoding model and canonical decomposition for lookup; current docs still identify Unicode 12.1.0 as the default model | Kernel casefold is not established as equivalent to Unicode 18.0.0 K4 | Current kernel documentation inspected; exact kernel/filesystem image must be tested |

Sources:
- Git: https://git-scm.com/docs/git-commit.html
- Git configuration: https://git-scm.com/docs/git-config
- Windows: https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
- Windows whitespace behavior: https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/file-folder-name-whitespace-characters
- Apple current guidance: https://developer.apple.com/documentation/technologyoverviews/files-and-directories
- Apple archived APFS guide: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html
- Linux ext4: https://cdn.kernel.org/doc/html/latest/admin-guide/ext4.html

### 4.1 Windows-specific checks

At minimum, a Windows portability profile must account for:
- reserved characters: `< > : " / \\ | ? *`;
- NUL and control characters in the documented restricted range;
- reserved device names, including `CON`, `PRN`, `AUX`, `NUL`, `COM1` through `COM9`, `LPT1` through `LPT9`, and documented superscript-digit variants;
- trailing ASCII period and space;
- case-insensitive behavior by default, while recognizing that NTFS can support POSIX case-sensitive semantics in configured contexts;
- path and component length constraints that vary with filesystem, API, namespace prefix, and policy.

Do not implement this as a single unversioned regular expression. Define the exact target API/provider profile and test it.

### 4.2 macOS-specific checks

- APFS case sensitivity is a volume property; do not assume one global behavior.
- Git's `core.precomposeUnicode` is a Git/macOS compatibility setting, not the SR-02 canonicalization algorithm.
- The archived APFS guide describes behavior tied to Unicode 9.0 and older OS releases. It is not sufficient evidence for the exact normalization behavior of every current APFS version.
- Until current-version behavior is directly verified, record APFS normalization equivalence as environment-dependent / UNKNOWN.

### 4.3 Linux-specific checks

- ext4 casefold is opt-in per directory; it is not the default for all ext4 directories.
- The filesystem stores an encoding model for casefold behavior. Kernel documentation describes canonical decomposition and a Unicode 12.1.0 default in the current text.
- Invalid UTF-8 may be treated as opaque bytes when strict mode is not enabled; such behavior is not compatible with the SR-02 strict UTF-8 admission rule.
- The target kernel, filesystem feature flags, and mount configuration must be recorded in tests.

## 5. Age versus General_Category — corrected formal interpretation

### 5.1 Unicode 18.0.0 data facts

The official file:
- https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt

has header `DerivedAge-18.0.0.txt` and states that “assigned” includes code points assigned as graphic, format, control, private-use, noncharacter, or surrogate.

Observed official entries include:
- `E000..F8FF ; 1.1` — BMP Private Use Area;
- `FDD0..FDEF ; 3.1` — BMP Noncharacters;
- `FFFE..FFFF ; 1.1` — BMP Noncharacters;
- `D800..DFFF ; 2.0` — Surrogates;
- supplementary Private Use and Noncharacter ranges with Age 2.0.

All code points not explicitly listed in DerivedAge have Age=Unassigned.

### 5.2 Consequences for the approved R1-I decision

The existing owner decision says:
- reject code points whose Unicode 18.0.0 Age is Unassigned;
- use the pinned DerivedAge data;
- do not replace this with a blanket `General_Category=Cn` rule;
- Private Use and Noncharacters are not rejected merely because of this Age decision;
- strict UTF-8 decoding rejects surrogate encodings.

This is internally consistent.

However, it means:
- ordinary reserved/unassigned code points are rejected;
- Noncharacters have assigned Age values and therefore pass this particular Age check;
- Private Use characters have assigned Age values and therefore pass this particular Age check;
- Surrogates cannot enter through valid strict UTF-8 decoding.

### 5.3 Difference from NPSS

UAX #15 §12.1 defines NPSS to abort if a code point has `General_Category=Unassigned` under the selected Unicode version.

Unicode's Private-Use / Noncharacter FAQ explains:
- Noncharacters have `General_Category=Cn`;
- Private Use characters have `General_Category=Co`;
- Noncharacters are distinct from ordinary reserved unassigned code points.

Therefore, NPSS's `General_Category=Unassigned` test rejects Noncharacters, while the approved Age=Unassigned test does not.

The current profile may use Unicode normalization algorithms and a pinned UCD release, but MUST NOT claim that the input gate is identical to NPSS.

Sources:
- UAX #15 §12.1: https://www.unicode.org/reports/tr15/
- UAX #44 §5.14: https://www.unicode.org/reports/tr44/
- Unicode Private-Use / Noncharacter FAQ: https://www.unicode.org/faq/private_use.html
- Unicode 18.0.0 DerivedAge: https://www.unicode.org/Public/18.0.0/ucd/DerivedAge.txt

### 5.4 Separate owner decision still required

The current R1-I decision remains unchanged. A separate policy choice is needed for Noncharacters:

- **NC-1 — Allow:** retain current Age-only behavior; reject Noncharacters only if another independent rule requires it.
- **NC-2 — Reject Noncharacters:** add explicit `Noncharacter_Code_Point=Yes` rejection while retaining Age=Unassigned rejection.
- **NC-3 — Reject all General_Category=Cn:** reject Noncharacters and ordinary unassigned code points under the selected release; this is broader than R1-I and must be explicitly approved.
- **NC-4 — Reject all Cn and Co:** also reject Private Use characters; highest compatibility cost and should require a concrete product requirement.

No option is selected by this audit.

Recommendation for evaluation only: NC-2 is the clearest bounded policy if the product requires excluding noncharacters but has no requirement to prohibit Private Use characters. This is NOT an owner decision.

## 6. Unicode algorithm and artifact evidence

The official Unicode 18.0.0 `CaseFolding.txt` header was inspected:
- https://www.unicode.org/Public/18.0.0/ucd/CaseFolding.txt
- It defines C+F as Full Case Folding.
- S is used with C for Simple Case Folding.
- T is a special Turkic mapping and is normally excluded for non-Turkic default behavior.
- The file explicitly warns that case folding does not preserve normalization formats.

The official `NormalizationTest.txt` header was inspected:
- https://www.unicode.org/Public/18.0.0/ucd/NormalizationTest.txt
- It provides NFC/NFD/NFKC/NFKD conformance invariants.

The official UAX #15 and UAX #44 pages identify Unicode 18.0.0 and stable/approved annex status.

**Integrity limitation:** the web-readable headers and content were inspected, but exact raw artifact byte lengths and SHA-256 checksums were not obtained in this workflow. Therefore artifact integrity remains NOT VERIFIED. Do not infer checksums from the web view.

## 7. Proposed acceptance test plan — NOT RUN

### 7.1 Protocol Unicode tests

| ID | Input / condition | Expected result |
|---|---|---|
| R1K-U-001 | Valid UTF-8, NFC, assigned scalar values | Pass Unicode admission, subject to path/provider checks |
| R1K-U-002 | Malformed UTF-8 | Reject before Unicode property lookup |
| R1K-U-003 | UTF-8 encoding of surrogate | Reject at strict decoder |
| R1K-U-004 | Valid UTF-8 containing Age=Unassigned under U18 | Reject under approved R1-I rule |
| R1K-U-005 | Non-NFC input | Reject; never normalize or rewrite |
| R1K-U-006 | NFC input | Preserve exact UTF-8 bytes |
| R1K-U-007 | U+FDD0 | Pass Age check; NC policy remains decisive |
| R1K-U-008 | U+FFFE | Pass Age check; NC policy remains decisive |
| R1K-U-009 | U+E000 | Pass Age check; PUA policy remains decisive |
| R1K-U-010 | Unicode 19+ character not assigned in U18 | Reject under pinned U18 Age rule |
| R1K-U-011 | Full CaseFolding C/F corpus | Match exact U18 mappings |
| R1K-U-012 | S-only or T mapping | Must not be used by proposed default profile |
| R1K-U-013 | NFD(CaseFold(NFD(P))) | Produce byte-identical collision key across independent implementations |
| R1K-U-014 | Fullwidth A versus ASCII A | Distinct under K4; must not be merged by compatibility folding |
| R1K-U-015 | Circled digit one versus ASCII 1 | Distinct under K4; must not be merged by compatibility folding |

### 7.2 Platform portability tests

| ID | Target | Test | Expected result |
|---|---|---|---|
| R1K-P-001 | Windows | Reserved device basenames, including extensions | Reject from Windows-portable target profile |
| R1K-P-002 | Windows | Trailing ASCII dot/space | Reject from Windows-portable target profile |
| R1K-P-003 | Windows | Forbidden punctuation and controls | Reject from Windows-portable target profile |
| R1K-P-004 | Windows | Case-only sibling names | Detect as non-portable under default case-insensitive profile |
| R1K-P-005 | macOS | Case-sensitive and case-insensitive APFS volumes | Record distinct observed behavior |
| R1K-P-006 | macOS | NFC/NFD equivalent name pairs | Determine actual behavior on each supported OS/APFS configuration |
| R1K-P-007 | macOS | Git with `core.precomposeUnicode` on/off | Record tree/index/working-tree representation and detect drift |
| R1K-P-008 | Linux ext4 | Casefold disabled/enabled | Record lookup behavior and filesystem encoding version |
| R1K-P-009 | Linux ext4 | Invalid UTF-8 under strict/non-strict mode | Verify filesystem behavior; protocol must reject before reaching filesystem |
| R1K-P-010 | Git | `core.ignoreCase`, `core.protectHFS`, `core.protectNTFS` | Confirm these are defense-in-depth, not protocol identity rules |
| R1K-P-011 | Git/provider | Create tree and retrieve path bytes through provider API | Verify exact preserved path identity |
| R1K-P-012 | Cross-platform | Checkout the same adversarial corpus on each supported target | No silent rename, alias, overwrite, or lossy checkout |

### 7.3 Test acceptance conditions

A test run is acceptable only if it records:
- exact OS build, filesystem type, filesystem feature flags, and volume case-sensitivity;
- Git version and relevant configuration values;
- provider/API and repository identity;
- exact input bytes and code-point sequence;
- exact output bytes, error class, and observed filesystem path;
- independent expected result and test harness version.

A test is NOT a pass if the environment is unspecified or if the test only checks a high-level display string.

## 8. Decision architecture recommended for SR-02

Keep these as separate policy modules:

1. `UnicodeAdmissionProfile`: strict UTF-8, NFC-only, pinned Age rule, and separately approved Noncharacter/Private Use/format-control policy.
2. `UnicodeCollisionProfile`: pinned Default Full Case Folding C/F plus canonical NFD pipeline; comparison-only output.
3. `GitPathProfile`: Git's UTF-8/NFC path convention, exact tree path preservation, slash/path-segment rules, object-mode restrictions.
4. `ProviderPathProfile`: provider-specific path restrictions and API semantics.
5. `CheckoutPortabilityProfile`: per-target Windows/macOS/Linux constraints and environment-specific behavior.
6. `ResourceLimitProfile`: byte length, component length, depth, total entries, and manifest size, with explicit provider/runtime ceilings.

A failure in a portability profile must not silently rewrite a path. It should return a deterministic rejection or a clearly scoped NOT_PORTABLE result according to an owner-approved product policy.

## 9. Remaining blockers

| Blocker | Severity | State | Evidence needed |
|---|---|---|---|
| Unicode 18.0.0 artifact SHA-256 and byte-length pinning | BLOCKER | NOT VERIFIED | Raw artifact download, repeat retrieval, hashes, immutable fixtures |
| Exact K4 implementation parity | BLOCKER | NOT RUN | Two independent implementations and byte-identical corpus |
| Noncharacter policy | HIGH | OPEN | Owner decision NC-1..NC-4 |
| Private Use policy | HIGH | OPEN | Product compatibility requirement and owner decision |
| Control / Format / Bidi policy | HIGH | OPEN | Threat model and adversarial vectors |
| Current APFS normalization behavior | HIGH | UNKNOWN | Tests on explicitly named current macOS/APFS versions |
| Windows path semantics in supported APIs | HIGH | PARTIAL | Win32/WinRT/API-specific tests |
| ext4 casefold Unicode data/version in deployed kernels | HIGH | PARTIAL | Kernel/filesystem image and feature metadata |
| Git provider exact path behavior | BLOCKER | NOT RUN | Provider API round-trip and checkout tests |
| Resource limits | HIGH | OPEN | Provider/runtime ceilings and abuse analysis |
| Independent R1-G review | BLOCKER | NOT RECEIVED | Independent reviewer result against exact SR-02 blob |

## 10. Falsification criteria

The candidate profile must be rejected or revised if any of the following occurs:

- Two independent implementations produce different K4 bytes for the same accepted path.
- The same UCD version label resolves to different artifact hashes without an explainable provenance difference.
- A path accepted by protocol admission is silently rewritten or aliased by a supported Git provider.
- A supported checkout target cannot represent an accepted path and the product policy requires universal portability.
- A case-only or normalization-equivalent collision is admitted by the protocol.
- A path passes Age validation but violates an explicitly approved Noncharacter/format/bidi/provider rule.
- A resource limit can be exceeded before bounded validation or manifest admission.

## 11. Gate status

- Option A strict preservation: OWNER-APPROVED.
- Reject Unicode 18.0.0 Age=Unassigned: OWNER-APPROVED.
- Unicode 18.0.0 as the complete pinned profile: PROPOSED.
- Full Default Case Folding C/F, excluding T: PROPOSED.
- K4 collision key: PROPOSED.
- Noncharacter policy: OPEN.
- Private Use policy: OPEN.
- Control / Format / Bidi policy: OPEN.
- Provider portability profile: OPEN.
- UCD raw artifact checksums: NOT VERIFIED.
- Cross-runtime tests: NOT RUN.
- Platform tests: NOT RUN.
- Independent R1-G review: NOT RECEIVED.
- SR-02 freeze: NOT APPROVED.
- Implementation: NOT AUTHORIZED.
- PR / merge / deploy: NOT AUTHORIZED.
- SR-08 external GitHub write dispatch: DENY / NOT AUTHORIZED.

**Conclusion:** the evidence supports separating protocol Unicode identity from platform portability. The approved Age=Unassigned rule is not equivalent to NPSS and does not itself reject Noncharacters or Private Use characters. These are explicit remaining policy choices, not implementation details. No execution or test-success claim is made.
