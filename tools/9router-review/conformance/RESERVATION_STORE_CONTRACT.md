# Production ReservationStore Contract

## Status and decision

**Provider-neutral design contract only.** No backend is selected, implemented, provisioned, or deployed by this document. The reference adapter remains an in-memory conformance oracle and is not a production implementation.

The immediate objective is to make duplicate suppression and attempt authorization depend on a durable, linearizable reservation authority invoked before model inference. Workflow concurrency, process-local locks, read-before-write comment scans, and deterministic markers are defense-in-depth or reconciliation mechanisms; none is the reservation authority.

## 1. Identity and trust boundary

The immutable reservation key is the complete tuple:

`(repository_id, pull_request_number, head_sha, base_sha)`

Requirements:

- `repository_id` is the immutable numeric GitHub repository ID from a trusted configuration boundary, not a caller-selected owner/name string.
- Before deriving the key, fetch the live PR and verify that base and head repository IDs both equal the trusted repository ID; verify the canonical full name against the trusted repository identity; reject cross-repository PRs.
- Validate PR number as a positive safe integer and both SHAs as canonical 40-character hexadecimal values.
- Canonicalize the tuple with a versioned, unambiguous encoding (fixed field order, explicit lengths/types, normalized lowercase SHAs); hash it with SHA-256. Never concatenate unescaped strings.
- Persist both the digest and the full canonical tuple. If a digest maps to a different tuple, return `INTEGRITY_CONFLICT`; do not merge identities.
- Policy/runtime digests are immutable attributes of a reservation attempt, not substitutes for the identity tuple. A policy/runtime mismatch must fail closed or require a separately versioned reservation according to explicit policy; it must never silently reuse a prior authorization.
- A changed head or base SHA is a different reservation key. Evidence for one snapshot never authorizes another.

## 2. Required abstract interface

The production adapter exposes typed operations. All writes are idempotent by operation ID and exact canonical request digest. Repeating an operation ID with identical canonical input returns the original result; reusing it with different input returns `INTEGRITY_CONFLICT`.

