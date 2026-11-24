import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAgentWorkerAssertion,
  createScheduledWorkerAssertion,
} from "../orchestrator-worker-identity.js";

const NOW = 1_800_000_200_000;
const KEY_SET = JSON.stringify({ test: "a".repeat(64) });
const TENANT_ID = "tenant-alpha";
const PROJECT_ID = "project-red";
const WORKER_ID = "worker-a";
const SCHEDULER_ID = "orchestrator-scheduler";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

async function createScheduledTask(instance, taskId) {
  instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
  const assertion = await createScheduledWorkerAssertion(KEY_SET, "test", {
    subject: SCHEDULER_ID,
    role: "system",
    operation: "createTask",
    nowMs: NOW,
  });
  return instance.createTask({
    task: {
      taskId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      state: "SCHEDULED",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      executorId: WORKER_ID,
      agentRound: 0,
    },
    idempotencyKey: "idempotency-" + taskId,
    inputHash: "d".repeat(64),
    now: NOW,
    workerId: SCHEDULER_ID,
    workerAssertion: assertion,
  });
}

async function assertionFor(operation, taskId, now) {
  return createAgentWorkerAssertion(KEY_SET, "test", {
    subject: WORKER_ID,
    operation,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    taskId,
    nowMs: now,
  });
}

async function claim(instance, taskId, now) {
  const workerAssertion = await assertionFor("claimTask", taskId, now);
  return instance.claimTask({
    taskId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    workerAssertion,
    leaseMs: 30_000,
    now,
  });
}

function persistedLease(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, worker_id, lease_generation, lease_until, updated_at FROM orchestrator_execution_leases WHERE task_id = ?",
    taskId,
  ).toArray()[0] ?? null;
}

