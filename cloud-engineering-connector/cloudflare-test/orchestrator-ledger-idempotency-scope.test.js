import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createSchedulerInvocationAssertion } from "../orchestrator-scheduler-invocation.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger tenant/project idempotency isolation", () => {
  it("allows the same caller idempotency key in different tenant/project scopes with signed Admissions", async () => {
    const ledger = ledgerFor("task-idempotency-same-key-different-tenants");
    const now = Date.now();
    const adminKeys = JSON.stringify({ test: "e".repeat(64) });
    const schedulerKeys = JSON.stringify({ "scheduler-k1": "a".repeat(64) });
    const workerKeys = JSON.stringify({ test: "f".repeat(64) });
    await runInDurableObject(ledger, instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = workerKeys;
    });

    const create = async ({ taskId, tenantId, projectId, inputHash }) => {
      const principalId = "scheduler-" + tenantId;
      const directory = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
      await runInDurableObject(directory, instance => {
        instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = adminKeys;
        instance.env.SCHEDULER_INVOCATION_KEYS = schedulerKeys;
      });
      const admin = (operation, target, project = projectId, issuedAt = now) =>
        createTenantDirectoryAdminAssertion(adminKeys, "test", {
          subject: "tenant-directory-provisioner",
          operation,
          tenantId,
          projectId: project,
          target,
          nowMs: issuedAt,
        });
      const membership = {
        principalId,
        membershipId: "membership-" + principalId,
        role: "tenant-member",
        status: "active",
        expectedVersion: 0,
      };
      await directory.upsertMembership({
        assertion: await admin("upsertMembership", membership, null),
        tenantId,
        ...membership,
        now,
      });
      const policy = {
        projectId,
        principalId,
        action: "task.create",
        resourceDigest: "*",
        effect: "allow",
        policyVersion: "task-create-v1",
        status: "active",
        expectedVersion: 0,
      };
      await directory.upsertProjectPolicy({
        assertion: await admin("upsertProjectPolicy", policy, projectId, now + 1),
        tenantId,
        ...policy,
        now: now + 1,
      });
      const task = {
        taskId,
        tenantId,
        projectId,
        state: "SCHEDULED",
        version: 1,
        createdAt: now,
        updatedAt: now,
        executorId: "worker-a",
        agentRound: 0,
      };
      const invocationId = "idempotency-invocation-" + tenantId;
      const schedulerAssertion = await createSchedulerInvocationAssertion(
        schedulerKeys,
        "scheduler-k1",
        { invocationId, cron: "*/5 * * * *", scheduledTime: now, nowMs: now + 2 },
      );
      const admissionReceipt = await directory.issueAdmissionReceipt({
        tenantId,
        principalId,
        projectId,
        action: "task.create",
        resourceDigest: "b".repeat(64),
        task,
        idempotencyKey: "client-request-42",
        cron: "*/5 * * * *",
        scheduledTime: now,
        invocationId,
        schedulerAssertion,
        now: now + 2,
      });
      const workerAssertion = await createScheduledWorkerAssertion(workerKeys, "test", {
        subject: "orchestrator-scheduler",
        role: "system",
        operation: "createTask",
        nowMs: now + 3,
      });
      return ledger.createTask({
        task,
        idempotencyKey: "client-request-42",
        inputHash,
        now: now + 3,
        workerId: "orchestrator-scheduler",
        workerAssertion,
        admissionReceipt,
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
    const rows = await runInDurableObject(ledger, instance => instance.ctx.storage.sql.exec(
      "SELECT task_id, tenant_id, project_id FROM orchestrator_tasks WHERE tenant_id IN (?, ?) ORDER BY tenant_id",
      "tenant-alpha", "tenant-beta",
    ).toArray());
    expect(rows).toEqual([
      { task_id: "tenant-alpha-task-42", tenant_id: "tenant-alpha", project_id: "project-red" },
      { task_id: "tenant-beta-task-42", tenant_id: "tenant-beta", project_id: "project-blue" },
    ]);
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

      const legacyTask = {
        taskId: "v8-unmapped-task",
        state: "SCHEDULED",
        version: 1,
        createdAt: now + 1,
        updatedAt: now + 1,
      };
      sql.exec(
        "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        legacyTask.taskId, "legacy-unmapped-client-key", "4".repeat(64),
        legacyTask.state, legacyTask.version, JSON.stringify(legacyTask),
        legacyTask.createdAt, legacyTask.updatedAt,
      );
      sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_generation, lease_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, 0, ?, ?)",
        "v8-unmapped-event", "legacy-unmapped-outbox-key", legacyTask.taskId,
        "task.created", JSON.stringify({ taskId: legacyTask.taskId, version: 1 }),
        now + 2, now + 2,
      );

      instance.ensureSchema();
      const legacyTaskKey = sql.exec(
        "SELECT idempotency_key FROM orchestrator_tasks WHERE task_id = ?",
        legacyTask.taskId,
      ).one().idempotency_key;
      const legacyEventKey = sql.exec(
        "SELECT idempotency_key FROM orchestrator_outbox_events WHERE event_id = ?",
        "v8-unmapped-event",
      ).one().idempotency_key;
      expect(legacyTaskKey).toBe(scoped("__legacy__", "__legacy__", "legacy-unmapped-client-key"));
      expect(legacyEventKey).toBe(scoped("__legacy__", "__legacy__", "legacy-unmapped-outbox-key"));

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
