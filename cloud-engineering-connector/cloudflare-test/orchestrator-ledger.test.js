import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";
import { consumeOrchestratorDeadLetters, consumeOrchestratorOutbox, processOrchestratorOutbox } from "../worker.js";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}
const now = 1_800_000_000_000;
const task = (taskId = "task-0001") => ({
  taskId, state: "SCHEDULED", version: 1, agentRound: 0, createdAt: now, updatedAt: now,
  executorId: "agent:worker-1", commitSha: "a".repeat(40),
  objective: "bounded task",
});
const agent = { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" };
const authenticatedSender = { id: "agent:worker-1", authenticated: true, identityVerified: true };
const authenticatedWorker = (id, role = "agent") => ({ id, authenticated: true, identityVerified: true, role });
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
async function ensureAgentLease(ledger, { taskId = "task-0001", workerId = "agent:worker-1", now: at = now } = {}) {
  const existing = await runInDurableObject(ledger, async (_instance, state) => (
    state.storage.sql.exec(
      "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
      taskId,
    ).toArray()[0] ?? null
  ));
  if (existing && existing.worker_id === workerId && existing.lease_until > at) {
    return existing.lease_generation;
  }
  const claimed = await ledger.claimTask({
    workerId,
    workerAssertion: await claimAssertion(workerId, at),
    leaseMs: 30_000,
    now: at,
    taskId,
  });
  if (claimed?.claimed !== true) {
    throw new Error("Unable to establish test Agent lease: " + String(claimed?.reason ?? "unknown"));
  }
  return claimed.leaseGeneration;
}
const protocolEnvelope = (messageId, taskId, inputHash, payload, createdAt = now) => ({
  protocolVersion: 1, messageId, taskId, correlationId: "corr-0001",
  senderId: "agent:worker-1", recipientId: "agent:worker-2", type: "PROGRESS",
  createdAt, expiresAt: createdAt + 60_000,
  scopeRef: { repository: "owner/repo", baseBranch: "integration", targetBranch: "task/task-0001", allowedPaths: ["src/**"] },
  inputHash, evidenceRefs: [], payload,
});
const evidence = { kind: "test-evidence", reference: "ci://run/123" };

describe("OrchestratorLedger durable coordination contract", () => {
  it("initializes its own SQLite schema and reports the schema version", async () => {
    const ledger = ledgerFor("ledger-schema-ping");
    expect(await ledger.ping()).toEqual({ ok: true, schemaVersion: 5 });
    await runInDurableObject(ledger, async (instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "orchestrator_tasks", "orchestrator_processed_messages",
        "orchestrator_execution_leases", "orchestrator_outbox_events", "orchestrator_outbox_receipts", "orchestrator_audit_events",
        "orchestrator_consumed_assertions",
      ]));
      const outboxColumns = state.storage.sql.exec("PRAGMA table_info(orchestrator_outbox_events)").toArray().map(row => row.name);
      expect(outboxColumns).toEqual(expect.arrayContaining([
        "retry_state", "next_attempt_at", "last_error_code", "dead_lettered_at",
      ]));
    });
  });

  it("enforces durable business idempotency across distinct GitHub delivery IDs", async () => {
    const ledger = ledgerFor("ledger-github-business-idempotency");
    const common = {
      bodySha256: "a".repeat(64), eventName: "issues", receivedAt: now,
      idempotencyKey: "repo:123:issues:labeled:issue:42:actor:7",
      inputHash: "b".repeat(64),
    };
    const first = await ledger.claimGitHubDelivery({ ...common, deliveryId: "delivery-00000001" });
    const replay = await ledger.claimGitHubDelivery({ ...common, deliveryId: "delivery-00000002" });
    expect(first).toMatchObject({ claimed: true, replay: false });
    expect(replay).toMatchObject({ claimed: false, replay: true, reason: "BUSINESS_REPLAY" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_business_idempotency").one().count).toBe(1);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_webhook_deliveries").one().count).toBe(2);
    });
  });

  it("quarantines a different semantic payload under an existing GitHub business key", async () => {
    const ledger = ledgerFor("ledger-github-business-idempotency-conflict");
    const common = {
      bodySha256: "c".repeat(64), eventName: "issues", receivedAt: now,
      idempotencyKey: "repo:123:issues:labeled:issue:42:actor:7",
    };
    const first = await ledger.claimGitHubDelivery({
      ...common, deliveryId: "delivery-00000003", inputHash: "d".repeat(64),
    });
    const conflict = await ledger.claimGitHubDelivery({
      ...common, deliveryId: "delivery-00000004", inputHash: "e".repeat(64),
    });
    expect(first).toMatchObject({ claimed: true });
    expect(conflict).toMatchObject({ claimed: false, replay: false, conflict: true, reason: "BUSINESS_IDEMPOTENCY_CONFLICT" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_business_idempotency").one().count).toBe(1);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_webhook_deliveries").one().count).toBe(2);
    });
  });

  it("creates a task once and replays the original task for the same idempotency key and input hash", async () => {
    const ledger = ledgerFor("ledger-task-idempotency");
    const first = await createTask(ledger, { task: task(), idempotencyKey: "task-create-0001", inputHash: "b".repeat(64), now });
    const replay = await createTask(ledger, { task: task(), idempotencyKey: "task-create-0001", inputHash: "b".repeat(64), now: now + 1 });
    expect(first).toMatchObject({ created: true, task: { taskId: "task-0001", version: 1 } });
    expect(replay).toMatchObject({ created: false, replay: true, task: { taskId: "task-0001", version: 1 } });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(1);
    });
  });

  it("rejects idempotency-key reuse with a different input hash without changing the original task", async () => {
    const ledger = ledgerFor("ledger-task-idempotency-conflict");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0002", inputHash: "c".repeat(64), now });
    await expect(createTask(ledger, {
      task: { ...task(), objective: "different" }, idempotencyKey: "task-create-0002", inputHash: "d".repeat(64), now: now + 1,
    })).resolves.toMatchObject({ created: false, conflict: true, reason: "IDEMPOTENCY_CONFLICT" });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ objective: "bounded task", version: 1 });
  });

  it("allows at most one concurrent task lease claimant", async () => {
    const ledger = ledgerFor("ledger-concurrent-claim");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0003", inputHash: "e".repeat(64), now });
    const results = await Promise.all([
      ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"), leaseMs: 30_000, now }),
      ledger.claimTask({ workerId: "agent:worker-2", workerAssertion: await claimAssertion("agent:worker-2"), leaseMs: 30_000, now }),
    ]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.filter(result => !result.claimed)).toHaveLength(1);
    expect(results.find(result => result.claimed).leaseGeneration).toBe(1);
  });

  it("rejects stale lease generations on renew, release, and worker-driven state transitions", async () => {
    const ledger = ledgerFor("ledger-stale-fence");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0004", inputHash: "f".repeat(64), now });
    const first = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1"),
      leaseMs: 100,
      now,
    });
    await expect(ledger.releaseLease({
      taskId: "task-0001",
      workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 1,
      }),
      leaseGeneration: first.leaseGeneration,
      now: now + 1,
    })).resolves.toMatchObject({ released: true });

    const reclaimed = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now + 2),
      leaseMs: 100,
      now: now + 2,
    });
    expect(reclaimed.leaseGeneration).toBe(2);
    await expect(ledger.renewLease({
      taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "renewLease", nowMs: now + 3 }), leaseGeneration: first.leaseGeneration, leaseMs: 100, now: now + 3,
    })).resolves.toMatchObject({ renewed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.releaseLease({
      taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 3 }), leaseGeneration: first.leaseGeneration, now: now + 3,
    })).resolves.toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 3, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 3 }), leaseGeneration: first.leaseGeneration,
    })).resolves.toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
  });

  it("rejects stale task version or expected-state compare-and-set writes", async () => {
    const ledger = ledgerFor("ledger-task-cas");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0005", inputHash: "1".repeat(64), now });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 2, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: { id: "owner:one", authenticated: true, identityVerified: true, role: "owner" }, evidence, now: now + 1, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1 }),
    })).resolves.toMatchObject({ updated: false, reason: "VERSION_OR_STATE_CONFLICT" });
  });

  it("deduplicates repeated messages and rejects the same message ID with a different input hash", async () => {
    const ledger = ledgerFor("ledger-message-dedup");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0006", inputHash: "2".repeat(64), now });
    const input = { messageId: "msg-0001", taskId: "task-0001", inputHash: "3".repeat(64), envelope: protocolEnvelope("msg-0001", "task-0001", "3".repeat(64), { step: 1 }), workerId: "agent:worker-1", leaseGeneration: await ensureAgentLease(ledger), workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }), now };
    expect(await ledger.recordMessage(input)).toMatchObject({ accepted: true });
    expect(await ledger.recordMessage({ ...input, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }) })).toMatchObject({ accepted: false, replay: true });
    await expect(ledger.recordMessage({ ...input, workerAssertion: undefined }))
      .resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
    const changedHash = "4".repeat(64);
    const changedEnvelope = protocolEnvelope("msg-0001", "task-0001", changedHash, { step: 1 });
    expect(await ledger.recordMessage({ ...input, inputHash: changedHash, envelope: changedEnvelope, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }) }))
      .toMatchObject({ accepted: false, conflict: true });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages").one().count).toBe(1);
    });
  });

  it("commits a task transition and its outbox intent atomically", async () => {
    const ledger = ledgerFor("ledger-transition-outbox-atomic");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0007", inputHash: "5".repeat(64), now });
    const lease = await ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"), leaseMs: 30_000, now });
    expect(lease).toMatchObject({ claimed: true, leaseGeneration: 1 });
    const result = await ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 1, workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1 }), leaseGeneration: lease.leaseGeneration,
      outboxEvent: {
        eventId: "event-transition-1", idempotencyKey: "task-running-1", eventType: "task.running",
        payload: { taskId: "task-0001", version: 2 },
      },
    });
    expect(result).toMatchObject({ updated: true, task: { state: "RUNNING", version: 2 }, outbox: { enqueued: true } });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT state, version FROM orchestrator_tasks WHERE task_id='task-0001'").one())
        .toMatchObject({ state: "RUNNING", version: 2 });
      expect(state.storage.sql.exec("SELECT status FROM orchestrator_outbox_events WHERE event_id='event-transition-1'").one())
        .toMatchObject({ status: "PENDING" });
    });
  });

  it("makes outbox enqueue idempotent and detects changed payload conflicts", async () => {
    const ledger = ledgerFor("ledger-outbox-idempotency");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0008", inputHash: "6".repeat(64), now });
    const input = {
      eventId: "event-0001", idempotencyKey: "outbox-key-0001", taskId: "task-0001",
      eventType: "task.created", payload: { taskId: "task-0001" }, workerId: "agent:worker-1", leaseGeneration: await ensureAgentLease(ledger), now,
    };
    expect(await ledger.enqueueOutbox({ ...input, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }) })).toMatchObject({ enqueued: true });
    expect(await ledger.enqueueOutbox({ ...input, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }) })).toMatchObject({ enqueued: false, replay: true });
    expect(await ledger.enqueueOutbox({ ...input, payload: { taskId: "task-0001", changed: true }, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }) }))
      .toMatchObject({ enqueued: false, conflict: true });
  });

  it("uses monotonically increasing outbox fencing generations and rejects stale completion", async () => {
    const ledger = ledgerFor("ledger-outbox-fencing");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0009", inputHash: "7".repeat(64), now });
    await ledger.enqueueOutbox({
      eventId: "event-0002", idempotencyKey: "outbox-key-0002", taskId: "task-0001",
      eventType: "task.created", payload: { taskId: "task-0001" }, workerId: "agent:worker-1", leaseGeneration: await ensureAgentLease(ledger), workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }), now,
    });
    await expect(ledger.claimOutbox({ workerId: "publisher-1", leaseMs: 100, now }))
      .resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
    const first = await ledger.claimOutbox({ workerId: "publisher-1", workerAssertion: await createWorkerAssertion({ subject: "publisher-1", role: "publisher", operation: "claimOutbox", nowMs: now }), leaseMs: 100, now });
    const second = await ledger.claimOutbox({ workerId: "publisher-2", workerAssertion: await createWorkerAssertion({ subject: "publisher-2", role: "publisher", operation: "claimOutbox", nowMs: now + 101 }), leaseMs: 100, now: now + 101 });
    expect(second.leaseGeneration).toBe(first.leaseGeneration + 1);
    await expect(ledger.completeOutbox({ eventId: "event-0002", workerId: "publisher-1", workerAssertion: await createWorkerAssertion({ subject: "publisher-1", role: "publisher", operation: "completeOutbox", nowMs: now + 102 }), leaseGeneration: first.leaseGeneration, now: now + 102 }))
      .resolves.toMatchObject({ completed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.completeOutbox({ eventId: "event-0002", workerId: "publisher-2", workerAssertion: await createWorkerAssertion({ subject: "publisher-2", role: "publisher", operation: "completeOutbox", nowMs: now + 103 }), leaseGeneration: second.leaseGeneration, now: now + 103 }))
      .resolves.toMatchObject({ completed: true });
  });

  it("schedules bounded outbox retries and dead-letters permanent failures", async () => {
    const ledger = ledgerFor("ledger-outbox-retry-dead-letter");
    await createTask(ledger, {
      task: task(), idempotencyKey: "task-create-outbox-retry", inputHash: "9".repeat(64), now,
    });
    await ledger.enqueueOutbox({
      eventId: "event-outbox-retry", idempotencyKey: "outbox-retry-key",
      taskId: "task-0001", eventType: "task.created", payload: { taskId: "task-0001" },
      workerId: "agent:worker-1",
      leaseGeneration: await ensureAgentLease(ledger),
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now,
      }),
      now,
    });
    const first = await ledger.claimOutbox({
      workerId: "publisher-1",
      workerAssertion: await createWorkerAssertion({
        subject: "publisher-1", role: "publisher", operation: "claimOutbox", nowMs: now,
      }),
      leaseMs: 30_000, now,
    });
    const failed = await ledger.failOutbox({
      eventId: "event-outbox-retry", workerId: "publisher-1",
      workerAssertion: await createWorkerAssertion({
        subject: "publisher-1", role: "publisher", operation: "failOutbox", nowMs: now + 1,
      }),
      leaseGeneration: first.leaseGeneration, retryable: true,
      errorCode: "UPSTREAM_TIMEOUT", now: now + 1,
    });
    expect(failed).toMatchObject({
      failed: true, retryScheduled: true, deadLettered: false,
      nextAttemptAt: now + 1_001,
    });
    await expect(ledger.claimOutbox({
      workerId: "publisher-2",
      workerAssertion: await createWorkerAssertion({
        subject: "publisher-2", role: "publisher", operation: "claimOutbox", nowMs: now + 500,
      }),
      leaseMs: 30_000, now: now + 500,
    })).resolves.toMatchObject({ claimed: false, reason: "NO_OUTBOX_AVAILABLE" });

    const retry = await ledger.claimOutbox({
      workerId: "publisher-2",
      workerAssertion: await createWorkerAssertion({
        subject: "publisher-2", role: "publisher", operation: "claimOutbox", nowMs: now + 1_001,
      }),
      leaseMs: 30_000, now: now + 1_001,
    });
    expect(retry).toMatchObject({ claimed: true, event: { attempts: 2 } });
    const deadLetter = await ledger.failOutbox({
      eventId: "event-outbox-retry", workerId: "publisher-2",
      workerAssertion: await createWorkerAssertion({
        subject: "publisher-2", role: "publisher", operation: "failOutbox", nowMs: now + 1_002,
      }),
      leaseGeneration: retry.leaseGeneration, retryable: false,
      errorCode: "UPSTREAM_REJECTED", now: now + 1_002,
    });
    expect(deadLetter).toMatchObject({ failed: true, retryScheduled: false, deadLettered: true });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT retry_state, last_error_code, dead_lettered_at FROM orchestrator_outbox_events WHERE event_id = ?",
        "event-outbox-retry",
      ).one()).toMatchObject({
        retry_state: "DEAD_LETTER",
        last_error_code: "UPSTREAM_REJECTED",
        dead_lettered_at: now + 1_002,
      });
    });
  });

  it("appends immutable hash-linked audit events and rejects event ID rebinding", async () => {
    const ledger = ledgerFor("ledger-audit-chain");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0010", inputHash: "8".repeat(64), now });
    const input = {
      eventId: "audit-0001", taskId: "task-0001", actor: agent, workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "appendAuditEvent", nowMs: now }),
      eventType: "task.created", details: { version: 1 }, now,
    };
    const first = await ledger.appendAuditEvent(input);
    const replay = await ledger.appendAuditEvent({ ...input, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "appendAuditEvent", nowMs: now }) });
    const second = await ledger.appendAuditEvent({ ...input, eventId: "audit-0002", eventType: "task.scheduled", now: now + 1, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "appendAuditEvent", nowMs: now + 1 }) });
    expect(first).toMatchObject({
      appended: true,
      event: { eventId: "audit-0001", actorId: "agent:worker-1", actorRole: "agent", previousHash: null },
    });
    expect(replay).toMatchObject({ appended: false, replay: true, event: { actorRole: "agent" } });
    expect(second.event.previousHash).toBe(first.event.eventHash);
    await runInDurableObject(ledger, async instance => {
      await expect(instance.appendAuditEvent({
        ...input, actor: { ...agent, identityVerified: false }, workerAssertion: undefined,
      })).resolves.toMatchObject({ appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" });
    });
    await expect(ledger.appendAuditEvent({ ...input, details: { version: 99 }, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "appendAuditEvent", nowMs: now }) }))
      .resolves.toMatchObject({ appended: false, conflict: true });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(2);
      expect(state.storage.sql.exec("SELECT actor_id, actor_role FROM orchestrator_audit_events WHERE event_id='audit-0001'").one())
        .toMatchObject({ actor_id: "agent:worker-1", actor_role: "agent" });
    });
  });

  it("one hundred duplicate deliveries produce exactly one effective message record", async () => {
    const ledger = ledgerFor("ledger-message-100-duplicates");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0011", inputHash: "9".repeat(64), now });
    const input = {
      messageId: "msg-100-duplicates", taskId: "task-0001", inputHash: "a".repeat(64),
      envelope: protocolEnvelope("msg-100-duplicates", "task-0001", "a".repeat(64), { accepted: true }), workerId: "agent:worker-1", leaseGeneration: await ensureAgentLease(ledger), now,
    };
    const results = await Promise.all(Array.from({ length: 100 }, async () => ledger.recordMessage({ ...input, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }) })));
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.filter(result => result.replay)).toHaveLength(99);
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id='msg-100-duplicates'").one().count).toBe(1);
    });
  });

  it("fails closed on expired lease recovery and consumes the signed assertion exactly once", async () => {
    const ledger = ledgerFor("ledger-expired-lease-reconciliation-single-use");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0012", inputHash: "b".repeat(64), now });
    const first = await ledger.claimTask({
      workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
      leaseMs: 100, now,
    });
    const reconciliationJti = "jti-forged-lease-recovery-single-use-0001";
    const reconciliationAssertion = await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "claimTask",
      nowMs: now + 101, jti: reconciliationJti,
    });
    await expect(ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: reconciliationAssertion,
      leaseMs: 100, now: now + 101,
      reconciliationEvidence: {
        checked: true, priorGeneration: first.leaseGeneration,
        evidenceRef: "github://audit/reconcile/12",
      },
    })).resolves.toMatchObject({ claimed: false, reason: "RECONCILIATION_REQUIRED" });

    // A rejected, but cryptographically valid, one-time assertion cannot be replayed.
    await expect(ledger.claimTask({
      workerId: "agent:worker-1", workerAssertion: reconciliationAssertion,
      leaseMs: 100, now: now + 101,
      reconciliationEvidence: {
        checked: true, priorGeneration: first.leaseGeneration,
        evidenceRef: "github://audit/reconcile/12",
      },
    })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        "task-0001",
      ).one()).toMatchObject({
        worker_id: "agent:worker-1", lease_generation: 1, lease_until: now + 100,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        reconciliationJti,
      ).one().count).toBe(1);
    });
    await expect(ledger.getTask({ taskId: "task-0001" }))
      .resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });

  it("refuses to persist a protocol message without a verified authenticated sender context", async () => {
    const ledger = ledgerFor("ledger-message-authentication");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-auth-message", inputHash: "c".repeat(64), now });
    const envelope = protocolEnvelope("msg-auth-required", "task-0001", "d".repeat(64), { step: 1 });
    await expect(ledger.recordMessage({
      messageId: "msg-auth-required", taskId: "task-0001", inputHash: "d".repeat(64), envelope, now,
    })).resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
    await expect(ledger.recordMessage({
      messageId: "msg-auth-required", taskId: "task-0001", inputHash: "d".repeat(64), envelope,
      workerId: "agent:worker-1", authenticatedSender: { id: "agent:worker-1", authenticated: true, identityVerified: true }, now,
    })).resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
  });

  it("authenticates a message sender before inspecting an untrusted protocol envelope", async () => {
    const ledger = ledgerFor("ledger-message-auth-before-inspection");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-message-auth-order", inputHash: "b".repeat(64), now });
    const envelope = protocolEnvelope("msg-auth-order-0001", "task-0001", "c".repeat(64), {
      apiKey: "must-not-be-inspected-before-authentication",
    });

    const result = await ledger.recordMessage({
      messageId: "msg-auth-order-0001",
      taskId: "task-0001",
      inputHash: "c".repeat(64),
      envelope,
      workerId: "agent:worker-1",
      workerAssertion: null,
      now,
    });
    expect(result).toEqual({
      accepted: false,
      reason: "AUTHENTICATED_SENDER_REQUIRED",
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
        "msg-auth-order-0001",
      ).one().count).toBe(0);
    });
  });

  it("consumes the assertion and returns a bounded rejection for an oversized message envelope", async () => {
    const ledger = ledgerFor("ledger-message-oversized-envelope-rejection");
    await createTask(ledger, {
      task: task(), idempotencyKey: "task-create-oversized-envelope", inputHash: "b".repeat(64), now,
    });
    const input = {
      messageId: "msg-oversized-envelope-0001",
      taskId: "task-0001",
      inputHash: "c".repeat(64),
    };
    const envelope = protocolEnvelope(input.messageId, input.taskId, input.inputHash, { step: 1 });
    envelope.untrustedExtension = "x".repeat(33_000);
    const workerAssertion = await createWorkerAssertion({
      subject: "agent:worker-1",
      role: "agent",
      operation: "recordMessage",
      nowMs: now,
      jti: "jti-message-oversized-envelope-0001",
    });

    await expect(ledger.recordMessage({
      ...input, envelope, workerId: "agent:worker-1", workerAssertion, now,
    })).resolves.toEqual({
      accepted: false,
      reason: "RECORD_TOO_LARGE",
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        "jti-message-oversized-envelope-0001",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
        input.messageId,
      ).one().count).toBe(0);
    });
  });

