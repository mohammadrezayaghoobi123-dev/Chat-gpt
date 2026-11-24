import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAgentWorkerAssertion, createScheduledWorkerAssertion, verifyWorkerAssertion } from "../orchestrator-worker-identity.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}


describe("OrchestratorLedger globally unique identifiers across tenant scopes", () => {
  it("returns opaque conflicts for message and audit identifiers already owned by another tenant", async () => {
    const ledger = ledgerFor("global-identifiers-cross-tenant-collision");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keyHex = "d".repeat(64);
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = JSON.stringify({ test: keyHex });
      const sql = instance.ctx.storage.sql;
      const taskA = {
        taskId: "global-id-task-alpha",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        state: "SCHEDULED",
        version: 1,
        createdAt: now - 100,
        updatedAt: now - 50,
      };
      const taskB = {
        taskId: "global-id-task-beta",
        tenantId: "tenant-beta",
        projectId: "project-blue",
        state: "SCHEDULED",
        version: 1,
        createdAt: now - 100,
        updatedAt: now - 50,
      };
      for (const task of [taskA, taskB]) {
        sql.exec(
          "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          task.taskId, "idem-" + task.tenantId, "e".repeat(64), task.state, task.version,
          JSON.stringify(task), task.createdAt, task.updatedAt, task.tenantId, task.projectId,
        );
      }

      const messageId = "globally-owned-message";
      const inputHash = "f".repeat(64);
      const envelope = {
        protocolVersion: 1,
        messageId,
        taskId: taskB.taskId,
        correlationId: "global-id-correlation",
        senderId: "worker-a",
        recipientId: "worker-b",
        type: "PROGRESS",
        createdAt: now - 20,
        expiresAt: now + 5_000,
        scopeRef: {
          repository: "org/repo",
          baseBranch: "main",
          targetBranch: "feature/global-id",
          allowedPaths: ["src/**"],
        },
        inputHash,
        evidenceRefs: [],
        payload: { progress: "tenant-local retry must not collide through an exception" },
      };
      sql.exec(
        "INSERT INTO orchestrator_processed_messages (message_id, task_id, input_hash, envelope_json, received_at, status, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, 'ACCEPTED', ?, ?)",
        messageId, taskA.taskId, "a".repeat(64), JSON.stringify({ owner: "tenant-alpha" }),
        now - 10, taskA.tenantId, taskA.projectId,
      );

      const auditEventId = "globally-owned-audit-event";
      sql.exec(
        "INSERT INTO orchestrator_audit_events (event_id, task_id, actor_id, actor_role, event_type, details_json, previous_hash, event_hash, created_at, tenant_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        auditEventId, taskA.taskId, "worker-a", "agent", "TASK_NOTE",
        JSON.stringify({ owner: "tenant-alpha" }), null, "b".repeat(64), now - 5,
        taskA.tenantId, taskA.projectId,
      );

      const assertion = operation => createAgentWorkerAssertion(
        JSON.stringify({ test: keyHex }), "test", {
          subject: "worker-a", operation, tenantId: taskB.tenantId,
          projectId: taskB.projectId, taskId: taskB.taskId, nowMs: now,
        },
      );
      const messageResult = await instance.recordMessage({
        messageId,
        taskId: taskB.taskId,
        tenantId: taskB.tenantId,
        projectId: taskB.projectId,
        inputHash,
        envelope,
        workerId: "worker-a",
        workerAssertion: await assertion("recordMessage"),
        now,
      });
      const auditResult = await instance.appendAuditEvent({
        eventId: auditEventId,
        taskId: taskB.taskId,
        tenantId: taskB.tenantId,
        projectId: taskB.projectId,
        actor: { id: "worker-a", role: "agent" },
        workerId: "worker-a",
        workerAssertion: await assertion("appendAuditEvent"),
        eventType: "TASK_NOTE",
        details: { owner: "tenant-beta" },
        now,
      });

      expect(messageResult).toMatchObject({
        accepted: false,
        conflict: true,
        reason: "MESSAGE_ID_CONFLICT",
      });
      expect(auditResult).toMatchObject({
        appended: false,
        conflict: true,
        reason: "EVENT_ID_CONFLICT",
      });
      expect(sql.exec(
        "SELECT tenant_id, project_id, task_id FROM orchestrator_processed_messages WHERE message_id = ?",
        messageId,
      ).one()).toEqual({
        tenant_id: taskA.tenantId,
        project_id: taskA.projectId,
        task_id: taskA.taskId,
      });
      expect(sql.exec(
        "SELECT tenant_id, project_id, task_id, details_json FROM orchestrator_audit_events WHERE event_id = ?",
        auditEventId,
      ).one()).toEqual({
        tenant_id: taskA.tenantId,
        project_id: taskA.projectId,
        task_id: taskA.taskId,
        details_json: JSON.stringify({ owner: "tenant-alpha" }),
      });
    });
  });

  it("rejects a Task ID already owned by another tenant/project without altering the original Task or Claim Candidate", async () => {
    const ledger = ledgerFor("global-task-id-collision-across-tenant-scopes");
    await runInDurableObject(ledger, async instance => {
      const now = 1_800_000_000_000;
      const keySet = JSON.stringify({ test: "a".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = keySet;
      const taskId = "global-task-id-owner";

      const create = async ({ tenantId, projectId, idempotencyKey, inputHash }) => {
        const workerAssertion = await createScheduledWorkerAssertion(keySet, "test", {
          subject: "orchestrator-scheduler",
          role: "system",
          operation: "createTask",
          nowMs: now,
        });
        const verified = await verifyWorkerAssertion(keySet, workerAssertion, {
          subject: "orchestrator-scheduler",
          role: "system",
          operation: "createTask",
          nowMs: now,
        });
        const outcome = await instance.createTask({
          task: {
            taskId,
            tenantId,
            projectId,
            state: "SCHEDULED",
            version: 1,
            createdAt: now,
            updatedAt: now,
            executorId: "worker-a",
            agentRound: 0,
          },
          idempotencyKey,
          inputHash,
          now,
          workerId: "orchestrator-scheduler",
          workerAssertion,
        }).then(
          result => ({ threw: false, result }),
          error => ({ threw: true, errorName: error?.name ?? "UnknownError" }),
        );
        return { outcome, jti: verified.jti };
      };

      const original = await create({
        tenantId: "tenant-alpha",
        projectId: "project-red",
        idempotencyKey: "create-alpha-original",
        inputHash: "b".repeat(64),
      });
      const collision = await create({
        tenantId: "tenant-beta",
        projectId: "project-blue",
        idempotencyKey: "create-beta-substitute",
        inputHash: "c".repeat(64),
      });

      const sql = instance.ctx.storage.sql;
      const persistedTasks = sql.exec(
        "SELECT task_id, tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        taskId,
      ).toArray();
      const claimCandidates = sql.exec(
        "SELECT task_id, executor_id, tenant_id, project_id FROM orchestrator_claim_candidates WHERE task_id = ?",
        taskId,
      ).toArray();
      const consumedAssertions = sql.exec(
        "SELECT jti FROM orchestrator_consumed_assertions WHERE jti IN (?, ?) ORDER BY jti",
        original.jti,
        collision.jti,
      ).toArray();

      expect(original.outcome).toMatchObject({
        threw: false,
        result: {
          created: true,
          task: {
            taskId,
            tenantId: "tenant-alpha",
            projectId: "project-red",
            state: "SCHEDULED",
            version: 1,
          },
        },
      });
      expect(collision.outcome).toEqual({
        threw: false,
        result: {
          created: false,
          conflict: true,
          reason: "TASK_ID_CONFLICT",
        },
      });
      expect(persistedTasks).toEqual([{
        task_id: taskId,
        tenant_id: "tenant-alpha",
        project_id: "project-red",
      }]);
      expect(claimCandidates).toEqual([{
        task_id: taskId,
        executor_id: "worker-a",
        tenant_id: "tenant-alpha",
        project_id: "project-red",
      }]);
      expect(consumedAssertions).toEqual(
        [original.jti, collision.jti].sort().map(jti => ({ jti })),
      );
      expect(instance.getTask({
        taskId,
        tenantId: "tenant-alpha",
        projectId: "project-red",
      })).toMatchObject({
        taskId,
        tenantId: "tenant-alpha",
        projectId: "project-red",
        state: "SCHEDULED",
        version: 1,
      });
      expect(instance.getTask({
        taskId,
        tenantId: "tenant-beta",
        projectId: "project-blue",
      })).toBeNull();
    });
  });

});
