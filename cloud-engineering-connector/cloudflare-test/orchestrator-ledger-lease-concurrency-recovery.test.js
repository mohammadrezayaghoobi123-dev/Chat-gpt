import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAgentWorkerAssertion,
  createScheduledWorkerAssertion,
} from "../orchestrator-worker-identity.js";

const NOW = 1_800_000_300_000;
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
    inputHash: "e".repeat(64),
    now: NOW,
    workerId: SCHEDULER_ID,
    workerAssertion,
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

async function claimTask(instance, taskId, now, workerAssertion) {
  return instance.claimTask({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    workerAssertion,
    leaseMs: 30_000,
    now,
    ...(taskId === null ? {} : { taskId }),
  });
}

async function transition(instance, taskId, fromState, version, nextState, now, leaseGeneration = 1, workerAssertion) {
  return instance.transitionTask({
    taskId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    expectedVersion: version,
    expectedState: fromState,
    nextState,
    actor: {
      id: WORKER_ID,
      role: "agent",
      authenticated: true,
      identityVerified: true,
    },
    evidence: {},
    workerId: WORKER_ID,
    workerAssertion,
    leaseGeneration,
    now,
  });
}

async function prepareRunningTask(instance, taskId, offset) {
  await createScheduledTask(instance, taskId);
  const claimNow = NOW + offset;
  const claimAssertion = await assertionFor("claimTask", taskId, claimNow);
  expect(await claimTask(instance, taskId, claimNow, claimAssertion))
    .toMatchObject({ claimed: true, leaseGeneration: 1 });
  const runningNow = claimNow + 1;
  const runningAssertion = await assertionFor("transitionTask", taskId, runningNow);
  expect(await transition(instance, taskId, "SCHEDULED", 1, "RUNNING", runningNow, 1, runningAssertion))
    .toMatchObject({ updated: true, task: { state: "RUNNING", version: 2 } });
  return { runningNow };
}

function leaseRow(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, worker_id, lease_generation, lease_until, tenant_id, project_id FROM orchestrator_execution_leases WHERE task_id = ?",
    taskId,
  ).toArray()[0] ?? null;
}

function candidateRows(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, executor_id, created_at, tenant_id, project_id FROM orchestrator_claim_candidates WHERE task_id = ?",
    taskId,
  ).toArray();
}

