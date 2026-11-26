import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAgentWorkerAssertion } from "../orchestrator-worker-identity.js";

const KEY_SET = JSON.stringify({ test: "8".repeat(64) });
const NOW = 1_800_000_000_000;

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger terminal candidate claim fencing", () => {
  it("never claims a terminal task left stale in the candidate index", async () => {
    env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
    const ledger = ledgerFor("terminal-candidate-must-not-be-claimed");
    await runInDurableObject(ledger, async instance => {
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "terminal-task-1",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        executorId: "worker-alpha",
        state: "COMPLETED",
        version: 2,
        createdAt: 100,
        updatedAt: 200,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "terminal-task-idempotency", "a".repeat(64), task.state,
        task.version, JSON.stringify(task), task.createdAt, task.updatedAt,
        task.tenantId, task.projectId,
      );
      // Model a stale derived-index row after an independent terminal transition.
      sql.exec(
        "INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?)",
        task.taskId, "worker-alpha", task.createdAt, task.tenantId, task.projectId,
      );
      const workerAssertion = await createAgentWorkerAssertion(KEY_SET, "test", {
        subject: "worker-alpha",
        role: "agent",
        operation: "claimTask",
        tenantId: task.tenantId,
        projectId: task.projectId,
        taskId: null,
        nowMs: NOW,
      });

      const result = await instance.claimTask({
        workerId: "worker-alpha",
        workerAssertion,
        leaseMs: 30_000,
        now: NOW,
        tenantId: task.tenantId,
        projectId: task.projectId,
      });

      expect(result).toMatchObject({ claimed: false, reason: "NO_TASK_AVAILABLE" });
      expect(sql.exec(
        "SELECT worker_id FROM orchestrator_execution_leases WHERE task_id = ?",
        task.taskId,
      ).toArray()).toHaveLength(0);
    });
  });
});
