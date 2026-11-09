import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createOwnerAssertion } from "../orchestrator-owner-assertion.js";
import { canonicalJson, sha256Canonical } from "../orchestrator-protocol.js";

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
    const claim = await ledger.claimTask({
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "claimTask"),
      leaseMs: 30_000,
      now,
    });
    expect(claim).toMatchObject({ claimed: true, leaseGeneration: 1 });
    const enqueued = await ledger.enqueueOutbox({
      leaseGeneration: claim.leaseGeneration,
      eventId: "owner-queued-before-cancel-01",
      idempotencyKey: "owner-queued-before-cancel-key-01",
      taskId: "task-owner-0001",
      eventType: "task.transitioned",
      payload,
      workerId: "agent:worker-1",
      workerAssertion: await workerAssertion("agent:worker-1", "agent", "enqueueOutbox"),
      now,
    });
    expect(enqueued).toMatchObject({ enqueued: true });
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
});


it("removes a scheduler candidate atomically when an Owner command cancels its task", async () => {
  const ledger = ledgerFor("owner-command-candidate-sync");
  await createTask(ledger);
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-owner-0001",
    ).one().count).toBe(1);
  });

  const result = await ledger.executeOwnerCommand(await ownerInput());
  expect(result).toMatchObject({ applied: true, task: { state: "CANCELLED", version: 2 } });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM orchestrator_claim_candidates WHERE task_id = ?",
      "task-owner-0001",
    ).one().count).toBe(0);
  });
});
