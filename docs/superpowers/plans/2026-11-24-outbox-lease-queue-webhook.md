# Outbox Lease Renewal and Queue/Webhook Delivery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task after owner approval. Steps use checkbox syntax for tracking.

**Goal:** Complete the existing Ledger Outbox transport as one coherent workflow: durable lease capabilities, alarm-based publication, encrypted Queue delivery, authenticated HTTPS webhook processing, receipt settlement, and DLQ archival.

**Architecture:** The owning SQLite-backed `OrchestratorLedger` remains the source of truth and schedules its next Durable Object Alarm atomically with Outbox SQL state. The Alarm claims a row and publishes a minimal AES-256-GCM encrypted capability envelope to the existing environment Queue. The Queue consumer routes to the exact originating Ledger, atomically rotates the one-time capability before external I/O, posts a signed webhook using the stable event ID as idempotency key, and commits either a receipt or a bounded retry/dead-letter decision. Cloudflare Queue delivery and remote HTTP effects remain at-least-once; no exactly-once external-effect claim is made.

**Tech Stack:** Node.js >=22, JavaScript ES modules, Cloudflare Workers, SQLite-backed Durable Objects, Wrangler 4.155.0, Vitest 4.1.12, `@cloudflare/vitest-plugin` 1.4.11, Web Crypto, existing GitHub Actions CI. No dependency additions planned.

**Spec:** `docs/superpowers/specs/2026-11-24-outbox-lease-renewal-queue-webhook-design.md`

## Global Constraints

- Parent PR #462 exact head: `2449e079792e0579632127b2ba6ff81643bf90f8`.
- Implementation branch: `implementation/outbox-lease-queue-webhook-2026-11-24`; intended child Draft PR base: `test/outbox-receipt-atomicity-2026-11-24`, never `main`.
- Preserve `main`, PR #462, all live Cloudflare Queue objects, deployed Worker settings, bindings, secrets, routes, staging, and production. No live Cloudflare API writes are authorized by this plan.
- Keep all code, identifiers, comments, documentation, schema fields, logs, branch names, and commit messages in English.
- Preserve `MAX_LEASE_MS = 86_400_000`, `MAX_OUTBOX_ATTEMPTS = 8`, `OUTBOX_RETRY_BASE_MS = 1_000`, and `OUTBOX_RETRY_MAX_MS = 900_000`.
- Use a 60,000 ms consumer lease and 20,000 ms HTTPS timeout; timeout must remain strictly below the active lease.
- Use queue `max_batch_size = 1`, `max_retries = 3`, and initial `max_concurrency = 4` as a conservative implementation setting, not as a destination throughput guarantee.
- Add only the existing six Queue names. Quarantine has no consumer.
- SQLite stores only SHA-256 token digests. Queue messages carry only AES-256-GCM ciphertext, never plaintext capability tokens.
- Use `ctx.storage.transaction(async () => { ...ctx.storage.sql.exec(...); await ctx.storage.setAlarm(...); })` when SQL and Alarm state must commit together. Do not use `transactionSync()` for awaited Alarm operations. Keep Web Crypto, Queue sends, and HTTP fetch outside storage transactions.
- Preserve the existing event producers: `transitionTask(outboxEvent)` and owner `release`. Do not invent a new public event-ingress endpoint.
- Keep secrets and destination URLs deployment-configured. Reject missing or malformed configuration; do not read, create, update, or delete secret values.
- No merge, deployment, staging smoke, or real Queue/webhook delivery.
- The full-history secret scan findings recorded in PR #462 remain a separate repository-wide release blocker.

## Review Focus

1. **Queue envelope attacks:** unknown fields, unsupported versions, invalid DO IDs, unknown key IDs, malformed IVs, changed ciphertext, and AAD mismatch must never issue webhook fetch. Covered by Tasks 5–7.
2. **Lease boundaries:** equality at `lease_until === now`, expired or reclaimed generations, maximum duration, and renewal shortening must fail closed. Covered by Tasks 1, 3, and 4.
3. **Duplicate and ambiguous delivery:** only one duplicate delivery may rotate a current token; after remote 2xx with failed receipt settlement, replay must retain the same event ID idempotency key. Covered by Tasks 3, 4, 7, and 8.
4. **HTTP response semantics:** 3xx, permanent 4xx, 408/425/429, 5xx, timeout, network failure, and malformed configuration must follow the response matrix without leaking secrets. Covered by Tasks 5 and 7.
5. **Legacy rows and Alarm atomicity:** migrated v10 rows without token hashes remain untrusted until reclaimed; failed Alarm writes roll back corresponding Outbox SQL mutations. Covered by Tasks 1 and 2.

