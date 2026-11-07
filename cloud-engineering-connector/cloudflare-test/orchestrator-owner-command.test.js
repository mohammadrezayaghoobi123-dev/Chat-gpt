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
async function workerAssertion(subject, operation, at = now) {
  const claims = {
    v: 1, iss: "chat-gpt111-worker", aud: "orchestrator-ledger",
    sub: subject, role: "system", op: operation, iat: Math.floor(at / 1000),
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
    workerAssertion: await workerAssertion("orchestrator-scheduler", "createTask"),
  });
}
async function ownerInput(overrides = {}) {
  const command = {
    operation: "cancel", taskId: "task-owner-0001", expectedVersion: 1, expectedState: "SCHEDULED",
    reason: "Owner requested cancellation", eventId: "owner-event-0001",
  };
  Object.assign(command, overrides.command);
  const context = {
    actorId: ownerId, repositoryId, taskId: command.taskId,
    operation: command.operation, deliveryId: overrides.deliveryId ?? "delivery-owner-00000001",
    commentId: overrides.commentId ?? "123456789",
    commandHash: await sha256Canonical(command),
  };
  const assertion = await createOwnerAssertion(ownerKeySet, "owner-v1", context, now);
  return {
    assertion, assertionContext: context, command,
    bodySha256: overrides.bodySha256 ?? "c".repeat(64),
    now: overrides.now ?? now,
  };
}

describe("Owner command atomic Ledger contract", () => {
  it("atomically consumes Owner JTI, claims delivery/comment, cancels task, fences leases, and appends audit", async () => {
    const ledger = ledgerFor("owner-atomic-cancel");
    await createTask(ledger);
    const result = await ledger.executeOwnerCommand(await ownerInput());
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

  it("rejects a stale expected version atomically and records only a rejected audit event", async () => {
    const ledger = ledgerFor("owner-command-stale-version");
    await createTask(ledger);
    const input = await ownerInput({ command: { expectedVersion: 99 } });
    const result = await ledger.executeOwnerCommand(input);
    expect(result).toMatchObject({ applied: false, conflict: true, reason: "VERSION_OR_STATE_CONFLICT" });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT state, version FROM orchestrator_tasks WHERE task_id = ?", "task-owner-0001").one())
        .toMatchObject({ state: "SCHEDULED", version: 1 });
      expect(state.storage.sql.exec("SELECT event_type, actor_role FROM orchestrator_audit_events").one())
        .toMatchObject({ event_type: "OWNER_COMMAND_REJECTED", actor_role: "owner" });
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_command_receipts").one().count).toBe(1);
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
    await expect(ledger.executeOwnerCommand(input)).rejects.toThrow("injected owner audit failure");
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_github_webhook_deliveries").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_owner_consumed_assertions").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT state, version FROM orchestrator_tasks WHERE task_id = ?", "task-owner-0001").one())
        .toMatchObject({ state: "SCHEDULED", version: 1 });
    });
  });
});
