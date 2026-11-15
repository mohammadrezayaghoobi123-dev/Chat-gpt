# Master Brain — Gate 2P / R1-E
## SR-02 Internal Adversarial Gap Assessment After F-01/F-02 Owner Decisions

**Assessment ID:** MB-G2P-R1E-SR02-IAG-2026-11-15  
**Date:** 2026-11-15  
**Status:** INTERNAL REVIEW — NOT INDEPENDENT — NOT A CONTRACT APPROVAL  
**Target contract blob reviewed:** `b4dc90f4fb1972145e19930fb24ca27efc6f9f7c`  
**Controlling F-01/F-02 owner-decision blob:** `b4d12c192331409db0f51319f9e941ce22121d6f`  
**Controlling SR-03 owner-decision blob:** `13fca32d63d589bc67c6f2a36f7a15125c62d750`  
**Controlling SR-08 owner-decision blob:** `ffc1c80e117d356b89577083fa902efd32e2c824`

## 1. Purpose and limits

This is a fresh internal adversarial reading of the exact SR-02 contract blob identified above and the related owner-decision records. It is not an independent review, executable test, implementation review, or verification of deployed behavior.

The assessment is intentionally limited to identifying unresolved contract ambiguities and proposing conservative resolution directions. It does not select owner-reserved protocol parameters, freeze SR-02, authorize code changes, or authorize external writes.

Evidence labels:
- **OBSERVED:** directly present in the pinned contract or owner-decision text.
- **INFERENCE:** engineering consequence inferred from observed text.
- **PROPOSAL:** recommended resolution, not yet owner-approved.
- **NOT_RUN:** no executable test was performed.

## 2. Current decision baseline

The following are already owner-decided and must not be reopened implicitly:

### F-01 — base branch is authorization-relevant
For `project.create_pr`, canonical `base_branch` is part of the server-derived authorization resource descriptor. A different base branch must change `authorization_resource_digest` and `request_fingerprint`; `content_digest` may remain unchanged when the content manifest is unchanged.

### F-02 — reject v1 case-fold path collisions
Two distinct repository-relative paths colliding under the versioned Unicode case-fold comparison profile cause rejection of the entire request before digest admission or external side effect. Silent rename, merge, overwrite, or winner selection is prohibited.

### SR-03 — hybrid retention
Durable replay-prevention evidence is retained for consumed keys within a namespace; bulky details may be bounded only for terminal, fully reconciled operations under an approved schedule. UNKNOWN, IN_PROGRESS, ORPHAN, and unresolved records are not eligible for routine deletion or epoch rollover. Exact parameters remain open.

### SR-08 — external writes denied
External GitHub write dispatch remains `DENY / NOT AUTHORIZED`. Ambiguous outcomes remain UNKNOWN; blind resend is prohibited. This is a design/authorization decision, not an operational kill switch.

## 3. Findings

### R1E-01 — Canonical branch identity is not yet deterministic
**Severity:** BLOCKER  
**Evidence:** Contract §§3.1, 4.1, 9; F-01 owner decision §§2.1–2.3.  
**Observed:** The contract requires a canonical `base_branch` but leaves the exact branch-name validation/canonicalization profile and version open. The owner decision requires a versioned branch-name profile.  
**Risk:** Two services may resolve or serialize branch names differently; branch aliases, invalid refs, whitespace handling, Unicode handling, or case transformations could alter authorization scope or request identity.  
**Proposal:** Define the authorized target as an exact repository branch ref resolved by the trusted server. Validate against one pinned Git ref-name profile; do not trim, lowercase, or Unicode-normalize branch names implicitly. Store both the validated branch name and resolved provider/base-commit identity as separate fields. Define whether the commit precondition is part of request fingerprint (it should be if caller-specified) and whether it is authorization-relevant (not automatically; policy must explicitly decide).  
**Required tests:** invalid refs fail closed; branch spelling changes do not silently alias; changing base branch changes authorization and request digests; moving the same branch to a new commit is handled according to explicit precondition semantics.  
**State:** PROPOSAL / NOT_RUN.

