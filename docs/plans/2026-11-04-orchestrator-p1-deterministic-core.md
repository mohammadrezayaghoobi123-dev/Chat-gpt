# Orchestrator P1 Deterministic Core Implementation Plan

> **For agentic workers:** Use the host's available task-by-task implementation workflow. Steps use checkbox syntax for tracking.

**Goal:** Implement a deterministic, testable orchestration core for task contracts, state transitions, fail-closed policy decisions, idempotent message processing, leases, outbox events, and audit evidence without enabling live model calls or cloud deployment.

**Architecture:** Build the core as pure JavaScript modules with an in-memory reference ledger used only for deterministic tests. Keep persistence and external side effects behind explicit interfaces so a later phase can evaluate Cloudflare Durable Objects against verified free-tier and recovery requirements. Do not merge the core into the MCP request path during P1.

**Tech Stack:** Node.js 22 ESM, native node:test, existing Vitest/Cloudflare test environment for compatibility checks, SHA-256 via Web Crypto, existing npm lockfile and scripts.

## Global Constraints

- GitHub remains authoritative for source code, branches, tasks, pull requests, CI evidence, and review records.
- KnowledgeStore remains the canonical source of project knowledge. The P1 ledger may retain references and evidence metadata only; it must not copy or fork canonical knowledge.
- Notion remains a non-authoritative management projection and is outside this phase.
- ChatGPT and Claude adapters remain disabled unless official, authenticated, sustainable zero-cost invocation is independently verified. Mock adapters never count as live integration.
- No paid model API, paid hosting, paid database/queue, automatic billing enablement, plan upgrade, or paid fallback.
- If an external capability, identity, policy result, quota, or state is unknown, deny or block the affected action.
- No browser-session scraping, cookie reuse, credential sharing, quota bypass, or invented agent activity.
- No changes to main; no merge, rebase, force-push, or deletion of protected branches.
- PRs #145, #146, and #147 remain untouched. PR #148 remains a separate Draft P0 review item; do not merge it or stack implementation commits onto it.
- No secret values may be read, logged, copied, committed, or included in task/message payloads.
- No Worker deployment, Durable Object migration, Cloudflare binding change, traffic change, secret mutation, billing change, or Production operation is in scope.
- The existing KnowledgeStore and WriteControl classes retain their current responsibilities. Do not reuse either as the Orchestrator task ledger.
- The P1 in-memory ledger is a test/reference adapter, not a durable production store and not evidence of production-grade persistence.
- Each implementation task must be independently testable, use test-first development, and be committed only after its focused and integration checks pass.

---

## Repository findings and boundaries

Observed on the P0 branch:

- cloud-engineering-connector/worker.js: existing MCP Worker entry point and tool dispatch. P1 must not add public MCP tools or route task execution through this Worker.
- cloud-engineering-connector/knowledge-store.js: existing tenant-scoped canonical KnowledgeStore Durable Object with SQLite schema, immutable document references, and its own outbox. Do not add orchestrator task state here.
- cloud-engineering-connector/write-control.js: existing write-operation admission ledger with phase transitions and lease generations. Its write-probe lifecycle is not the orchestrator task state machine.
- cloud-engineering-connector/vitest.config.js: Cloudflare Vitest plugin configured against wrangler.toml.
- cloud-engineering-connector/package.json: Node tests are registered explicitly in test:node; syntax checks are registered explicitly in check.
- The active Cloudflare inventory does not show a deployed KnowledgeStore namespace, and the billing plan could not be verified. P1 therefore remains local/test-only and must not alter Wrangler migrations.

## Proposed public contracts

The following module interfaces are the P1 implementation contract:

    // orchestrator-contract.js
    validateTask(task) -> { ok: true, value: task } | { ok: false, errors: string[] }
    validateAgentMessage(message, now) -> { ok: true, value: message } | { ok: false, errors: string[] }
    canonicalJson(value) -> string
    sha256Hex(value) -> Promise<string>

    // orchestrator-state-machine.js
    TASK_STATES
    ALLOWED_TRANSITIONS
    transitionTask(task, nextState, context) -> updatedTask | throws ORCHESTRATOR_INVALID_TRANSITION

    // orchestrator-policy.js
    evaluatePolicy(input) -> {
      decision: "ALLOW" | "DENY",
      reasonCodes: string[],
      evaluatedAt: number
    }

    // orchestrator-ledger-memory.js
    class InMemoryOrchestratorLedger {
      createTask(task, idempotencyKey, inputHash)
      getTask(taskId)
      transitionTask(taskId, nextState, context)
      recordMessage(messageId, fingerprint, message)
      acquireLease(taskId, ownerId, now, leaseMs)
      renewLease(taskId, ownerId, generation, now, leaseMs)
      releaseLease(taskId, ownerId, generation, now)
      enqueueOutbox(event, idempotencyKey, fingerprint, now)
      claimOutbox(ownerId, now, leaseMs)
      completeOutbox(eventId, ownerId, generation, now)
      failOutbox(eventId, ownerId, generation, now, failureClass, maxAttempts)
      appendAuditEvent(event)
      listAuditEvents(taskId)
    }

    // orchestrator-core.js
    createOrchestrator({ ledger, policy, clock, hash })
    submitTask(task)
    acceptMessage(message)
    transition(taskId, nextState, context)
    claimTask(taskId, ownerId, leaseMs)
    recordAgentRound(taskId, roundId, message)

