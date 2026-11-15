# MB Gate 2P — Unified Write Execution Contract v2 Draft Review
Date: 2026-11-15
Review type: independent architecture, protocol, security, and experiment review
Reviewed material: user-supplied Unified Write Execution Contract v2 (DRAFT) and MB R2 GitHub Git-Data behaviour experiment
Review status: BLOCKED FOR NORMATIVE FREEZE — CORRECTIONS REQUIRED
Execution status: NO IMPLEMENTATION, NO TEST EXECUTION, NO GITHUB WRITE EXPERIMENT

## 1. Executive verdict

The draft has a sound high-level direction: separate TenantDirectory from WriteControl, persist dispatch intent before external I/O, avoid Exactly-Once claims, preserve UNKNOWN, and use read-only reconciliation. It is not yet safe to freeze as a normative implementation contract.

Critical blockers:
1. Cross-DO authorization has an unresolved time-of-check/time-of-use race. A fresh TenantDirectory read cannot be atomic with a later WriteControl transaction or GitHub dispatch.
2. The operation-key and request-digest byte encodings are underspecified; independent implementations can compute different keys/digests.
3. The state/status model does not adequately represent known partial external effects. FAILED can be misread as “no external effect”.
4. At-most-once dispatch per phase needs a precise definition for the crash window between committing *_DISPATCHED and actually sending the HTTP request.
5. R2 tests only a narrow subset of endpoint behaviour. It does not test lost-response ambiguity, exact reconciliation, or sufficient repetitions to establish a robust rule.
6. R2 api() suppresses all errors with || true, losing reliable distinction between success, expected conflict, authorization failure, rate limit, and transport ambiguity.
7. The script has no enforced disposable-repository confirmation, and its branch/marker identifiers are not sufficiently unique.

No D-01..D-14 owner decision is changed by this review. D-04 remains UNVERIFIED until R2 evidence satisfies explicit acceptance criteria. This report is a review artifact, not approval to implement or run writes.

## 2. Contract corrections — blocking

### C-01 — Define exact action and scope names

The draft alternates between create_change_pr and project.create_pr. Choose one immutable canonical action identifier for authorization, operation-key derivation, audit, quota, and request envelope. If a public alias exists, resolve it before admission and persist both canonical action and alias separately.

The authorization resource descriptor MUST include base_branch for project.create_pr, consistent with the existing SR-02 requirement. Include a stable GitHub repository identity where available (repository numeric ID) as well as owner/repo slug. A rename or transfer must fail closed unless explicitly re-authorized.

### C-02 — Make operation-key serialization normative

“SHA-256 of length-prefixed sequence” is not interoperable until the following are fixed:
- domain separator bytes and encoding;
- field order and field identifiers;
- length integer width and byte order;
- string encoding (strict UTF-8);
- null/absent/empty distinctions;
- maximum field lengths;
- canonicalization rules for owner/repo and identifiers;
- operation-key schema version.

Recommended encoding: domain separator MB-WRITE-OP followed by NUL; each field encoded as a fixed field tag plus a 32-bit unsigned big-endian byte length plus exact UTF-8 bytes. Reject invalid UTF-8, duplicate/unknown fields, and over-limit values. Owner/repo canonicalization must be explicit and must not silently normalize arbitrary user strings.

The raw client idempotency key MUST NOT be stored or logged. Enforce a documented entropy/length policy. The scoped operation key is an index/fingerprint, not an authorization credential. A hash-only lookup without tenant/principal scope remains forbidden.

### C-03 — Make request_digest a complete deterministic request envelope

