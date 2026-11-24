import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";
import { createTenantDirectoryAdminAssertion } from "../identity/tenant-directory-assertion.js";
import { createTenantDirectoryAdapters } from "../identity/tenant-directory-adapter.js";
import { taskAdmissionDigest } from "../orchestrator-admission.js";

describe("OrchestratorLedger tenant task admission", () => {
  it("rejects Task creation without a TenantDirectory-signed admission grant", async () => {
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("task-admission-required-" + crypto.randomUUID()),
    );
    await runInDurableObject(ledger, async instance => {
      const now = Date.now();
      const workerKeySet = JSON.stringify({ test: "f".repeat(64) });
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = workerKeySet;
      const workerAssertion = await createScheduledWorkerAssertion(workerKeySet, "test", {
        subject: "orchestrator-scheduler",
        role: "system",
        operation: "createTask",
        nowMs: now,
      });
      const task = {
        taskId: "task-admission-required-01",
        tenantId: "tenant-admission-required-01",
        projectId: "project-admission-required-01",
        state: "SCHEDULED",
        version: 1,
        createdAt: now,
        updatedAt: now,
        executorId: "worker-admission-required",
      };

      const result = await instance.createTask({
        task,
        idempotencyKey: "admission-required-request-01",
        inputHash: "a".repeat(64),
        now,
        workerId: "orchestrator-scheduler",
        workerAssertion,
      });

      expect(result).toEqual({
        created: false,
        reason: "TASK_ADMISSION_REQUIRED",
      });
      expect(instance.getTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        projectId: task.projectId,
      })).toBeNull();
    });
  });

const WORKER_KEY_SET = JSON.stringify({ test: "f".repeat(64) });
const DIRECTORY_ADMIN_KEY_SET = JSON.stringify({ test: "e".repeat(64) });

async function taskAdmissionFixture() {
  const now = Date.now();
  const tenantId = "tenant-ledger-admission-" + crypto.randomUUID();
  const projectId = "project-ledger-admission";
  const principalId = "principal-ledger-admission";
  const membershipId = "membership-ledger-admission";
  const task = {
    taskId: "task-ledger-admission-" + crypto.randomUUID(),
    tenantId,
    projectId,
    state: "SCHEDULED",
    version: 1,
    createdAt: now,
    updatedAt: now,
    executorId: "executor-ledger-admission",
  };
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
      principalId, membershipId, role: "tenant-member", status: "active", expectedVersion: 0,
    }),
    tenantId, principalId, membershipId, role: "tenant-member",
    status: "active", expectedVersion: 0, now,
  });
  await adapters.provisioningStore.upsertProjectPolicy({
    assertion: await adminAssertion("upsertProjectPolicy", projectId, {
      projectId, principalId, action: "task.create", resourceDigest: "*",
      effect: "allow", policyVersion: "task-create-v1", status: "active", expectedVersion: 0,
    }),
    tenantId, projectId, principalId, action: "task.create", resourceDigest: "*",
    effect: "allow", policyVersion: "task-create-v1", status: "active",
    expectedVersion: 0, now,
  });
  const idempotencyKey = "ledger-admission-request-01";
  const inputHash = "a".repeat(64);
  const reservation = await adapters.admissionStore.prepareTaskAdmission({
    tenantId,
    projectId,
    principalId,
    taskId: task.taskId,
    taskDigest: await taskAdmissionDigest(task),
    idempotencyKey,
    inputHash,
  });
  return { now, tenantId, projectId, principalId, task, idempotencyKey, inputHash,
    publicKeys, grant: reservation.grant, admissionId: reservation.admissionId, jti: reservation.jti };
}

async function workerAssertion(now) {
  return createScheduledWorkerAssertion(WORKER_KEY_SET, "test", {
    subject: "orchestrator-scheduler",
    role: "system",
    operation: "createTask",
    nowMs: now,
  });
}

