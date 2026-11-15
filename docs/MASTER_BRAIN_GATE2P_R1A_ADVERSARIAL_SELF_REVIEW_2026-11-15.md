# Master Brain — Gate 2P / R1-A-SR: Adversarial Self-Review

> **Provenance note (added at publication):** the analysis in this document was performed against branch `integration/master-brain-unification-2026-11-15` at commit `5d55336feef7f27c3ec8b02bb7b8dab4dab0d768` (main `919b19ca3d3887352cdef06b03c668ead04fbce7`). That branch was force-updated before publication; its head at publication is `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`, whose history does not contain `5d55336` and which contains 45 additional files (including `.github/workflows/unicode18-raw-byte-acquisition.yml`) that were **NOT reviewed**. No finding here is claimed for `5d8ae8c`. Status: documentation only; no code, no tests run (NOT_RUN).

**Review ID:** MB-G2P-R1A-SR-2026-11-15  
**Target branch:** integration/master-brain-unification-2026-11-15  
**Target proposal:** docs/MASTER_BRAIN_GATE2P_R1A_CONTRACT_DELTA_V2_PROPOSAL_2026-11-15.md  
**Proposal blob SHA:** d170f8d7bc99135d72f64ecd144aa1bf316ccefe  
**Proposal commit:** c0a90dfa7abcc424a8229d506b4aa4a4f42b0d33  
**Review type:** Internal adversarial self-review by the proposal authoring assistant  
**Independence:** NOT INDEPENDENT. This document is not Gate 2P-R1-C and cannot substitute for Claude or another separately operating reviewer.  
**Status:** REVIEW FINDINGS — OWNER DECISION AND INDEPENDENT REVIEW REQUIRED

## 0. Scope and limitations

This review challenges the text and internal consistency of R1-A. It does not claim source-code verification, runtime behavior, GitHub API experimentation, or implementation correctness. No code, secrets, PR, merge, deployment, or production/staging write was performed. All proposed tests remain NOT_RUN.

A finding marked PROVISIONALLY_SUPPORTED identifies a design gap visible in the proposal text; it does not prove an exploitable implementation defect.

## 1. Executive result

R1-A is materially stronger than the initial R1 draft, but it is not ready to freeze. Remaining design gaps concern:

1. internal lease fencing versus already-authorized external side effects;
2. separation of authorization resource identity from payload/request fingerprint;
3. replay guarantees after tombstone deletion;
4. fault injection that simulates a lost response after GitHub has accepted a POST;
5. exact ordering/atomicity scope for audit hash-chain events;
6. canonical operation ID constraints and branch namespace;
7. reconciliation's least-privilege read capability;
8. residual revocation race after dispatch-intent.

Recommended disposition: **CONDITIONAL — revise the proposal before independent review; do not implement.**

## 2. Findings

### SR-01 — A fencing generation does not fence GitHub side effects

**Severity:** BLOCKER  
**Claim under test:** D-07's lease_generation prevents stale workers from performing an obsolete operation.  
**Evidence:** D-07 specifies generation checks for state mutations and CAS, but does not define an enforcement point at the external GitHub boundary.  
**Failure scenario:** Worker A obtains generation 4, validates it, and pauses before sending a GitHub POST. Its lease expires; worker B obtains generation 5 and proceeds. Worker A resumes and sends the old POST. Local CAS may reject A's later state update, but cannot undo the external GitHub write.  
**Counter-hypothesis:** A single serialized dispatcher may ensure that only the current generation can cross the network boundary.  
**Falsification test:** Pause worker A after lease validation but before network dispatch; expire its lease; allow worker B to claim generation 5; resume A. Verify whether A can still cause an external write.  
**Expected result:** A must be prevented from dispatching, or the design must explicitly classify this as an unavoidable in-flight side-effect risk and provide reconciliation/containment.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Define an external dispatch gate/dispatcher ownership protocol. State plainly that local fencing alone cannot revoke a request already sent or prevent a stale worker from sending after a local check unless the dispatch boundary itself serializes/validates the permit. Do not claim full external fencing from a local generation counter.

### SR-02 — Authorization resource digest and request fingerprint are conflated

