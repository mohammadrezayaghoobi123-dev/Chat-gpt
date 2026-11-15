# R1-U8 — Independent Unicode 18.0.0 Digest Provenance and Archive-Reroll Reconciliation
Date: 2026-11-15
Repository: mohammadrezayaghoobi123-dev/Chat-gpt
Branch: integration/master-brain-unification-2026-11-15
Scope: read-only external corroboration of R1-U7 source digests and adversarial analysis of UCD.zip hash history.

## 1. Executive verdict

**PARTIAL PASS — independent downstream metadata corroborates the current UCD.zip digest and a third-party manifest independently corroborates six of the nine individual file digests. However, FreeBSD package history proves that the UCD.zip container was re-rolled more than once under the same Unicode version.**

The current archive checksum is valid for the bytes acquired in R1-U7. It must not be treated as an immutable, version-only identifier for every historical UCD.zip distribution.

## 2. Independent downstream archive checksum

The FreeBSD ports tree contains a pinned commit:

- Repository: `freebsd/freebsd-ports`
- Commit: `c0caf8a2746e250774d46f938e8d043d44e890b2`
- Commit date: 2026-09-22T09:54:06Z
- Commit message: `textproc/UCD: tarball has been rerolled`
- File: `textproc/UCD/distinfo`
- Immutable file URL:
  `https://raw.githubusercontent.com/freebsd/freebsd-ports/c0caf8a2746e250774d46f938e8d043d44e890b2/textproc/UCD/distinfo`
- Commit URL:
  `https://github.com/freebsd/freebsd-ports/commit/c0caf8a2746e250774d46f938e8d043d44e890b2`

The pinned FreeBSD metadata records:
- SHA-256: `7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8`
- Size: `5,657,953`

Both values exactly match the UCD.zip bytes independently downloaded in R1-U7 and reproduced in two hosted runners.

This is an independent downstream package-maintainer checksum record. It is not a Unicode Consortium digital signature, nor proof that FreeBSD and the workflow used independent publisher-controlled signing keys.

## 3. Third-party file-level checksum corroboration

A third-party Sparkles Unicode manifest identifies release `18.0.0` and records SHA-256 values matching six files in the R1-U7 manifest:

- `UnicodeData.txt`
- `DerivedCoreProperties.txt`
- `PropList.txt`
- `DerivedNormalizationProps.txt`
- `CaseFolding.txt`
- `extracted/DerivedGeneralCategory.txt`

Source:
`https://sparkles-docs.pages.dev/src/libs/base/tools/unicode/manifest.json`

The six digest strings match exactly. The manifest URL is mutable and an immutable repository revision or signed provenance was not established. Therefore this is supporting third-party corroboration, not an authoritative pinned source.

No matching independent third-party record was established in this audit for:
- `ReadMe.txt`
- `DerivedAge.txt`
- `NormalizationTest.txt`

Their hashes remain verified by the R1-U7 dual-path and cross-environment reproduction, but not by this third-party manifest.

## 4. Contradiction: archive hash changed under Unicode 18.0.0

The FreeBSD history records multiple UCD.zip digests for the same upstream version:

| FreeBSD record | UCD.zip SHA-256 | Size |
|---|---|---:|
| Initial 2026-07-12 upgrade commit `24225ab97b817a7a301ba0feb13e5b8e674233c5` | `c961d4405edd144b5052cfaf8bf7db54af44ebc5db7181f83c6c52df99e9363a` | 9,464,017 |
| Re-roll record, present in later FreeBSD history | `17591bf796d71323cdf69715aca3cc9778f6008bf61fb733bd2d1241c03702fd` | 9,495,736 |
| 2026-09-22 commit `c0caf8a2746e250774d46f938e8d043d44e890b2` | `7b3e555514060b92290d154f53655c5eb0fa62b16eb04c03434ff72d1a66a0d8` | 5,657,953 |

Evidence:
- Initial upgrade commit:
  `https://github.com/freebsd/freebsd-ports/commit/24225ab97b817a7a301ba0feb13e5b8e674233c5`
- Later re-roll commit:
  `https://github.com/freebsd/freebsd-ports/commit/c0caf8a2746e250774d46f938e8d043d44e890b2`