it("requires verified worker identities before task or outbox lease side effects", async () => {
    const ledger = ledgerFor("ledger-worker-authentication");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-worker-auth", inputHash: "c".repeat(64), now });
    await expect(ledger.claimTask({ workerId: "agent:worker-1", leaseMs: 30_000, now }))
      .resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
    await expect(ledger.claimTask({
      workerId: "agent:worker-1", authenticatedWorker: { id: "agent:worker-1", authenticated: true, identityVerified: false, role: "agent" },
      leaseMs: 30_000, now,
    })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  });

  it("persists the four-round ceiling so retries cannot reset agent coordination rounds", async () => {
    const ledger = ledgerFor("ledger-agent-round-limit");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-agent-rounds", inputHash: "c".repeat(64), now });
    const lease = await ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"), leaseMs: 30_000, now });
    let version = 1;
    for (let round = 1; round <= 4; round += 1) {
      const result = await ledger.advanceAgentRound({
        taskId: "task-0001", expectedVersion: version, expectedRound: round - 1,
        nextRound: round, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "advanceAgentRound", nowMs: now + round }), leaseGeneration: lease.leaseGeneration, now: now + round,
      });
      expect(result).toMatchObject({ advanced: true, task: { agentRound: round, version: version + 1 } });
      version += 1;
    }
    await expect(ledger.advanceAgentRound({
      taskId: "task-0001", expectedVersion: version, expectedRound: 4,
      nextRound: 5, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "advanceAgentRound", nowMs: now + 5 }), leaseGeneration: lease.leaseGeneration, now: now + 5,
    })).resolves.toMatchObject({ advanced: false, reason: "AGENT_ROUND_LIMIT" });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ agentRound: 4, version: 5 });
  });

  it("rejects a message whose envelope identifiers do not match the durable deduplication key", async () => {
    const ledger = ledgerFor("ledger-message-envelope-binding");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-envelope-binding", inputHash: "f".repeat(64), now });
    const result = await ledger.recordMessage({
      messageId: "msg-indexed-as-one", taskId: "task-0001", inputHash: "a".repeat(64),
      envelope: protocolEnvelope("msg-claimed-as-two", "task-0001", "a".repeat(64), {}), workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }), now,
    });
    expect(result).toMatchObject({ accepted: false, reason: "MESSAGE_ENVELOPE_MISMATCH" });
  });

  it("does not allow an unassigned worker identity to claim a task assigned to another executor", async () => {
    const ledger = ledgerFor("ledger-assignee-enforcement");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-assignee", inputHash: "b".repeat(64), now });
    await expect(ledger.claimTask({ workerId: "agent:unassigned", workerAssertion: await claimAssertion("agent:unassigned"), leaseMs: 30_000, now }))
      .resolves.toMatchObject({ claimed: false, reason: "ASSIGNEE_MISMATCH" });
    await expect(ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"), leaseMs: 30_000, now }))
      .resolves.toMatchObject({ claimed: true, leaseGeneration: 1 });
  });

  it("consumes a createTask assertion when the authenticated task payload is rejected", async () => {
    const ledger = ledgerFor("ledger-create-task-sensitive-assertion-consumption");
    const assertion = await createWorkerAssertion({
      subject: "orchestrator-scheduler", role: "system", operation: "createTask",
      nowMs: now, jti: "jti-create-task-sensitive-000001",
    });
    const rejected = await ledger.createTask({
      task: { ...task(), apiKey: "must-not-be-persisted" },
      idempotencyKey: "a",
      inputHash: "a".repeat(64),
      now,
      workerId: "orchestrator-scheduler",
      workerAssertion: assertion,
    });
    expect(rejected).toEqual({ created: false, reason: "SENSITIVE_FIELD_REJECTED" });

    await expect(ledger.createTask({
      task: task(),
      idempotencyKey: "create-task-sensitive-001",
      inputHash: "a".repeat(64),
      now,
      workerId: "orchestrator-scheduler",
      workerAssertion: assertion,
    })).resolves.toEqual({ created: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        "jti-create-task-sensitive-000001",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_tasks WHERE task_id = ?",
        "task-0001",
      ).one().count).toBe(0);
    });
  });

  it("consumes a transitionTask assertion when its authenticated outbox payload is rejected", async () => {
    const ledger = ledgerFor("ledger-transition-outbox-sensitive-assertion-consumption");
    await createTask(ledger, {
      task: task(), idempotencyKey: "b", inputHash: "b".repeat(64), now,
    });
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
      leaseMs: 30_000, now,
    });
    const assertion = await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "transitionTask",
      nowMs: now + 1, jti: "jti-transition-outbox-sensitive-0001",
    });
    const input = {
      taskId: "task-0001",
      expectedVersion: 1,
      expectedState: "SCHEDULED",
      nextState: "RUNNING",
      actor: agent,
      evidence,
      now: now + 1,
      workerId: "agent:worker-1",
      workerAssertion: assertion,
      leaseGeneration: lease.leaseGeneration,
      outboxEvent: {
        eventId: "evt-transition-sensitive-0001",
        idempotencyKey: "b",
        eventType: "task.running",
        payload: { taskId: "task-0001", apiKey: "must-not-persist" },
      },
    };

    await expect(ledger.transitionTask(input)).resolves.toEqual({
      updated: false, reason: "SENSITIVE_FIELD_REJECTED",
    });
    await expect(ledger.transitionTask({
      ...input,
      outboxEvent: {
        eventId: "evt-transition-sensitive-0001",
        idempotencyKey: "idem-transition-sensitive-0001",
        eventType: "task.running",
        payload: { taskId: "task-0001" },
      },
    })).resolves.toEqual({
      updated: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        "jti-transition-outbox-sensitive-0001",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT state, version FROM orchestrator_tasks WHERE task_id = ?",
        "task-0001",
      ).one()).toMatchObject({ state: "SCHEDULED", version: 1 });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
        "evt-transition-sensitive-0001",
      ).one().count).toBe(0);
    });
  });

  it("consumes an appendAuditEvent assertion when authenticated audit details are rejected", async () => {
    const ledger = ledgerFor("ledger-audit-sensitive-assertion-consumption");
    await createTask(ledger, {
      task: task(), idempotencyKey: "c", inputHash: "c".repeat(64), now,
    });
    const assertion = await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "appendAuditEvent",
      nowMs: now, jti: "jti-audit-sensitive-000001",
    });
    const input = {
      eventId: "audit-sensitive-0001",
      taskId: "missing-task-0001",
      actor: agent,
      workerId: "agent:worker-1",
      workerAssertion: assertion,
      eventType: "task.created",
      details: { apiKey: "must-not-persist" },
      now,
    };

    await expect(ledger.appendAuditEvent(input)).resolves.toEqual({
      appended: false, reason: "SENSITIVE_FIELD_REJECTED",
    });
    await expect(ledger.appendAuditEvent({
      ...input, taskId: "task-0001", details: { safe: true },
    })).resolves.toEqual({
      appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED",
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        "jti-audit-sensitive-000001",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE event_id = ?",
        "audit-sensitive-0001",
      ).one().count).toBe(0);
    });
  });

  it("rejects secret-bearing fields and never creates or writes KnowledgeStore tables", async () => {
    const ledger = ledgerFor("ledger-secret-isolation");
    await expect(createTask(ledger, {
      task: { ...task(), apiKey: "must-not-persist" }, idempotencyKey: "task-secret-0001", inputHash: "c".repeat(64), now,
    })).resolves.toEqual({ created: false, reason: "SENSITIVE_FIELD_REJECTED" });
    await createTask(ledger, { task: task(), idempotencyKey: "task-safe-0001", inputHash: "d".repeat(64), now });
    const unauthenticatedMessage = await ledger.recordMessage({
      messageId: "msg-secret-0001", taskId: "task-0001", inputHash: "e".repeat(64),
      envelope: { token: "must-not-persist" }, workerId: "agent:worker-1",
      workerAssertion: null, now,
    });
    expect(unauthenticatedMessage).toEqual({
      accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED",
    });
    const authenticatedMessageAssertion = await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now,
    });
    const authenticatedMessageResult = await ledger.recordMessage({
      messageId: "msg-secret-0001", taskId: "task-0001", inputHash: "e".repeat(64),
      envelope: { token: "must-not-persist" }, workerId: "agent:worker-1",
      workerAssertion: authenticatedMessageAssertion, now,
    });
    expect(authenticatedMessageResult).toEqual({
      accepted: false, reason: "SENSITIVE_FIELD_REJECTED",
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
        "msg-secret-0001",
      ).one().count).toBe(0);
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
      expect(tables.some(name => name.startsWith("knowledge_"))).toBe(false);
      expect(tables).toEqual(expect.arrayContaining([
        "orchestrator_tasks", "orchestrator_processed_messages",
        "orchestrator_execution_leases", "orchestrator_outbox_events", "orchestrator_audit_events",
      ]));
    });
  });
});


  it("requires a live task lease for every state transition regardless of caller-declared actor role", async () => {
    const ledger = ledgerFor("ledger-transition-role-bypass");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-role-bypass", inputHash: "e".repeat(64), now });

    const ownerBypass = await ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: { id: "owner:one", authenticated: true, identityVerified: true, role: "owner" },
      evidence, now: now + 1, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1 }),
    });
    expect(ownerBypass).toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });

    const agentWithoutLease = await ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 1, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1 }),
    });
    expect(agentWithoutLease).toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });


it("rejects a caller-forged legacy worker identity before creating a lease", async () => {
  const ledger = ledgerFor("ledger-forged-legacy-worker-identity");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-forged-identity", inputHash: "a".repeat(64), now });
  const forged = { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" };
  await expect(ledger.claimTask({
    workerId: "agent:worker-1", authenticatedWorker: forged, leaseMs: 30_000, now,
  })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_execution_leases").one().count).toBe(0);
  });
});


it("accepts one signed claim assertion once and atomically rejects its replay", async () => {
  const ledger = ledgerFor("ledger-claim-assertion-replay");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-assertion-replay", inputHash: "b".repeat(64), now });
  const assertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "claimTask",
    nowMs: now, jti: "jti-claim-once-000000000001",
  });
  const first = await ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: assertion, leaseMs: 30_000, now });
  expect(first).toMatchObject({ claimed: true, leaseGeneration: 1 });
  await expect(ledger.releaseLease({
    taskId: "task-0001", workerId: "agent:worker-1",
    workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 1 }),
    leaseGeneration: first.leaseGeneration, now: now + 1,
  })).resolves.toMatchObject({ released: true });
  await expect(ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: assertion, leaseMs: 30_000, now: now + 2,
  })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT worker_id, lease_generation FROM orchestrator_execution_leases WHERE task_id='task-0001'").one())
      .toMatchObject({ worker_id: null, lease_generation: 1 });
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti='jti-claim-once-000000000001'").one().count).toBe(1);
  });
});

