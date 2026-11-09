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
  const claims = {
    v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger",
    sub: subject, role, op: operation, iat: issuedAt, exp: issuedAt + 60,
    jti: "jti-" + base64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const input = "v1.test-v1." + payload;
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return input + "." + base64Url(signature);
}
const ledgerFor = name => env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
async function createTask(ledger, taskId, at, index, executorId = "agent:worker-1") {
  return ledger.createTask({
    task: {
      taskId, state: "SCHEDULED", version: 1, agentRound: 0,
      createdAt: at, updatedAt: at, executorId,
      commitSha: "a".repeat(40), objective: "bounded claim fallback regression",
    },
    idempotencyKey: taskId,
    inputHash: index.toString(16).padStart(2, "0").repeat(32),
    now: at,
    workerId: "orchestrator-scheduler",
    workerAssertion: await assertion("orchestrator-scheduler", "system", "createTask", at),
  });
}
describe("Claim Engine bounded fallback cursor contract", () => {
  it("advances a 32-row durable fallback cursor and claims the first eligible task in the next batch", async () => {
    const ledger = ledgerFor("ledger-bounded-fallback-cursor");
    const ids = [];
    for (let i = 0; i < 33; i += 1) {
      const id = "task-fallback-" + String(i + 1).padStart(3, "0");
      ids.push(id);
      await createTask(ledger, id, now + i, i + 1);
    }

    // Simulate pre-index/legacy rows: 32 tasks are actively leased and none
    // of the 33 tasks has yet been reconciled into the candidate index.
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM orchestrator_claim_candidates");
      for (const id of ids.slice(0, 32)) {
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
    expect(first).toMatchObject({ claimed: false, reason: "NO_TASK_AVAILABLE" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT last_created_at, last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
        "agent:worker-1",
      ).toArray()[0]).toEqual({
        last_created_at: now + 31, last_task_id: ids[31], scan_complete: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates",
      ).one().count).toBe(0);
    });

    const second = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await assertion("agent:worker-1", "agent", "claimTask", now + 2_001),
      leaseMs: 30_000, now: now + 2_001,
    });
    expect(second).toMatchObject({
      claimed: true, task: { taskId: ids[32] }, leaseGeneration: 1,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT last_created_at, last_task_id, scan_complete FROM orchestrator_claim_scan_cursors WHERE executor_id = ?",
        "agent:worker-1",
      ).toArray()[0]).toEqual({
        last_created_at: now + 32, last_task_id: ids[32], scan_complete: 1,
      });
    });
  });

  it("serializes concurrent claims over four candidates without duplicate task ownership", async () => {
    const ledger = ledgerFor("ledger-concurrent-four-claims");
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      const id = "task-concurrent-claim-" + String(i + 1).padStart(3, "0");
      ids.push(id);
      await createTask(ledger, id, now + i, i + 40);
    }

    const results = await Promise.all(ids.map((_, index) => ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: assertion("agent:worker-1", "agent", "claimTask", now + 2_000 + index),
      leaseMs: 30_000,
      now: now + 2_000 + index,
    })));

    expect(results).toHaveLength(4);
    expect(results.every(result => result.claimed)).toBe(true);
    expect(new Set(results.map(result => result.task.taskId))).toEqual(new Set(ids));
    expect(new Set(results.map(result => result.leaseGeneration))).toEqual(new Set([1]));
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE worker_id = ? AND lease_until > ?",
        "agent:worker-1", now + 2_100,
      ).one().count).toBe(4);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates",
      ).one().count).toBe(0);
    });
  });

});