---

### Task 1: Add the v11 Lease Capability Schema and Claim Token

**Files**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-lease-capability.test.js`

**Interfaces**
- Consumes: current `claimOutbox({ workerId, workerAssertion, leaseMs, now })`, schema v10.
- Produces: schema v11 with nullable `lease_token_hash`; successful claim returns a one-time `leaseToken` to trusted runtime memory only. `outboxFromRow()` must never expose the token or hash.

- [ ] **Step 1 — Write failing tests**
  - `claimOutbox_mints_random_capability_and_persists_only_digest`: 32 random bytes encoded base64url; independently compute SHA-256 and compare with persisted `lease_token_hash`; assert plaintext is absent from SQL.
  - `claimOutbox_reclaim_rotates_capability_and_generation`: expire generation 1, reclaim, assert generation 2 and a different token/hash.
  - `schema_v11_preserves_legacy_rows_without_trusting_missing_capability`: migrate a v10 active row; assert token hash is null and the row cannot be completed/renewed on that missing capability.

- [ ] **Step 2 — Verify RED**
  Run from `cloud-engineering-connector/`:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-lease-capability.test.js`
  Expected: assertion failures for absent v11 token state, not test setup/runtime errors.

- [ ] **Step 3 — Implement**
  Add the additive v11 migration. Generate 32 bytes using `crypto.getRandomValues`, encode base64url, hash with SHA-256 before the SQL transaction, and persist only the digest with the claimed generation. Return the raw token only from a successful claim. Clear token hashes when a claim is terminalized at max attempts. Do not add token fields to `outboxFromRow()`.

- [ ] **Step 4 — Verify GREEN**
  Re-run the focused test. Expected: all three capability and migration tests pass.

- [ ] **Step 5 — Regression tests**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-tenant-fencing.test.js cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js`
  Expected: prior generation and receipt behavior remains green.

- [ ] **Step 6 — Commit**
  `git add cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-lease-capability.test.js`
  `git commit -m "feat: persist Outbox lease capability digests"`

---

### Task 2: Atomically Couple Outbox State to Its Durable Object Alarm

**Files**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-alarm-atomicity.test.js`

**Interfaces**
- Consumes: v11 schema and existing writers `enqueueOutbox`, `claimOutbox`, `failOutbox`, `completeOutbox`, `recordOutboxReceipt`, `recordOutboxDeadLetter`, `transitionTask(outboxEvent)`, and `executeOwnerCommand(release|cancel|quarantine)`.
- Produces: one private `scheduleNextOutboxAlarmInTransaction()` helper. Each transition that changes due/recoverable work recalculates the next Alarm inside the same asynchronous storage transaction.

- [ ] **Step 1 — Write failing tests**
  - `enqueueOutbox_commits_event_and_alarm_together`: assert row persistence and earliest due alarm.
  - `alarm_write_failure_rolls_back_outbox_sql_mutation`: inside an explicit async storage transaction, perform an Outbox SQL write and force `setAlarm()` to reject with an invalid scheduled time; assert the SQL write rolled back and no alarm persisted.
  - `transitionTask_outbox_and_owner_release_schedule_alarm`: exercise the existing internal producers and assert the Ledger Alarm is scheduled.
  - `scheduler_selects_earliest_due_or_expiring_event`: combine READY, RETRY_WAIT, and IN_PROGRESS rows; assert the minimum next-attempt/lease-expiry time; assert no eligible rows delete the Alarm.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-alarm-atomicity.test.js`
  Expected: alarm assertions fail because Outbox writers do not schedule durable wake-ups.

- [ ] **Step 3 — Implement**
  Compute the earliest due time from `PENDING/READY`, `PENDING/RETRY_WAIT`, and `IN_PROGRESS` lease expiry. Use `ctx.storage.transaction(async () => { SQL operations; await ctx.storage.setAlarm(nextAt); })` or `deleteAlarm()`; do not wrap an awaited Alarm call in `transactionSync()`. For SQLite-backed DOs, use direct `ctx.storage.sql.exec()` inside the explicit transaction. Convert the affected Outbox writer transactions to the async form, including internal task transition and owner-command paths. Never await crypto, Queue, or webhook operations inside the transaction.

- [ ] **Step 4 — Verify GREEN**
  Run the focused Alarm atomicity test. Expected: SQL mutation and Alarm commit together; forced Alarm failure rolls back SQL.

- [ ] **Step 5 — Regression tests**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js cloudflare-test/orchestrator-ledger-outbox-tenant-fencing.test.js cloudflare-test/orchestrator-ledger-readiness.test.js`
  Expected: receipt, tenant, and Ledger readiness suites remain green.