### R1E-02 — Path normalization, preserved path, and collision key are ambiguous
**Severity:** BLOCKER  
**Evidence:** Contract §§3.3 and 4.3; F-02 owner decision §§3.1–3.3.  
**Observed:** The contract refers to a “normalized repository-relative path,” says path Unicode is normalized according to a declared profile, then says to preserve exact final path bytes. The normalization profile and Unicode version remain open.  
**Risk:** It is unclear whether the canonical path stored in the content manifest is the submitted path, a normalized path, or a separately validated path. Different runtimes could hash different path bytes while agreeing on a collision key.  
**Proposal:** Choose one explicit model before implementation:
- **Option A (strict-preservation):** require submitted path bytes to already be valid UTF-8 and NFC; reject non-NFC paths; preserve accepted path bytes exactly; compute a separate Unicode full-case-fold comparison key from the accepted NFC path using a pinned Unicode version.
- **Option B (canonical-rewrite):** normalize submitted paths to NFC, use the normalized path as the actual Git tree path and manifest path, retain original input only as non-authoritative audit metadata, and reject any collision after normalization plus case-fold.
Do not mix Option A and B. Option A is the more conservative choice if preserving caller-specified path identity is required; Option B is viable only if the API explicitly defines normalization as part of the path semantics.
**Required tests:** precomposed/decomposed pairs; normalization-induced duplicate; ASCII and non-ASCII case-fold collisions; same canonical path across runtimes; proof that the exact path bytes hashed are the bytes sent to GitHub.  
**State:** PROPOSAL / OWNER CHOICE OPEN / NOT_RUN.

### R1E-03 — Case-fold profile lacks a pinned Unicode version and algorithm
**Severity:** BLOCKER  
**Evidence:** Contract §4.3 and §9; F-02 owner decision §3.3.  
**Observed:** The owner requires a versioned Unicode case-fold comparison key but has not selected the Unicode data version or exact full case-fold algorithm.  
**Risk:** Runtime/library Unicode database upgrades can change comparison behavior. A request admitted under one profile may be treated differently during replay, audit verification, or independent validation.  
**Proposal:** Pin a Unicode version, normalization form, and full (not locale-sensitive) case-fold algorithm as a named immutable profile. Store profile ID/version with operation, request fingerprint, and tombstone. Do not rely on each runtime's default case conversion. Require shared golden vectors and cross-runtime byte-identical comparison keys.  
**Required tests:** golden vectors for ASCII, Greek sigma, German sharp s, Turkish dotted/dotless I, combining marks, and normalization edge cases; profile-version migration tests. These examples are proposed coverage, not claims about current implementation behavior.  
**State:** PROPOSAL / OWNER CHOICE OPEN / NOT_RUN.

### R1E-04 — Backslash and separator handling is left as an alternative
**Severity:** HIGH  
**Evidence:** Contract §4.3.  
**Observed:** “Reject or normalize backslash consistently” leaves two different protocol behaviors open.  
**Risk:** The same path may be interpreted differently by client, Worker, Git tree construction, audit verifier, or host platform.  
**Proposal:** For v1, accept only forward slash as separator and reject any backslash byte/code point in repository-relative paths. Do not normalize backslash to slash. Validate path segments after this rejection.  
**Required tests:** single backslash, repeated backslash, mixed slash/backslash, encoded separator, and traversal combinations all fail before digest admission.  
**State:** PROPOSAL / NOT OWNER-APPROVED / NOT_RUN.

### R1E-05 — Effect-changing request schema is not closed
**Severity:** BLOCKER  
**Evidence:** Contract §3.2 and §9.  
**Observed:** The request descriptor contains “minimum proposed fields”; option fields are conditional (“if supported and effect-changing”); the contract itself leaves completeness of the effect-changing field list open.  
**Risk:** A newly supported GitHub option or precondition may be omitted from `request_fingerprint`, allowing semantically different operations to collapse to one fingerprint.  
**Proposal:** Define a closed, versioned schema for `project.create_pr`. Every accepted field must be classified as: authorization-relevant, request-effect-relevant, content-relevant, volatile/record-only, or rejected/unsupported. Unknown fields must be rejected. Any newly supported option requires a schema version change and explicit fingerprint inclusion/exclusion rationale.  
**Required tests:** mutate each accepted field independently; each effect-changing field must change request fingerprint; each declared content field must change content digest; presentation-only fields must not affect authorization digest unless policy says otherwise.  
**State:** PROPOSAL / OWNER DECISION OR CONTRACT DESIGN REQUIRED / NOT_RUN.

