import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../orchestrator-protocol.js";

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
    expect(await ledger.ping()).toEqual({ ok: true, schemaVersion: 3 });
    await runInDurableObject(ledger, async (instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "orchestrator_tasks", "orchestrator_processed_messages",
        "orchestrator_execution_leases", "orchestrator_outbox_events", "orchestrator_audit_events",
        "orchestrator_consumed_assertions",
      ]));
      const outboxColumns = state.storage.sql.exec("PRAGMA table_info(orchestrator_outbox_events)").toArray().map(row => row.name);
      expect(outboxColumns).toEqual(expect.arrayContaining([
        "retry_state", "next_attempt_at", "last_error_code", "dead_lettered_at",
      ]));
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
    const first = await ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"), leaseMs: 100, now });
    const reclaimed = await ledger.claimTask({
      workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1", now + 101), leaseMs: 100, now: now + 101,
      reconciliationEvidence: { checked: true, priorGeneration: 1, evidenceRef: "github://audit/reconcile/1" },
    });
    expect(reclaimed.leaseGeneration).toBe(2);
    await expect(ledger.renewLease({
      taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "renewLease", nowMs: now + 102 }), leaseGeneration: first.leaseGeneration, leaseMs: 100, now: now + 102,
    })).resolves.toMatchObject({ renewed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.releaseLease({
      taskId: "task-0001", workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "releaseLease", nowMs: now + 102 }), leaseGeneration: first.leaseGeneration, now: now + 102,
    })).resolves.toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 102, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "transitionTask", nowMs: now + 102 }), leaseGeneration: first.leaseGeneration,
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
    const input = { messageId: "msg-0001", taskId: "task-0001", inputHash: "3".repeat(64), envelope: protocolEnvelope("msg-0001", "task-0001", "3".repeat(64), { step: 1 }), workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }), now };
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
      eventType: "task.created", payload: { taskId: "task-0001" }, workerId: "agent:worker-1", now,
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
      eventType: "task.created", payload: { taskId: "task-0001" }, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }), now,
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
      envelope: protocolEnvelope("msg-100-duplicates", "task-0001", "a".repeat(64), { accepted: true }), workerId: "agent:worker-1", now,
    };
    const results = await Promise.all(Array.from({ length: 100 }, async () => ledger.recordMessage({ ...input, workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "recordMessage", nowMs: now }) })));
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.filter(result => result.replay)).toHaveLength(99);
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id='msg-100-duplicates'").one().count).toBe(1);
    });
  });

  it("requires reconciliation evidence before reclaiming an expired lease and preserves task state", async () => {
    const ledger = ledgerFor("ledger-expired-lease-reconciliation");
    await createTask(ledger, { task: task(), idempotencyKey: "task-create-0012", inputHash: "b".repeat(64), now });
    const worker = authenticatedWorker("agent:worker-1");
    const first = await ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1"), leaseMs: 100, now });
    await expect(ledger.claimTask({ workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1", now + 101), leaseMs: 100, now: now + 101 }))
      .resolves.toMatchObject({ claimed: false, reason: "RECONCILIATION_REQUIRED" });
    const reclaimed = await ledger.claimTask({
      workerId: "agent:worker-1", workerAssertion: await claimAssertion("agent:worker-1", now + 101), leaseMs: 100, now: now + 101,
      reconciliationEvidence: { checked: true, priorGeneration: first.leaseGeneration, evidenceRef: "github://audit/reconcile/12" },
    });
    expect(reclaimed).toMatchObject({ claimed: true, leaseGeneration: 2, reconciliationRequired: true });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
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

  it("rejects secret-bearing fields and never creates or writes KnowledgeStore tables", async () => {
    const ledger = ledgerFor("ledger-secret-isolation");
    await expect(Promise.resolve().then(() => createTask(ledger, {
      task: { ...task(), apiKey: "must-not-persist" }, idempotencyKey: "task-secret-0001", inputHash: "c".repeat(64), now,
    }))).rejects.toThrow(/sensitive field/);
    await createTask(ledger, { task: task(), idempotencyKey: "task-safe-0001", inputHash: "d".repeat(64), now });
    await expect(Promise.resolve().then(() => ledger.recordMessage({
      messageId: "msg-secret-0001", taskId: "task-0001", inputHash: "e".repeat(64),
      envelope: { token: "must-not-persist" }, now,
    }))).rejects.toThrow(/sensitive field/);
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
    taskId: "task-0001", eventType: "task.created", payload: { taskId: "task-0001" }, workerId: "agent:worker-1", workerAssertion: await createWorkerAssertion({ subject: "agent:worker-1", role: "agent", operation: "enqueueOutbox", nowMs: now }), now,
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
