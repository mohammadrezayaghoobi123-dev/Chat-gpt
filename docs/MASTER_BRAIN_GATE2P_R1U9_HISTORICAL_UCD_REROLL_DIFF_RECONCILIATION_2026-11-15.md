# R1-U9 — Historical Unicode 18.0.0 UCD Re-roll Diff Reconciliation
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Scope: read-only historical-source investigation and documentation-only reconciliation. No source code, workflow, secrets, main branch, PR, merge, deployment, Cloudflare, Supabase, or laptop changes are authorized by this gate.

## 1. Executive verdict

**PARTIAL PASS — the FreeBSD maintainer's published re-roll diff establishes that the Unicode 18.0.0 source snapshot changed in data-bearing files between the February and April/May 2026 snapshots. This falsifies a blanket claim that all observed re-rolls were packaging-only. However, the historical ZIP payloads with SHA-256 c961d440... and 17591bf... were not acquired, so exact archive-to-snapshot binding and member-level historical equality remain UNKNOWN.**

A separate September 22, 2026 re-roll changed the archive digest/size and removed two PDF files from the FreeBSD package file list. That is consistent with a packaging change, but without both archive payloads it does not prove that the September re-roll changed only packaging.

## 2. Evidence acquired

### 2.1 FreeBSD history and maintainer diff

FreshPorts records the following sequence:
- 2026-07-12 16:36:47 UTC: initial upgrade to Unicode 18.0.0, commit 24225ab97b817a7a301ba0feb13e5b8e674233c5.
- 2026-07-12 19:58:38 UTC: re-roll entry 18.0.0_1,2; its commit record explicitly links the maintainer's full diff at https://people.freebsd.org/~thierry/ucd.diff.
- 2026-09-22 09:54:06 UTC: later re-roll, commit c0caf8a2746e250774d46f938e8d043d44e890b2.

Sources:
- FreshPorts history and diff pointer: https://www.freshports.org/textproc/UCD/
- Initial upgrade commit: https://github.com/freebsd/freebsd-ports/commit/24225ab97b817a7a301ba0feb13e5b8e674233c5
- September re-roll commit: https://github.com/freebsd/freebsd-ports/commit/c0caf8a2746e250774d46f938e8d043d44e890b2
- Maintainer diff: https://people.freebsd.org/~thierry/ucd.diff

The maintainer diff is served as HTTP 200, text/plain by the inspected fetch channel. Its visible unified-diff headers compare old files timestamped 2026-02-03/05 with new files timestamped 2026-04-29 through 2026-05-22. The diff itself was not acquired as a verified raw-byte artifact in this gate; no SHA-256 or exact byte length is claimed for it.

### 2.2 Nine-file coverage

A targeted extraction of the maintainer diff reports:

| Pinned R1-U7 path | Diff section | Non-header data-line changes | Result |
|---|---|---|---|
| ReadMe.txt | Present | Yes, details not enumerated here | Content changed; exact semantic impact not assessed |
| PropList.txt | Present | Yes | Property membership changes |
| DerivedCoreProperties.txt | Present | Yes | Property membership changes |
| DerivedAge.txt | Present | Yes | Age assignments changed |
| extracted/DerivedGeneralCategory.txt | Not found | Not established | No conclusion from this diff |
| UnicodeData.txt | Present | Yes | Character records changed |
| CaseFolding.txt | Not found | Not established | No conclusion from this diff |
| DerivedNormalizationProps.txt | Not found | Not established | No conclusion from this diff |
| NormalizationTest.txt | Not found | Not established | No conclusion from this diff |

“Not found” means no matching diff section was identified in this maintainer diff; it does not prove the historical files were identical.

### 2.3 Concrete semantic changes reported in the diff

The following are representative changes, not an exhaustive diff:

**DerivedAge.txt**
- Removed from the 18.0 assignment set: U+0984, U+09FF, U+1879.
- Added: U+11DF0..U+11DF1.
- A character-name/comment label for U+1DF90..U+1DF96 also changed.

**DerivedCoreProperties.txt**
- U+0984 and U+09FF removed from multiple derived property memberships.
- U+1879 removed from Alphabetic/identifier-related memberships.
- U+11DF0 added to Alphabetic, Case_Ignorable, ID_Continue, Grapheme_Extend and related memberships.
- U+11DF1 added to Alphabetic, ID_Start, ID_Continue, XID_Start and related memberships.
- U+1DF90..U+1DF96 has a description/name-text correction.

**PropList.txt**
- U+0984 removed from Other_Alphabetic.
- U+11DF0 added to Other_Alphabetic.
- Diacritic membership/ranges changed, including U+0656, U+06E2 and U+08D3.

**UnicodeData.txt**
- Records for U+0984, U+09FF and U+1879 were removed from the earlier snapshot.
- Records for U+11DF0 and U+11DF1 were added.
- Names for U+1DF90, U+1DF91 and U+1DF93 were revised.

These are data changes, not ZIP metadata or PDF inventory changes. The exact historical ZIP member bytes remain unverified.

## 3. Historical archive digest sequence

FreeBSD's pinned history reports:

