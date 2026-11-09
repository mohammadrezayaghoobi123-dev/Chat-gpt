import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;
const keyBytes = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function assertion(subject, role, operation, at) {
  const issuedAt = Math.floor(at / 1000);
  const claims = { v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger", sub: subject, role, op: operation, iat: issuedAt, exp: issuedAt + 60, jti: "jti-" + base64Url(crypto.getRandomValues(new Uint8Array(16))) };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const input = "v1.test-v1." + payload;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return input + "." + base64Url(signature);
}
const ledgerFor = name => env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
async function createTask(ledger, taskId, at, index) {
  return ledger.createTask({
    task: { taskId, state: "SCHEDULED", version: 1, agentRound: 0, createdAt: at, updatedAt: at, executorId: "agent:worker-1", commitSha: "a".repeat(40), objective: "bounded claim cursor regression" },
    idempotencyKey: taskId, inputHash: (index % 256).toString(16).padStart(2, "0").repeat(32), now: at,
    workerId: "orchestrator-scheduler",
    workerAssertion: await assertion("orchestrator-scheduler", "system", "createTask", at),
  });
}
describe("Claim Engine bounded cursor contract", () => {
  it("returns a bounded continuation after skipping 128 active leases and resumes at candidate 129", async () => {
    const ledger = ledgerFor("ledger-bounded-scan-integration-red");
    const ids = [];
    for (let i = 0; i < 129; i += 1) {
      const id = "task-bounded-scan-" + String(i + 1).padStart(3, "0");
      ids.push(id);
      await createTask(ledger, id, now + i, i + 1);
    }
    await runInDurableObject(ledger, async (_instance, state) => {
      for (const id of ids.slice(0, 128)) {
        state.storage.sql.exec(
          "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, 1, ?, ?)",
          id, "agent:worker-1", now + 10_000, now,
        );
      }
    });
    const first = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 2_000),
      leaseMs: 30_000, now: now + 2_000,
    });
    expect(first).toMatchObject({
      claimed: false, reason: "CLAIM_SCAN_BUDGET_EXHAUSTED",
      candidatesExamined: 128, candidateRowsRead: 129,
      nextCursor: { version: 1, executorId: "agent:worker-1", snapshotSequence: expect.any(Number), createdAt: now + 127, taskId: ids[127] },
    });
    const second = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 2_001),
      leaseMs: 30_000, now: now + 2_001, cursor: first.nextCursor,
    });
    expect(second).toMatchObject({ claimed: true, task: { taskId: ids[128] }, candidatesExamined: 1 });
  });

  it("rejects a cursor scoped to another executor without creating a lease", async () => {
    const ledger = ledgerFor("ledger-bounded-cursor-wrong-executor");
    const taskId = "task-cursor-wrong-executor";
    await createTask(ledger, taskId, now, 200);
    const result = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
      cursor: {
        version: 1,
        executorId: "agent:worker-2",
        snapshotSequence: 0,
        createdAt: now,
        taskId: "task-cursor-wrong-executor",
      },
    });
    expect(result).toEqual({ claimed: false, reason: "INVALID_CLAIM_CURSOR" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one().count).toBe(0);
    });
  });

  it("requests a fresh snapshot when a new earlier-sorted candidate appears during cursor continuation", async () => {
    const ledger = ledgerFor("ledger-bounded-cursor-snapshot-churn");
    const ids = [];
    for (let i = 0; i < 129; i += 1) {
      const id = "task-snapshot-churn-" + String(i + 1).padStart(3, "0");
      ids.push(id);
      await createTask(ledger, id, now + i, 300 + i);
    }
    await runInDurableObject(ledger, async (_instance, state) => {
      for (const id of ids) {
        state.storage.sql.exec(
          "INSERT INTO orchestrator_execution_leases (task_id, worker_id, lease_generation, lease_until, updated_at) VALUES (?, ?, 1, ?, ?)",
          id, "agent:worker-1", now + 10_000, now,
        );
      }
    });
    const first = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 2_000),
      leaseMs: 30_000,
      now: now + 2_000,
    });
    expect(first.reason).toBe("CLAIM_SCAN_BUDGET_EXHAUSTED");

    const newEarlierTaskId = "task-snapshot-churn-000";
    await createTask(ledger, newEarlierTaskId, now, 244);
    const resumed = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 2_001),
      leaseMs: 30_000,
      now: now + 2_001,
      cursor: first.nextCursor,
    });
    expect(resumed).toMatchObject({
      claimed: false,
      reason: "CLAIM_SCAN_SNAPSHOT_EXHAUSTED",
      nextCursor: null,
      restartRequired: true,
    });

    const restarted = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 2_002),
      leaseMs: 30_000,
      now: now + 2_002,
    });
    expect(restarted).toMatchObject({
      claimed: true,
      task: { taskId: newEarlierTaskId },
    });
  });

});