it("rejects a signed assertion bound to another operation or a modified MAC", async () => {
  const ledger = ledgerFor("ledger-claim-assertion-binding");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-assertion-binding", inputHash: "c".repeat(64), now });
  const wrongOperation = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now,
  });
  const valid = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
  });
  const modifiedParts = valid.split(".");
  modifiedParts[3] = (modifiedParts[3][0] === "A" ? "B" : "A") + modifiedParts[3].slice(1);
  const modified = modifiedParts.join(".");
  for (const workerAssertion of [wrongOperation, modified]) {
    await expect(ledger.claimTask({
      workerId: "agent:worker-1", workerAssertion, leaseMs: 30_000, now,
    })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  }
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_execution_leases").one().count).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count).toBe(1);
  });
});


it("rejects legacy boolean identity for lease release without mutating lease state", async () => {
  const ledger = ledgerFor("ledger-release-forged-identity");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-release-forged", inputHash: "d".repeat(64), now });
  const claimed = await ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
    leaseMs: 30_000, now,
  });
  await expect(ledger.releaseLease({
    taskId: "task-0001", workerId: "agent:worker-1",
    authenticatedWorker: authenticatedWorker("agent:worker-1"),
    leaseGeneration: claimed.leaseGeneration, now: now + 1,
  })).resolves.toMatchObject({ released: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT worker_id, lease_generation FROM orchestrator_execution_leases WHERE task_id='task-0001'").one())
      .toMatchObject({ worker_id: "agent:worker-1", lease_generation: 1 });
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count).toBe(2);
  });
});


it("consumes a signed lease-renewal assertion once and rejects replay", async () => {
  const ledger = ledgerFor("ledger-renew-assertion-replay");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-renew-replay", inputHash: "e".repeat(64), now });
  const claimed = await ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
    leaseMs: 30_000, now,
  });
  const assertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "renewLease", nowMs: now + 1,
    jti: "jti-renew-once-000000000001",
  });
  const renewed = await ledger.renewLease({
    taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: assertion,
    leaseGeneration: claimed.leaseGeneration, leaseMs: 60_000, now: now + 1,
  });
  expect(renewed).toMatchObject({ renewed: true, leaseUntil: now + 1 + 60_000 });
  await expect(ledger.renewLease({
    taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: assertion,
    leaseGeneration: claimed.leaseGeneration, leaseMs: 90_000, now: now + 2,
  })).resolves.toMatchObject({ renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT lease_until FROM orchestrator_execution_leases WHERE task_id='task-0001'").one().lease_until)
      .toBe(now + 1 + 60_000);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti='jti-renew-once-000000000001'").one().count).toBe(1);
  });
});

it("rejects caller-supplied boolean identity for lease renewal", async () => {
  const ledger = ledgerFor("ledger-renew-forged-identity");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-renew-forged", inputHash: "f".repeat(64), now });
  const claimed = await ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
    leaseMs: 30_000, now,
  });
  await expect(ledger.renewLease({
    taskId: "task-0001", workerId: "agent:worker-1",
    authenticatedWorker: authenticatedWorker("agent:worker-1"),
    leaseGeneration: claimed.leaseGeneration, leaseMs: 60_000, now: now + 1,
  })).resolves.toMatchObject({ renewed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT lease_until FROM orchestrator_execution_leases WHERE task_id='task-0001'").one().lease_until)
      .toBe(now + 30_000);
  });
});


it("rejects legacy boolean identity for agent-round mutation", async () => {
  const ledger = ledgerFor("ledger-agent-round-forged-identity");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-round-forged", inputHash: "9".repeat(64), now });
  const lease = await ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
    leaseMs: 30_000, now,
  });
  await expect(ledger.advanceAgentRound({
    taskId: "task-0001", expectedVersion: 1, expectedRound: 0, nextRound: 1,
    workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"),
    leaseGeneration: lease.leaseGeneration, now: now + 1,
  })).resolves.toMatchObject({ advanced: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ agentRound: 0, version: 1 });
});


it("rejects legacy boolean identity for state transitions even with a live lease", async () => {
  const ledger = ledgerFor("ledger-transition-forged-identity");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-transition-forged", inputHash: "8".repeat(64), now });
  const lease = await ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
    leaseMs: 30_000, now,
  });
  await expect(ledger.transitionTask({
    taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
    actor: agent, evidence, now: now + 1, workerId: "agent:worker-1",
    authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseGeneration: lease.leaseGeneration,
  })).resolves.toMatchObject({ updated: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
});


it("rejects caller-forged publisher booleans before claiming an outbox event", async () => {
  const ledger = ledgerFor("ledger-outbox-forged-publisher");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-outbox-forged", inputHash: "7".repeat(64), now });
  await ledger.enqueueOutbox({
    eventId: "event-forged-publisher", idempotencyKey: "outbox-forged-publisher",
    taskId: "task-0001", eventType: "task.created", payload: { taskId: "task-0001" }, workerId: "agent:worker-1", leaseGeneration: await ensureAgentLease(ledger), workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }), now,
  });
  await expect(ledger.claimOutbox({
    workerId: "publisher-1", authenticatedWorker: authenticatedWorker("publisher-1", "publisher"),
    leaseMs: 30_000, now,
  })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT status, attempts FROM orchestrator_outbox_events WHERE event_id='event-forged-publisher'").one())
      .toMatchObject({ status: "PENDING", attempts: 0 });
  });
});

it("rejects legacy boolean sender identity for message intake without persisting data", async () => {
  const ledger = ledgerFor("ledger-message-forged-sender");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-message-forged", inputHash: "6".repeat(64), now });
  const envelope = protocolEnvelope("msg-forged-sender", "task-0001", "b".repeat(64), { forged: true });
  await expect(ledger.recordMessage({
    messageId: "msg-forged-sender", taskId: "task-0001", inputHash: "b".repeat(64), envelope,
    workerId: "agent:worker-1", authenticatedSender: authenticatedSender, now,
  })).resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages").one().count).toBe(0);
  });
});

it("rejects legacy caller-supplied actor booleans for audit append", async () => {
  const ledger = ledgerFor("ledger-audit-forged-actor");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-audit-forged", inputHash: "5".repeat(64), now });
  await expect(ledger.appendAuditEvent({
    eventId: "audit-forged-actor", taskId: "task-0001",
    actor: { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" },
    eventType: "task.created", details: { forged: true }, now,
  })).resolves.toMatchObject({ appended: false, reason: "AUTHENTICATED_ACTOR_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
  });
});

it("rejects unauthenticated direct outbox enqueue", async () => {
  const ledger = ledgerFor("ledger-outbox-forged-enqueue");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-outbox-enqueue-forged", inputHash: "4".repeat(64), now });
  await expect(ledger.enqueueOutbox({
    eventId: "event-unauth-enqueue", idempotencyKey: "outbox-unauth-enqueue",
    taskId: "task-0001", eventType: "task.created", payload: { taskId: "task-0001" }, now,
  })).resolves.toMatchObject({ enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
  });
});

it("authenticates an outbox writer before inspecting an untrusted event payload", async () => {
  const ledger = ledgerFor("ledger-outbox-auth-before-inspection");
  const result = await ledger.enqueueOutbox({
    eventId: "evt-outbox-auth-order-0001",
    idempotencyKey: "idem-outbox-auth-order-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { apiKey: "must-not-be-inspected-before-authentication" },
    workerId: "agent:worker-1",
    workerAssertion: null,
    now,
  });
  expect(result).toEqual({
    enqueued: false,
    reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  const authenticatedPayloadAssertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now,
  });
  const authenticatedResult = await ledger.enqueueOutbox({
    eventId: "evt-outbox-auth-order-authenticated-0001",
    idempotencyKey: "idem-outbox-auth-order-authenticated-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { apiKey: "must-still-be-rejected-after-authentication" },
    workerId: "agent:worker-1",
    workerAssertion: authenticatedPayloadAssertion,
    now,
  });
  expect(authenticatedResult).toEqual({
    enqueued: false,
    reason: "SENSITIVE_FIELD_REJECTED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id IN (?, ?)",
      "evt-outbox-auth-order-0001",
      "evt-outbox-auth-order-authenticated-0001",
    ).one().count).toBe(0);
  });
});


it("rejects unauthenticated and caller-forged task creation", async () => {
  const ledger = ledgerFor("ledger-create-task-forged");
  await expect(ledger.createTask({
    task: task(), idempotencyKey: "task-create-forged", inputHash: "3".repeat(64), now,
    workerId: "orchestrator-scheduler",
    authenticatedWorker: { id: "orchestrator-scheduler", authenticated: true, identityVerified: true, role: "system" },
  })).resolves.toMatchObject({ created: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(0);
  });
});

it("prunes consumed assertion IDs only after expiry plus the retention margin", async () => {
  const ledger = ledgerFor("ledger-assertion-retention");
  await createTask(ledger, { task: task(), idempotencyKey: "task-create-retention-1", inputHash: "2".repeat(64), now });
  const assertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "claimTask", nowMs: now,
    jti: "jti-claim-retention-000000000001",
  });
  await ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: assertion, leaseMs: 30_000, now });
  const later = now + 12 * 60 * 1000;
  await createTask(ledger, { task: task("task-0002"), idempotencyKey: "task-create-retention-2", inputHash: "3".repeat(64), now: later });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti='jti-claim-retention-000000000001'").one().count).toBe(0);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions").one().count).toBe(1);
  });
});


it("moves an expired final-attempt outbox lease to a lease-free dead-letter state", async () => {
  const ledger = ledgerFor("ledger-outbox-final-attempt-crash");
  await createTask(ledger, {
    task: task(), idempotencyKey: "task-create-final-attempt-crash", inputHash: "f".repeat(64), now,
  });
  await ledger.enqueueOutbox({
    eventId: "event-final-attempt-crash", idempotencyKey: "outbox-final-attempt-crash",
    taskId: "task-0001", eventType: "task.created", payload: { taskId: "task-0001" },
    workerId: "agent:worker-1",
    leaseGeneration: await ensureAgentLease(ledger),
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now,
    }),
    now,
  });

  let finalAttempt;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const attemptNow = now + (attempt - 1) * 101;
    finalAttempt = await ledger.claimOutbox({
      workerId: "publisher-" + attempt,
      workerAssertion: await createWorkerAssertion({
        subject: "publisher-" + attempt, role: "publisher", operation: "claimOutbox", nowMs: attemptNow,
      }),
      leaseMs: 100, now: attemptNow,
    });
    expect(finalAttempt).toMatchObject({ claimed: true, event: { attempts: attempt } });
  }

  const afterLeaseExpiry = now + 8 * 101;
  const exhausted = await ledger.claimOutbox({
    workerId: "publisher-recovery",
    workerAssertion: await createWorkerAssertion({
      subject: "publisher-recovery", role: "publisher", operation: "claimOutbox", nowMs: afterLeaseExpiry,
    }),
    leaseMs: 100, now: afterLeaseExpiry,
  });
  expect(exhausted).toMatchObject({
    claimed: false,
    deadLettered: true,
    reason: "OUTBOX_MAX_ATTEMPTS",
    event: {
      status: "PENDING",
      retryState: "DEAD_LETTER",
      leaseWorkerId: null,
      leaseUntil: 0,
      attempts: 8,
    },
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT status, retry_state, lease_worker_id, lease_until, dead_lettered_at FROM orchestrator_outbox_events WHERE event_id = ?",
      "event-final-attempt-crash",
    ).one()).toMatchObject({
      status: "PENDING",
      retry_state: "DEAD_LETTER",
      lease_worker_id: null,
      lease_until: 0,
      dead_lettered_at: afterLeaseExpiry,
    });
  });
});


