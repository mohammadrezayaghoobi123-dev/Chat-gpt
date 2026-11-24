# Scheduler Assertion Request-Binding Audit

**Assessment date:** 2026-11-24  
**Audited source commit:** `43ba374fa1d7c26855a1343da53e3cedcf29afb2`  
**Related characterization:** PR #383  
**Change class:** Evidence-only; no runtime or policy change

## 1. Question

Does the current Scheduler assertion authorize one exact `createTask` request, or does it authorize the fixed principal to invoke that operation with any request accepted by the Ledger?

This audit follows the real-SQLite characterization in PR #383: a Task INSERT abort rolls back the consumed JTI; the same still-valid assertion can then be retried with a different Task projection.

## 2. Source facts

### 2.1 Assertion schema

In `cloud-engineering-connector/orchestrator-worker-identity.js`:

- `CLAIM_KEYS` is the exact set `aud, exp, iat, iss, jti, op, role, sub, v`.
- `validClaims` verifies issuer, audience, subject, role, operation, JTI syntax, and time bounds.
- The Scheduler policy permits only `orchestrator-scheduler / system / createTask`.
- `createScheduledWorkerAssertion` generates a random JTI and signs canonical claim JSON with HMAC-SHA-256.
- The verifier returns JTI, subject, role, operation, key ID, issued-at, and expiry metadata.

No claim binds the assertion to a Task ID, idempotency key, input digest, Task version, request ID, or validation-policy version.

### 2.2 Ledger request checks

In `cloud-engineering-connector/orchestrator-ledger.js`, `createTask`:

1. validates idempotency-key and input-hash syntax plus timestamp;
2. requires worker ID `orchestrator-scheduler`;
3. verifies the assertion for the fixed Scheduler subject, role, and operation;
4. validates and normalizes the Task projection;
5. enters one SQLite transaction;
6. consumes the assertion JTI;
7. checks persisted idempotency-key and Task-ID conflicts;
8. inserts the Task and synchronizes its Claim Candidate.

The method checks that `inputHash` has SHA-256 syntax. It does not independently recompute that digest from the normalized Task projection. The assertion verifier does not receive the request fields.

### 2.3 Confirmed protocol property

The signature establishes **who may call which operation**, but not **which exact request that signature authorizes**.

Database idempotency protects an already-persisted key from conflicting reuse. It cannot compare a request with a prior row when the earlier transaction rolled back before persistence. The PR #383 characterization demonstrated this at the Ledger boundary.

## 3. Falsifiable hypotheses

| Hypothesis | Evidence/test | Result |
|---|---|---|
| H1: Assertion is bound to a specific Task. | Exact claim allowlist and verifier inputs contain no Task/request digest or identifier. | **Rejected** |
| H2: Ledger recomputes `inputHash` from Task content. | `createTask` validates digest syntax but does not recompute it from normalized Task content. | **Rejected** |
| H3: Database idempotency prevents all changed-payload retries. | Real SQLite abort leaves no idempotency row; same assertion was accepted for a different Task and key. | **Rejected** |
| H4: Current in-repository Scheduler reuses one assertion across retries. | PR #383 source audit found no Scheduler signer call-site or `createTask` caller in Worker runtime. | **Unknown; not demonstrated** |
| H5: This is externally exploitable in deployed Production. | No live Worker/binding inspection or correlated runtime evidence was performed. | **Unknown** |

## 4. Security classification

- Missing request binding in the assertion schema: **Confirmed**.
- Changed-request retry after SQLite rollback at the Ledger boundary: **Confirmed by PR #383 characterization**.
- Current in-repository Scheduler runtime reachability: **Rejected by PR #383 source audit**.
- External runtime reachability and Production exploitability: **Unknown**.

Do not describe this as a demonstrated Production vulnerability or signing-key compromise.

## 5. Candidate protocol contract — proposal only

A future versioned Scheduler authorization should bind at least:

| Binding | Purpose |
|---|---|
| Fixed issuer, audience, subject, role, operation | Preserve principal and operation authorization |
| Unique JTI | One-time assertion identity |
| Request ID | Stable identity across retries |
| Task ID | Prevent cross-Task substitution |
| Idempotency key | Bind durable deduplication identity |
| Canonical request digest | Bind the complete semantic Task projection |
| Input/source digest | Bind source material and provenance |
| Schema/protocol version | Prevent interpretation drift |
| Issued-at and expiry | Bound replay window |

