# Orchestrator A+B Executor Plane Design

**Status:** Proposed design for review  
**Date:** 2026-11-23  
**Repository baseline:** `mohammadrezayaghoobi123-dev/Chat-gpt`  
**Baseline commit:** `20ee4e2139ef8bebc1f17b50d49a0250619e0190`  
**Working branch:** `design/orchestrator-executor-ab-2026-11-23`

## 1. Goal

Connect the existing Claim Ledger to a real, bounded cloud execution path while combining:

- **A — Internal execution plane:** queue/scheduler-driven task claiming, cursor progression, leases, fencing, and execution.
- **B — MCP control plane:** authenticated job submission, status observation, and controlled cancellation or quarantine requests.

MCP must not claim tasks, mint executor assertions, choose executor identities, or directly mutate execution leases. The Ledger remains authoritative for task state and execution ownership.

## 2. Repository evidence and current boundary

The following facts were inspected at baseline commit `20ee4e2139ef8bebc1f17b50d49a0250619e0190`:

1. `cloud-engineering-connector/orchestrator-ledger.js` implements `claimTask({ workerId, workerAssertion, leaseMs, now, taskId, reconciliationEvidence, cursor })`. It requires a verified assertion bound to `subject: workerId`, `role: agent`, and `operation: claimTask`. Cursor tokens are opaque, one-use, executor-bound, and time-limited. Candidate scanning is bounded to 128 rows per call.
2. The Ledger's `createTask` path is restricted to the fixed `orchestrator-scheduler` principal with `role: system` and `operation: createTask`.
3. `cloud-engineering-connector/orchestrator-worker-identity.js` has an explicit fixed-principal signing policy. It currently allows the scheduler to create tasks and separate fixed principals to publish/consume outbox events. It does not authorize a fixed cloud executor to claim tasks.
4. `cloud-engineering-connector/worker.js` wires the scheduled handler to knowledge/orchestrator outbox publishing and wires the queue handler to outbox receipt/DLQ processing. No task-claim call was found in the inspected runtime entry points.
5. `cloud-engineering-connector/orchestrator-github-intake.js` explicitly returns `sideEffects: false` and `taskExecution: false`. It is a validated dry-run intake, not a task submission path.
6. Existing Queue configuration is for outbox and dead-letter traffic. It must not be repurposed as an execution queue.

These observations are limited to the inspected baseline and files; implementation must repeat repository-wide call-site and configuration searches on its actual parent SHA.

## 3. Proposed architecture

### 3.1 Control plane — MCP

Add a narrowly scoped MCP job-submission capability only after its caller-identity contract is approved.

The MCP layer may:
- Validate the request envelope and enforce the authenticated caller's authorization policy.
- Require an idempotency key and compute a canonical request digest.
- Submit a bounded job-request envelope to a dedicated job-intake channel.
- Return a request identifier and expose read-only status for authorized requests.
- Request cancellation or quarantine through a separate audited control operation, if explicitly enabled.

The MCP layer may not:
- Call `claimTask` or any lease mutation method.
- Supply or select `workerId`, `executorId`, `leaseGeneration`, assertion claims, or cursor values.
- Mint worker assertions or access the Ledger signing key.
- Treat a Queue acknowledgement as proof that a task was created or executed.
- Interpret caller-provided evidence as reconciliation authorization.

### 3.2 Internal scheduling plane — A

Use a dedicated job-intake Queue, distinct from the existing outbox and DLQ queues.

A trusted internal scheduler consumer:
1. Validates the request envelope again; the MCP boundary is not a trust substitute.
2. Performs durable idempotency and conflict detection in the Ledger.
3. Creates a task through the existing fixed scheduler principal.
4. Assigns the task to the one configured executor identity; callers cannot override it.
5. Emits an execution wake-up signal only after the Ledger confirms task creation.

Queue messages are delivery hints, not authoritative task state. Duplicate delivery must resolve through durable idempotency, and invalid or conflicting envelopes must be rejected/quarantined without creating tasks.

### 3.3 Fixed cloud executor — A

The first deployment supports one fixed executor principal, proposed identifier `orchestrator-executor`. The design must remain extensible to multiple executor identities without allowing request callers to choose them.

The executor:
1. Receives a wake-up signal or scheduled drain trigger.
2. Obtains a short-lived, operation-scoped assertion from the fixed-principal signing policy.
3. Calls the Ledger claim API using its configured identity.
4. Uses the opaque cursor protocol to advance bounded candidate scans. Cursor state must remain private to the executor runtime and must never be returned to MCP callers.
5. Executes only a task whose authoritative Ledger projection and lease match its identity.
6. Supplies the current lease generation on every state-changing operation.
7. Records outputs and evidence through the existing Ledger contracts.
8. Stops or fails closed when lease ownership, fencing generation, or reconciliation state cannot be proven.

