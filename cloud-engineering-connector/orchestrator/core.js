import { validateEnvelope, validateTask } from "./contracts.js";
import { canTransition, MAX_AGENT_ROUNDS } from "./state-machine.js";
import { evaluatePolicy } from "./policy.js";

const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "QUARANTINED"]);
const VERIFIED_FREE_STATES = new Set(["AVAILABLE_VERIFIED_FREE", "AVAILABLE_LIMITED_FREE"]);

function coreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nowMs(deps) {
  const value = typeof deps?.now === "function" ? deps.now() : deps?.now;
  const result = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Date.now();
  if (!Number.isFinite(result)) throw coreError("INVALID_CLOCK", "A valid clock value is required.");
  return result;
}

function eventId(deps, taskId, action, now) {
  const value = typeof deps?.createEventId === "function"
    ? deps.createEventId(taskId, action, now)
    : taskId + ":" + action + ":" + now;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw coreError("INVALID_EVENT_ID", "Event ID generator returned an invalid identifier.");
  }
  return value;
}

function actorId(actor) {
  return actor?.agentId || actor?.principalId || null;
}

function requireStore(deps) {
  if (!deps?.store) throw coreError("STORE_UNAVAILABLE", "A KnowledgeStore dependency is required.");
  return deps.store;
}

async function authenticatedActor(deps) {
  if (typeof deps?.getAuthenticatedActor !== "function") {
    throw coreError("ACTOR_UNAUTHENTICATED", "Authenticated actor resolver is unavailable.");
  }
  const actor = await deps.getAuthenticatedActor();
  if (!actor || actor.authenticated !== true) {
    throw coreError("ACTOR_UNAUTHENTICATED", "An authenticated actor is required.");
  }
  if (typeof actor.principalId !== "string" || actor.principalId.length === 0 ||
      typeof actor.agentId !== "string" || actor.agentId.length === 0) {
    throw coreError("ACTOR_IDENTITY_UNKNOWN", "Authenticated principal and agent identities are required.");
  }
  return actor;
}

function scopeIsSubset(messageScope, taskScope) {
  return Boolean(messageScope && taskScope &&
    messageScope.branch === taskScope.branch &&
    Array.isArray(messageScope.paths) && messageScope.paths.every(path => taskScope.paths.includes(path)) &&
    Array.isArray(messageScope.operations) && messageScope.operations.every(operation => taskScope.operations.includes(operation)));
}

function policyFailure(decision) {
  return coreError(decision.decisionCode, decision.reason);
}

async function blockTask(record, decision, actor, deps, now) {
  if (TERMINAL_STATES.has(record.state)) {
    return { scheduled: false, task: record, decision, alreadyTerminal: true };
  }
  const nextState = record.state === "RUNNING" || record.state === "DISPUTED" ? "QUARANTINED" : "BLOCKED";
  const transition = {
    tenantId: deps.tenantId,
    taskId: record.taskId,
    expectedState: record.state,
    nextState,
    eventId: eventId(deps, record.taskId, "policy-block", now),
    actorId: actorId(actor),
    evidence: { policyDecision: { allowed: false, decisionCode: decision.decisionCode } },
    now
  };
  if (record.state === "RUNNING") {
    const lease = await deps.getLeaseCredentials?.(record.taskId);
    if (!lease) {
      await requireStore(deps).appendTaskEvent({
        tenantId: deps.tenantId, taskId: record.taskId,
        eventId: eventId(deps, record.taskId, "policy-quarantine-request", now),
        eventType: "POLICY_QUARANTINE_REQUESTED", actorId: actorId(actor),
        payload: { decisionCode: decision.decisionCode }, now
      });
      return { scheduled: false, task: record, decision, quarantinePending: true };
    }
    transition.leaseToken = lease.leaseToken;
    transition.fencingToken = lease.fencingToken;
    transition.leaseOwnerId = lease.ownerId;
  }
  const task = await requireStore(deps).transitionTask(transition);
  return { scheduled: false, task, decision };
}

