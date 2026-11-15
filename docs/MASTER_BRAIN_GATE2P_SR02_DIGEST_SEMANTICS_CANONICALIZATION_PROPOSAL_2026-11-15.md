# Master Brain — Gate 2P / R1-Candidate: SR-02 Digest Semantics and Canonicalization Contract

**Document ID:** MB-G2P-SR02-CANON-2026-11-15  
**Status:** ENGINEERING PROPOSAL — NOT OWNER-APPROVED — NOT IMPLEMENTED — NOT TESTED  
**Scope:** Clarification of SR-02 only: authorization resource identity, exact request idempotency, and payload content identity.  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Reference proposal blob:** `d170f8d7bc99135d72f64ecd144aa1bf316ccefe`  
**Reference amendment blob:** `6034625a4b2b161b6e35c1665f17d31e258aa865`

## 1. Executive finding

SR-02 is not merely a naming issue. It is a separation-of-authority and replay-integrity requirement. Three digests answer three different questions and MUST NOT be substituted for one another:

1. `authorization_resource_digest`: **What resource is the caller asking policy to authorize?**
2. `request_fingerprint`: **Is this retry semantically the exact same requested operation?**
3. `content_digest`: **Are the exact payload bytes and paths the same as the payload previously recorded or observed?**

A valid authorization decision does not prove that a replay has the same request. A matching request fingerprint does not prove that GitHub contains the expected content. A matching content digest does not prove that the caller is authorized to write it.

## 2. Security invariants

- TenantDirectory is the policy authority and evaluates only a server-derived canonical authorization target.
- WriteControl owns idempotency and operation lifecycle; it stores the request fingerprint and content digest as evidence, not as policy authority.
- The client MUST NOT supply authoritative digest values. The trusted server boundary derives all canonical structures and digests from validated request fields.
- The same idempotency namespace/key with a different request fingerprint MUST produce a conflict and MUST NOT dispatch.
- The same namespace/key with the same request fingerprint is a replay candidate, not automatic proof of success. Current authorization and external-state reconciliation remain required.
- A digest match is an integrity comparison, not an authorization grant, authenticity proof, or proof of external execution.
- Any missing, malformed, ambiguous, or unverifiable digest input MUST fail closed.
- SR-08 owner decision REJECT remains controlling: external GitHub write dispatch is DENY / NOT AUTHORIZED pending a stronger, independently reviewed mitigation and a new explicit owner decision.

## 3. Canonical data models

### 3.1 Authorization resource descriptor

The server constructs a typed descriptor containing only policy-relevant identity:

- descriptor schema version;
- tenant immutable identifier;
- project immutable identifier;
- action identifier (for example, `project.create_pr`);
- canonical repository identity, preferably immutable provider repository ID plus current canonical owner/name for audit;
- resource target identity required by the action (for example, target repository and base branch, where base branch is part of policy scope);
- any additional attribute only where the policy model explicitly declares it authorization-relevant.

The descriptor MUST NOT silently include mutable presentation metadata. Title, summary, file content, and other request payload fields belong in this descriptor only if a separately documented policy rule explicitly makes them part of the authorization target. Default: they are excluded from the authorization resource descriptor.

The descriptor is serialized with a versioned canonicalization profile and hashed using a domain-separated digest:

`SHA-256("MB:AUTHZ_RESOURCE:v1" || 0x00 || canonical_bytes)`

The exact prefix and serialization version are protocol constants, not caller-controlled values.

### 3.2 Request descriptor and request fingerprint

The server constructs a complete semantic operation descriptor. It MUST include every field that can change the requested external effect or the preconditions under which that effect is accepted. For the current create-PR operation, the minimum proposed fields are:

- request schema version and action;
- immutable repository identity and canonical repository locator;
- base branch and any expected base/head preconditions;
- title and summary/body exactly as semantically submitted after the declared normalization rules;
- complete file path set and the digest of each canonical file payload;
- expected blob SHA values and other compare-and-swap preconditions;
- draft flag, maintainer-modification setting, labels, reviewers, or any other option if supported and effect-changing;
- explicit null/absent semantics for optional fields.

The descriptor MUST exclude volatile or execution-generated values that are not part of the caller's semantic request, including operation ID, generated branch name, retry count, dispatch timestamp, lease generation, worker ID, and response metadata. Those values are recorded separately in the operation record.

The proposed fingerprint is:

`SHA-256("MB:REQUEST:v1" || 0x00 || canonical_request_bytes)`

The idempotency namespace/key and principal/tenant scope are separate identity dimensions in the operation uniqueness constraint; they MUST NOT be treated as a substitute for request fingerprint comparison.

### 3.3 Content manifest and content digest

Construct a manifest from the exact file payloads intended for the Git tree. Each entry contains:

- normalized repository-relative path;
- byte length;
- content encoding declaration (UTF-8 for text in the current adapter unless binary support is separately specified);
- SHA-256 of the exact content bytes.

Sort entries by the UTF-8 byte sequence of the normalized path. Reject duplicate paths after normalization. The manifest itself is canonicalized and hashed:

`SHA-256("MB:CONTENT_MANIFEST:v1" || 0x00 || canonical_manifest_bytes)`

This digest is distinct from the request fingerprint. A request can have the same content but a different title, summary, base branch, or PR option; in that case content_digest may remain the same while request_fingerprint changes.

## 4. Canonicalization profile — proposed minimum

A single, versioned canonicalization profile MUST be shared by admission, replay comparison, reconciliation, and audit verification. Different services MUST NOT independently invent serialization rules.

### 4.1 Serialization

- Use a deterministic, schema-aware serialization format. RFC 8785 JSON Canonicalization Scheme may be evaluated for JSON objects, but it does not itself normalize Unicode; Unicode rules below remain mandatory.
- Reject duplicate object keys before canonical serialization.
- Preserve array order where order is semantically meaningful. Sort only collections explicitly defined as unordered, such as the content manifest path entries.
- Distinguish absent, explicit null, empty string, empty array, and empty object unless the schema explicitly defines equivalence.
- Encode canonical bytes as UTF-8 without a byte-order mark.
- Do not use locale-sensitive sorting, number formatting, or case conversion.

### 4.2 Unicode and text

- Normalize text fields to Unicode NFC only where the API contract declares normalization semantics; otherwise preserve exact submitted Unicode scalar sequence and include it in the fingerprint.
- The contract MUST choose one behavior per field and version it. It MUST NOT normalize one service-side representation differently from another.
- Reject invalid UTF-8 and unpaired surrogate input at the trusted boundary.
- Line-ending normalization (LF/CRLF) MUST be field-specific and explicit. For file contents, hash the exact bytes that will be written, not a separately normalized display string.
- Title and summary normalization rules must be explicit; whitespace trimming or newline normalization must not occur implicitly.

### 4.3 Repository-relative paths

- Reject absolute paths, empty paths, NUL, traversal segments (`.` or `..`), and paths escaping the repository root.
- Define slash as the only separator in canonical form; reject or normalize backslash consistently before duplicate detection.
- Normalize path Unicode according to the declared path profile, then detect duplicates after normalization.
- For portability across case-sensitive and case-insensitive workstations, evaluate rejecting case-fold collisions (for example, `Readme` vs `README`) rather than silently treating them as distinct. This remains an owner/implementation design choice until repository behavior is verified.
- Preserve exact final path bytes in the content manifest after validation.
- Symlinks, submodules, binary files, and mode changes are out of scope until separately specified; unsupported types MUST be rejected, not silently coerced.

### 4.4 Numeric and optional values

- Avoid floating-point values in the current write request schema unless a precise canonical numeric representation is specified.
- Represent identifiers and large integers as strings where precision loss is possible.
- Apply schema defaults before fingerprinting only if the API contract explicitly states that omitted and default-valued inputs are semantically equivalent.
- Record the canonicalization profile version with every operation and tombstone.

## 5. Domain separation, algorithm agility, and key handling

- Use SHA-256 initially for all three digest classes, with distinct domain-separation prefixes and independent schema/version identifiers.
- Store algorithm ID, digest profile version, and digest value together; never store an unlabeled hash.
- Do not use a plain hash as a secrecy mechanism for low-entropy sensitive values. Do not place secrets in descriptors or audit events.
- If a keyed HMAC is later required to prevent offline guessing of sensitive identifiers, specify key versioning, rotation, dual-verification windows, archival verification, and emergency recovery before adoption. HMAC is not a replacement for authorization.
- A future algorithm migration MUST be versioned and tested against archived records. Old digest profiles must remain verifiable for the required retention horizon.
- Constant-time comparison should be used where digest comparison is security-sensitive and practical in the runtime.

## 6. Required comparison behavior

| Condition | Authorization resource digest | Request fingerprint | Content digest | Required result |
|---|---|---|---|---|
| Same request replay | Same | Same | Same | Replay candidate; re-authorize and reconcile; no blind resend |
| Same key, changed summary | Usually same | Different | Usually same | IDEMPOTENCY_CONFLICT; no dispatch |
| Same key, changed file bytes | Same | Different | Different | IDEMPOTENCY_CONFLICT; no dispatch |
| Different target repository | Different | Different | May be same | New authorization required; scope mismatch is not replay |
| Same bytes, changed base branch | Depends on policy scope | Different | Same | Request conflict for same key |
| GitHub object has different bytes | N/A | Stored request remains same | Observed digest differs | CONFLICT / UNKNOWN; never declare success |
| Client supplies digest inconsistent with server computation | N/A | N/A | N/A | Reject client digest; server recomputes |

## 7. Replay and reconciliation protocol