| Stage | SHA-256 | Byte length | Evidence |
|---|---|---:|---|
| Initial 2026-07-12 record | c961d4405edd144b5052cfaf8bf7db54af44ebc5db7181f83c6c52df99e9363a | 9,464,017 | FreeBSD commit 24225ab97b817a7a301ba0feb13e5b8e674233c5 |
| Later 2026-07-12 re-roll record | 17591bf796d71323cdf69715aca3cc9778f6008bf61fb733bd2d1241c03702fd | 9,495,736 | FreeBSD/FreshPorts re-roll history |
| 2026-09-22 record | 7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8 | 5,657,953 | Pinned FreeBSD commit c0caf8a2746e250774d46f938e8d043d44e890b2 |

The September commit changes the ZIP digest and size and removes USourceGlyphs.pdf and USourceRSChart.pdf from the FreeBSD package file list. It also changes the separately packaged Unihan archive digest. The PDF removal is a plausible explanation for a substantial portion of the UCD.zip size decrease, but it is not a byte-level proof of the September ZIP's complete contents.

## 4. Competing hypotheses and falsification status

- **H1 — all re-rolls are packaging-only:** **FALSIFIED.** The maintainer diff associated with the July 12 re-roll contains changes to data-bearing UCD files, including DerivedAge, DerivedCoreProperties, PropList and UnicodeData.
- **H2 — data-bearing UCD content changed during at least one re-roll:** **SUPPORTED by the published maintainer diff.** The exact mapping from each historical ZIP digest to a specific member snapshot is not cryptographically bound by the diff.
- **H3 — September 22 re-roll changed only package composition/ZIP metadata:** **PROVISIONALLY_SUPPORTED, NOT PROVEN.** The FreeBSD package list removes two PDFs, but old September-predecessor archive bytes were not acquired.
- **H4 — one or more of the nine pinned files changed between the July snapshot and the current September snapshot:** **UNKNOWN.** The maintainer diff compares February/April-May snapshots and is not a direct September-vs-current member comparison.

The correct model is therefore at least two distinct events:
1. July 12 data refresh/re-roll, with source-file changes visible in the maintainer diff.
2. September 22 archive re-roll, with PDF package-list removals visible in FreeBSD metadata; exact payload delta still unknown.

## 5. Historical mirror acquisition attempts

Read-only discovery found:
- NJU FreeBSD distfiles mirror lists UCD.zip dated 2026-09-02 at approximately 5.4 MiB; this does not match either July historical size and is not a candidate for the two old archives without further digest proof.
- OpenIndiana source archive mirror lists UCD-18.0.0.zip dated 2026-09-17 at approximately 5.4 MiB; this appears to be a current-era copy, not an established July historical copy.
- Slackware and other indexed mirrors surfaced current-sized copies, not an independently verifiable old archive.
- Exact-hash web searches did not surface a retrievable raw archive matching either historical SHA.
- A distcache candidate could not be validated through the current retrieval path because of a TLS/certificate retrieval failure; no insecure TLS bypass was used.

No historical archive bytes were acquired. No candidate is promoted to a verified historical artifact.

## 6. Required interpretation for SR-02 source pinning

1. Pin individual Unicode data files by exact byte length and SHA-256, not solely by a version label or ZIP container digest.
2. Preserve archive digest as an acquisition-time container identity.
3. Maintain separate provenance records for Unicode release/version, individual data-file bytes, archive container bytes, downstream package metadata, and maintainer diff evidence.
4. Do not equate a diff URL or a downstream checksum record with a publisher signature.
5. Do not treat “not found in diff” as proof of equality.
6. Before SR-02 freeze, bind the selected Unicode 18.0.0 property data to the exact R1-U7 manifest and ensure parser tests consume only those pinned bytes.

## 7. Status ledger

| Claim / action | Status |
|---|---|
| Current nine-file R1-U7 raw-byte manifest read back | VERIFIED |
| Current archive digest independently corroborated by pinned FreeBSD metadata | VERIFIED |
| Maintainer diff retrieved as text/plain | VERIFIED AS FETCHED REPRESENTATION |
| Maintainer diff shows changes in data-bearing files | VERIFIED AS DOCUMENT CONTENT |
| Diff covers four core property/data files among the nine plus ReadMe | VERIFIED AS DOCUMENT CONTENT |
| Historical archive bytes matching c961... acquired | NOT ACQUIRED |
| Historical archive bytes matching 17591... acquired | NOT ACQUIRED |
| Historical ZIP members compared byte-for-byte | NOT RUN |
| Exact archive-hash-to-diff-snapshot binding | UNKNOWN |
| September 22 archive-only packaging hypothesis | PROVISIONALLY_SUPPORTED |
| Parser implementation | NOT AUTHORIZED |
| Parser/property tests | NOT RUN |
| R1-G independent review | NOT RECEIVED |
| Full Unicode profile freeze | NOT APPROVED |
| SR-02 freeze | NOT APPROVED |
| PR / merge / deploy | NOT AUTHORIZED |

## 8. Safety and next atomic gate

This gate is documentation-only. No workflow or application code was modified. No secrets, main branch, PR, merge, deployment, Cloudflare, Supabase, or laptop state was changed.

**Next gate: R1-U10 — deterministic parser specification and test-oracle design.** It should define byte decoding, source-version/hash preconditions, parser grammar, range expansion, duplicate/conflict semantics, property derivation, canonical output, manifest binding, resource limits, and adversarial test vectors. It remains design-only until a separate implementation authorization is granted.

**R1-U9 final verdict: PARTIAL PASS — a data-changing July re-roll is evidenced; historical archive payload binding remains UNKNOWN; September packaging-only hypothesis remains provisional.**