export async function intakeTask(input, deps) {
  const store = requireStore(deps);
  const task = validateTask(input?.task);
  const actor = await authenticatedActor(deps);
  const decision = evaluatePolicy({ actor, action: "intake_task", task, now: nowMs(deps) });
  if (!decision.allowed) throw policyFailure(decision);
  const tenantId = input?.tenantId ?? deps.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw coreError("TENANT_REQUIRED", "A tenant ID is required for task intake.");
  }
  const now = nowMs(deps);
  return store.createTask({
    tenantId,
    task,
    idempotencyKey: input.idempotencyKey,
    eventId: input.eventId ?? eventId(deps, task.taskId, "received", now),
    outboxEventId: input.outboxEventId ?? eventId(deps, task.taskId, "outbox", now),
    now
  });
}

export async function scheduleTask(taskId, deps) {
  const store = requireStore(deps);
  const tenantId = deps?.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) throw coreError("TENANT_REQUIRED", "A tenant ID is required.");
  const record = await store.getTask({ tenantId, taskId });
  if (!record) throw coreError("ORCHESTRATOR_TASK_NOT_FOUND", "Task does not exist.");
  if (record.state !== "READY") throw coreError("TASK_NOT_READY", "Only READY tasks can be scheduled.");

  const actor = await authenticatedActor(deps);
  const now = nowMs(deps);
  const stopSwitch = await store.getStopSwitch({ tenantId });
  for (const dependencyId of record.task.dependencies ?? []) {
    const dependency = await store.getTask({ tenantId, taskId: dependencyId });
    if (!dependency || dependency.state !== "COMPLETED") {
      return blockTask(record, {
        allowed: false, decisionCode: "DEPENDENCY_NOT_COMPLETED",
        reason: "All declared task dependencies must be COMPLETED before scheduling."
      }, actor, deps, now);
    }
  }

  const capability = typeof deps.getCapability === "function"
    ? await deps.getCapability(actor, record.task)
    : null;
  const quota = typeof deps.getQuota === "function"
    ? await deps.getQuota(actor, record.task)
    : null;
  const decision = evaluatePolicy({
    actor,
    action: "schedule_task",
    task: record.task,
    branch: record.task.scope.branch,
    paths: record.task.scope.paths,
    scopeOperation: "write",
    stopSwitch,
    capability,
    quota,
    now
  });
  if (!decision.allowed) return blockTask(record, decision, actor, deps, now);

  const task = await store.transitionTask({
    tenantId,
    taskId,
    expectedState: "READY",
    nextState: "SCHEDULED",
    eventId: eventId(deps, taskId, "schedule", now),
    actorId: actor.agentId,
    evidence: {
      policyDecision: { allowed: true, decisionCode: decision.decisionCode },
      stopSwitchClear: stopSwitch.active === false
    },
    now
  });
  return { scheduled: true, task, decision };
}