**Severity:** HIGH  
**Claim under test:** D-06 can include all authorization-relevant and externally written fields in a single canonical digest.  
**Evidence:** D-06 describes a canonical resource and request fingerprint together, including repository, base branch, title, summary, paths, file content, and preconditions. D-05 separately stores resource_digest and request_digest.  
**Failure scenario:** A title or summary change alters request content but not necessarily the identity of the resource being authorized. If authorization policy scopes a repository/project/action/resource, including presentation fields in resource identity may create unnecessary authorization scope churn. Conversely, if policy authorizes exact payload content, that must be explicit.  
**Counter-hypothesis:** The implementation may already distinguish stable authorization resource identity from an exact operation request fingerprint.  
**Falsification test:** Define two requests targeting the same repository/project/action/resource but with different summary/title; determine which digest changes and which authorization rule is evaluated.  
**Expected result:** Stable resource identity and full request fingerprint are separate, versioned values with documented semantics.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Define at least:
- authorization_resource_digest: canonical identity of the protected target/resource;
- request_fingerprint: every input affecting the exact external operation;
- content_digest: canonical payload/file content digest if needed.

Specify which digest TenantDirectory authorizes and which digest WriteControl uses for idempotency/conflict detection. Ensure summary is included in request_fingerprint even if it is not part of resource identity.

### SR-03 — Replay rejection after tombstone deletion is not fully specified

**Severity:** HIGH  
**Claim under test:** D-10 can return IDEMPOTENCY_EXPIRED after the idempotency window.  
**Evidence:** D-10 correctly notes replay protection exists only while a tombstone or equivalent remains, but does not define how the system recognizes an expired key after the tombstone is deleted.  
**Failure scenario:** An operation result expires; its tombstone is later deleted; the same client key is submitted again. With no remaining record or namespace epoch, the system cannot distinguish a never-used key from an expired key.  
**Counter-hypothesis:** A persistent namespace epoch, compact key ledger, or permanent operation identity index may preserve this distinction.  
**Falsification test:** Delete the tombstone under the proposed retention policy and replay the original client key. Verify the response and whether a second external operation can be admitted.  
**Expected result:** Either the key remains recognizable as expired, or the documented guarantee explicitly ends after a bounded horizon and requires a new client-key namespace/epoch.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Owner must choose bounded versus indefinite replay protection. Specify a durable epoch/namespace scheme or explicitly document that duplicate prevention is not guaranteed beyond the retention horizon. Do not promise IDEMPOTENCY_EXPIRED after all identifying evidence has been deleted.

### SR-04 — R2 does not simulate the most important ambiguous-response failure

**Severity:** BLOCKER  
**Claim under test:** The R2 duplicate POST tests establish safe recovery after ambiguous timeouts.  
**Evidence:** Section 3 tests repeated POSTs and subsequent GETs, but does not require fault injection that drops the response after GitHub accepts the request.  
**Failure scenario:** GitHub accepts a tree/commit/ref/PR POST, but the client connection resets or times out before the response reaches the Worker. A normal second POST test with a received response does not reproduce this ambiguity.  
**Counter-hypothesis:** The R2 operator may be able to use a controlled proxy/fault-injection harness to drop responses after upstream acceptance.  
**Falsification test:** For each POST endpoint, inject response loss after upstream acceptance; then run the proposed reconciler/GET flow without blindly resending.  
**Expected result:** The system identifies the external object or returns UNKNOWN without duplicate or destructive side effects.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Extend R2 with a separately labeled response-loss/fault-injection test for each endpoint. If the GitHub API path cannot be safely fault-injected, mark that property UNKNOWN and do not claim recovery safety from duplicate-request observations alone.

### SR-05 — Audit hash-chain ordering and transaction boundary are underspecified

**Severity:** HIGH  
**Claim under test:** D-11 guarantees a verifiable ordered chain and audit failure rollback.  
**Evidence:** D-11 defines previous_hash/event_hash and sequence/ordering scope, but does not select the chain partition or define how concurrent admissions atomically reserve sequence and persist event/state.  
**Failure scenario:** Concurrent operations append events using the same prior hash or sequence; one update is lost, ordering becomes ambiguous, or state is committed without its audit event.  
**Counter-hypothesis:** A single Durable Object transaction with serialized sequence allocation and event append may provide a well-defined chain within one partition.  
**Falsification test:** Concurrently admit operations and inject storage failures around sequence allocation, event append, and operation-state persistence; run the verifier.  
**Expected result:** No duplicate sequence, fork, missing event, or state-without-audit condition within the declared consistency boundary.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Specify chain partition and atomicity boundary. If state and audit are in the same DO transaction, state the exact transaction scope; if cross-DO, use a documented outbox/reconciliation model and do not claim cross-DO atomicity.

### SR-06 — operation_id and branch-name syntax/length constraints are incomplete

