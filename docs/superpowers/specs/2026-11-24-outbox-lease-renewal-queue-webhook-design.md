# Outbox Lease Renewal and Queue/Webhook Delivery Design

**Status:** Proposed design; implementation blocked pending owner approval  
**Date:** 2026-11-24  
**Parent:** PR #462 — atomic Outbox receipt settlement  
**Parent head:** 2449e079792e0579632127b2ba6ff81643bf90f8  
**Design branch:** design/outbox-lease-queue-webhook-2026-11-24  
**Intended implementation base:** test/outbox-receipt-atomicity-2026-11-24 at the parent head above  
**Deployment policy:** Draft PR only; no merge, Worker update, Queue mutation, secret write, staging smoke, or production deployment is included.

## 1. Decision

Implement the two requested paths as one end-to-end transport boundary:

1. A durable Outbox lease lifecycle with one-time capability fencing and monotonic lease renewal.
2. A Cloudflare Durable Object alarm-driven Queue producer, Queue consumer, HTTPS webhook delivery, durable receipt settlement, and two-stage dead-letter handling.

The durable Outbox row remains the source of truth. Cloudflare Queues are an at-least-once transport, not the source of truth. A webhook success is not considered settled until the Ledger has atomically committed the receipt and the event's COMPLETED transition.

The design intentionally does not claim exactly-once external effects. A remote endpoint can accept a request and the sender can lose the response or fail before receipt settlement. The same stable event ID must therefore be used as the destination idempotency key. Cloudflare documents at-least-once delivery and recommends destination-side idempotency for this case ([delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)).

## 2. Evidence boundary and current-state findings

The following were inspected at the exact parent head, not inferred from the default branch:

- OrchestratorLedger already has enqueueOutbox, claimOutbox, failOutbox, completeOutbox, recordOutboxReceipt, and recordOutboxDeadLetter.
- claimOutbox assigns a worker, increments lease_generation, increments attempts, and sets a bounded lease. It has no Outbox lease renewal or per-delivery capability token.
- recordOutboxReceipt atomically inserts a receipt and completes the matching active generation. It currently has no token fence against simultaneous duplicate Queue deliveries using the same generation.
- worker.js exports only a fetch handler. It has no queue handler and does not call ORCHESTRATOR_LEDGER.
- wrangler.toml declares the Ledger Durable Object namespace but has no Outbox Queue producer or consumer declarations.
- No production caller of enqueueOutbox was found in the inspected Worker/runtime path. This proposal wires the transport to the existing Ledger API; it does not invent a new public task/event ingress contract.
- PR #462 is Draft/Open/Unmerged and its exact head is the parent SHA above. Its parent CI is green, but its Full History Secret Scan remains a separate repository-wide blocker (13 historical findings were reported in the parent PR evidence).

A fresh, read-only Cloudflare account inventory showed these six existing Queues, each with zero producers and zero consumers:

| Environment | Main queue | Dead-letter queue | Quarantine queue |
|---|---|---|---|
| Production | chat-gpt111-orchestrator-outbox | chat-gpt111-orchestrator-outbox-dlq | chat-gpt111-orchestrator-outbox-dlq-quarantine |
| Staging | chat-gpt111-staging-orchestrator-outbox | chat-gpt111-staging-orchestrator-outbox-dlq | chat-gpt111-staging-orchestrator-outbox-dlq-quarantine |

The currently deployed chat-gpt111 and chat-gpt111-staging Worker settings do not have an ORCHESTRATOR_LEDGER binding or Queue bindings. The inspected deployed secret-name lists also do not include LEDGER_WORKER_ASSERTION_KEYS, OUTBOX_WEBHOOK_URL, or OUTBOX_WEBHOOK_HMAC_KEY. No secret values were read.

All Cloudflare inspection was read-only. No Queue object, consumer, producer, Worker setting, secret, deployment, or route was changed.

## 3. Architecture

### 3.1 Durable Outbox + DO Alarm relay

