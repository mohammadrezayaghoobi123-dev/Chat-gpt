# Gate 2P R1-G — Independent Review Package: SR-02 Option A
Date: 2026-11-15

## 1. Review mandate
Perform an independent, adversarial, read-only review of the exact SR-02 contract blob identified below. The review must assess protocol determinism, security properties, replay integrity, cross-runtime reproducibility, implementation feasibility, and whether the contract is sufficiently complete to freeze.

This is not a request to implement code, run external writes, create a PR, merge, deploy, or alter secrets/infrastructure.

## 2. Exact target and provenance
- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Branch: `integration/master-brain-unification-2026-11-15`
- Target file: `docs/MASTER_BRAIN_GATE2P_SR02_DIGEST_SEMANTICS_CANONICALIZATION_PROPOSAL_2026-11-15.md`
- **Exact target blob SHA-256 (Git blob object ID):** `e6172bcf1d47a0df031a11b5d36a53feb36df13c`
- Target content length: 19,530 UTF-8 characters (verify independently; do not rely on this length alone).
- Owner decision file: `docs/MASTER_BRAIN_GATE2P_R1F_OWNER_DECISION_SR02_PATH_IDENTITY_OPTION_A_2026-11-15.md`
- Owner decision blob: `89e6e3f355fe02c06a77aea6ece56e68eea43fd6`
- Controlling F-01/F-02 owner decision blob: `b4d12c192331409db0f51319f9e941ce22121d6f`
- Controlling SR-08 decision blob: `ffc1c80e117d356b89577083fa902efd32e2c824`
- Controlling SR-03 hybrid-retention decision blob: `13fca32d63d589bc67c6f2a36f7a15125c62d750`

Reviewer MUST fetch the target from the stated repository/branch and independently verify the exact blob identity before reviewing. If the blob differs, stop and report TARGET_MISMATCH. Do not review a similarly named file or a later/earlier revision as a substitute.

## 3. Required independence declaration
The reviewer must state:
1. Whether they are independent from the author and prior internal reviews.
2. Whether they accessed the exact pinned blob.
3. Whether they used any implementation, tests, or external systems; if so, enumerate them.
4. Any conflicts, shared assumptions, or limitations affecting independence.

A review that merely repeats the internal R1-E assessment is not sufficient.

## 4. Owner-approved constraints to treat as binding
- F-01: `base_branch` is part of the authorization resource descriptor for current `project.create_pr`; changes affect authorization resource digest and request fingerprint.
- F-02: v1 rejects path sets colliding under the pinned, versioned Unicode case-fold profile; no silent rename, merge, overwrite, or winner selection.
- Path identity Option A: accept only valid UTF-8 paths already in NFC; reject non-NFC; preserve accepted path representation as the actual Git tree path; use a separate versioned case-fold key only for collision detection; reject any backslash separator.
- SR-03: hybrid retention; unresolved/UNKNOWN/IN_PROGRESS evidence is not purged; detailed retention and compact tombstone lifecycle still require exact operational parameters.
- SR-08: external GitHub write dispatch remains **DENY / NOT AUTHORIZED**. Ambiguous dispatch remains UNKNOWN; blind resend is prohibited.

The reviewer must not reinterpret these owner decisions as implementation or release authorization.

## 5. Required adversarial review coverage
At minimum, evaluate each area below. For every finding provide severity, exact section/requirement, exploit or failure scenario, preconditions, impact, counter-hypothesis, falsification test, and recommended disposition.

### A. Digest boundaries and semantic completeness
- Authorization resource descriptor contains all and only policy-relevant identity.
- Request fingerprint includes every effect-changing request field and relevant precondition.
- Content digest binds exact accepted path identity and exact payload bytes.
- No digest is treated as authorization, authenticity, or proof of external execution.
- Domain separation, schema versions, algorithm IDs, and comparison binding are sufficient.

### B. Path identity and Unicode — Option A
- Valid UTF-8 validation and NFC acceptance/rejection are deterministic.
- Preserved path representation is unambiguously the Git tree path and manifest path.
- Case-fold key is separate and cannot rewrite the target path.
- Exact duplicate, case-fold collision, traversal, empty-segment, absolute, NUL, and backslash cases fail closed.
- The remaining unpinned Unicode version, NFC profile/implementation, and full case-fold algorithm are correctly treated as blockers to freeze.
- Determine whether Option A leaves any ambiguity between raw input bytes, decoded Unicode scalar sequence, UTF-8 re-encoding, Git path bytes, and collision-key construction.

