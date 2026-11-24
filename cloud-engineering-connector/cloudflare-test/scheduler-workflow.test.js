import { env } from "cloudflare:workers";
import { createScheduledController, introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import schedulerWorker from "../orchestrator-scheduler-worker.js";
import {
  admitPreparedScheduledTask,
  prepareScheduledAdmission,
  scheduledWorkflowId,
  verifyPreparedScheduledAdmission,
} from "../orchestrator-scheduler-admission.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";

const DIRECTORY_ADMIN_KEY_SET = JSON.stringify({ test: "e".repeat(64) });
const WORKER_KEY_SET = JSON.stringify({ test: "f".repeat(64) });
const CRON = "0 * * * *";
const PROJECT_ID = "project-scheduler-workflow";

async function provisionTenant(tenantId) {
  const now = Date.now();
  const principalId = "principal-scheduler-workflow";
  const membershipId = "membership-scheduler-workflow";
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKeys = JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.privateKey) });
  const publicKeys = JSON.stringify({ test: await crypto.subtle.exportKey("jwk", pair.publicKey) });
  const directory = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));

  await runInDurableObject(directory, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = DIRECTORY_ADMIN_KEY_SET;
    instance.env.TENANT_DIRECTORY_ADMISSION_PRIVATE_KEYS = privateKeys;
    instance.env.TENANT_DIRECTORY_ADMISSION_ACTIVE_KID = "test";
  });

  const adapters = createTenantDirectoryAdapters(env.TENANT_DIRECTORY, tenantId);
  const adminAssertion = (operation, project, target) =>
    createTenantDirectoryAdminAssertion(DIRECTORY_ADMIN_KEY_SET, "test", {
      subject: "tenant-directory-provisioner",
      operation,
      tenantId,
      projectId: project,
      nowMs: now,
      target,
    });

  await adapters.provisioningStore.upsertMembership({
    assertion: await adminAssertion("upsertMembership", null, {
      principalId,
      membershipId,
      role: "tenant-member",
      status: "active",
      expectedVersion: 0,
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
    assertion: await adminAssertion("upsertProjectPolicy", PROJECT_ID, {
      projectId: PROJECT_ID,
      principalId,
      action: "task.create",
      resourceDigest: "*",
      effect: "allow",
      policyVersion: "scheduler-workflow-v1",
      status: "active",
      expectedVersion: 0,
    }),
    tenantId,
    projectId: PROJECT_ID,
    principalId,
    action: "task.create",
    resourceDigest: "*",
    effect: "allow",
    policyVersion: "scheduler-workflow-v1",
    status: "active",
    expectedVersion: 0,
    now,
  });

  const ledger = env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(tenantId));
  await runInDurableObject(ledger, instance => {
    instance.env.LEDGER_WORKER_ASSERTION_KEYS = env.LEDGER_WORKER_ASSERTION_KEYS;
    instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = publicKeys;
  });

  return { tenantId, projectId: PROJECT_ID, principalId, directory, ledger };
}

function taskPolicy(tenantId, suffix) {
  return {
    tenantId,
    projectId: PROJECT_ID,
    taskIdPrefix: "workflow-task-" + suffix,
    idempotencyPrefix: "workflow-idem-" + suffix,
    taskTemplate: {
      executorId: "scheduler-workflow-worker",
      taskKind: "scheduled-workflow-admission",
    },
  };
}

function workflowContext() {
  return { exports: { ScheduledTaskAdmissionWorkflow: env.SCHEDULED_TASK_ADMISSION } };
}

function schedulerEnv(policies) {
  const result = Object.create(env);
  Object.assign(result, {
    SCHEDULED_ADMISSION_POLICIES: JSON.stringify(policies),
    LEDGER_WORKER_ASSERTION_KEYS: WORKER_KEY_SET,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test",
  });
  return result;
}

function controller(scheduledTime = Date.now()) {
  return createScheduledController({ scheduledTime: new Date(scheduledTime), cron: CRON });
}

