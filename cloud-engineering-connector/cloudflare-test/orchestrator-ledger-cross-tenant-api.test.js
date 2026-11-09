import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAgentWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}


describe("OrchestratorLedger cross-tenant API isolation", () => {
  it("rejects an agent capability replayed against a different tenant/project before storage access", async () => {
    const ledger = ledgerFor("agent-capability-scope-replay");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "7".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const token = await createAgentWorkerAssertion(keySet, "test", {
        subject: "worker-a",
        operation: "renewLease",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        taskId: "task-alpha",
        nowMs: now,
      });
      const result = await instance.renewLease({
        taskId: "task-alpha",
        tenantId: "tenant-beta",
        projectId: "project-blue",
        workerId: "worker-a",
        workerAssertion: token,
        leaseGeneration: 1,
        leaseMs: 5_000,
        now,
      });
      expect(result).toMatchObject({
        renewed: false,
        reason: "AUTHENTICATED_WORKER_REQUIRED",
      });
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases",
      ).one().count).toBe(0);
    });
  });

  it("rejects foreign-scope task mutations and does not alter the owning tenant's rows", async () => {
    const ledger = ledgerFor("cross-tenant-task-api-isolation");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keyHex = "c".repeat(64);
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = JSON.stringify({ test: keyHex });
      const sql = instance.ctx.storage.sql;
      const task = {
        taskId: "tenant-alpha-task",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        executorId: "worker-a",
        agentRound: 0,
        state: "SCHEDULED",
        version: 1,
        createdAt: now - 100,
        updatedAt: now - 50,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        task.taskId, "tenant-alpha-idem", "d".repeat(64), task.state, task.version,
        JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
      );
      sql.exec(
        "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at, tenant_id, project_id) VALUES (?, ?, 1, ?, ?, ?, ?)",
        task.taskId, "worker-a", now + 10_000, now - 40, task.tenantId, task.projectId,
      );

      const assertion = async operation => createAgentWorkerAssertion(
        JSON.stringify({ test: keyHex }), "test", {
          subject: "worker-a", operation, tenantId: "tenant-beta",
          projectId: "project-blue", taskId: task.taskId, nowMs: now,
        },
      );
      const messageInputHash = "e".repeat(64);
      const messageId = "foreign-scope-message";
      const messageEnvelope = {
        protocolVersion: 1,
        messageId,
        taskId: task.taskId,
        correlationId: "foreign-scope-correlation",
        senderId: "worker-a",
        recipientId: "worker-b",
        type: "PROGRESS",
        createdAt: now - 20,
        expiresAt: now + 5_000,
        scopeRef: {
          repository: "org/repo",
          baseBranch: "main",
          targetBranch: "feature/foreign-scope",
          allowedPaths: ["src/**"],
        },
        inputHash: messageInputHash,
        evidenceRefs: [],
        payload: { progress: "must not cross tenant" },
      };
      const [transition, claim, advance, renew, release, enqueue, audit, message] = await Promise.all([
        instance.transitionTask({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
          actor: { id: "worker-a", role: "agent" }, workerId: "worker-a",
          workerAssertion: await assertion("transitionTask"), leaseGeneration: 1, now,
        }),
        instance.claimTask({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          workerId: "worker-a", workerAssertion: await assertion("claimTask"),
          leaseMs: 5_000, now,
        }),
        instance.advanceAgentRound({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          expectedVersion: 1, expectedRound: 0, nextRound: 1, workerId: "worker-a",
          workerAssertion: await assertion("advanceAgentRound"), leaseGeneration: 1, now,
        }),
        instance.renewLease({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          workerId: "worker-a", workerAssertion: await assertion("renewLease"),
          leaseGeneration: 1, leaseMs: 5_000, now,
        }),
        instance.releaseLease({
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          workerId: "worker-a", workerAssertion: await assertion("releaseLease"),
          leaseGeneration: 1, now,
        }),
        instance.enqueueOutbox({
          eventId: "foreign-event", idempotencyKey: "foreign-outbox-idem",
          taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          eventType: "task.created", payload: { taskId: task.taskId, version: 1 },
          workerId: "worker-a", workerAssertion: await assertion("enqueueOutbox"), now,
        }),
        instance.appendAuditEvent({
          eventId: "foreign-audit", taskId: task.taskId,
          tenantId: "tenant-beta", projectId: "project-blue",
          actor: { id: "worker-a", role: "agent" }, workerId: "worker-a",
          workerAssertion: await assertion("appendAuditEvent"),
          eventType: "TASK_NOTE", details: { note: "must not cross tenant" }, now,
        }),
        instance.recordMessage({
          messageId, taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
          inputHash: messageInputHash, envelope: messageEnvelope, workerId: "worker-a",
          workerAssertion: await assertion("recordMessage"), now,
        }),
      ]);

      const fallbackClaim = await instance.claimTask({
        workerId: "worker-a",
        workerAssertion: await createAgentWorkerAssertion(
          JSON.stringify({ test: keyHex }), "test", {
            subject: "worker-a",
            operation: "claimTask",
            tenantId: "tenant-beta",
            projectId: "project-blue",
            taskId: null,
            nowMs: now,
          },
        ),
        leaseMs: 5_000,
        now,
        tenantId: "tenant-beta",
        projectId: "project-blue",
      });
      expect(fallbackClaim).toMatchObject({ claimed: false, reason: "NO_TASK_AVAILABLE" });

      expect(instance.getTask({
        taskId: task.taskId, tenantId: "tenant-alpha", projectId: "project-red",
      })).toMatchObject({ taskId: task.taskId, tenantId: "tenant-alpha", projectId: "project-red" });
      expect(instance.getTask({
        taskId: task.taskId, tenantId: "tenant-beta", projectId: "project-blue",
      })).toBeNull();
      expect(instance.getTask({
        taskId: task.taskId, tenantId: "tenant-alpha",
      })).toBeNull();

      expect(transition.reason).toBe("NOT_FOUND");
      expect(claim.claimed).toBe(false);
      expect(claim.reason).toBe("NO_TASK_AVAILABLE");
      expect(advance.reason).toBe("NOT_FOUND");
      expect(renew.renewed).toBe(false);
      expect(release.released).toBe(false);
      expect(enqueue.reason).toBe("TASK_NOT_FOUND");
      expect(audit.reason).toBe("TASK_NOT_FOUND");
      expect(message.reason).toBe("TASK_NOT_FOUND");

      const storedTask = sql.exec("SELECT state, version, tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?", task.taskId).one();
      expect(storedTask).toEqual({
        state: "SCHEDULED", version: 1, tenant_id: "tenant-alpha", project_id: "project-red",
      });
      const storedLease = sql.exec("SELECT worker_id, lease_generation, lease_until, tenant_id, project_id FROM orchestrator_execution_leases WHERE task_id = ?", task.taskId).one();
      expect(storedLease).toEqual({
        worker_id: "worker-a", lease_generation: 1, lease_until: now + 10_000,
        tenant_id: "tenant-alpha", project_id: "project-red",
      });
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
      expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages").one().count).toBe(0);
    });
  });
});
