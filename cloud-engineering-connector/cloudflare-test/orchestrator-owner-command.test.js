import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
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
      idempotencyKey: "attacker-rebound-dedupe-01",
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

});