“Canonical” is not a specification. Define a versioned schema and canonical serializer. Recommended:
- RFC 8785 JCS for the JSON envelope, with project restrictions (duplicate keys rejected before parse; no floats/NaN/Infinity; bounded safe integers; strict UTF-8; no implicit Unicode normalization);
- SHA-256 over the canonical UTF-8 bytes;
- content digest = SHA-256 over exact raw file bytes, not decoded/re-encoded text;
- paths sorted by a specified byte ordering (recommend unsigned lexicographic UTF-8 byte order), while preserving exact case and exact accepted path bytes;
- include each file path, mode, type, content length, and content digest;
- include all GitHub API payload fields across tree, commit, branch/ref, and PR phases, including title, body/summary, base, head, draft, commit message/trailers, author/committer identity and fixed timestamps where supplied, and API version;
- persist a per-phase payload digest as well as the overall request_digest.

If a field sent to GitHub is not included in the digest, the contract must explain why it cannot affect the external result. request_digest must not depend on JSON object insertion order or host locale.

### C-04 — Branch-name derivation needs unambiguous encoding and larger collision margin

The expression SHA-256("MB-WRITE-BRANCH" concatenated with operation_id) is underspecified. Use a domain separator with a NUL terminator or the same normative length-prefix encoding. Define operation_id’s byte format.

The first 16 hex characters provide only 64 bits. Increase the branch suffix to at least 32 hex characters (128 bits), unless a documented collision analysis justifies a different size. Persist the final branch name before BRANCH_DISPATCHED. On pre-existing ref, do not adopt it merely because the name matches; verify exact operation marker and expected commit. Otherwise return BRANCH_COLLISION and preserve evidence.

### C-05 — Resolve the cross-DO authorization race

The current design cannot claim that a revoke committed in TenantDirectory always prevents a later WriteControl dispatch. The sequence “read policy/membership → later commit *_DISPATCHED” is not atomic across two Durable Objects.

The contract MUST choose and document one of these semantics:
A. Bounded authorization snapshot: TenantDirectory returns an exact, versioned, short-lived authorization decision/ticket bound to tenant, principal, action, resource_digest, and request_digest. WriteControl records the ticket/version and rejects expired or mismatched tickets. The contract explicitly states that revocation may not affect already-issued tickets until their bounded expiry.
B. Strict revocation serialization: introduce a coordination protocol that serializes revocation and dispatch authorization. This is more complex and cannot be claimed from a plain re-read.

Do not state “fresh re-check” as if it closes the race. Define the maximum permitted decision age and the exact revocation linearization semantics. Re-read immediately before every dispatch as defence-in-depth, but document the residual race. This is a release blocker until the owner selects semantics.

### C-06 — Separate operation status from external-effect state

The current status set IN_PROGRESS, UNKNOWN, SUCCEEDED, FAILED is insufficient unless FAILED is precisely constrained.

Required semantics:
- SUCCEEDED: PR creation is confirmed by a unique, exact GitHub witness and all required phase records are complete.
- FAILED_NO_EFFECT: definitive evidence shows no external side effect occurred.
- PARTIAL_ORPHAN: one or more GitHub objects/refs exist, but the operation cannot safely continue or complete.
- UNKNOWN: the external effect cannot be determined uniquely.
- IN_PROGRESS: a valid current lease and known phase permit progress.

If the owner insists on retaining only four status labels, add a mandatory external_effect_state enum and prohibit FAILED whenever any external object/ref/PR may exist. Do not collapse partial artifacts into FAILED.

### C-07 — Define crash and dispatch semantics

The durable *_DISPATCHED transition occurs before network I/O. A crash immediately after that commit but before sending the HTTP request produces an UNKNOWN phase even though GitHub may have received nothing. This is an intentional safety/liveness trade-off, not an implementation bug.

Specify:
- dispatch_attempt_id format and uniqueness;
- exact persisted payload digest and target endpoint;
- transition from *_DISPATCHED to UNKNOWN on process termination/timeout;
- which phases may be reissued and only under what evidence;
- how a worker that returns after lease loss is prevented from changing local state;
- that a lease fence cannot cancel an HTTP request already in flight;
- no new dispatch for ref/PR solely because a GET returned 404 once.

For deterministic object phases, any re-POST must use byte-identical payload and must be justified by R2. The dispatch attempt record must distinguish original attempt from a permitted same-payload retry.