```ts
type Stage = "MODEL" | "COMMENT";

type ReservationKey = {
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
};

type OwnerFence = {
  ownerId: string;       // opaque, unguessable; never caller-selected authority
  generation: number;   // monotonically increasing fencing generation
  recordVersion: number;
};

type ReservationState =
  | "UNCLAIMED" | "CLAIMED" | "MODEL_ATTEMPTED" | "MODEL_COMPLETED"
  | "COMMENT_ATTEMPTED" | "PUBLISHED" | "UNKNOWN" | "EXPIRED"
  | "ABORTED" | "CLOSED_NO_PUBLISH" | "DUPLICATE_ACCEPTED";

type ReservationRecord = {
  key: ReservationKey;
  keyDigest: string;
  state: ReservationState;
  generation: number;
  recordVersion: number;
  ownerId: string | null;
  leaseExpiresAt: string | null; // backend-authoritative UTC
  policyDigest: string;
  runtimeDigest: string;
  modelAttemptId: string | null;
  commentAttemptId: string | null;
  modelBoundaryReceipt: AttemptBoundaryReceipt | null;
  commentBoundaryReceipt: AttemptBoundaryReceipt | null;
  createdAt: string;
  updatedAt: string;
};

type EffectLedgerIntentAck = {
  attemptId: string;
  stage: Stage;
  reservationKeyDigest: string;
  requestDigest: string;
  eventId: string;
  durableWatermark: string;
  acknowledgementDigest: string;
};

type EffectLedgerOutcomeAck = {
  attemptId: string;
  stage: Stage;
  reservationKeyDigest: string;
  boundaryReceiptDigest: string;
  outcomeDigest: string;
  durableWatermark: string;
  acknowledgementDigest: string;
};

type StoreResult<T> =
  | { status: "ACK"; value: T }
  | { status: "ALREADY_CONSUMED"; value?: T }
  | { status: "BUSY"; retryAfter?: string }
  | { status: "FENCED" }
  | { status: "INTEGRITY_CONFLICT"; reason: string }
  | { status: "INVALID_TRANSITION"; reason: string }
  | { status: "NOT_FOUND" }
  | { status: "UNKNOWN"; reason: string }
  | { status: "RECOVERY_LOCKED" };

interface ReservationStore {
  claim(input: {
    key: ReservationKey;
    operationId: string;
    policyDigest: string;
    runtimeDigest: string;
    callerIdentity: string;
    requestedLeaseMs: number;
  }): Promise<StoreResult<{
    fence: OwnerFence;
    leaseExpiresAt: string;
    state: "CLAIMED";
    recordVersion: number;
  }>>;

  renew(input: {
    key: ReservationKey;
    operationId: string;
    fence: OwnerFence;
    expectedRecordVersion: number;
    requestedLeaseMs: number;
  }): Promise<StoreResult<{ fence: OwnerFence; leaseExpiresAt: string; recordVersion: number }>>;

  beginModelAttempt(input: {
    key: ReservationKey;
    operationId: string;
    attemptId: string;
    requestDigest: string;
    fence: OwnerFence;
    expectedRecordVersion: number;
    effectLedgerIntentAck: EffectLedgerIntentAck;
  }): Promise<StoreResult<{
    fence: OwnerFence;
    attemptBoundaryReceipt: AttemptBoundaryReceipt;
    committedRecordVersion: number;
  }>>;

  beginCommentAttempt(input: {
    key: ReservationKey;
    operationId: string;
    attemptId: string;
    requestDigest: string;
    fence: OwnerFence;
    expectedRecordVersion: number;
    modelAttemptId: string;
    effectLedgerIntentAck: EffectLedgerIntentAck;
    exactSnapshotValidationDigest: string;
  }): Promise<StoreResult<{
    fence: OwnerFence;
    attemptBoundaryReceipt: AttemptBoundaryReceipt;
    committedRecordVersion: number;
  }>>;

  readAttemptBoundaryReceipt(input: {
    key: ReservationKey;
    stage: Stage;
    attemptId: string;
  }): Promise<StoreResult<{ attemptBoundaryReceipt: AttemptBoundaryReceipt }>>;

  completeModelAttempt(input: {
    key: ReservationKey;
    operationId: string;
    attemptId: string;
    fence: OwnerFence;
    expectedRecordVersion: number;
    attemptBoundaryReceipt: AttemptBoundaryReceipt;
    effectLedgerOutcomeAck: EffectLedgerOutcomeAck;
    modelEvidenceDigest: string;
    evidenceReference: string;
  }): Promise<StoreResult<{ fence: OwnerFence; recordVersion: number; state: "MODEL_COMPLETED" }>>;

  completeCommentAttempt(input: {
    key: ReservationKey;
    operationId: string;
    attemptId: string;
    fence: OwnerFence;
    expectedRecordVersion: number;
    attemptBoundaryReceipt: AttemptBoundaryReceipt;
    effectLedgerOutcomeAck: EffectLedgerOutcomeAck;
    publicationEvidenceDigest: string;
    remoteCommentId: number;
    evidenceReference: string;
  }): Promise<StoreResult<{ recordVersion: number; state: "PUBLISHED" }>>;

  resumeCompletedModel(input: {
    key: ReservationKey;
    operationId: string;
    modelAttemptId: string;
    expectedRecordVersion: number;
    continuationIdentity: string;
  }): Promise<StoreResult<{ fence: OwnerFence; recordVersion: number }>>;

  abortBeforeModel(input: {
    key: ReservationKey;
    operationId: string;
    fence: OwnerFence;
    expectedRecordVersion: number;
    reasonDigest: string;
  }): Promise<StoreResult<{ recordVersion: number; state: "ABORTED" }>>;

  markUnknown(input: {
    key: ReservationKey;
    operationId: string;
    stage: Stage;
    attemptId: string;
    expectedRecordVersion: number;
    reasonCode: string;
    evidenceReference: string;
  }): Promise<StoreResult<{ recordVersion: number; state: "UNKNOWN" }>>;

  closeWithoutPublish(input: {
    key: ReservationKey;
    operationId: string;
    expectedRecordVersion: number;
    reasonDigest: string;
    evidenceReference: string;
  }): Promise<StoreResult<{ recordVersion: number; state: "CLOSED_NO_PUBLISH" }>>;

  reconcileComment(input: {
    key: ReservationKey;
    operationId: string;
    attemptId: string;
    expectedRecordVersion: number;
    listingCompleteness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
    exactMarkerCommentIds: number[];
    evidenceDigest: string;
    evidenceReference: string;
  }): Promise<StoreResult<{
    recordVersion: number;
    state: "PUBLISHED" | "DUPLICATE_ACCEPTED" | "UNKNOWN";
  }>>;

  read(input: {
    key: ReservationKey;
    consistency: "AUTHORITATIVE";
  }): Promise<StoreResult<{ record: ReservationRecord }>>;
}
```

