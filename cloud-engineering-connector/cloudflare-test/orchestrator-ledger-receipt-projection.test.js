import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createSchedulerInvocationAssertion } from "../orchestrator-scheduler-invocation.js";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

const ADMIN_KEYS = JSON.stringify({ test: "e".repeat(64) });
const SCHEDULER_KEYS = JSON.stringify({ "scheduler-k1": "a".repeat(64) });
const WORKER_KEYS = JSON.stringify({ test: "f".repeat(64) });
const CRON = "*/5 * * * *";

async function fixture(suffix) {
  const now = Date.now();
  const tenantId = "ledger-receipt-tenant-" + suffix + "-" + crypto.randomUUID();
  const projectId = "ledger-receipt-project-" + suffix;
  const principalId = "ledger-receipt-principal-" + suffix;
  const taskId = "ledger-receipt-task-" + suffix + "-" + crypto.randomUUID();
  const action = "task.create";
  const resourceDigest = "a".repeat(64);
  const idempotencyKey = "ledger-receipt-request-" + suffix;
  const task = {
    taskId,
    tenantId,
    projectId,
    state: "SCHEDULED",
    version: 1,
    createdAt: now,
    updatedAt: now,
    executorId: "ledger-receipt-executor",
  };
  const directory = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  await runInDurableObject(directory, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = ADMIN_KEYS;
    instance.env.SCHEDULER_INVOCATION_KEYS = SCHEDULER_KEYS;
  });

  const adminAssertion = (operation, project, target, issuedAt) =>
    createTenantDirectoryAdminAssertion(ADMIN_KEYS, "test", {
      subject: "tenant-directory-provisioner",
      operation,
      tenantId,
      projectId: project,
      nowMs: issuedAt,
      target,
    });

  const membership = {
    principalId,
    membershipId: "membership-" + principalId,
    role: "tenant-member",
    status: "active",
    expectedVersion: 0,
  };
  await directory.upsertMembership({
    assertion: await adminAssertion("upsertMembership", null, membership, now),
    tenantId,
    ...membership,
    now,
  });

  const policy = {
    projectId,
    principalId,
    action,
    resourceDigest: "*",
    effect: "allow",
    policyVersion: "task-create-v1",
    status: "active",
    expectedVersion: 0,
  };
  await directory.upsertProjectPolicy({
    assertion: await adminAssertion("upsertProjectPolicy", projectId, policy, now + 1),
    tenantId,
    ...policy,
    now: now + 1,
  });

  const invocationId = "ledger-receipt-invocation-" + suffix + "-" + crypto.randomUUID();
  const schedulerAssertion = await createSchedulerInvocationAssertion(
    SCHEDULER_KEYS,
    "scheduler-k1",
    { invocationId, cron: CRON, scheduledTime: now, nowMs: now + 2 },
  );
  const admissionReceipt = await directory.issueAdmissionReceipt({
    tenantId,
    principalId,
    projectId,
    action,
    resourceDigest,
    task,
    idempotencyKey,
    cron: CRON,
    scheduledTime: now,
    invocationId,
    schedulerAssertion,
    now: now + 2,
  });

  const ledger = env.ORCHESTRATOR_LEDGER.get(
    env.ORCHESTRATOR_LEDGER.idFromName("ledger-receipt-projection-" + suffix + "-" + crypto.randomUUID()),
  );
  await runInDurableObject(ledger, instance => {
    instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
  });
  return {
    now: now + 3,
    tenantId,
    projectId,
    principalId,
    task,
    idempotencyKey,
    inputHash: "b".repeat(64),
    admissionReceipt,
    ledger,
  };
}

async function workerAssertion(now) {
  return createScheduledWorkerAssertion(WORKER_KEYS, "test", {
    subject: "orchestrator-scheduler",
    role: "system",
    operation: "createTask",
    nowMs: now,
  });
}

async function projectTask(instance, data, overrides = {}) {
  const now = overrides.now ?? Date.now();
  return instance.createTask({
    task: overrides.task ?? data.task,
    idempotencyKey: overrides.idempotencyKey ?? data.idempotencyKey,
    inputHash: overrides.inputHash ?? data.inputHash,
    now,
    workerId: "orchestrator-scheduler",
    workerAssertion: overrides.workerAssertion ?? await workerAssertion(now),
    ...(Object.hasOwn(overrides, "admissionReceipt")
      ? { admissionReceipt: overrides.admissionReceipt }
      : { admissionReceipt: data.admissionReceipt }),
  });
}