The executor must not treat Queue payloads as instructions for arbitrary code, paths, commands, repositories, or identities. The Ledger task projection and a separately enforced task-scope policy are authoritative.

### 3.4 Proof and audit plane — B

Every externally meaningful state transition must have:
- A durable task/request identifier and idempotency key.
- A verified actor/principal and operation.
- Expected and resulting state/version.
- Lease generation where execution ownership applies.
- Evidence references with integrity digests.
- A bounded, machine-readable reason code for rejection or failure.

Unknown execution outcomes remain **unknown** until independently reconciled. They must not be recorded as success or failure merely because a Queue message was acknowledged, a worker timed out, or an assertion expired.

## 4. Trust boundaries and threat model

| Boundary | Untrusted input / threat | Required control |
|---|---|---|
| MCP caller → control plane | Forged caller identity, overbroad job request, replay | Existing authenticated session identity, explicit authorization policy, schema bounds, canonical idempotency |
| MCP → job-intake Queue | Duplicate, delayed, reordered, malformed delivery | Dedicated Queue, bounded envelope, durable dedupe in Ledger |
| Queue → scheduler | Queue payload treated as authority | Revalidate all fields; fixed scheduler principal; no caller-selected identity |
| Scheduler → Ledger | Assertion forgery/replay or privilege expansion | Fixed subject/role/operation allowlist, short TTL, one-time JTI consumption |
| Executor → Ledger | Claim replay, cross-executor claim, lease theft | Executor-bound assertion, executor-bound cursor, atomic claim, lease generation fencing |
| Executor → external work | Prompt/task injection, path escape, secret exfiltration, arbitrary command execution | Explicit task capability policy, path allowlist, no ambient credentials, bounded tools, output redaction |
| Runtime → proof plane | False success, missing evidence, contradictory evidence | Evidence schema, independent verification, outcome states including unknown/disputed |
| Recovery → expired lease | Stale worker continues after reassignment | Fail-closed reconciliation; no caller-shaped evidence; generation fencing |

### Mandatory security invariants

1. Only the fixed scheduler principal can create Ledger tasks.
2. Only the configured executor principal can claim tasks assigned to it.
3. MCP cannot mint or replay internal worker assertions.
4. Assertions are bound to one subject, role, operation, short lifetime, and one-time JTI.
5. A cursor is bound to one executor, is opaque, single-use, expires, and is never accepted from an MCP request.
6. A task is not executable solely because a Queue message exists.
7. Every state-changing executor operation must be fenced by the current lease generation.
8. Expired leases remain blocked until trusted reconciliation exists; no caller-provided boolean or evidence blob can bypass this.
9. Unknown outcomes are not silently converted to success or failure.
10. No route, tool, Queue binding, secret, or deployment change may weaken the public read-only boundary.

## 5. Proposed request and execution sequence

```text
MCP caller
  -> authenticated MCP control plane
  -> dedicated Job Intake Queue
  -> trusted Scheduler consumer
  -> Ledger: durable idempotency + createTask
  -> execution wake-up Queue
  -> fixed Executor service
  -> Ledger: claimTask + cursor + lease
  -> bounded task execution
  -> Ledger: fenced transitions + evidence
  -> independent verification / reconciliation
  -> authorized MCP status observation
```

The exact Queue retry/DLQ policy, cursor checkpoint mechanism, and execution-time budget must be selected from the current Cloudflare limits and the repository's existing operational conventions before implementation. Existing outbox queues are not candidates for reuse.

## 6. Atomic implementation slices

Each slice is independently reviewable and must be delivered with a focused test-first cycle.

### Slice 1 — Identity contract

**Proposed files:** `orchestrator-worker-identity.js`, `test/orchestrator-worker-identity.test.js`, and the relevant Ledger Durable Object tests.

Add a fixed executor principal to the signer allowlist, with only the exact operations required by the first executor implementation. Do not authorize arbitrary subjects, caller-provided roles, or wildcard operations.

Required negative tests: unknown principal, wrong role, wrong operation, expired assertion, altered claims, replayed JTI, and assertion minted for one principal used by another.

### Slice 2 — Durable job-intake contract

**Proposed files:** dedicated job-intake module, Ledger schema/methods, and focused Durable Object tests.

Define the minimal request projection and durable idempotency behavior. Repeated identical requests return the original request/task identity; same idempotency key with a different canonical digest is a conflict and cannot mutate the original record.

No MCP tool is added in this slice.

### Slice 3 — Scheduler Queue consumer

**Proposed files:** Worker Queue routing, scheduler consumer module, Wrangler Queue declarations, and consumer tests.

Use a new Queue name and dedicated consumer path. The scheduler must revalidate the envelope, create a task through its fixed principal, and publish a wake-up only after durable task creation. Unknown Queue names must continue to fail closed.

