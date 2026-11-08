import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger tenant/project idempotency isolation", () => {
  it("allows the same caller idempotency key in different tenant/project scopes", async () => {
    const ledger = ledgerFor("task-idempotency-same-key-different-tenants");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "f".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const create = async ({ taskId, tenantId, projectId, inputHash }) => {
        const workerAssertion = await createScheduledWorkerAssertion(keySet, "test", {
          subject: "orchestrator-scheduler",
          role: "system",
          operation: "createTask",
          nowMs: now,
        });
        return instance.createTask({
          task: {
            taskId, tenantId, projectId, state: "SCHEDULED", version: 1,
            createdAt: now, updatedAt: now, executorId: "worker-a",
          },
          idempotencyKey: "client-request-42",
          inputHash,
          now,
          workerId: "orchestrator-scheduler",
          workerAssertion,
        });
      };

      const first = await create({
        taskId: "tenant-alpha-task-42",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        inputHash: "1".repeat(64),
      });
      const second = await create({
        taskId: "tenant-beta-task-42",
        tenantId: "tenant-beta",
        projectId: "project-blue",
        inputHash: "2".repeat(64),
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(second.task).toMatchObject({
        taskId: "tenant-beta-task-42",
        tenantId: "tenant-beta",
        projectId: "project-blue",
      });
      const rows = instance.ctx.storage.sql.exec(
        "SELECT task_id, tenant_id, project_id FROM orchestrator_tasks WHERE tenant_id IN (?, ?) ORDER BY tenant_id",
        "tenant-alpha", "tenant-beta",
      ).toArray();
      expect(rows).toEqual([
        { task_id: "tenant-alpha-task-42", tenant_id: "tenant-alpha", project_id: "project-red" },
        { task_id: "tenant-beta-task-42", tenant_id: "tenant-beta", project_id: "project-blue" },
      ]);
    });
  });

  it("backfills v8 task and outbox keys into injective tenant/project namespaces exactly once", async () => {
    const ledger = ledgerFor("task-outbox-idempotency-v8-to-v9");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      sql.exec("DELETE FROM orchestrator_schema_migrations WHERE version = 9");
      const now = 1_800_000_000_000;
      const task = {
        taskId: "v8-legacy-task",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        state: "SCHEDULED",
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "legacy-client-key", "3".repeat(64), task.state, task.version,
        JSON.stringify(task), now, now, task.tenantId, task.projectId,
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, 0, ?, ?, ?, ?)",
        "v8-legacy-event", "legacy-outbox-key", task.taskId, "task.created",
        JSON.stringify({ taskId: task.taskId, version: 1 }), now, now,
        task.tenantId, task.projectId,
      );

      const scoped = (tenantId, projectId, key) =>
        "tp1:" + tenantId.length + ":" + tenantId +
        ":" + projectId.length + ":" + projectId +
        ":" + key.length + ":" + key;

      instance.ensureSchema();
      const taskKey = sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).one().idempotency_key;
      const eventKey = sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v8-legacy-event",
      ).one().idempotency_key;
      expect(taskKey).toBe(scoped(task.tenantId, task.projectId, "legacy-client-key"));
      expect(eventKey).toBe(scoped(task.tenantId, task.projectId, "legacy-outbox-key"));
      expect(sql.exec("SELECT version FROM orchestrator_schema_migrations WHERE version = 9").one().version).toBe(9);

      instance.ensureSchema();
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        task.taskId,
      ).one().idempotency_key).toBe(taskKey);
      expect(sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v8-legacy-event",
      ).one().idempotency_key).toBe(eventKey);
    });
  });
});
