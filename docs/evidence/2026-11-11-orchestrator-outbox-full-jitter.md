# OrchestratorLedger Outbox Full-Jitter Verification

## Decision scope

This evidence record covers only the retry-delay calculation for retryable failures in `OrchestratorLedger.failOutbox`. It does not authorize merge, deployment, Durable Object migration, queue provisioning, secret changes, or Production traffic changes.

## Source identity

- Repository: `mohammadrezayaghoobi123-dev/Chat-gpt`
- Base branch: `integration/unify-main-and-integrated-2026-11-02`
- Base SHA: `b312c061c1acc6f43f5dd884f0139b889962de7c`
- Working branch: `remediation/outbox-full-jitter-2026-11-11`
- Test-only RED commit: `95f50a78ddde7c69b1242b442922b5b5d735912c`
- Implementation commit: `44ac1f59a1a90a6260b9c1778099dc9772aa9a72`
- Draft PR: [#227](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/pull/227)

## Behavior

For retryable failures, the retry ceiling remains:

```text
cap(attempt) = min(900000 ms, 1000 ms * 2^(attempt - 1))
delay        = 1 ms + floor(random_sample * cap)
```

The sample must be finite and satisfy `0 <= sample < 1`; invalid samples fail closed. The resulting delay is bounded to `[1 ms, cap]`. The 1 ms floor avoids a zero-delay retry loop. This randomness is for load distribution only; it is not an identity, authorization, or security primitive.

Permanent failures and exhausted attempts retain the existing dead-letter behavior. No database schema or persisted event identity changed.

## Test-driven evidence

### RED

Workflow run: [43080952948](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/43080952948)

- Node tests: 447 passed, 0 failed.
- Durable Object/Vitest: 1 failed, 163 passed across 8 files.
- Expected failure: `Math.random` was expected once but was called zero times.
- The failure was isolated to the new full-jitter regression assertion in `cloudflare-test/orchestrator-ledger.test.js`.

### GREEN

Implementation SHA: `44ac1f59a1a90a6260b9c1778099dc9772aa9a72`

- Cloud Engineering Connector CI: [43081082440](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/43081082440) — success.
- Node tests: 447 passed, 0 failed.
- Durable Object/Vitest: 164 passed, 0 failed across 8 files.
- JavaScript syntax checks: success.
- Wrangler Production dry-run: success.
- Wrangler Staging dry-run: success.
- npm advisory audit: success.
- Full History Secret Scan: [43081082527](https://github.com/mohammadrezayaghoobi123-dev/Chat-gpt/actions/runs/43081082527) — success.

## Related recovery coverage inspected

The existing Durable Object integration test `acknowledges a republished event after an uncertain send even when the publisher attempt counter changes` exercises:

1. Queue send success followed by uncertain Ledger completion.
2. Lease expiry and reclaim with a new fencing generation.
3. Republish with the same `eventId` and idempotency key but incremented delivery-attempt metadata.
4. Durable receipt deduplication of the replay.
5. Rejection of altered semantic payload under the same event ID.

This test is pre-existing on the base Integration line and was included in the successful 164-test Vitest run. It was inspected, not modified by this PR.

## Explicit limitations

- Staging post-deploy smoke was skipped. No live Cloudflare runtime behavior is established by these CI results.
- The outbox receipt consumer records durable receipts; it is not proof that task business execution or external side effects are implemented.
- The broader Orchestrator outbox reconciliation/quarantine authority and Production readiness gates remain separate unresolved work.
- Production remains `NO-GO` until every release gate has independently verifiable evidence and an authorized final decision.
