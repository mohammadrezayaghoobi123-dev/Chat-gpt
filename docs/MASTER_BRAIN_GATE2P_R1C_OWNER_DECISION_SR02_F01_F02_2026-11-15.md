# Master Brain — Gate 2P / R1-C Owner Decision Record

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).
## SR-02 F-01 and F-02: Authorization Scope and Path Case-Collision Policy

**Decision ID:** MB-G2P-R1C-OD-SR02-F01-F02-2026-11-15  
**Decision date:** 2026-11-15  
**Decision authority:** Project owner (explicit approval in conversation)  
**Status:** OWNER DECISIONS RECORDED — POLICY DIRECTION APPROVED  
**Scope:** SR-02 digest semantics and canonicalization contract only  
**Target proposal blob at decision time:** `641a089d7116eec78f77ae6b19a3bb973b6ba9f4`  
**Independent review report:** Grok report MB-G2P-R1C-SR02-IND-REV-2026-11-15, verdict `ACCEPT_WITH_BLOCKERS`

## 1. Decision summary

The owner explicitly approves both conservative policy choices proposed in response to findings F-01 and F-02:

1. **F-01 — Base branch is authorization-relevant.** For the current `project.create_pr` action, the canonical `base_branch` MUST be included in the server-derived authorization resource descriptor and therefore in `authorization_resource_digest`. A change to the target base branch changes the authorization resource identity and requires authorization to be evaluated for that distinct target.
2. **F-02 — Reject case-fold path collisions in v1.** The v1 path-validation profile MUST reject a request containing two repository-relative paths that collide under the explicitly specified Unicode case-fold comparison. The system MUST NOT silently rename, merge, overwrite, or otherwise repair such paths.

These decisions resolve the two owner-policy questions raised as BLOCKER findings in the Grok SR-02 review. They do not establish that the current proposal text or any implementation already enforces them.

## 2. F-01 — Authorization scope includes base branch

### 2.1 Normative rule

For `project.create_pr`, the authorization resource descriptor MUST contain:
- immutable tenant identifier;
- immutable project identifier;
- action identifier;
- canonical repository identity;
- canonical target `base_branch` identifier.

The base branch value MUST be resolved and canonicalized by the trusted server boundary under one versioned branch-name profile before authorization evaluation and digest computation. Client-supplied digest values are never authoritative.

### 2.2 Required consequence

Two otherwise identical requests targeting different base branches MUST produce different `authorization_resource_digest` values. A prior authorization decision for one base branch MUST NOT be reused as authorization for another base branch.

The `request_fingerprint` MUST also change when `base_branch` changes, because the requested external operation changes. The `content_digest` MAY remain unchanged when the file paths and exact content bytes remain unchanged.

### 2.3 Boundary conditions

- The rule is specific to the current `project.create_pr` action and does not silently define authorization scope for future actions.
- Any future action must declare its authorization resource dimensions explicitly.
- A missing, invalid, ambiguous, or unresolvable base branch MUST fail closed before any authorization success is recorded.
- This decision does not authorize external dispatch; SR-08 remains controlling.

## 3. F-02 — Reject case-fold path collisions in v1

### 3.1 Normative rule

For the v1 repository-relative path profile, after path validation and the declared Unicode normalization step, the server MUST compute a versioned Unicode case-fold comparison key for every path. If two distinct submitted paths produce the same comparison key within one request, the entire request MUST be rejected before digest admission or any external side effect.

Examples that MUST be rejected when present together:
- `Readme.md` and `README.md`
- `docs/Alpha.md` and `docs/alpha.md`

### 3.2 No silent repair

The system MUST NOT:
- silently rename either path;
- merge file contents;
- select a winner based on input order;
- overwrite one path with another;
- depend on the host operating system's filesystem case behavior to decide acceptance.

### 3.3 Determinism requirements

