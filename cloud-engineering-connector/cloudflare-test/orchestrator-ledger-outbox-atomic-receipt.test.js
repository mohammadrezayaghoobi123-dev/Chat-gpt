import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

const NOW = 1_800_000_600_000;
const KEY_SET = JSON.stringify({ test: "a".repeat(64) });
const TENANT_ID = "tenant-alpha";
const PROJECT_ID = "project-red";
const PUBLISHER_ID = "orchestrator-outbox-publisher";
const CONSUMER_ID = "orchestrator-outbox-consumer";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

async function assertionFor(subject, role, operation, now) {
  return createScheduledWorkerAssertion(KEY_SET, "test", {
    subject,
    role,
    operation,
    nowMs: now,
  });
}

function insertTaskAndOutbox(instance, { taskId, eventId, createdAt }) {
  const payload = { taskId, version: 1 };
  const payloadJson = JSON.stringify(payload);
  const idempotencyKey = "outbox-idem-" + eventId;
  const task = {
    taskId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    state: "SCHEDULED",
    version: 1,
    createdAt: createdAt - 10,
    updatedAt: createdAt - 5,
  };
  const sql = instance.ctx.storage.sql;
  sql.exec(
    "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    taskId, "task-idem-" + taskId, "a".repeat(64), task.state, task.version,
    JSON.stringify(task), task.createdAt, task.updatedAt, TENANT_ID, PROJECT_ID,
  );
  sql.exec(
    "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, 0, 0, ?, ?, ?, ?)",
    eventId, idempotencyKey, taskId, "task.created", payloadJson,
    createdAt, createdAt, TENANT_ID, PROJECT_ID,
  );
  return {
    eventId,
    eventType: "task.created",
    idempotencyKey,
    taskId,
    payload,
    createdAt,
  };
}

function storedOutbox(instance, eventId) {
  return instance.ctx.storage.sql.exec(
    "SELECT event_id, status, attempts, lease_worker_id, lease_generation, lease_until FROM orchestrator_outbox_events WHERE event_id = ?",
    eventId,
  ).toArray()[0] ?? null;
}

function receiptCount(instance, eventId) {
  return instance.ctx.storage.sql.exec(
    "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
    eventId,
  ).one().count;
}

async function claimEvent(instance, event, now, leaseMs = 5_000) {
  instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
  return instance.claimOutbox({
    workerId: PUBLISHER_ID,
    workerAssertion: await assertionFor(PUBLISHER_ID, "publisher", "claimOutbox", now),
    leaseMs,
    now,
  });
}

async function recordReceipt(instance, event, leaseGeneration, now, workerAssertion, envelopeSha256 = "c".repeat(64)) {
  return instance.recordOutboxReceipt({
    ...event,
    schemaVersion: 1,
    envelopeSha256,
    consumerId: CONSUMER_ID,
    workerAssertion: workerAssertion ?? await assertionFor(CONSUMER_ID, "consumer", "recordOutboxReceipt", now),
    leaseGeneration,
    now,
  });
}

function providerSink({ idempotent }) {
  const accepted = new Set();
  let attempts = 0;
  let effects = 0;
  return {
    async deliver(event) {
      attempts += 1;
      if (!idempotent || !accepted.has(event.eventId)) {
        accepted.add(event.eventId);
        effects += 1;
      }
      return { status: 202, attempts, effects };
    },
    get attempts() { return attempts; },
    get effects() { return effects; },
  };
}