describe("durable Scheduler Workflow admission", () => {
  it("persists per-Task steps, retries a transient step failure, and deduplicates the same Cron event", async () => {
    const tenantId = "tenant-scheduler-workflow-" + crypto.randomUUID();
    const fixture = await provisionTenant(tenantId);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const policy = {
      servicePrincipalId: fixture.principalId,
      tasks: [taskPolicy(tenantId, suffix)],
    };
    const event = controller();
    const envForEvent = schedulerEnv({ [CRON]: policy });
    const snapshot = await prepareScheduledAdmission(event, envForEvent);
    const workflowId = await scheduledWorkflowId(snapshot);
    expect(workflowId.length).toBeLessThanOrEqual(100);

    await using instance = await introspectWorkflowInstance(env.SCHEDULED_TASK_ADMISSION, workflowId);
    await instance.modify(async modify => {
      await modify.disableRetryDelays();
      await modify.mockStepError(
        { name: "admit-task-01" },
        new Error("Injected transient failure before task admission."),
        1,
      );
    });

    const accepted = await schedulerWorker.scheduled(event, envForEvent, workflowContext());
    expect(accepted).toMatchObject({
      accepted: true,
      created: true,
      duplicate: false,
      workflowId,
    });
    await instance.waitForStatus("complete");
    const output = await instance.getOutput();
    expect(output).toMatchObject({
      version: 1,
      cron: CRON,
      scheduledTime: event.scheduledTime,
      processed: 1,
      created: 1,
      replayed: 0,
    });

    const duplicate = await schedulerWorker.scheduled(event, envForEvent, workflowContext());
    expect(duplicate).toMatchObject({
      accepted: true,
      created: false,
      duplicate: true,
      workflowId,
      status: "complete",
    });

    await runInDurableObject(fixture.ledger, instance => {
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE tenant_id=?",
        tenantId,
      ).one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE tenant_id=?",
        tenantId,
      ).one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE tenant_id=? AND event_type='task.admitted'",
        tenantId,
      ).one().count)).toBe(1);
    });
  });

  it("keeps earlier Task commits when a later Task fails permanently", async () => {
    const firstTenantId = "tenant-scheduler-workflow-first-" + crypto.randomUUID();
    const secondTenantId = "tenant-scheduler-workflow-denied-" + crypto.randomUUID();
    const first = await provisionTenant(firstTenantId);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const event = controller();
    const policy = {
      servicePrincipalId: first.principalId,
      tasks: [
        taskPolicy(firstTenantId, suffix + "a"),
        taskPolicy(secondTenantId, suffix + "b"),
      ],
    };
    const envForEvent = schedulerEnv({ [CRON]: policy });
    const snapshot = await prepareScheduledAdmission(event, envForEvent);
    const workflowId = await scheduledWorkflowId(snapshot);

    await using instance = await introspectWorkflowInstance(env.SCHEDULED_TASK_ADMISSION, workflowId);
    await instance.modify(async modify => {
      await modify.disableRetryDelays();
    });

    await schedulerWorker.scheduled(event, envForEvent, workflowContext());
    await instance.waitForStatus("errored");
    const error = await instance.getError();
    expect(error.name).toBe("NonRetryableError");

    const secondLedger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName(secondTenantId),
    );
    await runInDurableObject(first.ledger, ledger => {
      expect(Number(ledger.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE tenant_id=?",
        firstTenantId,
      ).one().count)).toBe(1);
      expect(Number(ledger.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE tenant_id=?",
        firstTenantId,
      ).one().count)).toBe(1);
    });
    await runInDurableObject(secondLedger, ledger => {
      expect(Number(ledger.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE tenant_id=?",
        secondTenantId,
      ).one().count)).toBe(0);
      expect(Number(ledger.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE tenant_id=?",
        secondTenantId,
      ).one().count)).toBe(0);
    });
  });

  it("uses the immutable Ledger receipt after a commit response is lost and the Directory Grant expires", async () => {
    const tenantId = "tenant-scheduler-workflow-lost-response-" + crypto.randomUUID();
    const fixture = await provisionTenant(tenantId);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const event = controller();
    const policy = {
      servicePrincipalId: fixture.principalId,
      tasks: [taskPolicy(tenantId, suffix)],
    };
    const envForEvent = schedulerEnv({ [CRON]: policy });
    const snapshot = await prepareScheduledAdmission(event, envForEvent);
    const item = snapshot.tasks[0];

    let prepareCalls = 0;
    let probeCalls = 0;
    let createCalls = 0;
    let loseResponse = true;
    const directoryNamespace = {
      idFromName: name => env.TENANT_DIRECTORY.idFromName(name),
      get: id => {
        const stub = env.TENANT_DIRECTORY.get(id);
        return {
          async prepareTaskAdmission(input) {
            prepareCalls += 1;
            return stub.prepareTaskAdmission(input);
          },
          async renewTaskAdmissionGrant(input) {
            return stub.renewTaskAdmissionGrant(input);
          },
        };
      },
    };
    const ledgerNamespace = {
      idFromName: name => env.ORCHESTRATOR_LEDGER.idFromName(name),
      get: id => {
        const stub = env.ORCHESTRATOR_LEDGER.get(id);
        return {
          async getTaskAdmissionReceipt(input) {
            probeCalls += 1;
            return stub.getTaskAdmissionReceipt(input);
          },
          async createTask(input) {
            createCalls += 1;
            const result = await stub.createTask(input);
            if (loseResponse) {
              loseResponse = false;
              throw Object.assign(new Error("Injected response loss after Ledger commit."), {
                code: "LEDGER_RPC_UNAVAILABLE",
              });
            }
            return result;
          },
        };
      },
    };
    const faultEnv = {
      SCHEDULED_ADMISSION_POLICIES: JSON.stringify({ [CRON]: policy }),
      LEDGER_WORKER_ASSERTION_KEYS: envForEvent.LEDGER_WORKER_ASSERTION_KEYS,
      LEDGER_WORKER_ASSERTION_ACTIVE_KID: envForEvent.LEDGER_WORKER_ASSERTION_ACTIVE_KID,
      TENANT_DIRECTORY: directoryNamespace,
      ORCHESTRATOR_LEDGER: ledgerNamespace,
    };

    await expect(admitPreparedScheduledTask(snapshot, item, faultEnv))
      .rejects.toMatchObject({ code: "LEDGER_RPC_UNAVAILABLE" });

    let expiresAt;
    await runInDurableObject(fixture.directory, directory => {
      expiresAt = Number(directory.ctx.storage.sql.exec(
        "SELECT expires_at FROM tenant_task_admission_reservations WHERE tenant_id=?",
        tenantId,
      ).one().expires_at);
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue((expiresAt + 6) * 1000);
    let replay;
    try {
      replay = await admitPreparedScheduledTask(snapshot, item, faultEnv);
    } finally {
      clock.mockRestore();
    }

    expect(replay).toMatchObject({
      tenantId,
      taskId: item.taskId,
      outcome: "replayed",
    });
    expect(prepareCalls).toBe(1);
    expect(probeCalls).toBe(2);
    expect(createCalls).toBe(1);
  });

  it("rejects a Workflow snapshot whose Task or digest was changed after preparation", async () => {
    const tenantId = "tenant-scheduler-workflow-snapshot-" + crypto.randomUUID();
    const fixture = await provisionTenant(tenantId);
    const event = controller();
    const envForEvent = schedulerEnv({
      [CRON]: {
        servicePrincipalId: fixture.principalId,
        tasks: [taskPolicy(tenantId, crypto.randomUUID().replace(/-/g, "").slice(0, 10))],
      },
    });
    const snapshot = await prepareScheduledAdmission(event, envForEvent);
    expect(await verifyPreparedScheduledAdmission(snapshot)).toMatchObject({
      version: 1,
      cron: CRON,
      scheduledTime: event.scheduledTime,
    });

    const tampered = structuredClone(snapshot);
    tampered.tasks[0].inputHash = "0".repeat(64);
    await expect(verifyPreparedScheduledAdmission(tampered))
      .rejects.toMatchObject({ code: "SCHEDULED_ADMISSION_SNAPSHOT_INVALID" });
  });
});
