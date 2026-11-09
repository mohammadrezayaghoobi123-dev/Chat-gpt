import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";
import { CLAIM_CANDIDATE_QUERY } from "../orchestrator-ledger.js";

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
    expect(candidates).toEqual(["task-candidate-a", "task-candidate-b", "task-active-lease"]);
    expect(sql.exec(
      "SELECT last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
      "agent:worker-1",
    ).one()).toMatchObject({ last_task_id: "task-active-lease", scan_complete: 1 });
    instance.ensureSchema();
    expect(sql.exec(
      "SELECT task_id FROM orchestrator_claim_candidates ORDER BY executor_id, created_at, task_id",
    ).toArray().map(row => row.task_id)).toEqual(["task-candidate-a", "task-candidate-b", "task-active-lease"]);
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


it("migrates pre-v8 candidate rows lazily and resets the bounded reconciliation cursor", async () => {
  const ledger = ledgerFor("ledger-candidate-sequence-migration");
  await runInDurableObject(ledger, async (instance, state) => {
    const sql = state.storage.sql;
    insertTask(sql, { taskId: "task-pre-v8-candidate", createdAt: now });
    sql.exec(
      "INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at) VALUES (?, ?, ?)",
      "task-pre-v8-candidate", "agent:worker-1", now,
    );
    sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_sequence");
    sql.exec("DROP INDEX IF EXISTS orchestrator_claim_candidates_by_executor_order");
    sql.exec("ALTER TABLE orchestrator_claim_candidates RENAME TO orchestrator_claim_candidates_pre_v8");
    sql.exec(`
      CREATE TABLE orchestrator_claim_candidates (
        task_id TEXT PRIMARY KEY REFERENCES orchestrator_tasks(task_id) ON DELETE CASCADE,
        executor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(
      "INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at) SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates_pre_v8",
    );
    sql.exec("DROP TABLE orchestrator_claim_candidates_pre_v8");
    sql.exec("CREATE INDEX orchestrator_claim_candidates_by_executor_order ON orchestrator_claim_candidates(executor_id, created_at, task_id)");
    sql.exec(
      "INSERT OR REPLACE INTO orchestrator_claim_scan_cursors (executor_id, last_created_at, last_task_id, scan_complete, updated_at) VALUES (?, ?, ?, 1, ?)",
      "agent:worker-1", now + 99, "task-z", now,
    );

    instance.ensureSchema();
    const columns = sql.exec("PRAGMA table_info(orchestrator_claim_candidates)").toArray().map(row => row.name);
    expect(columns).toContain("candidate_seq");
    expect(sql.exec(
      "SELECT candidate_seq FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-pre-v8-candidate",
    ).one().candidate_seq).toBeNull();
    expect(sql.exec(
      "SELECT last_created_at, last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
      "agent:worker-1",
    ).one()).toEqual({ last_created_at: 0, last_task_id: "", scan_complete: 0 });
  });

  const claimed = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 1),
    leaseMs: 30_000,
    now: now + 1,
  });
  expect(claimed).toMatchObject({
    claimed: true,
    task: { taskId: "task-pre-v8-candidate" },
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT candidate_seq FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-pre-v8-candidate",
    ).one().candidate_seq).toBeGreaterThan(0);
  });
});

it("removes a task from the candidate index when a fenced transition makes it non-claimable", async () => {
  const ledger = ledgerFor("ledger-candidate-transition-removal");
  await createTask(ledger, {
    task: task("task-transition-blocked"),
    idempotencyKey: "task-transition-blocked",
    inputHash: "9".repeat(64),
    now,
  });
  await createTask(ledger, {
    task: task("task-transition-next"),
    idempotencyKey: "task-transition-next",
    inputHash: "a".repeat(64),
    now: now + 1,
  });
  const firstLease = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now),
    leaseMs: 30_000,
    now,
  });
  expect(firstLease).toMatchObject({ claimed: true, task: { taskId: "task-transition-blocked" } });

  const transitioned = await ledger.transitionTask({
    taskId: "task-transition-blocked",
    expectedVersion: 1,
    expectedState: "SCHEDULED",
    nextState: "BLOCKED",
    actor: { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" },
    evidence: { kind: "test-evidence", reference: "ci://claim-candidate-transition" },
    now: now + 1,
    workerId: "agent:worker-1",
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1,
    }),
    leaseGeneration: firstLease.leaseGeneration,
  });
  expect(transitioned).toMatchObject({ updated: true, task: { state: "BLOCKED" } });

  const next = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 2),
    leaseMs: 30_000,
    now: now + 2,
  });
  expect(next).toMatchObject({ claimed: true, task: { taskId: "task-transition-next" } });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-transition-blocked",
    ).one().count).toBe(0);
  });
});

it("uses candidate discovery for scheduling and fails closed on missing explicit candidate rows", async () => {
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
  expect(explicitResult).toEqual({
    claimed: false,
    reason: "CANDIDATE_INDEX_INCONSISTENT",
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ?",
      "task-candidate-explicit-path",
    ).one().count).toBe(0);
  });
});

it("consumes a valid worker assertion before rejecting an explicit claim with a missing candidate row", async () => {
  const ledger = ledgerFor("ledger-explicit-claim-index-mismatch-consumes-assertion");
  await createTask(ledger, {
    task: task("task-explicit-index-missing"),
    idempotencyKey: "task-explicit-index-missing",
    inputHash: "6".repeat(64),
    now,
  });
  await createTask(ledger, {
    task: task("task-explicit-index-present"),
    idempotencyKey: "task-explicit-index-present",
    inputHash: "7".repeat(64),
    now: now + 1,
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec(
      "DELETE FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-explicit-index-missing",
    );
  });

  const oneTimeAssertion = await claimAssertion("agent:worker-1", now + 2);
  const rejected = await ledger.claimTask({
    taskId: "task-explicit-index-missing",
    workerId: "agent:worker-1",
    workerAssertion: oneTimeAssertion,
    leaseMs: 30_000,
    now: now + 2,
  });
  expect(rejected).toEqual({ claimed: false, reason: "CANDIDATE_INDEX_INCONSISTENT" });

  const replay = await ledger.claimTask({
    taskId: "task-explicit-index-present",
    workerId: "agent:worker-1",
    workerAssertion: oneTimeAssertion,
    leaseMs: 30_000,
    now: now + 3,
  });
  expect(replay).toEqual({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
});

it("repairs a malformed derived candidate sequence before scheduler claim", async () => {
  const ledger = ledgerFor("ledger-candidate-sequence-repair");
  await createTask(ledger, {
    task: task("task-candidate-sequence-repair"),
    idempotencyKey: "task-candidate-sequence-repair",
    inputHash: "8".repeat(64),
    now,
  });
  const originalSequence = await runInDurableObject(ledger, async (_instance, state) => {
    const sql = state.storage.sql;
    const sequence = sql.exec(
      "SELECT candidate_seq FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-candidate-sequence-repair",
    ).one().candidate_seq;
    sql.exec(
      "UPDATE orchestrator_claim_candidates SET candidate_seq = -1 WHERE task_id = ?",
      "task-candidate-sequence-repair",
    );
    return sequence;
  });

  const claimed = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now),
    leaseMs: 30_000,
    now,
  });
  expect(claimed).toMatchObject({
    claimed: true,
    task: { taskId: "task-candidate-sequence-repair" },
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    const repairedSequence = state.storage.sql.exec(
      "SELECT candidate_seq FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-candidate-sequence-repair",
    ).one().candidate_seq;
    expect(repairedSequence).toBeGreaterThan(originalSequence);
  });
});

it("uses the executor/order index for the exact bounded cursor query without a temporary sort", async () => {
  const ledger = ledgerFor("ledger-candidate-query-plan");
  await runInDurableObject(ledger, async (_instance, state) => {
    const plan = state.storage.sql.exec(
      "EXPLAIN QUERY PLAN " + CLAIM_CANDIDATE_QUERY,
      "agent:worker-1", 10_000, 0, "", 129,
    ).toArray();
    const details = plan.map(row => row.detail).join(" ");
    expect(details).toContain("orchestrator_claim_candidates_by_executor_order");
    expect(details).not.toMatch(/USE TEMP B-TREE/i);

    const snapshotPlan = state.storage.sql.exec(
      "EXPLAIN QUERY PLAN SELECT 1 FROM orchestrator_claim_candidates WHERE executor_id = ? AND candidate_seq > ? LIMIT 1",
      "agent:worker-1", 100,
    ).toArray();
    expect(snapshotPlan.map(row => row.detail).join(" ")).toContain(
      "orchestrator_claim_candidates_by_executor_sequence",
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
    ).one().count).toBe(32);
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
    ).one().count).toBe(8);
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
      "EXPLAIN QUERY PLAN SELECT task_id, state, task_json, created_at FROM orchestrator_tasks WHERE COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) = ? AND (created_at, task_id) > (?, ?) ORDER BY created_at, task_id LIMIT 32",
      "agent:worker-1", now, "task-fallback-32",
    ).toArray();
    expect(continuationPlan.map(row => row.detail).join(" ")).toContain(
      "orchestrator_tasks_by_executor_created",
    );
    expect(continuationPlan.map(row => row.detail).join(" ")).toContain(
      "(created_at,task_id)>(?,?)",
    );
  });
});

it("atomically assigns distinct candidate tasks under concurrent claims for one executor", async () => {
  const ledger = ledgerFor("ledger-candidate-concurrent-claims");
  for (const taskId of ["task-concurrent-a", "task-concurrent-b"]) {
    await createTask(ledger, {
      task: task(taskId),
      idempotencyKey: taskId,
      inputHash: taskId === "task-concurrent-a" ? "a".repeat(64) : "b".repeat(64),
      now,
    });
  }

  const [first, second] = await Promise.all([
    ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    }),
    ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now + 2),
      leaseMs: 30_000,
      now: now + 2,
    }),
  ]);

  expect(first.claimed).toBe(true);
  expect(second.claimed).toBe(true);
  expect(new Set([first.task.taskId, second.task.taskId])).toEqual(
    new Set(["task-concurrent-a", "task-concurrent-b"]),
  );

  await runInDurableObject(ledger, async (_instance, state) => {
    const leases = state.storage.sql.exec(
      "SELECT task_id, worker_id, lease_generation FROM orchestrator_execution_leases WHERE task_id IN (?, ?) ORDER BY task_id",
      "task-concurrent-a", "task-concurrent-b",
    ).toArray();
    expect(leases).toHaveLength(2);
    expect(leases).toEqual([
      { task_id: "task-concurrent-a", worker_id: "agent:worker-1", lease_generation: 1 },
      { task_id: "task-concurrent-b", worker_id: "agent:worker-1", lease_generation: 1 },
    ]);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id IN (?, ?)",
      "task-concurrent-a", "task-concurrent-b",
    ).one().count).toBe(2);
  });
});