describe("OrchestratorLedger Outbox receipt-gated completion and ambiguous delivery", () => {
  it("rejects completion until a durable receipt exists", async () => {
    const ledger = ledgerFor("outbox-completion-requires-receipt");
    const taskId = "receipt-required-task";
    const eventId = "receipt-required-event";
    const createdAt = NOW;
    const claimNow = NOW + 20;

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      insertTaskAndOutbox(instance, { taskId, eventId, createdAt });
      expect(await claimEvent(instance, { eventId }, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      const result = await instance.completeOutbox({
        eventId,
        workerId: PUBLISHER_ID,
        workerAssertion: await assertionFor(PUBLISHER_ID, "publisher", "completeOutbox", claimNow + 1),
        leaseGeneration: 1,
        now: claimNow + 1,
      });

      expect(result).toMatchObject({
        completed: false,
        reason: "OUTBOX_RECEIPT_REQUIRED",
      });
      expect(storedOutbox(instance, eventId)).toMatchObject({
        status: "IN_PROGRESS",
        lease_generation: 1,
      });
      expect(receiptCount(instance, eventId)).toBe(0);
    });
  });

  it("rolls back receipt, completion, and consumer assertion together when SQLite aborts", async () => {
    const ledger = ledgerFor("outbox-receipt-transaction-rollback");
    const taskId = "receipt-rollback-task";
    const eventId = "receipt-rollback-event";
    const createdAt = NOW + 100;
    const claimNow = createdAt + 10;
    const receiptNow = claimNow + 1;
    const external = providerSink({ idempotent: true });
    const consumerAssertion = await assertionFor(CONSUMER_ID, "consumer", "recordOutboxReceipt", receiptNow);
    let event;

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      event = insertTaskAndOutbox(instance, { taskId, eventId, createdAt });
      const claimed = await claimEvent(instance, event, claimNow);
      expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });
      expect(await external.deliver(event)).toMatchObject({ status: 202, effects: 1 });

      instance.ctx.storage.sql.exec(
        "CREATE TRIGGER fail_outbox_receipt_insert BEFORE INSERT ON orchestrator_outbox_receipts BEGIN SELECT RAISE(ABORT, 'forced_receipt_insert_failure'); END",
      );
      let insertError;
      try {
        await recordReceipt(instance, event, 1, receiptNow, consumerAssertion);
      } catch (error) {
        insertError = error;
      }
      expect(String(insertError)).toContain("forced_receipt_insert_failure");
      expect(receiptCount(instance, eventId)).toBe(0);
      expect(storedOutbox(instance, eventId)).toMatchObject({
        status: "IN_PROGRESS",
        lease_generation: 1,
      });
    });

    await evictDurableObject(ledger);

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      expect(storedOutbox(instance, eventId)).toMatchObject({
        status: "IN_PROGRESS",
        lease_generation: 1,
      });
      expect(receiptCount(instance, eventId)).toBe(0);
      expect(() => instance.ctx.storage.sql.exec("DROP TRIGGER fail_outbox_receipt_insert")).not.toThrow();

      const duplicateDelivery = await external.deliver(event);
      expect(duplicateDelivery).toMatchObject({ status: 202, attempts: 2, effects: 1 });

      const settled = await recordReceipt(instance, event, 1, receiptNow + 1, consumerAssertion);
      expect(settled).toMatchObject({
        recorded: true,
        completed: true,
        eventId,
        leaseGeneration: 1,
      });
      expect(storedOutbox(instance, eventId)).toMatchObject({
        status: "COMPLETED",
        lease_worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(receiptCount(instance, eventId)).toBe(1);
    });

    await evictDurableObject(ledger);
    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      const replay = await recordReceipt(
        instance,
        event,
        1,
        receiptNow + 2,
        await assertionFor(CONSUMER_ID, "consumer", "recordOutboxReceipt", receiptNow + 2),
      );
      expect(replay).toMatchObject({ recorded: false, replay: true, eventId });
      const conflict = await recordReceipt(
        instance,
        event,
        1,
        receiptNow + 3,
        await assertionFor(CONSUMER_ID, "consumer", "recordOutboxReceipt", receiptNow + 3),
        "d".repeat(64),
      );
      expect(conflict).toMatchObject({
        recorded: false,
        conflict: true,
        reason: "OUTBOX_EVENT_ID_CONFLICT",
      });
      expect(storedOutbox(instance, eventId)).toMatchObject({ status: "COMPLETED" });
      expect(receiptCount(instance, eventId)).toBe(1);
      expect(instance.ctx.storage.sql.exec(
        "SELECT lease_generation FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).one().lease_generation).toBe(1);
    });
  });

  it("fences stale receipts after reclaim and exposes destination idempotency requirements", async () => {
    for (const idempotent of [true, false]) {
      const suffix = idempotent ? "idempotent" : "non-idempotent";
      const ledger = ledgerFor("outbox-provider-reclaim-" + suffix);
      const taskId = "provider-task-" + suffix;
      const eventId = "provider-event-" + suffix;
      const createdAt = NOW + (idempotent ? 200 : 300);
      const firstClaimAt = createdAt + 10;
      const firstLeaseMs = 1_000;
      const external = providerSink({ idempotent });
      let event;

      await runInDurableObject(ledger, async instance => {
        instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
        event = insertTaskAndOutbox(instance, { taskId, eventId, createdAt });
        const first = await claimEvent(instance, event, firstClaimAt, firstLeaseMs);
        expect(first).toMatchObject({ claimed: true, leaseGeneration: 1 });
        expect(await external.deliver(event)).toMatchObject({ status: 202, effects: 1 });
      });

      await evictDurableObject(ledger);
      const reclaimedAt = firstClaimAt + firstLeaseMs + 1;
      await runInDurableObject(ledger, async instance => {
        instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
        const expiredReceipt = await recordReceipt(
          instance,
          event,
          1,
          reclaimedAt,
          await assertionFor(CONSUMER_ID, "consumer", "recordOutboxReceipt", reclaimedAt),
        );
        expect(expiredReceipt).toMatchObject({
          recorded: false,
          blocked: true,
          reason: "OUTBOX_LEASE_FENCE_MISMATCH",
        });

        const claimedAt = reclaimedAt + 1;
        const reclaimed = await claimEvent(instance, event, claimedAt, 5_000);
        expect(reclaimed).toMatchObject({
          claimed: true,
          leaseGeneration: 2,
          reconciliationRequired: true,
        });

        const staleReceipt = await recordReceipt(
          instance,
          event,
          1,
          claimedAt + 1,
          await assertionFor(CONSUMER_ID, "consumer", "recordOutboxReceipt", claimedAt + 1),
        );
        expect(staleReceipt).toMatchObject({
          recorded: false,
          blocked: true,
          reason: "OUTBOX_LEASE_FENCE_MISMATCH",
        });
        expect(receiptCount(instance, eventId)).toBe(0);

        const redelivery = await external.deliver(event);
        expect(redelivery).toMatchObject({
          status: 202,
          attempts: 2,
          effects: idempotent ? 1 : 2,
        });

        const settled = await recordReceipt(instance, event, 2, claimedAt + 2);
        expect(settled).toMatchObject({
          recorded: true,
          completed: true,
          eventId,
          leaseGeneration: 2,
        });
        expect(storedOutbox(instance, eventId)).toMatchObject({
          status: "COMPLETED",
          lease_generation: 2,
        });
        expect(receiptCount(instance, eventId)).toBe(1);
      });
    }
  });
});