### R1E-06 — Canonical serialization profile is not selected
**Severity:** HIGH  
**Evidence:** Contract §§4.1, 5, 9.  
**Observed:** A deterministic schema-aware serializer is required, but RFC 8785 is only an option to evaluate; exact canonicalization library and cross-runtime vectors remain open.  
**Risk:** Different implementations may disagree on escaping, number formatting, key ordering, or invalid input handling.  
**Proposal:** Select one normative serialization algorithm and version, define the accepted JSON data model, reject duplicate keys before parsing destroys that evidence, avoid floating-point fields, and publish canonical byte-level vectors.  
**Required tests:** duplicate keys, object-key order, integer boundaries, negative zero if numeric values are admitted, escaping, Unicode scalar validity, and cross-runtime identical bytes.  
**State:** PROPOSAL / NOT OWNER-APPROVED / NOT_RUN.

### R1E-07 — Repository identity fallback is not closed
**Severity:** HIGH  
**Evidence:** Contract §§3.1, 3.2, 9.  
**Observed:** Immutable provider repository ID is preferred, while canonical owner/name is also included for audit; fallback if immutable ID is unavailable and rename/transfer semantics remain open.  
**Risk:** Repository rename or transfer could cause authorization, replay, or audit identity drift if mutable locator is treated as the sole identity.  
**Proposal:** Require immutable provider repository ID for write-capable request admission. Treat owner/name as a mutable locator/audit attribute, not identity. If immutable ID cannot be obtained or verified, fail closed for the write-capable contract. A future provider adapter without stable IDs needs a separate approved identity scheme.  
**Required tests:** rename preserves immutable identity but updates locator; transfer behavior; deleted/recreated repository with same owner/name does not alias prior identity; unavailable ID fails closed.  
**State:** PROPOSAL / OWNER CHOICE OPEN / NOT_RUN.

### R1E-08 — Base branch name and base commit precondition need distinct semantics
**Severity:** HIGH  
**Evidence:** Contract §§3.1, 3.2, 6; F-01 decision §2.  
**Observed:** `base_branch` is authorization-relevant, while expected base/head preconditions are request-fingerprint fields. The exact distinction between branch resource identity and the branch's observed commit is not specified.  
**Risk:** Branch movement between authorization and execution/reconciliation may change the effective target state without changing the branch-name resource digest.  
**Proposal:** Model branch identity and branch-tip precondition separately. The branch name belongs in authorization resource identity. A caller-supplied expected base commit belongs in request fingerprint and must be checked as a precondition. If no expected commit is supplied, the contract must define the exact snapshot point and whether a changed tip yields conflict/UNKNOWN rather than silent retargeting. This is a contract question, not an authorization to dispatch.  
**Required tests:** branch tip changes before admission, between admission and any future dispatch, and during reconciliation; outcomes are deterministic and fail closed.  
**State:** PROPOSAL / NOT_RUN.

### R1E-09 — Hybrid tombstone profile binding is underspecified
**Severity:** HIGH  
**Evidence:** Contract §§5, 7, 9; SR-03 decision §§2–5.  
**Observed:** The contract says algorithm/profile version is stored with operation and tombstone verification must survive migration, but SR-03 leaves tombstone representation, key lifecycle, namespace/epoch format, archive verification, and retention parameters open.  
**Risk:** A tombstone may remain present but no longer be verifiable under the historical canonicalization/digest profile, or an archive outage may be misinterpreted as absence.  
**Proposal:** Bind each tombstone to namespace/epoch, key identifier representation, request fingerprint algorithm/profile, content digest algorithm/profile where retained, terminal state, and integrity-protected archive reference. Unknown/unavailable archive evidence must fail closed. Do not claim permanent replay protection until retention horizon, capacity, key rotation, restore, and epoch closure are specified and tested.  
**Required tests:** archived old-profile tombstone verification; missing/corrupt archive; key rotation; epoch rollover with unresolved operation; capacity threshold and fail-closed admission.  
**State:** PROPOSAL / OWNER PARAMETERS OPEN / NOT_RUN.