it("authenticates the Queue consumer before inspecting an untrusted receipt payload", async () => {
  const ledger = ledgerFor("ledger-outbox-receipt-auth-before-inspection");
  const input = {
    eventId: "evt-receipt-auth-order-0001",
    idempotencyKey: "outbox-receipt-auth-order-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { apiKey: "must-not-be-inspected-before-authentication" },
    createdAt: now,
    schemaVersion: 1,
    envelopeSha256: "a".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
    workerAssertion: null,
  };

  const result = await ledger.recordOutboxReceipt(input);
  expect(result).toEqual({
    recorded: false,
    reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  const authenticatedReceiptAssertion = await createWorkerAssertion({
    subject: input.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
  });
  const authenticatedReceiptResult = await ledger.recordOutboxReceipt({
    ...input,
    workerAssertion: authenticatedReceiptAssertion,
  });
  expect(authenticatedReceiptResult).toEqual({
    recorded: false,
    reason: "SENSITIVE_FIELD_REJECTED",
  });

  const replayedReceiptAssertion = await ledger.recordOutboxReceipt({
    ...input,
    payload: { taskId: "task-0001", version: 1 },
    workerAssertion: authenticatedReceiptAssertion,
  });
  expect(replayedReceiptAssertion).toEqual({
    recorded: false,
    reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
  });
});


it("rejects an authenticated Queue receipt when no matching durable Outbox event exists", async () => {
  const ledger = ledgerFor("ledger-outbox-receipt-source-binding");
  const input = {
    eventId: "evt-receipt-unbound-0001",
    idempotencyKey: "outbox-unbound-0001",
    taskId: "task-0001",
    eventType: "task.transitioned",
    payload: { taskId: "task-0001", version: 2 },
    createdAt: now,
    schemaVersion: 1,
    envelopeSha256: "d".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  const result = await ledger.recordOutboxReceipt({
    ...input,
    workerAssertion: await createWorkerAssertion({
      subject: input.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
    }),
  });
  expect(result).toMatchObject({ recorded: false, reason: "OUTBOX_SOURCE_NOT_FOUND" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
  });
});


it("records a receipt only when every immutable Queue field matches the durable Outbox row", async () => {
  const ledger = ledgerFor("ledger-outbox-receipt-source-match");
  const payload = { taskId: "task-0001", version: 1 };
  await createTask(ledger, {
    task: task(), idempotencyKey: "task-create-receipt-source", inputHash: "f".repeat(64), now,
  });
  await ledger.enqueueOutbox({
    eventId: "evt-receipt-source-0001",
    idempotencyKey: "outbox-receipt-source-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload,
    workerId: "agent:worker-1",
    leaseGeneration: await ensureAgentLease(ledger),
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now,
    }),
    now,
  });
  const common = {
    eventId: "evt-receipt-source-0001",
    eventType: "task.created",
    idempotencyKey: "outbox-receipt-source-0001",
    taskId: "task-0001",
    payload,
    createdAt: now,
    schemaVersion: 1,
    envelopeSha256: "e".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  const accepted = await ledger.recordOutboxReceipt({
    ...common,
    workerAssertion: await createWorkerAssertion({
      subject: common.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
    }),
  });
  expect(accepted).toMatchObject({ recorded: true, eventId: common.eventId });
  const tampered = await ledger.recordOutboxReceipt({
    ...common,
    payload: { ...payload, version: 999 },
    envelopeSha256: "f".repeat(64),
    workerAssertion: await createWorkerAssertion({
      subject: common.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now + 1,
    }),
    now: now + 1,
  });
  expect(tampered).toMatchObject({ recorded: false, reason: "OUTBOX_SOURCE_NOT_FOUND" });
});


it("integrates the real Durable Object Ledger with publisher and Queue consumer across duplicate delivery", async () => {
  const ledger = ledgerFor("orchestrator-ledger-global");
  const integrationNow = Date.now();
  const taskId = "task-queue-e2e-0001";
  const created = await createTask(ledger, {
    task: task(taskId),
    idempotencyKey: "task-create-queue-e2e-0001",
    inputHash: "a".repeat(64),
    now: integrationNow,
  });
  expect(created).toMatchObject({ created: true, task: { taskId } });
  const payload = { taskId, transition: "created", source: "integration-test" };
  const enqueued = await ledger.enqueueOutbox({
    eventId: "evt-queue-e2e-0001",
    idempotencyKey: "outbox-queue-e2e-0001",
    taskId,
    eventType: "task.created",
    payload,
    workerId: "agent:worker-1",
    leaseGeneration: await ensureAgentLease(ledger, { taskId, now: integrationNow }),
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: integrationNow,
    }),
    now: integrationNow,
  });
  expect(enqueued).toMatchObject({ enqueued: true, event: { eventId: "evt-queue-e2e-0001" } });

  const queued = [];
  const runtimeEnv = {
    ORCHESTRATOR_LEDGER: {
      idFromName: name => name,
      get: name => name === "orchestrator-ledger-global" ? ledger : null,
    },
    ORCHESTRATOR_OUTBOX_QUEUE: {
      send: async (message, options) => {
        queued.push({ message: structuredClone(message), options });
      },
    },
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: TEST_ASSERTION_KID,
  };
  const published = await processOrchestratorOutbox(runtimeEnv, { maxEvents: 1 });
  expect(published).toEqual({
    processed: 1, published: 1, failed: 0, deadLettered: 0, completionPending: 0,
  });
  expect(queued).toHaveLength(1);
  expect(queued[0].options).toEqual({ contentType: "json" });
  expect(queued[0].message).toMatchObject({
    schemaVersion: 1,
    eventId: "evt-queue-e2e-0001",
    idempotencyKey: "outbox-queue-e2e-0001",
    taskId,
    eventType: "task.created",
    payload,
    createdAt: integrationNow,
  });

  const delivered = () => ({
    body: structuredClone(queued[0].message),
    acknowledged: false,
    retried: false,
    ack() { this.acknowledged = true; },
    retry() { this.retried = true; },
  });
  const consumerEnv = {
    ORCHESTRATOR_LEDGER: {
      idFromName: name => name,
      get: () => ledger,
    },
    LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: TEST_ASSERTION_KID,
  };
  const first = delivered();
  const firstResult = await consumeOrchestratorOutbox({ messages: [first] }, consumerEnv);
  expect(firstResult).toEqual({ received: 1, acknowledged: 1, retried: 0, duplicates: 0 });
  expect(first.acknowledged).toBe(true);
  expect(first.retried).toBe(false);

  const duplicate = delivered();
  const duplicateResult = await consumeOrchestratorOutbox({ messages: [duplicate] }, consumerEnv);
  expect(duplicateResult).toEqual({ received: 1, acknowledged: 1, retried: 0, duplicates: 1 });
  expect(duplicate.acknowledged).toBe(true);
  expect(duplicate.retried).toBe(false);

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
      "evt-queue-e2e-0001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT status FROM orchestrator_outbox_events WHERE event_id = ?",
      "evt-queue-e2e-0001",
    ).one().status).toBe("COMPLETED");
  });
});


it("acknowledges a republished event after an uncertain send even when the publisher attempt counter changes", async () => {
  const integrationNow = Date.now();
  let clockNow = integrationNow;
  const dateNow = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
  try {
    const ledger = ledgerFor("orchestrator-ledger-republish-e2e");
    const taskId = "task-queue-republish-e2e";
    const created = await createTask(ledger, {
      task: task(taskId),
      idempotencyKey: "task-create-queue-republish-e2e",
      inputHash: "b".repeat(64),
      now: integrationNow,
    });
    expect(created).toMatchObject({ created: true, task: { taskId } });

    const payload = { taskId, transition: "created", source: "uncertain-send-replay-test" };
    const enqueued = await ledger.enqueueOutbox({
      eventId: "evt-queue-republish-e2e",
      idempotencyKey: "outbox-queue-republish-e2e",
      taskId,
      eventType: "task.created",
      payload,
      workerId: "agent:worker-1",
      leaseGeneration: await ensureAgentLease(ledger, { taskId, now: integrationNow }),
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: integrationNow,
      }),
      now: integrationNow,
    });
    expect(enqueued).toMatchObject({ enqueued: true });

    const queued = [];
    let completionCalls = 0;
    const binding = {
      idFromName: () => "orchestrator-ledger-republish-e2e",
      get: () => ({
        claimOutbox: input => ledger.claimOutbox(input),
        failOutbox: input => ledger.failOutbox(input),
        completeOutbox: input => {
          completionCalls += 1;
          if (completionCalls === 1) return Promise.resolve({ completed: false, reason: "LEASE_FENCE_MISMATCH" });
          return ledger.completeOutbox(input);
        },
        recordOutboxReceipt: input => ledger.recordOutboxReceipt(input),
      }),
    };
    const runtimeEnv = {
      ORCHESTRATOR_LEDGER: binding,
      ORCHESTRATOR_OUTBOX_QUEUE: {
        send: async (message, options) => queued.push({ message: structuredClone(message), options }),
      },
      LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
      LEDGER_WORKER_ASSERTION_ACTIVE_KID: TEST_ASSERTION_KID,
    };

    const firstPublish = await processOrchestratorOutbox(runtimeEnv, { maxEvents: 1 });
    expect(firstPublish.completionPending).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0].message.attempts).toBe(1);

    clockNow += 120_001;
    const recoveryPublish = await processOrchestratorOutbox(runtimeEnv, { maxEvents: 1 });
    expect(recoveryPublish).toMatchObject({ processed: 1, published: 1, completionPending: 0 });
    expect(queued).toHaveLength(2);
    expect(queued[1].message.eventId).toBe(queued[0].message.eventId);
    expect(queued[1].message.attempts).toBe(2);

    const consumerEnv = {
      ORCHESTRATOR_LEDGER: binding,
      LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
      LEDGER_WORKER_ASSERTION_ACTIVE_KID: TEST_ASSERTION_KID,
    };
    const deliver = message => ({
      body: structuredClone(message),
      acknowledged: false,
      retried: false,
      ack() { this.acknowledged = true; },
      retry() { this.retried = true; },
    });
    const firstDelivery = deliver(queued[0].message);
    const firstResult = await consumeOrchestratorOutbox({ messages: [firstDelivery] }, consumerEnv);
    expect(firstResult).toEqual({ received: 1, acknowledged: 1, retried: 0, duplicates: 0 });

    const replayDelivery = deliver(queued[1].message);
    const replayResult = await consumeOrchestratorOutbox({ messages: [replayDelivery] }, consumerEnv);
    expect(replayResult).toEqual({ received: 1, acknowledged: 1, retried: 0, duplicates: 1 });
    expect(replayDelivery.acknowledged).toBe(true);
    expect(replayDelivery.retried).toBe(false);

    // A replay may vary only in delivery metadata. Rebinding the same event ID
    // to altered semantic content must be rejected and must not create a receipt.
    const tamperedEnvelope = structuredClone(queued[1].message);
    tamperedEnvelope.payload = { ...tamperedEnvelope.payload, transition: "privilege-escalation" };
    const tamperedDelivery = deliver(tamperedEnvelope);
    const tamperedResult = await consumeOrchestratorOutbox({ messages: [tamperedDelivery] }, consumerEnv);
    expect(tamperedResult).toEqual({ received: 1, acknowledged: 0, retried: 1, duplicates: 0 });
    expect(tamperedDelivery.acknowledged).toBe(false);
    expect(tamperedDelivery.retried).toBe(true);

    // A consumer with a mismatched signing key must not be able to persist a
    // receipt, even when the Queue envelope itself is otherwise legitimate.
    const invalidSignatureDelivery = deliver(queued[1].message);
    const invalidSignatureResult = await consumeOrchestratorOutbox(
      { messages: [invalidSignatureDelivery] },
      {
        ...consumerEnv,
        LEDGER_WORKER_ASSERTION_KEYS: JSON.stringify({
          [TEST_ASSERTION_KID]: "3031323334353637383961626364656630313233343536373839616263646567",
        }),
      },
    );
    expect(invalidSignatureResult).toEqual({ received: 1, acknowledged: 0, retried: 1, duplicates: 0 });
    expect(invalidSignatureDelivery.acknowledged).toBe(false);
    expect(invalidSignatureDelivery.retried).toBe(true);

    // Malformed envelopes are retried without reaching the durable receipt API.
    const malformedDelivery = deliver({ ...queued[1].message, attempts: 0 });
    const malformedResult = await consumeOrchestratorOutbox({ messages: [malformedDelivery] }, consumerEnv);
    expect(malformedResult).toEqual({ received: 1, acknowledged: 0, retried: 1, duplicates: 0 });
    expect(malformedDelivery.acknowledged).toBe(false);
    expect(malformedDelivery.retried).toBe(true);

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
        "evt-queue-republish-e2e",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT status FROM orchestrator_outbox_events WHERE event_id = ?",
        "evt-queue-republish-e2e",
      ).one().status).toBe("COMPLETED");
    });
  } finally {
    dateNow.mockRestore();
  }
});


