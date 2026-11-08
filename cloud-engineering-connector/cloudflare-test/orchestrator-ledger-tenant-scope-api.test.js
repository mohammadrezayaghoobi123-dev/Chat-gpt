import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger task API scope admission", () => {
  it("rejects task-scoped mutations without both tenantId and projectId before authentication or storage writes", async () => {
    const ledger = ledgerFor("task-api-scope-required");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const task = {
        taskId: "scope-required-task",
        state: "SCHEDULED",
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

      const results = await Promise.all([
        instance.createTask({ task, idempotencyKey: "scope-required-idem", inputHash: "a".repeat(64), now }),
        instance.transitionTask({
          taskId: task.taskId, expectedVersion: 1, expectedState: "SCHEDULED",
          nextState: "RUNNING", actor: { id: "worker-a", role: "agent" },
          workerId: "worker-a", leaseGeneration: 1, now,
        }),
        instance.recordMessage({
          messageId: "scope-required-message", taskId: task.taskId,
          inputHash: "b".repeat(64), envelope: {}, workerId: "worker-a", now,
        }),
        instance.claimTask({ workerId: "worker-a", leaseMs: 1_000, now, taskId: task.taskId }),
        instance.enqueueOutbox({
          eventId: "scope-required-event",
          idempotencyKey: "scope-required-outbox-idem",
          taskId: task.taskId,
          eventType: "task.created",
          payload: { taskId: task.taskId },
          workerId: "worker-a",
          now,
        }),
        instance.advanceAgentRound({
          taskId: task.taskId, expectedVersion: 1, expectedRound: 0, nextRound: 1,
          workerId: "worker-a", leaseGeneration: 1, now,
        }),
        instance.renewLease({ taskId: task.taskId, workerId: "worker-a", leaseGeneration: 1, leaseMs: 1_000, now }),
        instance.releaseLease({ taskId: task.taskId, workerId: "worker-a", leaseGeneration: 1, now }),
        instance.appendAuditEvent({
          eventId: "scope-required-audit", taskId: task.taskId,
          actor: { id: "worker-a", role: "agent" }, workerId: "worker-a",
          eventType: "TASK_NOTE", details: {}, now,
        }),
      ]);

      for (const result of results) {
        expect(result.reason).toBe("TENANT_PROJECT_SCOPE_REQUIRED");
      }

      const sql = instance.ctx.storage.sql;
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_execution_leases").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
    });
  });

  it("does not treat a tenant-only or project-only selector as a complete scope", async () => {
    const ledger = ledgerFor("partial-task-api-scope");
    await runInDurableObject(ledger, async instance => {
      const base = {
        taskId: "partial-scope-task", expectedVersion: 1, expectedState: "SCHEDULED",
        nextState: "RUNNING", actor: { id: "worker-a", role: "agent" },
        workerId: "worker-a", leaseGeneration: 1, now: 1_800_000_000_000,
      };

      const tenantOnly = await instance.transitionTask({ ...base, tenantId: "tenant-a" });
      const projectOnly = await instance.transitionTask({ ...base, projectId: "project-a" });

      expect(tenantOnly.reason).toBe("TENANT_PROJECT_SCOPE_REQUIRED");
      expect(projectOnly.reason).toBe("TENANT_PROJECT_SCOPE_REQUIRED");
    });
  });
});