The method signatures are an abstract design target, not a frozen implementation API. Before coding, reconcile them against the existing `OPERATIONS.md` transition table and the executable conformance harness. In particular, recovery-only mutations must use a separately authenticated recovery authority; they must not accept a caller-supplied owner fence as proof of recovery privilege. `completeModelAttempt` and `completeCommentAttempt` must validate the exact persisted boundary receipt and durable EffectLedger OUTCOME acknowledgement before changing state. `markUnknown` and `reconcileComment` must be idempotent and must not mint new attempt permits.


## 3. Atomicity and state-transition requirements

### Claim arbitration

- A unique constraint or equivalent linearizable arbitration must enforce at most one live owner for a reservation key.
- Claim creation is one atomic operation. Two independent clients racing on an absent key must produce at most one `ACK/CLAIMED`; all others observe `BUSY`, `ALREADY_CONSUMED`, or a typed conflict.
- Lease expiry is evaluated using authoritative backend time, never caller time.
- A takeover may increment the fencing generation only while the record proves that no external-effect attempt boundary was consumed. A stale owner must fail every subsequent mutation.
- Lease expiry after a MODEL or COMMENT attempt does not authorize another attempt. It leads to recovery/reconciliation or `UNKNOWN`, not an automatic retry.
- The full tuple, policy/runtime digests, state, owner, generation, version, and audit event must be committed atomically.

### Attempt boundary and receipt

- The effect ledger first durably acknowledges the immutable stage-specific INTENT.
- The reservation authority validates the exact INTENT acknowledgement, owner fence, lease, expected version, stage, attempt ID, request digest, and current state.
- In one linearizable transaction, it consumes the one-time attempt, increments record version, persists the boundary event and canonical receipt payload, and returns the receipt only after durable acknowledgement.
- The receipt contract is defined in `ATTEMPT_BOUNDARY_RECEIPT_CONTRACT.md`. Receipt issuance and record transition must not be separate writes.
- A lost response after commit is resolved only by read-only `readAttemptBoundaryReceipt`, which returns the exact persisted receipt. It must not mint another receipt or permit.
- No model/provider request or GitHub comment POST may occur before the exact attempt-boundary receipt is received or positively recovered and independently verified.
- The EffectLedger independently verifies the receipt and binds its OUTCOME to the exact INTENT, key digest, stage, attempt ID, request digest, generation, record version, authority, and signing key.
- Missing, invalid, stale, cross-key, cross-stage, cross-attempt, or replayed receipts are rejected before any ledger sequence/watermark mutation.

### Cross-store protocol

The ReservationStore and EffectLedger are separate authorities unless a candidate explicitly proves a single atomic transaction across both. Do not imply a distributed transaction where none exists.

Required ordering:

1. Append immutable EffectLedger INTENT; require durable ACK.
2. Commit the one-time ReservationStore attempt boundary; require durable ACK and receipt.
3. Verify the receipt and INTENT binding.
4. Perform exactly one external attempt.
5. Append immutable EffectLedger OUTCOME bound to the receipt and external evidence; require durable ACK.
6. Commit the corresponding reservation state transition using the same attempt identity and a fresh fencing/version check.

If any boundary acknowledgement is ambiguous, do not perform the external effect. Recover from authoritative state. If the external effect may have occurred, set stage-specific `UNKNOWN`; do not create a new attempt. An OUTCOME append and reservation-state transition cannot be assumed atomic across stores. Recovery must reconcile their durable evidence without guessing.

The write-ahead ledger must have append-only semantics, unique attempt IDs, immutable payloads, durable acknowledgements, complete inventory, and an independently verifiable recovery anchor. If those properties are unavailable, the system remains quarantined.

