import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAgentWorkerAssertion,
  createScheduledWorkerAssertion,
} from "../orchestrator-worker-identity.js";

const NOW = 1_800_000_300_000;
const KEY_SET = JSON.stringify({ test: "a".repeat(64) });
const TENANT_ID = "tenant-alpha";
const PROJECT_ID = "project-red";
const WORKER_ID = "worker-a";
const SCHEDULER_ID = "orchestrator-scheduler";
const PUBLISHER_ID = "orchestrator-outbox-publisher";

function ledgerFor(name) {
  return env.ORCHESTRATOR_LEDGER.get(env.ORCHESTRATOR_LEDGER.idFromName(name));
}

async function createScheduledTask(instance, taskId) {
  instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
  const workerAssertion = await createScheduledWorkerAssertion(KEY_SET, "test", {
    subject: SCHEDULER_ID,
    role: "system",
    operation: "createTask",
    nowMs: NOW,
  });
  return instance.createTask({
    task: {
      taskId,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      state: "SCHEDULED",
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      executorId: WORKER_ID,
      agentRound: 0,
    },
    idempotencyKey: "idempotency-" + taskId,
    inputHash: "e".repeat(64),
    now: NOW,
    workerId: SCHEDULER_ID,
    workerAssertion,
  });
}

async function assertionFor(operation, taskId, now) {
  return createAgentWorkerAssertion(KEY_SET, "test", {
    subject: WORKER_ID,
    operation,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    taskId,
    nowMs: now,
  });
}

async function publisherAssertion(operation, now) {
  return createScheduledWorkerAssertion(KEY_SET, "test", {
    subject: PUBLISHER_ID,
    role: "publisher",
    operation,
    nowMs: now,
  });
}

async function claimTask(instance, taskId, now, workerAssertion) {
  return instance.claimTask({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    workerAssertion,
    leaseMs: 30_000,
    now,
    ...(taskId === null ? {} : { taskId }),
  });
}

async function transition(instance, taskId, fromState, version, nextState, now, leaseGeneration = 1, workerAssertion) {
  return instance.transitionTask({
    taskId,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    expectedVersion: version,
    expectedState: fromState,
    nextState,
    actor: {
      id: WORKER_ID,
      role: "agent",
      authenticated: true,
      identityVerified: true,
    },
    evidence: {},
    workerId: WORKER_ID,
    workerAssertion,
    leaseGeneration,
    now,
  });
}

async function prepareRunningTask(instance, taskId, offset) {
  await createScheduledTask(instance, taskId);
  const claimNow = NOW + offset;
  const claimAssertion = await assertionFor("claimTask", taskId, claimNow);
  expect(await claimTask(instance, taskId, claimNow, claimAssertion))
    .toMatchObject({ claimed: true, leaseGeneration: 1 });
  const runningNow = claimNow + 1;
  const runningAssertion = await assertionFor("transitionTask", taskId, runningNow);
  expect(await transition(instance, taskId, "SCHEDULED", 1, "RUNNING", runningNow, 1, runningAssertion))
    .toMatchObject({ updated: true, task: { state: "RUNNING", version: 2 } });
  return { runningNow };
}

function leaseRow(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, worker_id, lease_generation, lease_until, tenant_id, project_id FROM orchestrator_execution_leases WHERE task_id = ?",
    taskId,
  ).toArray()[0] ?? null;
}

function candidateRows(instance, taskId) {
  return instance.ctx.storage.sql.exec(
    "SELECT task_id, executor_id, created_at, tenant_id, project_id FROM orchestrator_claim_candidates WHERE task_id = ?",
    taskId,
  ).toArray();
}

function outboxRow(instance, eventId) {
  return instance.ctx.storage.sql.exec(
    "SELECT event_id, status, attempts, lease_worker_id, lease_generation, lease_until, tenant_id, project_id, payload_json FROM orchestrator_outbox_events WHERE event_id = ?",
    eventId,
  ).toArray()[0] ?? null;
}

