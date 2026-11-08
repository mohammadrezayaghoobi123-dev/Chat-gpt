# Claim Engine A+B+C Design

**Status:** Approved by the repository owner on 2026-11-08  
**Baseline:** PR #190 head `27ecf073c7f069b9405e45f29d675759998b5dc6`  
**Scope:** Cloud Engineering Connector Durable Object task-claim path only.

## Intent

Make task claiming predictable under dense queues and concurrent workers while preserving task/lease correctness, bounded work per invocation, deterministic ordering, and fail-closed recovery. The design combines three complementary mechanisms rather than treating them as alternatives.

## Goals

- Keep candidate discovery bounded and index-oriented.
- Maintain exact synchronization between authoritative task/lease state and any derived candidate index.
- Preserve deterministic `(created_at, task_id)` ordering and executor isolation.
- Bound per-invocation fallback work and make continuation resumable without skipping or duplicating candidates.
- Require cryptographically authenticated, task- and generation-bound reconciliation evidence before reclaiming expired leases.
- Preserve existing API outcomes where semantically valid and make rejection reasons explicit.
- Prove correctness with invariant, concurrency, stress, query-plan, and full-suite tests.

## Non-goals

- No changes to `main`, merge, release, deployment, Cloudflare bindings, secrets, or production resources.
- No unrelated orchestrator refactor.
- No claim that a SQL `LIMIT` alone bounds rows examined or CPU.
- No automatic reclaim of an expired lease without valid reconciliation evidence.

## Approved approach: A+B+C

### A — Candidate Index (primary path)

Add a derived candidate relation in the Durable Object SQLite schema, keyed to support executor-scoped deterministic ordering. It represents only tasks eligible for scheduler consideration and must be maintained in the same `transactionSync` transaction as authoritative task and lease mutations. Candidate state is derived data, never an authority that can override task or lease state.

The implementation must define and test the exact eligibility predicate before creating the index. Schema initialization must backfill existing tasks safely and idempotently. A consistency verifier used by tests must compare candidate rows with the predicate over authoritative tables.

### B — Query and index optimization

Optimize candidate lookup and supporting existence/reason queries against the actual schema and SQLite query planner. Use `EXPLAIN QUERY PLAN` and representative dense fixtures. Query changes must preserve executor filtering, deterministic ordering, explicit `taskId` behavior, lease fencing, and existing reason precedence. Do not infer bounded internal work from output `LIMIT`; record rows/pages examined or another defensible work metric in stress tests.

### C — Bounded batch fallback

If the primary candidate path cannot complete within its configured budget, process a bounded batch with a stable keyset cursor based on the same deterministic ordering. Each invocation must have explicit maximum candidate rows and a clear continuation result. Cursor advancement must not skip unprocessed rows; retries must be idempotent. Exhaustion and budget exhaustion must be distinguishable. The fallback must not become an unbounded second scan.

## Reconciliation security contract

Replace the current caller-supplied boolean/object evidence check with authenticated evidence that binds at minimum:
- `taskId`
- `priorGeneration`
- unique evidence identifier / JTI
- authenticated issuer and authorized operation
- `issuedAt` and `expiresAt`
- cryptographic signature verified against configured key material

Evidence must be rejected when forged, expired, replayed, issued by an unauthorized principal, or bound to another task or generation. Evidence consumption and lease generation update must be atomic. The production issuer and runtime call path must be identified before enabling reclaim; if no trusted producer can be established, the system remains fail-closed. Do not mint evidence from user-controlled MCP arguments or webhook payloads.

## Atomic mutation coverage

Candidate synchronization must cover every authoritative mutation path that can change task eligibility or lease availability:
- `createTask`
- `transitionTask`
- `claimTask`
- `releaseLease`
- `executeOwnerCommand`
- any additional task/lease mutation discovered during implementation audit

Lease renewal and agent-round changes must be explicitly evaluated and shown not to change candidate membership, or synchronized if the predicate depends on them. All related writes must occur inside the existing Durable Object `transactionSync` boundary. Conditional updates must check affected/persisted state and throw on invariant mismatch so the transaction rolls back.

## Compatibility and constraints

- Preserve the current Durable Object SQLite storage model and project conventions.
- Preserve Node >=22, Vitest, Cloudflare Vitest plugin, and existing test commands.
- Do not add a new external dependency unless a verified security or correctness requirement cannot be met with platform primitives.
- Preserve explicit task lookup semantics and current deterministic task ordering.
- Do not modify `main` or deploy any artifact during this work.

## Acceptance criteria

1. Candidate-index invariant holds after schema bootstrap/backfill and after every audited mutation path.
2. No eligible task is lost; no ineligible task is returned as a valid candidate.
3. Concurrent claimers cannot create two valid leases for the same task/generation.
4. Stale generations cannot renew, release, transition, or reclaim a lease.
5. Invalid, forged, replayed, expired, wrong-task, and wrong-generation reconciliation evidence is rejected.
6. Candidate lookup uses the intended index in the query plan for representative data.
7. Per-invocation work is bounded by an explicit configured budget; fallback cursor behavior is resumable and lossless.
8. Tests cover empty, sparse, dense, all-leased, expired-lease, mixed-executor, equal-timestamp, and large-queue conditions.
9. Full project tests and CI pass on the exact resulting SHA.
10. No merge, deployment, secret mutation, binding mutation, or `main` modification occurs.

## Release posture

Implementation is staged on an isolated branch. Any failed invariant, unexplained query-plan regression, missing trusted reconciliation issuer, or unverified runtime call path is a NO-GO. Production rollout is a separate, explicitly authorized activity after independent review.
