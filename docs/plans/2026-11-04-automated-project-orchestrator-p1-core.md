# Automated Project Orchestrator P1 Core Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, fail-closed Orchestrator Core and its durable coordination ledger without enabling model-provider calls, changing live infrastructure, or weakening existing repository boundaries.

**Architecture:** Implement the state machine, protocol validation, and policy evaluation as pure Node.js modules so they can be tested without external services. Add a separate SQLite-backed Cloudflare Durable Object for task, message-deduplication, lease, outbox, and audit records; it is a new coordination ledger and must not replace or mutate the canonical KnowledgeStore. The first implementation remains source-and-test only: no Cloudflare deployment or namespace migration is part of P1.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, Cloudflare Workers Durable Objects with SQLite, existing Wrangler 4 and `@cloudflare/vitest-plugin` test harness, GitHub Actions.

## Global Constraints

- GitHub remains authoritative for source code, task intake, branches, PRs, CI, and review evidence.
- KnowledgeStore remains the canonical project knowledge source. The Orchestrator Ledger stores task coordination state only; it must not duplicate or replace knowledge entities or documents.
- Notion remains a non-authoritative sanitized projection.
- No paid API, paid inference, paid hosting, automatic billing enablement, plan upgrade, or paid fallback.
- ChatGPT and Claude adapters remain disabled unless each has an official, authenticated, demonstrably zero-cost invocation path. Mock adapters are test fixtures only and are never reported as live model invocation.
- No browser-session automation, cookies, passwords, subscription scraping, or quota bypass.
- No automatic writes to `main`; no merge, secret access, billing changes, permission changes, or Production/Staging deployment.
- Preserve PRs #145, #146, and #147. Keep P0 PR #148 separate; this P1 plan is on its own branch and must not expand PR #148's scope.
- All unknown actors, scopes, states, policy results, branch identities, and approval states fail closed.
- Every execution unit has a bounded scope, immutable task ID, idempotency key, exact input hash, and inspectable evidence.
- Use leases with monotonically increasing fencing generations. A stale lease holder must not commit effects.
- Use durable deduplication and a transactional outbox. Claim at-most-once effect through idempotency and reconciliation; do not claim globally exactly-once delivery across GitHub and Cloudflare.
- Enforce a maximum of four automated agent-to-agent rounds per task. Retries do not reset the round count.
- No secret values or credentials may enter task records, message payloads, audit records, test snapshots, or logs.
- Do not deploy or migrate the new Durable Object namespace during P1. Runtime binding and backup/restore prerequisites remain separately gated.

---

### Task 1: Deterministic task state machine and completion gate

**Files:**
- Create: `cloud-engineering-connector/orchestrator-core.js`
- Create: `cloud-engineering-connector/test/orchestrator-core.test.js`
- Modify: `cloud-engineering-connector/package.json` (register the new Node test file in `test:node` and `check`)

**Interfaces:**
- Export `TASK_STATES` as the immutable set of the normal and exception states in the approved architecture.
- Export `LEGAL_TRANSITIONS` as an immutable state-to-next-state map.
- Export `transitionTask({ task, nextState, actor, evidence, now })`, returning a new task projection with incremented `version`, updated `state`, timestamps, and transition evidence; it must not mutate the input object.
- Export `assertTaskCompletion({ task, evidence })`, which accepts completion only from `REVIEW_PENDING` with passing acceptance evidence and an independent approval bound to the exact resulting commit SHA.
- Export `isTerminalTaskState(state)`.

- [ ] **Step 1: Add focused failing tests**

Cover:
1. Every normal transition in the approved sequence is accepted.
2. Every unlisted transition is rejected without changing the input task.
3. `COMPLETED`, `CANCELLED`, and `FAILED` cannot be reopened by an ordinary transition.
4. `RUNNING` cannot transition directly to `COMPLETED`.
5. `COMPLETED` is rejected if acceptance criteria are missing or failing.
6. `COMPLETED` is rejected if review is missing, is not independent of the executor, or references a different commit SHA.
7. A version mismatch rejects a stale transition.
8. Unknown states and malformed task projections are rejected.