describe("OrchestratorLedger Durable Object eviction and recovery invariants", () => {
  it("reconstructs a fresh instance while preserving Task, Lease, and consumed assertion state", async () => {
    const ledger = ledgerFor("ledger-eviction-task-lease-assertion");
    const taskId = "eviction-running-task";
    let originalInstance;
    let consumedRenewalAssertion;
    let expectedLeaseUntil;

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      const { runningNow } = await prepareRunningTask(instance, taskId, 41);
      const renewNow = runningNow + 1;
      consumedRenewalAssertion = await assertionFor("renewLease", taskId, renewNow);

      expect(await instance.renewLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion: consumedRenewalAssertion,
        leaseGeneration: 1,
        leaseMs: 30_000,
        now: renewNow,
      })).toMatchObject({ renewed: true, leaseGeneration: 1 });

      expectedLeaseUntil = renewNow + 30_000;
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: expectedLeaseUntil,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);

      instance.__testEvictionSentinel = "volatile-instance-state";
      originalInstance = instance;
    });

    await evictDurableObject(ledger);

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      expect(instance).not.toBe(originalInstance);
      expect(instance.__testEvictionSentinel).toBeUndefined();

      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ taskId, state: "RUNNING", version: 2 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: expectedLeaseUntil,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);

      const replay = await instance.renewLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion: consumedRenewalAssertion,
        leaseGeneration: 1,
        leaseMs: 30_000,
        now: expectedLeaseUntil - 29_998,
      });
      expect(replay).toMatchObject({
        renewed: false,
        reason: "AUTHENTICATED_WORKER_REQUIRED",
      });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
        lease_until: expectedLeaseUntil,
      });

      const freshNow = expectedLeaseUntil - 29_997;
      const freshAssertion = await assertionFor("renewLease", taskId, freshNow);
      expect(await instance.renewLease({
        taskId,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        workerId: WORKER_ID,
        workerAssertion: freshAssertion,
        leaseGeneration: 1,
        leaseMs: 30_000,
        now: freshNow,
      })).toMatchObject({ renewed: true, leaseGeneration: 1 });
    });
  });

  it("preserves Claim Candidate and Outbox lease generations across repeated eviction and reconstruction", async () => {
    const ledger = ledgerFor("ledger-eviction-candidate-outbox");
    const taskId = "eviction-outbox-task";
    const eventId = "eviction-outbox-event";
    const payload = { taskId, version: 1, source: "eviction-recovery-test" };
    const enqueueNow = NOW + 51;
    const firstClaimNow = NOW + 52;
    const secondClaimNow = firstClaimNow + 5_001;

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      await createScheduledTask(instance, taskId);
      expect(candidateRows(instance, taskId)).toEqual([{
        task_id: taskId,
        executor_id: WORKER_ID,
        created_at: NOW,
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
      }]);

      const enqueued = await instance.enqueueOutbox({
        eventId,
        idempotencyKey: "eviction-outbox-idempotency",
        taskId,
        eventType: "task.created",
        payload,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        now: enqueueNow,
        workerId: WORKER_ID,
        workerAssertion: await assertionFor("enqueueOutbox", taskId, enqueueNow),
      });
      expect(enqueued).toMatchObject({ enqueued: true, event: { eventId, payload } });
      expect(outboxRow(instance, eventId)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        lease_worker_id: null,
        lease_generation: 0,
      });
    });

    await evictDurableObject(ledger);

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ taskId, state: "SCHEDULED", version: 1 });
      expect(candidateRows(instance, taskId)).toHaveLength(1);
      const persistedPendingEvent = outboxRow(instance, eventId);
      expect(persistedPendingEvent).toMatchObject({
        status: "PENDING",
        attempts: 0,
        lease_worker_id: null,
        lease_generation: 0,
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
      });
      expect(JSON.parse(persistedPendingEvent.payload_json)).toEqual(payload);

      expect(await claimTask(
        instance,
        taskId,
        firstClaimNow,
        await assertionFor("claimTask", taskId, firstClaimNow),
      )).toMatchObject({ claimed: true, leaseGeneration: 1 });
      expect(candidateRows(instance, taskId)).toEqual([]);

      const firstOutboxClaim = await instance.claimOutbox({
        workerId: PUBLISHER_ID,
        workerAssertion: await publisherAssertion("claimOutbox", firstClaimNow + 1),
        leaseMs: 5_000,
        now: firstClaimNow + 1,
      });
      expect(firstOutboxClaim).toMatchObject({
        claimed: true,
        leaseGeneration: 1,
        reconciliationRequired: false,
        event: { eventId, payload },
      });
      expect(outboxRow(instance, eventId)).toMatchObject({
        status: "IN_PROGRESS",
        attempts: 1,
        lease_worker_id: PUBLISHER_ID,
        lease_generation: 1,
        lease_until: firstClaimNow + 5_001,
      });
    });

    await evictDurableObject(ledger);

    await runInDurableObject(ledger, async instance => {
      instance.env.LEDGER_WORKER_ASSERTION_KEYS = KEY_SET;
      expect(instance.getTask({ taskId, tenantId: TENANT_ID, projectId: PROJECT_ID }))
        .toMatchObject({ taskId, state: "SCHEDULED", version: 1 });
      expect(leaseRow(instance, taskId)).toMatchObject({
        worker_id: WORKER_ID,
        lease_generation: 1,
      });
      expect(candidateRows(instance, taskId)).toEqual([]);
      expect(outboxRow(instance, eventId)).toMatchObject({
        status: "IN_PROGRESS",
        attempts: 1,
        lease_worker_id: PUBLISHER_ID,
        lease_generation: 1,
        lease_until: firstClaimNow + 5_001,
      });

      const reclaimed = await instance.claimOutbox({
        workerId: PUBLISHER_ID,
        workerAssertion: await publisherAssertion("claimOutbox", secondClaimNow),
        leaseMs: 5_000,
        now: secondClaimNow,
      });
      expect(reclaimed).toMatchObject({
        claimed: true,
        leaseGeneration: 2,
        reconciliationRequired: true,
        event: { eventId, payload },
      });
      expect(outboxRow(instance, eventId)).toMatchObject({
        status: "IN_PROGRESS",
        attempts: 2,
        lease_worker_id: PUBLISHER_ID,
        lease_generation: 2,
        lease_until: secondClaimNow + 5_000,
      });
    });
  });
});
