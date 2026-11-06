  });
});


it("records outbox receipts atomically and deduplicates identical eventId redelivery", async () => {
  const ledger = ledgerFor("ledger-outbox-receipt-dedup");
  const common = {
    eventId: "evt-receipt-00000001",
    eventType: "task.transitioned",
    schemaVersion: 1,
    envelopeSha256: "a".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  const first = await ledger.recordOutboxReceipt({
    ...common,
    workerAssertion: await createWorkerAssertion({
      subject: common.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
    }),
  });
  const replay = await ledger.recordOutboxReceipt({
    ...common,
    workerAssertion: await createWorkerAssertion({
      subject: common.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now + 1,
    }),
    now: now + 1,
  });
  expect(first).toMatchObject({ recorded: true, eventId: common.eventId });
  expect(replay).toMatchObject({ recorded: false, replay: true, eventId: common.eventId });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?", common.eventId).one().count).toBe(1);
  });
});

it("rejects eventId rebinding and unsigned outbox receipt writes", async () => {
  const ledger = ledgerFor("ledger-outbox-receipt-conflict");
  const common = {
    eventId: "evt-receipt-00000002",
    eventType: "task.created",
    schemaVersion: 1,
    envelopeSha256: "b".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  await expect(ledger.recordOutboxReceipt(common)).resolves.toMatchObject({
    recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });
  await ledger.recordOutboxReceipt({
    ...common,
    workerAssertion: await createWorkerAssertion({
      subject: common.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
    }),
  });
  await expect(ledger.recordOutboxReceipt({
    ...common,
    envelopeSha256: "c".repeat(64),
    workerAssertion: await createWorkerAssertion({
      subject: common.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now + 1,
    }),
    now: now + 1,
  })).resolves.toMatchObject({ recorded: false, conflict: true, reason: "OUTBOX_EVENT_ID_CONFLICT" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?", common.eventId).one().count).toBe(1);
  });
});

it("rejects an authenticated Queue receipt when no matching durable Outbox event exists", async () => {
  const ledger = ledgerFor("ledger-outbox-receipt-source-binding");
  const input = {
    eventId: "evt-receipt-unbound-0001",
    idempotencyKey: "outbox-unbound-0001",
    taskId: "task-0001",
    eventType: "task.transitioned",
    payload: { taskId: "task-0001", version: 2 },
    schemaVersion: 1,
    envelopeSha256: "d".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  const result = await ledger.recordOutboxReceipt({
    ...input,
    workerAssertion: await createWorkerAssertion({
      subject: input.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
    }),
  });
  expect(result).toMatchObject({ recorded: false, reason: "OUTBOX_SOURCE_NOT_FOUND" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
  });
});