- [ ] **Step 6 — Commit**
  `git add cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-alarm-atomicity.test.js`
  `git commit -m "feat: schedule Outbox alarms atomically"`

---

### Task 3: Implement One-Time, Monotonic Outbox Lease Renewal

**Files**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/orchestrator-worker-identity.js`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-lease-capability.test.js`

**Interfaces**
- Consumes: v11 token hash, async Alarm scheduler.
- Produces: `renewOutboxLease({ eventId, leaseOwnerId, leaseGeneration, leaseToken, consumerId, workerAssertion, leaseMs, now })`.
- `leaseOwnerId` remains the fixed publisher owner `orchestrator-outbox-publisher`; the signed consumer principal `orchestrator-outbox-consumer` is a separate identity. The row's `lease_worker_id` is compared to `leaseOwnerId`, never to the consumer ID.
- Success: `{ renewed: true, eventId, leaseOwnerId, leaseGeneration, leaseUntil, leaseToken, event }`.
- Failures: `AUTHENTICATED_WORKER_REQUIRED`, `LEASE_FENCE_MISMATCH`, `LEASE_TOKEN_MISMATCH`.

- [ ] **Step 1 — Write failing tests**
  - `renewOutboxLease_requires_active_owner_generation_and_token`: reject wrong owner/generation/token, non-IN_PROGRESS state, and `lease_until <= now`.
  - `renewOutboxLease_extends_monotonically_without_changing_attempts_or_generation`: assert deadline equals `max(previousLeaseUntil, now + leaseMs)`, attempts/generation unchanged.
  - `renewOutboxLease_rotates_capability_and_rejects_replay`: old token is rejected after a successful renewal.
  - `renewOutboxLease_serializes_concurrent_reuse_of_same_token`: two concurrent calls with same token produce exactly one success.
  - `renewOutboxLease_rejects_assertion_jti_replay`: one signed assertion cannot renew twice.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-lease-capability.test.js`
  Expected: renewal assertions fail because the method and signer permission do not exist.

- [ ] **Step 3 — Implement**
  Add only `orchestrator-outbox-consumer / consumer / renewOutboxLease` to the fixed signer policy. Require exact lease owner, generation, token digest, IN_PROGRESS, and `lease_until > now`. Enforce `1 <= leaseMs <= MAX_LEASE_MS`. Generate/hash the replacement token before entering the storage transaction, then atomically consume the JTI, rotate the digest, apply monotonic deadline extension, and recalculate the next Alarm. Return plaintext replacement token only to the authenticated caller in memory.

- [ ] **Step 4 — Verify GREEN**
  Re-run the focused lease-capability test. Expected: expiry, monotonicity, single-winner rotation, and assertion-replay cases pass.

- [ ] **Step 5 — Commit**
  `git add cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/orchestrator-worker-identity.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-lease-capability.test.js`
  `git commit -m "feat: add fenced Outbox lease renewal"`

---

### Task 4: Fence Failure and Receipt Settlement with the Current Capability

**Files**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/orchestrator-worker-identity.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-token-settlement.test.js`
- Modify: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js`

**Interfaces**
- `failOutbox({ eventId, leaseOwnerId, leaseGeneration, leaseToken, actorId, workerAssertion, retryable, errorCode, now })`; `actorId` is permitted only as exact fixed publisher or consumer principal with its corresponding signed role.
- `recordOutboxReceipt()` receives the current `leaseOwnerId`, `leaseGeneration`, and `leaseToken` in addition to existing receipt source metadata.
- Receipt insertion, COMPLETED transition, token invalidation, JTI consumption, and next Alarm recalculation commit atomically.

- [ ] **Step 1 — Write failing tests**
  - `recordOutboxReceipt_rejects_stale_and_wrong_capabilities`.
  - `recordOutboxReceipt_atomically_completes_and_invalidates_token`.
  - `recordOutboxReceipt_rolls_back_receipt_completion_token_and_jti_on_sql_abort`.
  - `failOutbox_accepts_only_fixed_publisher_or_consumer_assertions`.
  - `failOutbox_clears_token_and_schedules_retry_or_dead_letter`.
  - `stale_generation_cannot_fail_or_receipt_after_reclaim`.
  Assertions include receipt count 0 on rejection, `lease_token_hash IS NULL` after settlement, `status = 'COMPLETED'` after receipt, existing backoff bounds, and `retry_state = 'DEAD_LETTER'` for permanent failure. The existing `status` column remains `PENDING` for dead-lettered retry state.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-token-settlement.test.js cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js`
  Expected: token and role fencing assertions fail against current methods.