## 4. State and retry rules

The implementation must preserve the existing state machine and distinguish at least:

- `UNCLAIMED`
- `CLAIMED`
- `MODEL_ATTEMPTED`
- `MODEL_COMPLETED`
- `COMMENT_ATTEMPTED`
- `PUBLISHED`
- `UNKNOWN`
- `EXPIRED`
- `ABORTED`
- `CLOSED_NO_PUBLISH`
- `DUPLICATE_ACCEPTED`
- global `RECOVERY_LOCKED`

Rules:

- MODEL attempt is single-use. A timeout, lost response, process crash, or uncertain provider response becomes MODEL-stage `UNKNOWN`; it is not retried.
- COMMENT attempt is single-use. A timeout, redirect, dropped connection, or uncertain GitHub response becomes COMMENT-stage `UNKNOWN`; it is not retried.
- COMMENT-stage `UNKNOWN` can resolve to `PUBLISHED` only with positive, exact-marker evidence tied to the reservation key and attempt. Two or more distinct exact valid markers resolve to `DUPLICATE_ACCEPTED`.
- A complete authoritative listing with zero exact markers may support a policy-defined no-publication conclusion only if the listing completeness and consistency are positively established. An incomplete, stale, paginated, rate-limited, or unavailable listing never proves absence.
- A previously published exact snapshot must short-circuit before model inference. A changed snapshot is a different key and requires its own claim and review.
- `RECOVERY_LOCKED` blocks every external-effect permit and ordinary mutation. Unlock requires complete independent inventory and a monotonic trusted recovery anchor; restoring an old reservation snapshot without the independent ledger must not silently reopen attempts.

## 5. Integration point in `runReview()`

The current source path has no ReservationStore integration. The required future ordering is:

1. Validate configuration and trusted repository identity.
2. Fetch the live PR and verify repository IDs, open/draft/lock state, head SHA, and base SHA.
3. Derive the canonical immutable reservation key from that verified snapshot.
4. Call `claim()` before patch retrieval and before model inference. If not `ACK/CLAIMED`, return/stop according to the typed result; never fall through to model inference.
5. Perform complete marker reconciliation under the claim. Positive prior publication short-circuits; incomplete negative evidence fails closed.
6. Build the immutable patch and revalidate the same live snapshot.
7. Append MODEL INTENT, commit MODEL attempt boundary, verify/recover its receipt, then invoke the model exactly once.
8. Persist model outcome and reservation transition; only a continuation owner with a valid fence may proceed.
9. Revalidate the exact live PR snapshot; append COMMENT INTENT, commit COMMENT attempt boundary, verify receipt, then issue one non-redirecting GitHub POST.
10. Persist positive publication evidence and reconcile ambiguous responses without retrying the POST.
11. Release/close only through a typed terminal transition; preserve audit history.

This sequence is a target integration contract, not a claim about current `runReview()`. A future implementation must be split into small test-first commits and preserve the current reviewer-disabled guard.

## 6. Candidate evaluation (evidence-based, not selection)

### Candidate A — Cloudflare SQLite-backed Durable Objects

**Documented strengths**

- Each Durable Object has private, transactional, strongly consistent storage; SQLite-backed storage supports SQL and PITR.
- A storage method is transactionally isolated; `transactionSync` provides a synchronous transaction and rolls back if the callback throws.
- A deterministic object identity derived from the canonical reservation-key digest can route all contenders for one key to the same object. The object must still persist and compare the complete tuple to detect digest aliasing.
- SQLite-backed DO PITR can restore the embedded database to a point in the previous 30 days.

**Required hostile checks / limitations**

