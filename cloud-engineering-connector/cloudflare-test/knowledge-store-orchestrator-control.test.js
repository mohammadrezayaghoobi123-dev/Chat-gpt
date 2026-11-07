import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function storeFor(name) {
  return env.KNOWLEDGE_STORE.get(env.KNOWLEDGE_STORE.idFromName(name));
}


async function expectLocalCode(store, operation, code) {
  await runInDurableObject(store, async instance => {
    let caught;
    try {
      await operation(instance);
    } catch (error) {
      caught = error;
    }
    expect(caught?.code, caught ? caught.name + ": " + caught.message : "operation completed without throwing").toBe(code);
  });
}

function validTask(taskId = "task-001", overrides = {}) {
  return {
    schemaVersion: 1,
    taskId,
    correlationId: "corr-" + taskId,
    taskType: "engineering",
    inputHash: "a".repeat(64),
    createdAt: "2026-11-04T10:00:00.000Z",
    expiresAt: "2026-11-05T10:00:00.000Z",
    scope: {
      branch: "feature/" + taskId,
      paths: ["src/worker.js", "test/worker.test.js"],
      operations: ["read", "test"]
    },
    acceptanceCriteria: ["focused tests pass"],
    ...overrides
  };
}

function createInput(taskId = "task-001", tenantId = "tenant-a", now = 1000) {
  return {
    tenantId,
    task: validTask(taskId),
    idempotencyKey: "intake-" + taskId,
    eventId: "created-" + taskId,
    outboxEventId: "outbox-" + taskId,
    now
  };
}

function validEnvelope(task, overrides = {}) {
  return {
    schemaVersion: 1,
    messageId: "message-001",
    taskId: task.taskId,
    correlationId: task.correlationId,
    parentMessageId: null,
    sender: { agentId: "chatgpt", principalId: "service:chatgpt" },
    messageType: "AGENT_RESULT",
    issuedAt: "2026-11-04T10:10:00.000Z",
    expiresAt: "2026-11-04T10:20:00.000Z",
    round: 1,
    inputHash: task.inputHash,
    scope: task.scope,
    evidenceRefs: ["https://github.com/example/repo/commit/" + "b".repeat(40)],
    payload: { summary: "analysis complete" },
    ...overrides
  };
}

async function scheduleTask(store, taskId = "task-001", tenantId = "tenant-a") {
  await store.setStopSwitch({
    tenantId, active: false, actorId: "owner:1", reason: "test scheduling",
    ownerAuthorization: { verified: true, principalId: "owner:1", approvalId: "schedule-" + taskId },
    now: 1500
  });
  await store.transitionTask({
    tenantId, taskId, expectedState: "RECEIVED", nextState: "VALIDATING",
    eventId: "transition-" + taskId + "-1", actorId: "owner:1", evidence: {}, now: 2000
  });
  await store.transitionTask({
    tenantId, taskId, expectedState: "VALIDATING", nextState: "READY",
    eventId: "transition-" + taskId + "-2", actorId: "owner:1",
    evidence: { validation: { passed: true } }, now: 3000
  });
  await store.transitionTask({
    tenantId, taskId, expectedState: "READY", nextState: "SCHEDULED",
    eventId: "transition-" + taskId + "-3", actorId: "owner:1",
    evidence: { policyDecision: { allowed: true }, stopSwitchClear: true }, now: 4000
  });
}

