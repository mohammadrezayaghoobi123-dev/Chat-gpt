import test from "node:test";
import assert from "node:assert/strict";
import { canTransition } from "../orchestrator/state-machine.js";
import {
  intakeTask, scheduleTask, processAgentMessage, requestCancellation, runDispatchCycle
} from "../orchestrator/core.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const SHA = "a".repeat(40);

function validTask(taskId = "task-core", overrides = {}) {
  return {
    schemaVersion: 1,
    taskId,
    correlationId: "corr-" + taskId,
    taskType: "engineering",
    inputHash: "b".repeat(64),
    createdAt: "2026-11-04T10:00:00.000Z",
    expiresAt: "2026-11-05T10:00:00.000Z",
    scope: {
      branch: "feature/" + taskId,
      paths: ["src/a.js", "test/a.test.js"],
      operations: ["read", "write", "test", "review"]
    },
    acceptanceCriteria: ["focused tests pass"],
    dependencies: [],
    ...overrides
  };
}

function actor() {
  return { authenticated: true, principalId: "owner:1", agentId: "agent:1" };
}

function capability() {
  return { state: "AVAILABLE_VERIFIED_FREE", verified: true, expiresAt: NOW + 60_000 };
}

function quota() {
  return { remaining: 10, costCents: 0, maxSpendCents: 0, billingEnabled: false, paidFallback: false };
}

function makeStore({ tasks = [], stopSwitch = false, outbox = [] } = {}) {
  const taskMap = new Map(tasks.map(record => [record.task.taskId, structuredClone(record)]));
  const events = [];
  const messages = new Map();
  const counters = { claimed: 0, completed: 0, deferred: 0, failed: 0 };
  const store = {
    events,
    counters,
    async createTask(input) {
      const record = {
        tenantId: input.tenantId, taskId: input.task.taskId, task: structuredClone(input.task),
        state: "RECEIVED", version: 1, fencingToken: 0
      };
      taskMap.set(record.taskId, record);
      return record;
    },
    async getTask({ taskId }) { return taskMap.has(taskId) ? structuredClone(taskMap.get(taskId)) : null; },
    async getStopSwitch() { return { active: stopSwitch }; },
    async transitionTask(input) {
      const record = taskMap.get(input.taskId);
      if (!record) throw Object.assign(new Error("not found"), { code: "ORCHESTRATOR_TASK_NOT_FOUND" });
      if (record.state !== input.expectedState) throw Object.assign(new Error("state conflict"), { code: "ORCHESTRATOR_STATE_CONFLICT" });
      const decision = canTransition(input.expectedState, input.nextState, input.evidence ?? {});
      if (!decision.allowed) throw Object.assign(new Error(decision.reason), { code: "ORCHESTRATOR_INVALID_TRANSITION" });
      record.state = input.nextState;
      record.version += 1;
      events.push({ ...input });
      return structuredClone(record);
    },
    async appendTaskEvent(event) { events.push({ ...event }); return event; },
    async recordMessage({ envelope }) {
      const prior = messages.get(envelope.messageId);
      if (prior) {
        if (prior.fingerprint !== JSON.stringify(envelope)) throw Object.assign(new Error("conflict"), { code: "ORCHESTRATOR_MESSAGE_ID_CONFLICT" });
        return { inserted: false, priorResult: prior.result };
      }
      messages.set(envelope.messageId, { fingerprint: JSON.stringify(envelope), result: null });
      return { inserted: true, priorResult: null };
    },
    async claimTask({ ownerId, leaseMs }) { return { ownerId, fencingToken: 1, leaseUntil: NOW + leaseMs }; },
    async claimOutbox() { counters.claimed += 1; return outbox.shift() ?? null; },
    async completeOutbox() { counters.completed += 1; },
    async deferOutbox() { counters.deferred += 1; },
    async failOutbox() { counters.failed += 1; }
  };
  return store;
}

function depsFor(store, overrides = {}) {
  return {
    tenantId: "tenant-a",
    store,
    now: NOW,
    getAuthenticatedActor: async () => actor(),
    authenticateActor: async () => actor(),
    authenticateSender: async envelope => ({
      authenticated: true, principalId: envelope.sender.principalId, agentId: envelope.sender.agentId
    }),
    getCapability: async () => capability(),
    getQuota: async () => quota(),
    createEventId: (taskId, action) => taskId + ":" + action + ":" + NOW,
    workerId: "agent:1",
    createLeaseToken: async taskId => "lease-token-for-" + taskId,
    ...overrides
  };
}