- [ ] **Step 3 — Implement**
  Separate the authenticated actor from the lease owner. `actorId` is the signed fixed publisher or consumer principal; `leaseOwnerId` is the persisted publisher owner `orchestrator-outbox-publisher`. Verify only the exact fixed actor/role/operation combinations; compare row `lease_worker_id` to `leaseOwnerId`, plus generation, token hash, active state, and expiry. Clear token hash on retry/permanent failure/receipt. Keep matching completed receipt replay idempotent without reviving a lease. Recalculate Alarm in the same async transaction.

- [ ] **Step 4 — Verify GREEN**
  Run focused settlement tests. Expected: only the current capability can settle; SQL abort leaves no partial receipt, state, token, Alarm, or JTI mutation.

- [ ] **Step 5 — Regression and commit**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-tenant-fencing.test.js cloudflare-test/orchestrator-ledger-outbox-receipt-scope.test.js cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js`
  Then commit:
  `git add cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/orchestrator-worker-identity.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-token-settlement.test.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-atomic-receipt.test.js`
  `git commit -m "feat: fence Outbox settlement by lease capability"`

---

### Task 5: Implement Capability Encryption and Signed HTTPS Request Construction

**Files**
- Create: `cloud-engineering-connector/orchestrator-outbox-webhook.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-outbox-webhook-crypto.test.js`

**Interfaces**
- `encryptOutboxCapability({ ledgerObjectId, eventId, leaseGeneration, leaseToken }, env)`
- `decryptOutboxCapability(envelope, env)`
- `buildOutboxWebhookRequest({ event, env, now })`
- `classifyOutboxWebhookResponse(status)`
- AES-256-GCM: 32-byte key, 12-byte random IV, 128-bit tag. AAD exactly `v1\n{ledgerObjectId}\n{eventId}\n{leaseGeneration}\n{keyId}`.
- Webhook timeout 20,000 ms; redirect policy `manual`.

- [ ] **Step 1 — Write failing tests**
  - `encryptOutboxCapability_hides_plaintext_and_authenticates_routing_metadata`: valid decrypt; changing DO ID, event ID, generation, key ID, IV, or ciphertext fails authentication.
  - `decryptOutboxCapability_rejects_unknown_key_and_malformed_nonce`.
  - `buildOutboxWebhookRequest_signs_exact_raw_body_and_stable_event_id`: independently compute HMAC and assert `Idempotency-Key`, timestamp, signature.
  - `buildOutboxWebhookRequest_rejects_non_https_credentials_and_fragments`.
  - `classifyOutboxWebhookResponse_separates_retryable_and_permanent_statuses`.
  - `webhook_request_never_contains_capability_or_key_material`.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-outbox-webhook-crypto.test.js`
  Expected: helper exports/behavior are absent.

- [ ] **Step 3 — Implement**
  Strictly parse `OUTBOX_QUEUE_ENCRYPTION_KEYS` and active key ID; allow one active key and at most one previous decrypt-only key. Validate HTTPS URL without credentials or fragment. Build canonical JSON once and HMAC-SHA256 over `v1\n{timestamp}\n{rawBody}`. Construct fetch with `redirect: 'manual'` and `AbortSignal.timeout(20_000)`. Never log request/response bodies, capability tokens, or key values.

- [ ] **Step 4 — Verify GREEN and commit**
  Re-run the focused crypto test, then:
  `git add cloud-engineering-connector/orchestrator-outbox-webhook.js cloud-engineering-connector/cloudflare-test/orchestrator-outbox-webhook-crypto.test.js`
  `git commit -m "feat: encrypt Outbox capabilities and sign webhook requests"`

---

### Task 6: Add the Durable Object Alarm Publisher

