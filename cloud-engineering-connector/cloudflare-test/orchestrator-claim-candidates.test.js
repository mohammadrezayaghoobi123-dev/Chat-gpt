import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

const task = (taskId = "task-0001") => ({
  taskId, state: "SCHEDULED", version: 1, agentRound: 0,
  createdAt: now, updatedAt: now, executorId: "agent:worker-1",
  commitSha: "a".repeat(40), objective: "candidate query fixture",
});
const TEST_ASSERTION_KID = "test-v1";
const TEST_ASSERTION_KEY = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function createWorkerAssertion({ subject, role, operation, nowMs, jti }) {
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger",
    sub: subject, role, op: operation, iat: issuedAt, exp: issuedAt + 60,
    jti: jti ?? "jti-" + base64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const signingInput = "v1." + TEST_ASSERTION_KID + "." + payload;
  const key = await crypto.subtle.importKey("raw", TEST_ASSERTION_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return signingInput + "." + base64Url(signature);
}
const claimAssertion = (subject, issuedAt = now) => createWorkerAssertion({
  subject, role: "agent", operation: "claimTask", nowMs: issuedAt,
});
const createTask = async (ledger, input) => ledger.createTask({
  ...input, workerId: "orchestrator-scheduler",
  workerAssertion: await createWorkerAssertion({
    subject: "orchestrator-scheduler", role: "system", operation: "createTask", nowMs: input.now,
  }),
});

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
  it("creates candidate schema without an unbounded startup backfill and reconciles it in a bounded claim batch", async () => {
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
    expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_candidates").one().count).toBe(0);
    expect(sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_scan_cursors").one().count).toBe(0);
  });

  const claimed = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 10),
    leaseMs: 30_000,
    now: now + 10,
  });
  expect(claimed).toMatchObject({
    claimed: true,
    task: { taskId: "task-candidate-a" },
  });

  await runInDurableObject(ledger, async (instance, state) => {
    const sql = state.storage.sql;
    const candidates = sql.exec(
      "SELECT task_id FROM orchestrator_claim_candidates ORDER BY executor_id, created_at, task_id",
    ).toArray().map(row => row.task_id);
    expect(candidates).toEqual(["task-candidate-b"]);
    expect(sql.exec(
      "SELECT last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
      "agent:worker-1",
    ).one()).toMatchObject({ last_task_id: "task-active-lease", scan_complete: 1 });
    instance.ensureSchema();
    expect(sql.exec(
      "SELECT task_id FROM orchestrator_claim_candidates ORDER BY executor_id, created_at, task_id",
    ).toArray().map(row => row.task_id)).toEqual(["task-candidate-b"]);
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
  expect(schedulerResult).toMatchObject({
    claimed: true,
    task: { taskId: "task-candidate-query-path" },
    leaseGeneration: 1,
  });

  await createTask(ledger, {
    task: task("task-candidate-explicit-path"),
    idempotencyKey: "task-candidate-explicit-path",
    inputHash: "5".repeat(64),
    now: now + 1,
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec(
      "DELETE FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-candidate-explicit-path",
    );
  });
  const explicitResult = await ledger.claimTask({
    taskId: "task-candidate-explicit-path",
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 2),
    leaseMs: 30_000,
    now: now + 2,
  });
  expect(explicitResult).toMatchObject({
    claimed: true,
    task: { taskId: "task-candidate-explicit-path" },
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


it("reconciles a missing candidate index in bounded batches with a stable keyset cursor", async () => {
  const ledger = ledgerFor("ledger-candidate-bounded-fallback");
  for (let i = 0; i < 40; i += 1) {
    const taskId = "task-fallback-" + String(i + 1).padStart(2, "0");
    const createdAt = now + i;
    await createTask(ledger, {
      task: { ...task(taskId), createdAt, updatedAt: createdAt },
      idempotencyKey: taskId,
      inputHash: i.toString(16).padStart(2, "0").repeat(32),
      now: createdAt,
    });
  }
  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM orchestrator_claim_candidates");
  });

  const first = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 1_000),
    leaseMs: 30_000,
    now: now + 1_000,
  });
  expect(first).toMatchObject({
    claimed: true,
    task: { taskId: "task-fallback-01" },
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates",
    ).one().count).toBe(31);
    expect(state.storage.sql.exec(
      "SELECT last_created_at, last_task_id FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
      "agent:worker-1",
    ).one()).toMatchObject({ last_created_at: now + 31, last_task_id: "task-fallback-32" });
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec("DELETE FROM orchestrator_claim_candidates");
  });
  const second = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 1_001),
    leaseMs: 30_000,
    now: now + 1_001,
  });
  expect(second).toMatchObject({
    claimed: true,
    task: { taskId: "task-fallback-33" },
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates",
    ).one().count).toBe(7);
    expect(state.storage.sql.exec(
      "SELECT last_created_at, last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
      "agent:worker-1",
    ).one()).toMatchObject({
      last_created_at: now + 39, last_task_id: "task-fallback-40", scan_complete: 1,
    });
  });
});

it("uses the executor/created-at index for bounded fallback pagination", async () => {
  const ledger = ledgerFor("ledger-candidate-fallback-query-plan");
  await runInDurableObject(ledger, async (_instance, state) => {
    const firstPagePlan = state.storage.sql.exec(
      "EXPLAIN QUERY PLAN SELECT task_id, state, task_json, created_at FROM orchestrator_tasks WHERE COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) = ? ORDER BY created_at, task_id LIMIT 32",
      "agent:worker-1",
    ).toArray();
    expect(firstPagePlan.map(row => row.detail).join(" ")).toContain(
      "orchestrator_tasks_by_executor_created",
    );
    const continuationPlan = state.storage.sql.exec(
      "EXPLAIN QUERY PLAN SELECT task_id, state, task_json, created_at FROM orchestrator_tasks WHERE COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) = ? AND (created_at > ? OR (created_at = ? AND task_id > ?)) ORDER BY created_at, task_id LIMIT 32",
      "agent:worker-1", now, now, "task-fallback-32",
    ).toArray();
    expect(continuationPlan.map(row => row.detail).join(" ")).toContain(
      "orchestrator_tasks_by_executor_created",
    );
  });
});
