import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

const PUBLISHER = "orchestrator-outbox-publisher";

async function assertion(keySet, operation, nowMs) {
  return createScheduledWorkerAssertion(keySet, "test", {
    subject: PUBLISHER,
    role: "publisher",
    operation,
    nowMs,
  });
}

describe("OrchestratorLedger outbox tenant attribution and lease fencing", () => {
  it("preserves source tenant/project attribution across reclaim and rejects stale publisher generations", async () => {
    const ledger = ledgerFor("outbox-tenant-attribution-lease-fencing");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "9".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "outbox-fenced-task",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        state: "SCHEDULED",
        version: 1,
        createdAt: now - 100,
        updatedAt: now - 50,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "scoped-task-idem", "a".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );
      const payload = { taskId: task.taskId, version: 1 };
      const eventId = "outbox-fenced-event";
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, NULL, 0, 0, ?, ?, ?, ?)",
        eventId, "scoped-outbox-idem", task.taskId, "task.created", JSON.stringify(payload),
        now - 10, now - 10, task.tenantId, task.projectId,
      );

      const first = await instance.claimOutbox({
        workerId: PUBLISHER,
        workerAssertion: await assertion(keySet, "claimOutbox", now),
        leaseMs: 5_000,
        now,
      });
      expect(first.claimed).toBe(true);
      expect(first.leaseGeneration).toBe(1);
      expect(first.event).toMatchObject({
        eventId,
        taskId: task.taskId,
        tenantId: task.tenantId,
        projectId: task.projectId,
        payload,
      });

      const reclaimedAt = now + 5_001;
      const second = await instance.claimOutbox({
        workerId: PUBLISHER,
        workerAssertion: await assertion(keySet, "claimOutbox", reclaimedAt),
        leaseMs: 5_000,
        now: reclaimedAt,
      });
      expect(second.claimed).toBe(true);
      expect(second.reconciliationRequired).toBe(true);
      expect(second.leaseGeneration).toBe(2);
      expect(second.event).toMatchObject({
        tenantId: task.tenantId,
        projectId: task.projectId,
      });

      const staleFail = await instance.failOutbox({
        eventId,
        workerId: PUBLISHER,
        workerAssertion: await assertion(keySet, "failOutbox", reclaimedAt + 1),
        leaseGeneration: 1,
        retryable: true,
        errorCode: "STALE_WORKER",
        now: reclaimedAt + 1,
      });
      const staleComplete = await instance.completeOutbox({
        eventId,
        workerId: PUBLISHER,
        workerAssertion: await assertion(keySet, "completeOutbox", reclaimedAt + 2),
        leaseGeneration: 1,
        now: reclaimedAt + 2,
      });
      expect(staleFail).toMatchObject({ failed: false, reason: "LEASE_FENCE_MISMATCH" });
      expect(staleComplete).toMatchObject({ completed: false, reason: "LEASE_FENCE_MISMATCH" });

      const completed = await instance.completeOutbox({
        eventId,
        workerId: PUBLISHER,
        workerAssertion: await assertion(keySet, "completeOutbox", reclaimedAt + 3),
        leaseGeneration: 2,
        now: reclaimedAt + 3,
      });
      expect(completed).toMatchObject({ completed: true, eventId, leaseGeneration: 2 });
      expect(sql.exec(
        "SELECT status, lease_generation, tenant_id, project_id FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one()).toEqual({
        status: "COMPLETED",
        lease_generation: 2,
        tenant_id: task.tenantId,
        project_id: task.projectId,
      });
    });
  });
});