### C-08 — Lease protocol requires expiry and recovery rules

CAS on operation_id, previous_phase, lease_holder, lease_generation is a useful start, but define lease_expires_at, renewal policy, holder identity, maximum lease duration, takeover conditions, and generation increment. A stale generation must never write a phase result.

Use a logical monotonic revision/sequence for ordering. Date.now() inside the DO may be used as the server-side wall-clock source for audit and lease evaluation, but it is not a monotonic clock guarantee. Define conservative handling of clock jumps and boundary equality (now >= expires_at).

### C-09 — Clarify the Durable Object transaction model

transactionSync is available only for SQLite-backed Durable Objects and its callback must be synchronous; it cannot contain await, network calls, or cross-DO operations. The contract must state that WriteControl uses a SQLite-backed DO and that admission’s atomic transaction covers only WriteControl-local data: idempotency, reservation/quota counters, operation record, decision snapshot, and audit append.

TenantDirectory reads occur outside that transaction. They cannot be represented as part of one cross-DO atomic admission. The sequence and race semantics must be explicit.

### C-10 — Single-DO v1 requires capacity and failure-domain evidence

“One logical DO” must mean one explicitly identified global WriteControl singleton if it owns tenant/principal/repository/global quotas. Otherwise global quota cannot be enforced by independent shards.

Before implementation approval, provide:
- measured peak request and transaction rate;
- p50/p95/p99 transaction latency under concurrent admissions;
- maximum active operations and UNKNOWN records;
- maximum audit growth and retention storage;
- recovery/reconciliation load;
- free-plan storage and CPU constraints;
- outage/blast-radius analysis and tested backup/restore.

Cloudflare documents a soft limit of approximately 1,000 requests/second per individual DO and 1 GB SQLite storage on Workers Free versus 10 GB on Paid. These are platform ceilings/context, not an application capacity guarantee. A single global DO is a deliberate serialization and availability bottleneck.

### C-11 — Define quota accounting lifecycle

For each quota dimension, define whether it is concurrency, rate, or retained-record capacity. Define atomic reserve, consume, release, and decrement rules for:
- admission rejected before dispatch;
- operation succeeded;
- FAILED_NO_EFFECT;
- UNKNOWN;
- PARTIAL_ORPHAN;
- terminal retention expiry.

UNKNOWN must count against the dedicated UNKNOWN cap until resolved or explicitly administratively dispositioned. Missing any required quota setting closes admission. Define whether configuration changes are versioned and how a lower ceiling behaves when current usage is already above it.

### C-12 — Reconciliation needs a stronger witness and least privilege

A marker is a correlation field, not proof of authorship or integrity. Commit messages and PR bodies can be edited or copied. Reconciliation MUST combine:
- repository numeric ID and canonical owner/repo;
- exact base branch and head ref;
- expected commit SHA and parent SHA;
- expected tree SHA and exact tree entries/content digests;
- exact commit trailer marker and request_digest;
- exact PR head/base, body marker, state, and PR number;
- pagination across all result pages;
- observed GitHub API request IDs, timestamps, and raw response digest.

Any mismatch, multiple match, mutable field inconsistency, or insufficient evidence remains UNKNOWN/DISPUTED. Use a read-only GitHub credential for reconciliation if feasible; do not let a nominally read-only code path rely on a write-capable credential without documenting that residual privilege.

### C-13 — Audit append must be atomic with state transitions

For each state transition, the state update and corresponding audit event/hash append MUST commit in the same WriteControl-local transaction. Define canonical audit serialization, schema version, hash algorithm, sequence number, and exact fields covered by event_hash. If audit append fails, the state transition rolls back. The chain is tamper-evident only within the stored chain; do not call it tamper-proof. External anchoring remains a separate future control.

### C-14 — Retention needs an exact tombstone model