async function createAdmittedTask(instance, fixture, { grant = fixture.grant, task = fixture.task,
  idempotencyKey = fixture.idempotencyKey, inputHash = fixture.inputHash, now = Date.now(),
  workerProof = null } = {}) {
  const assertion = workerProof ?? await workerAssertion(now);
  return instance.createTask({
    task,
    idempotencyKey,
    inputHash,
    now,
    workerId: "orchestrator-scheduler",
    workerAssertion: assertion,
    admissionGrant: grant,
  });
}


  it("accepts a real Directory grant and makes same-grant replay idempotent", async () => {
    const fixture = await taskAdmissionFixture();
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("ledger-admission-valid-" + crypto.randomUUID()),
    );
    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEY_SET;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = fixture.publicKeys;

      const created = await createAdmittedTask(instance, fixture);
      expect(created.created).toBe(true);
      expect(created.admissionReceipt).toMatchObject({
        admissionId: fixture.admissionId,
        jti: fixture.jti,
      });
      expect(created.outbox).toMatchObject({ enqueued: true, event: { eventType: "task.admitted" } });

      const replay = await createAdmittedTask(instance, fixture);
      expect(replay).toMatchObject({
        created: false,
        replay: true,
        admissionReceipt: {
          admissionId: fixture.admissionId,
          jti: fixture.jti,
        },
      });

      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id=?",
        fixture.task.taskId,
      ).one().count).toBe(1);
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts WHERE admission_id=?",
        fixture.admissionId,
      ).one().count).toBe(1);
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE idempotency_key=?",
        "task-admitted:" + fixture.admissionId,
      ).one().count).toBe(1);
    });
  });

  it("rejects a grant that expires between cryptographic verification and Ledger commit", async () => {
    const fixture = await taskAdmissionFixture();
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("ledger-admission-expiry-fence-" + crypto.randomUUID()),
    );
    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEY_SET;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = fixture.publicKeys;
      const workerNow = Date.now();
      const proof = await workerAssertion(workerNow);
      const { claims } = (await import("../orchestrator-admission.js"))
        .decodeTaskAdmissionGrantClaims(fixture.grant);
      let clockCalls = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() =>
        clockCalls++ === 0 ? (claims.exp - 1) * 1000 : claims.exp * 1000,
      );
      let result;
      try {
        result = await createAdmittedTask(instance, fixture, {
          now: workerNow,
          workerProof: proof,
        });
      } finally {
        clock.mockRestore();
      }

      expect(result).toEqual({ created: false, reason: "TASK_ADMISSION_EXPIRED" });
      expect(clockCalls).toBe(2);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count).toBe(0);
    });
  });

  it("rejects Task scope/digest substitution and tampered grant signatures before writing", async () => {
    const fixture = await taskAdmissionFixture();
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("ledger-admission-tamper-" + crypto.randomUUID()),
    );
    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEY_SET;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = fixture.publicKeys;

      const substituted = await createAdmittedTask(instance, fixture, {
        task: { ...fixture.task, projectId: "project-foreign-admission" },
      });
      expect(substituted).toMatchObject({
        created: false,
        reason: "TASK_ADMISSION_INVALID",
      });

      const parts = fixture.grant.split(".");
      parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
      const tampered = await createAdmittedTask(instance, fixture, { grant: parts.join(".") });
      expect(tampered).toMatchObject({
        created: false,
        reason: "TASK_ADMISSION_INVALID",
      });

      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
    });
  });

  it("rolls back Task, worker JTI, admission receipt, and Outbox together when Outbox insertion fails", async () => {
    const fixture = await taskAdmissionFixture();
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("ledger-admission-outbox-rollback-" + crypto.randomUUID()),
    );
    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEY_SET;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = fixture.publicKeys;
      const workerNow = Date.now();
      const proof = await workerAssertion(workerNow);
      instance.ctx.storage.sql.exec(
        "CREATE TRIGGER reject_task_admitted_outbox BEFORE INSERT ON orchestrator_outbox_events " +
        "WHEN NEW.event_type='task.admitted' BEGIN SELECT RAISE(ABORT, 'TEST_TASK_ADMISSION_OUTBOX_ABORT'); END",
      );

      await expect(createAdmittedTask(instance, fixture, { now: workerNow, workerProof: proof }))
        .rejects.toThrow();

      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts").one().count).toBe(0);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
      const consumedAfterAbort = Number(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions",
      ).one().count);
      expect(consumedAfterAbort).toBe(0);

      instance.ctx.storage.sql.exec("DROP TRIGGER reject_task_admitted_outbox");
      const retry = await createAdmittedTask(instance, fixture, { now: workerNow, workerProof: proof });
      expect(retry.created).toBe(true);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(1);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_task_admission_receipts").one().count).toBe(1);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_type='task.admitted'").one().count).toBe(1);
      expect(instance.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count).toBe(1);
    });
  });

});

describe("OrchestratorLedger admission receipt probe", () => {
  it("distinguishes absent, exactly admitted, and conflicting admission state without returning bearer material", async () => {
    const fixture = await taskAdmissionFixture();
    const ledger = env.ORCHESTRATOR_LEDGER.get(
      env.ORCHESTRATOR_LEDGER.idFromName("ledger-admission-receipt-probe-" + crypto.randomUUID()),
    );

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = WORKER_KEY_SET;
      instance.env.ORCHESTRATOR_LEDGER_ADMISSION_PUBLIC_KEYS = fixture.publicKeys;
      const input = {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        principalId: fixture.principalId,
        taskId: fixture.task.taskId,
        taskDigest: await taskAdmissionDigest(fixture.task),
        idempotencyKey: fixture.idempotencyKey,
        inputHash: fixture.inputHash,
      };

      expect(await instance.getTaskAdmissionReceipt(input)).toEqual({ status: "not_found" });
      expect((await createAdmittedTask(instance, fixture)).created).toBe(true);

      const admitted = await instance.getTaskAdmissionReceipt(input);
      expect(admitted).toMatchObject({
        status: "admitted",
        receipt: {
          admissionId: fixture.admissionId,
          taskId: fixture.task.taskId,
          tenantId: fixture.tenantId,
          projectId: fixture.projectId,
          principalId: fixture.principalId,
          taskDigest: input.taskDigest,
          inputHash: fixture.inputHash,
        },
      });
      expect(JSON.stringify(admitted)).not.toContain(fixture.grant);
      expect(admitted.receipt).not.toHaveProperty("grant");
      expect(admitted.receipt).not.toHaveProperty("grantToken");

      const conflict = await instance.getTaskAdmissionReceipt({
        ...input,
        inputHash: "b".repeat(64),
      });
      expect(conflict).toEqual({
        status: "conflict",
        reason: "TASK_ADMISSION_RECEIPT_MISMATCH",
      });
    });
  });
});
