import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";
import { createExecutorWorkerAssertion } from "../orchestrator-executor-assertion.js";

const EXECUTOR_ID = "orchestrator-executor";
const EXECUTOR_KID = "executor-ed25519-v1";
const now = Date.now();

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
  const keySet = JSON.parse(env.LEDGER_WORKER_ASSERTION_KEYS);
  const encodedMaterial = keySet["test-v1"];
  if (typeof encodedMaterial !== "string" || !/^[a-f0-9]{64,128}$/.test(encodedMaterial)) {
    throw new Error("Missing test-only Scheduler assertion material.");
  }
  const material = Uint8Array.from(
    encodedMaterial.match(/.{2}/g),
    pair => Number.parseInt(pair, 16),
  );
  const signingInput = "v1.test-v1." + payload;
  const hmacKey = await crypto.subtle.importKey(
    "raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC", hmacKey, new TextEncoder().encode(signingInput),
  ));
  return signingInput + "." + base64Url(signature);
}

async function createExecutorAssertion(nowMs = now, operation = "claimTask") {
  const seed = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix);
  pkcs8.set(seed, prefix.length);
  return createExecutorWorkerAssertion(base64Url(pkcs8), EXECUTOR_KID, { nowMs, operation });
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

  it("renews an Executor lease only with a one-time renewLease assertion", async () => {
    const ledger = ledgerFor("executor-ed25519-renew-lease");
    await expect(createScheduledTask(ledger, "task-executor-renew", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseMs: 30_000,
      now,
      taskId: "task-executor-renew",
    });
    expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });

    await expect(ledger.renewLease({
      taskId: "task-executor-renew",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 45_000,
      now: now + 1,
    })).resolves.toMatchObject({ renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });

    const renewAssertion = await createExecutorAssertion(now + 1, "renewLease");
    const renewed = await ledger.renewLease({
      taskId: "task-executor-renew",
      workerId: EXECUTOR_ID,
      workerAssertion: renewAssertion,
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 45_000,
      now: now + 1,
    });
    expect(renewed).toMatchObject({
      renewed: true,
      leaseGeneration: claimed.leaseGeneration,
    });
    expect(renewed.leaseUntil).toBeGreaterThanOrEqual(now + 45_000);
    expect(renewed.leaseUntil).toBeLessThanOrEqual(Date.now() + 45_000);
    await expect(ledger.renewLease({
      taskId: "task-executor-renew",
      workerId: EXECUTOR_ID,
      workerAssertion: renewAssertion,
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 45_000,
      now: now + 2,
    })).resolves.toMatchObject({ renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        "task-executor-renew",
      ).toArray()).toEqual([{
        worker_id: EXECUTOR_ID,
        lease_generation: 1,
        lease_until: renewed.leaseUntil,
      }]);
    });
  });

  it("releases an Executor lease only with a one-time releaseLease assertion", async () => {
    const ledger = ledgerFor("executor-ed25519-release-lease");
    await expect(createScheduledTask(ledger, "task-executor-release", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseMs: 30_000,
      now,
      taskId: "task-executor-release",
    });
    expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });

    await expect(ledger.releaseLease({
      taskId: "task-executor-release",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "renewLease"),
      leaseGeneration: claimed.leaseGeneration,
      now: now + 1,
    })).resolves.toMatchObject({ released: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });

    const releaseAssertion = await createExecutorAssertion(now + 2, "releaseLease");
    await expect(ledger.releaseLease({
      taskId: "task-executor-release",
      workerId: EXECUTOR_ID,
      workerAssertion: releaseAssertion,
      leaseGeneration: claimed.leaseGeneration,
      now: now + 2,
    })).resolves.toMatchObject({ released: true, leaseGeneration: claimed.leaseGeneration });

    await expect(ledger.releaseLease({
      taskId: "task-executor-release",
      workerId: EXECUTOR_ID,
      workerAssertion: releaseAssertion,
      leaseGeneration: claimed.leaseGeneration,
      now: now + 3,
    })).resolves.toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        "task-executor-release",
      ).toArray()).toEqual([{
        worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      }]);
      expect(state.storage.sql.exec(
        "SELECT operation FROM orchestrator_consumed_assertions WHERE subject = ? ORDER BY operation",
        EXECUTOR_ID,
      ).toArray()).toEqual([
        { operation: "claimTask" },
        { operation: "releaseLease" },
      ]);
    });
  });

  it("rejects HMAC Executor assertions and denies Executor operations outside the fixed allowlist", async () => {
    const ledger = ledgerFor("executor-ed25519-reject-hmac-renew-and-disallowed");
    await expect(createScheduledTask(ledger, "task-executor-hmac-renew", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseMs: 30_000,
      now,
      taskId: "task-executor-hmac-renew",
    });
    expect(claimed).toMatchObject({ claimed: true });

    await expect(ledger.renewLease({
      taskId: "task-executor-hmac-renew",
      workerId: EXECUTOR_ID,
      workerAssertion: await createHmacAssertion({
        subject: EXECUTOR_ID,
        role: "agent",
        operation: "renewLease",
        nowMs: now + 1,
      }),
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 30_000,
      now: now + 1,
    })).resolves.toMatchObject({ renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });

    await expect(ledger.advanceAgentRound({
      taskId: "task-executor-hmac-renew",
      expectedVersion: 1,
      expectedRound: 0,
      nextRound: 1,
      workerId: EXECUTOR_ID,
      workerAssertion: await createHmacAssertion({
        subject: EXECUTOR_ID,
        role: "agent",
        operation: "advanceAgentRound",
        nowMs: now + 2,
      }),
      leaseGeneration: claimed.leaseGeneration,
      now: now + 2,
    })).resolves.toMatchObject({ advanced: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  });

  it("preserves lease-generation fencing and expiry for Executor renewal and release", async () => {
    const ledger = ledgerFor("executor-ed25519-lease-fencing");
    await expect(createScheduledTask(ledger, "task-executor-lease-fencing", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseMs: 30_000,
      now,
      taskId: "task-executor-lease-fencing",
    });
    expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });

    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_generation = 2 WHERE task_id = ?",
        "task-executor-lease-fencing",
      );
    });
    await expect(ledger.renewLease({
      taskId: "task-executor-lease-fencing",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now + 1, "renewLease"),
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 30_000,
      now: now + 1,
    })).resolves.toMatchObject({ renewed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.releaseLease({
      taskId: "task-executor-lease-fencing",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now + 2, "releaseLease"),
      leaseGeneration: claimed.leaseGeneration,
      now: now + 2,
    })).resolves.toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });

    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_generation = 1, lease_until = ? WHERE task_id = ?",
        now + 3, "task-executor-lease-fencing",
      );
    });
    await expect(ledger.renewLease({
      taskId: "task-executor-lease-fencing",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now + 4, "renewLease"),
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 30_000,
      now: now + 4,
    })).resolves.toMatchObject({ renewed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.releaseLease({
      taskId: "task-executor-lease-fencing",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now + 5, "releaseLease"),
      leaseGeneration: claimed.leaseGeneration,
      now: now + 5,
    })).resolves.toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
  });

  it("rejects the Executor principal from HMAC-only publisher operations", async () => {
    const ledger = ledgerFor("executor-ed25519-reject-publisher-hmac");
    await expect(ledger.claimOutbox({
      workerId: EXECUTOR_ID,
      workerAssertion: await createHmacAssertion({
        subject: EXECUTOR_ID,
        role: "publisher",
        operation: "claimOutbox",
        nowMs: now,
      }),
      leaseMs: 30_000,
      now,
    })).resolves.toMatchObject({
      claimed: false,
      reason: "AUTHENTICATED_WORKER_REQUIRED",
    });
  });

  it("does not let a backdated caller timestamp resurrect an expired Executor lease", async () => {
    const ledger = ledgerFor("executor-ed25519-reject-backdated-lease-time");
    await expect(createScheduledTask(ledger, "task-executor-backdated-time", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseMs: 30_000,
      now,
      taskId: "task-executor-backdated-time",
    });
    expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });

    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_until = ? WHERE task_id = ?",
        now - 1, "task-executor-backdated-time",
      );
    });

    const backdatedNow = now - 1_000;
    await expect(ledger.renewLease({
      taskId: "task-executor-backdated-time",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(backdatedNow, "renewLease"),
      leaseGeneration: claimed.leaseGeneration,
      leaseMs: 30_000,
      now: backdatedNow,
    })).resolves.toMatchObject({
      renewed: false,
      reason: "LEASE_FENCE_MISMATCH",
    });
  });

  it("does not let a backdated caller timestamp release an expired Executor lease", async () => {
    const ledger = ledgerFor("executor-ed25519-reject-backdated-release-time");
    await expect(createScheduledTask(ledger, "task-executor-backdated-release-time", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(now, "claimTask"),
      leaseMs: 30_000,
      now,
      taskId: "task-executor-backdated-release-time",
    });
    expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });

    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_until = ? WHERE task_id = ?",
        now - 1, "task-executor-backdated-release-time",
      );
    });

    const backdatedNow = now - 1_000;
    await expect(ledger.releaseLease({
      taskId: "task-executor-backdated-release-time",
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(backdatedNow, "releaseLease"),
      leaseGeneration: claimed.leaseGeneration,
      now: backdatedNow,
    })).resolves.toMatchObject({
      released: false,
      reason: "LEASE_FENCE_MISMATCH",
    });
  });

  it("uses a post-verification Ledger timestamp when renewing an Executor lease", async () => {
    const ledger = ledgerFor("executor-ed25519-lease-clock-toctou");
    await expect(createScheduledTask(ledger, "task-executor-clock-toctou", EXECUTOR_ID))
      .resolves.toMatchObject({ created: true });
    const issuedAt = Date.now();
    const claimed = await ledger.claimTask({
      workerId: EXECUTOR_ID,
      workerAssertion: await createExecutorAssertion(issuedAt, "claimTask"),
      leaseMs: 30_000,
      now: issuedAt,
      taskId: "task-executor-clock-toctou",
    });
    expect(claimed).toMatchObject({ claimed: true, leaseGeneration: 1 });

    const realNow = Date.now;
    const verificationTime = realNow();
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE orchestrator_execution_leases SET lease_until = ? WHERE task_id = ?",
        verificationTime + 500, "task-executor-clock-toctou",
      );
    });

    let clockReads = 0;
    Date.now = () => {
      clockReads += 1;
      return clockReads === 1 ? verificationTime : verificationTime + 1_000;
    };
    try {
      const renewed = await ledger.renewLease({
        taskId: "task-executor-clock-toctou",
        workerId: EXECUTOR_ID,
        workerAssertion: await createExecutorAssertion(verificationTime, "renewLease"),
        leaseGeneration: claimed.leaseGeneration,
        leaseMs: 30_000,
        now: verificationTime,
      });
      expect(renewed).toMatchObject({
        renewed: false,
        reason: "LEASE_FENCE_MISMATCH",
      });
      expect(clockReads).toBeGreaterThanOrEqual(2);
    } finally {
      Date.now = realNow;
    }
  });
});
