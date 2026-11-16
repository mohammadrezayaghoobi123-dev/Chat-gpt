# Master Brain — Independent adversarial audit of Unified Write Contract v2.2

**Date:** 2026-11-16  
**Reviewer:** ChatGPT, independent read-only design review  
**Scope:** v2.2 amendment document at PR head `cab29063d2700f97a73f1761f4afc0b3534cc61a`, blob `b1ba4575c7fdc533a25553a5436366b442b29d1c`; v2.1 parent contract blob `9386966430353e81d95591632d8f50d61e981657`.  
**Status:** DESIGN REVIEW ONLY. No implementation, real-GitHub experiment, Cloudflare runtime test, or test suite execution was performed in this review. All unexecuted tests remain `NOT_RUN`; unverified platform behavior remains `UNKNOWN/UNVERIFIED`.

## 1. Executive verdict

**VERDICT: BLOCKED — v2.2 is not ready to freeze or authorize implementation.**

The direction is materially stronger than v2.1: client intent is separated from the pinned execution plan; absence of evidence is not treated as proof of no effect; reconciliation favors immutable Git objects; and terminal administrative closure is no longer represented as success or failure.

However, the amendment still has unresolved internal contradictions and lifecycle gaps. The most important are:
- ambiguous ticket consumption and dispatch binding (A-02);
- an incompletely specified durability-to-network-send boundary and lease/ticket timing (A-06);
- repository delete/recreate TOCTOU against GitHub's slug-addressed write endpoints (A-03);
- incomplete exact PR witness criteria (A-08);
- key/tombstone lifetime after `ADMIN_CLOSED` (A-04/A-05);
- quota accounting when UNKNOWN work is resumed (A-05).

No finding below is evidence that the current implementation has been changed. The contract remains a documentation-only proposal.

## 2. Findings

### MB-V22-01 — Ticket is not unambiguously single-use per dispatch
**Severity: BLOCKER | Sections: A-02, v2.1 §7**

A-02 says the ticket is “single use per admission”, but also requires a valid ticket for every `*_DISPATCHED`, records a ticket id per phase, and permits obtaining a new ticket when the old one lacks sufficient remaining lifetime. These phrases do not define whether one ticket may authorize multiple phases or whether a new ticket is required for each phase.

**Required amendment**
- Define one authorization ticket per external dispatch attempt, not merely per admission.
- Bind it to: operation key, operation id, canonical action, repository id, resource digest, request digest, phase, phase payload digest, dispatch attempt id, lease generation, policy version, membership version, issuer, issued-at, expiry and unique ticket id.
- A ticket is consumed atomically with the durable `*_DISPATCHED` transition. It cannot be reused after timeout, takeover, a changed payload, a changed phase or an ambiguous send.
- A replacement ticket is a fresh authorization decision; it does not authorize a different payload.
- Define the exact clock used for expiry evaluation and the permitted skew bound.

**Falsification tests:** replay the same ticket concurrently; reuse across two phases; reuse after a lost response; attempt use after expiry margin; change payload/phase/lease generation; issue ticket from stale policy or membership version. Every case must fail closed without an outbound request.

### MB-V22-02 — Durability barrier is a requirement, not yet a complete protocol
**Severity: BLOCKER | Section: A-06, T-29**

A-06 correctly requires durable confirmation of `*_DISPATCHED` before sending. The mechanism remains unspecified. Cloudflare's primary Durable Objects documentation describes output gates: outgoing network messages are held until pending storage writes complete; if a write fails, outgoing messages are discarded and the object is restarted. The documentation also describes synchronous SQLite operations and synchronous-only `transactionSync` callbacks. This is strong platform evidence for a possible barrier, but it does not replace a test of the exact implementation path, compatibility date, storage backend, and outbound request mechanism.

