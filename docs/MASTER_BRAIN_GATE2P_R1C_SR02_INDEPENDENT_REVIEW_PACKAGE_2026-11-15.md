# Master Brain — Gate 2P / R1-C: Independent Adversarial Review Package for SR-02

**Package ID:** MB-G2P-R1C-SR02-2026-11-15  
**Status:** REVIEW REQUEST PACKAGE — NOT A REVIEW RESULT  
**Review target:** Exact pinned SR-02 proposal blob only  
**Repository:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Branch:** `integration/master-brain-unification-2026-11-15`  
**Target path:** `docs/MASTER_BRAIN_GATE2P_SR02_DIGEST_SEMANTICS_CANONICALIZATION_PROPOSAL_2026-11-15.md`  
**Target blob SHA:** `641a089d7116eec78f77ae6b19a3bb973b6ba9f4`  
**Target commit:** `19c0558f83141af5ef9bc242f3dfe6cc8eaa82b8`  
**Related proposal blob:** `d170f8d7bc99135d72f64ecd144aa1bf316ccefe`  
**Related amendment blob:** `6034625a4b2b161b6e35c1665f17d31e258aa865`  
**Controlling owner decision:** SR-08 REJECT, blob `ffc1c80e117d356b89577083fa902efd32e2c824`

## 1. Purpose and independence requirement

Perform a hostile, technically rigorous review of the exact target blob. The objective is to find ways the proposed digest and canonicalization contract can fail, be bypassed, produce false equivalence, or be misused across authorization, idempotency, content verification, replay, and reconciliation.

This is an independent review request. Do not rely on the author's rationale or previous self-review as proof. Reconstruct the contract from the pinned target and related pinned documents. If the reviewer has authored or materially contributed to the proposal, disclose that and classify the review as non-independent.

The review is not an implementation task. Do not edit source code, create commits, open/merge PRs, deploy, execute GitHub writes, access secrets, or modify Cloudflare, Supabase, or local machines.

## 2. Exact review scope

Review the three digest classes and their boundaries:

- `authorization_resource_digest`: policy target identity.
- `request_fingerprint`: semantic identity of the complete requested operation for idempotency/conflict detection.
- `content_digest`: identity of exact payload bytes and paths.

Review all associated rules for:

- server-side derivation and rejection/ignoring of client-supplied digests;
- domain separation, schema/profile versions, and algorithm identifiers;
- canonical serialization, duplicate JSON keys, absent/null/empty distinctions;
- Unicode normalization, invalid UTF-8, unpaired surrogates, and line endings;
- path normalization, traversal, separators, duplicate paths, case collisions;
- semantic vs non-semantic request fields;
- repository identity, rename/transfer, base branch and preconditions;
- replay behavior, idempotency namespace/key scoping, conflict outcomes;
- external-state reconciliation and evidence needed before SUCCEEDED;
- archive/tombstone verification and future digest/key migration;
- interaction with SR-08 REJECT and the no-write authorization boundary.

## 3. Required adversarial scenarios

For each scenario, state whether the proposal prevents it, detects it, leaves it unresolved, or is vulnerable. Give a concrete counterexample and a minimal distinguishing test.

1. Same idempotency key, same apparent JSON but different duplicate-key interpretation.
2. Same semantic request encoded with different property order, Unicode forms, or line endings.
3. Same content bytes but changed title, summary, base branch, reviewer, label, draft flag, or another effect-changing field.
4. Different content bytes that collide due to path normalization, case folding, separator handling, or duplicate normalized paths.
5. Path traversal, absolute path, NUL, symlink, submodule, or unsupported file mode.
6. Repository rename/transfer or alias resolution causing two repository identities to be confused.
7. Caller-supplied digest mismatch or digest substitution across tenant/project/repository/namespace.
8. Same key with different fingerprint; same fingerprint under a different principal/tenant/project scope.
9. Replay after details are compacted but tombstone remains; replay after epoch closure or epoch rollover.
10. Stored digest or manifest tampering; independent verifier uses different canonicalization version.
11. GitHub observed content differs from expected content although request fingerprint matches.
12. Digest match incorrectly used as proof of authorization, authenticity, or successful external execution.
13. Algorithm/profile migration while historical tombstones remain.
14. Resource policy includes or excludes base branch/title/summary inconsistently across services.
15. Unicode confusables and visually identical but byte-distinct identifiers where relevant.
16. Resource or request fields omitted from the descriptor despite changing external side effects.