**Files**
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-alarm-publisher.test.js`

**Interfaces**
- Consumes: Alarm scheduler, claim capability issuance, capability encryption, fixed publisher assertion, and token-fenced publisher `failOutbox`.
- Produces: `OrchestratorLedger.alarm()`, bounded to 8 claims per invocation; sends a v1 encrypted Queue envelope with `ledgerObjectId = this.ctx.id.toString()`.

- [ ] **Step 1 — Write failing tests**
  - `alarm_publishes_encrypted_v1_envelope_with_originating_do_id`.
  - `alarm_persists_lease_watchdog_before_queue_send`.
  - `alarm_queue_send_failure_commits_retry_and_new_alarm`.
  - `alarm_crash_after_claim_recovers_through_lease_expiry`.
  - `alarm_bounds_dispatch_and_reschedules_remaining_work`.
  Use the documented Cloudflare Vitest `runDurableObjectAlarm(stub)` helper; assert Queue send occurs only after the lease and expiry Alarm are durable. Assert serialized Queue body never contains the plaintext token.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-alarm-publisher.test.js`
  Expected: no `alarm()` publisher currently exists.

- [ ] **Step 3 — Implement**
  Validate required bindings/config before claiming. Use fixed publisher identity `orchestrator-outbox-publisher` and `LEDGER_WORKER_ASSERTION_KEYS` plus active KID. Claim at most 8 rows. Encrypt each token before calling `this.env.OUTBOX_QUEUE.send(envelope)`. Queue send stays outside the storage transaction. On send failure call token-fenced publisher failure. Recalculate or preserve the earliest pending/lease-expiry Alarm before returning.

- [ ] **Step 4 — Verify GREEN and commit**
  Re-run focused alarm-publisher test, then:
  `git add cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-alarm-publisher.test.js`
  `git commit -m "feat: publish Outbox events from Durable Object alarms"`

---

### Task 7: Implement the Main Queue Consumer and Worker Queue Handler

**Files**
- Create: `cloud-engineering-connector/orchestrator-outbox-consumer.js`
- Modify: `cloud-engineering-connector/worker.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-outbox-queue-consumer.test.js`

**Interfaces**
- `consumeOutboxBatch(batch, env, ctx)`.
- Worker default export adds `async queue(batch, env, ctx)`.
- Deterministic routing: `env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromString(envelope.ledgerObjectId))`.
- Main message ack occurs only after durable receipt, retry/dead-letter decision, or verified stale/completed no-op.

- [ ] **Step 1 — Write failing consumer tests**
  - `queue_handler_routes_to_exact_originating_ledger_and_settles_after_receipt`.
  - `queue_handler_rotates_capability_before_webhook_fetch`.
  - `queue_handler_stale_duplicate_never_calls_fetch`.
  - `queue_handler_transient_http_failure_persists_retry_before_ack`.
  - `queue_handler_permanent_http_failure_persists_dead_letter_before_ack`.
  - `queue_handler_retries_if_ledger_decision_is_unavailable`.
  - `queue_handler_invalid_envelope_never_calls_fetch`.
  Use documented Cloudflare Vitest helpers `createMessageBatch`, `createExecutionContext`, and `getQueueResult`. Keep Ledger and Queue behavior real; stub only the external network fetch boundary.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-outbox-queue-consumer.test.js`
  Expected: current Worker has no `queue()` handler or consumer module.

- [ ] **Step 3 — Implement**
  Validate exact envelope fields/version, decrypt the capability, and resolve the exact DO ID. Sign fixed consumer assertions and call `renewOutboxLease()` before any HTTP request. Only a successful rotation may call fetch. On 2xx call `recordOutboxReceipt`; retryable statuses/network failures call consumer `failOutbox(retryable=true)`; permanent statuses call `failOutbox(retryable=false)`. Ack after a durable Ledger decision or verified stale no-op. Retry only when no durable decision could be made. Preserve existing `fetch()` behavior.

- [ ] **Step 4 — Verify GREEN and commit**
  Re-run focused consumer tests, then:
  `git add cloud-engineering-connector/orchestrator-outbox-consumer.js cloud-engineering-connector/worker.js cloud-engineering-connector/cloudflare-test/orchestrator-outbox-queue-consumer.test.js`
  `git commit -m "feat: consume Outbox queue with fenced webhook settlement"`

---

### Task 8: Implement Encrypted DLQ Archival and Quarantine Routing

**Files**
- Modify: `cloud-engineering-connector/orchestrator-outbox-consumer.js`
- Modify: `cloud-engineering-connector/orchestrator-ledger.js`
- Modify: `cloud-engineering-connector/orchestrator-worker-identity.js`
- Create: `cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-dlq-encrypted-archive.test.js`

**Interfaces**
- Consumes: original encrypted envelope, Queue DLQ message metadata, fixed archiver assertion, and Ledger `recordOutboxDeadLetter`.
- Produces: idempotent archive of exact original encrypted body; source mutation only when current owner/generation/token/expiry all match; DLQ consumer routes repeated archive failures to existing quarantine Queue.

- [ ] **Step 1 — Write failing tests**
  - `dlq_archiver_hashes_original_envelope_and_persists_ciphertext_only`.
  - `dlq_archiver_terminalizes_only_exact_current_capability`.
  - `dlq_archiver_stale_capability_archives_without_mutating_new_generation`.
  - `dlq_archiver_replay_is_idempotent_and_conflicts_are_rejected`.
  - `malformed_dlq_message_returns_retry_without_fabricating_do_route`; verify the Wrangler DLQ consumer's configured quarantine target separately in Task 9.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-ledger-outbox-dlq-encrypted-archive.test.js`
  Expected: current archiver stores message content but lacks encrypted capability fencing and exact source mutation rules.