function validEnvelope(task, overrides = {}) {
  return {
    schemaVersion: 1,
    messageId: "message-core-1",
    taskId: task.taskId,
    correlationId: task.correlationId,
    parentMessageId: null,
    sender: { agentId: "chatgpt", principalId: "service:chatgpt" },
    messageType: "AGENT_RESULT",
    issuedAt: "2026-11-04T11:00:00.000Z",
    expiresAt: "2026-11-04T13:00:00.000Z",
    round: 2,
    inputHash: task.inputHash,
    scope: task.scope,
    evidenceRefs: [],
    payload: { summary: "completed" },
    ...overrides
  };
}

test("intakeTask validates and persists a task through the injected store", async () => {
  const store = makeStore();
  const result = await intakeTask({
    tenantId: "tenant-a", task: validTask(), idempotencyKey: "intake-1",
    eventId: "created-1", outboxEventId: "outbox-1"
  }, depsFor(store));
  assert.equal(result.state, "READY");
  assert.equal(result.task.taskId, "task-core");
});

test("intakeTask rejects unauthenticated actors and malformed task contracts", async () => {
  const store = makeStore();
  await assert.rejects(
    intakeTask({ tenantId: "tenant-a", task: validTask(), idempotencyKey: "x", eventId: "e", outboxEventId: "o" },
      depsFor(store, { getAuthenticatedActor: async () => null })),
    error => error.code === "ACTOR_UNAUTHENTICATED"
  );
  await assert.rejects(
    intakeTask({ tenantId: "tenant-a", task: validTask("bad", { acceptanceCriteria: [] }), idempotencyKey: "x", eventId: "e", outboxEventId: "o" },
      depsFor(store)),
    error => error.code === "INVALID_TASK"
  );
});

test("scheduleTask schedules only when dependencies, scope, capability, quota, and stop switch pass", async () => {
  const task = validTask();
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "READY", version: 1, fencingToken: 0 }] });
  const result = await scheduleTask(task.taskId, depsFor(store));
  assert.equal(result.scheduled, true);
  assert.equal(result.task.state, "SCHEDULED");
});

test("scheduleTask blocks missing dependencies and active stop switch", async () => {
  const task = validTask("task-dep", { dependencies: ["task-missing"] });
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "READY", version: 1, fencingToken: 0 }] });
  const blocked = await scheduleTask(task.taskId, depsFor(store));
  assert.equal(blocked.scheduled, false);
  assert.equal(blocked.task.state, "BLOCKED");

  const task2 = validTask("task-stop");
  const store2 = makeStore({ tasks: [{ tenantId: "tenant-a", task: task2, state: "READY", version: 1, fencingToken: 0 }], stopSwitch: true });
  const stopped = await scheduleTask(task2.taskId, depsFor(store2));
  assert.equal(stopped.scheduled, false);
  assert.equal(stopped.task.state, "BLOCKED");
});

test("scheduleTask blocks unavailable capability, exhausted quota, and protected branch", async () => {
  const task = validTask("task-cap");
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "READY", version: 1, fencingToken: 0 }] });
  const capDenied = await scheduleTask(task.taskId, depsFor(store, {
    getCapability: async () => ({ state: "UNAVAILABLE", verified: false, expiresAt: NOW + 1000 })
  }));
  assert.equal(capDenied.task.state, "BLOCKED");

  const task2 = validTask("task-quota");
  const store2 = makeStore({ tasks: [{ tenantId: "tenant-a", task: task2, state: "READY", version: 1, fencingToken: 0 }] });
  const quotaDenied = await scheduleTask(task2.taskId, depsFor(store2, {
    getQuota: async () => ({ ...quota(), remaining: 0 })
  }));
  assert.equal(quotaDenied.task.state, "BLOCKED");

  const task3 = validTask("task-main", { scope: { ...validTask().scope, branch: "main" } });
  const store3 = makeStore({ tasks: [{ tenantId: "tenant-a", task: task3, state: "READY", version: 1, fencingToken: 0 }] });
  const branchDenied = await scheduleTask(task3.taskId, depsFor(store3));
  assert.equal(branchDenied.task.state, "BLOCKED");
});

test("processAgentMessage verifies sender, expiry, correlation, and scope before deduplicating", async () => {
  const task = validTask("task-message");
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "REVIEW_PENDING", version: 2, fencingToken: 0 }] });
  const deps = depsFor(store);
  const accepted = await processAgentMessage(validEnvelope(task), deps);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.duplicate, false);
  const duplicate = await processAgentMessage(validEnvelope(task), deps);
  assert.equal(duplicate.duplicate, true);

  await assert.rejects(
    processAgentMessage(validEnvelope(task, { expiresAt: "2026-11-04T11:30:00.000Z" }), deps),
    error => error.code === "MESSAGE_EXPIRED"
  );
  await assert.rejects(
    processAgentMessage(validEnvelope(task, { scope: { ...task.scope, paths: ["secrets/config.json"] } }), deps),
    error => error.code === "MESSAGE_SCOPE_ESCALATION"
  );
  await assert.rejects(
    processAgentMessage(validEnvelope(task), depsFor(store, {
      authenticateSender: async () => ({ authenticated: false })
    })),
    error => error.code === "SENDER_UNAUTHENTICATED"
  );
  await assert.rejects(
    processAgentMessage(validEnvelope(task, { round: 5 }), deps),
    error => error.code === "MAX_AGENT_ROUNDS_EXCEEDED"
  );
});