### R1E-10 — Digest and provider-state reconciliation criteria are not executable
**Severity:** HIGH  
**Evidence:** Contract §§3.3, 6, 7, 10.  
**Observed:** The contract requires GitHub observed state to be independently reconciled and says mismatch must not yield success, but it does not define a complete observed-state tuple or deterministic mismatch classification.  
**Risk:** A digest match could be mistaken for proof that the intended branch/tree/PR exists, or a partial upstream result could be misclassified.  
**Proposal:** Define an evidence tuple for read-only reconciliation: immutable repository ID, relevant ref names and observed commit SHAs, tree SHA, per-path blob identities/modes, PR identity and base/head refs, and observation timestamp/source. Define which tuple elements are authoritative for each operation phase. A mismatch or incomplete read remains CONFLICT/UNKNOWN; it must never trigger blind resend.  
**Required tests:** exact match, missing ref, moved ref, partial tree, duplicate path/case collision, PR exists with wrong base/head, timeout after upstream acceptance, and stale read snapshot.  
**State:** PROPOSAL / NOT_RUN.

## 4. Cross-finding consistency checks

1. F-01 owner decision is reflected in contract §3.1, §6, and T-SR02-06. The remaining gap is the exact branch canonicalization and branch-tip semantics.
2. F-02 owner decision is reflected in contract §4.3 and T-SR02-14. The remaining gap is the precise Unicode/path normalization profile and the relationship between collision key and path bytes used in the manifest.
3. The contract's §4.3 “reject or normalize” backslash wording is not a single deterministic rule.
4. The contract's §3.2 “minimum proposed fields” is inconsistent with a freeze-ready, closed request schema.
5. The contract's §4.1 serializer choice remains a candidate, not a normative protocol.
6. SR-03's hybrid retention direction is compatible with versioned digest profiles only if historical profiles remain verifiable and archive failure is fail-closed; detailed parameters are not yet defined.
7. SR-08 remains controlling and is not modified by any finding in this assessment.

## 5. Proposed resolution order

Do not combine these into one broad approval. Resolve them in this order:

1. **Owner decision A:** choose strict path preservation (Option A) or canonical rewrite (Option B). Recommended: Option A for v1.
2. **Protocol design:** pin Unicode normalization and full case-fold profile/version.
3. **Protocol design:** pin branch validation and exact branch identity semantics.
4. **Protocol design:** close the `project.create_pr` request schema and classify every field.
5. **Protocol design:** select canonical serialization and publish byte-level vectors.
6. **Owner decision B:** decide fail-closed behavior when immutable repository ID is unavailable; recommended: reject write-capable admission.
7. **Protocol design:** close tombstone/profile binding and provider reconciliation evidence tuple under SR-03.
8. Only then prepare a revised candidate for independent review and executable test design.

## 6. Verification record

- Exact contract blob reviewed: `b4dc90f4fb1972145e19930fb24ca27efc6f9f7c`.
- F-01/F-02 owner decision blob reviewed: `b4d12c192331409db0f51319f9e941ce22121d6f`.
- SR-03 owner decision blob reviewed: `13fca32d63d589bc67c6f2a36f7a15125c62d750`.
- SR-08 owner decision blob reviewed: `ffc1c80e117d356b89577083fa902efd32e2c824`.
- Independent review: NOT PERFORMED by this assessment.
- Executable tests: NOT_RUN.
- Cross-runtime conformance: NOT_RUN.
- Source implementation review: NOT PERFORMED in this assessment.
- Deployment verification: NOT PERFORMED.

## 7. Gate classification

| Item | Status |
|---|---|
| F-01 owner policy | APPROVED |
| F-02 owner policy | APPROVED |
| Internal adversarial gap assessment | RECORDED — NOT INDEPENDENT |
| Branch canonicalization profile | OPEN |
| Path normalization/case-fold profile | OPEN |
| Closed request schema | OPEN |
| Canonical serializer | OPEN |
| Immutable repository identity fallback | OPEN |
| SR-03 detailed retention parameters | OPEN |
| Provider reconciliation evidence model | OPEN |
| Executable tests | NOT_RUN |
| Independent review of revised contract | NOT_RUN |
| Contract freeze | NOT APPROVED |
| Implementation | NOT AUTHORIZED |
| External GitHub writes | DENY / NOT AUTHORIZED |

**Conclusion:** The two owner decisions are incorporated, but SR-02 is not yet a deterministic, freeze-ready protocol. The next safest action is to resolve the path identity model and then pin the path/branch canonicalization profiles before preparing another independent review candidate.
