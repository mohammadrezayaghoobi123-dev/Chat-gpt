# Orchestrator Outbox Publisher — Source Evidence Snapshot

- Evidence date: 2026-11-06
- Branch: `remediation/orchestrator-production-hardening`
- Current source implementation head: `35f29867f0c144de023269997dbd57386ed9ff6f`
- CI run: [Cloud Engineering Connector CI #42281844106](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/42281844106)
- Secret scan: [Full History Secret Scan #42280584212](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/42260745365)

## Source-confirmed

1. `orchestrator-worker-identity.js` exports `createScheduledWorkerAssertion`.
   - HMAC-SHA-256 signing uses `LEDGER_WORKER_ASSERTION_KEYS`.
   - The active key identifier is explicit.
   - The signer is restricted to fixed scheduled service principals and exact operations.
   - Agent assertions cannot be minted by this signer.
2. `worker.js` exports `processOrchestratorOutbox`.
   - Queue and Ledger bindings are checked before claim.
   - Batch size is bounded (default 5, maximum 20).
   - Each Ledger mutation receives a fresh signed operation-bound assertion.
   - Queue-send failures use the Ledger retry/DLQ path.
   - Uncertain completion after a successful send leaves the lease to expire, preserving at-least-once semantics.
3. The scheduled handler attaches both Knowledge Store reconciliation and Orchestrator outbox publishing to one `waitUntil(Promise.all(...))` lifecycle.
4. A missing optional Queue binding returns `orchestrator_outbox_queue_unavailable` before any Ledger claim. This configuration state is not emitted as an alert-level error.

5. The Worker exports `consumeOrchestratorOutbox` as its Cloudflare Queue handler.
   - It accepts only schema version 1 and the explicit event types `task.created`, `task.transitioned`, and `vault.document.proposed`.
   - It validates the exact envelope key set, identifiers, timestamps, attempt bounds, object payload, and 32 KiB serialized size before touching the Ledger.
   - Unknown event types and malformed envelopes are retried; no payload-driven Task execution or repository mutation occurs.
6. The consumer uses the fixed `orchestrator-outbox-consumer` principal and the operation-bound `recordOutboxReceipt` assertion.
7. OrchestratorLedger schema v4 creates `orchestrator_outbox_receipts`, with `event_id` as a primary key and the envelope SHA-256, event type, schema version, consumer ID, and receive time recorded atomically.
   - An identical eventId/envelope replay is acknowledged as a duplicate.
   - Rebinding an eventId to a different event type, schema version, or envelope hash returns a conflict.
   - The receipt table stores no arbitrary payload and triggers no business side effect.

## CI-confirmed at current source head

- Branch HEAD: `35f29867f0c144de023269997dbd57386ed9ff6f`.
- Cloud Engineering Connector CI #42281844106: success.
- Full History Secret Scan #42281844124: success.
- Orchestrator GitHub Intake Contract #42281844172: success.
- Node test suite: 377 passed, 0 failed.
- Durable Object suite: 100 passed across 6 test files.
- JavaScript syntax and Wrangler configuration checks: success.
- `post-deploy-staging-smoke`: skipped. CI success is not live runtime evidence.

## Runtime-unknown / not activated

- `ORCHESTRATOR_OUTBOX_QUEUE` is not yet configured in `wrangler.toml`.
- The Queue consumer is implemented and CI-tested, but is not activated: no Queue resource or `ORCHESTRATOR_OUTBOX_QUEUE` producer/consumer binding is configured in Wrangler or live Cloudflare.
- No live Staging or Production Queue binding has been inspected.
- Presence and compatibility of `LEDGER_WORKER_ASSERTION_KEYS` and `LEDGER_WORKER_ASSERTION_ACTIVE_KID` in Cloudflare have not been verified.
- No end-to-end live claim → publish → consume → deduplicate → complete test has run.
- No live Durable Object or Cloudflare deployment verification has run.

## Required next controls

1. Provision separate Staging and Production Queues and configure reviewed producer bindings.
2. Provision separate Staging and Production Queues; configure the reviewed Queue producer/consumer bindings and retry/DLQ policy only after the Staging deployment plan is approved.
3. Add live Staging failure-injection coverage for duplicate delivery after send-success / completion-failure, receipt persistence, and Queue redelivery.
4. Configure and verify signer secret/key ID presence without exposing values.
5. Run full Staging end-to-end smoke and recovery tests.
6. Complete backup/restore evidence, independent review, and operator-approved deployment.

**Release decision: NO-GO.** This snapshot proves source and CI state only. It does not establish that the runtime is activated or production-ready.


## Historical verification refresh — 2026-11-06 19:33 UTC

- Branch HEAD: `46a4e58b3babbb7ca83288f3592df85bc4c52672`.
- Cloud Engineering Connector CI: run `42280584167`, completed `success`.
- Full History Secret Scan: run `42280584212`, completed `success`.
- Node test runner: 372 passed, 0 failed.
- Vitest Durable Object suite: 6 files, 98 tests passed.
- `post-deploy-staging-smoke`: skipped. No live Staging smoke was performed by this workflow.
- The test suite includes fail-closed readiness coverage for missing Queue and invalid/missing signer key configuration. The readiness fixture in the credential matrix was updated to provide ephemeral signing material and a test Queue; no real secret is committed.

This refresh supersedes the earlier CI identifiers and Node test count in this snapshot. It does not change the runtime-unknown findings above.


## Queue consumer implementation and verification — 2026-11-06

- Consumer implementation is present in `worker.js` and exported as the Worker's `queue` handler.
- Durable receipt schema and transaction are present in `orchestrator-ledger.js`; Ledger ping reports schema version 4.
- The fixed consumer signer policy permits only `recordOutboxReceipt`; it cannot mint Agent assertions or authorize task execution.
- Unit coverage verifies unknown event rejection, supported event receipt, identical redelivery, eventId rebinding conflict, and signed consumer identity.
- Failure-injection coverage joins the publisher and consumer paths: Queue send succeeds, Ledger completion becomes uncertain, and duplicate Queue delivery is safely acknowledged through durable receipt deduplication.
- CI at exact HEAD `35f29867f0c144de023269997dbd57386ed9ff6f`: 377/377 Node tests and 100/100 Durable Object tests passed; syntax/config checks passed; full-history Secret Scan passed.
- The workflow's post-deploy Staging smoke remains skipped. No Queue was provisioned, no Wrangler Queue binding was activated, and no Cloudflare deployment or live runtime test was performed.

**Updated release decision: NO-GO.** Source and CI gates for the consumer pass; Queue infrastructure, Staging configuration, and live end-to-end delivery/recovery remain unverified.


## Receipt source-binding hardening — 2026-11-06 19:54 UTC

- Source HEAD: `42068ad0482d78811d50bf6cacecf999232519bf`.
- `OrchestratorLedger.recordOutboxReceipt` now verifies, inside the same Durable Object transaction that writes the receipt, that the event ID resolves to a persisted Outbox row and that event type, idempotency key, task ID, canonical payload JSON, and creation timestamp exactly match the source row.
- The Queue consumer passes those immutable envelope fields to the Ledger. An authenticated but unbound or altered envelope is rejected before receipt insertion; duplicate receipt handling remains keyed by the event ID and envelope hash.
- No task execution, repository write, or business side effect was added to the consumer.
- Regression coverage verifies rejection of a receipt with no source Outbox row, successful receipt of a matching source event, and rejection of a payload altered after publication.
- Cloud Engineering Connector CI run `42283608598`: success. Node tests: 377 passed, 0 failed. Durable Object tests: 6 files, 100 passed, 0 failed. Wrangler production/staging dry-run and JavaScript syntax checks: success.
- Full History Secret Scan run `42283608888`: success. Orchestrator GitHub Intake Contract run `42283608740`: success.
- `post-deploy-staging-smoke` was skipped. These results are source/CI evidence only; live Queue, Durable Object bindings, signer configuration, Staging end-to-end delivery, and Production remain unverified.

**Release decision remains NO-GO.**


## Queue activation configuration and release gates — 2026-11-06 20:02 UTC

- Current source HEAD: `569921f48eb13b1338d6928db145cd22542134b2`.
- `wrangler.toml` now declares separate Producer and Consumer bindings for Production and Staging. The Queue names are `chat-gpt111-orchestrator-outbox` and `chat-gpt111-staging-orchestrator-outbox`; each Consumer uses a dedicated environment-specific DLQ.
- Queue delivery is bounded: batch size 5, max concurrency 5, max retries 5, retry delay 30 seconds, batch timeout 5 seconds. The primary queues are preflighted before release; the release workflow verifies the deployed consumer attachment, retry settings, and DLQ after deployment. Cloudflare creates a referenced DLQ if it does not already exist when the consumer is configured.
- Production release preflight requires both Production and Staging primary Queue resources to exist. Production post-deploy verification checks that both Queue/DLQ pairs and consumer configurations are present and isolated.
- Cloud Engineering Connector CI #42284792185: success. Node tests: 381 passed, 0 failed. Durable Object tests: 6 files, 100 passed, 0 failed. JavaScript syntax checks and Wrangler Production/Staging dry-runs: success.
- Full History Secret Scan #42284792176: success. Orchestrator GitHub Intake Contract #42284792243: success.
- Post-deploy Staging smoke: skipped; no runtime deployment was performed by PR CI.

### Live runtime recheck (read-only)

- Cloudflare account Queue inventory returned zero Queues.
- Staging Worker binding inventory still lacks `KNOWLEDGE_STORE`, `ORCHESTRATOR_LEDGER`, `ORCHESTRATOR_OUTBOX_QUEUE`, `LEDGER_WORKER_ASSERTION_KEYS`, and `LEDGER_WORKER_ASSERTION_ACTIVE_KID`; only the earlier `WRITE_CONTROL` namespace is present among the Durable Object bindings inspected.
- No resource was created, modified, deployed, or deleted. No secret value was read.

**Release decision remains NO-GO.** Source configuration and release gates are CI-verified; Queue provisioning, Staging signer configuration, Durable Object activation/migration, live delivery/recovery, and Production remain unverified.