describe("OrchestratorLedger Lease concurrency and recovery invariants", () => {
  it("preserves terminalization when Lease renewal races with a terminal Task transition", async () => {
    const ledger = ledgerFor("lease-race-renew-terminalization");
    await runInDurableObject(ledger, async instance => {
      const taskId = "race-renew-terminal-task";
      const { runningNow } = await prepareRunningTask(instance, taskId, 1);
      const renewNow = runningNow + 1;
      const terminalNow = runningNow + 1;
      const [renewAssertion, terminalAssertion] = await Promise.all([
        assertionFor("renewLease", taskId, renewNow),
        assertionFor("transitionTask", taskId, terminalNow),
      ]);

      const [renewed, terminal] = await Promise.all([
        instance.renewLease({
          taskId,
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workerId: WORKER_ID,
          workerAssertion: renewAssertion,
          leaseGeneration: 1,
          leaseMs: 60_000,
          now: renewNow,
        }),
        transition(instance, taskId, "RUNNING", 2, "FAILED", terminalNow, 1, terminalAssertion),
      ]);

      expect(terminal).toMatchObject({ updated: true, task: { state: "FAILED", version: 3 } });
      expect(
        renewed.renewed === true ||
        (renewed.renewed === false && renewed.reason === "TASK_NOT_LEASE_ELIGIBLE"),
      ).toBe(true);
      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ state: "FAILED", version: 3 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);
    });
  });

  it("keeps Task, Lease, and Candidate mutually consistent when release races with terminalization", async () => {
    const ledger = ledgerFor("lease-race-release-terminalization");
    await runInDurableObject(ledger, async instance => {
      const taskId = "race-release-terminal-task";
      const { runningNow } = await prepareRunningTask(instance, taskId, 5);
      const raceNow = runningNow + 1;
      const [releaseAssertion, terminalAssertion] = await Promise.all([
        assertionFor("releaseLease", taskId, raceNow),
        assertionFor("transitionTask", taskId, raceNow),
      ]);

      const [released, terminal] = await Promise.all([
        instance.releaseLease({
          taskId,
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workerId: WORKER_ID,
          workerAssertion: releaseAssertion,
          leaseGeneration: 1,
          now: raceNow,
        }),
        transition(instance, taskId, "RUNNING", 2, "FAILED", raceNow, 1, terminalAssertion),
      ]);

      const task = instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      if (terminal.updated) {
        expect(terminal.task).toMatchObject({ state: "FAILED", version: 3 });
        expect(released).toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
        expect(candidateRows(instance, taskId)).toEqual([]);
      } else {
        expect(terminal).toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
        expect(released).toMatchObject({ released: true, leaseGeneration: 1 });
        expect(task).toMatchObject({ state: "RUNNING", version: 2 });
        expect(candidateRows(instance, taskId)).toEqual([{
          task_id: taskId,
          executor_id: WORKER_ID,
          created_at: NOW,
          tenant_id: TENANT_ID,
          project_id: PROJECT_ID,
        }]);
      }
    });
  });

  it("rolls back Task, Lease, Candidate, and assertion consumption when terminal Lease invalidation aborts", async () => {
    const ledger = ledgerFor("lease-terminalization-forced-rollback");
    await runInDurableObject(ledger, async instance => {
      const taskId = "terminal-rollback-task";
      const { runningNow } = await prepareRunningTask(instance, taskId, 9);
      const terminalNow = runningNow + 1;
      const terminalAssertion = await assertionFor("transitionTask", taskId, terminalNow);

      instance.ctx.storage.sql.exec(`
        CREATE TRIGGER reject_terminal_lease_invalidation
        BEFORE UPDATE ON orchestrator_execution_leases
        WHEN NEW.task_id = 'terminal-rollback-task'
          AND OLD.worker_id IS NOT NULL
          AND NEW.worker_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'forced_terminal_lease_invalidation_failure');
        END
      `);

      await expect(
        transition(instance, taskId, "RUNNING", 2, "FAILED", terminalNow, 1, terminalAssertion),
      ).rejects.toThrow("forced_terminal_lease_invalidation_failure");

      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ state: "RUNNING", version: 2 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: runningNow + 30_000,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);

      instance.ctx.storage.sql.exec("DROP TRIGGER reject_terminal_lease_invalidation");
      const retried = await transition(instance, taskId, "RUNNING", 2, "FAILED", terminalNow, 1, terminalAssertion);
      expect(retried).toMatchObject({ updated: true, task: { state: "FAILED", version: 3 } });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);
    });
  });

  it("serializes concurrent Lease release and scheduler reclaim without losing the Candidate", async () => {
    const ledger = ledgerFor("lease-race-release-scheduler-reclaim");
    await runInDurableObject(ledger, async instance => {
      const taskId = "race-release-reclaim-task";
      await createScheduledTask(instance, taskId);
      const claimNow = NOW + 13;
      const firstClaimAssertion = await assertionFor("claimTask", taskId, claimNow);
      expect(await claimTask(instance, taskId, claimNow, firstClaimAssertion))
        .toMatchObject({ claimed: true, leaseGeneration: 1 });

      const raceNow = claimNow + 1;
      const [releaseAssertion, schedulerAssertion] = await Promise.all([
        assertionFor("releaseLease", taskId, raceNow),
        assertionFor("claimTask", null, raceNow),
      ]);
      const [released, reclaimed] = await Promise.all([
        instance.releaseLease({
          taskId,
          tenantId: TENANT_ID,
          projectId: PROJECT_ID,
          workerId: WORKER_ID,
          workerAssertion: releaseAssertion,
          leaseGeneration: 1,
          now: raceNow,
        }),
        claimTask(instance, null, raceNow, schedulerAssertion),
      ]);

      const lease = leaseRow(instance, taskId);
      const candidates = candidateRows(instance, taskId);
      if (reclaimed.claimed) {
        expect(reclaimed).toMatchObject({ claimed: true, leaseGeneration: 2, task: { taskId } });
        expect(released).toMatchObject({ released: true, leaseGeneration: 1 });
        expect(lease).toMatchObject({ worker_id: WORKER_ID, lease_generation: 2 });
        expect(candidates).toEqual([]);
      } else {
        expect(reclaimed).toMatchObject({ claimed: false, reason: "NO_TASK_AVAILABLE" });
        expect(released).toMatchObject({ released: true, leaseGeneration: 1 });
        expect(lease).toMatchObject({ worker_id: null, lease_generation: 1, lease_until: 0 });
        expect(candidates).toHaveLength(1);
      }
    });
  });
});