- Prove that every claim/renew/attempt/receipt operation for one key is routed to exactly one deterministic DO identity, and test independent clients and concurrent requests.
- Prove SQL uniqueness, compare-and-swap/version predicates, fencing generation, transaction rollback, and response-loss recovery under process/isolate restart.
- A DO's private storage is not a global cross-object transaction. Cross-key recovery inventory and the EffectLedger remain separate concerns.
- PITR can roll reservation state backward. Restore must trigger global `RECOVERY_LOCKED` until compared with an independent complete journal and monotonic recovery anchor.
- An R2 ledger in the same Cloudflare account is a separate storage/rollback surface, not a separate vendor/account failure domain. Account compromise, administrative access, and shared control-plane failure remain correlated.
- R2 conditional `If-None-Match: *` writes serialize competing creates while the object exists, but a deleted object can be created again. A 404 HEAD during an in-flight write does not prove the write failed. Use immutable unique write IDs and reconcile ambiguous writes; never treat R2 as a transactional replacement for the reservation state machine.
- Current documented Free SQLite DO storage allowance is 5 GB per account; the exact account billing state, usage, and effective limits are not inspected here. No free-tier affordability or no-card eligibility is claimed.

**Disposition:** strongest current fit for a low-latency single-key transactional authority, but only a candidate. Not selected or deployed.

### Candidate B — Supabase PostgreSQL

**Documented strengths**

- PostgreSQL supports unique constraints, row locking, transactional updates, and conditional state transitions suitable for an atomic claim/CAS implementation.
- Supavisor transaction pooling is designed for serverless/edge workloads; transaction-scoped logic can be executed inside one database transaction.

**Required hostile checks / limitations**

- Implement claim with a unique key constraint and a single database transaction using a row lock or serializable/CAS update; verify the SQL isolation level and retry only serialization aborts before any external attempt boundary.
- Use database server time for lease evaluation; never accept caller timestamps as authoritative.
- Test the actual runtime driver and transaction-pooler mode. Transaction mode does not preserve session state between transactions; prepared statements and session-level advisory locks have documented limitations. Do not base correctness on session-level locks.
- A Free project may pause after seven days of low activity and does not include automatic backups or PITR. Supabase recommends manual off-site exports for Free projects. This is not sufficient as the sole production reservation authority without an independently verified backup/restore and recovery process.
- A Postgres table used as both ReservationStore and EffectLedger in one project may provide a single local transaction but does not provide independent failure-domain evidence. If a separate ledger is required, explicitly model the cross-store protocol above.
- Account plan, payment method, project activity, backup configuration, network compatibility, driver behavior, and restore drill results are not inspected here.

**Disposition:** viable transactional database candidate, but the currently documented Free-plan pause/backup properties make it unsuitable as the sole production authority under the project's no-card/low-cost constraint. Not selected or deployed.

### R2 as an independent ledger candidate

R2 conditional writes are useful for immutable create-once event objects and write-ID reconciliation. They do not provide a multi-object transaction or a global atomic append sequence. If used for EffectLedger, the implementation must prove unique immutable event creation, conditional watermark/manifest advancement, complete inventory, retention/lock policy, and crash recovery. Bucket-lock administrative controls and same-account failure correlation remain explicit risks. R2 is not a ReservationStore candidate in this decision.

## 7. Backend qualification gates

No candidate may be selected until all gates below have reproducible evidence:

1. **Identity:** canonical tuple, trusted repository-ID validation, collision/alias rejection.
2. **Concurrency:** at least 100 independent clients/processes race the same absent key; exactly one claim wins; no split-brain ownership.
3. **Fencing:** stale owner, expired lease, delayed request, duplicate operation ID, and generation rollback are rejected.
4. **Atomic boundary:** receipt and attempt transition commit together; injected commit/ack loss recovers the same receipt and never issues a second permit.
5. **Ledger binding:** valid receipt accepted; missing/mutated/cross-key/cross-stage/cross-attempt/replayed receipt rejected with unchanged sequence and watermark.
6. **Crash matrix:** kill process/isolate before, during, and after each durable write and external effect; restart and prove the prescribed state.
7. **Ambiguous POST:** simulate timeout after remote commit, delayed listing, incomplete pagination, duplicate markers, and stale reads; no second POST is issued.
8. **Restore/rollback:** restore reservation state to an earlier point while preserving the independent ledger; system remains locked until inventory and monotonic anchor reconcile.
9. **Security:** least-privilege runtime identity, separate admin identity, key rotation/revocation, no credential exposure in logs, audit retention, and vendor/account failure-domain analysis.
10. **Cost/availability:** verify actual free-tier quotas, account billing/card requirements, hard limits, pause/eviction behavior, throttling, outage behavior, and an explicit fail-closed cost ceiling.
11. **Integration:** `runReview()` claims before patch/model work; no provider or comment effect without a valid boundary receipt; reviewer remains disabled until separately approved.
12. **Independent review:** hostile review of implementation, schema, threat model, migration, rollback, and test evidence by a reviewer independent of the author.