it("archives DLQ messages durably with signature validation, content integrity, and idempotent replay", async () => {
  const ledger = ledgerFor("ledger-outbox-dlq-archive");
  const queueName = "chat-gpt111-staging-orchestrator-outbox-dlq";
  const messageId = "cf-message-archive-0001";
  const body = {
    schemaVersion: 1,
    eventId: "evt-dlq-archive-0001",
    idempotencyKey: "idem-dlq-archive-0001",
    taskId: "task-0001",
    eventType: "task.transitioned",
    payload: { taskId: "task-0001", transition: "SCHEDULED_TO_RUNNING" },
    attempts: 1,
    createdAt: now,
  };
  const messageTimestamp = now - 10_000;
  const bodySha256 = await sha256Canonical({ queueName, messageId, messageAttempts: 5, messageTimestamp, body });
  const input = {
    queueName, messageId, messageAttempts: 5, messageTimestamp, body, bodySha256,
    archiverId: "orchestrator-outbox-dlq-archiver", now,
  };
  const record = async () => ledger.recordOutboxDeadLetter({
    ...input,
    workerAssertion: await createWorkerAssertion({
      subject: input.archiverId, role: "consumer", operation: "recordOutboxDeadLetter", nowMs: now,
    }),
  });
  await expect(record()).resolves.toMatchObject({ recorded: true, messageId });
  await expect(record()).resolves.toMatchObject({ recorded: false, replay: true, messageId });
  const tamperedBody = { ...body, payload: { taskId: "task-0001", transition: "TAMPERED" } };
  const tamperedSha = await sha256Canonical({
    queueName, messageId, messageAttempts: 5, messageTimestamp, body: tamperedBody,
  });
  await expect(ledger.recordOutboxDeadLetter({
    ...input,
    body: tamperedBody,
    bodySha256: tamperedSha,
    workerAssertion: await createWorkerAssertion({
      subject: input.archiverId, role: "consumer", operation: "recordOutboxDeadLetter", nowMs: now,
    }),
  })).resolves.toMatchObject({ recorded: false, conflict: true, reason: "DEAD_LETTER_MESSAGE_ID_CONFLICT" });

  await expect(ledger.recordOutboxDeadLetter({
    ...input,
    bodySha256: "0".repeat(64),
    workerAssertion: await createWorkerAssertion({
      subject: input.archiverId, role: "consumer", operation: "recordOutboxDeadLetter", nowMs: now,
    }),
  })).resolves.toMatchObject({ recorded: false, reason: "DEAD_LETTER_HASH_MISMATCH" });

  const unauthenticatedSensitivePayloadResult = await ledger.recordOutboxDeadLetter({
    ...input,
    body: { ...body, payload: { apiKey: "must-not-be-inspected-before-authentication" } },
    workerAssertion: null,
  });
  expect(unauthenticatedSensitivePayloadResult).toEqual({
    recorded: false,
    reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  const sensitivePayloadResult = await ledger.recordOutboxDeadLetter({
    ...input,
    body: { ...body, payload: { apiKey: "must-not-be-persisted" } },
    workerAssertion: await createWorkerAssertion({
      subject: input.archiverId, role: "consumer", operation: "recordOutboxDeadLetter", nowMs: now,
    }),
  });
  expect(sensitivePayloadResult).toEqual({
    recorded: false,
    reason: "SENSITIVE_FIELD_REJECTED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_dead_letters WHERE source_queue = ? AND message_id = ?",
      queueName, messageId,
    ).one().count).toBe(1);
  });
});


it("integrates the DLQ consumer with Durable Object archival before message acknowledgement", async () => {
  const queueName = "chat-gpt111-staging-orchestrator-outbox-dlq";
  const ledger = ledgerFor("ledger-outbox-dlq-consumer-integration");
  const body = {
    schemaVersion: 1,
    eventId: "evt-dlq-consumer-integration",
    idempotencyKey: "idem-dlq-consumer-integration",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001" },
    attempts: 1,
    createdAt: now,
  };
  const messageTimestamp = Date.now() - 1000;
  const consumerEnv = {
    ORCHESTRATOR_OUTBOX_DLQ_QUEUE: queueName,
    ORCHESTRATOR_LEDGER: {
      idFromName: name => name,
      get: () => ledger,
    },
    LEDGER_WORKER_ASSERTION_KEYS: JSON.stringify({
      [TEST_ASSERTION_KID]: "3031323334353637383961626364656630313233343536373839616263646566",
    }),
    LEDGER_WORKER_ASSERTION_ACTIVE_KID: TEST_ASSERTION_KID,
  };
  const deliver = () => ({
    id: "cf-message-integration-0001",
    timestamp: new Date(messageTimestamp),
    attempts: 5,
    body,
    acknowledged: false,
    retried: false,
    ack() { this.acknowledged = true; },
    retry() { this.retried = true; },
  });
  const first = deliver();
  await expect(consumeOrchestratorDeadLetters(
    { queue: queueName, messages: [first] }, consumerEnv,
  )).resolves.toMatchObject({ received: 1, archived: 1, duplicates: 0, retried: 0 });
  expect(first.acknowledged).toBe(true);
  const duplicate = deliver();
  await expect(consumeOrchestratorDeadLetters(
    { queue: queueName, messages: [duplicate] }, consumerEnv,
  )).resolves.toMatchObject({ received: 1, archived: 1, duplicates: 1, retried: 0 });
  expect(duplicate.acknowledged).toBe(true);
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_dead_letters WHERE source_queue = ? AND message_id = ?",
      queueName, "cf-message-integration-0001",
    ).one().count).toBe(1);
  });
});


it("consumes a verified receipt assertion even when the authenticated payload is rejected", async () => {
  const ledger = ledgerFor("ledger-receipt-sensitive-assertion-consumption");
  const input = {
    eventId: "evt-receipt-sensitive-jti-0001",
    eventType: "task.created",
    idempotencyKey: "outbox-receipt-sensitive-jti-0001",
    taskId: "task-0001",
    payload: { taskId: "task-0001", apiKey: "must-not-be-persisted" },
    createdAt: now,
    schemaVersion: 1,
    envelopeSha256: "c".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  const workerAssertion = await createWorkerAssertion({
    subject: input.consumerId,
    role: "consumer",
    operation: "recordOutboxReceipt",
    nowMs: now,
    jti: "jti-receipt-sensitive-consume-00000001",
  });

  await expect(ledger.recordOutboxReceipt({ ...input, workerAssertion }))
    .resolves.toMatchObject({
      recorded: false,
      reason: "SENSITIVE_FIELD_REJECTED",
    });

  await expect(ledger.recordOutboxReceipt({
    ...input,
    payload: { taskId: "task-0001", version: 1 },
    workerAssertion,
  })).resolves.toMatchObject({
    recorded: false,
    reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-receipt-sensitive-consume-00000001",
    ).one().count).toBe(1);
  });
});


it("consumes a verified message assertion when an authenticated envelope contains sensitive fields", async () => {
  const ledger = ledgerFor("ledger-message-sensitive-assertion-consumption");
  await createTask(ledger, {
    task: task(),
    idempotencyKey: "a",
    inputHash: "d".repeat(64),
    now,
  });
  const input = {
    messageId: "msg-sensitive-jti-0001",
    taskId: "task-0001",
    inputHash: "e".repeat(64),
    workerId: "agent:worker-1",
    now,
  };
  const workerAssertion = await createWorkerAssertion({
    subject: input.workerId, role: "agent", operation: "recordMessage",
    nowMs: now, jti: "jti-message-sensitive-consume-00000001",
  });

  await expect(ledger.recordMessage({
    ...input,
    envelope: protocolEnvelope(input.messageId, input.taskId, input.inputHash, {
      apiKey: "must-not-be-persisted",
    }),
    workerAssertion,
  })).resolves.toMatchObject({
    accepted: false, reason: "SENSITIVE_FIELD_REJECTED",
  });

  await expect(ledger.recordMessage({
    ...input,
    envelope: protocolEnvelope(input.messageId, input.taskId, input.inputHash, {
      status: "progress",
    }),
    workerAssertion,
  })).resolves.toMatchObject({
    accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-message-sensitive-consume-00000001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
      input.messageId,
    ).one().count).toBe(0);
  });
});

it("consumes an outbox assertion when an authenticated event payload contains sensitive fields", async () => {
  const ledger = ledgerFor("ledger-outbox-sensitive-assertion-consumption");
  await createTask(ledger, {
    task: task(), idempotencyKey: "a", inputHash: "f".repeat(64), now,
  });
  const input = {
    eventId: "evt-outbox-sensitive-jti-0001",
    idempotencyKey: "a",
    taskId: "task-0001",
    eventType: "task.created",
    workerId: "agent:worker-1",
    now,
  };
  const workerAssertion = await createWorkerAssertion({
    subject: input.workerId, role: "agent", operation: "enqueueOutbox",
    nowMs: now, jti: "jti-outbox-sensitive-consume-00000001",
  });

  await expect(ledger.enqueueOutbox({
    ...input, payload: { apiKey: "must-not-be-persisted" }, workerAssertion,
  })).resolves.toMatchObject({
    enqueued: false, reason: "SENSITIVE_FIELD_REJECTED",
  });

  await expect(ledger.enqueueOutbox({
    ...input, payload: { taskId: "task-0001", transition: "created" }, workerAssertion,
  })).resolves.toMatchObject({
    enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-outbox-sensitive-consume-00000001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
  });
});


