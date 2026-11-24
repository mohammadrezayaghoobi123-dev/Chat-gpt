import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";

const ADMIN_KEYS = JSON.stringify({ test: "e".repeat(64) });
const SCHEDULER_KEYS = JSON.stringify({ "scheduler-k1": "a".repeat(64) });
const CRON = "*/5 * * * *";
const NOW = Date.now();

async function admin(operation, tenantId, projectId, target, now) {
  return createTenantDirectoryAdminAssertion(ADMIN_KEYS, "test", {
    subject: "tenant-directory-provisioner",
    operation,
    tenantId,
    projectId,
    target,
    nowMs: now,
  });
}

async function provisionServicePrincipal(tenantId, projectId, principalId, action, resourceDigest) {
  const stub = env.TENANT_DIRECTORY.get(env.TENANT_DIRECTORY.idFromName(tenantId));
  await runInDurableObject(stub, instance => {
    instance.env.TENANT_DIRECTORY_ADMIN_ASSERTION_KEYS = ADMIN_KEYS;
    instance.env.SCHEDULER_INVOCATION_KEYS = SCHEDULER_KEYS;
  });
  const membership = {
    principalId,
    membershipId: "membership-" + principalId,
    role: "tenant-member",
    status: "active",
    expectedVersion: 0,
  };
  await stub.upsertMembership({
    assertion: await admin("upsertMembership", tenantId, null, membership, NOW),
    tenantId,
    ...membership,
    now: NOW,
  });
  const policy = {
    projectId,
    principalId,
    action,
    resourceDigest: "*",
    effect: "allow",
    policyVersion: "scheduled-v1",
    status: "active",
    expectedVersion: 0,
  };
  await stub.upsertProjectPolicy({
    assertion: await admin("upsertProjectPolicy", tenantId, projectId, policy, NOW + 1),
    tenantId,
    ...policy,
    now: NOW + 1,
  });
  return stub;
}

function scheduledEnvironment(policy) {
  return {
    ...env,
    SCHEDULED_ADMISSION_POLICIES: JSON.stringify(policy),
    SCHEDULER_INVOCATION_KEYS: SCHEDULER_KEYS,
    SCHEDULER_INVOCATION_ACTIVE_KEY_ID: "scheduler-k1",
  };
}

describe("Worker platform scheduled Admission", () => {
  it("creates one signed Admission Receipt for an exact allowlisted Cron and replays idempotently", async () => {
    const tenantId = "worker-scheduled-tenant";
    const projectId = "worker-scheduled-project";
    const principalId = "worker-scheduled-principal";
    const action = "project.reconcile";
    const resourceDigest = "f".repeat(64);
    const stub = await provisionServicePrincipal(tenantId, projectId, principalId, action, resourceDigest);
    const envWithPolicy = scheduledEnvironment({
      [CRON]: {
        servicePrincipalId: principalId,
        tasks: [{
          tenantId,
          projectId,
          action,
          resourceDigest,
          taskIdPrefix: "daily-reconcile",
          idempotencyPrefix: "daily-reconcile",
          taskTemplate: {
            title: "Daily reconciliation",
            executorId: "worker-a",
          },
        }],
      },
    });
    const controller = { cron: CRON, scheduledTime: NOW };

    await worker.scheduled(controller, envWithPolicy, {});
    await worker.scheduled(controller, envWithPolicy, {});

    const persisted = await runInDurableObject(stub, instance => ({
      admissions: instance.ctx.storage.sql.exec(
        "SELECT task_id, scheduler_invocation_id, claims_json FROM tenant_admissions WHERE tenant_id = ?",
        tenantId,
      ).toArray(),
      outboxCount: instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_admission_outbox WHERE tenant_id = ?",
        tenantId,
      ).one().count,
    }));
    expect(persisted.admissions).toHaveLength(1);
    expect(persisted.admissions[0].task_id).toBe("daily-reconcile-" + NOW);
    expect(JSON.parse(persisted.admissions[0].claims_json)).toMatchObject({
      schedulerCron: CRON,
      scheduledTime: NOW,
      principalId,
      tenantId,
      projectId,
      action,
    });
    expect(persisted.outboxCount).toBe(1);
  });

  it("does not create Admission for an unconfigured Cron or missing policy map", async () => {
    const tenantId = "worker-scheduled-skip-tenant";
    const projectId = "worker-scheduled-skip-project";
    const principalId = "worker-scheduled-skip-principal";
    const action = "project.read";
    const resourceDigest = "e".repeat(64);
    const stub = await provisionServicePrincipal(tenantId, projectId, principalId, action, resourceDigest);
    const configured = scheduledEnvironment({
      [CRON]: {
        servicePrincipalId: principalId,
        tasks: [{
          tenantId, projectId, action, resourceDigest,
          taskIdPrefix: "read-task",
          idempotencyPrefix: "read-task",
          taskTemplate: { title: "Read task" },
        }],
      },
    });
    await worker.scheduled({ cron: "0 * * * *", scheduledTime: NOW }, configured, {});
    await worker.scheduled({ cron: CRON, scheduledTime: NOW }, { ...env }, {});
    const count = await runInDurableObject(stub, instance =>
      instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM tenant_admissions WHERE tenant_id = ?",
        tenantId,
      ).one().count,
    );
    expect(count).toBe(0);
  });
});
