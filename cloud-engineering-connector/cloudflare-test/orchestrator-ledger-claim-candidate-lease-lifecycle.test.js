import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAgentWorkerAssertion,
  createScheduledWorkerAssertion,
} from "../orchestrator-worker-identity.js";

const NOW = 1_800_000_100_000;
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
  const workerAssertion = await createScheduledWorkerAssertion(KEY_SET, "test", {
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
    inputHash: "c".repeat(64),
    now: NOW,
    workerId: SCHEDULER_ID,
    workerAssertion,
  });
}

async function agentAssertion(operation, taskId, now) {
  return createAgentWorkerAssertion(KEY_SET, "test", {
    subject: WORKER_ID,
    operation,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    taskId,
    nowMs: now,
  });
}

async function claimTask(instance, taskId, now, workerAssertion, leaseMs = 30_000) {
  return instance.claimTask({
    workerId: WORKER_ID,
    workerAssertion,
    leaseMs,
    now,
    ...(taskId === null ? {} : { taskId }),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
  });
}

async function releaseLease(instance, taskId, now, leaseGeneration, workerAssertion) {
  return instance.releaseLease({
    taskId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    workerAssertion,
    leaseGeneration,
    now,
  });
}

function candidateRows(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, executor_id, created_at, tenant_id, project_id FROM orchestrator_claim_candidates WHERE task_id = ?",
    taskId,
  ).toArray();
}

function leaseRow(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, worker_id, lease_generation, lease_until, tenant_id, project_id FROM orchestrator_execution_leases WHERE task_id = ?",
    taskId,
  ).toArray()[0] ?? null;
}

