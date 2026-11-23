import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";
import { createExecutorWorkerAssertion } from "../orchestrator-executor-assertion.js";

const EXECUTOR_ID = "orchestrator-executor";
const EXECUTOR_KID = "executor-ed25519-v1";
const SCHEDULER_MARKER = "test-v1";
const SCHEDULER_KEY = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const now = 1_800_000_000_000;

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createHmacAssertion({ subject, role, operation, nowMs }) {
  const issuedAt = Math.floor(nowMs / 1000);
  const claims = {
    v: 1,
    iss: "chat-gpt111-worker",
    aud: "orchestrator-ledger",
    sub: subject,
    role,
    op: operation,
    iat: issuedAt,
    exp: issuedAt + 60,
    jti: "jti-" + base64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = base64Url(new TextEncoder().encode(canonicalJson(claims)));
  const signingInput = "v1." + SCHEDULER_MARKER + "." + payload;
  const key = await crypto.subtle.importKey(
    "raw", SCHEDULER_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(signingInput),
  ));
  return signingInput + "." + base64Url(signature);
}

async function createExecutorAssertion(nowMs = now) {
  const seed = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix);
  pkcs8.set(seed, prefix.length);
  return createExecutorWorkerAssertion(base64Url(pkcs8), EXECUTOR_KID, { nowMs });
}

async function createScheduledTask(ledger, taskId, executorId) {
  const task = {
    taskId,
    state: "SCHEDULED",
    version: 1,
    agentRound: 0,
    createdAt: now,
    updatedAt: now,
    executorId,
    commitSha: "a".repeat(40),
    objective: "bounded executor assertion test",
  };
  return ledger.createTask({
    task,
    idempotencyKey: "create-" + taskId,
    inputHash: "b".repeat(64),
    now,
    workerId: "orchestrator-scheduler",
    workerAssertion: await createHmacAssertion({
      subject: "orchestrator-scheduler",
      role: "system",
      operation: "createTask",
      nowMs: now,
    }),
  });
}

describe("Executor Ed25519 trust boundary", () => {
  it("accepts an Ed25519 Executor assertion and records its one-time JTI", async () => {
    const ledger = ledgerFor("executor-ed25519-claim-accept");
    await expect(createScheduledTask(ledger, "task-executor-ed25519-accept", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const assertion = await createExecutorAssertion();
    const result = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: assertion,
      leaseMs: 30_000,
      now,
      taskId: "task-executor-ed25519-accept",
    });
    expect(result).toMatchObject({
      claimed: true,
      workerId: EXECUTOR_ID,
      leaseGeneration: 1,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT subject, role, operation, key_id FROM orchestrator_consumed_assertions WHERE subject = ?",
        EXECUTOR_ID,
      ).toArray()).toEqual([{
        subject: EXECUTOR_ID,
        role: "agent",
        operation: "claimTask",
        key_id: EXECUTOR_KID,
      }]);
    });
  });

  it("rejects a Scheduler HMAC assertion when it attempts to claim as the Executor", async () => {
    const ledger = ledgerFor("executor-ed25519-claim-reject-hmac");
    await expect(createScheduledTask(ledger, "task-executor-ed25519-reject-hmac", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const forged = await createHmacAssertion({
      subject: EXECUTOR_ID,
      role: "agent",
      operation: "claimTask",
      nowMs: now,
    });
    await expect(ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: forged,
      leaseMs: 30_000,
      now,
      taskId: "task-executor-ed25519-reject-hmac",
    })).resolves.toMatchObject({
      claimed: false,
      reason: "AUTHENTICATED_WORKER_REQUIRED",
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ?",
        "task-executor-ed25519-reject-hmac",
      ).one().count).toBe(0);
    });
  });

  it("rejects an Executor Ed25519 assertion at the Scheduler task-creation boundary", async () => {
    const ledger = ledgerFor("executor-ed25519-cannot-create-task");
    await expect(ledger.createTask({
      task: {
        taskId: "task-executor-ed25519-cannot-create",
        state: "SCHEDULED",
        version: 1,
        agentRound: 0,
        createdAt: now,
        updatedAt: now,
        executorId: EXECUTOR_ID,
        commitSha: "c".repeat(40),
        objective: "cross-principal negative test",
      },
      idempotencyKey: "executor-ed25519-cannot-create",
      inputHash: "d".repeat(64),
      now,
      workerId: "orchestrator-scheduler",
      workerAssertion: await createExecutorAssertion(),
    })).resolves.toMatchObject({
      created: false,
      reason: "AUTHENTICATED_WORKER_REQUIRED",
    });
  });

  it("consumes an Executor JTI once across distinct task claims", async () => {
    const ledger = ledgerFor("executor-ed25519-claim-replay");
    await expect(createScheduledTask(ledger, "task-executor-replay-one", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    await expect(createScheduledTask(ledger, "task-executor-replay-two", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const assertion = await createExecutorAssertion();
    await expect(ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: assertion,
      leaseMs: 30_000,
      now,
      taskId: "task-executor-replay-one",
    })).resolves.toMatchObject({ claimed: true });
    await expect(ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: assertion,
      leaseMs: 30_000,
      now,
      taskId: "task-executor-replay-two",
    })).resolves.toMatchObject({
      claimed: false,
      reason: "AUTHENTICATED_WORKER_REQUIRED",
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE subject = ?",
        EXECUTOR_ID,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_execution_leases WHERE task_id = ?",
        "task-executor-replay-two",
      ).one().count).toBe(0);
    });
  });

  it("preserves the existing HMAC claim path for non-Executor agents", async () => {
    const ledger = ledgerFor("executor-ed25519-legacy-agent-regression");
    await expect(createScheduledTask(ledger, "task-executor-legacy-agent", "agent:worker-1"))
      .resolves.toMatchObject({ created: true });
    const assertion = await createHmacAssertion({
      subject: "agent:worker-1",
      role: "agent",
      operation: "claimTask",
      nowMs: now,
    });
    await expect(ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: assertion,
      leaseMs: 30_000,
      now,
      taskId: "task-executor-legacy-agent",
    })).resolves.toMatchObject({
      claimed: true,
      workerId: "agent:worker-1",
      leaseGeneration: 1,
    });
  });
});
