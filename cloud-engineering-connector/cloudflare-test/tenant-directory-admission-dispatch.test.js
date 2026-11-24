import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createSchedulerInvocationAssertion } from "../orchestrator-scheduler-invocation.js";

const ADMIN_KEYS = JSON.stringify({ test: "e".repeat(64) });
const SCHEDULER_KEYS = JSON.stringify({ "scheduler-k1": "a".repeat(64) });
const WORKER_KEYS = JSON.stringify({ "worker-k1": "f".repeat(64) });
const CRON = "*/5 * * * *";

async function createFixture(suffix) {
  const now = Date.now();
  const tenantId = "admission-dispatch-tenant-" + suffix + "-" + crypto.randomUUID();
  const projectId = "admission-dispatch-project-" + suffix;
  const principalId = "admission-dispatch-principal-" + suffix;
  const taskId = "admission-dispatch-task-" + suffix + "-" + crypto.randomUUID();
  const action = "task.create";
  const resourceDigest = "d".repeat(64);
  const idempotencyKey = "admission-dispatch-" + suffix + "-" + now;
  const task = {
    taskId,
    tenantId,
    projectId,
    state: "SCHEDULED",
    version: 1,
    createdAt: now,
    updatedAt: now,
    executorId: "admission-dispatch-executor",
    title: "Dispatch recovery task",
  };
  const directory = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  const ledger = env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(tenantId));

  await runInDurableObject(directory, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = ADMIN_KEYS;
    instance.env.SCHEDULER_INVOCATION_KEYS = SCHEDULER_KEYS;
    instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
    instance.env.LEDGER_WORKER_ASSERTION_ACTIVE_KEY_ID = "worker-k1";
  });
  await runInDurableObject(ledger, instance => {
    instance.env.TENANT_DIRECTORY = env.TENANT_DIRECTORY;
    instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEYS;
  });

  const admin = (operation, project, target, issuedAt) =>
    createTenantDirectoryAdminAssertion(ADMIN_KEYS, "test", {
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
    assertion: await admin("upsertMembership", null, membership, now),
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
    policyVersion: "dispatch-v1",
    status: "active",
    expectedVersion: 0,
  };
  await directory.upsertProjectPolicy({
    assertion: await admin("upsertProjectPolicy", projectId, policy, now + 1),
    tenantId,
    ...policy,
    now: now + 1,
  });

  const invocationId = "dispatch-invocation-" + crypto.randomUUID();
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

  return {
    now,
    tenantId,
    projectId,
    principalId,
    task,
    idempotencyKey,
    admissionReceipt,
    directory,
    ledger,
  };
}

