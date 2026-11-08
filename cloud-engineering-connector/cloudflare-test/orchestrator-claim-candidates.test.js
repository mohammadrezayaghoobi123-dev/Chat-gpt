import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const now = 1_800_000_000_000;

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function insertTask(sql, {
  taskId,
  state = "SCHEDULED",
  executorId = "agent:worker-1",
  createdAt = now,
}) {
  const task = {
    taskId,
    state,
    version: 1,
    agentRound: 0,
    createdAt,
    updatedAt: createdAt,
    ...(executorId === null ? {} : { executorId }),
    commitSha: "a".repeat(40),
    objective: "candidate-index bootstrap fixture",
  };
  sql.exec(
    "INSERT INTO orchestrator_tasks (task_id, idempotency_key, input_hash, state, version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
    taskId,
    "idempotency-" + taskId,
    "b".repeat(64),
    state,
    JSON.stringify(task),
    createdAt,
    createdAt,
  );
}

describe("OrchestratorLedger claim candidate index", () => {
  it("backfills only unleased active tasks and is idempotent across schema initialization", async () => {
    const ledger = ledgerFor("ledger-candidate-index-backfill");
    await runInDurableObject(ledger, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE IF EXISTS orchestrator_claim_candidates");
      insertTask(sql, { taskId: "task-candidate-b", createdAt: now + 1 });
      insertTask(sql, { taskId: "task-candidate-a", createdAt: now + 1 });
      insertTask(sql, { taskId: "task-terminal", state: "COMPLETED", createdAt: now + 2 });
      insertTask(sql, { taskId: "task-unassigned", executorId: null, createdAt: now + 3 });
      insertTask(sql, { taskId: "task-active-lease", createdAt: now + 4 });
      sql.exec(
        "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, 1, ?, ?)",
        "task-active-lease", "agent:worker-2", now + 60_000, now,
      );

      instance.ensureSchema();
      const first = sql.exec(
        "SELECT task_id FROM orchestrator_claim_candidates ORDER BY executor_id, created_at, task_id",
      ).toArray().map(row => row.task_id);
      instance.ensureSchema();
      const second = sql.exec(
        "SELECT task_id FROM orchestrator_claim_candidates ORDER BY executor_id, created_at, task_id",
      ).toArray().map(row => row.task_id);

      expect(first).toEqual(["task-candidate-a", "task-candidate-b"]);
      expect(second).toEqual(first);
    });
  });

  it("creates an executor-scoped ordering index for candidate lookup", async () => {
    const ledger = ledgerFor("ledger-candidate-index-plan");
    await runInDurableObject(ledger, async (_instance, state) => {
      const indexes = state.storage.sql.exec(
        "PRAGMA index_list(orchestrator_claim_candidates)",
      ).toArray().map(row => row.name);
      expect(indexes).toContain("orchestrator_claim_candidates_by_executor_order");
      const columns = state.storage.sql.exec(
        "PRAGMA index_info(orchestrator_claim_candidates_by_executor_order)",
      ).toArray().map(row => row.name);
      expect(columns).toEqual(["executor_id", "created_at", "task_id"]);
    });
  });
});


it("uses the candidate relation for scheduler discovery while preserving explicit task lookup", async () => {
  const ledger = ledgerFor("ledger-candidate-query-path");
  await createTask(ledger, {
    task: task("task-candidate-query-path"),
    idempotencyKey: "task-candidate-query-path",
    inputHash: "3".repeat(64),
    now,
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec(
      "DELETE FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-candidate-query-path",
    );
  });

  const schedulerResult = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now),
    leaseMs: 30_000,
    now,
  });
  expect(schedulerResult).toEqual({ claimed: false, reason: "NO_TASK_AVAILABLE" });

  const explicitResult = await ledger.claimTask({
    taskId: "task-candidate-query-path",
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 1),
    leaseMs: 30_000,
    now: now + 1,
  });
  expect(explicitResult).toMatchObject({
    claimed: true,
    task: { taskId: "task-candidate-query-path" },
    leaseGeneration: 1,
  });
});

it("uses the executor/order candidate index for the scheduler lookup query plan", async () => {
  const ledger = ledgerFor("ledger-candidate-query-plan");
  await runInDurableObject(ledger, async (_instance, state) => {
    const plan = state.storage.sql.exec(
      "EXPLAIN QUERY PLAN SELECT task.* FROM orchestrator_claim_candidates AS candidate INNER JOIN orchestrator_tasks AS task ON task.task_id = candidate.task_id WHERE candidate.executor_id = ? ORDER BY candidate.created_at, candidate.task_id LIMIT 1",
      "agent:worker-1",
    ).toArray();
    expect(plan.map(row => row.detail).join(" ")).toContain(
      "orchestrator_claim_candidates_by_executor_order",
    );
  });
});
