# Master Brain — Unified Write Execution Contract v2.1 (DRAFT)

**Status:** DRAFT — normative candidate for independent review; NOT IMPLEMENTED.  
**Baseline:** Contract v2 draft at PR #229 head f3953e915ad287eb67195df83224096b0a7f97fa.  
**Review base:** 5d8ae8c5c096356f0f64a68a46f874374b5a34b8.  
**Scope:** service-only project.create_change_pr.v1. No general-purpose GitHub write API.  
**Supersedes:** nothing until owner approval; v2 remains historical input.  
**Safety:** This document does not authorize implementation, test execution, merge or deployment.

> **Authority reconciliation required:** the v2 contract says D-01..D-14 were owner-approved in chat, while the companion R1 decision-proposal document says the proposal has not been applied and requires owner approval. Treat decision content as inputs, but do not freeze this contract until the approval record and any conditions are reconciled. D-04 remains conditional and UNVERIFIED.

## 0. Normative language and status vocabulary

MUST, MUST NOT, SHOULD and MAY are normative terms. Status labels are evidence labels:
- PROPOSED: candidate rule, not approved.
- APPROVED: explicit owner decision exists and is recorded.
- IMPLEMENTED: code change exists.
- TESTED: named test executed with retained evidence.
- NOT_RUN: test was not executed.
- UNKNOWN: external effect cannot be determined from current evidence.
- UNVERIFIED: hypothesis has not passed its defined experiment.
- BLOCKED: a required prerequisite is missing.
- PASS / FAIL: only for a defined test with evidence.

Unknown is neither pass nor fail. Not-run is never pass.

## 1. Safety invariants

1. GitHub is authoritative for external repository objects. WriteControl stores intent, authorization snapshot, dispatch phase, quota reservation and evidence references; it MUST NOT claim external state without a reconciliation witness.
2. No Exactly-Once claim is permitted. The design targets conservative at-most-once dispatch per phase, with explicit UNKNOWN after ambiguous dispatch.
3. No retry of a phase after its dispatch-intent commit unless that phase has an explicitly approved and experimentally established retry rule.
4. Policy, membership, quota, credential or clock dependency failure MUST fail closed before the next external side effect.
5. Reconciliation is read-only. Automatic deletion or rollback of GitHub artifacts is out of scope.
6. Every operation is scoped by tenant, principal, project, action and repository identity. A digest alone is never an authorization capability.
7. No untrusted value may select an arbitrary GitHub host, API path, repository, base branch or credential.

## 2. Canonical action and resource descriptor

Use one immutable canonical action identifier: project.create_change_pr.v1. Do not mix create_change_pr and project.create_pr as independently authorizable aliases.

The authorization resource descriptor MUST include:
- GitHub numeric repository ID;
- canonical owner and repository name as observed from GitHub;
- exact base branch;
- project ID;
- operation scope version;
- action identifier and schema version.

Owner/repository name is case-preserved for display and API use. Any comparison normalization must be explicitly specified and must not replace numeric repository identity. A rename or transfer MUST trigger fresh resource binding and authorization.

## 3. Ownership boundaries

| Aggregate | Sole owner | Prohibited responsibility |
|---|---|---|
| Tenant membership and policy | TenantDirectory | WriteControl must not become a policy cache or authority |
| Write operation, idempotency, quota reservation, lease, dispatch phase, UNKNOWN and audit | WriteControl | Must not reuse OrchestratorLedger task/outbox state as write-operation authority |
| General tasks and outbox orchestration | OrchestratorLedger | Must not own GitHub write lifecycle |
| External repository objects | GitHub | No local assertion without evidence |

WriteControl v1 is one logical Durable Object. Any future sharding is a versioned migration.

## 4. Deterministic identity encoding

### 4.1 operation_key

The v2 length-prefix proposal is underspecified. Candidate v2.1 encoding, subject to independent test vectors:

- Domain separator: ASCII bytes MB-WRITE-OP followed by NUL.
- Encoding version: unsigned 16-bit big-endian integer, currently 1.
- Fields emitted in this exact order, each with a one-byte field tag, then unsigned 32-bit big-endian byte length, then field bytes:
  1. action;
  2. principal.type;
  3. principal.id;
  4. tenant_id;
  5. project_id;
  6. resource.repository_id as decimal ASCII;
  7. client_idempotency_key.
- All string fields MUST be valid UTF-8, non-empty, and subject to per-field and total byte-length limits fixed in the implementation profile.
- Null, absent and empty are not interchangeable. Required fields reject null/absent/empty. Optional fields introduced later require an explicit presence tag; they MUST NOT be encoded as empty strings.
- No Unicode normalization, case folding, locale conversion or trimming is implicit. Owning authorities validate identifiers before encoding.
- SHA-256 is computed over the exact byte sequence. Store the encoding version with the operation record.

