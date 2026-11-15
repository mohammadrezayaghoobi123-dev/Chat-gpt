# Master Brain — Gate 2P / R1-U: Unicode 18.0.0 Source Acquisition Attempt and UTS #39 Revision Verification

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Document ID:** MB-G2P-R1U-UNICODE18-SOURCE-ACQUISITION-REVISION-VERIFICATION-2026-11-15  
**Status:** PARTIAL — UTS #39 REVISION 34 VERIFIED; UCD RAW-BYTE INTEGRITY BLOCKED  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Scope:** Documentation/evidence only. No implementation, test execution, PR, merge, deployment, secret, Cloudflare, Supabase, or laptop operation.

## 1. Objective

Continue R1-T's source-provenance gate without inferring byte integrity from rendered web content. This stage verifies the synchronized UTS #39 revision and evaluates additional retrieval paths for the exact Unicode 18.0.0 UCD source files.

## 2. New primary-source evidence

### E-U1 — Official UTS #39 Revision 34 page

URL: https://www.unicode.org/reports/tr39/tr39-34.html

A live retrieval of the revision-specific official page returned HTTP 200 and content type `text/html; charset=UTF-8`. Its Modifications section explicitly states that Revision 34 was reissued for Unicode 18.0.0. It also records the A1 joining-context change: no Transparent character is allowed after ZWNJ.

Disposition:
- UTS #39 revision identity: **SUPPORTED**.
- Revision 34 / Unicode 18.0.0 synchronization: **SUPPORTED**.
- The exact A1 rule must remain pinned to Revision 34 in the SR-02 profile.
- This evidence does not establish UCD source-file hashes or byte lengths.

### E-U2 — Official Unicode release and UCD directory

URLs:
- https://www.unicode.org/versions/Unicode18.0.0/
- https://www.unicode.org/Public/18.0.0/ucd/

The official release page identifies the Unicode 18.0.0 UCD location and states that Version 18.0.0 UCD data files are available. The directory index lists versioned source files and modification metadata. The release landing page still contains a preliminary-draft/beta-review banner; R1-T2 already records this contradiction against the official release announcement and archive.

Disposition:
- Official publication: **SUPPORTED** (R1-T2).
- Versioned UCD directory and file inventory: **SUPPORTED**.
- Directory listing timestamps/sizes: useful discovery metadata, not cryptographic integrity evidence.
- No SHA-256 values or exact downloaded raw-byte lengths are established by the listing.

## 3. Retrieval experiments and limits

### EXP-U1 — Live retrieval of PropList.txt

URL: https://www.unicode.org/Public/18.0.0/ucd/PropList.txt

A live page retrieval returned HTTP 200 and content type `text/plain` (as reported by the retrieval service). The rendered text begins with the expected header `PropList-18.0.0.txt` and date `2026-08-07, 16:20:14 GMT`; visible records include Bidi_Control and Join_Control sections consistent with the Unicode 18.0.0 data.

However, the retrieval interface returned parsed/rendered text, not a guaranteed byte-for-byte artifact with preserved original line endings, encoding, and all transport bytes. No verified Content-Length or SHA-256 for the raw response was provided.

Disposition: **CONTENT/HEADER CONSISTENCY ONLY**; **NOT RAW-BYTE ACQUISITION**; no checksum may be derived from this representation.

### EXP-U2 — Community GitHub reference

A public issue in `moonbit-community/err_marker` describes a `tools/ucd/SOURCES` file containing SHA-256 values for a subset of Unicode 18.0.0 source files. The issue itself does not expose the checksum values. An attempt to retrieve the guessed repository paths `tools/ucd/SOURCES` and `tools/ucd/PropList.txt` through the GitHub contents endpoint returned HTTP 404.

This is a non-authoritative community implementation in any case. Even if its checksum manifest is recovered, it can serve only as an independent comparison signal; it cannot replace direct acquisition from the official Unicode host and verification of the source bytes.

Disposition: **LEAD ONLY**; **NOT SOURCE OF AUTHORITY**; path retrieval **NOT FOUND**.

## 4. Evidence matrix

| Requirement | Result | State |
|---|---|---|
| Unicode 18.0.0 official release status | Supported by official release announcement/archive (R1-T2) | SUPPORTED |
| Versioned UCD directory exists | Official directory retrieved/indexed | SUPPORTED |
| UTS #39 Revision 34 identity | Official revision-specific page retrieved | SUPPORTED |
| Revision 34 synchronized with Unicode 18.0.0 | Explicitly stated in Revision 34 modifications | SUPPORTED |
| Raw bytes for all R1-T listed UCD files | Not obtained as byte-preserving artifacts | BLOCKED |
| Exact byte lengths | Not computed from raw files | UNKNOWN |
| SHA-256 digests | Not computed from raw files | UNKNOWN |
| Independent second-path reproduction | Not performed | NOT_RUN |
| UCD header/version verification for every file | Only PropList rendered header observed; remaining files not verified | INCOMPLETE |
| Deterministic generator / FC-3 manifest regeneration | Not run; source lock absent | BLOCKED |
| Independent R1-G review | No reviewer result received | NOT_RECEIVED |
| SR-02 full profile freeze | Not approved | NOT_APPROVED |

## 5. Falsification and acceptance criteria

The source-integrity gate may pass only when all of the following are recorded for every required file:

1. Exact official versioned URL and final redirect URL.
2. Retrieval timestamp in UTC.
3. HTTP status, TLS certificate validation result, media type, and Content-Length where supplied.
4. Exact raw bytes preserved without text decoding/re-encoding or newline conversion.
5. SHA-256 and byte length computed locally from those exact bytes.
6. Header/version checked against the expected Unicode 18.0.0 file identity.
7. Independent reproduction of each digest through a separately controlled retrieval path or reviewer.
8. Any mismatch, redirect to unversioned/latest content, unexpected header, or differing digest causes a fail-closed stop.

A web page excerpt, parsed text, directory timestamp, Git blob SHA-1, third-party checksum, or a claimed checksum without independently matching bytes is not sufficient.

## 6. Next atomic action

Use a trusted network-enabled execution environment that can save the exact HTTPS response body as binary files. Download the complete R1-T source inventory, preserve response metadata, calculate SHA-256 and byte lengths, then independently reproduce the results. Do not generate or update the source lock/FC-3 manifest until this gate passes.

If the current connector/browser path cannot expose binary response bodies and transport metadata, classify that limitation as an environment blocker and request a user-authorized trusted execution path; do not route around it by trusting rendered text or a community checksum.

## 7. Gate disposition

- UTS #39 Revision 34 verification: **PASS for revision identity/synchronization only**.
- Unicode 18.0.0 raw UCD integrity: **BLOCKED**.
- Exact source hashes and lengths: **UNKNOWN**.
- R1-U overall: **PARTIAL / NOT PASSED**.
- R1-V (source lock and deterministic regeneration): **NOT AUTHORIZED TO START until raw-byte gate passes**.
- Implementation, tests, PR, merge, deployment, and infrastructure changes: **NOT AUTHORIZED**.

No checksum, byte length, or successful raw download is claimed by this record.
