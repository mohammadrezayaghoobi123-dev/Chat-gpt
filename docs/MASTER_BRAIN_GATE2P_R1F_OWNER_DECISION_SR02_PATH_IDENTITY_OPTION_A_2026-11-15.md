# Gate 2P R1-F — Owner Decision: SR-02 Path Identity Option A
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
