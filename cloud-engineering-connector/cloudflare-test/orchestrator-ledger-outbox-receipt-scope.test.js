import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger outbox receipt tenant/project binding", () => {
  it("does not accept a task version from a different tenant/project than the source outbox event", async () => {
    const ledger = ledgerFor("outbox-receipt-cross-tenant-task-binding");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "a".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const assertion = await createScheduledWorkerAssertion(keySet, "test", {
        subject: "orchestrator-outbox-consumer",
        role: "consumer",
        operation: "recordOutboxReceipt",
        nowMs: now,
      });
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "receipt-scope-task",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        state: "SCHEDULED",
        version: 3,
        createdAt: now - 10,
        updatedAt: now - 5,
      };
      const payload = { taskId: task.taskId, version: 3 };
      const payloadJson = JSON.stringify(payload);
      const eventId = "receipt-scope-event";
      const eventType = "task.created";
      const idempotencyKey = "receipt-scope-idem";
      const createdAt = now - 4;
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "task-scope-idem", "a".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, 0, ?, ?, ?, ?)",
        eventId, idempotencyKey, task.taskId, eventType, payloadJson, createdAt, createdAt,
        "tenant-beta", "project-blue",
      );

      const result = await instance.recordOutboxReceipt({
        eventId,
        eventType,
        idempotencyKey,
        taskId: task.taskId,
        payload,
        createdAt,
        schemaVersion: 1,
        envelopeSha256: "b".repeat(64),
        consumerId: "orchestrator-outbox-consumer",
        workerAssertion: assertion,
        now,
      });

      expect(result).toMatchObject({
        recorded: false,
        blocked: true,
        reason: "TASK_VERSION_FENCED",
      });
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts").one().count).toBe(0);
    });
  });
});