- [ ] **Step 3 — Implement**
  Hash the exact original Queue body before normalization. Persist the encrypted envelope only. Decrypt the capability only in trusted runtime memory, and extend `recordOutboxDeadLetter()` to terminalize the source row only when exact lease owner, generation, token digest, and active expiry match. Stale capabilities may be archived idempotently but cannot mutate a newer generation. Main Queue DLQ consumer sends repeated archive failures to the pre-existing quarantine Queue.

- [ ] **Step 4 — Verify GREEN and commit**
  Re-run focused DLQ tests, then:
  `git add cloud-engineering-connector/orchestrator-outbox-consumer.js cloud-engineering-connector/orchestrator-ledger.js cloud-engineering-connector/orchestrator-worker-identity.js cloud-engineering-connector/cloudflare-test/orchestrator-ledger-outbox-dlq-encrypted-archive.test.js`
  `git commit -m "feat: archive fenced Outbox dead letters"`

---

### Task 9: Bind the Existing Production and Staging Queues in Wrangler

**Files**
- Modify: `cloud-engineering-connector/wrangler.toml`
- Modify: `cloud-engineering-connector/package.json`
- Test: `cloud-engineering-connector/cloudflare-test/orchestrator-outbox-queue-consumer.test.js`

**Interfaces**
- Consumes: `OUTBOX_QUEUE` producer binding, `queue()` handler, and existing `ORCHESTRATOR_LEDGER` binding.
- Produces: explicit environment-specific bindings for the six existing Queue resources only.

- [ ] **Step 1 — Add failing environment-routing assertions**
  - Main queue name delegates to the main consumer.
  - DLQ queue name delegates to the archiver.
  - Unknown queue name fails closed.
  - Queue names are never guessed from message content.

- [ ] **Step 2 — Verify RED**
  Run:
  `npm run test:do -- cloudflare-test/orchestrator-outbox-queue-consumer.test.js`
  Expected: configured environment routing is absent.

- [ ] **Step 3 — Implement Wrangler bindings**
  Preserve existing DO bindings/migrations. Add `OUTBOX_QUEUE` producer binding to each environment's main Queue. Add main consumer (`max_batch_size = 1`, `max_concurrency = 4`, `max_retries = 3`, existing DLQ target). Add DLQ consumer (`max_batch_size = 1`, `max_retries = 3`, existing quarantine target). Leave quarantine without a consumer. Add non-secret `OUTBOX_QUEUE_NAME` and `OUTBOX_DLQ_NAME` vars for both environments. Extend `check` script syntax validation for new modules. Do not add secret values/placeholders or create live Queue resources.

- [ ] **Step 4 — Verify GREEN**
  Run focused consumer tests, then `npm run check`.
  Expected: Worker syntax and both default/staging Wrangler dry-runs pass. Dry-run proves packaging/config syntax only; it does not prove deployed bindings or delivery.

