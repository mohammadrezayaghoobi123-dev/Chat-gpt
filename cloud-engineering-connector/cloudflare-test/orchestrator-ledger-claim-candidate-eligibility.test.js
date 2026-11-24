import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";

const NOW = 1_800_000_000_000;
const KEY_SET = JSON.stringify({ test: "a".repeat(64) });
const WORKER_ID = "orchestrator-scheduler";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

async function createTask(instance, {
  taskId,
  state,
  tenantId = "tenant-alpha",
  projectId = "project-red",
  executorId,
}) {
  instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
  const workerAssertion = await createScheduledWorkerAssertion(KEY_SET, "test", {
    subject: WORKER_ID,
    role: "system",
    operation: "createTask",
    nowMs: NOW,
  });
  return instance.createTask({
    task: {
      taskId,
      tenantId,
      projectId,
      state,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      ...(executorId === undefined ? {} : { executorId }),
      agentRound: 0,
    },
    idempotencyKey: "idempotency-" + taskId,
    inputHash: "b".repeat(64),
    now: NOW,
    workerId: WORKER_ID,
    workerAssertion,
  });
}

async function claimCandidates(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, executor_id, created_at, tenant_id, project_id FROM orchestrator_claim_candidates WHERE task_id = ?",
    taskId,
  ).toArray();
}

describe("OrchestratorLedger Claim Candidate eligibility matrix", () => {
  it("does not materialize a Claim Candidate for RECEIVED tasks, even when an executor is assigned", async () => {
    const ledger = ledgerFor("claim-candidate-received-state-exclusion");
    await runInDurableObject(ledger, async instance => {
      const result = await createTask(instance, {
        taskId: "received-task-with-executor",
        state: "RECEIVED",
        executorId: "worker-a",
      });

      expect(result).toMatchObject({ created: true });
      expect(await claimCandidates(instance, "received-task-with-executor")).toEqual([]);
    });
  });

  it("does not materialize a Claim Candidate for SCHEDULED tasks without an executor", async () => {
    const ledger = ledgerFor("claim-candidate-missing-executor-exclusion");
    await runInDurableObject(ledger, async instance => {
      const result = await createTask(instance, {
        taskId: "scheduled-task-without-executor",
        state: "SCHEDULED",
      });

      expect(result).toMatchObject({ created: true });
      expect(await claimCandidates(instance, "scheduled-task-without-executor")).toEqual([]);
    });
  });

  it("materializes exactly one correctly scoped Claim Candidate for an eligible SCHEDULED task", async () => {
    const ledger = ledgerFor("claim-candidate-scheduled-positive-control");
    await runInDurableObject(ledger, async instance => {
      const result = await createTask(instance, {
        taskId: "scheduled-task-with-executor",
        state: "SCHEDULED",
        tenantId: "tenant-alpha",
        projectId: "project-red",
        executorId: "worker-a",
      });

      expect(result).toMatchObject({
        created: true,
        task: {
          taskId: "scheduled-task-with-executor",
          tenantId: "tenant-alpha",
          projectId: "project-red",
          state: "SCHEDULED",
          executorId: "worker-a",
        },
      });
      expect(await claimCandidates(instance, "scheduled-task-with-executor")).toEqual([{
        task_id: "scheduled-task-with-executor",
        executor_id: "worker-a",
        created_at: NOW,
        tenant_id: "tenant-alpha",
        project_id: "project-red",
      }]);
    });
  });
});