describe("OrchestratorLedger Claim Candidate and execution Lease lifecycle", () => {
  it("removes a Candidate while leased, keeps it absent on renewal, and restores exactly one on release", async () => {
    const ledger = ledgerFor("lease-lifecycle-claim-renew-release");
    await runInDurableObject(ledger, async instance => {
      const taskId = "lease-cycle-task";
      expect(await createScheduledTask(instance, taskId)).toMatchObject({ created: true });
      expect(candidateRows(instance, taskId)).toHaveLength(1);

      const claimNow = NOW + 1;
      const claimAssertion = await agentAssertion("claimTask", taskId, claimNow);
      const claimed = await claimTask(instance, taskId, claimNow, claimAssertion);
      expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });
      expect(candidateRows(instance, taskId)).toEqual([]);
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: claimNow + 30_000,
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
      });

      const renewNow = claimNow + 10;
      const renewAssertion = await agentAssertion("renewLease", taskId, renewNow);
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
      expect(renewed).toMatchObject({ renewed: true, leaseGeneration: 1, leaseUntil: renewNow + 60_000 });
      expect(candidateRows(instance, taskId)).toEqual([]);

      const releaseNow = renewNow + 1;
      const releaseAssertion = await agentAssertion("releaseLease", taskId, releaseNow);
      expect(await releaseLease(instance, taskId, releaseNow, 1, releaseAssertion))
        .toMatchObject({ released: true, leaseGeneration: 1 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(candidateRows(instance, taskId)).toEqual([{
        task_id: taskId,
        executor_id: WORKER_ID,
        created_at: NOW,
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
      }]);

      const staleReleaseNow = releaseNow + 1;
      const staleReleaseAssertion = await agentAssertion("releaseLease", taskId, staleReleaseNow);
      expect(await releaseLease(instance, taskId, staleReleaseNow, 1, staleReleaseAssertion))
        .toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
      expect(candidateRows(instance, taskId)).toHaveLength(1);
    });
  });

  it("serializes concurrent claims so exactly one lease generation is committed", async () => {
    const ledger = ledgerFor("lease-lifecycle-concurrent-claim");
    await runInDurableObject(ledger, async instance => {
      const taskId = "concurrent-claim-task";
      await createScheduledTask(instance, taskId);
      const now = NOW + 2;
      const assertions = await Promise.all([
        agentAssertion("claimTask", taskId, now),
        agentAssertion("claimTask", taskId, now),
      ]);
      const results = await Promise.all(
        assertions.map(assertion => claimTask(instance, taskId, now, assertion)),
      );

      expect(results.filter(result => result.claimed)).toHaveLength(1);
      expect(results.filter(result => !result.claimed)).toHaveLength(1);
      expect(results.find(result => !result.claimed)).toMatchObject({
        claimed: false,
        reason: "NO_TASK_AVAILABLE",
      });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);
    });
  });

  it("does not restore or reassign an expired worker-owned Lease without reconciliation evidence", async () => {
    const ledger = ledgerFor("lease-lifecycle-expired-without-reconciliation");
    await runInDurableObject(ledger, async instance => {
      const taskId = "expired-lease-task";
      await createScheduledTask(instance, taskId);
      const firstClaimNow = NOW + 3;
      const firstAssertion = await agentAssertion("claimTask", taskId, firstClaimNow);
      const firstClaim = await claimTask(instance, taskId, firstClaimNow, firstAssertion, 5_000);
      expect(firstClaim).toMatchObject({ claimed: true, leaseGeneration: 1 });
      expect(candidateRows(instance, taskId)).toEqual([]);

      const expiredAt = firstClaimNow + 5_000;
      const retryAssertion = await agentAssertion("claimTask", taskId, expiredAt);
      const retry = await claimTask(instance, taskId, expiredAt, retryAssertion, 5_000);
      expect(retry).toMatchObject({ claimed: false, reason: "RECONCILIATION_REQUIRED" });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: expiredAt,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);
    });
  });

  it("repairs a missing Candidate through the bounded scheduler reconciliation path before claiming", async () => {
    const ledger = ledgerFor("lease-lifecycle-bounded-candidate-reconciliation");
    await runInDurableObject(ledger, async instance => {
      const taskId = "reconciled-candidate-task";
      await createScheduledTask(instance, taskId);
      instance.ctx.storage.sql.exec(
        "DELETE FROM orchestrator_claim_candidates WHERE task_id = ?",
        taskId,
      );
      expect(candidateRows(instance, taskId)).toEqual([]);

      const now = NOW + 4;
      const assertion = await agentAssertion("claimTask", null, now);
      const result = await claimTask(instance, null, now, assertion);
      expect(result).toMatchObject({ claimed: true, task: { taskId }, leaseGeneration: 1 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);
    });
  });

  it("rolls back Lease release and assertion consumption when Candidate restoration aborts", async () => {
    const ledger = ledgerFor("lease-lifecycle-release-atomic-rollback");
    await runInDurableObject(ledger, async instance => {
      const taskId = "release-rollback-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 5;
      const claimAssertion = await agentAssertion("claimTask", taskId, claimNow);
      expect(await claimTask(instance, taskId, claimNow, claimAssertion))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });
      expect(candidateRows(instance, taskId)).toEqual([]);

      instance.ctx.storage.sql.exec(`
        CREATE TRIGGER reject_candidate_restore
        BEFORE INSERT ON orchestrator_claim_candidates
        WHEN NEW.task_id = 'release-rollback-task'
        BEGIN
          SELECT RAISE(ABORT, 'forced_candidate_restore_failure');
        END
      `);

      const releaseNow = claimNow + 1;
      const releaseAssertion = await agentAssertion("releaseLease", taskId, releaseNow);
      await expect(releaseLease(instance, taskId, releaseNow, 1, releaseAssertion))
        .rejects.toThrow("forced_candidate_restore_failure");
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: claimNow + 30_000,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);

      instance.ctx.storage.sql.exec("DROP TRIGGER reject_candidate_restore");
      expect(await releaseLease(instance, taskId, releaseNow, 1, releaseAssertion))
        .toMatchObject({ released: true, leaseGeneration: 1 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(candidateRows(instance, taskId)).toHaveLength(1);
    });
  });
});