The exact exported signatures may be refined only to preserve these semantics and must remain consistent across modules and tests.

## Task 1: Task and message contracts plus explicit state machine

**Files:**
- Create: cloud-engineering-connector/orchestrator-contract.js
- Create: cloud-engineering-connector/orchestrator-state-machine.js
- Create: cloud-engineering-connector/test/orchestrator-contract.test.js
- Create: cloud-engineering-connector/test/orchestrator-state-machine.test.js
- Modify: cloud-engineering-connector/package.json

**Interfaces:**
- Consumes: task and agent-message fields from the approved architecture spec.
- Produces: validateTask, validateAgentMessage, canonicalJson, sha256Hex, TASK_STATES, ALLOWED_TRANSITIONS, and transitionTask.

- [ ] **Step 1: Add failing contract tests**

Cover:
1. A valid task containing immutable IDs, source reference, authenticated requester identity reference, task type, priority, risk level, capabilities, scope object, acceptance criteria, dependencies, input hash, state, and timestamps is accepted without rewriting its supplied values.
2. Missing taskId, malformed input hash, unsupported state, non-object scope, and non-array dependencies are rejected with stable field-specific errors.
3. A valid message with protocol version, unique message ID, task/correlation IDs, sender/recipient identity references, message type, timestamps, scope reference, input hash, and evidence references is accepted.
4. Expired, oversized, malformed, or missing-identity-proof messages are rejected or marked advisory according to the explicit identity-proof field; a self-declared sender name never becomes authenticated identity.
5. Canonical JSON produces the same byte string for objects with reordered keys, preserves array order, and does not silently coerce values.
6. State transition tests accept only the approved normal and exception transitions; they reject unknown states, illegal jumps, and completion without required verification/review context.

- [ ] **Step 2: Verify the relevant failure**

Run from cloud-engineering-connector:

    node --test test/orchestrator-contract.test.js test/orchestrator-state-machine.test.js

Expected: module import failures or missing-export failures prove the contract modules and behaviors are not yet implemented.

- [ ] **Step 3: Implement the minimum contract and state machine**

Implement:
- Stable state constants: RECEIVED, VALIDATING, READY, SCHEDULED, RUNNING, VERIFYING, REVIEW_PENDING, COMPLETED, BLOCKED, FAILED, CANCELLED, DISPUTED, QUARANTINED, and RETRY_WAIT.
- A transition allowlist with no implicit transition and no direct RUNNING -> COMPLETED or FAILED -> COMPLETED.
- Completion requires verification evidence and review evidence appropriate to the task risk; absent evidence keeps the task out of COMPLETED.
- Task/message validation returns structured errors and does not mutate the supplied input.
- Message identity proof is represented separately from the self-declared sender label. Unverified identity can produce advisory-only data but cannot authorize a privileged action.
- Canonical JSON sorts object keys recursively while preserving array order; SHA-256 uses Web Crypto and returns lowercase hexadecimal.

- [ ] **Step 4: Verify focused tests**

Run:

    node --test test/orchestrator-contract.test.js test/orchestrator-state-machine.test.js

Expected: all focused contract and transition tests pass; illegal transitions and incomplete completion evidence are rejected.

- [ ] **Step 5: Run affected integration checks**

Run:

    npm run test:node
    npm run check

Expected: all registered Node tests pass and all JavaScript syntax/Wrangler dry-run checks complete successfully. The preflight report may still say BLOCKED; that is the expected external-readiness result.

- [ ] **Step 6: Commit the passing deliverable**

    git add orchestrator-contract.js orchestrator-state-machine.js test/orchestrator-contract.test.js test/orchestrator-state-machine.test.js package.json
    git commit -m "feat(orchestrator): add task contracts and state machine"

## Task 2: Fail-closed policy engine and stop-switch evaluation

**Files:**
- Create: cloud-engineering-connector/orchestrator-policy.js
- Create: cloud-engineering-connector/test/orchestrator-policy.test.js
- Modify: cloud-engineering-connector/package.json

