# Outbox Receipt-Gated Completion Design

## Intent

Make the Durable Object Outbox completion boundary reflect a verified downstream acceptance receipt, not merely successful Queue submission or a publisher's assertion. Preserve the existing at-least-once delivery model and make the ambiguity window after an external side effect explicit and recoverable.

## Goals

- Reject Outbox completion when no matching durable receipt exists.
- Bind a new receipt to the exact immutable Outbox event and the current publisher lease generation.
- Insert the receipt and transition the Outbox row to COMPLETED in one SQLite transaction.
- Preserve transaction rollback for receipt insertion, completion, and one-time consumer assertion consumption.
- Make identical receipt retries idempotent and conflicting receipts explicit.
- Demonstrate the post-provider-acceptance / pre-receipt-write failure window using deterministic test-only provider sinks.
- Preserve tenant/project and Task-version fencing.

## Non-goals

- Provisioning Cloudflare Queue resources or changing Worker deployment configuration.
- Enabling production Queue producers/consumers or invoking a real HTTPS destination.
- Claiming exactly-once network delivery or exactly-once external effects.
- Changing the main branch, Worker secrets, Cloudflare resources, staging, or production.

## Approaches

1. Publisher-completion after Queue send. Rejected: Queue acceptance is not downstream effect acceptance and can precede later consumer failure.
2. Separate receipt and completion transactions. Rejected: a crash between the two transactions leaves a durable receipt but an unfinished event, requiring another reconciliation state.
3. Consumer receipt and Outbox completion in one Durable Object transaction. Selected: the consumer's authenticated receipt is validated against the current event and lease generation, then the receipt insert and event completion commit or roll back together.

## Contract

recordOutboxReceipt accepts a positive leaseGeneration. It first checks source-event identity and any existing receipt. An identical existing receipt returns replay: true; a different receipt for the same event ID returns OUTBOX_EVENT_ID_CONFLICT. A new receipt is accepted only while the source event is IN_PROGRESS, its generation equals the supplied generation, and its lease has not expired. Task-version and tenant/project checks remain mandatory. The receipt row insert and Outbox transition to COMPLETED occur inside the same transactionSync callback. A failed SQL statement rolls back both and the consumer assertion JTI.

completeOutbox remains as a compatibility/recovery operation, but it cannot complete an event without a matching receipt. Replaying completion for an already completed event with a receipt is idempotent.

The stable eventId remains the downstream idempotency key. The external destination must independently honor that key because a successful remote side effect cannot be rolled back by a local SQLite transaction.

## Adversarial acceptance criteria

- No receipt: completion is rejected and the Outbox row remains IN_PROGRESS.
- Wrong lease generation or expired lease: new receipt is rejected without writing a receipt.
- Same event, same receipt: replay is reported without inserting a second row.
- Same event, different event type/schema/hash: conflict is reported.
- SQLite abort during receipt insert: no receipt, no completion, and the consumer JTI is not consumed.
- Eviction/reconstruction after the abort preserves the event and lease; retry with the same assertion is accepted only while that assertion and lease remain valid.
- After lease expiry and reclaim, generation advances; an old-generation receipt is rejected.
- A test-only idempotent provider sink deduplicates retries by eventId; a test-only non-idempotent sink demonstrates duplicate side effects. Neither fake is represented as a production provider integration.

## Evidence boundary

This design proves local Ledger semantics in the Workers Vitest runtime. It does not prove real Queue delivery, real HTTPS destination behavior, abrupt host/process termination, or production fault injection. Those remain UNKNOWN until a separate, repository-grounded Queue/Webhook integration is implemented and independently verified.