The byte-level test-vector package MUST cover empty values, non-ASCII UTF-8, maximum lengths, tag ordering, field ambiguity, null/absent distinctions and cross-runtime reproducibility. No implementation may infer the encoding from prose.

### 4.2 request_digest

Use a versioned canonical envelope:
- envelope schema: mb.write-request.v1;
- canonical JSON serialization: RFC 8785 JCS, restricted to a schema excluding floating-point numbers, NaN/Infinity, duplicate object keys and implementation-dependent numeric coercion;
- digest: SHA-256 over UTF-8 bytes of canonical JCS output.

The envelope MUST include every semantically relevant input and every GitHub payload field, including:
- action/schema version;
- numeric repository ID, owner, repo and base branch;
- PR title and body/summary exactly as sent;
- commit message and trailers;
- author and committer identity fields;
- author and committer timestamps;
- tree entry paths, modes, types and content SHA-256 values;
- parent commit identifiers;
- any template/version affecting generated content.

Paths are case-sensitive. Sort path records by unsigned lexicographic UTF-8 byte order. Reject invalid UTF-8 and duplicate byte paths. Do not normalize path Unicode unless a separately approved path policy requires it. Include a digest for each exact content byte sequence, not decoded/re-encoded text.

Store a top-level request digest and a digest for each phase payload. The phase payload digest binds the exact request the worker intends to send. Changing any byte or payload field changes the digest.

## 5. Branch derivation and collision handling

The v2 16-hex-character suffix is only 64 bits and its concatenation was not a complete encoding specification.

Candidate v2.1 derivation:
- branch_digest = SHA-256(ASCII domain separator MB-WRITE-BRANCH followed by NUL, concatenated with operation_key bytes);
- branch name = assistant/mb- plus first 32 lowercase hex characters (128 bits).

This improves collision resistance but does not prove uniqueness. The operation record MUST persist the full digest and exact branch name before branch dispatch.

Before adopting an existing branch:
1. GET the exact ref.
2. Fetch its commit and inspect exact tree and marker.
3. Verify repository numeric ID, operation marker, request digest, base relationship and expected payload digest.
4. If any field differs or evidence is incomplete, stop with BRANCH_COLLISION or UNKNOWN; never adopt or overwrite the branch.

No force update is allowed in v1.

## 6. Authorization and revocation

### 6.1 Versioned authorization ticket

A fresh TenantDirectory read followed by a WriteControl transaction does not eliminate the cross-DO TOCTOU window. Re-read alone is insufficient.

Candidate protocol:
1. TenantDirectory issues a short-lived signed or MAC-authenticated ticket containing tenant ID, principal ID/type, project ID, canonical action, repository numeric ID, exact base branch, resource digest, policy version, membership version, decision ID, issued-at, expiry and unique nonce.
2. WriteControl verifies authenticity, audience, scope, expiry, policy/membership versions and nonce binding during admission and before each new dispatch phase.
3. Ticket maximum lifetime and clock-skew allowance are fixed configuration values. Missing values deny admission.
4. Ticket is bound to exact operation_key and request_digest; it cannot be replayed for another request.
5. Revocation semantics MUST be an explicit owner decision:
   - Option A, bounded revocation: ticket remains valid until expiry; revocation latency is bounded by ticket TTL.
   - Option B, online revocation check: every phase requires a current TenantDirectory response, accepting the cross-DO race unless a stronger protocol exists.
   - Option C, serialized authority: introduce a single authority/sequence mechanism that linearizes revocation and dispatch authorization.

No option is silently selected here. Until selected and tested, implementation is BLOCKED.

### 6.2 Linearization

The WriteControl transaction committing a phase intent is the local dispatch-intent linearization point, not proof GitHub received the request. Revocation after that point cannot guarantee cancellation of an in-flight request. This residual risk must be explicit in policy and release notes.

## 7. State machine and external-effect state

A single status enum hides partial external artifacts. Maintain two dimensions.

Operation lifecycle:
- RESERVED
- IN_PROGRESS
- UNKNOWN
- SUCCEEDED
- FAILED_NO_EFFECT
- PARTIAL_ORPHAN

External effect state:
- NONE_CONFIRMED
- TREE_CONFIRMED
- COMMIT_CONFIRMED
- BRANCH_CONFIRMED
- PR_CONFIRMED
- CONFLICTING_EVIDENCE
- UNKNOWN_EFFECT

Phase progression:
RESERVED → TREE_INTENT_COMMITTED → TREE_CONFIRMED → COMMIT_INTENT_COMMITTED → COMMIT_CONFIRMED → BRANCH_INTENT_COMMITTED → BRANCH_CONFIRMED → PR_INTENT_COMMITTED → PR_CONFIRMED.