describe("OrchestratorLedger signed Admission Receipt projection", () => {
  it("rejects the legacy HMAC-only Task creation path without writing any state", async () => {
    const data = await fixture("missing");
    const result = await runInDurableObject(data.ledger, async instance => {
      const now = Date.now();
      return instance.createTask({
        task: data.task,
        idempotencyKey: data.idempotencyKey,
        inputHash: data.inputHash,
        now,
        workerId: "orchestrator-scheduler",
        workerAssertion: await workerAssertion(now),
      });
    });
    expect(result).toEqual({ created: false, reason: "TASK_ADMISSION_REQUIRED" });

    const counts = await runInDurableObject(data.ledger, instance => ({
      tasks: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks",
      ).one().count,
      assertions: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions",
      ).one().count,
      receipts: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts",
      ).one().count,
      outbox: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events",
      ).one().count,
    }));
    expect(counts).toEqual({ tasks: 0, assertions: 0, receipts: 0, outbox: 0 });
  });

  it("projects a Directory-signed Receipt atomically and permits only identical replay", async () => {
    const data = await fixture("valid");
    const first = await runInDurableObject(data.ledger, instance => projectTask(instance, data));
    expect(first.created).toBe(true);
    expect(first.admissionReceipt).toMatchObject({
      admissionId: data.admissionReceipt.claims.admissionId,
      jti: data.admissionReceipt.claims.jti,
      keyId: data.admissionReceipt.keyId,
    });
    expect(first.outbox).toMatchObject({
      enqueued: true,
      event: { eventType: "task.admitted", status: "PENDING" },
    });

    const replay = await runInDurableObject(data.ledger, instance => projectTask(instance, data));
    expect(replay).toMatchObject({
      created: false,
      replay: true,
      admissionReceipt: {
        admissionId: data.admissionReceipt.claims.admissionId,
        jti: data.admissionReceipt.claims.jti,
      },
    });

    const counts = await runInDurableObject(data.ledger, instance => ({
      tasks: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id = ?",
        data.task.taskId,
      ).one().count,
      receipts: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE admission_id = ?",
        data.admissionReceipt.claims.admissionId,
      ).one().count,
      outbox: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE task_id = ? AND event_type = 'task.admitted'",
        data.task.taskId,
      ).one().count,
    }));
    expect(counts).toEqual({ tasks: 1, receipts: 1, outbox: 1 });
  });

  it("rejects a modified Task or tampered Receipt signature before writes", async () => {
    const data = await fixture("tamper");
    const substitutedTask = { ...data.task, projectId: "project-foreign" };
    const substituted = await runInDurableObject(data.ledger, instance =>
      projectTask(instance, data, { task: substitutedTask }),
    );
    expect(substituted).toEqual({ created: false, reason: "TASK_ADMISSION_INVALID" });

    const tampered = {
      ...data.admissionReceipt,
      signature: (data.admissionReceipt.signature[0] === "A" ? "B" : "A") +
        data.admissionReceipt.signature.slice(1),
    };
    const invalid = await runInDurableObject(data.ledger, instance =>
      projectTask(instance, data, { admissionReceipt: tampered }),
    );
    expect(invalid).toEqual({ created: false, reason: "TASK_ADMISSION_INVALID" });

    const tasks = await runInDurableObject(data.ledger, instance =>
      instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count,
    );
    expect(tasks).toBe(0);
  });

  it("rolls back Task, receipt consumption, worker JTI, and Outbox together when Outbox insertion fails", async () => {
    const data = await fixture("rollback");
    const workerNow = Date.now();
    const assertion = await workerAssertion(workerNow);
    await runInDurableObject(data.ledger, instance => {
      instance.ctx.storage.sql.exec(
        "CREATE TRIGGER reject_task_admitted_outbox BEFORE INSERT ON orchestrator_outbox_events " +
        "WHEN NEW.event_type = 'task.admitted' " +
        "BEGIN SELECT RAISE(ABORT, 'TEST_TASK_ADMISSION_OUTBOX_ABORT'); END",
      );
    });

    await expect(runInDurableObject(data.ledger, instance =>
      projectTask(instance, data, { now: workerNow, workerAssertion: assertion }),
    )).rejects.toThrow();

    const aborted = await runInDurableObject(data.ledger, instance => ({
      tasks: instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count,
      assertions: instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count,
      receipts: instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts").one().count,
      outbox: instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count,
    }));
    expect(aborted).toEqual({ tasks: 0, assertions: 0, receipts: 0, outbox: 0 });

    await runInDurableObject(data.ledger, instance => {
      instance.ctx.storage.sql.exec("DROP TRIGGER reject_task_admitted_outbox");
    });
    const retry = await runInDurableObject(data.ledger, instance =>
      projectTask(instance, data, { now: workerNow, workerAssertion: assertion }),
    );
    expect(retry.created).toBe(true);
  });
});