**Required amendment**
- State whether the implementation relies on the documented output gate or an explicit storage synchronization operation.
- Do not assume `storage.sync()` is a universal SQLite barrier; document which API/backend supports the chosen mechanism.
- Prohibit any bypass such as unconfirmed writes or a send path outside the gated Durable Object execution context.
- Specify that the request cannot be emitted until the transaction has committed and the relevant output gate has opened.
- Record the runtime compatibility date, storage backend, and exact code path as part of the implementation evidence.

**Evidence:** Cloudflare, [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/); [KV-backed Durable Object Storage (Legacy)](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/); [Access Durable Objects Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

**Falsification tests:** inject a storage failure after the dispatch record is written but before network emission; force object restart; verify no outbound request can escape before persistence; verify recovery sees either the committed dispatch record or no dispatch record, never a send without a durable record.

### MB-V22-03 — Repository identity check cannot close the slug TOCTOU window
**Severity: BLOCKER unless residual risk is explicitly accepted | Section: A-03**

Persisting `repository_id` and checking it immediately before every dispatch is the correct identity model. But the documented GitHub Git Database write endpoints are addressed using `owner` and `repo` path parameters. The repository can theoretically be deleted and recreated under the same slug between the preflight identity read and the write request. A post-write identity check can detect a wrong-target write but cannot undo the external effect.

**Required amendment**
- Explicitly state that preflight `repository_id` validation narrows but does not eliminate delete/recreate TOCTOU.
- Determine whether the selected write API supports an immutable repository-id target. Do not assume it does.
- If no identity-conditioned write endpoint exists, either:
  1. block writes for this threat model, or
  2. record an explicit owner-approved residual-risk decision with compensating controls and an accepted blast radius.
- A post-write repository-id mismatch must become a security incident / `UNKNOWN` or `PARTIAL_ORPHAN`; it must never be described as a successful write to the intended repository.

**Evidence:** GitHub REST Git Trees, Git Commits and Git References APIs document `owner` and `repo` as path parameters: [Trees](https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28), [Commits](https://docs.github.com/en/rest/git/commits), [References](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28). These sources do not establish an immutable repository-id write route.

**Falsification test:** pause after repository-id preflight, delete/recreate the repository with the same slug in a disposable organization, then resume the request. Confirm the operation cannot silently write into the replacement repository. If the platform cannot guarantee this, the contract must retain the residual risk and block the stronger safety claim.

### MB-V22-04 — FAILED_NO_EFFECT has a wording-level contradiction
**Severity: HIGH | Section: A-04**

A-04 permits `FAILED_NO_EFFECT` after a definitive rejection of the first phase, while rule (3) says absence of evidence never yields `FAILED_NO_EFFECT` after any dispatch. These can coexist only if a definitive rejection is **positive endpoint evidence of no effect**, not merely a missing object or a generic HTTP error.

**Required amendment**
- Rewrite the rule as: after any dispatch, `FAILED_NO_EFFECT` is permitted only when a documented, endpoint-specific response positively proves that the request was rejected before creating any external effect.
- A timeout, connection reset, generic 4xx/5xx, rate limit, malformed response, empty GET, or absence of a matching object is not such proof.
- The endpoint outcome table must identify the exact method/path/status/body semantics and supporting primary documentation for every allowed no-effect classification.

**Falsification tests:** lost response after successful create; 422 validation response; 403 permission denial; 404 repository/path response; 409 conflict; 429 rate limit; 5xx; malformed/truncated body. Each case must have a deterministic evidence-based classification. Unlisted outcomes remain ambiguous.

### MB-V22-05 — ADMIN_CLOSED can outlive its idempotency protection
**Severity: HIGH | Sections: A-04, A-05, v2.1 §11**

A-04 says the `ADMIN_CLOSED` tombstone keeps blocking the key. A-05 starts the idempotency window when a terminal status is entered, including `ADMIN_CLOSED`. The amendments do not explicitly say whether the key remains permanently blocked after the normal idempotency window expires or after tombstone expiry.

**Required amendment**
- For `ADMIN_CLOSED` with `INDETERMINATE` or `PRESENT_PARTIAL` external-effect state, retain a permanent/non-expiring key reservation unless a separately authorized legal/deletion process explicitly resolves the external-effect risk.
- Do not permit key reuse merely because a timer elapsed.
- Separate ordinary terminal retention from unresolved-effect key reservation.
- Define the deletion/legal exception and require an auditable, named actor and evidence.

**Falsification test:** close an UNKNOWN operation administratively, advance beyond every ordinary retention/idempotency period, then replay the same key. It must not create a new operation.

### MB-V22-06 — Recovery/resumption quota transitions are incomplete
**Severity: HIGH | Section: A-05**

A-05 releases concurrency when the operation enters UNKNOWN, and prevents double release with `concurrency_held`. But it does not define how concurrency is reacquired if reconciliation safely permits the same operation to resume, nor does it define an explicit UNKNOWN-to-active-resumption transition. If recovery dispatches can proceed without re-reserving concurrency, quota enforcement can be bypassed; if concurrency is re-reserved without a state transition rule, double accounting becomes possible.

**Required amendment**
- Define a distinct recovery/resume admission transition for the existing operation.
- Reacquire concurrency atomically before a new dispatch, using the same tenant/repository/global ceilings and a fresh lease generation.
- Define whether recovery consumes rate quota; make the choice explicit and resistant to unbounded retries.
- Ensure the original idempotency key remains bound to the original operation.
- Update counters and audit in one transaction.

**Falsification tests:** UNKNOWN → reconcile → resume; concurrent recovery attempts; crash after quota reacquisition but before dispatch; stale lease takeover; quota full during recovery; terminal resolution after a prior release. Verify no undercount, over-release or double reservation.

### MB-V22-07 — PR success witness is not sufficiently exact
**Severity: HIGH | Section: A-08**

A-08 lists immutable commit/tree evidence, PR number, creation time and PR author id. It then says mutable PR fields, including `head.sha`, are recorded as evidence but are not match criteria. This can prove that a matching commit and a PR-like record exist, but it does not necessarily prove that the PR being marked successful currently points to the exact commit created by this operation.

**Required amendment**
For immediate success verification, require at minimum:
- exact base repository id and head repository id;
- exact base ref and head ref;
- exact expected head commit SHA;
- exact expected base commit/ref semantics;
- exact commit parent, tree SHA, tree entries and content digests;
- exact PR author numeric id;
- exact immutable commit trailer marker and request digest;
- PR number and created-at bounds;
- all relevant pagination completed with no duplicate/conflicting match.

Treat PR state (open/closed/merged) as a recorded mutable property, not a proof criterion. For later reconciliation after branch movement/deletion, define a separate witness rule that still cryptographically/structurally binds the PR to the expected immutable commit. Do not silently weaken the immediate success witness.

**Falsification tests:** create PR then advance head branch; delete head branch; change PR base; edit PR body; create a second PR with copied marker; create a PR from another repository with same branch name; return multiple candidates. Only the exact expected PR/commit relation may produce `SUCCEEDED`.

### MB-V22-08 — Two-digest model needs an exact byte boundary
**Severity: HIGH | Section: A-01**

The semantic split is sound:
- `request_digest` identifies client intent;
- `execution_digest` identifies the server-pinned execution plan.

However, “SHA-256 of the JCS of the exact request body sent” is ambiguous unless the implementation sends those exact JCS bytes without a later serializer transformation.

**Required amendment**
- Define `phase_payload_bytes` as the exact UTF-8 byte sequence supplied to the HTTP transport as the request body.
- Construct the body once, hash those bytes, persist the digest, and send the same byte buffer unchanged.
- If a transport library reserializes objects, hash the post-serialization bytes or bypass that serializer.
- Keep semantic JCS digest and transport-body digest as distinct named fields.
- Specify content encoding/compression handling; do not confuse application body bytes with TLS or HTTP framing bytes.

Also define exact Git commit identity serialization: author/committer name and email, timestamp format, timezone offset, message encoding, trailers and newline rules. GitHub's create-commit API accepts author/committer dates in ISO-8601 form and parents/tree/message as separate fields.

**Evidence:** [GitHub REST API endpoints for Git commits](https://docs.github.com/en/rest/git/commits).

### MB-V22-09 — Clock clamp is still incomplete for authorization and lease safety
**Severity: HIGH | Section: A-06**

`max(now,last_observed_now)` prevents a backward wall-clock movement from shortening a lease. A forward-jump ceiling is useful, but the contract does not yet define:
- the authoritative clock source for ticket issuance versus dispatch;
- how two Durable Objects compare timestamps safely;
- how the system exits clock quarantine;
- whether a forward jump during an already-issued ticket invalidates all pending tickets;
- the maximum delay between the durable dispatch record and actual network send.

**Required amendment**
Use one explicit clock authority for ticket/lease comparisons, or define a bounded-skew protocol. Persist clock observations and quarantine on anomalies. A dispatch whose authorization/lease safety margin cannot be demonstrated must not be sent. Do not treat a wall-clock clamp as a monotonic clock.

### MB-V22-10 — `execution_digest` and pinned base snapshot need tighter Git invariants
**Severity: MEDIUM/HIGH | Section: A-01**

The pinned base commit and tree should be derived from one immutable commit object. The contract should say:
- resolve the base ref once;
- pin the returned commit SHA;
- fetch that exact commit by SHA;
- take its tree SHA and parent metadata from that immutable commit;
- never independently resolve the moving branch again during retry/takeover.

Define whether the commit API request's fixed timestamp is second precision and UTC `Z`, and ensure all author/committer identity fields and message bytes are fixed. GitHub documents ISO-8601 timestamps for author and committer dates.

### MB-V22-11 — FC3/SR-02 is a normative dependency but not pinned here
**Severity: HIGH | Section: A-07**

A-07 defers to SR-02/FC3 without identifying the exact document revision, blob SHA, Unicode version, normalization/case-fold algorithm, or test-vector manifest. A mutable branch reference is insufficient for a security-sensitive path policy.

**Required amendment**
Pin exact document blob SHAs and the normative profile version. The contract must fail closed if the implementation's parser/profile version differs. Include a cross-reference to the approved path-policy test-vector manifest and state that no broader runtime Unicode database may silently substitute for the pinned profile.

### MB-V22-12 — `ADMIN_CLOSED` and error-code semantics need separation
**Severity: MEDIUM**

A-10 lists `ADMIN_CLOSED` among error codes although A-04 defines it as an operation status. Define whether API responses use a status field, an error code, or both. Do not make the same token ambiguously mean a terminal state and a request error.

## 3. Direct answers to the owner questions

1. **Two-digest split:** conceptually correct and recommended. It must be complemented by a separately defined exact transport-body digest.
2. **FAILED_NO_EFFECT only when no phase was dispatched:** conservative and appropriate, with one narrow exception for a documented positive endpoint rejection proving no effect. Absence of an object is never sufficient.
3. **max(now,last_observed_now):** insufficient alone. It handles backward movement only; forward-jump quarantine, cross-DO skew, ticket authority and send-time margin remain required.
4. **OD-9 unreferenced objects:** do not default to “not an external effect.” A created Git object is an external artifact even if not yet referenced by a branch. Record it as possible/observed partial effect. Never infer no effect from inability to enumerate it.
5. **repository_id in operation key:** correct. Keep slug as locator, not durable identity. But a preflight ID check does not close the write-target TOCTOU window where GitHub APIs resolve writes through owner/repo path parameters.

## 4. Additional state-machine invariants required

The consolidated contract should explicitly assert:

- A ticket authorizes one exact dispatch attempt only.
- No outbound request exists without a previously durable dispatch record.
- No payload mutation is permitted after its payload digest is committed.
- No ambiguous dispatch can be converted to no-effect by a missing GET result.
- No operation with unresolved external effects can release its idempotency key.
- A recovery dispatch must reacquire concurrency before sending.
- A stale lease generation cannot mutate phase state; late observations are audit-only hints.
- `SUCCEEDED` requires exact repository, ref, commit, tree and PR binding.
- A repository identity mismatch before dispatch blocks the send; a mismatch after dispatch is an incident and never success.
- Every endpoint outcome classification is backed by a primary source or a reproducible experiment.

## 5. Required tests (additions to T-01..T-32)

All are **NOT_RUN**:

- T-33 ticket replay across phases and concurrent dispatch attempts.
- T-34 output-gate / durable-before-send fault injection on the selected Cloudflare backend and compatibility date.
- T-35 delete/recreate same-slug race at the GitHub write boundary.
- T-36 ADMIN_CLOSED key replay after all ordinary idempotency windows.
- T-37 UNKNOWN recovery reacquires concurrency exactly once.
- T-38 PR head SHA advances between creation and verification.
- T-39 exact transport-body bytes equal the persisted phase payload digest input.
- T-40 forward clock jump while a ticket is outstanding; quarantine and recovery.
- T-41 pinned base ref moves between admission and takeover; pinned commit/tree remain unchanged.
- T-42 FC3 profile version/blob mismatch blocks admission.

## 6. PR, branch and CI provenance snapshot

Observed during this review:
- PR #229: OPEN / DRAFT; PR head `cab29063d2700f97a73f1761f4afc0b3534cc61a`; reported base SHA `5d8ae8c5c096356f0f64a68a46f874374b5a34b8`.
- Integration branch head: `7f7abd2ae5d111c4e25dc2a2eb0dfefb0b24eb51`.
- Fixed main baseline: `919b19ca3d3887352cdef06b03c668ead04fbce7`; compare reported 77 ahead / 0 behind before this audit report was committed.
- GitHub generated merge-test commit `275c53dcd9747beb2be7ef0fb70de03a5632f0c5` had parents `7f7abd2...` and `cab2906...`. This is a synthetic/test merge reference; it does not mean PR #229 was merged.
- The v2.2 amendment blob was fetched directly from the PR head. The integration branch is not the same commit as the PR head; review scope and PR merge-test provenance must remain explicit.
- R2.1 real-GitHub experiment and E6 lost-response test remain NOT_RUN. Fake-`gh` mechanics do not prove GitHub server semantics.
- Gitleaks full-history scan reported two `generic-api-key` detections in R1-U17 lines 32 and 70. The exact referenced values are public OpenPGP key identifiers/fingerprint material, not secrets. The PR-diff scan reported no leaks. The workflow's historical-scan failure remains a CI failure; any allowlist change must be narrowly scoped and independently reviewed.

## 7. Required next gate

Do not freeze v2.2 and do not implement from it.

Recommended next sequence:
1. Claude authors a v2.2.1 amendment resolving MB-V22-01 through MB-V22-12 without changing implementation.
2. Owner explicitly resolves OD-1 through OD-11; unresolved decisions remain release blockers.
3. Independent reviewer checks the consolidated v2.3 against the parent contract and exact FC3/SR-02 blob references.
4. Run R2.1 and E6 only in a disposable GitHub repository with explicit owner authorization, recording every request/response, status, request id, body digest, pagination and resulting Git object/ref/PR state.
5. Run T-01..T-42; report each as PASS, FAIL, NOT_RUN or UNKNOWN with evidence. A green CI run is not contract approval.
6. Only after those gates may implementation authorization be considered.

## 8. Scope and non-actions

This review did not:
- change PR #229, its base/head, reviewers, labels or comments;
- merge or close any PR;
- modify source code, workflows, dependencies, secrets, Cloudflare, Supabase or laptop state;
- execute R2.1 against GitHub;
- run tests or send GitHub write requests.

This report is a documentation artifact only. It does not approve v2.2, v2.3, an implementation, a release or a deployment.