After the idempotency window, retain a scoped tombstone keyed by the scoped operation-key fingerprint and containing the request_digest fingerprint, expiry metadata, and audit linkage. It must be sufficient to return IDEMPOTENCY_EXPIRED without storing the raw client key or allowing the same key to execute again.

Define whether the audit window begins at admission, terminal completion, or last state transition. UNKNOWN and PARTIAL_ORPHAN must not be pruned. Define tombstone retention beyond audit expiry and legal deletion rules.

### C-15 — Error taxonomy and phase outcome classification

Add explicit outcomes for:
- GITHUB_REJECTED_NO_EFFECT (only when endpoint response semantics establish no effect);
- GITHUB_RESPONSE_AMBIGUOUS;
- PARTIAL_EXTERNAL_EFFECT;
- POLICY_VERSION_CHANGED / MEMBERSHIP_VERSION_CHANGED;
- LEASE_EXPIRED;
- AUDIT_WRITE_FAILED;
- RECONCILE_NOT_AUTHORIZED;
- RECONCILE_EVIDENCE_STALE;
- WRITE_CONTROL_UNAVAILABLE.

Do not map generic 4xx/5xx, transport errors, rate limits, or malformed responses to FAILED automatically. Classification must be endpoint-specific and backed by documented response semantics.

## 3. R2 experiment — independent review

### 3.1 What the current script can observe

- E1: whether two identical tree POSTs return the same tree SHA in one trial.
- E2: whether two identical commit POSTs with fixed author/committer dates return the same commit SHA in one trial.
- E3: the response from creating the same ref twice.
- E4: the response from creating the same PR twice.
- E5: a basic ref GET and a count of PRs returned by the head filter.

This is exploratory only. One run cannot establish a general retry guarantee.

### 3.2 Script defects

1. api() { gh api "$@" 2>&1 || true; } suppresses every nonzero exit code. It conflates expected duplicate conflicts with 401/403, rate limits, 5xx, transport failures, and CLI errors.
2. E3/E4 record concatenated text rather than structured status, response body, request ID, and exit code.
3. E5 only counts PRs; it does not verify exact head SHA, base branch, body marker, commit marker, request digest, PR state, or pagination completeness.
4. The branch suffix uses second-resolution time only; collisions are possible. The marker r2-test is constant and cannot uniquely identify a run.
5. The script does not enforce that the target repository is disposable. The comment is not a safety control.
6. It does not preflight that the branch name is unused, that the base exists, or that the test path is unique.
7. It does not record gh version, API version, repository ID, base SHA, timestamps, or GitHub request IDs.
8. It does not test the critical ambiguous-response case (server accepted the request but client did not receive the response).
9. It does not repeat the experiment enough times or vary input cases to support a robust deterministic claim.
10. Duplicate PR creation is a real write and the official GitHub endpoint documentation warns that PR creation triggers notifications and can cause secondary rate limiting. Keep this restricted to an explicitly disposable repository.

### 3.3 R2 interpretation rules

- E1/E2 equal SHAs demonstrate identical returned object identity for the tested payloads only. They do not, by themselves, prove an endpoint-level exactly-once guarantee or that all future payloads behave identically.
- Git tree and commit objects are content-addressed Git objects. Distinguish object determinism from HTTP request idempotency and from safe recovery after a lost response.
- E3 duplicate-ref response is expected to be a conflict/validation outcome; the decisive evidence is a subsequent GET showing the ref points to the exact expected commit. A single 404 is not sufficient proof that the first request never took effect.
- E4 duplicate-PR response must be followed by a fully paginated exact query. A count alone is insufficient. The PR endpoint may trigger notifications; do not repeat outside a throwaway repo.
- D-04 MUST remain UNVERIFIED until E1/E2 have repeated independent trials and the lost-response/recovery behaviour is separately examined. No test result can establish Exactly-Once.

### 3.4 Required R2.1 safety and evidence controls