Use the owning OrchestratorLedger instance as the dispatch authority. The producer runs from that Durable Object's alarm() method and sends through a Queue producer binding on this.env. Cloudflare documents direct Queue publishing from a Durable Object and demonstrates including this.ctx.id.toString() in the Queue message for routing back to the same object ([Queues from Durable Objects](https://developers.cloudflare.com/queues/examples/use-queues-with-durable-objects/)).

Do not use a global Cron poller: the inspected code has no authoritative registry for enumerating all Ledger object IDs. Do not send directly from the user-facing enqueue call as the only delivery mechanism: that creates a SQL-commit/Queue-send dual-write gap.

**Wake-up invariant:** every transition that creates or reschedules dispatchable Outbox work must update the next Durable Object alarm in the same storage transaction as the corresponding SQL state change. Cloudflare states that alarm operations follow the Storage API rules, that each Durable Object has one alarm, and that SQLite transactionSync includes synchronous storage operations. This exact SQL-plus-alarm behavior is a mandatory runtime characterization test before implementation can pass ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Storage API transaction semantics](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/durable-objects/api-storage-other-methods.mdx)).

The scheduler computes the earliest of:
- the next due PENDING/READY or PENDING/RETRY_WAIT event;
- the next IN_PROGRESS lease expiry.

It sets one alarm for that time, or deletes the alarm if no dispatchable/recoverable Outbox row remains. The scan is local to the owning Ledger object; there is no global Durable Object enumeration.

When enqueueOutbox inserts a new row, it schedules the alarm as part of the same synchronous storage transaction. Idempotent enqueue replay also recomputes the alarm so a previous missed wake-up can be repaired. claimOutbox, lease renewal, failure settlement, receipt settlement, and dead-letter settlement recompute the next alarm after their state transitions.

The alarm handler claims one due row at a time, creates a signed fixed-principal publisher assertion, and sends a minimal versioned Queue envelope. The claim transaction schedules the lease-expiry watchdog before the external Queue send occurs. If Queue send fails, the publisher attempts a token-fenced failOutbox transition to durable retry state. If the process fails between claim and send, the existing lease-expiry alarm reclaims the row. If Queue send succeeds but the producer cannot observe/finish the call, a later lease reclaim can publish a duplicate; consumer fencing and destination idempotency handle this at-least-once case.

