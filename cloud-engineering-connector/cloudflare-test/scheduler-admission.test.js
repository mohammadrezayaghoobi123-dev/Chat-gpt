import { env } from "cloudflare:workers";
import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import schedulerWorker from "../orchestrator-scheduler-worker.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";

const WORKER_KEY_SET = JSON.stringify({ test: "f".repeat(64) });
const DIRECTORY_ADMIN_KEY_SET = JSON.stringify({ test: "e".repeat(64) });
const CRON = "0 * * * *";

async function provisionTenant(tenantId, configureLedger = true) {
  const now = Date.now();
  const projectId = "project-scheduled-admission";
  const principalId = "principal-scheduled-admission";
  const membershipId = "membership-scheduled-admission";
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
    assertion: await adminAssertion("upsertProjectPolicy", projectId, {
      projectId,
      principalId,
      action: "task.create",
      resourceDigest: "*",
      effect: "allow",
      policyVersion: "scheduled-task-create-v1",
      status: "active",
      expectedVersion: 0,
    }),
    tenantId,
    projectId,
    principalId,
    action: "task.create",
    resourceDigest: "*",
    effect: "allow",
    policyVersion: "scheduled-task-create-v1",
    status: "active",
    expectedVersion: 0,
    now,
  });

  let ledger = null;
  if (configureLedger) {
    ledger = env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(tenantId));
    await runInDurableObject(ledger, instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEY_SET;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = publicKeys;
    });
  }

  return { tenantId, projectId, principalId, directory, ledger };
}

function makeSchedulerEnv(policies) {
  const schedulerEnv = Object.create(env);
  Object.assign(schedulerEnv, {
    SCHEDULED_ADMISSION_POLICIES: JSON.stringify(policies),
    LEDGER_WORKER_ASSERTION_KEYS: WORKER_KEY_SET,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test",
  });
  return schedulerEnv;
}

function taskPolicy(tenantId, projectId, suffix) {
  return {
    tenantId,
    projectId,
    taskIdPrefix: "scheduled-task-" + suffix,
    idempotencyPrefix: "scheduled-idem-" + suffix,
    taskTemplate: {
      executorId: "scheduled-executor",
      taskKind: "scheduled-reconciliation",
    },
  };
}

describe("Scheduler tenant Task admission", () => {
  it("admits through TenantDirectory and OrchestratorLedger, then replays the same scheduled event idempotently", async () => {
    const tenantId = "tenant-scheduled-admission-" + crypto.randomUUID();
    const fixture = await provisionTenant(tenantId);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const policy = {
      servicePrincipalId: fixture.principalId,
      tasks: [taskPolicy(fixture.tenantId, fixture.projectId, suffix)],
    };
    const schedulerEnv = makeSchedulerEnv({ [CRON]: policy });
    const scheduledTime = Date.now();
    const controller = createScheduledController({
      scheduledTime: new Date(scheduledTime),
      cron: CRON,
    });
    const context = { waitUntil: vi.fn() };
    const taskId = policy.tasks[0].taskIdPrefix + "-" + scheduledTime;

    expect(typeof controller.scheduledTime).toBe("number");
    expect(schedulerWorker.fetch).toBeUndefined();

    const first = await schedulerWorker.scheduled(controller, schedulerEnv, context);
    expect(first).toMatchObject({ processed: 1, created: 1, replayed: 0 });
    expect(first.admissions).toEqual([
      expect.objectContaining({ tenantId, projectId: fixture.projectId, taskId }),
    ]);

    const replay = await schedulerWorker.scheduled(controller, schedulerEnv, context);
    expect(replay).toMatchObject({ processed: 1, created: 0, replayed: 1 });
    expect(context.waitUntil).not.toHaveBeenCalled();

    await runInDurableObject(fixture.ledger, instance => {
      expect(instance.getTask({ taskId, tenantId, projectId: fixture.projectId })).not.toBeNull();
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE tenant_id=? AND project_id=? AND task_id=?",
        tenantId,
        fixture.projectId,
        taskId,
      ).one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE tenant_id=? AND project_id=?",
        tenantId,
        fixture.projectId,
      ).one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE tenant_id=? AND project_id=? AND event_type='task.admitted'",
        tenantId,
        fixture.projectId,
      ).one().count)).toBe(1);
    });
  });

  it("recovers a Directory reservation after a Ledger RPC interruption using the same scheduled identity", async () => {
    const tenantId = "tenant-scheduled-recovery-" + crypto.randomUUID();
    const fixture = await provisionTenant(tenantId);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const policy = {
      servicePrincipalId: fixture.principalId,
      tasks: [taskPolicy(fixture.tenantId, fixture.projectId, suffix)],
    };
    const baseEnv = makeSchedulerEnv({ [CRON]: policy });
    const scheduledTime = Date.now();
    const controller = createScheduledController({
      scheduledTime: new Date(scheduledTime),
      cron: CRON,
    });
    const realNamespace = env.ORCHESTRATOR_LEDGER;
    let failNextLedgerCall = true;
    const faultedNamespace = {
      idFromName(name) {
        return realNamespace.idFromName(name);
      },
      get(id) {
        const stub = realNamespace.get(id);
        return {
          async createTask(input) {
            if (failNextLedgerCall) {
              failNextLedgerCall = false;
              throw Object.assign(new Error("Simulated Ledger transport interruption."), {
                code: "LEDGER_RPC_UNAVAILABLE",
              });
            }
            return stub.createTask(input);
          },
        };
      },
    };
    const faultEnv = Object.create(baseEnv);
    faultEnv.ORCHESTRATOR_LEDGER = faultedNamespace;

    await expect(schedulerWorker.scheduled(controller, faultEnv, {}))
      .rejects.toMatchObject({
        code: "SCHEDULED_ADMISSION_PARTIAL_FAILURE",
        completed: 0,
        directoryReserved: true,
        causeCode: "LEDGER_RPC_UNAVAILABLE",
      });

    await runInDurableObject(fixture.directory, instance => {
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_task_admission_reservations",
      ).one().count)).toBe(1);
    });

    const retry = await schedulerWorker.scheduled(controller, baseEnv, {});
    expect(retry).toMatchObject({ processed: 1, created: 1, replayed: 0 });

    await runInDurableObject(fixture.ledger, instance => {
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks",
      ).one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts",
      ).one().count)).toBe(1);
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_type='task.admitted'",
      ).one().count)).toBe(1);
    });
  });

  it("preflights every task policy entry before creating any Directory reservation", async () => {
    const tenantId = "tenant-scheduled-preflight-" + crypto.randomUUID();
    const fixture = await provisionTenant(tenantId, false);
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const valid = taskPolicy(fixture.tenantId, fixture.projectId, suffix);
    const invalid = { ...taskPolicy(fixture.tenantId, fixture.projectId, suffix + "b"), taskIdPrefix: "../invalid" };
    const schedulerEnv = makeSchedulerEnv({
      [CRON]: {
        servicePrincipalId: fixture.principalId,
        tasks: [valid, invalid],
      },
    });
    const controller = createScheduledController({
      scheduledTime: new Date(Date.now()),
      cron: CRON,
    });

    await expect(schedulerWorker.scheduled(controller, schedulerEnv, {}))
      .rejects.toMatchObject({ code: "SCHEDULED_ADMISSION_POLICY_INVALID" });

    await runInDurableObject(fixture.directory, instance => {
      expect(Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_task_admission_reservations",
      ).one().count)).toBe(0);
    });
  });
});