export async function processAgentMessage(envelopeInput, deps) {
  const store = requireStore(deps);
  const tenantId = deps?.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) throw coreError("TENANT_REQUIRED", "A tenant ID is required.");
  const envelope = validateEnvelope(envelopeInput);
  const now = nowMs(deps);
  if (Date.parse(envelope.expiresAt) <= now) throw coreError("MESSAGE_EXPIRED", "Agent message has expired.");
  if (typeof deps.authenticateSender !== "function") {
    throw coreError("SENDER_UNAUTHENTICATED", "Authenticated sender resolver is unavailable.");
  }
  const authenticated = await deps.authenticateSender(envelope);
  if (!authenticated || authenticated.authenticated !== true ||
      authenticated.principalId !== envelope.sender.principalId ||
      authenticated.agentId !== envelope.sender.agentId) {
    throw coreError("SENDER_UNAUTHENTICATED", "Message sender identity is not independently authenticated.");
  }

  const record = await store.getTask({ tenantId, taskId: envelope.taskId });
  if (!record) throw coreError("ORCHESTRATOR_TASK_NOT_FOUND", "Message references an unknown task.");
  if (record.task.correlationId !== envelope.correlationId || record.task.inputHash !== envelope.inputHash) {
    throw coreError("MESSAGE_CORRELATION_MISMATCH", "Message correlation ID or input hash does not match the task.");
  }
  if (!scopeIsSubset(envelope.scope, record.task.scope)) {
    throw coreError("MESSAGE_SCOPE_ESCALATION", "Agent message scope exceeds the task's approved scope.");
  }
  if (envelope.round > MAX_AGENT_ROUNDS) {
    throw coreError("MAX_AGENT_ROUNDS_EXCEEDED", "Agent round limit exceeded.");
  }

  const stored = await store.recordMessage({ tenantId, envelope, result: envelope.payload, now });
  if (!stored.inserted) return { accepted: true, duplicate: true, state: record.state };

  if (envelope.payload?.conflictingFindings === true) {
    if (record.state === "VERIFYING" || record.state === "REVIEW_PENDING") {
      const disputed = await store.transitionTask({
        tenantId, taskId: record.taskId, expectedState: record.state, nextState: "DISPUTED",
        eventId: eventId(deps, record.taskId, "disputed", now),
        actorId: authenticated.agentId, evidence: { conflictingFindings: true }, now
      });
      return { accepted: true, duplicate: false, state: disputed.state };
    }
    await store.appendTaskEvent({
      tenantId, taskId: record.taskId,
      eventId: eventId(deps, record.taskId, "conflicting-findings", now),
      eventType: "CONFLICTING_FINDINGS", actorId: authenticated.agentId,
      payload: { messageId: envelope.messageId }, now
    });
    return { accepted: true, duplicate: false, state: record.state, disputeRecorded: true };
  }
  return { accepted: true, duplicate: false, state: record.state };
}

export async function requestCancellation(taskId, actorInput, deps) {
  const store = requireStore(deps);
  const tenantId = deps?.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) throw coreError("TENANT_REQUIRED", "A tenant ID is required.");
  if (typeof deps.authenticateActor !== "function") {
    throw coreError("ACTOR_UNAUTHENTICATED", "Authenticated actor resolver is unavailable.");
  }
  const actor = await deps.authenticateActor(actorInput);
  if (!actor || actor.authenticated !== true ||
      typeof actor.principalId !== "string" || typeof actor.agentId !== "string") {
    throw coreError("ACTOR_UNAUTHENTICATED", "Cancellation requires an authenticated actor.");
  }
  const record = await store.getTask({ tenantId, taskId });
  if (!record) throw coreError("ORCHESTRATOR_TASK_NOT_FOUND", "Task does not exist.");
  if (TERMINAL_STATES.has(record.state)) {
    return { cancelled: false, reason: "TERMINAL_STATE", task: record };
  }
  const decision = evaluatePolicy({ actor, action: "cancel_task", task: record.task, now: nowMs(deps) });
  if (!decision.allowed) throw policyFailure(decision);
  const now = nowMs(deps);
  const transition = {
    tenantId, taskId, expectedState: record.state, nextState: "CANCELLED",
    eventId: eventId(deps, taskId, "cancel", now),
    actorId: actor.principalId,
    evidence: { cancellationRequestedBy: actor.principalId },
    now
  };
  if (record.state === "RUNNING") {
    const lease = await deps.getLeaseCredentials?.(taskId);
    if (!lease) {
      await store.appendTaskEvent({
        tenantId, taskId, eventId: eventId(deps, taskId, "cancel-requested", now),
        eventType: "CANCELLATION_REQUESTED", actorId: actor.principalId,
        payload: { requestedBy: actor.principalId, reason: "CURRENT_LEASE_UNAVAILABLE" }, now
      });
      await deps.signalCancellation?.(taskId, actor);
      return { cancelled: false, pending: true, reason: "CURRENT_LEASE_UNAVAILABLE", task: record };
    }
    transition.leaseToken = lease.leaseToken;
    transition.fencingToken = lease.fencingToken;
    transition.leaseOwnerId = lease.ownerId;
  }
  const task = await store.transitionTask(transition);
  await deps.signalCancellation?.(taskId, actor);
  return { cancelled: true, task };
}