Every phase record contains:
- phase name and monotonically increasing phase sequence;
- dispatch_attempt_id unique per attempted dispatch;
- exact phase payload digest;
- lease generation and holder;
- authorization ticket digest and decision ID;
- local intent commit sequence;
- external response status, request ID and response digest if received;
- evidence references and reconciliation status.

Crash after intent commit but before network send is indistinguishable from a request accepted with a lost response. It MUST become UNKNOWN until reconciled. A single 404, one empty search page or one missing ref is not proof of no effect.

## 8. Dispatch, retry and reconciliation

- Intent is committed before network I/O.
- Network I/O MUST occur outside Durable Object storage transactions.
- A successful response is not sufficient to close a phase if returned identifiers cannot be verified.
- Transport timeout, connection reset, process crash, ambiguous 5xx, malformed response or lost response after dispatch intent produces UNKNOWN.
- No retry follows UNKNOWN by default.
- A phase may be retried only when a phase-specific rule has been experimentally established and the retry uses the exact same payload digest and attempt lineage. R2 evidence is not automatically production retry authorization.
- Reconciliation must be read-only and use the least-privileged credential able to observe all relevant objects.
- Reconciliation must query exact repository identity and paginate to exhaustion. A bounded result limit without proof of complete pagination is insufficient.
- A branch/commit/PR marker is corroborating evidence, not sole proof; markers can be copied or edited.

### Required reconciliation witness

Tree:
- numeric repository ID;
- exact tree SHA;
- complete expected path/mode/type set;
- each blob SHA and independently recomputed content digest;
- base tree relationship and phase payload digest.

Commit:
- exact commit SHA;
- exact tree SHA;
- exact parent list;
- author/committer identity and timestamps;
- exact message and trailer marker;
- repository identity and phase payload digest.

Branch:
- exact ref name and target SHA;
- expected commit SHA;
- exact operation/request marker;
- no conflicting branch history.

PR:
- exact PR number and URL;
- repository numeric ID;
- exact head repository, head branch and head SHA;
- exact base branch and base SHA relationship;
- exact title/body marker and request digest;
- state, draft/merged status, creation timestamp and response/request IDs;
- fully paginated search or direct known PR identifier plus consistency check.

Any mismatch, stale evidence, inaccessible page, permission failure or multiple candidate objects leaves operation UNKNOWN or PARTIAL_ORPHAN.

## 9. Durable Object transaction and lease rules

- transactionSync MUST contain synchronous storage-only operations. No await, network request, cross-DO call, timer wait or external side effect may occur inside.
- TenantDirectory reads and ticket verification occur outside the WriteControl transaction; verified ticket is then checked and consumed/bound inside the local transaction.
- Every transition uses compare-and-swap on operation ID, expected phase, lease holder and lease generation.
- Lease record includes holder ID, generation, acquired-at logical sequence, expiry, renewal count and bounded maximum lifetime.
- Renewal requires current holder and generation. A stale worker cannot commit a transition.
- Takeover increments generation atomically. Old generation is permanently fenced.
- Wall-clock jumps cannot reorder phase events. Use a monotonic per-operation sequence for ordering; use DO wall-clock timestamps only for expiry and audit display, with explicit clock-skew policy.
- Define and test expired lease, clock rollback/forward jump, worker pause, duplicate delivery and takeover during in-flight request.
- Lease expiry does not prove the old request was not sent; expiry after dispatch intent remains UNKNOWN until reconciliation.

## 10. Quota accounting

Quota dimensions: tenant, principal, repository, global emergency ceiling and UNKNOWN/PARTIAL operation capacity.

Admission:
- reserve quota atomically with operation reservation and audit append;
- missing/invalid quota configuration denies admission;
- concurrent admission must not oversubscribe counters.

Terminal accounting rules MUST be specified:
- rejected before reservation: no consumption;
- success: consume operation quota per configured policy;
- FAILED_NO_EFFECT with authoritative evidence: release refundable reservation according to policy;
- UNKNOWN or PARTIAL_ORPHAN: retain conservative reservation until reconciled or owner-approved terminal resolution;
- replay of same key/digest: no second reservation;
- idempotency conflict: no new reservation;
- expiry: tombstone retained; no automatic re-execution.

Quota values, windows, refund rules and UNKNOWN caps remain owner decisions. No default/unlimited values are permitted.

## 11. Audit atomicity and evidence integrity

