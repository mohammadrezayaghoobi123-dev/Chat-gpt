import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";
import { taskAdmissionDigest } from "../orchestrator-admission.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

describe("OrchestratorLedger tenant/project idempotency isolation", () => {
  it("allows the same caller idempotency key in different tenant/project scopes", async () => {
    const ledger = ledgerFor("task-idempotency-same-key-different-tenants-" + crypto.randomUUID());
    const now = Date.now();
    const adminKeySet = JSON.stringify({ test: "f".repeat(64) });
    const workerKeySet = JSON.stringify({ test: "e".repeat(64) });
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const privateKeys = JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.privateKey) });
    const publicKeys = JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.publicKey) });

    const createDirectoryGrant = async ({ taskId, tenantId, projectId, inputHash }) => {
      const principalId = "principal-" + tenantId;
      const membershipId = "membership-" + tenantId;
      const directoryStub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
      await runInDurableObject(directoryStub, instance => {
        instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = adminKeySet;
        instance.env.TENANT_DIRECTORY_ADMISSION_PRIVATE_KEYS = privateKeys;
        instance.env.TENANT_DIRECTORY_ADMISSION_ACTIVE_KID = "test";
      });
      const adapters = createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
      const adminAssertion = async (operation, project, target) =>
        createTenantDirectoryAdminAssertion(adminKeySet, "test", {
          subject: "tenant-directory-provisioner",
          operation,
          tenantId,
          projectId: project,
          nowMs: now,
          target,
        });

      await adapters.provisioningStore.upsertMembership({
        assertion: await adminAssertion("upsertMembership", null, {
          principalId, membershipId, role: "tenant-member", status: "active", expectedVersion: 0,
        }),
        tenantId,
        principalId,
        membershipId,
        role: "tenant-member",
        status: "active",
        expectedVersion: 0,
        now,
      });
      await adapters.provisioningStore.upsertProjectPolicy({
        assertion: await adminAssertion("upsertProjectPolicy", projectId, {
          projectId, principalId, action: "task.create", resourceDigest: "*",
          effect: "allow", policyVersion: "task-create-v1", status: "active", expectedVersion: 0,
        }),
        tenantId,
        projectId,
        principalId,
        action: "task.create",
        resourceDigest: "*",
        effect: "allow",
        policyVersion: "task-create-v1",
        status: "active",
        expectedVersion: 0,
        now,
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
      };
      const reservation = await adapters.admissionStore.prepareTaskAdmission({
        tenantId,
        projectId,
        principalId,
        taskId,
        taskDigest: await taskAdmissionDigest(task),
        idempotencyKey: "client-request-42",
        inputHash,
      });
      return { task, grant: reservation.grant };
    };

    const firstAdmission = await createDirectoryGrant({
      taskId: "tenant-alpha-task-42",
      tenantId: "tenant-alpha",
      projectId: "project-red",
      inputHash: "1".repeat(64),
    });
    const secondAdmission = await createDirectoryGrant({
      taskId: "tenant-beta-task-42",
      tenantId: "tenant-beta",
      projectId: "project-blue",
      inputHash: "2".repeat(64),
    });

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = workerKeySet;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = publicKeys;
      const create = async admission => {
        const workerNow = Date.now();
        const workerAssertion = await createScheduledWorkerAssertion(workerKeySet, "test", {
          subject: "orchestrator-scheduler",
          role: "system",
          operation: "createTask",
          nowMs: workerNow,
        });
        return instance.createTask({
          task: admission.task,
          idempotencyKey: "client-request-42",
          inputHash: admission.task.tenantId === "tenant-alpha" ? "1".repeat(64) : "2".repeat(64),
          now: workerNow,
          workerId: "orchestrator-scheduler",
          workerAssertion,
          admissionGrant: admission.grant,
        });
      };

      const first = await create(firstAdmission);
      const second = await create(secondAdmission);
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
      const receipts = instance.ctx.storage.sql.exec(
        "SELECT task_id, tenant_id, project_id FROM orchestrator_task_admission_receipts WHERE tenant_id IN (?, ?) ORDER BY tenant_id",
        "tenant-alpha", "tenant-beta",
      ).toArray();
      expect(receipts).toEqual(rows);

      const outbox = instance.ctx.storage.sql.exec(
        "SELECT task_id, tenant_id, project_id, event_type FROM orchestrator_outbox_events WHERE tenant_id IN (?, ?) ORDER BY tenant_id",
        "tenant-alpha", "tenant-beta",
      ).toArray();
      expect(outbox).toEqual([
        { task_id: "tenant-alpha-task-42", tenant_id: "tenant-alpha", project_id: "project-red", event_type: "task.admitted" },
        { task_id: "tenant-beta-task-42", tenant_id: "tenant-beta", project_id: "project-blue", event_type: "task.admitted" },
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