describe("KnowledgeStore orchestrator ledger v4", () => {
  it("migrates the v3 KnowledgeStore schema additively without losing Option C records", async () => {
    const store = storeFor("orchestrator-v4-migration");
    await store.upsertEntity({
      tenantId: "tenant-a", entityId: "preserved-entity", entityType: "service",
      name: "Preserved", properties: { canonical: "KnowledgeStore" }, expectedVersion: 0, now: 100
    });
    expect(await store.ping()).toEqual({ ok: true, schemaVersion: 4 });
    await runInDurableObject(store, async instance => {
      for (const table of [
        "orchestrator_processed_messages",
        "orchestrator_execution_leases",
        "orchestrator_approvals",
        "orchestrator_policy_decisions",
        "orchestrator_agent_capability_snapshots",
        "orchestrator_control_state",
        "orchestrator_audit_events",
        "orchestrator_task_events",
        "orchestrator_tasks"
      ]) {
        instance.ctx.storage.sql.exec("DROP TABLE IF EXISTS " + table);
      }
      instance.ctx.storage.sql.exec("DELETE FROM knowledge_schema_migrations WHERE version = 4");
      instance.ensureSchema();
      expect(instance.ping()).toEqual({ ok: true, schemaVersion: 4 });
      expect(instance.getEntity({ tenantId: "tenant-a", entityId: "preserved-entity" }))
        .toMatchObject({ name: "Preserved", version: 1, properties: { canonical: "KnowledgeStore" } });
      const versions = instance.ctx.storage.sql.exec(
        "SELECT version FROM knowledge_schema_migrations ORDER BY version"
      ).toArray().map(row => row.version);
      expect(versions).toEqual([2, 3, 4]);
    });
  });

  it("creates a task and its initial event/outbox entry atomically and replays idempotently", async () => {
    const store = storeFor("orchestrator-task-idempotency");
    const input = createInput();
    const created = await store.createTask(input);
    expect(created).toMatchObject({
      tenantId: "tenant-a", taskId: "task-001", state: "RECEIVED",
      version: 1, fencingToken: 0, task: { correlationId: "corr-task-001" }
    });
    const replay = await store.createTask({
      ...input, eventId: "ignored-created-replay", outboxEventId: "ignored-outbox-replay"
    });
    expect(replay).toEqual(created);
    await runInDurableObject(store, async instance => {
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM orchestrator_task_events WHERE tenant_id=? AND task_id=?",
        "tenant-a", "task-001"
      ).one().count).toBe(1);
      expect(instance.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM knowledge_outbox WHERE tenant_id=? AND aggregate_id=?",
        "tenant-a", "task-001"
      ).one().count).toBe(1);
    });
    await expectLocalCode(store, instance => instance.createTask({
      ...input, task: validTask("task-001", { inputHash: "b".repeat(64) })
    }), "ORCHESTRATOR_TASK_IDEMPOTENCY_CONFLICT");
  });

  it("keeps tasks tenant-isolated and applies expected-state compare-and-set", async () => {
    const store = storeFor("orchestrator-task-cas");
    await store.createTask(createInput("task-cas", "tenant-a"));
    await expect(store.getTask({ tenantId: "tenant-b", taskId: "task-cas" })).resolves.toBeNull();
    const changed = await store.transitionTask({
      tenantId: "tenant-a", taskId: "task-cas", expectedState: "RECEIVED", nextState: "VALIDATING",
      eventId: "cas-transition-1", actorId: "owner:1", evidence: {}, now: 2000
    });
    expect(changed).toMatchObject({ state: "VALIDATING", version: 2 });
    await expectLocalCode(store, instance => instance.transitionTask({
      tenantId: "tenant-a", taskId: "task-cas", expectedState: "RECEIVED", nextState: "VALIDATING",
      eventId: "cas-transition-stale", actorId: "owner:1", evidence: {}, now: 3000
    }), "ORCHESTRATOR_STATE_CONFLICT");
    await expectLocalCode(store, instance => instance.appendTaskEvent({
      tenantId: "tenant-b", taskId: "task-cas", eventId: "cross-tenant-event",
      eventType: "NOTE", actorId: "agent:2", payload: {}, now: 4000
    }), "ORCHESTRATOR_TASK_NOT_FOUND");
  });

  it("appends immutable task events and deduplicates identical event IDs", async () => {
    const store = storeFor("orchestrator-append-only-events");
    await store.createTask(createInput("task-events"));
    const input = {
      tenantId: "tenant-a", taskId: "task-events", eventId: "event-note-1",
      eventType: "AGENT_NOTE", actorId: "agent:1", payload: { note: "reviewed" }, now: 2000
    };
    const event = await store.appendTaskEvent(input);
    expect(event).toMatchObject({ eventId: "event-note-1", sequence: 2, eventType: "AGENT_NOTE" });
    await expect(store.appendTaskEvent(input)).resolves.toEqual(event);
    await expectLocalCode(store, instance => instance.appendTaskEvent({ ...input, payload: { note: "tampered" } }),
      "ORCHESTRATOR_EVENT_ID_CONFLICT");
    await runInDurableObject(store, async instance => {
      expect(() => instance.ctx.storage.sql.exec(
        "UPDATE orchestrator_task_events SET event_type='TAMPERED' WHERE tenant_id=? AND event_id=?",
        "tenant-a", "event-note-1"
      )).toThrow(/append-only/);
      expect(() => instance.ctx.storage.sql.exec(
        "DELETE FROM orchestrator_task_events WHERE tenant_id=? AND event_id=?",
        "tenant-a", "event-note-1"
      )).toThrow(/append-only/);
    });
  });

  it("deduplicates processed messages and returns the original result without allowing ID rebinding", async () => {
    const store = storeFor("orchestrator-message-dedup");
    const task = validTask("task-message");
    await store.createTask({ ...createInput("task-message"), task });
    const envelope = validEnvelope(task);
    await expect(store.recordMessage({
      tenantId: "tenant-a", envelope, result: { accepted: true }, now: 2000
    })).resolves.toEqual({ inserted: true, priorResult: null });
    await expect(store.recordMessage({
      tenantId: "tenant-a", envelope, result: { accepted: false }, now: 3000
    })).resolves.toEqual({ inserted: false, priorResult: { accepted: true } });
    await expectLocalCode(store, instance => instance.recordMessage({
      tenantId: "tenant-a", envelope: {
        ...envelope, payload: { summary: "different content" }
      }, now: 4000
    }), "ORCHESTRATOR_MESSAGE_ID_CONFLICT");
    await expectLocalCode(store, instance => instance.recordMessage({
      tenantId: "tenant-b", envelope, now: 5000
    }), "ORCHESTRATOR_TASK_NOT_FOUND");
  });

  it("reclaims expired leases with a higher fencing token and rejects stale workers", async () => {
    const store = storeFor("orchestrator-fencing");
    await store.createTask(createInput("task-fence"));
    await scheduleTask(store, "task-fence");
    const first = await store.claimTask({
      tenantId: "tenant-a", taskId: "task-fence", ownerId: "agent:1",
      leaseToken: "first-lease-token", leaseMs: 1000, now: 5000
    });
    expect(first).toMatchObject({ fencingToken: 1, leaseUntil: 6000 });
    await expectLocalCode(store, instance => instance.claimTask({
      tenantId: "tenant-a", taskId: "task-fence", ownerId: "agent:2",
      leaseToken: "second-lease-token", leaseMs: 1000, now: 5500
    }), "ORCHESTRATOR_LEASE_ACTIVE");
    const second = await store.claimTask({
      tenantId: "tenant-a", taskId: "task-fence", ownerId: "agent:2",
      leaseToken: "second-lease-token", leaseMs: 1000, now: 6000
    });
    expect(second.fencingToken).toBe(2);
    await expectLocalCode(store, instance => instance.transitionTask({
      tenantId: "tenant-a", taskId: "task-fence", expectedState: "SCHEDULED", nextState: "RUNNING",
      eventId: "stale-worker-start", actorId: "agent:1", leaseToken: "first-lease-token",
      fencingToken: first.fencingToken, evidence: {}, now: 6100
    }), "ORCHESTRATOR_LEASE_CONFLICT");
    const running = await store.transitionTask({
      tenantId: "tenant-a", taskId: "task-fence", expectedState: "SCHEDULED", nextState: "RUNNING",
      eventId: "current-worker-start", actorId: "agent:2", leaseToken: "second-lease-token",
      fencingToken: second.fencingToken, evidence: {}, now: 6200
    });
    expect(running).toMatchObject({ state: "RUNNING", fencingToken: 2 });
    await expectLocalCode(store, instance => instance.transitionTask({
      tenantId: "tenant-a", taskId: "task-fence", expectedState: "RUNNING", nextState: "VERIFYING",
      eventId: "stale-worker-finish", actorId: "agent:1", leaseToken: "first-lease-token",
      fencingToken: first.fencingToken, evidence: { execution: { commitSha: "b".repeat(40) } }, now: 6250
    }), "ORCHESTRATOR_LEASE_CONFLICT");
    const verified = await store.transitionTask({
      tenantId: "tenant-a", taskId: "task-fence", expectedState: "RUNNING", nextState: "VERIFYING",
      eventId: "current-worker-finish", actorId: "agent:2", leaseToken: "second-lease-token",
      fencingToken: second.fencingToken, evidence: { execution: { commitSha: "b".repeat(40) } }, now: 6300
    });
    expect(verified).toMatchObject({ state: "VERIFYING", fencingToken: 2 });
    await runInDurableObject(store, async instance => {
      expect(instance.ctx.storage.sql.exec(
        "SELECT lease_until FROM orchestrator_execution_leases WHERE tenant_id=? AND task_id=?",
        "tenant-a", "task-fence"
      ).one().lease_until).toBe(6300);
    });
  });


  it("enforces the persisted stop switch before scheduling and claiming", async () => {
    const store = storeFor("orchestrator-stop-switch-enforcement");
    await store.createTask(createInput("task-stop"));
    await store.transitionTask({
      tenantId: "tenant-a", taskId: "task-stop", expectedState: "RECEIVED", nextState: "VALIDATING",
      eventId: "stop-transition-1", actorId: "owner:1", evidence: {}, now: 2000
    });
    await store.transitionTask({
      tenantId: "tenant-a", taskId: "task-stop", expectedState: "VALIDATING", nextState: "READY",
      eventId: "stop-transition-2", actorId: "owner:1",
      evidence: { validation: { passed: true } }, now: 3000
    });
    await expectLocalCode(store, instance => instance.transitionTask({
      tenantId: "tenant-a", taskId: "task-stop", expectedState: "READY", nextState: "SCHEDULED",
      eventId: "stop-transition-denied", actorId: "owner:1",
      evidence: { policyDecision: { allowed: true }, stopSwitchClear: true }, now: 4000
    }), "ORCHESTRATOR_STOP_SWITCH_ACTIVE");
    await store.setStopSwitch({
      tenantId: "tenant-a", active: false, actorId: "owner:1", reason: "owner resume",
      ownerAuthorization: { verified: true, principalId: "owner:1", approvalId: "resume-task-stop" }, now: 4100
    });
    await store.transitionTask({
      tenantId: "tenant-a", taskId: "task-stop", expectedState: "READY", nextState: "SCHEDULED",
      eventId: "stop-transition-allowed", actorId: "owner:1",
      evidence: { policyDecision: { allowed: true }, stopSwitchClear: true }, now: 4200
    });
    await store.setStopSwitch({
      tenantId: "tenant-a", active: true, actorId: "operator:1", reason: "emergency pause", now: 4300
    });
    await expectLocalCode(store, instance => instance.claimTask({
      tenantId: "tenant-a", taskId: "task-stop", ownerId: "agent:1",
      leaseToken: "stop-test-lease", leaseMs: 1000, now: 4400
    }), "ORCHESTRATOR_STOP_SWITCH_ACTIVE");
  });

  it("defaults the stop switch to active, persists owner-authorized changes, and fails closed on read errors", async () => {
    const store = storeFor("orchestrator-stop-switch");
    await expect(store.getStopSwitch({ tenantId: "tenant-a" }))
      .resolves.toMatchObject({ active: true, source: "DEFAULT_FAIL_CLOSED" });
    await expect(store.setStopSwitch({
      tenantId: "tenant-a", active: false, actorId: "owner:1", reason: "owner approved",
      ownerAuthorization: { verified: true, principalId: "owner:1", approvalId: "approval-001" }, now: 2000
    })).resolves.toMatchObject({ active: false, source: "PERSISTED" });
    await expect(store.setStopSwitch({
      tenantId: "tenant-a", active: true, actorId: "operator:1", reason: "emergency pause", now: 3000
    })).resolves.toMatchObject({ active: true, source: "PERSISTED" });
    await expectLocalCode(store, instance => instance.setStopSwitch({
      tenantId: "tenant-a", active: false, actorId: "operator:1", reason: "unauthorized resume", now: 4000
    }), "ORCHESTRATOR_OWNER_AUTHORIZATION_REQUIRED");
    await runInDurableObject(store, async instance => {
      instance.ctx.storage.sql.exec("DROP TABLE orchestrator_control_state");
    });
    await expect(store.getStopSwitch({ tenantId: "tenant-a" }))
      .resolves.toMatchObject({ active: true, source: "READ_ERROR_FAIL_CLOSED" });
  });
});