- [ ] **Step 2: Verify the expected failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-core.test.js`

Expected: test runner reports missing exports or the new assertions fail because the state machine does not yet exist.

- [ ] **Step 3: Implement the minimum deterministic state machine**

Use the approved normal path:
`RECEIVED → VALIDATING → READY → SCHEDULED → RUNNING → VERIFYING → REVIEW_PENDING → COMPLETED`.

Represent exception states `BLOCKED`, `FAILED`, `CANCELLED`, `DISPUTED`, `QUARANTINED`, and `RETRY_WAIT` explicitly. Reject transitions not in `LEGAL_TRANSITIONS`. Require compare-and-set through the supplied expected task version. Keep task projections immutable. Permit completion only from `REVIEW_PENDING`, with passing acceptance evidence and an independent reviewer approval for the exact SHA. A quarantine release requires an explicit owner-authorized resolution event; a self-declared agent identity is not sufficient.

- [ ] **Step 4: Verify the focused pass**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-core.test.js`

Expected: all state-machine and completion-gate tests pass.

- [ ] **Step 5: Run affected integration checks**

Run: `cd cloud-engineering-connector && npm run test:node && npm run check`

Expected: existing Node tests and syntax/Wrangler dry-runs pass with no change to current Worker behavior.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add cloud-engineering-connector/orchestrator-core.js cloud-engineering-connector/test/orchestrator-core.test.js cloud-engineering-connector/package.json
git commit -m "feat(orchestrator): add deterministic task state machine"
```

### Task 2: Versioned agent message protocol and deterministic deduplication keys

**Files:**
- Create: `cloud-engineering-connector/orchestrator-protocol.js`
- Create: `cloud-engineering-connector/test/orchestrator-protocol.test.js`
- Modify: `cloud-engineering-connector/package.json` (register the Node test and syntax check)

**Interfaces:**
- Export `MESSAGE_TYPES` for task proposal, acknowledgement, progress, verification result, dispute, blocker, decision request, and closure.
- Export `validateMessageEnvelope(envelope, { now, authenticatedSender })`, returning a validated normalized envelope or a typed validation error.
- Export `canonicalJson(value)` and `sha256Canonical(value)` for deterministic request/input fingerprints.
- Export `messageIdempotencyKey(envelope)`, derived from the immutable message and task identifiers.
- Export `assertAgentRoundLimit({ currentRound, nextRound })`, rejecting any automated round above four.

- [ ] **Step 1: Add focused failing tests**

Cover:
1. A complete envelope with protocol version, message/task/correlation IDs, sender/recipient, type, creation/expiry times, scope reference, input hash, and evidence references is accepted.
2. Missing required fields, unsupported protocol versions, malformed timestamps, expired messages, unknown message types, and invalid SHA-256 input hashes are rejected.
3. A self-declared `sender_identity` without an authenticated sender context is rejected for any privileged or state-changing message.
4. Authenticated sender identity must match the authorized sender context; a mismatch is rejected.
5. Reordering JSON object keys yields the same canonical digest; changing a value yields a different digest.
6. Repeated delivery of the same message produces the same idempotency key.
7. The fifth automated agent round is rejected; retries do not reset the round count.
8. Payload data remains untrusted input and cannot alter the envelope's declared scope or policy context.

- [ ] **Step 2: Verify the expected failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-protocol.test.js`

Expected: the test runner reports the missing protocol exports or the new assertions fail.

- [ ] **Step 3: Implement the minimum protocol contract**

Validate the versioned envelope against the approved field contract. Treat `sender_identity` as descriptive only; authorization must use the separately supplied authenticated identity context. Preserve payload content as data and never interpret it as tool instructions or expanded authorization. Canonicalize object keys recursively before hashing. Enforce the four-round ceiling as durable task metadata in the ledger integration; the pure helper must reject a requested next round above four.

- [ ] **Step 4: Verify the focused pass**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-protocol.test.js`

Expected: all envelope, identity, hashing, expiry, and round-limit tests pass.

- [ ] **Step 5: Run affected integration checks**

Run: `cd cloud-engineering-connector && npm run test:node && npm run check`

Expected: all existing Node tests and syntax checks pass.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add cloud-engineering-connector/orchestrator-protocol.js cloud-engineering-connector/test/orchestrator-protocol.test.js cloud-engineering-connector/package.json
git commit -m "feat(orchestrator): validate versioned agent messages"
```

### Task 3: Fail-closed policy engine and side-effect authorization

**Files:**
- Create: `cloud-engineering-connector/orchestrator-policy.js`
- Create: `cloud-engineering-connector/test/orchestrator-policy.test.js`
- Modify: `cloud-engineering-connector/package.json` (register the Node test and syntax check)

**Interfaces:**
- Export `POLICY_DECISIONS` with `ALLOW`, `DENY`, and `QUARANTINE`.
- Export `evaluateOrchestratorPolicy({ actor, action, repository, baseBranch, targetBranch, changedPaths, scope, stopSwitch, agentCapability, approval })`, returning a structured decision with stable reason code and no secret-bearing detail.
- Export `assertPolicyAllows(decision)`, throwing a typed authorization error unless the decision is exactly `ALLOW`.