The September commit changes both the UCD.zip checksum/size and the FreeBSD package file list. In particular, it removes:
- `USourceGlyphs.pdf`
- `USourceRSChart.pdf`

The removed PDFs have combined directory-listing sizes of approximately 4.1 MB; the archive size decreases by approximately 3.84 MB between the previous and current FreeBSD records.

### Competing hypotheses

- **H1 — packaging-only re-roll:** the archive was rebuilt to remove non-core PDF material and possibly alter ZIP metadata, while the nine UCD text-file payloads remained byte-identical.
- **H2 — source-data change:** one or more UCD text-file payloads changed between the earlier and current archives.
- **H3 — mixed change:** archive composition/metadata and one or more data files changed.

Current evidence favors H1 because the FreeBSD commit explicitly removes two PDF entries and the size reduction is broadly consistent with their removal. However, the old archive bytes were not acquired and compared. H1 is therefore **PROVISIONALLY_SUPPORTED**, not proven. H2 and H3 are not falsified historically.

The current R1-U7 tests establish that the nine current direct downloads equal the nine members of the current UCD.zip. They do not establish what the earlier archives contained.

## 5. Reconciliation with UAX #44 stability wording

UAX #44 describes numbered release directories as stable and their released data files as archived permanently and unchanged:
`https://www.unicode.org/reports/tr44/`

The FreeBSD history does not, by itself, prove that any individual Unicode data file changed. It proves that the ZIP distribution container's digest and size changed. A ZIP container may be re-created while retaining identical member payloads or changing only its non-core packaging contents.

Therefore:
- Do not use the UCD.zip SHA-256 alone as the historical identity of the nine individual source files.
- Continue pinning each raw file by exact byte length and SHA-256.
- Retain the archive digest as an acquisition-time container digest.
- Do not infer that a current ZIP checksum applies to earlier copies of the same version.
- Preserve the distinction between versioned file stability and archive-container reproducibility.

## 6. R1-U7 evidence status update

| Claim | Status |
|---|---|
| Current UCD.zip raw bytes and SHA-256 acquired | VERIFIED |
| Current UCD.zip hash corroborated by pinned FreeBSD distinfo | VERIFIED |
| Nine current direct files equal current UCD.zip members | VERIFIED |
| Nine hashes reproduced by Python and curl/unzip on separate hosted runners | VERIFIED |
| Six of nine file hashes matched third-party Sparkles manifest | VERIFIED AS SUPPORTING EVIDENCE |
| All nine file hashes independently corroborated by third-party manifests | NOT ESTABLISHED |
| Historical UCD.zip payload equality across re-rolls | UNKNOWN |
| Reason for archive re-roll | PROVISIONALLY_SUPPORTED: removal of two PDF entries |
| Publisher signature / trusted timestamp | NOT ESTABLISHED |
| R1-G independent review | NOT RECEIVED |
| Deterministic UCD parser and property tests | NOT RUN |

## 7. Required next falsification experiment

If a historical copy of either earlier UCD.zip can be obtained from an immutable FreeBSD distfile cache or independently archived mirror:
1. Verify its exact digest and byte length against the historical FreeBSD record before inspection.
2. Enumerate its ZIP members without extraction.
3. Compare the nine required member byte sequences against the current direct-file manifest.
4. Record each member as unchanged, changed, missing, or ambiguous.
5. Inspect ZIP metadata and non-core files separately.
6. Do not substitute a mirror unless its immutable revision and provenance are verifiable.

If historical bytes cannot be obtained, retain the historical archive-content question as UNKNOWN. Do not convert the packaging-only hypothesis into a fact.

## 8. Repository safety and next gate

This audit is documentation-only. No workflow, code, source files, secrets, main branch, PR, merge, deployment, Cloudflare, Supabase, or laptop state was changed.

Next atomic gate: R1-U9 should reconcile the exact R1-U7 file manifest against the six third-party matches and seek a verifiable historical archive copy. After that, the deterministic UCD parser can be separately scoped and implemented with tests against the now-pinned source bytes.

**R1-U8 final status: PARTIAL PASS — current archive digest independently corroborated; six file hashes independently corroborated; archive historical immutability not established.**