1. Resolve authenticated principal/service identity and tenant/project context from trusted server-side sources.
2. Validate the request schema and reject unsupported fields/types.
3. Construct canonical authorization descriptor and compute authorization_resource_digest server-side.
4. Ask TenantDirectory to authorize the exact action/resource. Do not let WriteControl infer or cache policy.
5. Construct canonical request descriptor and content manifest; compute request_fingerprint and content_digest server-side.
6. Admit or look up the scoped idempotency namespace/key in WriteControl.
7. If key exists with a different request_fingerprint, return conflict and do not dispatch.
8. If key exists with the same fingerprint, re-check current authorization and reconcile GitHub state before deciding the response. A matching digest is not permission to resend.
9. If key is new, persist the operation evidence and decision snapshot according to the separately approved lifecycle contract.
10. External write dispatch remains blocked under the current SR-08 decision. This sequence is a contract proposal and does not authorize an external side effect.

## 8. Required test matrix — all NOT_RUN

- T-SR02-01: title change changes request_fingerprint.
- T-SR02-02: summary change changes request_fingerprint but does not change authorization_resource_digest under default policy semantics.
- T-SR02-03: one content byte change changes content_digest and request_fingerprint.
- T-SR02-04: path change changes content_digest and request_fingerprint.
- T-SR02-05: repository/resource target change changes authorization_resource_digest.
- T-SR02-06: base branch change changes request_fingerprint; authorization digest changes only if policy scope includes base branch.
- T-SR02-07: same semantic request with reordered unordered manifest entries produces identical digests.
- T-SR02-08: duplicate JSON keys are rejected.
- T-SR02-09: absent/null/empty values follow explicit schema semantics.
- T-SR02-10: Unicode NFC/NFD behavior is deterministic and consistent across services.
- T-SR02-11: invalid UTF-8 and unpaired surrogate inputs are rejected.
- T-SR02-12: LF/CRLF behavior matches field-specific rules; file content digest covers exact written bytes.
- T-SR02-13: path traversal, absolute path, NUL, backslash ambiguity, and duplicate normalized path are rejected.
- T-SR02-14: case-fold collision behavior matches the approved portability policy.
- T-SR02-15: symlink/submodule/unsupported file mode is rejected.
- T-SR02-16: same key + same fingerprint enters replay/reconciliation path, not blind dispatch.
- T-SR02-17: same key + different fingerprint returns conflict.
- T-SR02-18: client-supplied digest fields are ignored or rejected; server recomputes.
- T-SR02-19: observed GitHub content mismatch never yields success.
- T-SR02-20: digest profile version and algorithm migration preserve verification of retained historical records.
- T-SR02-21: tampered descriptor, manifest, or stored digest is detected by independent verifier.
- T-SR02-22: all digest comparisons are bound to the correct operation, tenant, repository, and namespace context.

## 9. Open decisions and dependencies

Owner / independent review is required before freezing this contract:

- Whether base branch belongs in authorization scope for `project.create_pr`, or only in request_fingerprint.
- Whether repository immutable provider ID is available and stable across rename/transfer, and the fallback behavior if unavailable.
- Whether path case-fold collisions are rejected.
- Exact field-level Unicode and line-ending rules for title, summary, and file content.
- Whether non-text/binary files, symlinks, submodules, and file mode changes are supported in v1.
- Whether SHA-256 is sufficient for the required retention horizon or a keyed HMAC is needed for any identifier class.
- Exact schema versions, canonicalization library, and cross-runtime conformance vectors.
- How archived tombstones retain the ability to verify historical request fingerprints after algorithm/key rotation.

## 10. Threats, counter-hypotheses, and falsification criteria

**Threat H1:** Two semantically different operations can collapse to the same request fingerprint because a field was omitted or normalized inconsistently.  
**Falsification:** exhaustive field mutation and canonicalization property tests show every effect-changing field changes the fingerprint, while only explicitly equivalent representations remain equal.

**Threat H2:** Services compute different digests for the same semantic request.  
**Falsification:** independent implementations in each participating runtime pass a shared conformance corpus with byte-identical canonical encodings and digests.

**Threat H3:** A digest match is incorrectly treated as authorization or proof of external state.  
**Falsification:** composed tests demonstrate authorization is always re-evaluated and GitHub observed state is independently reconciled; digest match alone cannot transition an operation to SUCCEEDED.

**Threat H4:** Path normalization permits traversal or duplicate-path ambiguity.  
**Falsification:** adversarial path corpus, Unicode normalization cases, separator variants, and case-collision tests all reject ambiguous inputs before any external dispatch.

## 11. Gate status and non-authorization

- SR-02 engineering proposal: documented; owner decision NOT RECORDED.
- Independent review of this exact blob: NOT_RUN.
- Canonicalization conformance tests: NOT_RUN.
- Implementation: NOT_AUTHORIZED.
- External GitHub write dispatch: DENY / NOT AUTHORIZED under SR-08.
- R2 experiments: NOT_AUTHORIZED by this document.
- PR, merge, deployment, secrets, Cloudflare, Supabase, and laptop changes: NOT AUTHORIZED.

**Conclusion:** SR-02 has a concrete candidate contract and falsifiable test plan, but remains PROPOSED / DISPUTED pending owner decisions and independent review. No implementation or execution claim is made.
