import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
    expect(await ledger.ping()).toEqual({ ok: true, schemaVersion: 1 });
    await runInDurableObject(ledger, async (instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "orchestrator_tasks", "orchestrator_processed_messages",
        "orchestrator_execution_leases", "orchestrator_outbox_events", "orchestrator_audit_events",
      ]));
    });
  });

  it("creates a task once and replays the original task for the same idempotency key and input hash", async () => {
    const ledger = ledgerFor("ledger-task-idempotency");
    const first = await ledger.createTask({ task: task(), idempotencyKey: "task-create-0001", inputHash: "b".repeat(64), now });
    const replay = await ledger.createTask({ task: task(), idempotencyKey: "task-create-0001", inputHash: "b".repeat(64), now: now + 1 });
    expect(first).toMatchObject({ created: true, task: { taskId: "task-0001", version: 1 } });
    expect(replay).toMatchObject({ created: false, replay: true, task: { taskId: "task-0001", version: 1 } });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_tasks").one().count).toBe(1);
    });
  });

  it("rejects idempotency-key reuse with a different input hash without changing the original task", async () => {
    const ledger = ledgerFor("ledger-task-idempotency-conflict");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0002", inputHash: "c".repeat(64), now });
    await expect(ledger.createTask({
      task: { ...task(), objective: "different" }, idempotencyKey: "task-create-0002", inputHash: "d".repeat(64), now: now + 1,
    })).resolves.toMatchObject({ created: false, conflict: true, reason: "IDEMPOTENCY_CONFLICT" });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ objective: "bounded task", version: 1 });
  });

  it("allows at most one concurrent task lease claimant", async () => {
    const ledger = ledgerFor("ledger-concurrent-claim");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0003", inputHash: "e".repeat(64), now });
    const results = await Promise.all([
      ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseMs: 30_000, now }),
      ledger.claimTask({ workerId: "agent:worker-2", authenticatedWorker: authenticatedWorker("agent:worker-2"), leaseMs: 30_000, now }),
    ]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(results.filter(result => !result.claimed)).toHaveLength(1);
    expect(results.find(result => result.claimed).leaseGeneration).toBe(1);
  });

  it("rejects stale lease generations on renew, release, and worker-driven state transitions", async () => {
    const ledger = ledgerFor("ledger-stale-fence");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0004", inputHash: "f".repeat(64), now });
    const first = await ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseMs: 100, now });
    const reclaimed = await ledger.claimTask({
      workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseMs: 100, now: now + 101,
      reconciliationEvidence: { checked: true, priorGeneration: 1, evidenceRef: "github://audit/reconcile/1" },
    });
    expect(reclaimed.leaseGeneration).toBe(2);
    await expect(ledger.renewLease({
      taskId: "task-0001", workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseGeneration: first.leaseGeneration, leaseMs: 100, now: now + 102,
    })).resolves.toMatchObject({ renewed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.releaseLease({
      taskId: "task-0001", workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseGeneration: first.leaseGeneration, now: now + 102,
    })).resolves.toMatchObject({ released: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 102, workerId: "agent:worker-1", leaseGeneration: first.leaseGeneration,
    })).resolves.toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
  });

  it("rejects stale task version or expected-state compare-and-set writes", async () => {
    const ledger = ledgerFor("ledger-task-cas");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0005", inputHash: "1".repeat(64), now });
    await expect(ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 2, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: { id: "owner:one", authenticated: true, identityVerified: true, role: "owner" }, evidence, now: now + 1,
    })).resolves.toMatchObject({ updated: false, reason: "VERSION_OR_STATE_CONFLICT" });
  });

  it("deduplicates repeated messages and rejects the same message ID with a different input hash", async () => {
    const ledger = ledgerFor("ledger-message-dedup");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0006", inputHash: "2".repeat(64), now });
    const input = { messageId: "msg-0001", taskId: "task-0001", inputHash: "3".repeat(64), envelope: protocolEnvelope("msg-0001", "task-0001", "3".repeat(64), { step: 1 }), authenticatedSender, now };
    expect(await ledger.recordMessage(input)).toMatchObject({ accepted: true });
    expect(await ledger.recordMessage(input)).toMatchObject({ accepted: false, replay: true });
    await expect(ledger.recordMessage({ ...input, authenticatedSender: undefined }))
      .resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
    const changedHash = "4".repeat(64);
    const changedEnvelope = protocolEnvelope("msg-0001", "task-0001", changedHash, { step: 1 });
    expect(await ledger.recordMessage({ ...input, inputHash: changedHash, envelope: changedEnvelope }))
      .toMatchObject({ accepted: false, conflict: true });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages").one().count).toBe(1);
    });
  });

  it("commits a task transition and its outbox intent atomically", async () => {
    const ledger = ledgerFor("ledger-transition-outbox-atomic");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0007", inputHash: "5".repeat(64), now });
    const lease = await ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseMs: 30_000, now });
    expect(lease).toMatchObject({ claimed: true, leaseGeneration: 1 });
    const result = await ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 1, workerId: "agent:worker-1",
      authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseGeneration: lease.leaseGeneration,
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
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0008", inputHash: "6".repeat(64), now });
    const input = {
      eventId: "event-0001", idempotencyKey: "outbox-key-0001", taskId: "task-0001",
      eventType: "task.created", payload: { taskId: "task-0001" }, now,
    };
    expect(await ledger.enqueueOutbox(input)).toMatchObject({ enqueued: true });
    expect(await ledger.enqueueOutbox(input)).toMatchObject({ enqueued: false, replay: true });
    expect(await ledger.enqueueOutbox({ ...input, payload: { taskId: "task-0001", changed: true } }))
      .toMatchObject({ enqueued: false, conflict: true });
  });

  it("uses monotonically increasing outbox fencing generations and rejects stale completion", async () => {
    const ledger = ledgerFor("ledger-outbox-fencing");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0009", inputHash: "7".repeat(64), now });
    await ledger.enqueueOutbox({
      eventId: "event-0002", idempotencyKey: "outbox-key-0002", taskId: "task-0001",
      eventType: "task.created", payload: { taskId: "task-0001" }, now,
    });
    await expect(ledger.claimOutbox({ workerId: "publisher-1", leaseMs: 100, now }))
      .resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
    const first = await ledger.claimOutbox({ workerId: "publisher-1", authenticatedWorker: authenticatedWorker("publisher-1", "publisher"), leaseMs: 100, now });
    const second = await ledger.claimOutbox({ workerId: "publisher-2", authenticatedWorker: authenticatedWorker("publisher-2", "publisher"), leaseMs: 100, now: now + 101 });
    expect(second.leaseGeneration).toBe(first.leaseGeneration + 1);
    await expect(ledger.completeOutbox({ eventId: "event-0002", workerId: "publisher-1", authenticatedWorker: authenticatedWorker("publisher-1", "publisher"), leaseGeneration: first.leaseGeneration, now: now + 102 }))
      .resolves.toMatchObject({ completed: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.completeOutbox({ eventId: "event-0002", workerId: "publisher-2", authenticatedWorker: authenticatedWorker("publisher-2", "publisher"), leaseGeneration: second.leaseGeneration, now: now + 103 }))
      .resolves.toMatchObject({ completed: true });
  });

  it("appends immutable hash-linked audit events and rejects event ID rebinding", async () => {
    const ledger = ledgerFor("ledger-audit-chain");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0010", inputHash: "8".repeat(64), now });
    const input = {
      eventId: "audit-0001", taskId: "task-0001", actor: agent,
      eventType: "task.created", details: { version: 1 }, now,
    };
    const first = await ledger.appendAuditEvent(input);
    const replay = await ledger.appendAuditEvent(input);
    const second = await ledger.appendAuditEvent({ ...input, eventId: "audit-0002", eventType: "task.scheduled", now: now + 1 });
    expect(first).toMatchObject({
      appended: true,
      event: { eventId: "audit-0001", actorId: "agent:worker-1", actorRole: "agent", previousHash: null },
    });
    expect(replay).toMatchObject({ appended: false, replay: true, event: { actorRole: "agent" } });
    expect(second.event.previousHash).toBe(first.event.eventHash);
    await runInDurableObject(ledger, async instance => {
      await expect(instance.appendAuditEvent({
        ...input, actor: { ...agent, identityVerified: false },
      })).rejects.toMatchObject({ code: "AUTHENTICATED_ACTOR_REQUIRED" });
    });
    await expect(ledger.appendAuditEvent({ ...input, details: { version: 99 } }))
      .resolves.toMatchObject({ appended: false, conflict: true });
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_audit_events").one().count).toBe(2);
      expect(state.storage.sql.exec("SELECT actor_id, actor_role FROM orchestrator_audit_events WHERE event_id='audit-0001'").one())
        .toMatchObject({ actor_id: "agent:worker-1", actor_role: "agent" });
    });
  });

  it("one hundred duplicate deliveries produce exactly one effective message record", async () => {
    const ledger = ledgerFor("ledger-message-100-duplicates");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0011", inputHash: "9".repeat(64), now });
    const input = {
      messageId: "msg-100-duplicates", taskId: "task-0001", inputHash: "a".repeat(64),
      envelope: protocolEnvelope("msg-100-duplicates", "task-0001", "a".repeat(64), { accepted: true }), authenticatedSender, now,
    };
    const results = await Promise.all(Array.from({ length: 100 }, () => ledger.recordMessage(input)));
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.filter(result => result.replay)).toHaveLength(99);
    await runInDurableObject(ledger, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_processed_messages WHERE message_id='msg-100-duplicates'").one().count).toBe(1);
    });
  });

  it("requires reconciliation evidence before reclaiming an expired lease and preserves task state", async () => {
    const ledger = ledgerFor("ledger-expired-lease-reconciliation");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-0012", inputHash: "b".repeat(64), now });
    const worker = authenticatedWorker("agent:worker-1");
    const first = await ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: worker, leaseMs: 100, now });
    await expect(ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: worker, leaseMs: 100, now: now + 101 }))
      .resolves.toMatchObject({ claimed: false, reason: "RECONCILIATION_REQUIRED" });
    const reclaimed = await ledger.claimTask({
      workerId: "agent:worker-1", authenticatedWorker: worker, leaseMs: 100, now: now + 101,
      reconciliationEvidence: { checked: true, priorGeneration: first.leaseGeneration, evidenceRef: "github://audit/reconcile/12" },
    });
    expect(reclaimed).toMatchObject({ claimed: true, leaseGeneration: 2, reconciliationRequired: true });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });

  it("refuses to persist a protocol message without a verified authenticated sender context", async () => {
    const ledger = ledgerFor("ledger-message-authentication");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-auth-message", inputHash: "c".repeat(64), now });
    const envelope = protocolEnvelope("msg-auth-required", "task-0001", "d".repeat(64), { step: 1 });
    await expect(ledger.recordMessage({
      messageId: "msg-auth-required", taskId: "task-0001", inputHash: "d".repeat(64), envelope, now,
    })).resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
    await expect(ledger.recordMessage({
      messageId: "msg-auth-required", taskId: "task-0001", inputHash: "d".repeat(64), envelope,
      authenticatedSender: { id: "agent:worker-1", authenticated: true, identityVerified: false }, now,
    })).resolves.toMatchObject({ accepted: false, reason: "AUTHENTICATED_SENDER_REQUIRED" });
  });

  it("requires verified worker identities before task or outbox lease side effects", async () => {
    const ledger = ledgerFor("ledger-worker-authentication");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-worker-auth", inputHash: "c".repeat(64), now });
    await expect(ledger.claimTask({ workerId: "agent:worker-1", leaseMs: 30_000, now }))
      .resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
    await expect(ledger.claimTask({
      workerId: "agent:worker-1", authenticatedWorker: { id: "agent:worker-1", authenticated: true, identityVerified: false, role: "agent" },
      leaseMs: 30_000, now,
    })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  });

  it("persists the four-round ceiling so retries cannot reset agent coordination rounds", async () => {
    const ledger = ledgerFor("ledger-agent-round-limit");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-agent-rounds", inputHash: "c".repeat(64), now });
    const worker = authenticatedWorker("agent:worker-1");
    const lease = await ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: worker, leaseMs: 30_000, now });
    let version = 1;
    for (let round = 1; round <= 4; round += 1) {
      const result = await ledger.advanceAgentRound({
        taskId: "task-0001", expectedVersion: version, expectedRound: round - 1,
        nextRound: round, workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseGeneration: lease.leaseGeneration, now: now + round,
      });
      expect(result).toMatchObject({ advanced: true, task: { agentRound: round, version: version + 1 } });
      version += 1;
    }
    await expect(ledger.advanceAgentRound({
      taskId: "task-0001", expectedVersion: version, expectedRound: 4,
      nextRound: 5, workerId: "agent:worker-1", authenticatedWorker: worker, leaseGeneration: lease.leaseGeneration, now: now + 5,
    })).resolves.toMatchObject({ advanced: false, reason: "AGENT_ROUND_LIMIT" });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ agentRound: 4, version: 5 });
  });

  it("rejects a message whose envelope identifiers do not match the durable deduplication key", async () => {
    const ledger = ledgerFor("ledger-message-envelope-binding");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-envelope-binding", inputHash: "f".repeat(64), now });
    const result = await ledger.recordMessage({
      messageId: "msg-indexed-as-one", taskId: "task-0001", inputHash: "a".repeat(64),
      envelope: protocolEnvelope("msg-claimed-as-two", "task-0001", "a".repeat(64), {}), authenticatedSender, now,
    });
    expect(result).toMatchObject({ accepted: false, reason: "MESSAGE_ENVELOPE_MISMATCH" });
  });

  it("does not allow an unassigned worker identity to claim a task assigned to another executor", async () => {
    const ledger = ledgerFor("ledger-assignee-enforcement");
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-assignee", inputHash: "b".repeat(64), now });
    await expect(ledger.claimTask({ workerId: "agent:unassigned", authenticatedWorker: authenticatedWorker("agent:unassigned"), leaseMs: 30_000, now }))
      .resolves.toMatchObject({ claimed: false, reason: "ASSIGNEE_MISMATCH" });
    await expect(ledger.claimTask({ workerId: "agent:worker-1", authenticatedWorker: authenticatedWorker("agent:worker-1"), leaseMs: 30_000, now }))
      .resolves.toMatchObject({ claimed: true, leaseGeneration: 1 });
  });

  it("rejects secret-bearing fields and never creates or writes KnowledgeStore tables", async () => {
    const ledger = ledgerFor("ledger-secret-isolation");
    await expect(Promise.resolve().then(() => ledger.createTask({
      task: { ...task(), apiKey: "must-not-persist" }, idempotencyKey: "task-secret-0001", inputHash: "c".repeat(64), now,
    }))).rejects.toThrow(/sensitive field/);
    await ledger.createTask({ task: task(), idempotencyKey: "task-safe-0001", inputHash: "d".repeat(64), now });
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
    await ledger.createTask({ task: task(), idempotencyKey: "task-create-role-bypass", inputHash: "e".repeat(64), now });

    const ownerBypass = await ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: { id: "owner:one", authenticated: true, identityVerified: true, role: "owner" },
      evidence, now: now + 1,
    });
    expect(ownerBypass).toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });

    const agentWithoutLease = await ledger.transitionTask({
      taskId: "task-0001", expectedVersion: 1, expectedState: "SCHEDULED", nextState: "RUNNING",
      actor: agent, evidence, now: now + 1,
    });
    expect(agentWithoutLease).toMatchObject({ updated: false, reason: "LEASE_FENCE_MISMATCH" });
    await expect(ledger.getTask({ taskId: "task-0001" })).resolves.toMatchObject({ state: "SCHEDULED", version: 1 });
  });


it("rejects a caller-forged legacy worker identity before creating a lease", async () => {
  const ledger = ledgerFor("ledger-forged-legacy-worker-identity");
  await ledger.createTask({ task: task(), idempotencyKey: "task-create-forged-identity", inputHash: "a".repeat(64), now });
  const forged = { id: "agent:worker-1", authenticated: true, identityVerified: true, role: "agent" };
  await expect(ledger.claimTask({
    workerId: "agent:worker-1", authenticatedWorker: forged, leaseMs: 30_000, now,
  })).resolves.toMatchObject({ claimed: false, reason: "AUTHENTICATED_WORKER_REQUIRED" });
  await runInDurableObject(ledger, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM orchestrator_execution_leases").one().count).toBe(0);
  });
});