**Interfaces:**
- Consumes: validated task, authenticated actor evidence, operation, scope, stop-switch state, quota state, and agent capability state.
- Produces: evaluatePolicy(input) returning ALLOW or DENY with stable reason codes and evaluation timestamp.

- [ ] **Step 1: Add failing policy tests**

Cover:
1. Verified actor + in-scope operation + stop switch explicitly off + quota available + eligible agent capability yields ALLOW.
2. Missing or ambiguous actor identity yields DENY.
3. Stop switch enabled or unreadable/unavailable yields DENY.
4. Operation or path outside the task allowlist, including traversal-like paths, yields DENY.
5. Unknown policy result, unknown quota, exhausted quota, or provider state outside AVAILABLE_VERIFIED_FREE / AVAILABLE_LIMITED_FREE yields DENY.
6. Attempt to merge to protected branches, change branch protection, read/write secrets, change billing, or deploy yields DENY regardless of agent capability.
7. A mock adapter is identified as TEST_ONLY and cannot satisfy live provider eligibility.

- [ ] **Step 2: Verify the relevant failure**

Run:

    node --test test/orchestrator-policy.test.js

Expected: missing module or behavior failures before implementation.

- [ ] **Step 3: Implement deterministic policy evaluation**

Implement a pure function with no network, environment, or storage access. Require explicit positive evidence for every allow condition. Use stable reason codes such as ACTOR_UNVERIFIED, STOP_SWITCH_ACTIVE, STOP_SWITCH_UNAVAILABLE, SCOPE_DENIED, QUOTA_UNKNOWN, QUOTA_EXHAUSTED, AGENT_UNAVAILABLE, and PROTECTED_OPERATION_DENIED. Never infer actor authority from a message field or repository text.

- [ ] **Step 4: Verify focused tests**

Run:

    node --test test/orchestrator-policy.test.js

Expected: positive allow case passes; every unknown, missing, out-of-scope, protected, or paid-path case is denied.

- [ ] **Step 5: Run affected integration checks**

Run:

    npm run test:node
    npm run check

Expected: all Node tests and syntax/Wrangler dry-run checks pass.

- [ ] **Step 6: Commit the passing deliverable**

    git add orchestrator-policy.js test/orchestrator-policy.test.js package.json
    git commit -m "feat(orchestrator): add fail-closed policy engine"

## Task 3: Deterministic reference ledger for idempotency, leases, outbox, and audit

**Files:**
- Create: cloud-engineering-connector/orchestrator-ledger-memory.js
- Create: cloud-engineering-connector/test/orchestrator-ledger-memory.test.js
- Modify: cloud-engineering-connector/package.json

**Interfaces:**
- Consumes: validated task/message/event records and explicit clock/lease inputs.
- Produces: InMemoryOrchestratorLedger with the methods defined above. The adapter is intentionally in-memory and is used only as an executable reference model for later durable adapters.

- [ ] **Step 1: Add failing ledger tests**

Cover:
1. Repeating the same task idempotency key and same input fingerprint returns the original task; same key with different fingerprint returns a conflict and does not create a second task.
2. Delivering one message ID 100 times creates one effective processed-message record; reusing the ID with a different fingerprint returns an idempotency conflict.
3. Two concurrent lease claims for the same task yield one active lease; lease generations increase monotonically after expiry/reacquisition.
4. A stale worker cannot renew, release, complete, or append an effect using an expired lease generation.
5. Lease expiry does not silently mark a task successful; task remains recoverable and must reconcile before retry.
6. Outbox enqueue is idempotent; same key/different fingerprint conflicts.
7. Outbox claims are exclusive, bounded by explicit lease expiry, and fenced by generation.
8. Transient failures enter retry state only below the configured attempt ceiling; permanent failures and exhausted attempts enter dead-letter state.
9. Audit events are append-only, sequence-numbered, hash-linked, and reject mutation through the public API.
10. Repeated outbox delivery may be at-least-once, but consumer-side idempotency ensures one effective event result.

- [ ] **Step 2: Verify the relevant failure**

Run:

    node --test test/orchestrator-ledger-memory.test.js

Expected: missing module or method failures before implementation.

- [ ] **Step 3: Implement the reference ledger**

Use private Maps or equivalent internal collections; do not expose mutable internal references. Use injected now values rather than real timers. Use compare-and-set style checks on lease owner and generation. Distinguish pending, processing, retry, completed, and dead_letter outbox states. Store only references/hashes and sanitized metadata; never store credentials or canonical KnowledgeStore content. Audit records include previous hash and current hash but are not described as tamper-proof without an external trust anchor.

- [ ] **Step 4: Verify focused tests**

Run:

    node --test test/orchestrator-ledger-memory.test.js

Expected: duplicate delivery, conflicting idempotency keys, concurrent claims, stale fencing tokens, retry ceilings, and audit-chain continuity all pass.