A backend is `UNKNOWN` until the relevant gate has direct evidence. Documentation claims alone do not satisfy runtime qualification.

## 8. Required fault-injection conformance cases

| ID | Fault / adversarial schedule | Required result |
|---|---|---|
| RS-01 | Two independent clients claim the same absent key | Exactly one claim ACK |
| RS-02 | Same digest presented with a different full tuple | INTEGRITY_CONFLICT; no mutation |
| RS-03 | Stale owner writes after lease takeover | FENCED; no mutation |
| RS-04 | Lease expires before any attempt boundary | Safe takeover with higher generation |
| RS-05 | Lease expires after MODEL boundary | No second MODEL permit |
| RS-06 | Boundary commits but response is dropped | Read-only recovery returns exact same receipt |
| RS-07 | Boundary transaction aborts | No receipt; no external effect |
| RS-08 | Crash between ledger INTENT and reservation boundary | No external effect; reconcile INTENT |
| RS-09 | Crash after reservation boundary ACK, before model call | Same receipt recoverable; policy decides continuation, never new attempt |
| RS-10 | Crash after provider call, before OUTCOME ACK | MODEL UNKNOWN; no model retry |
| RS-11 | Crash after COMMENT boundary, before POST | No second COMMENT permit; reconcile safely |
| RS-12 | GitHub accepts POST but client loses response | COMMENT UNKNOWN; no second POST |
| RS-13 | Marker listing incomplete with zero matches | UNKNOWN; absence not inferred |
| RS-14 | Two distinct exact valid markers found | DUPLICATE_ACCEPTED |
| RS-15 | Reservation database restored behind ledger watermark | RECOVERY_LOCKED |
| RS-16 | Ledger unavailable or incomplete | No permit; RECOVERY_LOCKED/UNKNOWN |
| RS-17 | Signing key revoked or authority identity changed | Receipt rejected; no ledger mutation |
| RS-18 | Provider quota or backend rate limit exhausted | Fail closed before external effect |
| RS-19 | Delayed stale request arrives after generation increment | Fencing rejects it |
| RS-20 | Identical operation ID and payload retried | Original result returned, no duplicate event |
| RS-21 | Same operation ID with different payload | INTEGRITY_CONFLICT |
| RS-22 | Cross-vendor outage or partial restore | No inferred success; quarantine until reconciled |

## 9. Non-goals and explicit prohibitions

- No exactly-once claim for a remote model provider or GitHub comment API.
- No claim that workflow `concurrency` serializes every external actor or replaces durable arbitration.
- No process-local mutex as the correctness authority.
- No automatic retry of MODEL_ATTEMPTED, COMMENT_ATTEMPTED, or stage-specific UNKNOWN.
- No fallback from unavailable durable storage to in-memory state, read-only preflight, or optimistic publication.
- No silent repair of corrupt or incomplete state.
- No provider selection, resource creation, secret change, deployment, workflow registration, reviewer activation, PR merge, or local-host change as part of this design step.

## 10. Source references

Official vendor documentation reviewed on 2026-11-25:

- Cloudflare SQLite-backed Durable Object Storage: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Cloudflare Durable Objects access/storage guidance: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- Cloudflare Durable Objects limits: https://developers.cloudflare.com/durable-objects/platform/limits/
- Cloudflare R2 conditional operations: https://developers.cloudflare.com/r2/api/s3/conditional-operations/
- Cloudflare R2 consistency model: https://developers.cloudflare.com/r2/reference/consistency/
- Cloudflare R2 bucket locks: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- Supabase connection pooling and transaction-mode limitations: https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits
- Supabase Free project pausing: https://supabase.com/docs/guides/platform/free-project-pausing
- Supabase database backups: https://supabase.com/docs/guides/platform/backups
- Supabase pricing/plan limits: https://supabase.com/pricing

Vendor documentation establishes advertised platform behavior, not this project's configuration, billing state, deployed topology, or end-to-end correctness. Runtime qualification remains NOT RUN.