- Pin the Unicode version and case-fold algorithm as part of the versioned path canonicalization profile.
- Apply the same algorithm in admission, replay comparison, audit verification, and any future independent verifier.
- Preserve the validated canonical path representation separately from the case-fold comparison key.
- Reject invalid Unicode, invalid UTF-8, NUL, absolute paths, traversal segments, and duplicate paths after all required normalization checks.
- The case-fold collision check is an intra-request collision rule. It does not claim to model every provider-side or repository-specific path behavior; GitHub tree/ref behavior must still be independently reconciled.

## 4. Required contract changes

The SR-02 proposal must be revised to:
1. Replace the open F-01 question in §§3.1, 6, and 9 with the mandatory inclusion rule.
2. Replace the open F-02 question in §§4.3 and 9 with the v1 reject-collision rule.
3. Define the exact branch-name canonicalization/validation profile and its version.
4. Define the Unicode normalization and case-fold profile, including Unicode data version and cross-runtime conformance requirements.
5. Update test expectations:
   - T-SR02-06: changing `base_branch` MUST change both `authorization_resource_digest` and `request_fingerprint`; `content_digest` remains equal if content manifest is unchanged.
   - T-SR02-14: case-fold-colliding paths MUST be rejected before digest admission.
6. Add positive and negative conformance vectors for branch canonicalization and Unicode case-fold collisions.

## 5. Verification requirements

The following tests are required and remain NOT_RUN until execution evidence is recorded:
- same repository/action/tenant/project with `main` vs `develop` produces distinct authorization resource digests;
- same request key with a changed base branch produces a different request fingerprint and an idempotency conflict;
- a single path is accepted only if valid under the pinned profile;
- pairs such as `Readme.md` / `README.md`, Unicode case-fold equivalents, and normalization-induced collisions are rejected;
- behavior is byte-identical across every supported runtime;
- invalid Unicode and path traversal are rejected before any digest or operation admission;
- no path is silently renamed, merged, or overwritten.

Test state at decision time:
- Executed: NONE
- Passed: NONE
- Failed: NONE
- Not run: ALL tests listed above and the existing T-SR02 matrix
- Proposed: required tests and vectors only

## 6. Explicit non-decisions and constraints

This record does NOT:
- approve the complete SR-02 proposal for contract freeze;
- resolve Grok findings F-03 through F-10;
- approve the completeness of the effect-changing request-field list;
- select all Unicode rules for title, summary, or arbitrary text fields;
- select binary-file, symlink, submodule, or file-mode support;
- resolve repository immutable-ID fallback, tombstone/archive lifecycle, or algorithm migration;
- authorize implementation, code changes, PR creation, merge, deployment, R2 experiments, or infrastructure changes;
- assert that any existing code or deployed service enforces these rules.

## 7. SR-08 remains controlling

The existing owner decision `MB-G2P-R1B-OD-SR08-2026-11-15` remains unchanged:

**External GitHub write dispatch = DENY / NOT AUTHORIZED.**

These SR-02 policy decisions do not reduce, supersede, or bypass SR-08. Any future reconsideration of external writes requires a stronger mitigation, independent review of exact pinned artifacts, and a new explicit owner decision.

## 8. Audit classification

| Item | Status |
|---|---|
| F-01 owner policy decision | APPROVED |
| F-02 owner policy decision | APPROVED |
| Decision record implementation in repository | RECORDED BY THIS DOCUMENT ONLY |
| SR-02 proposal amendment | NOT YET UPDATED |
| Canonicalization profile fully specified | INCOMPLETE |
| Conformance tests | NOT_RUN |
| Independent re-review of revised proposal | NOT_RUN |
| Contract freeze | NOT APPROVED |
| Implementation | NOT AUTHORIZED |
| External GitHub writes | DENY / NOT AUTHORIZED |

**Final classification:** OWNER DECISIONS RECORDED — POLICY DIRECTION APPROVED — CONTRACT AMENDMENT PENDING — NOT TESTED — NOT IMPLEMENTATION-AUTHORIZED.