it("consumes authenticated message assertions when envelope identity is rejected", async () => {
  const ledger = ledgerFor("ledger-message-identity-rejection-consumes-jti");
  await createTask(ledger, {
    task: task(), idempotencyKey: "message-identity-task", inputHash: "b".repeat(64), now,
  });
  const input = {
    messageId: "msg-identity-rejection-0001",
    taskId: "task-0001",
    inputHash: "c".repeat(64),
    workerId: "agent:worker-1",
    now,
  };
  const workerAssertion = await createWorkerAssertion({
    subject: input.workerId, role: "agent", operation: "recordMessage", nowMs: now,
    jti: "jti-message-identity-rejection-0001",
  });
  const mismatchedEnvelope = protocolEnvelope(
    input.messageId, input.taskId, input.inputHash, { step: 1 },
  );
  mismatchedEnvelope.senderId = "agent:attacker";

  await expect(ledger.recordMessage({
    ...input, envelope: mismatchedEnvelope, workerAssertion,
  })).resolves.toEqual({
    accepted: false, reason: "SENDER_IDENTITY_MISMATCH",
  });
  await expect(ledger.recordMessage({
    ...input,
    envelope: protocolEnvelope(input.messageId, input.taskId, input.inputHash, { step: 1 }),
    workerAssertion,
  })).resolves.toEqual({
    accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-message-identity-rejection-0001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
      input.messageId,
    ).one().count).toBe(0);
  });
});

it("consumes an outbox assertion when the authenticated payload exceeds the size limit", async () => {
  const ledger = ledgerFor("ledger-outbox-oversized-payload-consumes-jti");
  await createTask(ledger, {
    task: task(), idempotencyKey: "outbox-oversized-task", inputHash: "d".repeat(64), now,
  });
  const workerAssertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now,
    jti: "jti-outbox-oversized-payload-0001",
  });
  const input = {
    eventId: "evt-outbox-oversized-payload-0001",
    idempotencyKey: "idem-outbox-oversized-payload-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001", extension: "x".repeat(33_000) },
    workerId: "agent:worker-1",
    workerAssertion,
    now,
  };

  await expect(ledger.enqueueOutbox(input)).resolves.toEqual({
    enqueued: false, reason: "RECORD_TOO_LARGE",
  });
  await expect(ledger.enqueueOutbox(input)).resolves.toEqual({
    enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-outbox-oversized-payload-0001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
  });
});

it("consumes a receipt assertion when the authenticated payload exceeds the size limit", async () => {
  const ledger = ledgerFor("ledger-receipt-oversized-payload-consumes-jti");
  const input = {
    eventId: "evt-receipt-oversized-payload-0001",
    eventType: "task.created",
    idempotencyKey: "idem-receipt-oversized-payload-0001",
    taskId: "task-0001",
    payload: { taskId: "task-0001", extension: "x".repeat(33_000) },
    createdAt: now,
    schemaVersion: 1,
    envelopeSha256: "e".repeat(64),
    consumerId: "orchestrator-outbox-consumer",
    now,
  };
  const workerAssertion = await createWorkerAssertion({
    subject: input.consumerId, role: "consumer", operation: "recordOutboxReceipt", nowMs: now,
    jti: "jti-receipt-oversized-payload-0001",
  });

  await expect(ledger.recordOutboxReceipt({ ...input, workerAssertion })).resolves.toEqual({
    recorded: false, reason: "RECORD_TOO_LARGE",
  });
  await expect(ledger.recordOutboxReceipt({ ...input, workerAssertion })).resolves.toEqual({
    recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-receipt-oversized-payload-0001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
      input.eventId,
    ).one().count).toBe(0);
  });
});

it("consumes a DLQ archiver assertion when the authenticated body exceeds the size limit", async () => {
  const ledger = ledgerFor("ledger-dlq-oversized-body-consumes-jti");
  const queueName = "chat-gpt111-staging-orchestrator-outbox-dlq";
  const messageId = "cf-oversized-body-0001";
  const body = {
    schemaVersion: 1,
    eventId: "evt-dlq-oversized-body-0001",
    idempotencyKey: "idem-dlq-oversized-body-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001", extension: "x".repeat(33_000) },
    attempts: 1,
    createdAt: now,
  };
  const input = {
    queueName, messageId, messageAttempts: 5, messageTimestamp: now - 10_000,
    body, bodySha256: "f".repeat(64),
    archiverId: "orchestrator-outbox-dlq-archiver", now,
  };
  const workerAssertion = await createWorkerAssertion({
    subject: input.archiverId, role: "consumer", operation: "recordOutboxDeadLetter", nowMs: now,
    jti: "jti-dlq-oversized-body-0001",
  });

  await expect(ledger.recordOutboxDeadLetter({ ...input, workerAssertion })).resolves.toEqual({
    recorded: false, reason: "RECORD_TOO_LARGE",
  });
  await expect(ledger.recordOutboxDeadLetter({ ...input, workerAssertion })).resolves.toEqual({
    recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-dlq-oversized-body-0001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_dead_letters WHERE source_queue = ? AND message_id = ?",
      queueName, messageId,
    ).one().count).toBe(0);
  });
});

it("consumes a DLQ archiver assertion when an authenticated dead-letter body contains sensitive fields", async () => {
  const ledger = ledgerFor("ledger-dlq-sensitive-assertion-consumption");
  const queueName = "chat-gpt111-staging-orchestrator-outbox-dlq";
  const messageId = "cf-sensitive-jti-0001";
  const messageAttempts = 5;
  const messageTimestamp = now - 10_000;
  const safeBody = {
    schemaVersion: 1,
    eventId: "evt-dlq-sensitive-jti-0001",
    idempotencyKey: "a",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001" },
    attempts: 1,
    createdAt: now,
  };
  const sensitiveBody = { ...safeBody, payload: { apiKey: "must-not-be-persisted" } };
  const archiverId = "orchestrator-outbox-dlq-archiver";
  const workerAssertion = await createWorkerAssertion({
    subject: archiverId, role: "consumer", operation: "recordOutboxDeadLetter",
    nowMs: now, jti: "jti-dlq-sensitive-consume-00000001",
  });
  const digest = body => sha256Canonical({
    queueName, messageId, messageAttempts, messageTimestamp, body,
  });

  await expect(ledger.recordOutboxDeadLetter({
    queueName, messageId, messageAttempts, messageTimestamp,
    body: sensitiveBody, bodySha256: await digest(sensitiveBody),
    archiverId, workerAssertion, now,
  })).resolves.toMatchObject({
    recorded: false, reason: "SENSITIVE_FIELD_REJECTED",
  });

  await expect(ledger.recordOutboxDeadLetter({
    queueName, messageId, messageAttempts, messageTimestamp,
    body: safeBody, bodySha256: await digest(safeBody),
    archiverId, workerAssertion, now,
  })).resolves.toMatchObject({
    recorded: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      "jti-dlq-sensitive-consume-00000001",
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_dead_letters WHERE source_queue = ? AND message_id = ?",
      queueName, messageId,
    ).one().count).toBe(0);
  });
});


it("consumes a transition assertion when authenticated transition evidence is invalid", async () => {
  const ledger = ledgerFor("ledger-transition-invalid-evidence-consumes-jti");
  await createTask(ledger, { task: task(), idempotencyKey: "transition-invalid-evidence-task", inputHash: "d".repeat(64), now });
  const lease = await ledger.claimTask({
    workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"),
    leaseMs: 30_000, now,
  });
  const jti = "jti-transition-invalid-evidence-0001";
  const workerAssertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1, jti,
  });
  const input = {
    taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
    actor: agent, evidence: null, now: now + 1, workerId: "agent:worker-1",
    workerAssertion, leaseGeneration: lease.leaseGeneration,
  };

  await expect(ledger.transitionTask(input)).resolves.toEqual({
    updated: false, reason: "INVALID_EVIDENCE",
  });
  await expect(ledger.transitionTask({ ...input, evidence })).resolves.toEqual({
    updated: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?", jti,
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT state, version FROM orchestrator_tasks WHERE task_id = ?", "task-0001",
    ).one()).toMatchObject({ state: "SCHEDULED", version: 1 });
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_events").one().count).toBe(0);
  });
});


it("fences Agent message and Outbox writes by task assignment and current lease generation", async () => {
  const ledger = ledgerFor("ledger-agent-rpc-lease-fencing");
  await createTask(ledger, {
    task: task(),
    idempotencyKey: "task-create-agent-rpc-lease-fencing",
    inputHash: "a".repeat(64),
    now,
  });

  const firstLease = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now),
    leaseMs: 30_000,
    now,
  });
  expect(firstLease).toMatchObject({ claimed: true, leaseGeneration: 1 });

  await expect(ledger.releaseLease({
    taskId: "task-0001",
    workerId: "agent:worker-1",
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 1,
    }),
    leaseGeneration: firstLease.leaseGeneration,
    now: now + 1,
  })).resolves.toMatchObject({ released: true });

  const currentLease = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now + 2),
    leaseMs: 30_000,
    now: now + 2,
  });
  expect(currentLease).toMatchObject({ claimed: true, leaseGeneration: 2 });

  const staleMessageJti = "jti-stale-agent-message-lease-0001";
  const staleMessageAssertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now + 3, jti: staleMessageJti,
  });
  await expect(ledger.recordMessage({
    messageId: "msg-stale-agent-lease-0001",
    taskId: "task-0001",
    inputHash: "b".repeat(64),
    envelope: protocolEnvelope("msg-stale-agent-lease-0001", "task-0001", "b".repeat(64), { step: 1 }),
    workerId: "agent:worker-1",
    leaseGeneration: firstLease.leaseGeneration,
    workerAssertion: staleMessageAssertion,
    now: now + 3,
  })).resolves.toMatchObject({ accepted: false, reason: "LEASE_FENCE_MISMATCH" });
  await expect(ledger.recordMessage({
    messageId: "msg-stale-agent-lease-0001",
    taskId: "task-0001",
    inputHash: "b".repeat(64),
    envelope: protocolEnvelope("msg-stale-agent-lease-0001", "task-0001", "b".repeat(64), { step: 1 }),
    workerId: "agent:worker-1",
    leaseGeneration: currentLease.leaseGeneration,
    workerAssertion: staleMessageAssertion,
    now: now + 3,
  })).resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });

  await expect(ledger.recordMessage({
    messageId: "msg-current-agent-lease-0001",
    taskId: "task-0001",
    inputHash: "c".repeat(64),
    envelope: protocolEnvelope("msg-current-agent-lease-0001", "task-0001", "c".repeat(64), { step: 2 }),
    workerId: "agent:worker-1",
    leaseGeneration: currentLease.leaseGeneration,
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now + 3,
    }),
    now: now + 3,
  })).resolves.toMatchObject({ accepted: true });

  const staleOutboxJti = "jti-stale-agent-outbox-lease-0001";
  const staleOutboxAssertion = await createWorkerAssertion({
    subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now + 3, jti: staleOutboxJti,
  });
  const outboxInput = {
    eventId: "evt-stale-agent-lease-0001",
    idempotencyKey: "idem-stale-agent-lease-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001", version: 1 },
    workerId: "agent:worker-1",
    leaseGeneration: firstLease.leaseGeneration,
    workerAssertion: staleOutboxAssertion,
    now: now + 3,
  };
  await expect(ledger.enqueueOutbox(outboxInput)).resolves.toMatchObject({
    enqueued: false, reason: "LEASE_FENCE_MISMATCH",
  });
  await expect(ledger.enqueueOutbox({
    ...outboxInput,
    leaseGeneration: currentLease.leaseGeneration,
  })).resolves.toMatchObject({
    enqueued: false, reason: "AUTHENTICATED_WORKER_REQUIRED",
  });

  await expect(ledger.enqueueOutbox({
    ...outboxInput,
    eventId: "evt-current-agent-lease-0001",
    idempotencyKey: "idem-current-agent-lease-0001",
    leaseGeneration: currentLease.leaseGeneration,
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now + 3,
    }),
  })).resolves.toMatchObject({ enqueued: true });

  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      staleMessageJti,
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
      staleOutboxJti,
    ).one().count).toBe(1);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
      "msg-stale-agent-lease-0001",
    ).one().count).toBe(0);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
      "evt-stale-agent-lease-0001",
    ).one().count).toBe(0);
  });
});