Cloudflare confirms a resolved Queue.send() means the message has been written to disk ([Queue JavaScript API](https://developers.cloudflare.com/queues/configuration/javascript-apis/)). This is not a distributed transaction with SQLite; the recovery mechanism is deliberate at-least-once replay.

### 3.2 Queue envelope and deterministic routing

Version 1 Queue envelope:

~~~json
{
  "schemaVersion": 1,
  "ledgerObjectId": "<DurableObjectId.toString()>",
  "eventId": "<stable-outbox-event-id>",
  "leaseGeneration": 1,
  "leaseToken": "<256-bit-random-capability>"
}
~~~

The Queue message contains no webhook URL and no caller-controlled routing destination. The consumer validates the exact schema, then obtains the owning object through env.ORCHESTRATOR_LEDGER.idFromString(ledgerObjectId). The DO ID is supplied by the Ledger that produced the message, not reconstructed from untrusted tenant/project selectors.

The envelope is intentionally small. The consumer retrieves the authoritative event payload from the Ledger only after proving possession of the current lease token.

### 3.3 Capability-fenced lease lifecycle

Add an additive Ledger schema migration after the current schema version 10:

- lease_token_hash TEXT, nullable for legacy rows and non-active leases.
- Do not persist the plaintext token in SQLite, logs, receipts, or dead-letter archives.

For each successful claimOutbox:
1. Generate a cryptographically random 256-bit token.
2. Persist only its SHA-256 digest with the new lease generation.
3. Return the plaintext token only to the trusted alarm producer so it can be placed in the internal Queue envelope.
4. Keep the existing publisher lease owner and generation checks.

Add renewOutboxLease with this contract:

- fixed consumer principal: orchestrator-outbox-consumer;
- assertion role/operation: consumer / renewOutboxLease;
- require exact event ID, lease owner, generation, current token digest, IN_PROGRESS state, and lease_until > now;
- reject expired leases; renewal must never resurrect an expired lease;
- require bounded positive leaseMs <= MAX_LEASE_MS;
- set lease_until = max(current_lease_until, now + leaseMs);
- rotate the capability token in the same transactionSync transaction and return the new plaintext token only to the successful caller;
- consume the assertion JTI in the same transaction as the token rotation.

The generation is unchanged by renewal. Only a successful reclaim increments the generation. This keeps generation as a claim/reclaim epoch and the random token as a one-time delivery capability.

**Duplicate-delivery fence:** when two consumers receive the same Queue message concurrently, both initially hold the same token. The first successful renewal rotates the stored hash. The second must fail with LEASE_TOKEN_MISMATCH and must not issue an HTTPS request. This is stronger than generation-only fencing and directly tests the duplicate-delivery race.

Extend recordOutboxReceipt to require the current lease token in addition to the existing source metadata and generation checks. Its receipt insert, event completion, token invalidation, assertion-JTI consumption, and next-alarm recalculation remain one SQLite transaction.

Extend failOutbox to require the current token and exact active lease. It must distinguish the authenticated actor from the lease owner:
- publisher actor for Queue send failure;
- consumer actor for webhook/consumer settlement.

Only the two fixed actor/role pairs are permitted. Failure settlement clears the token. Retryable failures schedule the existing bounded exponential retry (1s base, 15m cap, 8 attempts); permanent failures move the durable Outbox row to DEAD_LETTER. The Queue message is acknowledged after the Ledger has durably accepted the retry/dead-letter decision, preventing Queue retries from reusing a now-invalid token.

The Queue DLQ archiver also checks the original envelope token and generation. It may terminalize the source row only when that exact capability is still current. A stale DLQ message can be archived but cannot change a newer lease. The persisted archive body must redact the plaintext leaseToken; its stored body hash is calculated over the original pre-redaction envelope.

### 3.4 HTTPS webhook contract

The destination is a fixed deployment-time configuration, never a URL from Queue content or MCP arguments.

Required settings:
- OUTBOX_WEBHOOK_URL: configured HTTPS URL with no username/password or fragment;
- OUTBOX_WEBHOOK_HMAC_KEY: base64url-encoded random key of at least 256 bits;
- LEDGER_WORKER_ASSERTION_KEYS: existing Worker-assertion signing key set required by the Ledger boundary.

Fail closed when any setting is missing or invalid. Do not create or modify secrets in this PR.

Outbound body is canonical JSON containing the versioned event envelope and source metadata. Required headers:
- Idempotency-Key: <eventId>
- X-Outbox-Timestamp: <Unix-seconds>
- X-Outbox-Signature: v1=<hex-HMAC-SHA256>

The HMAC input is exactly v1, a newline, timestamp, a newline, and rawBody. The destination must verify the HMAC and a bounded freshness window. For the same Idempotency-Key and same body, the destination must return 2xx for both first acceptance and duplicate acceptance. Reuse of the same key with a different body must return a permanent conflict (409).

Use a bounded request timeout (proposed 20 seconds), redirect: manual, no caller-controlled URL, and no token forwarding. Never log request bodies, capability tokens, HMAC keys, or response bodies.

Response policy:
- 2xx: submit a token-fenced recordOutboxReceipt; the event is complete only after that Ledger transaction succeeds.
- 408, 425, 429, 5xx, network errors, and timeout: token-fenced retryable failOutbox.
- other 4xx, 3xx, malformed configuration, or idempotency conflict: permanent failOutbox and durable DEAD_LETTER state.
- If the remote endpoint accepted the event but the client cannot commit the receipt, the event will be replayed after lease expiry with the same event ID. No exactly-once external side-effect claim is made.

The destination implementation itself is outside this repository's inspected scope and has not been selected or verified. This design defines the outbound contract, not proof that a real receiver implements it.

### 3.5 Queue consumers and dead-letter topology

Use the six existing Queue names; do not create new Queue resources.

Proposed Wrangler source configuration, mirrored for production and staging:
- Producer binding from the owning Ledger to the environment's main Outbox Queue.
- Main Queue consumer: max_batch_size = 1, bounded concurrency, max_retries = 3, DLQ set to the environment's Outbox DLQ.
- DLQ consumer: max_batch_size = 1, max_retries = 3, dead-letter destination set to the environment's quarantine Queue.
- Quarantine Queue has no automatic consumer in this first iteration; it is a manual forensic boundary.

The Worker's queue(batch, env, ctx) handler dispatches based on the actual batch queue name and processes messages individually. It explicitly acknowledges a message only after the Ledger has durably committed receipt, retry, dead-letter, or archive state. A stale token/generation is acknowledged as obsolete; transient infrastructure failures before a durable Ledger decision use Queue retry. Cloudflare supports per-message ack()/retry() so one failed message need not redeliver unrelated batch entries ([batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)).

The main Queue is a transport retry layer. Known webhook failures use the Ledger's own retry schedule and the original Queue message is acknowledged after durable scheduling. The platform DLQ is for messages the consumer cannot safely process or durably archive. The DLQ archiver persists the original envelope hash and a redacted body in the owning Ledger. If archival fails repeatedly, Cloudflare routes the message to quarantine.

The currently inspected Quarantine Queues have a one-day retention period and no consumer. That is not adequate evidence of long-term forensic retention. Before live activation, an operator must approve either a longer retention policy (Cloudflare Queue permits up to 14 days) or an independent durable export/archive for quarantine. This PR must not mutate that policy.

## 4. Security and failure invariants

1. An expired lease can never be renewed or settled.
2. A worker with a stale generation cannot renew, fail, receipt, or dead-letter a newer claim.
3. A duplicate Queue delivery holding a rotated token cannot begin webhook delivery.
4. A plaintext lease token exists only in trusted runtime memory and the internal Queue envelope; never in Ledger SQL, logs, webhook headers, HMAC input metadata beyond the event generation, receipts, or persisted DLQ body.
5. Queue message routing never uses a caller-provided URL or tenant/project path to select a webhook destination.
6. Queue send is never performed inside a SQL transaction.
7. Every due/recoverable Outbox event has a durable next alarm in the same storage transaction as the state change; this is verified with a Cloudflare Workers runtime test, not inferred from a local mock.
8. Receipt completion and token invalidation are atomic.
9. External webhook retry uses stable eventId idempotency; duplicate external effects remain possible unless the receiver durably deduplicates.
10. Missing signing keys, webhook configuration, DO binding, or Queue binding fail closed; no unauthenticated fallback is allowed.

## 5. TDD and adversarial verification plan

### Lease/transaction tests
- active lease renewal succeeds for exact owner, generation, and current token;
- renewal never shortens an existing lease;
- renewal leaves generation and attempts unchanged;
- wrong owner, wrong generation, wrong token, consumed assertion, expired lease, and completed/dead-lettered event are rejected;
- two concurrent renewals using the same token produce exactly one winner;
- stale generation after reclaim cannot renew/fail/receipt;
- token rotation and assertion-JTI consumption roll back together on SQLite failure;
- receipt settlement clears token and atomically marks completion;
- migration from v10 preserves old rows while legacy active rows with no token remain untrusted until safely reclaimed.

### Alarm/producer tests
- enqueue inserts row and schedules alarm;
- a forced transaction abort after setAlarm leaves neither the row nor alarm;
- repeated enqueue idempotency repairs/recalculates the wake-up;
- one Durable Object alarm selects the earliest due/expiry across multiple rows;
- claim schedules lease expiry before Queue send;
- Queue send success, send failure, and crash-window simulations all lead to a durable retry or expiry wake-up;
- alarm reschedules after bounded processing and does not hot-loop on empty work;
- no global scan or unbounded batch is introduced.

### Consumer/webhook tests
- actual queue handler routes to the exact originating Durable Object ID;
- malformed or wrong-version envelope is rejected and eventually reaches the configured DLQ;
- stale duplicate token is acknowledged without issuing fetch;
- successful HTTP response is not complete until the receipt transaction succeeds;
- all response classes follow the matrix above;
- redirect is not followed;
- timeout/network error schedules Ledger retry;
- HMAC byte sequence, timestamp, and signature are asserted against independently derived fixtures;
- webhook request contains the stable event ID idempotency key and never contains the lease token;
- repeated accepted event uses the same idempotency key;
- no endpoint is read from message content.

### DLQ/quarantine tests
- archive hash is checked against the original envelope before redaction;
- persisted body contains no leaseToken;
- archive replay is idempotent and conflicting message IDs are rejected;
- only an exact current token/generation can terminalize the source event;
- stale or malformed envelopes cannot mutate a newer event generation;
- archiver failure routes to quarantine; quarantine retention remains an explicit operational blocker.

### Mutation controls

At least the following mutants must be killed by tests:
- remove lease expiry predicate;
- remove worker/generation predicate;
- skip token comparison;
- stop rotating the token;
- permit renewal after expiry;
- allow lease shortening;
- omit alarm scheduling in enqueue/claim/renew/fail/receipt transitions;
- accept webhook 3xx or 5xx as success;
- follow redirect;
- omit HMAC verification/signature or stable Idempotency-Key;
- persist plaintext token in DLQ archive;
- allow stale DLQ capability to terminalize a newer generation.

Exact-head CI must include Node tests, Cloudflare Workers Vitest, syntax checks, npm audit, Wrangler production/staging dry-runs, and PR-diff secret scanning. Full-history secret findings remain a separate release gate. No staging smoke or live Queue delivery is allowed in this implementation PR.

## 6. Rollout, rollback, and release gates

### Implementation PR boundaries

- Child branch from the exact PR #462 head above.
- One combined Draft PR based on test/outbox-receipt-atomicity-2026-11-24.
- Additive schema migration after v10; no destructive data migration.
- Add tests before production implementation and observe the expected red phase.
- Do not merge or deploy.

### Live activation blockers

Live activation is prohibited until all of the following are deliberately resolved:
1. Configure and verify ORCHESTRATOR_LEDGER, producer, and consumer bindings in the intended Worker environment.
2. Provision LEDGER_WORKER_ASSERTION_KEYS, OUTBOX_WEBHOOK_URL, and OUTBOX_WEBHOOK_HMAC_KEY through an approved secret-management path.
3. Select and independently verify the HTTPS receiver's HMAC and idempotency implementation.
4. Approve quarantine retention/export policy; current quarantine Queue retention is one day.
5. Identify the authenticated application caller that writes to enqueueOutbox. No production caller was found in the inspected Worker/runtime path.
6. Resolve the independent full-history secret-scan blocker.

### Rollback

- Revert the implementation commit/configuration only after pausing new Queue consumption and recording in-flight message IDs.
- Keep additive schema columns; the previous code can ignore the nullable token-hash column.
- Do not delete Queue objects or purge messages.
- In-flight leases expire and must be reconciled by generation; never clear leases with an un-fenced bulk update.
- A rollback does not reverse an external webhook side effect. Destination idempotency remains required across retries and deployments.

## 7. Alternatives rejected

| Alternative | Reason for rejection |
|---|---|
| Lease renewal only, then later Queue integration | Leaves the actual producer/consumer and webhook boundary unproven, contrary to the approved combined scope. |
| Direct Queue send as the only action after SQL enqueue | A crash between SQL commit and Queue send can strand a durable event. |
| Global Cron polling all Ledger objects | No authoritative object-ID registry or enumeration mechanism exists in the inspected runtime. |
| Generation-only duplicate protection | Concurrent duplicate Queue messages can share the same active generation; one-time token rotation is required. |
| Claiming exactly-once webhook effects | Queue is at-least-once and a remote accept/receipt-commit ambiguity cannot be eliminated without receiver-side durable idempotency. |

## 8. Approval boundary

This document proposes the combined architecture and the above fixed contracts. It does not implement code, create a Queue binding in Cloudflare, configure secrets, select a real webhook destination, add a public task/event ingress, merge, or deploy.

Owner approval is required for this design document before the implementation plan and TDD code changes are created.