function verifiedAdapter(adapter, deps, now) {
  if (!adapter || adapter.verified !== true || adapter.authenticated !== true ||
      !VERIFIED_FREE_STATES.has(adapter.state) ||
      adapter.billingEnabled !== false || adapter.paidFallback !== false ||
      adapter.maxSpendCents !== 0 || !Number.isFinite(adapter.quotaRemaining) ||
      adapter.quotaRemaining <= 0 || typeof adapter.invoke !== "function") {
    return false;
  }
  const expiresAt = typeof adapter.expiresAt === "number" ? adapter.expiresAt : Date.parse(adapter.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (adapter.mock === true && !(deps.mode === "test" && deps.allowMock === true)) return false;
  return true;
}

async function deferEvent(store, tenantId, event, now, reason) {
  await store.deferOutbox({
    tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration,
    retryAfterMs: 60_000, error: reason, now
  });
}

export async function runDispatchCycle(deps) {
  const store = requireStore(deps);
  const tenantId = deps?.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) throw coreError("TENANT_REQUIRED", "A tenant ID is required.");
  const maxEvents = deps.maxEvents === undefined ? 5 : deps.maxEvents;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10) {
    throw new TypeError("maxEvents must be between 1 and 10.");
  }
  const leaseMs = deps.leaseMs === undefined ? 30_000 : deps.leaseMs;
  const initialStopSwitch = await store.getStopSwitch({ tenantId });
  const result = { stopped: initialStopSwitch.active !== false, claimed: 0, invoked: 0, deferred: 0, completed: 0, failed: 0 };
  if (result.stopped) return result;

  for (let index = 0; index < maxEvents; index += 1) {
    const now = nowMs(deps);
    const event = await store.claimOutbox({ tenantId, now, leaseMs });
    if (!event) break;
    result.claimed += 1;
    try {
      const stopSwitch = await store.getStopSwitch({ tenantId });
      if (stopSwitch.active !== false) {
        await deferEvent(store, tenantId, event, now, "STOP_SWITCH_ACTIVE");
        result.deferred += 1;
        break;
      }

      let task = null;
      if (event.aggregateType === "task") {
        task = await store.getTask({ tenantId, taskId: event.aggregateId });
        if (!task) {
          await store.failOutbox({
            tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration,
            error: "TASK_NOT_FOUND", maxAttempts: 1, now
          });
          result.failed += 1;
          continue;
        }
        if (task.state !== "RECEIVED") {
          await store.completeOutbox({ tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration, now });
          result.completed += 1;
          continue;
        }
      }

      if (typeof deps.isCancellationRequested === "function" &&
          await deps.isCancellationRequested(event.aggregateId, task)) {
        await store.completeOutbox({ tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration, now });
        result.completed += 1;
        continue;
      }

      const adapter = deps.adapters?.[event.aggregateType] ?? deps.adapters?.[event.eventType];
      if (!verifiedAdapter(adapter, deps, now)) {
        await deferEvent(store, tenantId, event, now, "ADAPTER_NOT_VERIFIED_FREE");
        result.deferred += 1;
        continue;
      }

      const finalStopSwitch = await store.getStopSwitch({ tenantId });
      if (finalStopSwitch.active !== false) {
        await deferEvent(store, tenantId, event, now, "STOP_SWITCH_ACTIVATED_BEFORE_EFFECT");
        result.deferred += 1;
        break;
      }
      if (typeof deps.isCancellationRequested === "function" &&
          await deps.isCancellationRequested(event.aggregateId, task)) {
        await store.completeOutbox({ tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration, now });
        result.completed += 1;
        continue;
      }

      await adapter.invoke({ event, task, signal: deps.signal });
      await store.completeOutbox({ tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration, now });
      result.invoked += 1;
      result.completed += 1;
    } catch (error) {
      if (error?.transient === true || error?.retryable === true) {
        await deferEvent(store, tenantId, event, now, "TRANSIENT_DISPATCH_FAILURE");
        result.deferred += 1;
      } else {
        await store.failOutbox({
          tenantId, eventId: event.eventId, leaseGeneration: event.leaseGeneration,
          error: typeof error?.code === "string" ? error.code : "DISPATCH_FAILED",
          maxAttempts: 5, now
        });
        result.failed += 1;
      }
    }
  }
  return result;
}