it("rejects Agent writes when the authenticated worker does not own the task assignment", async () => {
  const ledger = ledgerFor("ledger-agent-assignment-fencing");
  await createTask(ledger, {
    task: task(),
    idempotencyKey: "task-create-agent-assignment-fencing",
    inputHash: "a".repeat(64),
    now,
  });
  const lease = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now),
    leaseMs: 30_000,
    now,
  });
  expect(lease).toMatchObject({ claimed: true, leaseGeneration: 1 });

  const messageJti = "jti-unassigned-agent-message-0001";
  await expect(ledger.recordMessage({
    messageId: "msg-unassigned-agent-0001",
    taskId: "task-0001",
    inputHash: "b".repeat(64),
    envelope: {
      ...protocolEnvelope("msg-unassigned-agent-0001", "task-0001", "b".repeat(64), { step: 1 }),
      senderId: "agent:worker-2",
    },
    workerId: "agent:worker-2",
    leaseGeneration: lease.leaseGeneration,
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-2", role: "agent", operation: "recordMessage", nowMs: now, jti: messageJti,
    }),
    now,
  })).resolves.toMatchObject({ accepted: false, reason: "LEASE_FENCE_MISMATCH" });

  const outboxJti = "jti-unassigned-agent-outbox-0001";
  await expect(ledger.enqueueOutbox({
    eventId: "evt-unassigned-agent-0001",
    idempotencyKey: "idem-unassigned-agent-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001", version: 1 },
    workerId: "agent:worker-2",
    leaseGeneration: lease.leaseGeneration,
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-2", role: "agent", operation: "enqueueOutbox", nowMs: now, jti: outboxJti,
    }),
    now,
  })).resolves.toMatchObject({ enqueued: false, reason: "LEASE_FENCE_MISMATCH" });

  await runInDurableObject(ledger, async (_instance, state) => {
    for (const jti of [messageJti, outboxJti]) {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?", jti,
      ).one().count).toBe(1);
    }
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
      "msg-unassigned-agent-0001",
    ).one().count).toBe(0);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
      "evt-unassigned-agent-0001",
    ).one().count).toBe(0);
  });
});

it("rejects Agent writes after lease expiry even when the generation still matches", async () => {
  const ledger = ledgerFor("ledger-agent-expired-lease-fencing");
  await createTask(ledger, {
    task: task(),
    idempotencyKey: "task-create-agent-expired-lease-fencing",
    inputHash: "c".repeat(64),
    now,
  });
  const lease = await ledger.claimTask({
    workerId: "agent:worker-1",
    workerAssertion: await claimAssertion("agent:worker-1", now),
    leaseMs: 10,
    now,
  });
  expect(lease).toMatchObject({ claimed: true, leaseGeneration: 1 });

  const expiredAt = now + 11;
  const messageJti = "jti-expired-agent-message-0001";
  await expect(ledger.recordMessage({
    messageId: "msg-expired-agent-0001",
    taskId: "task-0001",
    inputHash: "d".repeat(64),
    envelope: protocolEnvelope("msg-expired-agent-0001", "task-0001", "d".repeat(64), { step: 1 }),
    workerId: "agent:worker-1",
    leaseGeneration: lease.leaseGeneration,
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: expiredAt, jti: messageJti,
    }),
    now: expiredAt,
  })).resolves.toMatchObject({ accepted: false, reason: "LEASE_FENCE_MISMATCH" });

  const outboxJti = "jti-expired-agent-outbox-0001";
  await expect(ledger.enqueueOutbox({
    eventId: "evt-expired-agent-0001",
    idempotencyKey: "idem-expired-agent-0001",
    taskId: "task-0001",
    eventType: "task.created",
    payload: { taskId: "task-0001", version: 1 },
    workerId: "agent:worker-1",
    leaseGeneration: lease.leaseGeneration,
    workerAssertion: await createWorkerAssertion({
      subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: expiredAt, jti: outboxJti,
    }),
    now: expiredAt,
  })).resolves.toMatchObject({ enqueued: false, reason: "LEASE_FENCE_MISMATCH" });

  await runInDurableObject(ledger, async (_instance, state) => {
    for (const jti of [messageJti, outboxJti]) {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?", jti,
      ).one().count).toBe(1);
    }
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id = ?",
      "msg-expired-agent-0001",
    ).one().count).toBe(0);
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
      "evt-expired-agent-0001",
    ).one().count).toBe(0);
  });
});


it("consumes valid Agent assertions on denied lease-fenced mutations", async () => {
  const operations = ["renewLease", "releaseLease", "transitionTask", "advanceAgentRound"];
  for (const operation of operations) {
    const ledger = ledgerFor("ledger-denied-assertion-replay-" + operation);
    await createTask(ledger, {
      task: task(),
      idempotencyKey: "task-create-denied-assertion-" + operation,
      inputHash: "e".repeat(64),
      now,
    });
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now),
      leaseMs: 30_000,
      now,
    });
    expect(lease).toMatchObject({ claimed: true, leaseGeneration: 1 });
    const assertion = await createWorkerAssertion({
      subject: "agent:worker-1",
      role: "agent",
      operation,
      nowMs: now + 1,
      jti: "jti-denied-assertion-" + operation,
    });
    const invoke = (leaseGeneration) => {
      if (operation === "renewLease") {
        return ledger.renewLease({
          taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: assertion,
          leaseGeneration, leaseMs: 30_000, now: now + 1,
        });
      }
      if (operation === "releaseLease") {
        return ledger.releaseLease({
          taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: assertion,
          leaseGeneration, now: now + 1,
        });
      }
      if (operation === "transitionTask") {
        return ledger.transitionTask({
          taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
          actor: agent, evidence, now: now + 1, workerId: "agent:worker-1",
          workerAssertion: assertion, leaseGeneration,
        });
      }
      return ledger.advanceAgentRound({
        taskId: "task-0001", expectedVersion: 1, expectedRound: 0, nextRound: 1,
        workerId: "agent:worker-1", workerAssertion: assertion, leaseGeneration, now: now + 1,
      });
    };
    const denied = await invoke(lease.leaseGeneration + 1);
    const deniedKey = operation === "renewLease" ? "renewed"
      : operation === "releaseLease" ? "released"
      : operation === "transitionTask" ? "updated" : "advanced";
    expect(denied).toMatchObject({ [deniedKey]: false, reason: "LEASE_FENCE_MISMATCH" });
    const replay = await invoke(lease.leaseGeneration);
    expect(replay).toMatchObject({ [deniedKey]: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        "jti-denied-assertion-" + operation,
      ).one().count).toBe(1);
    });
  }
});

it("rejects an expired lease even when its generation is still current", async () => {
    const ledger = ledgerFor("ledger-expired-current-generation");
    await createTask(ledger, {
      task: task(), idempotencyKey: "task-expired-current-generation", inputHash: "a".repeat(64), now,
    });
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now),
      leaseMs: 100,
      now,
    });
    expect(lease).toMatchObject({ claimed: true, leaseGeneration: 1 });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 101, workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 101,
      }),
      leaseGeneration: lease.leaseGeneration,
    })).resolves.toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.getTask({ taskId: "task-0001" }))
      .resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });

  it("rejects a transition when the signed worker does not own the current lease", async () => {
    const ledger = ledgerFor("ledger-lease-owner-mismatch");
    await createTask(ledger, {
      task: task(), idempotencyKey: "task-lease-owner-mismatch", inputHash: "b".repeat(64), now,
    });
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now),
      leaseMs: 30_000,
      now,
    });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: { ...agent, id: "agent:worker-2" }, evidence, now: now + 1, workerId: "agent:worker-2",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-2", role: "agent", operation: "transitionTask", nowMs: now + 1,
      }),
      leaseGeneration: lease.leaseGeneration,
    })).resolves.toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.getTask({ taskId: "task-0001" }))
      .resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });

  it("rejects caller-forged actor identity or role despite a valid signed worker assertion", async () => {
    const ledger = ledgerFor("ledger-forged-transition-actor");
    await createTask(ledger, {
      task: task(), idempotencyKey: "task-forged-transition-actor", inputHash: "c".repeat(64), now,
    });
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now),
      leaseMs: 30_000,
      now,
    });
    const cases = [
      {
        workerId: "agent:worker-1",
        actor: { ...agent, id: "agent:worker-2" },
        assertionSubject: "agent:worker-1",
        expected: "LEASE_FENCE_MISMATCH",
      },
      {
        workerId: "agent:worker-1",
        actor: { ...agent, role: "owner" },
        assertionSubject: "agent:worker-1",
        expected: "LEASE_FENCE_MISMATCH",
      },
      {
        workerId: "agent:worker-2",
        actor: { ...agent, id: "agent:worker-2" },
        assertionSubject: "agent:worker-1",
        expected: "AUTHENTICATED_WORKER_REQUIRED",
      },
    ];
    for (const [index, item] of cases.entries()) {
      await expect(ledger.transitionTask({
        taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
        actor: item.actor, evidence, now: now + index + 1, workerId: item.workerId,
        workerAssertion: await createWorkerAssertion({
          subject: item.assertionSubject, role: "agent", operation: "transitionTask", nowMs: now + index + 1,
        }),
        leaseGeneration: lease.leaseGeneration,
      })).resolves.toMatchObject({ updated: false, reason: item.expected });
    }
    await expect(ledger.getTask({ taskId: "task-0001" }))
      .resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });

  it("serializes concurrent signed transitions so only one consumes the live task version", async () => {
    const ledger = ledgerFor("ledger-concurrent-transition-fence");
    await createTask(ledger, {
      task: task(), idempotencyKey: "task-concurrent-transition-fence", inputHash: "d".repeat(64), now,
    });
    const lease = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await claimAssertion("agent:worker-1", now),
      leaseMs: 30_000,
      now,
    });
    const transition = async () => ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 1, workerId: "agent:worker-1",
      workerAssertion: await createWorkerAssertion({
        subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 1,
      }),
      leaseGeneration: lease.leaseGeneration,
    });
    const results = await Promise.all([transition(), transition()]);
    expect(results.filter(result => result.updated)).toHaveLength(1);
    expect(results.filter(result => !result.updated)).toHaveLength(1);
    expect(results.find(result => !result.updated)).toMatchObject({
      updated: false, reason: "VERSION_OR_STATE_CONFLICT",
    });
    await expect(ledger.getTask({ taskId: "task-0001" }))
      .resolves.toMatchObject({ state: "RUNNING", version: 2 });
  });
