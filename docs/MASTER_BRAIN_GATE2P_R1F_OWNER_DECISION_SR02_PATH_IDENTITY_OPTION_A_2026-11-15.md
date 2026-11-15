# Gate 2P R1-F — Owner Decision: SR-02 Path Identity Option A

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
Date: 2026-11-15

## Decision
**APPROVED — Option A (strict preservation) for the SR-02 v1 path-identity policy.**

The v1 contract shall:
1. Accept only path inputs that are valid UTF-8 and already in Unicode NFC.
2. Reject non-NFC input; do not silently normalize, rewrite, or substitute a path.
3. Preserve the accepted path representation as the actual Git tree path.
4. Compute a separate, versioned Unicode case-fold collision key for collision detection.
5. Reject any v1 path set containing a collision under the pinned case-fold profile. Do not silently rename, merge, overwrite, or select a winner.

## Scope and limits
- This is an owner-level policy decision for the SR-02 v1 contract only.
- It does **not** select the Unicode data version, normalization implementation, case-fold algorithm/profile, branch-name canonicalization profile, JSON serializer, or repository identity fallback. Those remain explicit engineering decisions and must be pinned before contract freeze.
- Invalid UTF-8, non-NFC input, and collision cases must fail closed with deterministic error classes once the relevant profiles are specified.
- Original submitted bytes may be retained as audit evidence, but must not become an alternate accepted Git path.
- No implementation, test execution, PR creation, merge, deployment, or external GitHub write dispatch is authorized by this decision.

## Security and compatibility rationale
Strict preservation avoids a hidden transformation between the caller's path and the Git tree path. Rejecting non-NFC input prevents visually or canonically equivalent strings from being silently rewritten. A separate versioned case-fold key provides collision detection without changing the accepted path identity.

## Required follow-up
1. Amend the SR-02 contract so Option A is normative and Option B is excluded for v1.
2. Add conformance-vector requirements for valid UTF-8, NFC acceptance, non-NFC rejection, preserved path identity, and case-fold collisions.
3. Pin Unicode normalization and case-fold data/version and exact algorithm from authoritative specifications before freezing the contract.
4. Prepare a new independent-review package pinned to the exact revised contract blob.

## Status
- Owner policy decision: **APPROVED**
- Contract amendment: **PENDING**
- Contract freeze: **NOT APPROVED**
- Implementation: **NOT AUTHORIZED**
- Tests: **NOT RUN**
- PR / merge / deploy: **NOT AUTHORIZED**
- SR-08 external GitHub dispatch: **DENY / NOT AUTHORIZED**