- [ ] **Step 1: Add focused failing tests**

Cover:
1. A verified actor with an explicit matching task scope may perform an allowed read-only action.
2. Missing, unknown, or unauthenticated actors are denied.
3. Unknown actions and unknown policy states are denied.
4. Any write targeting `main`, a protected branch, secrets, repository settings, billing, or Production is denied.
5. A changed path outside the task allowlist is denied, including traversal and normalized path escape.
6. A present, enabled, or unreadable stop switch denies every side effect.
7. Missing or ambiguous approval denies operations that require owner approval or independent review.
8. An agent adapter with `UNAVAILABLE`, `AUTHENTICATION_UNVERIFIED`, `QUOTA_EXHAUSTED`, or `DISABLED_BY_POLICY` capability cannot be scheduled.
9. A capability marked available without independently verified identity is denied.
10. Decision output contains only stable reason codes and sanitized metadata, never credentials or raw secrets.

- [ ] **Step 2: Verify the expected failure**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-policy.test.js`

Expected: missing exports or failing assertions demonstrate the absence of the policy engine.

- [ ] **Step 3: Implement the minimum policy evaluator**

Use a closed allowlist for actions and explicit actor/capability states. Deny unknown values. Enforce path scope and protected-resource exclusions before returning `ALLOW`. Re-check stop-switch state at the side-effect boundary; unreadable state is a denial. The policy engine must not infer independence from display names or self-declared agent identities. It must not enable live model adapters or create credentials.

- [ ] **Step 4: Verify the focused pass**

Run: `cd cloud-engineering-connector && node --test test/orchestrator-policy.test.js`

Expected: all allow/deny/quarantine and fail-closed cases pass.

- [ ] **Step 5: Run affected integration checks**

Run: `cd cloud-engineering-connector && npm run test:node && npm run check`

Expected: existing tests and dry-runs pass; current MCP public-read-only and authenticated-write boundaries remain unchanged.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add cloud-engineering-connector/orchestrator-policy.js cloud-engineering-connector/test/orchestrator-policy.test.js cloud-engineering-connector/package.json
git commit -m "feat(orchestrator): enforce fail-closed task policy"
```

### Task 4: Durable Orchestrator Ledger with idempotency, fencing leases, outbox, and audit events