**Severity:** MEDIUM  
**Claim under test:** Using the full operation_id in a Git branch produces a deterministic valid branch name.  
**Evidence:** D-02 proposes assistant/op-{operation_id} and defers final charset/format decisions.  
**Failure scenario:** An operation ID contains characters disallowed or problematic in Git ref names, exceeds practical ref length limits, or is not unique within the repository namespace.  
**Counter-hypothesis:** operation_id may be generated as a fixed-format UUID/ULID restricted to a safe alphabet and length.  
**Falsification test:** Test the complete permitted operation_id domain against Git ref validation and repository-level collision behavior.  
**Expected result:** A fixed, validated, immutable format maps to one valid branch name with a defined uniqueness scope.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Specify operation_id format, entropy/uniqueness scope, allowed alphabet, length, and branch encoding. Reject invalid identifiers before admission.

### SR-07 — Reconciler least privilege needs explicit GitHub permission scope

**Severity:** MEDIUM  
**Claim under test:** D-15 defines a read-only reconciliation capability.  
**Evidence:** D-15 says the capability must not authorize new writes, policy changes, or deletion, but does not enumerate the external GitHub permissions/endpoints required for GET ref, GET commit/tree, and listing PRs.  
**Failure scenario:** The same credential used for reconciliation also has contents/pull-request write permissions, expanding blast radius if the reconciler is compromised.  
**Counter-hypothesis:** A separate GitHub App installation token or credential can be scoped to metadata/contents/PR read operations only.  
**Falsification test:** Attempt reconciliation with a read-only credential and verify all required observations work while write endpoints are denied.  
**Expected result:** Reconciler performs required reads and cannot create/update/delete repository objects.  
**Actual result:** NOT_RUN.  
**Outcome:** PROVISIONALLY_SUPPORTED.  
**Required remediation:** Define minimum GitHub permission set and separate read-only reconciler identity from write dispatcher identity where supported.

### SR-08 — Dispatch-intent leaves a revoke race that requires explicit owner acceptance

**Severity:** HIGH  
**Claim under test:** D-08 sufficiently defines the point after which revocation does not cancel a request.  
**Evidence:** D-08 makes dispatch-intent the internal linearization point but acknowledges network send may occur later.  
**Failure scenario:** Authorization is valid at intent commit; revocation occurs; worker sends the request afterward. The intent point is not the external effect point.  
**Counter-hypothesis:** Owner may explicitly accept the bounded race and require a maximum delay, short-lived dispatch permit, and reconciliation/compensation policy.  
**Falsification test:** Pause after intent commit, revoke authorization, then resume dispatcher. Observe whether external write occurs and how it is classified.  
**Expected result:** Behavior matches an explicitly owner-approved risk policy; no claim of instantaneous revocation is made.  
**Actual result:** NOT_RUN.  
**Outcome:** DISPUTED until owner accepts residual risk.  
**Required remediation:** Define maximum intent-to-dispatch age, stale-intent expiry, whether a final authorization check is required immediately before network send, and the unavoidable race after that check. Keep this as an explicit owner decision.

## 3. Required amendments before independent review

1. Add external-dispatch fencing limitations and a stale-worker fault-injection test (SR-01).
2. Split authorization_resource_digest from request_fingerprint and optional content_digest (SR-02).
3. Resolve bounded/unbounded replay guarantee and tombstone recognition semantics (SR-03).
4. Extend R2 to simulate response loss after upstream acceptance, or explicitly leave recovery UNKNOWN (SR-04).
5. Define audit chain partition and transactional consistency boundary (SR-05).
6. Define operation_id format and branch-name validation (SR-06).
7. Specify read-only GitHub permissions for reconciler (SR-07).
8. Keep the dispatch-intent residual revoke race as an explicit owner risk decision (SR-08).

## 4. Gate recommendation

**R1-A:** Proposal exists and was fetched back from GitHub; this is a document integrity check, not independent approval.

**R1-B:** OWNER DECISION REQUIRED. No D-01..D-16 decision is inferred.

**R1-C:** NOT_RUN. This self-review is not independent and must not be presented as such.

**R2:** NOT_RUN. GitHub API semantics and response-loss recovery remain UNKNOWN.

**Implementation / PR / merge / deployment:** NOT AUTHORIZED.

Recommended next atomic action: revise R1-A to address SR-01 through SR-07 and retain SR-08 as an explicit owner risk decision; then obtain an independent adversarial review of the exact revised blob. No code changes are authorized by this review.
