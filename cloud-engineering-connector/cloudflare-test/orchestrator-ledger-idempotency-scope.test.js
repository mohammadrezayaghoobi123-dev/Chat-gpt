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
});
