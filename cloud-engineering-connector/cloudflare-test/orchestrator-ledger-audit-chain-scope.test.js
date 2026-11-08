import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAgentWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger tenant/project audit hash chains", () => {
  it("does not link one tenant's audit head into another tenant/project chain", async () => {
    const ledger = ledgerFor("audit-chain-per-tenant-project");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "5".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const sql = instance.ctx.storage.sql;
      const tasks = [
        { taskId: "audit-task-alpha", tenantId: "tenant-alpha", projectId: "project-red" },
        { taskId: "audit-task-beta", tenantId: "tenant-beta", projectId: "project-blue" },
      ];
      for (const task of tasks) {
        sql.exec(
          "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, 'SCHEDULED', 1, ?, ?, ?, ?, ?)",
          task.taskId, "idem-" + task.taskId, "a".repeat(64), JSON.stringify({
            ...task, state: "SCHEDULED", version: 1, createdAt: now - 10, updatedAt: now - 10,
          }), now - 10, now - 10, task.tenantId, task.projectId,
        );
      }
      sql.exec(
        "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, actor_role, event_type, details_json, previous_hash, event_hash, created_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
        "audit-alpha-head", "audit-task-alpha", "worker-a", "agent", "TASK_NOTE",
        JSON.stringify({ note: "tenant alpha private audit detail" }), "c".repeat(64), now - 5,
        "tenant-alpha", "project-red",
      );

      const workerAssertion = await createAgentWorkerAssertion(keySet, "test", {
        subject: "worker-b",
        operation: "appendAuditEvent",
        tenantId: "tenant-beta",
        projectId: "project-blue",
        taskId: "audit-task-beta",
        nowMs: now,
      });
      const result = await instance.appendAuditEvent({
        eventId: "audit-beta-first",
        taskId: "audit-task-beta",
        tenantId: "tenant-beta",
        projectId: "project-blue",
        actor: { id: "worker-b", role: "agent" },
        workerId: "worker-b",
        workerAssertion,
        eventType: "TASK_NOTE",
        details: { note: "tenant beta starts an independent chain" },
        now,
      });

      expect(result.appended).toBe(true);
      expect(result.event.previousHash).toBeNull();
      const betaRow = sql.exec(
        "SELECT previous_hash, tenant_id, project_id FROM orchestrator_audit_events WHERE event_id = ?",
        "audit-beta-first",
      ).one();
      expect(betaRow).toEqual({
        previous_hash: null,
        tenant_id: "tenant-beta",
        project_id: "project-blue",
      });
      expect(sql.exec(
        "SELECT event_hash FROM orchestrator_audit_events WHERE event_id = ?",
        "audit-alpha-head",
      ).one().event_hash).toBe("c".repeat(64));
    });
  });
});