- [ ] **Step 5: Run affected integration checks**

Run:

    npm run test:node
    npm run check

Expected: all Node tests and syntax/Wrangler dry-run checks pass.

- [ ] **Step 6: Commit the passing deliverable**

    git add orchestrator-ledger-memory.js test/orchestrator-ledger-memory.test.js package.json
    git commit -m "feat(orchestrator): add deterministic reference ledger"

## Task 4: Orchestrator facade and end-to-end deterministic contract

**Files:**
- Create: cloud-engineering-connector/orchestrator-core.js
- Create: cloud-engineering-connector/test/orchestrator-core.test.js
- Modify: cloud-engineering-connector/package.json

**Interfaces:**
- Consumes: task/message contracts, state machine, policy evaluator, ledger interface, injected clock, and injected hash function.
- Produces: createOrchestrator({ ledger, policy, clock, hash }) with submitTask, acceptMessage, transition, claimTask, and recordAgentRound.

- [ ] **Step 1: Add failing facade tests**

Cover:
1. Task submission validates, evaluates policy, records idempotently, and emits an audit event.
2. A policy denial records the denial reason but performs no task-side effect.
3. Duplicate message processing returns the first result and emits no duplicate effect.
4. A message with unverified identity remains advisory and cannot schedule work or change task state.
5. A task cannot exceed four automated agent-to-agent rounds; the fifth attempt is blocked and audited.
6. Stop-switch activation between initial validation and a side-effect boundary prevents that side effect.
7. Task completion requires the state-machine verification and review evidence.
8. Unknown ledger/policy outcomes do not become success; they return a blocked/unknown result and preserve reconciliation data.

- [ ] **Step 2: Verify the relevant failure**

Run:

    node --test test/orchestrator-core.test.js

Expected: missing module or facade behavior failures before implementation.

- [ ] **Step 3: Implement the orchestration facade**

Keep it independent of Cloudflare, GitHub network calls, Notion, and live model providers. Inject all external dependencies. Re-check stop-switch and policy state immediately before each effectful ledger operation. Do not provide a Production or deployment method.

- [ ] **Step 4: Verify focused tests**

Run:

    node --test test/orchestrator-core.test.js

Expected: all deterministic end-to-end cases pass with only injected fake adapters.

- [ ] **Step 5: Run complete P1 verification**

Run:

    npm test
    npm run check
    npm audit --audit-level=moderate

Expected: Node and Cloudflare Durable Object test suites pass, syntax checks and Wrangler dry-runs pass, and npm audit reports no advisories at or above moderate severity.

- [ ] **Step 6: Commit the passing deliverable**

    git add orchestrator-core.js test/orchestrator-core.test.js package.json
    git commit -m "feat(orchestrator): add deterministic orchestration facade"

## P1 acceptance gate

P1 is accepted only when all of the following are evidenced on one exact final commit SHA:

- All P1 contract, state-machine, policy, ledger, and facade tests pass.
- Duplicate delivery test (100 deliveries) proves one effective task/message effect.
- Concurrent lease test proves one current fencing generation and rejects stale workers.
- The fifth agent round is blocked; the first four are durably counted by the reference ledger.
- Stop-switch active or unavailable denies side effects.
- Unknown actors, scopes, quotas, provider eligibility, and policy states fail closed.
- No test or report claims a mock adapter is a live ChatGPT or Claude connection.
- Existing KnowledgeStore and WriteControl tests remain green and their source files are unchanged by P1.
- main, PRs #145/#146/#147/#148, Cloudflare Workers, bindings, migrations, secrets, billing, and Production traffic remain unchanged.
- The final PR remains Draft until independent review is available; no merge is implied by P1 acceptance.

## Unresolved owner decisions

These choices affect externally visible behavior and must be confirmed before the corresponding task is implemented:

1. **Task scope object:** confirm whether the canonical shape is { repositories, allowedPaths, excludedPaths, allowedOperations } or provide another schema.
2. **State-transition matrix:** confirm the proposed transition table, especially recovery from BLOCKED, DISPUTED, and QUARANTINED.
3. **Lease policy:** select default lease duration and heartbeat interval; the reference adapter will accept explicit values until chosen.
4. **Retry policy:** select maximum attempts and backoff schedule for transient failures; permanent failures remain non-retryable.
5. **Audit retention:** select retention period and external checkpoint destination before any durable production adapter is designed.
6. **High-risk review threshold:** confirm which task risk levels require a distinct independent reviewer before COMPLETED.
7. **Agent-round interpretation:** confirm that the four-round cap counts one sender-to-recipient exchange as one round and is shared across retries and resumed executions.

No unresolved choice is silently treated as approved. P1 implementation must pause at the affected decision boundary rather than inventing policy.