### Slice 4 — Executor claim and cursor loop

**Proposed files:** executor module, private cursor checkpoint storage, Worker wiring, and Durable Object integration tests.

The executor must claim only as `orchestrator-executor`, advance opaque cursors, bound per-invocation work, and preserve recoverability if the invocation stops between cursor consumption and checkpoint persistence. If checkpoint persistence fails, the executor must restart safely from a fresh scan; it must not reuse a consumed cursor.

### Slice 5 — Fenced execution and proof

**Proposed files:** executor lifecycle module, Ledger transition tests, evidence validation, and independent verification tests.

No task result is marked successful without verified completion evidence. Lease expiry, generation mismatch, partial output, worker crash, or unavailable verifier produce a non-success terminal classification (including unknown/disputed where appropriate) and an auditable reason.

### Slice 6 — MCP surface

**Proposed files:** MCP tool registration/schema, request authorization, Worker tests, and protocol documentation.

Only after the caller-identity decision is resolved, add the smallest MCP surface: submit job, read authorized status, and (if approved) request cancellation/quarantine. No MCP claim, lease, cursor, or assertion operation is exposed.

## 7. Verification strategy

### Unit tests
- Fixed-principal signer allowlist and operation binding.
- Canonical request hashing and idempotency conflict behavior.
- Schema bounds and rejection of unknown fields.
- Queue message replay, delay, reordering, malformed payload, and wrong-queue routing.
- Cursor replay, expiry, cross-executor use, checkpoint failure, and restart from a fresh scan.
- Lease generation fencing and stale executor rejection.
- Proof classification for success, failure, unknown, and disputed outcomes.

### Durable Object integration tests
- Two concurrent scheduler deliveries for one request create at most one task.
- Two concurrent claims cannot obtain the same active lease.
- An executor cannot claim a task assigned to another principal.
- A stale lease generation cannot transition task state or append execution evidence.
- Cursor progression remains bounded and does not skip eligible tasks after restart.
- Expired leases remain blocked without trusted reconciliation.

### Adversarial tests
- MCP caller injects `workerId`, `executorId`, cursor, lease generation, assertion claims, or reconciliation evidence.
- Replayed request with same key/same digest and same key/different digest.
- Forged Queue payload claims a trusted scheduler identity.
- Queue message is acknowledged while task creation fails.
- Executor crashes after claim, after external side effect, and before evidence persistence.
- External task text attempts path traversal, secret access, policy override, or arbitrary command execution.
- Duplicate, delayed, and out-of-order wake-up signals.

### CI gates
- Focused Node tests and Durable Object tests.
- Full repository connector test suite.
- Static syntax and Wrangler dry-run checks.
- Gitleaks must pass; no scan suppression or baseline expansion without a separately reviewed, evidence-backed finding.
- Staging smoke must be explicitly run and pass before any staging-readiness claim.
- No workflow dispatch, deployment, migration, secret read, merge, or production action is part of this design review.

## 8. Explicitly unresolved product/security decisions

These decisions change the authorization and public API contract and must be settled before Slice 2 or Slice 6:

1. **MCP caller authorization:** Does the first release accept only the single repository-owner identity represented by the current MCP authentication boundary, or must it support multiple named callers with per-caller permissions? A shared bearer token alone does not establish distinct human identity.
2. **Initial task capability:** Which bounded task class is allowed in the first execution slice? Recommendation: repository read/analysis and test execution in an isolated workspace, with no merge, deployment, production write, secret access, or arbitrary shell command.
3. **External side effects:** Are all task-side external writes prohibited in the first release, with output limited to a proposed patch/PR artifact? Recommendation: yes.
4. **Cancellation semantics:** Is cancellation an immediate state transition, or a request that the executor acknowledges at a safe checkpoint? Recommendation: request/acknowledge with lease fencing; never revoke a live lease without reconciliation.
5. **Cursor checkpoint storage:** Should cursor continuation be held in a dedicated Durable Object keyed by the fixed executor, or should the executor restart scans after each bounded batch? Recommendation: dedicated private Durable Object state, with safe restart from a fresh scan if checkpoint persistence fails.

## 9. Non-goals and release boundary

This design does not authorize:
- Changing `main` or Production.
- Merging PR #190, PR #191, or this design branch.
- Deploying or changing Cloudflare resources/secrets.
- Reusing the outbox Queue for execution.
- Exposing claim/lease/cursor APIs through MCP.
- Enabling autonomous arbitrary-code execution.
- Treating a green unit-test suite as proof of production readiness.

The design branch is based on PR #191's current head and therefore inherits its dependency chain. It must not be retargeted to `main` until the PR #190 dependency and the Gitleaks failures are independently resolved.