describe("OrchestratorLedger Lease renewal eligibility and fencing", () => {
  it("rejects renewal after the Task becomes terminal without extending its active Lease", async () => {
    const ledger = ledgerFor("lease-renewal-terminal-task");
    await runInDurableObject(ledger, async instance => {
      const taskId = "terminal-renewal-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 1;
      expect(await claim(instance, taskId, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      instance.ctx.storage.sql.exec(
        "UPDATE orchestrator_tasks SET state = 'COMPLETED', version = 2, task_json = json_set(task_json, '$.state', 'COMPLETED', '$.version', 2, '$.updatedAt', ?), updated_at = ? WHERE task_id = ? AND tenant_id = ? AND project_id = ?",
        claimNow + 1, claimNow + 1, taskId, TENANT_ID, PROJECT_ID,
      );
      const before = persistedLease(instance, taskId);
      const renewNow = claimNow + 2;
      const workerAssertion = await assertionFor("renewLease", taskId, renewNow);
      const result = await instance.renewLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion,
        leaseGeneration: 1,
        leaseMs: 60_000,
        now: renewNow,
      });

      expect(result).toMatchObject({ renewed: false, reason: "TASK_NOT_LEASE_ELIGIBLE" });
      expect(persistedLease(instance, taskId)).toEqual(before);
      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ state: "COMPLETED", version: 2 });
    });
  });

  it("rejects renewal by a former assignee even while its old Lease generation remains active", async () => {
    const ledger = ledgerFor("lease-renewal-former-assignee");
    await runInDurableObject(ledger, async instance => {
      const taskId = "reassigned-renewal-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 3;
      expect(await claim(instance, taskId, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      instance.ctx.storage.sql.exec(
        "UPDATE orchestrator_tasks SET task_json = json_set(task_json, '$.executorId', 'worker-b') WHERE task_id = ? AND tenant_id = ? AND project_id = ?",
        taskId, TENANT_ID, PROJECT_ID,
      );
      const before = persistedLease(instance, taskId);
      const renewNow = claimNow + 1;
      const workerAssertion = await assertionFor("renewLease", taskId, renewNow);
      const result = await instance.renewLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion,
        leaseGeneration: 1,
        leaseMs: 60_000,
        now: renewNow,
      });

      expect(result).toMatchObject({ renewed: false, reason: "ASSIGNEE_MISMATCH" });
      expect(persistedLease(instance, taskId)).toEqual(before);
    });
  });

  it("rejects a Task transition by a former assignee even while its old Lease generation remains active", async () => {
    const ledger = ledgerFor("lease-transition-former-assignee");
    await runInDurableObject(ledger, async instance => {
      const taskId = "reassigned-transition-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 7;
      expect(await claim(instance, taskId, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      instance.ctx.storage.sql.exec(
        "UPDATE orchestrator_tasks SET task_json = json_set(task_json, '$.executorId', 'worker-b') WHERE task_id = ? AND tenant_id = ? AND project_id = ?",
        taskId, TENANT_ID, PROJECT_ID,
      );
      const transitionNow = claimNow + 1;
      const workerAssertion = await assertionFor("transitionTask", taskId, transitionNow);
      const result = await instance.transitionTask({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        expectedVersion: 1,
        expectedState: "SCHEDULED",
        nextState: "RUNNING",
        actor: {
          id: WORKER_ID,
          role: "agent",
          authenticated: true,
          identityVerified: true,
        },
        evidence: {},
        workerId: WORKER_ID,
        workerAssertion,
        leaseGeneration: 1,
        now: transitionNow,
      });

      expect(result).toMatchObject({ updated: false, reason: "ASSIGNEE_MISMATCH" });
      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ state: "SCHEDULED", version: 1, executorId: "worker-b" });
    });
  });

  it("rejects both renewal and release from a superseded Lease generation while the newer Lease is active", async () => {
    const ledger = ledgerFor("lease-active-generation-fence");
    await runInDurableObject(ledger, async instance => {
      const taskId = "superseded-generation-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 5;
      expect(await claim(instance, taskId, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      instance.ctx.storage.sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_generation = 2, updated_at = ? WHERE task_id = ? AND tenant_id = ? AND project_id = ?",
        claimNow + 1, taskId, TENANT_ID, PROJECT_ID,
      );
      const before = persistedLease(instance, taskId);

      const renewNow = claimNow + 2;
      const renewAssertion = await assertionFor("renewLease", taskId, renewNow);
      const renewed = await instance.renewLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion: renewAssertion,
        leaseGeneration: 1,
        leaseMs: 60_000,
        now: renewNow,
      });
      expect(renewed).toMatchObject({ renewed: false, reason: "LEASE_FENCE_MISMATCH" });

      const releaseNow = claimNow + 3;
      const releaseAssertion = await assertionFor("releaseLease", taskId, releaseNow);
      const released = await instance.releaseLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion: releaseAssertion,
        leaseGeneration: 1,
        now: releaseNow,
      });
      expect(released).toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
      expect(persistedLease(instance, taskId)).toEqual(before);
    });
  });

  it("rejects release by a former assignee without mutating the active Lease", async () => {
    const ledger = ledgerFor("lease-release-former-assignee");
    await runInDurableObject(ledger, async instance => {
      const taskId = "reassigned-release-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 9;
      expect(await claim(instance, taskId, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      instance.ctx.storage.sql.exec(
        "UPDATE orchestrator_tasks SET task_json = json_set(task_json, '$.executorId', 'worker-b') WHERE task_id = ? AND tenant_id = ? AND project_id = ?",
        taskId, TENANT_ID, PROJECT_ID,
      );
      const before = persistedLease(instance, taskId);
      const releaseNow = claimNow + 1;
      const workerAssertion = await assertionFor("releaseLease", taskId, releaseNow);
      const result = await instance.releaseLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion,
        leaseGeneration: 1,
        now: releaseNow,
      });

      expect(result).toMatchObject({ released: false, reason: "ASSIGNEE_MISMATCH" });
      expect(persistedLease(instance, taskId)).toEqual(before);
    });
  });

  it("atomically invalidates the execution Lease and Claim Candidate when a Task becomes terminal", async () => {
    const ledger = ledgerFor("lease-terminalization-atomicity");
    await runInDurableObject(ledger, async instance => {
      const taskId = "terminalization-atomic-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 11;
      expect(await claim(instance, taskId, claimNow))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      const runningNow = claimNow + 1;
      const runningAssertion = await assertionFor("transitionTask", taskId, runningNow);
      const running = await instance.transitionTask({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        expectedVersion: 1,
        expectedState: "SCHEDULED",
        nextState: "RUNNING",
        actor: {
          id: WORKER_ID,
          role: "agent",
          authenticated: true,
          identityVerified: true,
        },
        evidence: {},
        workerId: WORKER_ID,
        workerAssertion: runningAssertion,
        leaseGeneration: 1,
        now: runningNow,
      });
      expect(running).toMatchObject({ updated: true, task: { state: "RUNNING", version: 2 } });

      const terminalNow = runningNow + 1;
      const terminalAssertion = await assertionFor("transitionTask", taskId, terminalNow);
      const terminal = await instance.transitionTask({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        expectedVersion: 2,
        expectedState: "RUNNING",
        nextState: "FAILED",
        actor: {
          id: WORKER_ID,
          role: "agent",
          authenticated: true,
          identityVerified: true,
        },
        evidence: {},
        workerId: WORKER_ID,
        workerAssertion: terminalAssertion,
        leaseGeneration: 1,
        now: terminalNow,
      });

      expect(terminal).toMatchObject({ updated: true, task: { state: "FAILED", version: 3 } });
      expect(persistedLease(instance, taskId)).toMatchObject({
        task_id: taskId,
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      const candidateCount = instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ? AND tenant_id = ? AND project_id = ?",
        taskId, TENANT_ID, PROJECT_ID,
      ).toArray()[0].count;
      expect(candidateCount).toBe(0);
    });
  });

});
