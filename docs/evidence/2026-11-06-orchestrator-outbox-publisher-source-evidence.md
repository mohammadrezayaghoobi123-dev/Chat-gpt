# Orchestrator Outbox Publisher — Source Evidence Snapshot

- Evidence date: 2026-11-06
- Branch: `remediation/orchestrator-production-hardening`
- Source implementation commit: `07bd7a6d108666e0b1cc1f2dd8b60d143eae9937`
- CI run: [Cloud Engineering Connector CI #42260745352](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/42260745352)
- Secret scan: [Full History Secret Scan #42260745365](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/42260745365)

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

## CI-confirmed at source implementation commit

- Node test suite: 370 passed, 0 failed.
- Durable Object suite: 98 passed across 6 test files.
- JavaScript syntax and Wrangler configuration checks: success.
- Full-history Secret Scan: success.

The CI job's `post-deploy-staging-smoke` was skipped. CI success is not live runtime evidence.

## Runtime-unknown / not activated

- `ORCHESTRATOR_OUTBOX_QUEUE` is not yet configured in `wrangler.toml`.
- No Queue consumer is implemented in this repository.
- No live Staging or Production Queue binding has been inspected.
- Presence and compatibility of `LEDGER_WORKER_ASSERTION_KEYS` and `LEDGER_WORKER_ASSERTION_ACTIVE_KID` in Cloudflare have not been verified.
- No end-to-end live claim → publish → consume → deduplicate → complete test has run.
- No live Durable Object or Cloudflare deployment verification has run.

## Required next controls

1. Provision separate Staging and Production Queues and configure reviewed producer bindings.
2. Implement a Queue consumer with durable `eventId` deduplication and explicit allowlisted event handlers.
3. Add failure-injection coverage for duplicate delivery after send-success / completion-failure.
4. Configure and verify signer secret/key ID presence without exposing values.
5. Run full Staging end-to-end smoke and recovery tests.
6. Complete backup/restore evidence, independent review, and operator-approved deployment.

**Release decision: NO-GO.** This snapshot proves source and CI state only. It does not establish that the runtime is activated or production-ready.
