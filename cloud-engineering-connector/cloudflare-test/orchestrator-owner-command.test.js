import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
import { createScheduledWorkerAssertion } from "../orchestrator-worker-identity.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";
import { consumeOrchestratorOutbox, processOrchestratorOutbox } from "../worker.js";

const now = 1_800_000_000_000;
const ownerId = "335530603";
const repositoryId = 1398846697;
const ownerKeySet = JSON.stringify({
  "owner-v1": "3031323334353637383961626364656630313233343536373839616263646566",
});
const workerKey = Uint8Array.from(
  "3031323334353637383961626364656630313233343536373839616263646566".match(/../g),
  byte => Number.parseInt(byte, 16),
);
async function workerAssertion(subject, role, operation, at = now) {
  const claims = {
    v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger",
    sub: subject, role, op: operation, iat: Math.floor(at / 1000),
    exp: Math.floor(at / 1000) + 60, jti: "worker-jti-" + crypto.randomUUID(),
  };
  const payload = btoa(String.fromCharCode(...new TextEncoder().encode(canonicalJson(claims))))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const input = "v1.test-v1." + payload;
  const key = await crypto.subtle.importKey("raw", workerKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  const encoded = btoa(String.fromCharCode(...signature)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return input + "." + encoded;
}
function assertionJti(token) {
  const payload = token.split(".")[2].replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(payload + "=".repeat((4 - payload.length % 4) % 4));
  return JSON.parse(decoded).jti;
}
function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}
const task = (taskId = "task-owner-0001") => ({
  taskId, state: "SCHEDULED", version: 1, agentRound: 0,
  createdAt: now, updatedAt: now, executorId: "agent:worker-1",
  commitSha: "a".repeat(40), objective: "owner command test",
});
async function createTask(ledger, taskValue = task()) {
  return ledger.createTask({
    task: taskValue, idempotencyKey: "owner-task-create-" + taskValue.taskId,
    inputHash: "b".repeat(64), now,
    workerId: "orchestrator-scheduler",
    workerAssertion: await workerAssertion("orchestrator-scheduler", "system", "createTask"),
  });
}
async function ownerInput(overrides = {}) {
  const command = {
    operation: "cancel", taskId: "task-owner-0001",
    reason: "Owner requested cancellation", eventId: "owner-event-0001",
  };
  Object.assign(command, overrides.command);
  const context = {
    actorId: ownerId, repositoryId, taskId: command.taskId,
    operation: command.operation, deliveryId: overrides.deliveryId ?? "delivery-owner-00000001",
    commentId: overrides.commentId ?? "123456789",
    commandHash: await sha256Canonical({ eventId: command.eventId, operation: command.operation, reason: command.reason, taskId: command.taskId }),
  };
  const assertion = await createOwnerAssertion(ownerKeySet, "owner-v1", context, now);
  return {
    assertion, assertionContext: context, command,
    bodySha256: overrides.bodySha256 ?? "c".repeat(64),
    provenance: {
      eventName: "issue_comment.created",
      repository: "mohammadrezayaghoobi123-dev/Chat-gpt",
      issueNumber: 7,
      commentCreatedAt: now,
    },
    now: overrides.now ?? now,
  };
}

describe("Owner command atomic Ledger contract", () => {
  it("atomically consumes Owner JTI, claims delivery/comment, cancels task, fences Agent and outbox leases, and appends audit", async () => {
    const ledger = ledgerFor("owner-atomic-cancel");
    await createTask(ledger);
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO orchestrator_outbox_events (event_id, idempotency_key, task_id, event_type, payload_json, status, attempts, lease_worker_id, lease_generation, lease_until, created_at, updated_at, retry_state, next_attempt_at) VALUES (?, ?, ?, ?, ?, 'IN_PROGRESS', 1, ?, 1, ?, ?, ?, 'READY', 0)",
        "owner-outbox-0001", "owner-outbox-key-0001", "task-owner-0001", "task.transitioned",
        JSON.stringify({ state: "SCHEDULED" }), "orchestrator-outbox-publisher", now + 60_000, now, now,
      );
    });
    const result = await ledger.executeOwnerCommand(await ownerInput());
    const stalePublisherClaim = await ledger.claimOutbox({
      workerId: "orchestrator-outbox-publisher",
      workerAssertion: await workerAssertion("orchestrator-outbox-publisher", "publisher", "claimOutbox", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(stalePublisherClaim).toMatchObject({ claimed: false, reason: "NO_OUTBOX_AVAILABLE" });
    expect(result).toMatchObject({
      applied: true, operation: "cancel",
      task: { taskId: "task-owner-0001", state: "CANCELLED", version: 2 },
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts").one().count).toBe(1);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_consumed_assertions").one().count).toBe(1);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_webhook_deliveries").one().count).toBe(1);
      expect(state.storage.sql.exec("SELECT actor_id, actor_role, event_type FROM orchestrator_audit_events").one())
        .toMatchObject({ actor_id: ownerId, actor_role: "owner", event_type: "OWNER_TASK_CANCELLED" });
      expect(state.storage.sql.exec("SELECT lease_generation, worker_id, lease_until FROM orchestrator_execution_leases WHERE task_id = ?", "task-owner-0001").one())
        .toMatchObject({ lease_generation: 1, worker_id: null, lease_until: 0 });
      expect(state.storage.sql.exec("SELECT retry_state, lease_generation, lease_worker_id, lease_until FROM orchestrator_outbox_events WHERE event_id = ?", "owner-outbox-0001").one())
        .toMatchObject({ retry_state: "DEAD_LETTER", lease_generation: 2, lease_worker_id: null, lease_until: 0 });
    });
  });


  it("quarantines a non-terminal task and invalidates its active Agent lease", async () => {
    const ledger = ledgerFor("owner-command-quarantine");
    await createTask(ledger);
    const result = await ledger.executeOwnerCommand(await ownerInput({
      command: { operation: "quarantine", eventId: "owner-event-quarantine-01" },
      deliveryId: "delivery-owner-quarantine-01", commentId: "123456790",
    }));
    expect(result).toMatchObject({
      applied: true, operation: "quarantine",
      task: { taskId: "task-owner-0001", state: "QUARANTINED", version: 2 },
    });
  });

  it("releases only a quarantined task into VALIDATING with a new version", async () => {
    const ledger = ledgerFor("owner-command-release");
    await createTask(ledger, { ...task(), state: "QUARANTINED" });
    const result = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "release",
        reason: "Owner verified remediation", eventId: "owner-event-release-01",
      },
      deliveryId: "delivery-owner-release-01", commentId: "123456791",
    }));
    expect(result).toMatchObject({
      applied: true, operation: "release",
      task: { taskId: "task-owner-0001", state: "VALIDATING", version: 2 },
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      const event = state.storage.sql.exec(
        "SELECT status, payload_json, retry_state FROM orchestrator_outbox_events WHERE event_id = ?",
        "owner-release-owner-event-release-01",
      ).one();
      expect(event.status).toBe("PENDING");
      expect(event.retry_state).toBe("READY");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        taskId: "task-owner-0001", version: 2, from: "QUARANTINED", to: "VALIDATING",
      });
    });
  });

  it("never resurrects a terminal task through an Owner command", async () => {
    const ledger = ledgerFor("owner-command-terminal");
    await createTask(ledger, { ...task(), state: "COMPLETED" });
    const result = await ledger.executeOwnerCommand(await ownerInput({
      command: { eventId: "owner-event-terminal-01" },
      deliveryId: "delivery-owner-terminal-01", commentId: "123456792",
    }));
    expect(result).toMatchObject({ applied: false, conflict: true, reason: "ILLEGAL_OWNER_TRANSITION" });
    expect(await ledger.getTask({ taskId: "task-owner-0001" })).toMatchObject({ state: "COMPLETED", version: 1 });
  });

  it("blocks a Queue receipt created before Owner cancellation even if the message was already published", async () => {
    const ledger = ledgerFor("owner-command-stale-queue-receipt");
    await createTask(ledger);
    const payload = { taskId: "task-owner-0001", version: 1 };
    await ledger.enqueueOutbox({
      eventId: "owner-queued-before-cancel-01",
      idempotencyKey: "owner-queued-before-cancel-key-01",
      taskId: "task-owner-0001",
      eventType: "task.transitioned",
      payload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox"),
      now,
    });
    await ledger.executeOwnerCommand(await ownerInput());
    const consumerId = "orchestrator-outbox-consumer";
    const receipt = await ledger.recordOutboxReceipt({
      eventId: "owner-queued-before-cancel-01",
      eventType: "task.transitioned",
      idempotencyKey: "owner-queued-before-cancel-key-01",
      taskId: "task-owner-0001",
      payload,
      createdAt: now,
      schemaVersion: 1,
      envelopeSha256: "d".repeat(64),
      consumerId,
      workerAssertion: await workerAssertion(consumerId, "consumer", "recordOutboxReceipt", now + 1),
      now: now + 1,
    });
    expect(receipt).toMatchObject({ recorded: false, blocked: true, reason: "TASK_VERSION_FENCED" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?", "owner-queued-before-cancel-01").one().count).toBe(0);
    });
  });

  it("derives task state and version from its own Ledger snapshot, not caller-supplied CAS fields", async () => {
    const ledger = ledgerFor("owner-command-ledger-derived-cas");
    await createTask(ledger);
    const input = await ownerInput();
    const { expectedState: _expectedState, expectedVersion: _expectedVersion, ...semanticCommand } = input.command;
    const result = await ledger.executeOwnerCommand({ ...input, command: semanticCommand });
    expect(result).toMatchObject({
      applied: true, operation: "cancel",
      task: { taskId: "task-owner-0001", state: "CANCELLED", version: 2 },
    });
  });

  it("returns the exact stored result for a replay without a second transition or audit event", async () => {
    const ledger = ledgerFor("owner-command-replay");
    await createTask(ledger);
    const input = await ownerInput();
    const first = await ledger.executeOwnerCommand(input);
    const replay = await ledger.executeOwnerCommand(input);
    expect(first).toMatchObject({ applied: true });
    expect(replay).toMatchObject({ applied: true, replay: true, task: { version: 2, state: "CANCELLED" } });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(1);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts").one().count).toBe(1);
    });
  });

  it("rejects caller-supplied expected state/version overrides before mutation", async () => {
    const ledger = ledgerFor("owner-command-stale-version");
    await createTask(ledger);
    const input = await ownerInput({ command: { expectedVersion: 99 } });
    const result = await ledger.executeOwnerCommand(input);
    expect(result).toMatchObject({ applied: false, reason: "INVALID_OWNER_COMMAND" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT state, version FROM orchestrator_tasks WHERE task_id = ?", "task-owner-0001").one())
        .toMatchObject({ state: "SCHEDULED", version: 1 });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts").one().count).toBe(0);
    });
  });

  it("rejects an assertion replayed under a different delivery or command context", async () => {
    const ledger = ledgerFor("owner-command-context-replay");
    await createTask(ledger);
    const input = await ownerInput();
    await ledger.executeOwnerCommand(input);
    await expect(ledger.executeOwnerCommand({
      ...input, assertionContext: { ...input.assertionContext, deliveryId: "delivery-owner-00000002" },
    })).resolves.toMatchObject({ applied: false, reason: "OWNER_ASSERTION_REJECTED" });
  });

  it("rolls back delivery, JTI, task, and receipt when the audit insert fails", async () => {
    const ledger = ledgerFor("owner-command-atomic-rollback");
    await createTask(ledger);
    const input = await ownerInput();
    await runInDurableObject(ledger, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_owner_audit_insert
        BEFORE INSERT ON orchestrator_audit_events
        WHEN NEW.event_type LIKE 'OWNER_%'
        BEGIN
          SELECT RAISE(ABORT, 'injected owner audit failure');
        END
      `);
    });
    await expect(ledger.executeOwnerCommand(input)).resolves.toMatchObject({ applied: false, reason: "LEDGER_TRANSACTION_FAILED" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_webhook_deliveries").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_consumed_assertions").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT state, version FROM orchestrator_tasks WHERE task_id = ?", "task-owner-0001").one())
        .toMatchObject({ state: "SCHEDULED", version: 1 });
    });
  });

  it.each([
    ["cancel", "CANCELLED"],
    ["quarantine", "QUARANTINED"],
  ])("linearizes duplicate Queue consumers against concurrent Owner %s", async (operation, expectedState) => {
    const taskId = `task-owner-race-${operation}`;
    const ledger = ledgerFor(`owner-receipt-race-${operation}`);
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const eventId = `owner-race-${operation}-outbox-01`;
    const idempotencyKey = `owner-race-${operation}-key-01`;
    const payload = { taskId, version: 1, from: "READY", to: "SCHEDULED" };
    const enqueued = await ledger.enqueueOutbox({
      eventId,
      idempotencyKey,
      taskId,
      eventType: "task.transitioned",
      payload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox"),
      now,
    });
    expect(enqueued).toMatchObject({ enqueued: true });

    const body = {
      attempts: 1,
      createdAt: now,
      eventId,
      eventType: "task.transitioned",
      idempotencyKey,
      payload,
      schemaVersion: 1,
      taskId,
    };
    const makeQueueMessage = () => ({
      body: structuredClone(body),
      ackCalls: 0,
      retryCalls: 0,
      ack() { this.ackCalls += 1; },
      retry() { this.retryCalls += 1; },
    });
    const messages = [makeQueueMessage(), makeQueueMessage()];
    const consumerEnv = {
      ORCHESTRATOR_LEDGER: {
        idFromName: () => `owner-receipt-race-${operation}`,
        get: () => ledger,
      },
      LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
      LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test-v1",
    };
    const ownerCommand = await ownerInput({
      command: {
        operation,
        taskId,
        eventId: `owner-race-${operation}-command-01`,
      },
      deliveryId: `delivery-owner-race-${operation}-01`,
      commentId: operation === "cancel" ? "123456793" : "123456794",
    });

    const [firstConsumer, secondConsumer, ownerResult] = await Promise.all([
      consumeOrchestratorOutbox({ messages: [messages[0]] }, consumerEnv),
      consumeOrchestratorOutbox({ messages: [messages[1]] }, consumerEnv),
      ledger.executeOwnerCommand(ownerCommand),
    ]);

    expect(ownerResult).toMatchObject({
      applied: true,
      operation,
      task: { taskId, state: expectedState, version: 2 },
    });
    expect(firstConsumer).toMatchObject({ received: 1, acknowledged: 1, retried: 0 });
    expect(secondConsumer).toMatchObject({ received: 1, acknowledged: 1, retried: 0 });
    expect(messages).toEqual([
      expect.objectContaining({ ackCalls: 1, retryCalls: 0 }),
      expect.objectContaining({ ackCalls: 1, retryCalls: 0 }),
    ]);
    expect(await ledger.getTask({ taskId })).toMatchObject({
      taskId, state: expectedState, version: 2,
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      const receipts = state.storage.sql.exec(
        "SELECT event_id, event_type, schema_version, envelope_sha256, consumer_id FROM orchestrator_outbox_receipts WHERE event_id = ?",
        eventId,
      ).toArray();
      // Linearization is intentionally nondeterministic: both consumers may
      // commit before Owner, or both may observe Owner's fence. A partially
      // committed or duplicate receipt is never a valid outcome.
      expect(receipts.length).toBeLessThanOrEqual(1);
      if (receipts.length === 1) {
        expect(receipts[0]).toMatchObject({
          event_id: eventId,
          event_type: "task.transitioned",
          schema_version: 1,
          consumer_id: "orchestrator-outbox-consumer",
        });
        expect(receipts[0].envelope_sha256).toMatch(/^[a-f0-9]{64}$/);
      }

      expect(state.storage.sql.exec(
        "SELECT retry_state, lease_generation, lease_worker_id, lease_until FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one()).toMatchObject({
        retry_state: "DEAD_LETTER",
        lease_generation: 1,
        lease_worker_id: null,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ? AND operation = ?",
        taskId, operation,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type = ?",
        taskId, operation === "cancel" ? "OWNER_TASK_CANCELLED" : "OWNER_TASK_QUARANTINED",
      ).one().count).toBe(1);
    });
  });


  it("blocks a version-1 Queue delivery arriving after quarantine and release while accepting the release version", async () => {
    const taskId = "task-owner-late-delivery-0001";
    const ledger = ledgerFor("owner-late-delivery-after-release");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const staleEventId = "owner-late-delivery-stale-event-01";
    const staleDedupeId = "owner-late-delivery-stale-dedupe-01";
    const stalePayload = { taskId, version: 1, from: "READY", to: "SCHEDULED" };
    const enqueued = await ledger.enqueueOutbox({
      eventId: staleEventId,
      idempotencyKey: staleDedupeId,
      taskId,
      eventType: "task.transitioned",
      payload: stalePayload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox"),
      now,
    });
    expect(enqueued).toMatchObject({ enqueued: true });

    const queuedBodies = [];
    const binding = {
      idFromName: () => "orchestrator-ledger-global",
      get: () => ledger,
    };
    const runtimeEnv = {
      ORCHESTRATOR_LEDGER: binding,
      ORCHESTRATOR_OUTBOX_QUEUE: {
        send: async message => queuedBodies.push(structuredClone(message)),
      },
      LEDGER_WORKER_ASSERTION_KEYS: env.LEDGER_WORKER_ASSERTION_KEYS,
      LEDGER_WORKER_ASSERTION_ACTIVE_KID: "test-v1",
    };

    const publishedBeforeQuarantine = await processOrchestratorOutbox(runtimeEnv, { maxEvents: 1 });
    expect(publishedBeforeQuarantine).toMatchObject({
      processed: 1, published: 1, failed: 0, completionPending: 0,
    });
    expect(queuedBodies).toHaveLength(1);
    expect(queuedBodies[0]).toMatchObject({
      eventId: staleEventId,
      payload: stalePayload,
      attempts: 1,
    });

    const quarantined = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "quarantine",
        taskId,
        eventId: "owner-late-delivery-quarantine-01",
      },
      deliveryId: "delivery-late-delivery-quarantine-01",
      commentId: "123456797",
    }));
    expect(quarantined).toMatchObject({
      applied: true,
      task: { taskId, state: "QUARANTINED", version: 2 },
    });

    const released = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "release",
        taskId,
        eventId: "owner-late-delivery-release-01",
      },
      deliveryId: "delivery-late-delivery-release-01",
      commentId: "123456798",
    }));
    expect(released).toMatchObject({
      applied: true,
      task: { taskId, state: "VALIDATING", version: 3 },
    });

    const publishedAfterRelease = await processOrchestratorOutbox(runtimeEnv, { maxEvents: 1 });
    expect(publishedAfterRelease).toMatchObject({
      processed: 1, published: 1, failed: 0, completionPending: 0,
    });
    expect(queuedBodies).toHaveLength(2);
    expect(queuedBodies[1]).toMatchObject({
      eventId: "owner-release-owner-late-delivery-release-01",
      eventType: "task.transitioned",
      payload: { taskId, version: 3, from: "QUARANTINED", to: "VALIDATING" },
    });

    const messages = queuedBodies.map(body => ({
      body,
      ackCalls: 0,
      retryCalls: 0,
      ack() { this.ackCalls += 1; },
      retry() { this.retryCalls += 1; },
    }));
    const consumed = await consumeOrchestratorOutbox({ messages }, runtimeEnv);
    expect(consumed).toMatchObject({
      received: 2, acknowledged: 2, retried: 0, duplicates: 0,
    });
    expect(messages).toEqual([
      expect.objectContaining({ ackCalls: 1, retryCalls: 0 }),
      expect.objectContaining({ ackCalls: 1, retryCalls: 0 }),
    ]);
    expect(await ledger.getTask({ taskId })).toMatchObject({
      taskId, state: "VALIDATING", version: 3,
    });

    const staleReceipt = await ledger.recordOutboxReceipt({
      eventId: staleEventId,
      eventType: "task.transitioned",
      idempotencyKey: staleDedupeId,
      taskId,
      payload: stalePayload,
      createdAt: now,
      schemaVersion: 1,
      envelopeSha256: "a".repeat(64),
      consumerId: "orchestrator-outbox-consumer",
      workerAssertion: await workerAssertion(
        "orchestrator-outbox-consumer", "consumer", "recordOutboxReceipt", now + 1,
      ),
      now: now + 1,
    });
    expect(staleReceipt).toMatchObject({
      recorded: false, blocked: true, reason: "TASK_VERSION_FENCED",
    });

    const reboundReceipt = await ledger.recordOutboxReceipt({
      eventId: staleEventId,
      eventType: "task.transitioned",
      idempotencyKey: "rebound",
      taskId,
      payload: { taskId, version: 3, from: "QUARANTINED", to: "VALIDATING" },
      createdAt: now,
      schemaVersion: 1,
      envelopeSha256: "b".repeat(64),
      consumerId: "orchestrator-outbox-consumer",
      workerAssertion: await workerAssertion(
        "orchestrator-outbox-consumer", "consumer", "recordOutboxReceipt", now + 2,
      ),
      now: now + 2,
    });
    expect(reboundReceipt).toMatchObject({
      recorded: false, reason: "OUTBOX_SOURCE_NOT_FOUND",
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
        staleEventId,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_receipts WHERE event_id = ?",
        "owner-release-owner-late-delivery-release-01",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT status FROM orchestrator_outbox_events WHERE event_id = ?",
        staleEventId,
      ).one().status).toBe("COMPLETED");
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ?",
        taskId,
      ).one().count).toBe(2);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type IN ('OWNER_TASK_QUARANTINED','OWNER_TASK_RELEASED')",
        taskId,
      ).one().count).toBe(2);
    });
  });

  it("rejects rebinding an existing Outbox eventId or idempotency key to changed content after release", async () => {
    const taskId = "task-owner-event-rebind-0001";
    const ledger = ledgerFor("owner-event-rebind-after-release");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const eventId = "owner-event-rebind-original-01";
    const idempotencyKey = "owner-event-rebind-original-dedupe-01";
    const originalPayload = { taskId, version: 1, from: "READY", to: "SCHEDULED" };
    const original = await ledger.enqueueOutbox({
      eventId,
      idempotencyKey,
      taskId,
      eventType: "task.transitioned",
      payload: originalPayload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox"),
      now,
    });
    expect(original).toMatchObject({ enqueued: true });

    expect(await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "quarantine",
        taskId,
        eventId: "owner-event-rebind-quarantine-01",
      },
      deliveryId: "delivery-event-rebind-quarantine-01",
      commentId: "123456799",
    }))).toMatchObject({
      applied: true, task: { taskId, state: "QUARANTINED", version: 2 },
    });
    expect(await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "release",
        taskId,
        eventId: "owner-event-rebind-release-01",
      },
      deliveryId: "delivery-event-rebind-release-01",
      commentId: "123456800",
    }))).toMatchObject({
      applied: true, task: { taskId, state: "VALIDATING", version: 3 },
    });

    const changedPayload = { taskId, version: 3, from: "QUARANTINED", to: "VALIDATING" };
    const reusedEventId = await ledger.enqueueOutbox({
      eventId,
      idempotencyKey: "owner-event-rebind-new-key-01",
      taskId,
      eventType: "task.transitioned",
      payload: changedPayload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox", now + 1),
      now: now + 1,
    });
    expect(reusedEventId).toMatchObject({
      enqueued: false, conflict: true, reason: "EVENT_ID_CONFLICT",
    });

    const reusedIdempotencyKey = await ledger.enqueueOutbox({
      eventId: "owner-event-rebind-new-event-01",
      idempotencyKey,
      taskId,
      eventType: "task.transitioned",
      payload: changedPayload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox", now + 2),
      now: now + 2,
    });
    expect(reusedIdempotencyKey).toMatchObject({
      enqueued: false, conflict: true, reason: "IDEMPOTENCY_CONFLICT",
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      const originalRow = state.storage.sql.exec(
        "SELECT event_id, idempotency_key, payload_json FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one();
      expect(originalRow).toMatchObject({
        event_id: eventId,
        idempotency_key: idempotencyKey,
      });
      expect(JSON.parse(originalRow.payload_json)).toEqual(originalPayload);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
        "owner-event-rebind-new-event-01",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE event_id = ?",
        eventId,
      ).one().count).toBe(1);
    });
  });


  it("fences a stale Worker lease across concurrent renewal, Owner quarantine, and release", async () => {
    const taskId = "task-owner-lease-revocation-0001";
    const workerId = "agent:worker-1";
    const ledger = ledgerFor("owner-lease-revocation-fencing");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const originalClaim = await ledger.claimTask({
      taskId,
      workerId,
      workerAssertion: await workerAssertion(workerId, "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(originalClaim).toMatchObject({
      claimed: true,
      task: { taskId, state: "SCHEDULED", version: 1 },
      leaseGeneration: 1,
    });

    const raceRenewalAssertion = await workerAssertion(workerId, "agent", "renewLease", now + 2);
    const quarantineCommand = await ownerInput({
      command: {
        operation: "quarantine",
        taskId,
        eventId: "owner-lease-revoke-quarantine-01",
      },
      deliveryId: "delivery-lease-revoke-quarantine-01",
      commentId: "123456801",
      now: now + 2,
    });
    const [renewalDuringQuarantine, quarantine] = await Promise.all([
      ledger.renewLease({
        taskId,
        workerId,
        workerAssertion: raceRenewalAssertion,
        leaseGeneration: originalClaim.leaseGeneration,
        leaseMs: 30_000,
        now: now + 2,
      }),
      ledger.executeOwnerCommand(quarantineCommand),
    ]);

    if (renewalDuringQuarantine.renewed === true) {
      expect(renewalDuringQuarantine).toMatchObject({ renewed: true, leaseGeneration: 1 });
    } else {
      expect(renewalDuringQuarantine).toMatchObject({
        renewed: false, reason: "LEASE_FENCE_MISMATCH",
      });
    }
    expect(quarantine).toMatchObject({
      applied: true,
      operation: "quarantine",
      task: { taskId, state: "QUARANTINED", version: 2 },
    });

    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 2,
        lease_until: 0,
      });
    });

    const release = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "release",
        taskId,
        eventId: "owner-lease-revoke-release-01",
      },
      deliveryId: "delivery-lease-revoke-release-01",
      commentId: "123456802",
      now: now + 3,
    }));
    expect(release).toMatchObject({
      applied: true,
      operation: "release",
      task: { taskId, state: "VALIDATING", version: 3 },
    });

    const staleRenewAssertion = await workerAssertion(workerId, "agent", "renewLease", now + 4);
    const staleReleaseAssertion = await workerAssertion(workerId, "agent", "releaseLease", now + 4);
    const staleTransitionAssertion = await workerAssertion(workerId, "agent", "transitionTask", now + 4);
    const postReleaseClaimAssertion = await workerAssertion(workerId, "agent", "claimTask", now + 4);
    const staleJtis = [
      assertionJti(staleRenewAssertion),
      assertionJti(staleReleaseAssertion),
      assertionJti(staleTransitionAssertion),
      assertionJti(postReleaseClaimAssertion),
    ];

    const staleResults = await Promise.all([
      ledger.renewLease({
        taskId, workerId, workerAssertion: staleRenewAssertion,
        leaseGeneration: originalClaim.leaseGeneration, leaseMs: 30_000, now: now + 4,
      }),
      ledger.releaseLease({
        taskId, workerId, workerAssertion: staleReleaseAssertion,
        leaseGeneration: originalClaim.leaseGeneration, now: now + 4,
      }),
      ledger.transitionTask({
        taskId,
        expectedVersion: 3,
        expectedState: "VALIDATING",
        nextState: "READY",
        actor: { id: workerId, role: "agent" },
        evidence: {},
        now: now + 4,
        workerId,
        workerAssertion: staleTransitionAssertion,
        leaseGeneration: originalClaim.leaseGeneration,
      }),
      ledger.claimTask({
        taskId,
        workerId,
        workerAssertion: postReleaseClaimAssertion,
        leaseMs: 30_000,
        now: now + 4,
      }),
    ]);

    expect(staleResults[0]).toMatchObject({
      renewed: false, reason: "LEASE_FENCE_MISMATCH",
    });
    expect(staleResults[1]).toMatchObject({
      released: false, reason: "LEASE_FENCE_MISMATCH",
    });
    expect(staleResults[2]).toMatchObject({
      updated: false, reason: "LEASE_FENCE_MISMATCH",
    });
    // Owner release moves the task to VALIDATING. That state is deliberately
    // not claimable by the task-execution worker; no new lease may be fabricated.
    expect(staleResults[3]).toMatchObject({
      claimed: false, reason: "NO_TASK_AVAILABLE",
    });

    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId, state: "VALIDATING", version: 3, agentRound: 0,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 3,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti IN (?, ?, ?, ?)",
        ...staleJtis,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ?",
        taskId,
      ).one().count).toBe(2);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type IN ('OWNER_TASK_QUARANTINED','OWNER_TASK_RELEASED')",
        taskId,
      ).one().count).toBe(2);
    });
  });

  it("keeps a released task fail-closed until a trusted validation authority exists", async () => {
    const taskId = "task-owner-validation-authority-gap-0001";
    const workerId = "agent:worker-1";
    const ledger = ledgerFor("owner-validation-authority-gap");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const claim = await ledger.claimTask({
      taskId,
      workerId,
      workerAssertion: await workerAssertion(workerId, "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(claim).toMatchObject({ claimed: true, leaseGeneration: 1 });

    const quarantine = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "quarantine",
        taskId,
        eventId: "owner-validation-gap-quarantine-01",
      },
      deliveryId: "delivery-validation-gap-quarantine-01",
      commentId: "123456803",
      now: now + 2,
    }));
    expect(quarantine).toMatchObject({
      applied: true,
      task: { taskId, state: "QUARANTINED", version: 2 },
    });

    const release = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "release",
        taskId,
        eventId: "owner-validation-gap-release-01",
      },
      deliveryId: "delivery-validation-gap-release-01",
      commentId: "123456804",
      now: now + 3,
    }));
    expect(release).toMatchObject({
      applied: true,
      task: { taskId, state: "VALIDATING", version: 3 },
    });

    const postReleaseClaimAssertion = await workerAssertion(
      workerId, "agent", "claimTask", now + 4,
    );
    const postReleaseClaimJti = assertionJti(postReleaseClaimAssertion);
    const postReleaseClaim = await ledger.claimTask({
      taskId,
      workerId,
      workerAssertion: postReleaseClaimAssertion,
      leaseMs: 30_000,
      now: now + 4,
    });
    expect(postReleaseClaim).toMatchObject({
      claimed: false,
      reason: "NO_TASK_AVAILABLE",
    });

    await expect(createScheduledWorkerAssertion(
      env.LEDGER_WORKER_ASSERTION_KEYS,
      "test-v1",
      {
        subject: "orchestrator-scheduler",
        role: "agent",
        operation: "transitionTask",
        nowMs: now + 4,
      },
    )).rejects.toMatchObject({ code: "AUTHENTICATED_WORKER_REQUIRED" });

    const schedulerAssertion = await createScheduledWorkerAssertion(
      env.LEDGER_WORKER_ASSERTION_KEYS,
      "test-v1",
      {
        subject: "orchestrator-scheduler",
        role: "system",
        operation: "createTask",
        nowMs: now + 4,
      },
    );
    const schedulerJti = assertionJti(schedulerAssertion);
    const schedulerTransition = await ledger.transitionTask({
      taskId,
      expectedVersion: 3,
      expectedState: "VALIDATING",
      nextState: "READY",
      actor: {
        id: "orchestrator-scheduler",
        role: "agent",
        authenticated: true,
        identityVerified: true,
      },
      evidence: { ownerResolutionId: "owner-validation-gap-release-01" },
      now: now + 4,
      workerId: "orchestrator-scheduler",
      workerAssertion: schedulerAssertion,
      leaseGeneration: 3,
    });
    expect(schedulerTransition).toMatchObject({
      updated: false,
      reason: "AUTHENTICATED_WORKER_REQUIRED",
    });

    await expect(createScheduledWorkerAssertion(
      env.LEDGER_WORKER_ASSERTION_KEYS,
      env.LEDGER_WORKER_ASSERTION_ACTIVE_KID,
      {
        subject: "orchestrator-validator",
        role: "validator",
        operation: "validateReleasedTask",
        nowMs: now + 4,
      },
    )).rejects.toMatchObject({ code: "AUTHENTICATED_WORKER_REQUIRED" });

    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: "VALIDATING",
      version: 3,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 3,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        schedulerJti,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        postReleaseClaimJti,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type IN ('OWNER_TASK_QUARANTINED','OWNER_TASK_RELEASED')",
        taskId,
      ).one().count).toBe(2);
    });
  });


  it("does not let a reauthenticated former lease owner use the post-release generation to renew or promote a task", async () => {
    const taskId = "task-owner-fresh-assertion-after-release-0001";
    const workerId = "agent:worker-1";
    const ledger = ledgerFor("owner-fresh-assertion-after-release");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const originalClaim = await ledger.claimTask({
      taskId,
      workerId,
      workerAssertion: await workerAssertion(workerId, "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(originalClaim).toMatchObject({
      claimed: true,
      leaseGeneration: 1,
    });

    const quarantine = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "quarantine",
        taskId,
        eventId: "owner-fresh-assertion-quarantine-01",
      },
      deliveryId: "delivery-fresh-assertion-quarantine-01",
      commentId: "123456805",
      now: now + 2,
    }));
    expect(quarantine).toMatchObject({
      applied: true,
      task: { taskId, state: "QUARANTINED", version: 2 },
    });

    const release = await ledger.executeOwnerCommand(await ownerInput({
      command: {
        operation: "release",
        taskId,
        eventId: "owner-fresh-assertion-release-01",
      },
      deliveryId: "delivery-fresh-assertion-release-01",
      commentId: "123456806",
      now: now + 3,
    }));
    expect(release).toMatchObject({
      applied: true,
      task: { taskId, state: "VALIDATING", version: 3 },
    });

    const freshRenewAssertion = await workerAssertion(
      workerId, "agent", "renewLease", now + 4,
    );
    const freshTransitionAssertion = await workerAssertion(
      workerId, "agent", "transitionTask", now + 4,
    );
    const freshJtis = [
      assertionJti(freshRenewAssertion),
      assertionJti(freshTransitionAssertion),
    ];

    // Adversarially submit the current post-release generation, not the
    // stale generation from the former Lease. Fresh authentication must not
    // recreate ownership after Owner release cleared worker_id and lease_until.
    const [renewal, transition] = await Promise.all([
      ledger.renewLease({
        taskId,
        workerId,
        workerAssertion: freshRenewAssertion,
        leaseGeneration: 3,
        leaseMs: 30_000,
        now: now + 4,
      }),
      ledger.transitionTask({
        taskId,
        expectedVersion: 3,
        expectedState: "VALIDATING",
        nextState: "READY",
        actor: {
          id: workerId,
          role: "agent",
          authenticated: true,
          identityVerified: true,
        },
        evidence: {
          validationOutcome: "PASS",
          evidenceDigest: "e".repeat(64),
          validationRunId: "untrusted-validation-run-01",
        },
        now: now + 4,
        workerId,
        workerAssertion: freshTransitionAssertion,
        leaseGeneration: 3,
      }),
    ]);

    expect(renewal).toMatchObject({
      renewed: false,
      reason: "LEASE_FENCE_MISMATCH",
    });
    expect(transition).toMatchObject({
      updated: false,
      reason: "LEASE_FENCE_MISMATCH",
    });

    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: "VALIDATING",
      version: 3,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 3,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti IN (?, ?)",
        ...freshJtis,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ?",
        taskId,
      ).one().count).toBe(2);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ?",
        taskId,
      ).one().count).toBe(2);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_outbox_events WHERE task_id = ?",
        taskId,
      ).one().count).toBe(1);
    });
  });


  it("linearizes an active Agent transition against Owner quarantine without leaving a runnable task", async () => {
    const taskId = "task-owner-transition-linearization-0001";
    const workerId = "agent:worker-1";
    const ledger = ledgerFor("owner-transition-linearization-race");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const claim = await ledger.claimTask({
      taskId,
      workerId,
      workerAssertion: await workerAssertion(workerId, "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(claim).toMatchObject({ claimed: true, leaseGeneration: 1 });

    const transitionAssertion = await workerAssertion(
      workerId, "agent", "transitionTask", now + 2,
    );
    const transitionJti = assertionJti(transitionAssertion);
    const quarantineCommand = await ownerInput({
      command: {
        operation: "quarantine",
        taskId,
        eventId: "owner-transition-linearization-quarantine-01",
      },
      deliveryId: "delivery-transition-linearization-quarantine-01",
      commentId: "123456807",
      now: now + 2,
    });

    // Hold the Owner's audit hash after its optimistic task snapshot but before
    // its transaction. This forces the otherwise narrow stale-snapshot window:
    // Agent commits v2 while Owner still holds its v1 snapshot.
    let releaseOwnerAuditDigest;
    let signalOwnerAuditDigest;
    let heldOwnerAuditDigest = false;
    const ownerAuditDigestReached = new Promise(resolve => {
      signalOwnerAuditDigest = resolve;
    });
    const ownerAuditDigestGate = new Promise(resolve => {
      releaseOwnerAuditDigest = resolve;
    });
    let transition;
    let quarantine;
    await runInDurableObject(ledger, async instance => {
      // Install the gate inside the Durable Object context. WebCrypto objects
      // are context-bound by the Workers runtime and must not cross DO contexts.
      const originalDigest = crypto.subtle.digest;
      const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async function (algorithm, data) {
        const serialized = new TextDecoder().decode(data);
        if (!heldOwnerAuditDigest &&
            serialized.includes('"eventType":"OWNER_TASK_QUARANTINED"') &&
            serialized.includes("owner-transition-linearization-quarantine-01")) {
          heldOwnerAuditDigest = true;
          signalOwnerAuditDigest();
          await ownerAuditDigestGate;
        }
        return Reflect.apply(originalDigest, this, [algorithm, data]);
      });
      try {
        const quarantinePromise = instance.executeOwnerCommand(quarantineCommand);
        await ownerAuditDigestReached;
        transition = await instance.transitionTask({
          taskId,
          expectedVersion: 1,
          expectedState: "SCHEDULED",
          nextState: "RUNNING",
          actor: {
            id: workerId,
            role: "agent",
            authenticated: true,
            identityVerified: true,
          },
          evidence: { executionStartedAt: now + 2 },
          now: now + 2,
          workerId,
          workerAssertion: transitionAssertion,
          leaseGeneration: claim.leaseGeneration,
        });
        releaseOwnerAuditDigest();
        quarantine = await quarantinePromise;
      } finally {
        releaseOwnerAuditDigest?.();
        digestSpy.mockRestore();
      }
    });

    // The gate forces the stale-snapshot history: Agent commits RUNNING v2
    // after Owner's v1 snapshot, then Owner must retry and quarantine v3.
    expect(transition).toMatchObject({
      updated: true,
      task: { taskId, state: "RUNNING", version: 2 },
    });
    expect(quarantine).toMatchObject({
      applied: true,
      operation: "quarantine",
      task: { taskId, state: "QUARANTINED", version: 3 },
    });

    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: "QUARANTINED",
      version: 3,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 2,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        transitionJti,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ? AND operation = 'quarantine'",
        taskId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_audit_events WHERE task_id = ? AND event_type = 'OWNER_TASK_QUARANTINED'",
        taskId,
      ).one().count).toBe(1);
    });
  });


  it("retries Owner cancellation from a fresh task snapshot when an Agent transition commits after the initial read", async () => {
    const taskId = "task-owner-cancel-transition-linearizability-0001";
    const workerId = "agent:worker-1";
    const ledger = ledgerFor("owner-cancel-transition-linearizability");
    await createTask(ledger, { ...task(taskId), state: "SCHEDULED" });

    const claim = await ledger.claimTask({
      taskId,
      workerId,
      workerAssertion: await workerAssertion(workerId, "agent", "claimTask", now + 1),
      leaseMs: 30_000,
      now: now + 1,
    });
    expect(claim).toMatchObject({ claimed: true, leaseGeneration: 1 });

    const ownerCommand = await ownerInput({
      command: {
        operation: "cancel",
        taskId,
        reason: "Owner cancelled during Agent transition",
        eventId: "owner-transition-cancel-race-01",
      },
      deliveryId: "delivery-transition-cancel-race-01",
      commentId: "123456807",
      now: now + 3,
    });
    const transitionAssertion = await workerAssertion(
      workerId, "agent", "transitionTask", now + 3,
    );
    const transitionJti = assertionJti(transitionAssertion);

    // Pause on the actual Owner cancellation audit hash, which is computed
    // after the task snapshot and before the Owner write transaction. Matching
    // semantic audit fields avoids depending on an internal digest call count.
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let ownerAuditHashPaused = false;
    let releaseOwnerDigest;
    let signalOwnerSnapshot;
    const ownerDigestGate = new Promise(resolve => {
      releaseOwnerDigest = resolve;
    });
    const ownerSnapshotReached = new Promise(resolve => {
      signalOwnerSnapshot = resolve;
    });
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      const digestInput = new TextDecoder().decode(data);
      if (!ownerAuditHashPaused &&
          digestInput.includes('"eventId":"owner-owner-transition-cancel-race-01"') &&
          digestInput.includes('"eventType":"OWNER_TASK_CANCELLED"')) {
        ownerAuditHashPaused = true;
        signalOwnerSnapshot();
        await ownerDigestGate;
      }
      return originalDigest(algorithm, data);
    });

    let transition;
    let cancellation;
    try {
      const raceResult = await runInDurableObject(ledger, async instance => {
        const ownerPromise = instance.executeOwnerCommand(ownerCommand);
        const barrierState = await Promise.race([
          ownerSnapshotReached.then(() => "owner-snapshot-paused"),
          ownerPromise.then(() => "owner-finished-before-snapshot-barrier"),
        ]);
        expect(barrierState).toBe("owner-snapshot-paused");

        const agentTransition = await instance.transitionTask({
          taskId,
          expectedVersion: 1,
          expectedState: "SCHEDULED",
          nextState: "RUNNING",
          actor: {
            id: workerId,
            role: "agent",
            authenticated: true,
            identityVerified: true,
          },
          evidence: {},
          now: now + 3,
          workerId,
          workerAssertion: transitionAssertion,
          leaseGeneration: 1,
          outboxEvent: {
            eventId: "agent-transition-before-owner-cancel-01",
            idempotencyKey: "agent-transition-before-owner-cancel-key-01",
            eventType: "task.running",
            payload: { taskId, version: 2 },
          },
        });
        releaseOwnerDigest();
        const ownerCancellation = await ownerPromise;
        return { transition: agentTransition, cancellation: ownerCancellation };
      });
      transition = raceResult.transition;
      cancellation = raceResult.cancellation;
    } finally {
      releaseOwnerDigest();
      digestSpy.mockRestore();
    }

    expect(transition).toMatchObject({
      updated: true,
      task: { taskId, state: "RUNNING", version: 2 },
      outbox: { enqueued: true },
    });
    expect(cancellation).toMatchObject({
      applied: true,
      operation: "cancel",
      task: { taskId, state: "CANCELLED", version: 3 },
    });
    expect(ownerAuditHashPaused).toBe(true);

    await expect(ledger.getTask({ taskId })).resolves.toMatchObject({
      taskId,
      state: "CANCELLED",
      version: 3,
    });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT worker_id, lease_generation, lease_until FROM orchestrator_execution_leases WHERE task_id = ?",
        taskId,
      ).one()).toMatchObject({
        worker_id: null,
        lease_generation: 2,
        lease_until: 0,
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_consumed_assertions WHERE jti = ?",
        transitionJti,
      ).one().count).toBe(1);

      const outbox = state.storage.sql.exec(
        "SELECT status, retry_state, last_error_code, lease_worker_id, lease_generation, lease_until FROM orchestrator_outbox_events WHERE event_id = ?",
        "agent-transition-before-owner-cancel-01",
      ).one();
      expect(outbox).toMatchObject({
        status: "PENDING",
        retry_state: "DEAD_LETTER",
        last_error_code: "OWNER_CANCELLED",
        lease_worker_id: null,
        lease_generation: 1,
        lease_until: 0,
      });

      const audit = state.storage.sql.exec(
        "SELECT event_type, details_json FROM orchestrator_audit_events WHERE task_id = ?",
        taskId,
      ).one();
      expect(audit.event_type).toBe("OWNER_TASK_CANCELLED");
      expect(JSON.parse(audit.details_json)).toMatchObject({
        expectedVersion: 2,
        expectedState: "RUNNING",
        resultingVersion: 3,
        resultingState: "CANCELLED",
        fromState: "RUNNING",
        toState: "CANCELLED",
      });
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts WHERE task_id = ? AND operation = 'cancel'",
        taskId,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_owner_consumed_assertions WHERE task_id = ? AND operation = 'cancel'",
        taskId,
      ).one().count).toBe(1);
    });
  });

});
