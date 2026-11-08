import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";

const now = 1_800_000_000_000;
const TEST_ASSERTION_KID = "test-v1";
const TEST_ASSERTION_KEY = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "").split("+").join("-").split("/").join("_");
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


const ownerId = "335530603";
const repositoryId = 1398846697;
const ownerKeySet = JSON.stringify({
  "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const agent = { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" };
const transitionEvidence = { kind: "test-evidence", reference: "ci://candidate-index-transition" };

async function seedCandidate(ledger, taskId, executorId = "agent:worker-1", createdAt = now) {
  await runInDurableObject(ledger, async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO orchestrator_claim_candidates (task_id, executor_id, created_at) VALUES (?, ?, ?)",
      taskId, executorId, createdAt,
    );
  });
}

async function ownerCancelInput(taskId) {
  const command = {
    operation: "cancel", taskId, reason: "Owner requested cancellation",
    eventId: "candidate-owner-cancel-" + taskId,
  };
  const context = {
    actorId: ownerId, repositoryId, taskId, operation: command.operation,
    deliveryId: "delivery-" + taskId + "-0001",
    commentId: "987654321",
    commandHash: await sha256Canonical({
      eventId: command.eventId, operation: command.operation,
      reason: command.reason, taskId: command.taskId,
    }),
  };
  return {
    assertion: await createOwnerAssertion(ownerKeySet, "owner-v1", context, now),
    assertionContext: context,
    command,
    bodySha256: "c".repeat(64),
    provenance: {
      eventName: "issue_comment.created",
      repository: "mohammadrezayaghoobi123-dev/Chat-gpt",
      issueNumber: 7,
      commentCreatedAt: now,
    },
    now,
  };
}

describe("OrchestratorLedger candidate synchronization", () => {
  it("backfills candidate rows idempotently when the schema initializer is rerun", async () => {
    const ledger = ledgerFor("claim-candidate-index-backfill");
    await createTask(ledger, "candidate-backfill", "agent:worker-1");
    await runInDurableObject(ledger, async (instance, state) => {
      state.storage.sql.exec("DELETE FROM orchestrator_claim_candidates");
      instance.ensureSchema();
      const rows = state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates",
      ).toArray();
      expect(rows).toEqual([
        { task_id: "candidate-backfill", executor_id: "agent:worker-1", created_at: now },
      ]);
      instance.ensureSchema();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_claim_candidates").one().count).toBe(1);
    });
  });

  it("removes a task from the candidate index atomically when it transitions out of claimable states", async () => {
    const ledger = ledgerFor("claim-candidate-index-transition-removal");
    await createTask(ledger, "candidate-transition", "agent:worker-1");
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000, now,
    });
    expect(lease).toMatchObject({ claimed: true, task: { taskId: "candidate-transition" } });
    const result = await ledger.transitionTask({
      taskId: "candidate-transition",
      expectedVersion: 1,
      expectedState: "SCHEDULED",
      nextState: "BLOCKED",
      actor: agent,
      evidence: transitionEvidence,
      now: now + 1,
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1,
      }),
      leaseGeneration: lease.leaseGeneration,
    });
    expect(result).toMatchObject({ updated: true, task: { state: "BLOCKED", version: 2 } });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-transition",
      ).one().count).toBe(0);
    });
  });

  it("removes a task from the candidate index atomically when an Owner command cancels it", async () => {
    const ledger = ledgerFor("claim-candidate-index-owner-cancel");
    await createTask(ledger, "candidate-owner-cancel", "agent:worker-1");
    const result = await ledger.executeOwnerCommand(await ownerCancelInput("candidate-owner-cancel"));
    expect(result).toMatchObject({
      applied: true, operation: "cancel",
      task: { taskId: "candidate-owner-cancel", state: "CANCELLED", version: 2 },
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-owner-cancel",
      ).one().count).toBe(0);
    });
  });
});


describe("OrchestratorLedger lease/index separation", () => {
  it("keeps the derived task candidate row stable across lease claim and release", async () => {
    const ledger = ledgerFor("claim-candidate-index-lease-separation");
    await createTask(ledger, "candidate-lease-stable", "agent:worker-1");
    const before = await runInDurableObject(ledger, async (_instance, state) =>
      state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-lease-stable",
      ).one(),
    );
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
      }),
      leaseMs: 30_000, now,
    });
    expect(lease).toMatchObject({ claimed: true });
    const released = await ledger.releaseLease({
      taskId: "candidate-lease-stable",
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 1,
      }),
      leaseGeneration: lease.leaseGeneration,
      now: now + 1,
    });
    expect(released).toMatchObject({ released: true });
    const after = await runInDurableObject(ledger, async (_instance, state) =>
      state.storage.sql.exec(
        "SELECT task_id, executor_id, created_at FROM orchestrator_claim_candidates WHERE task_id = ?",
        "candidate-lease-stable",
      ).one(),
    );
    expect(after).toEqual(before);
  });
});
