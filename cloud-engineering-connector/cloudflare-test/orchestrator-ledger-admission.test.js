import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

describe("OrchestratorLedger tenant task admission", () => {
  it("rejects Task creation without a TenantDirectory-signed admission grant", async () => {
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("task-admission-required-" + crypto.randomUUID()),
    );
    await runInDurableObject(ledger, async instance => {
      const now = Date.now();
      const workerKeySet = JSON.stringify({ test: "f".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = workerKeySet;
      const workerAssertion = await createScheduledWorkerAssertion(workerKeySet, "test", {
        subject: "orchestrator-scheduler",
        role: "system",
        operation: "createTask",
        nowMs: now,
      });
      const task = {
        taskId: "task-admission-required-01",
        tenantId: "tenant-admission-required-01",
        projectId: "project-admission-required-01",
        state: "SCHEDULED",
        version: 1,
        createdAt: now,
        updatedAt: now,
        executorId: "worker-admission-required",
      };

      const result = await instance.createTask({
        task,
        idempotencyKey: "admission-required-request-01",
        inputHash: "a".repeat(64),
        now,
        workerId: "orchestrator-scheduler",
        workerAssertion,
      });

      expect(result).toEqual({
        created: false,
        reason: "TASK_ADMISSION_REQUIRED",
      });
      expect(instance.getTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        projectId: task.projectId,
      })).toBeNull();
    });
  });
});