Before any write:
- require R2_APPLY=yes AND a second explicit confirmation string that exactly matches R2_REPO;
- require the operator to attest the repository is disposable and owned/authorized;
- validate R2_REPO syntax, R2_BASE, required gh and jq, authenticated identity, repository metadata, and base ref;
- use a high-entropy unique run ID in branch, file path, commit trailer, PR body, and output filename;
- use a unique probe path; never overwrite a pre-existing path;
- record repository ID, base SHA, gh version, API version, start/end times, response exit code, HTTP status, GitHub request ID, and response-body digest;
- never swallow errors; expected API conflicts must be explicitly classified, all other errors remain separate;
- verify ref target and full PR fields using paginated GET;
- preserve raw evidence safely; redact credentials and never print environment variables;
- manual cleanup only after evidence review; no automatic branch/ref/PR deletion.

Add a separate fault-injection experiment for the accepted-write/lost-response case. If no safe fault-injection harness is available, mark that test NOT RUN and do not claim D-04 closes that failure mode.

### 3.5 Endpoint reference evidence

Official GitHub REST documentation lists:
- Create tree: 201 success; 403/404/409/422 errors.
- Create commit: 201 success; 404/409/422 errors; author and committer dates are explicit request fields.
- Create ref: 201 success; 409 conflict; 422 validation/spam.
- Create pull request: endpoint triggers notifications and may incur secondary rate limits.

These documented statuses are not proof of the behaviour of every ambiguous network failure. R2 must capture actual responses and subsequent GET evidence.

## 4. Proposed normative additions before v2 freeze

Add the following requirements:
1. A versioned canonical encoding specification for operation_key, request_digest, phase payload digests, and audit event hashes.
2. A bounded and explicit authorization-ticket/revocation consistency model.
3. A status model that distinguishes no-effect failure from partial external artifacts.
4. A formal dispatch crash-window and retry policy for every phase.
5. A SQLite-backed DO transaction profile and explicit global singleton identity.
6. Lease expiry, renewal, takeover, clock-jump, and stale-worker rules.
7. Quota accounting lifecycle and capacity test plan.
8. Exact reconciliation witness schema, pagination, and read-only credential profile.
9. Atomic audit/state writes and exact tombstone retention.
10. R2.1 protocol and machine-readable acceptance criteria.

## 5. Gate decision

| Gate | Status |
|---|---|
| High-level ownership separation | PARTIAL PASS |
| Idempotency byte-level specification | BLOCKED |
| Authorization/revocation race | BLOCKED |
| State and partial-effect semantics | BLOCKED |
| Dispatch/lease/recovery protocol | BLOCKED |
| Quota and single-DO capacity | BLOCKED |
| Audit/retention completeness | PARTIAL / BLOCKED |
| R2 script safety | FAIL — corrections required |
| R2 evidence sufficiency | NOT RUN / INSUFFICIENT |
| D-04 | UNVERIFIED |
| Implementation | NOT AUTHORIZED |
| Release/deploy | NOT AUTHORIZED |

## 6. Scope and non-actions

This review did not execute the supplied script, contact GitHub write endpoints, create a branch, commit, tree, or pull request in any repository, alter a repository, change Cloudflare/Supabase, modify secrets, or deploy code. No implementation or tests were run. The supplied script remains a draft and must not be run against the production repository.

## 7. Sources

- GitHub REST API — Git trees: https://docs.github.com/en/rest/git/trees
- GitHub REST API — Git commits: https://docs.github.com/en/rest/git/commits
- GitHub REST API — Git references: https://docs.github.com/en/rest/git/refs
- GitHub REST API — Pull requests: https://docs.github.com/en/rest/pulls/pulls
- Cloudflare Durable Objects — SQLite storage and transactionSync: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Cloudflare Durable Objects — rules and single-object architecture: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Cloudflare Durable Objects — storage access and consistency: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- Cloudflare Durable Objects — FAQ and per-object limits: https://developers.cloudflare.com/durable-objects/reference/faq/

---
This document is an independent review and correction proposal. It does not supersede the user's draft, does not amend D-01..D-14, and does not grant implementation or write-experiment authorization.