test("processAgentMessage marks conflicting findings as DISPUTED", async () => {
  const task = validTask("task-dispute");
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "REVIEW_PENDING", version: 3, fencingToken: 0 }] });
  const result = await processAgentMessage(validEnvelope(task, {
    messageId: "message-dispute",
    payload: { conflictingFindings: true, summary: "reviewers disagree" }
  }), depsFor(store));
  assert.equal(result.state, "DISPUTED");
});

test("requestCancellation records a durable state transition for an authenticated actor", async () => {
  const task = validTask("task-cancel");
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "READY", version: 2, fencingToken: 0 }] });
  const result = await requestCancellation(task.taskId, actor(), depsFor(store));
  assert.equal(result.cancelled, true);
  assert.equal(result.task.state, "CANCELLED");
});

test("requestCancellation rejects unauthenticated actors and preserves terminal tasks", async () => {
  const task = validTask("task-cancel-auth");
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "READY", version: 2, fencingToken: 0 }] });
  await assert.rejects(
    requestCancellation(task.taskId, actor(), depsFor(store, { authenticateActor: async () => null })),
    error => error.code === "ACTOR_UNAUTHENTICATED"
  );
  const completed = validTask("task-completed");
  const store2 = makeStore({ tasks: [{ tenantId: "tenant-a", task: completed, state: "COMPLETED", version: 5, fencingToken: 0 }] });
  const result = await requestCancellation(completed.taskId, actor(), depsFor(store2));
  assert.equal(result.cancelled, false);
  assert.equal(result.reason, "TERMINAL_STATE");
});


test("requestCancellation uses the current execution lease when cancelling a running task", async () => {
  const task = validTask("task-running-cancel");
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "RUNNING", version: 4, fencingToken: 2 }] });
  const result = await requestCancellation(task.taskId, actor(), depsFor(store, {
    getLeaseCredentials: async () => ({
      ownerId: "agent:1", leaseToken: "active-lease-token", fencingToken: 2
    })
  }));
  assert.equal(result.cancelled, true);
  assert.equal(result.task.state, "CANCELLED");
  assert.equal(store.events.at(-1).leaseOwnerId, "agent:1");
  assert.equal(store.events.at(-1).actorId, "owner:1");
});

test("runDispatchCycle stops before claiming when the stop switch is active", async () => {
  const store = makeStore({ stopSwitch: true });
  const result = await runDispatchCycle(depsFor(store));
  assert.equal(result.stopped, true);
  assert.equal(store.counters.claimed, 0);
});

test("runDispatchCycle never invokes an unverified adapter and defers the outbox event", async () => {
  const task = validTask("task-dispatch");
  const event = {
    tenantId: "tenant-a", eventId: "outbox-1", aggregateType: "task", aggregateId: task.taskId,
    eventType: "orchestrator.task.received", leaseGeneration: 1, payload: { taskId: task.taskId }
  };
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "SCHEDULED", version: 3, fencingToken: 0 }], outbox: [event] });
  let invoked = 0;
  const result = await runDispatchCycle(depsFor(store, {
    adapters: { task: { verified: false, authenticated: false, state: "UNAVAILABLE", invoke: async () => { invoked += 1; } } }
  }));
  assert.equal(invoked, 0);
  assert.equal(result.deferred, 1);
  assert.equal(result.invoked, 0);
});

test("runDispatchCycle invokes only a verified zero-cost adapter and completes the outbox event", async () => {
  const task = validTask("task-dispatch-ok");
  const event = {
    tenantId: "tenant-a", eventId: "outbox-2", aggregateType: "task", aggregateId: task.taskId,
    eventType: "orchestrator.task.received", leaseGeneration: 1, payload: { taskId: task.taskId }
  };
  const store = makeStore({ tasks: [{ tenantId: "tenant-a", task, state: "SCHEDULED", version: 3, fencingToken: 0 }], outbox: [event] });
  let invoked = 0;
  const result = await runDispatchCycle(depsFor(store, {
    adapters: { task: {
      verified: true, authenticated: true, state: "AVAILABLE_VERIFIED_FREE",
      billingEnabled: false, paidFallback: false, maxSpendCents: 0, quotaRemaining: 10,
      expiresAt: NOW + 60_000, mock: false,
      invoke: async () => { invoked += 1; return { ok: true, commitSha: SHA }; }
    } }
  }));
  assert.equal(invoked, 1);
  assert.equal(result.invoked, 1);
  assert.equal(result.completed, 1);
});
