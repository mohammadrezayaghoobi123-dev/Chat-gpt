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