**Files:**
- Create: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js`
- Modify: `cloud-engineering-connector/index.js` (export the new Durable Object class)
- Modify: `cloud-engineering-connector/wrangler.toml` (declare a new `ORCHESTRATOR_LEDGER` Durable Object binding and a new SQLite migration; do not alter existing KnowledgeStore bindings or migration history)
- Modify: `cloud-engineering-connector/package.json` only if an additional Node syntax check is required

**Interfaces:**
- Durable Object class: `OrchestratorLedger`.
- `ping()` returns `{ ok: true, schemaVersion }`.
- `createTask({ task, idempotencyKey, inputHash, now })` returns created, replay, or idempotency-conflict result.
- `getTask({ taskId })` returns one task projection or `null`.
- `transitionTask({ taskId, expectedVersion, expectedState, nextState, actor, evidence, now })` performs a transactional compare-and-set state transition.
- `recordMessage({ messageId, taskId, inputHash, envelope, now })` durably deduplicates a message and returns accepted, replay, or conflict.
- `claimTask({ workerId, leaseMs, now })`, `renewLease({ taskId, workerId, leaseGeneration, leaseMs, now })`, and `releaseLease({ taskId, workerId, leaseGeneration, now })` manage fenced leases.
- `enqueueOutbox({ eventId, idempotencyKey, taskId, eventType, payload, now })`, `claimOutbox({ workerId, leaseMs, now })`, and `completeOutbox({ eventId, leaseGeneration, now })` implement durable transactional publication intent.
- `appendAuditEvent({ eventId, taskId, actor, eventType, details, now })` appends an immutable event and links it to the preceding event hash.
- No public MCP tool or Worker route is added in this task. The ledger is internal infrastructure until a separate authenticated intake and authorization review.

- [ ] **Step 1: Add focused failing Durable Object tests**

Cover:
1. Schema initialization and `ping()` report the expected schema version.
2. Repeated task creation with the same idempotency key and input hash returns the original task without creating a second row.
3. Reusing an idempotency key with a different input hash returns a conflict and does not mutate the original task.
4. Two concurrent claims for one task yield at most one valid lease generation.
5. A stale worker cannot renew, release, transition, or commit after a newer fencing generation exists.
6. A stale expected task version/state cannot overwrite a newer state.
7. Concurrent duplicate message delivery records one effective message; same ID with a different input hash is quarantined or rejected without processing.
8. Task state change and corresponding outbox intent are committed atomically; a simulated interruption after commit leaves a recoverable pending outbox event.
9. Repeated outbox enqueue with the same idempotency key returns the existing event; changed payload under the same key is a conflict.
10. Outbox claims use leases and monotonically increasing fencing generations; stale completion is rejected.
11. Audit events are append-only, hash-linked, and reject mutation/reuse of an event ID with different content.
12. A 100-delivery duplicate-message test produces one effective task-side effect.
13. A simulated worker restart can reclaim an expired lease only after checking prior side effects and the durable state.
14. Ledger records contain no secret-value fields and do not write to KnowledgeStore tables.

- [ ] **Step 2: Verify the expected failure**

Run: `cd cloud-engineering-connector && npx vitest run --config vitest.config.js cloudflare-test/orchestrator-ledger.test.js`

Expected: the test runner cannot resolve the new Durable Object binding/class or the new behavior assertions fail.

- [ ] **Step 3: Implement the SQLite-backed Durable Object**

Create separate tables for tasks, processed message IDs, execution leases, outbox events, and audit events. Use `ctx.storage.transactionSync` for each multi-row state mutation. Add unique constraints for task idempotency keys, message IDs, and outbox idempotency keys. Increment the fencing generation on every successful lease claim/reclaim. Require the exact generation on every lease-bound write. Persist the outbox event in the same transaction as the state change it represents. Keep audit records append-only at the application API and hash-link each event; explicitly document that this is not an external trust anchor. Bound serialized task/message payloads by the existing Worker request-size ceiling and reject oversized data before persistence. Do not store provider credentials, secret values, or KnowledgeStore document content.

- [ ] **Step 4: Verify the focused pass**

Run: `cd cloud-engineering-connector && npx vitest run --config vitest.config.js cloudflare-test/orchestrator-ledger.test.js`

Expected: all schema, idempotency, concurrency, fencing, outbox recovery, and audit-integrity tests pass.

- [ ] **Step 5: Run affected integration checks**

Run: `cd cloud-engineering-connector && npm test && npm run check`

Expected: all Node and Cloudflare Durable Object tests pass, syntax checks pass, and both Wrangler dry-runs render the new source configuration without deployment. Confirm that no test or command invokes `wrangler deploy` without `--dry-run`.

- [ ] **Step 6: Commit the passing deliverable**

```bash
git add cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger.test.js cloud-engineering-connector/index.js cloud-engineering-connector/wrangler.toml
git commit -m "feat(orchestrator): add durable task coordination ledger"
```

---

## Unresolved externally observable decisions

1. **Task intake authority:** which exact GitHub Issue labels, event types, and authenticated actor identities may create a task? The policy engine will deny intake until this allowlist is approved and implemented in a later integration phase.
2. **Lease durations and retry ceilings:** exact lease TTL, renewal interval, maximum attempts, and backoff schedule need measured runtime limits and owner approval. P1 will expose explicit configuration inputs but must not silently select production values.
3. **Audit retention and external checkpoint destination:** retention duration and a separately controlled external anchor are not established. The P1 hash chain is integrity evidence only, not tamper-proof production audit.
4. **Owner-resolution mechanism for quarantined tasks:** the trusted identity and exact GitHub event proving owner authorization must be defined before quarantine release is enabled.
5. **Independent reviewer identity:** a distinct authenticated reviewer outside both agent identities has not been verified; completion remains blocked until one is available.
6. **Live provider capability:** no sustainable official zero-cost ChatGPT API and Claude API invocation path has been verified. Both adapters remain disabled; mock tests do not satisfy live collaboration acceptance.
7. **Runtime Durable Object availability and backup/restore:** the live Cloudflare inventory did not show the KnowledgeStore namespace expected by source and did not verify the active account plan. This plan adds only a source-level Orchestrator Ledger binding; deployment, namespace migration, and live backup/restore remain out of scope pending separate evidence and owner authorization.

## P1 acceptance boundary

P1 is complete only when all four tasks pass their focused tests and the full `npm test` and `npm run check` commands on the exact final commit SHA. The result proves deterministic core and local Durable Object behavior only. It does not prove GitHub event intake, real ChatGPT/Claude invocation, live Cloudflare namespace readiness, independent review, staging acceptance, or Production readiness.
