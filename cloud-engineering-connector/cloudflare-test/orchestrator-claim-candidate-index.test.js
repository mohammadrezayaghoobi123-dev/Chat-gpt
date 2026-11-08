import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;
const TEST_ASSERTION_KID = "test-v1";
const TEST_ASSERTION_KEY = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\\+/g, "-").replace(/\\//g, "_");
}

async function createWorkerAssertion({ subject, role, operation, nowMs }) {
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger",
    sub: subject, role, op: operation, iat: issuedAt, exp: issuedAt + 60,
    jti: "jti-" + base64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const signingInput = "v1." + TEST_ASSERTION_KID + "." + payload;
  const key = await crypto.subtle.importKey("raw", TEST_ASSERTION_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return signingInput + "." + base64Url(signature);
}

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

async function createTask(ledger, taskId, executorId, state = "SCHEDULED", createdAt = now) {
  return ledger.createTask({
    task: {
      taskId, state, version: 1, agentRound: 0, createdAt, updatedAt: createdAt,
      executorId, commitSha: "a".repeat(40), objective: "candidate index fixture",
    },
    idempotencyKey: "candidate-index-" + taskId,
    inputHash: "b".repeat(64),
    workerId: "orchestrator-scheduler",
    workerAssertion: await createWorkerAssertion({
      subject: "orchestrator-scheduler", role: "system", operation: "createTask", nowMs: createdAt,
    }),
    now: createdAt,
  });
}

describe("OrchestratorLedger claim candidate index", () => {
  it("creates the candidate index table and executor ordering index during schema initialization", async () => {
    const ledger = ledgerFor("claim-candidate-index-schema");
    await ledger.ping();
    await runInDurableObject(ledger, async (_instance, state) => {
      const tables = state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).toArray().map(row => row.name);
      expect(tables).toContain("orchestrator_claim_candidates");
      const indexes = state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      ).toArray().map(row => row.name);
      expect(indexes).toContain("orchestrator_claim_candidates_by_executor_created");
    });
  });

  it("indexes only active tasks with a stable executor and preserves deterministic ordering", async () => {
    const ledger = ledgerFor("claim-candidate-index-membership");
    await createTask(ledger, "candidate-z", "agent:worker-1", "SCHEDULED", now);
    await createTask(ledger, "candidate-a", "agent:worker-1", "RUNNING", now);
    await createTask(ledger, "candidate-terminal", "agent:worker-1", "COMPLETED", now + 1);
    await createTask(ledger, "candidate-other-executor", "agent:worker-2", "SCHEDULED", now + 2);

    await runInDurableObject(ledger, async (_instance, state) => {
      const rows = state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE executor_id = ? ORDER BY created_at, task_id",
        "agent:worker-1",
      ).toArray();
      expect(rows).toEqual([
        { task_id: "candidate-a", executor_id: "agent:worker-1", created_at: now },
        { task_id: "candidate-z", executor_id: "agent:worker-1", created_at: now },
      ]);
    });
  });

  it("keeps the candidate index consistent with authoritative task projections after task creation", async () => {
    const ledger = ledgerFor("claim-candidate-index-consistency");
    await createTask(ledger, "candidate-consistent-1", "agent:worker-1");
    await createTask(ledger, "candidate-consistent-2", "agent:worker-2", "FAILED", now + 1);

    await runInDurableObject(ledger, async (_instance, state) => {
      const expected = state.storage.sql.exec(
        "SELECT task_id, COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) AS executor_id, created_at FROM orchestrator_tasks WHERE state IN ('SCHEDULED','RUNNING','VERIFYING') AND COALESCE(json_extract(task_json, '$.executorId'), json_extract(task_json, '$.assignedAgentId')) IS NOT NULL ORDER BY created_at, task_id",
      ).toArray();
      const actual = state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates ORDER BY created_at, task_id",
      ).toArray();
      expect(actual).toEqual(expected);
    });
  });
});