### C. Branch and repository identity
- `base_branch` validation/canonicalization and branch-vs-branch-tip precondition semantics.
- Immutable repository ID availability and behavior across rename/transfer/archive/deletion.
- Repository locator and provider identity consistency during retries and reconciliation.

### D. Request schema and serialization
- Is the effect-changing request schema closed, versioned, and reject-unknown-fields?
- Are defaults, absent/null/empty, arrays, Unicode text, and line endings deterministic?
- Is the canonical serializer actually selected, specified, and safe across runtimes?
- Can any effect-changing field be omitted from the request fingerprint?

### E. Idempotency, retention, and recovery
- Namespace/key/principal/tenant/project uniqueness and replay behavior.
- Tombstone compact identity, retention horizon, epoch/profile binding, archive verification, migration, and purge semantics.
- UNKNOWN and response-loss states cannot be converted into false success or blind resend.
- Re-authorization on replay and after policy/membership changes.

### F. GitHub state reconciliation and audit
- Exact evidence tuple needed to distinguish accepted, committed, partially applied, rejected, and unknown provider outcomes.
- Ambiguous writes at every upstream stage, not only final PR creation.
- Audit event atomicity, ordering, partitioning, integrity, and recovery.
- Reconciler least-privilege read permissions and independent evidence requirements.

### G. Cross-runtime and adversarial conformance
- Independent implementations produce identical canonical bytes and digests.
- Property-based, mutation, fuzz, differential, and state-machine tests are specified.
- Error classes and failure behavior are deterministic and fail closed.

## 6. Minimum executable vector requirements
Provide at least **25 precise test vectors**. Each vector must include:
- unique ID;
- complete input (or an exact compact fixture);
- expected accept/reject result;
- expected canonical representation or digest equality/inequality relation;
- protocol rule under test;
- failure severity if the implementation violates it.

Vectors must include, at minimum:
1. valid UTF-8 + NFC path accepted and preserved;
2. non-NFC path rejected without normalization;
3. invalid UTF-8 rejected;
4. exact duplicate path rejected;
5. case-only collision rejected;
6. Unicode case-fold collision involving non-ASCII characters;
7. backslash rejected;
8. absolute path rejected;
9. empty path and empty segment rejected;
10. `.` and `..` traversal rejected;
11. NUL rejected;
12. path representation preserved from accepted input to manifest/Git tree target;
13. changed base branch changes authorization digest and request fingerprint, not unchanged content digest;
14. changed summary changes request fingerprint but not default authorization digest;
15. one payload byte change changes content digest and request fingerprint;
16. omitted vs null vs empty semantics;
17. duplicate JSON keys rejected;
18. reordered unordered manifest entries yield identical digest;
19. effect-changing unknown field rejected;
20. branch alias/case/Unicode edge case under selected branch profile (or explicitly blocked pending profile);
21. repository rename/transfer identity case;
22. same idempotency key + changed fingerprint conflicts;
23. same key + same fingerprint triggers re-authorization and reconciliation, not blind resend;
24. response loss after provider acceptance remains UNKNOWN until reconciled;
25. archived tombstone remains verifiable after profile/key migration.

If a vector cannot yet be executable because a profile is intentionally unpinned, mark it BLOCKED_BY_OPEN_DECISION; do not fabricate an expected digest.

## 7. Required output format
Return:
- Executive verdict: ACCEPT / ACCEPT_WITH_BLOCKERS / REJECT.
- Independence declaration and target blob verification.
- Findings table sorted by severity.
- At least 25 test vectors with precise expected outcomes.
- Open blockers ranked by severity and dependency order.
- Rival hypotheses and falsification conditions for every blocker.
- Explicit freeze recommendation and conditions.
- Explicit statement that no code, PR, merge, deployment, or external write was performed.

## 8. Acceptance criteria for this review gate
The review is useful only if it:
- is independent and pinned to the exact blob;
- challenges the contract rather than paraphrasing it;
- covers all sections A-G and supplies at least 25 vectors;
- distinguishes policy decisions from unresolved implementation profiles;
- does not claim tests passed when they were only proposed;
- preserves SR-08 DENY / NOT AUTHORIZED;
- gives a reasoned verdict and a prioritized remediation sequence.

## 9. Current status
- Owner path policy Option A: **APPROVED**.
- SR-02 contract amendment: committed and exact-blob fetch verified.
- Independent review of this exact blob: **NOT RECEIVED / NOT RUN**.
- Conformance tests: **NOT RUN**.
- Contract freeze: **NOT APPROVED**.
- Implementation: **NOT AUTHORIZED**.
- PR / merge / deploy: **NOT AUTHORIZED**.
- External GitHub write dispatch: **DENY / NOT AUTHORIZED**.