Add further attack cases where justified. Do not assume the listed cases are exhaustive.

## 4. Required review output format

Start with an explicit independence declaration:

- `INDEPENDENT`
- `NOT_INDEPENDENT`
- `INDEPENDENCE_UNKNOWN`

Then provide:

### A. Verdict
Choose one:
- `ACCEPT`
- `ACCEPT_WITH_BLOCKERS`
- `REJECT`
- `INCONCLUSIVE`

### B. Findings table
For every finding include:
- unique ID;
- severity: BLOCKER / CRITICAL / HIGH / MEDIUM / LOW / INFO;
- exact target section and quoted short anchor;
- violated invariant or threat model;
- reproducible counterexample;
- impact and exploit preconditions;
- proposed correction;
- minimal falsification test;
- whether it blocks contract freeze, implementation, or release.

### C. Cross-boundary analysis
Explicitly analyze interactions between TenantDirectory, WriteControl, the trusted server boundary, idempotency namespace, content manifest, GitHub, and the independent verifier. Identify any hidden trust assumptions or non-atomic boundaries.

### D. Canonicalization conformance vectors
Provide at least 12 input/output pairs covering:
- property order;
- duplicate keys;
- absent/null/empty;
- Unicode NFC/NFD;
- LF/CRLF;
- path separator and traversal;
- duplicate normalized paths;
- changed summary;
- changed content byte;
- changed base branch;
- changed repository identity;
- unsupported file type.

For each pair, specify expected equality/inequality for all three digest classes. Do not fabricate cryptographic digest values unless you actually compute them from the exact canonical byte representation and identify the algorithm/profile.

### E. Required tests
Provide concrete test names, input fixtures, expected result, and the threat each test falsifies. Separate unit, property-based, cross-runtime conformance, integration, fault-injection, and independent-verifier tests.

### F. Residual risks and open decisions
List issues that cannot be solved by digest design alone, and owner decisions still required.

### G. Evidence and reproducibility
Record:
- exact target blob SHA and commit;
- documents/versions inspected;
- tools/runtime and versions used;
- whether tests were actually executed;
- commands and outputs or fixture hashes;
- assumptions and unavailable evidence.

Never claim a test passed unless executed. Mark unexecuted tests `NOT_RUN`; uncertain conclusions `UNKNOWN`; disputed claims `DISPUTED`.

## 5. Non-negotiable review constraints

- Do not silently modify the pinned target.
- Do not infer owner approval from this review request.
- Do not treat the SR-02 proposal as frozen.
- Do not treat any digest as an authorization token, signature, trusted timestamp, or proof of GitHub state.
- Do not claim exactly-once external execution.
- Do not recommend enabling writes based solely on a positive digest review.
- SR-08 remains controlling: external GitHub write dispatch is `DENY / NOT AUTHORIZED` until a stronger mitigation is designed, independently reviewed, and explicitly approved by the owner.
- R2 experiments, implementation, PR, merge, deployment, secret changes, Cloudflare/Supabase changes, and laptop changes are outside this review authorization.

## 6. Acceptance criteria for the review itself

The review is usable only if:
1. The reviewer pins and confirms the exact target blob SHA.
2. Independence status is explicit and credible.
3. Every BLOCKER/CRITICAL/HIGH finding has a concrete counterexample or is clearly labeled as a reasoned hypothesis awaiting reproduction.
4. The review examines all three digest semantics separately and their cross-boundary composition.
5. At least 12 canonicalization vectors are supplied.
6. Tests are separated into executed and NOT_RUN.
7. No write enablement or implementation is inferred from the verdict.
8. The report is reproducible and cites exact target sections.

If any criterion is absent, classify the review package result as `INCONCLUSIVE`.

## 7. Current status

- Review package: prepared as a request brief.
- Independent reviewer assigned: NOT CONFIRMED.
- Independent review result: NOT_RUN.
- Owner approval of SR-02 contract: NOT RECORDED.
- SR-02 contract freeze: NOT AUTHORIZED.
- Implementation: NOT AUTHORIZED.
- Tests: NOT_RUN.
- External GitHub writes: DENY / NOT AUTHORIZED under SR-08.

**This document defines the review request and acceptance protocol. It is not itself an independent review, test result, or implementation authorization.**