- [ ] **Step 5 — Commit**
  `git add cloud-engineering-connector/wrangler.toml cloud-engineering-connector/package.json cloud-engineering-connector/cloudflare-test/orchestrator-outbox-queue-consumer.test.js`
  `git commit -m "config: bind existing Outbox queues in both environments"`

---

### Task 10: Mutation Controls, Full Verification, and Draft PR Evidence

**Files**
- All Task 1–9 files and tests.
- Create: `docs/superpowers/reports/2026-11-24-outbox-lease-queue-webhook-verification.md`
- Mutation controls must use disposable negative-control branches or a temporary isolated test workspace; never commit a broken mutant to the implementation branch.

- [ ] **Step 1 — Execute adversarial mutation controls**
  Each mutant must be killed by its named test:
  - Remove token-hash comparison → lease capability test fails.
  - Remove strict expiry predicate → expiry boundary test fails.
  - Stop token rotation → concurrent duplicate/replay test fails.
  - Omit Alarm recalculation → SQL/Alarm test fails.
  - Break AAD/decryption validation → tampered-envelope test fails.
  - Follow redirects or accept 3xx → HTTP classification test fails.
  - Omit HMAC or `Idempotency-Key` → independently computed signature/idempotency test fails.
  - Let a stale DLQ generation mutate a newer event → DLQ stale-capability test fails.

- [ ] **Step 2 — Verify no mutant remains**
  Run `git diff --check`, inspect the complete diff, and verify no deliberate mutation remains.

- [ ] **Step 3 — Run full test suite**
  Run `npm test`.
  Expected: Node and Cloudflare Workers Vitest suites exit 0 with zero failures.

- [ ] **Step 4 — Run repository checks**
  Run `npm run check`, `npm audit --audit-level=high`, and `git diff --check`.
  Expected: all commands exit 0. Report exact output and exit status; do not infer from prior runs.

- [ ] **Step 5 — Verify exact-head CI and security**
  Require the exact candidate head's Cloud Engineering Connector CI and PR-diff Gitleaks scan to complete successfully. Report full-history Gitleaks separately; previously observed 13 historical findings remain a release blocker until resolved. No staging smoke or deployment workflow may run.

- [ ] **Step 6 — Verify GitHub isolation**
  Confirm child branch descends from exact PR #462 head and child PR targets `test/outbox-receipt-atomicity-2026-11-24`. Confirm PR #462 and `main` remain unchanged. Keep child PR Draft/Open/Unmerged.

- [ ] **Step 7 — Commit verification report**
  Create the report with exact candidate SHA, CI run IDs, test counts, audit result, mutation outcomes, Gitleaks PR-diff/full-history results, and remaining UNKNOWNs. Then:
  `git add docs/superpowers/reports/2026-11-24-outbox-lease-queue-webhook-verification.md`
  `git commit -m "docs: record Outbox transport verification evidence"`

## Release Gates and Explicit Unknowns

- The real HTTPS destination has not been selected or verified; receiver HMAC validation and durable idempotency remain UNKNOWN.
- Deployed Worker bindings and secret names are not yet configured; no live bindings or secrets are modified by this plan.
- Existing Queue consumers currently have zero registrations; Wrangler source changes plus future deployment would be required to activate them.
- Quarantine Queues currently show 24-hour retention. Verify plan capability before requesting a retention change; otherwise an independent durable export/archive is required. No retention policy change is included.
- Existing internal Outbox producers are `transitionTask(outboxEvent)` and owner `release`; the inspected Worker `fetch` path does not invoke the Ledger. Verify the upstream invocation/actor path without inventing a public ingress.
- The parent PR #462's full-history secret-scan blocker remains independent of this branch.
- No exactly-once external side effects, production resilience, or real provider delivery may be claimed from local Workers Vitest evidence.

**Completion contract:** the implementation PR remains Draft/Open/Unmerged. Missing key material, absent destination, unverified receiver idempotency, failed runtime characterization, untested deployed bindings, quarantine retention gap, or full-history secret findings remain BLOCKED/UNKNOWN, never silently converted to success.

## Execution Handoff

This plan is a proposal for review. Do not start Task 1 until the owner approves this plan and chooses the execution method. The current tool environment does not expose a subagent dispatch tool; therefore the executable option in this session is Native/Inline implementation with a final author self-review clearly disclosed as weaker than an independent reviewer. Any Cloudflare secret/configuration write, Queue/Worker activation, deployment, merge, or live HTTP call remains outside this plan and requires separate explicit authorization.