- Every state transition and its audit event MUST commit in the same WriteControl storage transaction.
- Event fields: schema version, event sequence, operation ID, tenant/principal scope, action, phase, lifecycle state, external-effect state, request/phase digest, lease generation, authorization decision reference, timestamp, evidence references, previous hash and event hash.
- Canonical serialization and hash algorithm MUST be specified with cross-runtime test vectors.
- Failed audit append rolls back the associated state transition.
- Hash chaining is tamper-evident only relative to a trusted checkpoint; it is not tamper-proof. External anchoring and trusted timestamping remain a separate release gate.

## 12. Retention and tombstones

- UNKNOWN and PARTIAL_ORPHAN records MUST NOT be pruned automatically.
- Terminal operation details may expire only after a configured idempotency window.
- Tombstone MUST retain: scoped operation-key fingerprint, request-digest fingerprint, operation schema version, terminal status, expiry time, audit sequence/hash reference and outcome classification.
- Replays after expiry return IDEMPOTENCY_EXPIRED; they do not create a new operation under the old key.
- Audit retention window and its start/end semantics must be explicit. No tombstone is deleted while a related audit/evidence obligation remains open.

## 13. Error taxonomy

At minimum:
AUTHORIZATION_DENIED, AUTHORIZATION_UNAVAILABLE, AUTHORIZATION_TICKET_INVALID, POLICY_VERSION_CHANGED, MEMBERSHIP_VERSION_CHANGED, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_EXPIRED, QUOTA_EXCEEDED, QUOTA_UNCONFIGURED, LEASE_EXPIRED, STALE_LEASE, BRANCH_COLLISION, GITHUB_REJECTED_NO_EFFECT (only with authoritative no-effect evidence), GITHUB_RESPONSE_AMBIGUOUS, PARTIAL_EXTERNAL_EFFECT, RECONCILE_NOT_AUTHORIZED, RECONCILE_EVIDENCE_STALE, RECONCILE_EVIDENCE_INSUFFICIENT, AUDIT_WRITE_FAILED, WRITE_CONTROL_UNAVAILABLE.

Never map a transport error to FAILED_NO_EFFECT without evidence.

## 14. Test and falsification matrix

All entries are specifications; execution status is NOT_RUN.

| ID | Falsification target | Required test |
|---|---|---|
| C21-01 | Ambiguous field encoding | Golden vectors for field boundaries and UTF-8 |
| C21-02 | Canonical digest drift | Same envelope across runtimes yields same JCS bytes and digest |
| C21-03 | Omitted request field | Mutate every GitHub payload field independently; digest must change |
| C21-04 | Branch collision/adoption | Pre-create conflicting branch/marker; admission or reconciliation must stop |
| C21-05 | Authorization TOCTOU | Revoke/change membership around ticket issuance, admission and dispatch |
| C21-06 | Stale worker | Expire/take over lease while old worker is paused; old generation cannot commit |
| C21-07 | Ambiguous dispatch | Crash before send, after send, and after remote acceptance before response persistence |
| C21-08 | Partial external artifacts | Fail after each tree/commit/ref/PR phase; preserve partial effects |
| C21-09 | Incomplete reconciliation | Paginate; simulate stale search, 404, permission denial, duplicate markers and conflicts |
| C21-10 | Quota leak/oversubscription | Concurrent reserve, success, no-effect failure, UNKNOWN, replay and conflict |
| C21-11 | Audit atomicity | Inject audit write failure; state transition must roll back |
| C21-12 | Tombstone replay | Expire details but preserve scoped tombstone; old key cannot re-execute |
| C21-13 | Cross-tenant disclosure | Same client key across tenant/principal; no cross-scope result leakage |
| C21-14 | DO transaction misuse | Prove no network/await/cross-DO operation occurs in transaction callback |
| C21-15 | Credential boundary | No secret in logs, audit, PR body, marker or error output |

## 15. Open owner decisions — do not silently resolve

1. Authorization revocation model: bounded ticket, online check or serialized authority.
2. Ticket TTL, clock-skew allowance, nonce replay policy and key rotation.
3. Maximum field sizes and total operation payload size.
4. Quota values, windows, refund policy and UNKNOWN capacity.
5. Durable Object peak capacity, latency target, recovery objective and backup/restore.
6. GitHub credential type, least privilege, issuance, rotation, expiry and emergency revocation.
7. External audit anchoring and trusted timestamp requirements.
8. Whether and under what evidence a phase retry is ever allowed.
9. Whether a private disposable repository can be used for R2 and who receives PR notifications.
10. Reconcile v2 D-01..D-14 approval status with the companion proposal's status text.

## 16. Release gates

Implementation is BLOCKED until authority/decision status is reconciled; required owner decisions are resolved; canonicalization and authorization ticket protocols receive independent review; R2 is complete and its limits understood; failure-injection and reconciliation tests are implemented and pass; capacity, quota, credential and recovery evidence exists; and independent security review approves the exact implementation commit.

This document is a corrected draft, not implementation authorization.