The canonical request digest must be recomputed by the Ledger from the validated, normalized request. It must not be accepted as an opaque caller-supplied digest. Canonicalization version and included fields must be explicit and deterministic.

The signed material must bind request ID, Task ID, idempotency key, recomputed request digest, source/input digest, and protocol version. The Ledger must compare every bound field against the actual request before durable mutation.

### 5.1 Retry semantics requiring an explicit decision

1. Same request ID and same digest: retry may recover the same logical result.
2. Same request ID and different digest: reject as an idempotency conflict.
3. Same JTI and different request binding: reject, including after a prior database abort.
4. New JTI, same request ID and digest: return/recover the same logical result; never create a second Task.
5. Expired assertion: require a newly issued assertion bound to the same immutable request identity.

A key unresolved choice is whether JTI consumption commits independently of Task persistence (at-most-once authorization) or a durable request-intent record is committed before Task creation (recoverable idempotent effect). Simply moving JTI consumption outside the Task transaction is not automatically correct: it can burn an assertion without creating a Task. The design must define recovery semantics rather than choosing transaction placement in isolation.

### 5.2 Transactional requirement

The eventual implementation should persist a durable request-intent/idempotency record with a uniqueness constraint and immutable request digest. Task creation, Claim Candidate creation, request state transition, and audit event must share a clearly defined linearization point.

If a multi-transaction protocol is selected, every intermediate state must be explicit, bounded, recoverable, and non-claimable. No partial intent may make a Task executable.

## 6. Required adversarial tests before implementation

Use real Durable Object storage and SQLite. Do not mock the transaction, assertion verifier, or persistence boundary.

| Scenario | Required result |
|---|---|
| Valid assertion + exact binding | At most one durable Task |
| Same assertion + changed Task ID | Reject before mutation |
| Same assertion + changed idempotency key | Reject before mutation |
| Same assertion + changed normalized Task digest | Reject before mutation |
| Same request ID + changed digest | Conflict; no second Task |
| Same request ID/digest + new JTI | Recover same logical result |
| Database abort before Task INSERT | Follow selected durable-intent recovery policy |
| Abort after Task INSERT but before Candidate creation | Atomic rollback or deterministic recovery; no orphan |
| Concurrent identical requests | One logical Task |
| Concurrent same request ID/different digests | At most one winner |
| Expired assertion retry | Reject old token; new token remains bound to same request |
| Removed request-binding comparison mutant | A focused test fails |
| Removed durable uniqueness mutant | A replay/concurrency test fails |

Tests must assert Task count, Claim Candidate count, request-intent state, JTI state, and returned result—not merely HTTP status or mock call counts.

## 7. Owner decisions required before implementation

1. Scheduler owner and trusted runtime location.
2. Key custody, signer isolation, verifier-key provisioning, and rotation.
3. Exact request identity fields and canonicalization version.
4. Retry guarantee: at-most-once authorization versus recoverable idempotent processing.
5. Durable request-intent record and its state machine.
6. Authority for reconciliation of incomplete intents.
7. Retention period for request IDs, digests, and consumed JTI records.

The repository does not provide enough evidence to choose these policy decisions on the owner's behalf.

## 8. Non-actions and safety boundary

This audit does not change assertion schema or signer policy; add a Scheduler runtime or caller; introduce a Validator or principal; change Task transitions, leases, Queues, routes, or MCP tools; modify Worker, Ledger, Wrangler, Cloudflare resources, or secrets; read/disclose secret values or fingerprints; merge, deploy, or modify `main`.

The next implementation step remains blocked on Section 7. Until then, keep the current runtime fail-closed.

## 9. Falsification conditions

Reopen this conclusion if evidence establishes that:
- the assertion is request-bound by a verified mechanism outside the inspected claim schema;
- a separate durable intent record already binds JTI to the exact normalized request before Task persistence;
- a trusted Scheduler runtime exists outside this repository and supplies immutable request-bound assertions; or
- deployment uses a verified independent signing boundary not represented in this source snapshot.

Any such evidence must identify exact source revision, runtime identity, and observable binding behavior.