describe("TenantDirectory durable Admission Outbox dispatch", () => {
  it("projects a persisted Task and Receipt to the tenant Ledger and marks the Outbox delivered", async () => {
    const data = await createFixture("success");
    const scheduledAlarm = await runInDurableObject(data.directory, instance =>
      instance.ctx.storage.getAlarm(),
    );
    expect(typeof scheduledAlarm).toBe("number");

    await runInDurableObject(data.directory, instance => {
      instance.ctx.storage.sql.exec(
        "UPDATE tenant_admission_outbox SET next_attempt_at = ? WHERE admission_id = ?",
        Date.now() - 1,
        data.admissionReceipt.claims.admissionId,
      );
      instance.ctx.storage.setAlarm(Date.now() + 1_000);
    });
    const executed = await runDurableObjectAlarm(data.directory);
    expect(executed).toBe(true);

    const directoryState = await runInDurableObject(data.directory, instance => ({
      outbox: instance.ctx.storage.sql.exec(
        "SELECT status, attempts, last_error_code FROM tenant_admission_outbox WHERE admission_id = ?",
        data.admissionReceipt.claims.admissionId,
      ).one(),
    }));
    expect(directoryState.outbox.status).toBe("DELIVERED");
    expect(directoryState.outbox.attempts).toBe(1);
    expect(directoryState.outbox.last_error_code).toBeNull();

    const ledgerState = await runInDurableObject(data.ledger, instance => ({
      task: instance.ctx.storage.sql.exec(
        "SELECT task_id, tenant_id, project_id FROM orchestrator_tasks WHERE task_id = ?",
        data.task.taskId,
      ).one(),
      admissionCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE admission_id = ?",
        data.admissionReceipt.claims.admissionId,
      ).one().count,
      outboxCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE task_id = ? AND event_type='task.admitted'",
        data.task.taskId,
      ).one().count,
    }));
    expect(ledgerState.task).toEqual({
      task_id: data.task.taskId,
      tenant_id: data.tenantId,
      project_id: data.projectId,
    });
    expect(ledgerState.admissionCount).toBe(1);
    expect(ledgerState.outboxCount).toBe(1);
  });

  it("replays the same Admission after Ledger commit when the first RPC acknowledgement is lost", async () => {
    const data = await createFixture("ack-loss");
    const namespace = env.ORCHESTRATOR_LEDGER;
    const ledgerStub = data.ledger;
    let loseFirstAcknowledgement = true;

    await runInDurableObject(data.directory, instance => {
      instance.env.ORCHESTRATOR_LEDGER = {
        idFromName(name) {
          return namespace.idFromName(name);
        },
        get(id) {
          return {
            async createTask(input) {
              const result = await ledgerStub.createTask(input);
              if (loseFirstAcknowledgement) {
                loseFirstAcknowledgement = false;
                throw new Error("TEST_LEDGER_ACKNOWLEDGEMENT_LOST");
              }
              return result;
            },
          };
        },
      };
    });

    await runInDurableObject(data.directory, instance => {
      instance.ctx.storage.sql.exec(
        "UPDATE tenant_admission_outbox SET next_attempt_at = ? WHERE admission_id = ?",
        Date.now() - 1,
        data.admissionReceipt.claims.admissionId,
      );
      instance.ctx.storage.setAlarm(Date.now() + 1_000);
    });
    const firstRun = await runDurableObjectAlarm(data.directory);
    expect(firstRun).toBe(true);

    const afterLostAcknowledgement = await runInDurableObject(data.directory, instance =>
      instance.ctx.storage.sql.exec(
        "SELECT status, attempts, last_error_code FROM tenant_admission_outbox WHERE admission_id = ?",
        data.admissionReceipt.claims.admissionId,
      ).one(),
    );
    expect(afterLostAcknowledgement.status).toBe("RETRY_WAIT");
    expect(afterLostAcknowledgement.attempts).toBe(1);

    const ledgerTaskCount = await runInDurableObject(data.ledger, instance =>
      instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id = ?",
        data.task.taskId,
      ).one().count,
    );
    expect(ledgerTaskCount).toBe(1);

    await runInDurableObject(data.directory, instance => {
      instance.ctx.storage.sql.exec(
        "UPDATE tenant_admission_outbox SET next_attempt_at = ? WHERE admission_id = ?",
        Date.now(),
        data.admissionReceipt.claims.admissionId,
      );
      instance.ctx.storage.setAlarm(Date.now() + 1_000);
    });

    const secondRun = await runDurableObjectAlarm(data.directory);
    expect(secondRun).toBe(true);
    const finalState = await runInDurableObject(data.directory, instance =>
      instance.ctx.storage.sql.exec(
        "SELECT status, attempts FROM tenant_admission_outbox WHERE admission_id = ?",
        data.admissionReceipt.claims.admissionId,
      ).one(),
    );
    expect(finalState.status).toBe("DELIVERED");
    expect(finalState.attempts).toBe(2);

    const finalLedgerCounts = await runInDurableObject(data.ledger, instance => ({
      tasks: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id = ?",
        data.task.taskId,
      ).one().count,
      receipts: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE admission_id = ?",
        data.admissionReceipt.claims.admissionId,
      ).one().count,
      events: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE task_id = ? AND event_type='task.admitted'",
        data.task.taskId,
      ).one().count,
    }));
    expect(finalLedgerCounts).toEqual({ tasks: 1, receipts: 1, events: 1 });
  });
});
